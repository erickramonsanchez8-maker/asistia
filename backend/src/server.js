import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { verifyLicenseDocument } from './license-verifier.js';
import { getLicensePresentation } from './license-policy.js';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || '';
const DB_PATH = resolve(process.env.DATABASE_PATH || './data/asistia.sqlite');
const production = process.env.NODE_ENV === 'production';

if (JWT_SECRET.length < 32) {
  console.error('Configuración inválida: JWT_SECRET debe tener al menos 32 caracteres.');
  process.exit(1);
}
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS license_state (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL UNIQUE REFERENCES companies(id),
  license_id TEXT NOT NULL, signed_document TEXT NOT NULL,
  last_validated_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  device_id TEXT, activation_secret_encrypted TEXT,
  remote_status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','supervisor','worker')),
  employee_id TEXT, active INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, UNIQUE(company_id,email)
);
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  employee_number TEXT NOT NULL, full_name TEXT NOT NULL, email TEXT, rfc TEXT,
  branch TEXT NOT NULL DEFAULT 'Principal', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, UNIQUE(company_id,employee_number)
);
CREATE TABLE IF NOT EXISTS attendance_events (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  employee_id TEXT NOT NULL REFERENCES employees(id), event_type TEXT NOT NULL CHECK(event_type IN ('clock_in','clock_out')),
  occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, source TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id), previous_hash TEXT, event_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_company_employee_time ON attendance_events(company_id, employee_id, occurred_at);
CREATE TABLE IF NOT EXISTS correction_requests (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  event_id TEXT NOT NULL REFERENCES attendance_events(id), requested_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL, proposed_time TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected')),
  reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance_adjustments (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  correction_request_id TEXT NOT NULL UNIQUE REFERENCES correction_requests(id),
  original_event_id TEXT NOT NULL REFERENCES attendance_events(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('clock_in','clock_out')),
  original_time TEXT NOT NULL, adjusted_time TEXT NOT NULL, reason TEXT NOT NULL,
  approved_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  previous_hash TEXT, adjustment_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adjustments_company_employee_time
  ON attendance_adjustments(company_id, employee_id, adjusted_time);
CREATE TABLE IF NOT EXISTS agreements (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  employee_id TEXT NOT NULL REFERENCES employees(id), version TEXT NOT NULL,
  statement TEXT NOT NULL, accepted_at TEXT NOT NULL, method TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES users(id), evidence_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, details_json TEXT NOT NULL,
  created_at TEXT NOT NULL, previous_hash TEXT, entry_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_company_time ON audit_log(company_id, created_at);
`);
try { db.exec('ALTER TABLE license_state ADD COLUMN device_id TEXT'); }
catch (e) { if (!String(e.message).includes('duplicate column name')) throw e; }
try { db.exec('ALTER TABLE license_state ADD COLUMN activation_secret_encrypted TEXT'); }
catch (e) { if (!String(e.message).includes('duplicate column name')) throw e; }
try { db.exec("ALTER TABLE license_state ADD COLUMN remote_status TEXT NOT NULL DEFAULT 'active'"); }
catch (e) { if (!String(e.message).includes('duplicate column name')) throw e; }

// Migra bases creadas antes de token_version sin borrar ni recrear tablas.
try { db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0'); }
catch (e) { if (!String(e.message).includes('duplicate column name')) throw e; }
try { db.exec('ALTER TABLE employees ADD COLUMN rfc TEXT'); }
catch (e) { if (!String(e.message).includes('duplicate column name')) throw e; }

const now = () => new Date().toISOString();
const audit = db.prepare(`INSERT INTO audit_log
(id,company_id,actor_id,action,entity_type,entity_id,details_json,created_at,previous_hash,entry_hash)
VALUES (?,?,?,?,?,?,?,?,?,?)`);
function writeAudit(companyId, actorId, action, entityType, entityId, details = {}) {
  const prev = db.prepare('SELECT entry_hash FROM audit_log WHERE company_id=? ORDER BY rowid DESC LIMIT 1').get(companyId)?.entry_hash || null;
  const created = now();
  const id = randomUUID();
  const payload = JSON.stringify({ id, companyId, actorId, action, entityType, entityId, details, created, prev });
  const hash = createHash('sha256').update(payload).digest('hex');
  audit.run(id, companyId, actorId, action, entityType, entityId, JSON.stringify(details), created, prev, hash);
}
function writeEvent({companyId, employeeId, eventType, occurredAt, source, createdBy}) {
  const prev = db.prepare('SELECT event_hash FROM attendance_events WHERE company_id=? ORDER BY rowid DESC LIMIT 1').get(companyId)?.event_hash || null;
  const receivedAt = now();
  const id = randomUUID();
  const payload = JSON.stringify({id,companyId,employeeId,eventType,occurredAt,receivedAt,source,createdBy,prev});
  const hash = createHash('sha256').update(payload).digest('hex');
  db.prepare(`INSERT INTO attendance_events
  (id,company_id,employee_id,event_type,occurred_at,received_at,source,created_by,previous_hash,event_hash)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,companyId,employeeId,eventType,occurredAt,receivedAt,source,createdBy,prev,hash);
  return db.prepare('SELECT * FROM attendance_events WHERE id=?').get(id);
}

const appError = (status, message) => Object.assign(new Error(message), { status });
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
function parseDateRange(query) {
  const from = query.from ? new Date(String(query.from)) : new Date(Date.now() - 30 * 86400000);
  const to = query.to ? new Date(String(query.to)) : new Date();
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf()) || from > to) throw appError(400, 'Rango de fechas inválido.');
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw appError(400, 'El rango máximo de consulta es de 366 días.');
  return { from, to };
}
function parsePagination(query) {
  const rawLimit = query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(query.limit);
  const rawOffset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_SIZE) throw appError(400, `limit debe ser un entero entre 1 y ${MAX_PAGE_SIZE}.`);
  if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 1000000) throw appError(400, 'offset debe ser un entero entre 0 y 1000000.');
  return { limit: rawLimit, offset: rawOffset };
}
function assertValidEffectiveTimeline(companyId, employeeId, eventId, proposedTime) {
  const rows = db.prepare(`SELECT e.id,e.event_type,e.occurred_at,e.rowid,
    COALESCE((SELECT aa.adjusted_time FROM attendance_adjustments aa WHERE aa.original_event_id=e.id ORDER BY aa.rowid DESC LIMIT 1),e.occurred_at) AS effective_time
    FROM attendance_events e WHERE e.company_id=? AND e.employee_id=? ORDER BY e.rowid`).all(companyId, employeeId);
  const timeline = rows.map(row => ({...row, effective_time: row.id === eventId ? proposedTime : row.effective_time}))
    .sort((a,b) => Date.parse(a.effective_time)-Date.parse(b.effective_time) || a.rowid-b.rowid);
  let previous = null;
  for (const [index, row] of timeline.entries()) {
    if (index === 0 && row.event_type !== 'clock_in') throw appError(409, 'La cronología debe comenzar con una entrada; esta corrección rompería la secuencia.');
    if (previous && Date.parse(row.effective_time) <= Date.parse(previous.effective_time)) {
      throw appError(409, 'La corrección produciría dos eventos con la misma hora o fuera de orden.');
    }
    if (previous && previous.event_type === row.event_type) {
      throw appError(409, 'La corrección rompería la secuencia entrada/salida. Revisa los registros relacionados antes de aprobarla.');
    }
    previous = row;
  }
}
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin(origin, cb) {
    const allowed = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim());
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(Object.assign(new Error('Origen no autorizado por CORS.'), { status: 403 }));
  },
  methods: ['GET','POST','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json({ limit: '100kb', strict: true }));
// Límites generales: reducen abuso de endpoints que no son de autenticación.
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));
// Configura únicamente los saltos de proxy conocidos; no confíes en proxies arbitrarios.
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (Number.isInteger(proxyHops) && proxyHops > 0) app.set('trust proxy', proxyHops);
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }));

const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });
app.post('/api/auth/login', (req,res,next) => {
  try {
    const input = loginSchema.parse(req.body);
    const candidates = db.prepare('SELECT * FROM users WHERE email=? AND active=1').all(input.email.toLowerCase());
    const matches = candidates.filter(candidate => bcrypt.compareSync(input.password, candidate.password_hash));
    // Evita autenticar de forma ambigua si una misma dirección existe en varias empresas.
    if (matches.length !== 1) throw appError(401, 'Credenciales incorrectas o cuenta ambigua. Usa un correo único por usuario.'); 
    const user = matches[0];
    const token = jwt.sign({ sub:user.id, companyId:user.company_id, role:user.role, tokenVersion:user.token_version }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '20m', issuer:'asistia-api', audience:'asistia-client' });
    writeAudit(user.company_id,user.id,'auth.login','user',user.id,{});
    res.json({ token, tokenType:'Bearer', expiresIn:process.env.JWT_EXPIRES_IN || '20m', user:{id:user.id,name:user.name,email:user.email,role:user.role,companyId:user.company_id} });
  } catch(e) { next(e); }
});

function authenticate(req,res,next) {
  try {
    const value = req.get('authorization') || '';
    if (!value.startsWith('Bearer ')) throw appError(401,'Se requiere un token Bearer.');
    const claims = jwt.verify(value.slice(7),JWT_SECRET,{issuer:'asistia-api',audience:'asistia-client'});
    const user = db.prepare('SELECT id,company_id,name,email,role,employee_id,active,token_version FROM users WHERE id=?').get(claims.sub);
    if (!user || !user.active || user.company_id !== claims.companyId || claims.tokenVersion !== user.token_version) throw appError(401,'Sesión inválida, revocada o usuario inactivo.');
    req.user = { id:user.id, companyId:user.company_id, name:user.name, email:user.email, role:user.role, employeeId:user.employee_id };
    next();
  } catch(e) { next(e.status ? e : appError(401,'Token inválido o vencido.')); }
}
const roles = (...allowed) => (req,res,next) => allowed.includes(req.user.role) ? next() : next(appError(403,'No tienes permisos para esta operación.'));
const employeeSchema = z.object({
  employeeNumber:z.string().trim().min(1).max(40),
  fullName:z.string().trim().min(2).max(160),
  email:z.string().email().max(254).optional().or(z.literal('')),
  rfc:z.string().trim().toUpperCase().regex(/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/, 'RFC inválido: usa 3 o 4 letras, 6 dígitos y 3 caracteres finales.').optional().or(z.literal('')),
  branch:z.string().trim().min(1).max(100).default('Principal')
});
const userSchema = z.object({
  name:z.string().trim().min(2).max(160),
  email:z.string().trim().email().max(254).transform(v=>v.toLowerCase()),
  password:z.string().min(14).max(200),
  role:z.enum(['admin','supervisor','worker']),
  employeeId:z.string().uuid().optional()
});
const eventSchema = z.object({
  employeeId:z.string().uuid(),
  eventType:z.enum(['clock_in','clock_out']),
  occurredAt:z.string().datetime({offset:true}).optional(),
  source:z.enum(['web','admin','kiosk']).default('web')
});
const correctionSchema = z.object({ eventId:z.string().uuid(), reason:z.string().trim().min(8).max(1000), proposedTime:z.string().datetime({offset:true}) });
const agreementSchema = z.object({ employeeId:z.string().uuid(), version:z.string().trim().min(1).max(40), statement:z.string().trim().min(10).max(3000), method:z.enum(['in_person','paper_reference','electronic_acknowledgement','other']) });

app.get('/api/health', (req,res) => {
  try {
    db.prepare('SELECT 1 AS ready').get();
    res.json({status:'ok',database:'ok',service:'ASISTIA API',version:'0.3.0',time:now()});
  } catch {
    res.status(503).json({status:'error',database:'unavailable',service:'ASISTIA API',version:'0.3.0',time:now()});
  }
});

function licensePublicKey() {
  return (process.env.ASISTIA_LICENSE_PUBLIC_KEY || '').replace(/\\n/g, '\n').trim();
}
function licenseStorageKey() {
  const encoded = process.env.ASISTIA_LICENSE_STORAGE_KEY || '';
  if (!encoded) return null;
  try {
    const key = Buffer.from(encoded, 'base64');
    return key.length === 32 ? key : null;
  } catch { return null; }
}
function encryptActivationSecret(secret) {
  const key = licenseStorageKey();
  if (!key) throw appError(503, 'Falta configurar ASISTIA_LICENSE_STORAGE_KEY para guardar la activación de forma cifrada.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}
function decryptActivationSecret(value) {
  const key = licenseStorageKey();
  if (!key) throw appError(503, 'Falta configurar ASISTIA_LICENSE_STORAGE_KEY para renovar la licencia.');
  const parts = String(value || '').split('.');
  if (parts.length !== 3) throw appError(500, 'No se pudo leer la credencial de activación almacenada.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
  } catch { throw appError(500, 'La credencial de activación almacenada no pudo descifrarse.'); }
}
function remoteLicensingUrl() {
  const raw = (process.env.LICENSING_SERVICE_URL || '').trim();
  if (!raw) throw appError(503, 'El servicio remoto de licencias no está configurado en este equipo.');
  let parsed;
  try { parsed = new URL(raw); } catch { throw appError(503, 'La URL del servicio remoto de licencias no es válida.'); }
  if (production && parsed.protocol !== 'https:') throw appError(503, 'El servicio remoto de licencias debe usar HTTPS en producción.');
  if (!['http:', 'https:'].includes(parsed.protocol)) throw appError(503, 'El protocolo del servicio remoto de licencias no es válido.');
  return parsed.toString().replace(/\/$/, '');
}
async function callRemoteLicensing(path, body) {
  const base = remoteLicensingUrl();
  let response;
  try {
    response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw appError(503, 'No se pudo conectar con el servicio de licencias. Comprueba internet e inténtalo de nuevo.');
  }
  let data;
  try { data = await response.json(); } catch { throw appError(503, 'El servicio de licencias devolvió una respuesta no válida.'); }
  if (!response.ok) {
    const status = response.status >= 500 ? 503 : response.status;
    throw appError(status, typeof data.error === 'string' ? data.error.slice(0, 240) : 'El servicio remoto rechazó la operación.');
  }
  return data;
}
function readCompanyLicense(companyId) {
  const saved = db.prepare('SELECT license_id, signed_document, last_validated_at, remote_status FROM license_state WHERE company_id=?').get(companyId);
  if (!saved) return { status:'unlicensed', license:null, lastValidatedAt:null };
  if (saved.remote_status && saved.remote_status !== 'active') {
    return { status:saved.remote_status, license:null, lastValidatedAt:saved.last_validated_at };
  }
  const publicKey = licensePublicKey();
  if (!publicKey) return { status:'configuration_error', license:null, lastValidatedAt:saved.last_validated_at };
  try {
    const license = verifyLicenseDocument(saved.signed_document, publicKey, new Date());
    if (license.companyId !== companyId || license.licenseId !== saved.license_id) {
      return { status:'invalid', license:null, lastValidatedAt:saved.last_validated_at };
    }
    return { status:license.status, license, lastValidatedAt:saved.last_validated_at };
  } catch {
    return { status:'invalid', license:null, lastValidatedAt:saved.last_validated_at };
  }
}
function assertLicenseAllowsOperation(companyId, operationLabel = 'realizar esta operación') {
  if (process.env.ASISTIA_LICENSE_ENFORCEMENT !== 'true') return null;
  const state = readCompanyLicense(companyId);
  // La gracia sin conexión no extiende la vigencia comercial ni autoriza escrituras.
  if (!state.license || state.status !== 'active') {
    throw appError(402, `Se requiere una licencia ASISTIA vigente para ${operationLabel}. Puedes consultar y exportar el historial existente.`);
  }
  return state.license;
}
function assertLicenseAllowsEmployee(companyId) {
  const license = assertLicenseAllowsOperation(companyId, 'registrar empleados');
  if (!license) return;
  const activeEmployees = db.prepare('SELECT COUNT(*) AS total FROM employees WHERE company_id=? AND active=1').get(companyId).total;
  if (activeEmployees >= license.maxEmployees) {
    throw appError(409, `El plan actual permite hasta ${license.maxEmployees} empleados activos. Amplía tu plan para registrar más.`);
  }
}
app.get('/api/license/status', authenticate, roles('admin'), (req,res) => {
  const state = readCompanyLicense(req.user.companyId);
  const presentation = getLicensePresentation(state);
  res.json({
    status:state.status,
    daysRemaining:presentation.daysRemaining,
    showExpiryWarning:presentation.showExpiryWarning,
    historyReadOnly:presentation.historyReadOnly,
    lastValidatedAt:state.lastValidatedAt,
    license:state.license ? {
      licenseId:state.license.licenseId,
      companyId:state.license.companyId,
      planCode:state.license.planCode,
      expiresAt:state.license.expiresAt,
      offlineGraceUntil:state.license.offlineGraceUntil,
      maxEmployees:state.license.maxEmployees,
      maxDevices:state.license.maxDevices,
      licenseVersion:state.license.licenseVersion
    } : null,
    remoteActivation: Boolean(db.prepare("SELECT 1 FROM license_state WHERE company_id=? AND activation_secret_encrypted IS NOT NULL AND remote_status='active'").get(req.user.companyId))
  });
});
app.post('/api/license/activate', authenticate, roles('admin'), async (req,res,next) => {
  try {
    const input=z.object({
      signedDocument:z.string().min(20).max(16384).optional(),
      activationCode:z.string().min(20).max(128).optional()
    }).refine(value => Boolean(value.signedDocument) !== Boolean(value.activationCode), 'Proporciona signedDocument o activationCode, pero no ambos.').parse(req.body);
    const publicKey=licensePublicKey();
    if (!publicKey) throw appError(503,'La verificación de licencias no está configurada en este equipo.');
    const existingActivation = db.prepare("SELECT activation_secret_encrypted,remote_status FROM license_state WHERE company_id=?").get(req.user.companyId);
    if (input.signedDocument && existingActivation?.activation_secret_encrypted && existingActivation.remote_status === 'active') {
      throw appError(409,'Desactiva primero la activación remota antes de instalar una licencia manual.');
    }
    let signedDocument = input.signedDocument;
    let activationSecretEncrypted = null;
    let deviceId = null;
    if (input.activationCode) {
      // La clave de cifrado se comprueba antes de consumir el código remoto de un solo uso.
      if (!licenseStorageKey()) throw appError(503,'Falta configurar ASISTIA_LICENSE_STORAGE_KEY para activar licencias remotas.');
      const current = db.prepare('SELECT license_id, device_id, activation_secret_encrypted, remote_status FROM license_state WHERE company_id=?').get(req.user.companyId);
      if (current?.activation_secret_encrypted && current.remote_status === 'active') {
        throw appError(409,'Esta empresa ya tiene una activación remota. Renueva la licencia o desactiva el dispositivo primero.');
      }
      deviceId = current?.device_id || randomUUID();
      const remote = await callRemoteLicensing('/v1/activate', {
        activationCode:input.activationCode, companyId:req.user.companyId, deviceId
      });
      if (typeof remote.signedDocument !== 'string' || typeof remote.activationSecret !== 'string') {
        throw appError(503,'La respuesta de activación remota está incompleta.');
      }
      signedDocument = remote.signedDocument;
      activationSecretEncrypted = encryptActivationSecret(remote.activationSecret);
    }
    let license;
    try { license=verifyLicenseDocument(signedDocument,publicKey,new Date()); }
    catch(e) { throw appError(422,e.message || 'Documento de licencia inválido.'); }
    if (license.companyId !== req.user.companyId) throw appError(403,'La licencia no corresponde a esta empresa.');
    if (license.status !== 'active') throw appError(402,'La licencia está vencida. La activación requiere una licencia vigente.');
    const existing=db.prepare('SELECT id FROM license_state WHERE company_id=?').get(req.user.companyId);
    const timestamp=now();
    db.prepare(`INSERT INTO license_state(id,company_id,license_id,signed_document,last_validated_at,updated_at,device_id,activation_secret_encrypted,remote_status)
      VALUES(?,?,?,?,?,?,?,?, 'active')
      ON CONFLICT(company_id) DO UPDATE SET license_id=excluded.license_id,
      signed_document=excluded.signed_document,last_validated_at=excluded.last_validated_at,updated_at=excluded.updated_at,
      device_id=COALESCE(excluded.device_id,license_state.device_id),
      activation_secret_encrypted=excluded.activation_secret_encrypted,remote_status='active'`)
      .run(existing ? existing.id : randomUUID(),req.user.companyId,license.licenseId,signedDocument,timestamp,timestamp,deviceId,activationSecretEncrypted);
    writeAudit(req.user.companyId,req.user.id,'license.activated','license',license.licenseId,{planCode:license.planCode,expiresAt:license.expiresAt,maxEmployees:license.maxEmployees,maxDevices:license.maxDevices,remote:Boolean(input.activationCode)});
    res.status(200).json({ok:true,status:license.status,license:{
      licenseId:license.licenseId,planCode:license.planCode,expiresAt:license.expiresAt,
      offlineGraceUntil:license.offlineGraceUntil,maxEmployees:license.maxEmployees,maxDevices:license.maxDevices
    },remoteActivation:Boolean(input.activationCode)});
  } catch(e) { next(e); }
});
app.post('/api/license/refresh', authenticate, roles('admin'), async (req,res,next) => {
  try {
    const saved = db.prepare("SELECT * FROM license_state WHERE company_id=?").get(req.user.companyId);
    if (!saved?.activation_secret_encrypted || !saved.device_id) throw appError(409,'Esta instalación no tiene una activación remota renovable.');
    if (saved.remote_status !== 'active') throw appError(403,'La activación de esta instalación no está activa.');
    const activationSecret = decryptActivationSecret(saved.activation_secret_encrypted);
    let remote;
    try {
      remote = await callRemoteLicensing('/v1/licenses/refresh', {
        licenseId:saved.license_id, deviceId:saved.device_id, activationSecret
      });
    } catch (error) {
      if (error.status === 403) {
        const timestamp = now();
        db.prepare("UPDATE license_state SET remote_status='revoked',last_validated_at=?,updated_at=? WHERE company_id=?")
          .run(timestamp,timestamp,req.user.companyId);
        writeAudit(req.user.companyId,req.user.id,'license.remote_rejected','license',saved.license_id,{httpStatus:403});
      }
      throw error;
    }
    if (typeof remote.signedDocument !== 'string') throw appError(503,'La respuesta de renovación remota está incompleta.');
    let license;
    try { license = verifyLicenseDocument(remote.signedDocument, licensePublicKey(), new Date()); }
    catch(e) { throw appError(422,e.message || 'El documento renovado no es válido.'); }
    if (license.companyId !== req.user.companyId || license.licenseId !== saved.license_id) throw appError(403,'La renovación no corresponde a esta instalación.');
    // El documento almacenado ya fue verificado al activarse; extraemos solo su versión para evitar comparar fechas contra una hora artificial.
    let currentVersion = 0;
    try { currentVersion = Number(JSON.parse(Buffer.from(saved.signed_document.split('.')[0], 'base64url').toString('utf8')).licenseVersion) || 0; }
    catch { throw appError(500, 'No se pudo comprobar la versión de la licencia almacenada.'); }
    if (license.licenseVersion < currentVersion) throw appError(409,'El servicio devolvió una versión de licencia anterior.');
    const timestamp = now();
    db.prepare("UPDATE license_state SET signed_document=?,last_validated_at=?,updated_at=?,remote_status='active' WHERE company_id=?")
      .run(remote.signedDocument,timestamp,timestamp,req.user.companyId);
    writeAudit(req.user.companyId,req.user.id,'license.refreshed','license',license.licenseId,{licenseVersion:license.licenseVersion,expiresAt:license.expiresAt});
    res.json({ok:true,status:license.status,lastValidatedAt:timestamp,license:{
      licenseId:license.licenseId,planCode:license.planCode,expiresAt:license.expiresAt,
      offlineGraceUntil:license.offlineGraceUntil,maxEmployees:license.maxEmployees,maxDevices:license.maxDevices,
      licenseVersion:license.licenseVersion
    }});
  } catch(e) { next(e); }
});
app.post('/api/license/deactivate', authenticate, roles('admin'), async (req,res,next) => {
  try {
    const saved = db.prepare("SELECT * FROM license_state WHERE company_id=?").get(req.user.companyId);
    if (!saved?.activation_secret_encrypted || !saved.device_id) throw appError(409,'Esta instalación no tiene una activación remota que liberar.');
    const activationSecret = decryptActivationSecret(saved.activation_secret_encrypted);
    await callRemoteLicensing('/v1/licenses/deactivate', {
      licenseId:saved.license_id, deviceId:saved.device_id, activationSecret
    });
    const timestamp = now();
    db.prepare("UPDATE license_state SET activation_secret_encrypted=NULL,remote_status='deactivated',last_validated_at=?,updated_at=? WHERE company_id=?")
      .run(timestamp,timestamp,req.user.companyId);
    writeAudit(req.user.companyId,req.user.id,'license.deactivated','license',saved.license_id,{deviceId:saved.device_id});
    res.json({ok:true,status:'deactivated',historyPreserved:true});
  } catch(e) { next(e); }
});
app.get('/api/me', authenticate, (req,res) => res.json({user:req.user}));
app.get('/api/company', authenticate, (req,res) => {
  const company = db.prepare('SELECT id,name,created_at AS createdAt FROM companies WHERE id=?').get(req.user.companyId);
  res.json({company});
});
app.get('/api/users', authenticate, roles('admin'), (req,res,next) => {
  try {
    const {limit,offset}=parsePagination(req.query);
    const total=db.prepare('SELECT COUNT(*) AS total FROM users WHERE company_id=?').get(req.user.companyId).total;
    const users=db.prepare('SELECT id,name,email,role,employee_id AS employeeId,active,created_at AS createdAt FROM users WHERE company_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.user.companyId,limit,offset);
    res.json({users,pagination:{limit,offset,total,hasMore:offset+users.length<total}});
  } catch(e) { next(e); }
});
app.post('/api/users', authenticate, roles('admin'), (req,res,next) => {
  try {
    const input=userSchema.parse(req.body);
    // El login solo recibe correo y contraseña: evita crear nuevas ambigüedades entre empresas.
    if (db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE LIMIT 1').get(input.email)) throw appError(409,'El correo ya está registrado. Cada cuenta debe usar un correo único.');
    if (input.role==='worker' && !input.employeeId) throw appError(400,'La cuenta de trabajador debe asociarse a un empleado.');
    if (input.employeeId) {
      const employee=db.prepare('SELECT id FROM employees WHERE id=? AND company_id=?').get(input.employeeId,req.user.companyId);
      if (!employee) throw appError(404,'Empleado no encontrado en esta empresa.');
    }
    const id=randomUUID(), created=now();
    db.prepare('INSERT INTO users(id,company_id,name,email,password_hash,role,employee_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,req.user.companyId,input.name,input.email,bcrypt.hashSync(input.password,12),input.role,input.employeeId||null,created);
    writeAudit(req.user.companyId,req.user.id,'user.created','user',id,{role:input.role,employeeId:input.employeeId||null});
    res.status(201).json({user:{id,name:input.name,email:input.email,role:input.role,employeeId:input.employeeId||null,createdAt:created}});
  } catch(e) { next(e); }
});
app.post('/api/auth/change-password', authenticate, (req,res,next) => {
  try {
    const input=z.object({
      currentPassword:z.string().min(1).max(200),
      newPassword:z.string().min(14).max(200)
    }).parse(req.body);
    const account=db.prepare('SELECT password_hash FROM users WHERE id=? AND company_id=? AND active=1').get(req.user.id,req.user.companyId);
    if (!account || !bcrypt.compareSync(input.currentPassword,account.password_hash)) throw appError(401,'La contraseña actual es incorrecta.');
    if (input.currentPassword === input.newPassword) throw appError(400,'La nueva contraseña debe ser diferente.');
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash=?,token_version=token_version+1 WHERE id=? AND company_id=?')
        .run(bcrypt.hashSync(input.newPassword,12),req.user.id,req.user.companyId);
      writeAudit(req.user.companyId,req.user.id,'auth.password_changed','user',req.user.id,{});
    })();
    res.json({ok:true,message:'Contraseña actualizada. Inicia sesión de nuevo; las sesiones anteriores quedaron revocadas.'});
  } catch(e) { next(e); }
});
app.post('/api/users/:id/reset-password', authenticate, roles('admin'), (req,res,next) => {
  try {
    const input=z.object({newPassword:z.string().min(14).max(200)}).parse(req.body);
    const target=db.prepare('SELECT id,active FROM users WHERE id=? AND company_id=?').get(req.params.id,req.user.companyId);
    if (!target || !target.active) throw appError(404,'Usuario no encontrado o inactivo.');
    if (target.id===req.user.id) throw appError(400,'Para cambiar tu propia contraseña usa /api/auth/change-password.');
    db.transaction(()=>{
      db.prepare('UPDATE users SET password_hash=?,token_version=token_version+1 WHERE id=? AND company_id=?')
        .run(bcrypt.hashSync(input.newPassword,12),target.id,req.user.companyId);
      writeAudit(req.user.companyId,req.user.id,'user.password_reset','user',target.id,{});
    })();
    res.json({ok:true,message:'Contraseña restablecida; las sesiones anteriores quedaron revocadas.'});
  } catch(e) { next(e); }
});
app.patch('/api/users/:id/deactivate', authenticate, roles('admin'), (req,res,next) => {
  try {
    if (req.params.id === req.user.id) throw appError(400,'No puedes desactivar tu propia cuenta.');
    const target=db.prepare('SELECT id,role,active FROM users WHERE id=? AND company_id=?').get(req.params.id,req.user.companyId);
    if (!target || !target.active) throw appError(404,'Usuario no encontrado o ya inactivo.');
    if (target.role === 'admin') {
      const activeAdmins=db.prepare("SELECT COUNT(*) AS n FROM users WHERE company_id=? AND role='admin' AND active=1").get(req.user.companyId).n;
      if (activeAdmins <= 1) throw appError(409,'No puedes desactivar al último administrador activo de la empresa.');
    }
    db.transaction(() => {
      db.prepare('UPDATE users SET active=0,token_version=token_version+1 WHERE id=? AND company_id=?').run(target.id,req.user.companyId);
      writeAudit(req.user.companyId,req.user.id,'user.deactivated','user',target.id,{role:target.role});
    })();
    res.json({ok:true});
  } catch(e) { next(e); }
});
app.get('/api/employees', authenticate, (req,res,next) => {
  try {
  const {limit,offset}=parsePagination(req.query);
  // Los trabajadores solo pueden consultar su propio expediente.
  if (req.user.role === 'worker') {
    if (!req.user.employeeId) return res.json({employees:[]});
    const employee = db.prepare('SELECT id,employee_number AS employeeNumber,full_name AS fullName,rfc,branch,active,created_at AS createdAt FROM employees WHERE id=? AND company_id=?').get(req.user.employeeId,req.user.companyId);
    return res.json({employees:employee ? [employee] : []});
  }
  const total=db.prepare('SELECT COUNT(*) AS total FROM employees WHERE company_id=?').get(req.user.companyId).total;
  const rows = db.prepare('SELECT id,employee_number AS employeeNumber,full_name AS fullName,email,rfc,branch,active,created_at AS createdAt FROM employees WHERE company_id=? ORDER BY full_name LIMIT ? OFFSET ?').all(req.user.companyId,limit,offset);
  res.json({employees:rows,pagination:{limit,offset,total,hasMore:offset+rows.length<total}});
  } catch(e) { next(e); }
});
app.post('/api/employees', authenticate, roles('admin','supervisor'), (req,res,next) => {
  try {
    const input = employeeSchema.parse(req.body);
    assertLicenseAllowsEmployee(req.user.companyId);
    const id = randomUUID(), created = now();
    db.prepare('INSERT INTO employees(id,company_id,employee_number,full_name,email,rfc,branch,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,req.user.companyId,input.employeeNumber,input.fullName,input.email || null,input.rfc || null,input.branch,created);
    writeAudit(req.user.companyId,req.user.id,'employee.created','employee',id,{employeeNumber:input.employeeNumber});
    res.status(201).json({employee:{id,...input,createdAt:created,active:1}});
  } catch(e) { next(e); }
});
app.patch('/api/employees/:id/deactivate', authenticate, roles('admin'), (req,res,next) => {
  try {
    const employee=db.prepare('SELECT id FROM employees WHERE id=? AND company_id=?').get(req.params.id,req.user.companyId);
    if (!employee) throw appError(404,'Empleado no encontrado.');
    db.transaction(() => {
      db.prepare('UPDATE employees SET active=0 WHERE id=? AND company_id=?').run(req.params.id,req.user.companyId);
      const linkedUsers=db.prepare("SELECT id,role FROM users WHERE employee_id=? AND company_id=? AND role='worker' AND active=1").all(req.params.id,req.user.companyId);
      db.prepare("UPDATE users SET active=0,token_version=token_version+1 WHERE employee_id=? AND company_id=? AND role='worker' AND active=1").run(req.params.id,req.user.companyId);
      for (const linked of linkedUsers) writeAudit(req.user.companyId,req.user.id,'user.deactivated_with_employee','user',linked.id,{role:linked.role,employeeId:req.params.id});
      writeAudit(req.user.companyId,req.user.id,'employee.deactivated','employee',req.params.id,{linkedUsersDeactivated:linkedUsers.length});
    })();
    res.json({ok:true,linkedAccountsDeactivated:true});
  } catch(e) { next(e); }
});
app.post('/api/attendance/events', authenticate, (req,res,next) => {
  try {
    const input = eventSchema.parse(req.body);
    assertLicenseAllowsOperation(req.user.companyId, 'registrar nuevas asistencias');
    const employee = db.prepare('SELECT id,active FROM employees WHERE id=? AND company_id=?').get(input.employeeId,req.user.companyId);
    if (!employee || !employee.active) throw appError(404,'Empleado no encontrado o inactivo.');
    if (req.user.role === 'worker' && req.user.employeeId !== input.employeeId) throw appError(403,'Solo puedes registrar tu propia asistencia.');
    if (req.user.role === 'worker' && input.occurredAt) throw appError(400,'El trabajador no puede elegir la hora del evento; se utiliza la hora del servidor.');
    const occurredAt = new Date(req.user.role === 'worker' ? now() : (input.occurredAt || now())).toISOString();
    const timeDeltaMs = Date.parse(occurredAt) - Date.now();
    if (timeDeltaMs > 5 * 60 * 1000) throw appError(400,'La hora del evento no puede superar en más de 5 minutos la hora del servidor.');
    if (req.user.role !== 'worker' && input.occurredAt && Math.abs(timeDeltaMs) > 5 * 60 * 1000) throw appError(400,'Los registros manuales deben estar dentro de una ventana de 5 minutos. Para otros horarios, solicita una corrección trazable.');
    const last = db.prepare(`SELECT e.event_type,COALESCE((SELECT aa.adjusted_time FROM attendance_adjustments aa WHERE aa.original_event_id=e.id ORDER BY aa.rowid DESC LIMIT 1),e.occurred_at) AS occurred_at
      FROM attendance_events e WHERE e.company_id=? AND e.employee_id=? ORDER BY COALESCE((SELECT aa.adjusted_time FROM attendance_adjustments aa WHERE aa.original_event_id=e.id ORDER BY aa.rowid DESC LIMIT 1),e.occurred_at) DESC,e.rowid DESC LIMIT 1`).get(req.user.companyId,input.employeeId);
    if (!last && input.eventType === 'clock_out') throw appError(409,'No existe una entrada pendiente de salida.');
    if (last?.event_type === input.eventType) throw appError(409,input.eventType === 'clock_in' ? 'Ya existe una entrada sin salida.' : 'No existe una entrada pendiente de salida.');
    if (last && Date.parse(occurredAt) < Date.parse(last.occurred_at)) throw appError(409,'La fecha no puede ser anterior al último evento. Solicita una corrección trazable.');
    const event = db.transaction(() => {
      const source = req.user.role === 'worker' ? 'web' : input.source;
      const saved = writeEvent({companyId:req.user.companyId,employeeId:input.employeeId,eventType:input.eventType,occurredAt,source,createdBy:req.user.id});
      writeAudit(req.user.companyId,req.user.id,'attendance.event_created','attendance_event',saved.id,{eventType:input.eventType,occurredAt:saved.occurred_at,eventHash:saved.event_hash});
      return saved;
    })();
    res.status(201).json({event});
  } catch(e) { next(e); }
});
app.get('/api/attendance/events', authenticate, (req,res,next) => {
  try {
    const {from,to}=parseDateRange(req.query);
    const {limit,offset}=parsePagination(req.query);
    const rows = db.prepare(`SELECT e.id,e.employee_id AS employeeId,p.employee_number AS employeeNumber,p.full_name AS fullName,
      e.event_type AS eventType,e.occurred_at AS occurredAt,e.received_at AS receivedAt,e.source,e.created_by AS createdBy,e.previous_hash AS previousHash,e.event_hash AS eventHash,
      a.adjusted_time AS adjustedAt,a.reason AS adjustmentReason,a.adjustment_hash AS adjustmentHash,
      COALESCE(a.adjusted_time,e.occurred_at) AS effectiveOccurredAt
      FROM attendance_events e JOIN employees p ON p.id=e.employee_id
      LEFT JOIN attendance_adjustments a ON a.id=(SELECT aa.id FROM attendance_adjustments aa WHERE aa.original_event_id=e.id ORDER BY aa.rowid DESC LIMIT 1)
      WHERE e.company_id=? AND COALESCE(a.adjusted_time,e.occurred_at)>=? AND COALESCE(a.adjusted_time,e.occurred_at)<=? AND (? IS NULL OR e.employee_id=?) ORDER BY COALESCE(a.adjusted_time,e.occurred_at),e.rowid LIMIT ? OFFSET ?`)
      .all(req.user.companyId,from.toISOString(),to.toISOString(),req.user.role === 'worker' ? (req.user.employeeId || '__no_employee__') : null,req.user.role === 'worker' ? (req.user.employeeId || '__no_employee__') : null,limit,offset);
    const total=db.prepare(`SELECT COUNT(*) AS total FROM attendance_events e LEFT JOIN attendance_adjustments a ON a.id=(SELECT aa.id FROM attendance_adjustments aa WHERE aa.original_event_id=e.id ORDER BY aa.rowid DESC LIMIT 1) WHERE e.company_id=? AND COALESCE(a.adjusted_time,e.occurred_at)>=? AND COALESCE(a.adjusted_time,e.occurred_at)<=? AND (? IS NULL OR e.employee_id=?)`).get(req.user.companyId,from.toISOString(),to.toISOString(),req.user.role === 'worker' ? (req.user.employeeId || '__no_employee__') : null,req.user.role === 'worker' ? (req.user.employeeId || '__no_employee__') : null).total;
    res.json({events:rows,from:from.toISOString(),to:to.toISOString(),pagination:{limit,offset,total,hasMore:offset+rows.length<total}});
  } catch(e) { next(e); }
});
app.post('/api/attendance/corrections', authenticate, (req,res,next) => {
  try {
    const input = correctionSchema.parse(req.body);
    if (Date.parse(input.proposedTime) > Date.now() + 5 * 60 * 1000) throw appError(400,'La hora propuesta no puede estar en el futuro.');
    const event = db.prepare('SELECT id,employee_id FROM attendance_events WHERE id=? AND company_id=?').get(input.eventId,req.user.companyId);
    if (!event) throw appError(404,'Registro original no encontrado.');
    if (req.user.role === 'worker' && req.user.employeeId !== event.employee_id) throw appError(403,'No puedes solicitar cambios en otro expediente.');
    const id=randomUUID(), created=now();
    db.prepare('INSERT INTO correction_requests(id,company_id,event_id,requested_by,reason,proposed_time,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id,req.user.companyId,input.eventId,req.user.id,input.reason,input.proposedTime,created);
    writeAudit(req.user.companyId,req.user.id,'attendance.correction_requested','correction_request',id,{eventId:input.eventId,reason:input.reason});
    res.status(201).json({correction:{id,eventId:input.eventId,status:'pending',createdAt:created}});
  } catch(e) { next(e); }
});
app.get('/api/attendance/corrections', authenticate, roles('admin','supervisor'), (req,res,next) => {
  try {
  const {limit,offset}=parsePagination(req.query);
  const total=db.prepare('SELECT COUNT(*) AS total FROM correction_requests WHERE company_id=?').get(req.user.companyId).total;
  const corrections=db.prepare(`SELECT c.id,c.event_id AS eventId,c.requested_by AS requestedBy,c.reason,c.proposed_time AS proposedTime,c.status,c.reviewed_by AS reviewedBy,c.reviewed_at AS reviewedAt,c.created_at AS createdAt,
    a.id AS adjustmentId,a.adjusted_time AS adjustedTime,a.original_time AS originalTime,a.adjustment_hash AS adjustmentHash
  FROM correction_requests c LEFT JOIN attendance_adjustments a ON a.correction_request_id=c.id
  WHERE c.company_id=? ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(req.user.companyId,limit,offset);
  res.json({corrections,pagination:{limit,offset,total,hasMore:offset+corrections.length<total}});
  } catch(e) { next(e); }
});
app.post('/api/attendance/corrections/:id/review', authenticate, roles('admin','supervisor'), (req,res,next) => {
  try {
    const input=z.object({decision:z.enum(['approved','rejected'])}).parse(req.body);
    const row=db.prepare('SELECT * FROM correction_requests WHERE id=? AND company_id=?').get(req.params.id,req.user.companyId);
    if (!row) throw appError(404,'Solicitud no encontrada.');
    if (row.status!=='pending') throw appError(409,'La solicitud ya fue revisada.');
    if (row.requested_by === req.user.id) throw appError(403,'No puedes revisar tu propia solicitud de corrección.');
    const original=db.prepare('SELECT id,employee_id,event_type,occurred_at FROM attendance_events WHERE id=? AND company_id=?').get(row.event_id,req.user.companyId);
    if (!original) throw appError(409,'El registro original ya no está disponible; no se puede aplicar el ajuste.');
    let adjustment=null;
    db.transaction(() => {
      const reviewedAt=now();
      db.prepare('UPDATE correction_requests SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(input.decision,req.user.id,reviewedAt,row.id);
      if (input.decision==='approved') {
        const adjustedTime=new Date(row.proposed_time).toISOString();
        assertValidEffectiveTimeline(req.user.companyId, original.employee_id, original.id, adjustedTime);
        const id=randomUUID();
        const previousHash=db.prepare('SELECT adjustment_hash FROM attendance_adjustments WHERE company_id=? ORDER BY rowid DESC LIMIT 1').get(req.user.companyId)?.adjustment_hash || null;
        const createdAt=now();
        const payload={id,companyId:req.user.companyId,correctionRequestId:row.id,originalEventId:original.id,employeeId:original.employee_id,eventType:original.event_type,originalTime:original.occurred_at,adjustedTime,reason:row.reason,approvedBy:req.user.id,createdAt,prev:previousHash};
        const adjustmentHash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        db.prepare(`INSERT INTO attendance_adjustments(id,company_id,correction_request_id,original_event_id,employee_id,event_type,original_time,adjusted_time,reason,approved_by,created_at,previous_hash,adjustment_hash)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,req.user.companyId,row.id,original.id,original.employee_id,original.event_type,original.occurred_at,payload.adjustedTime,row.reason,req.user.id,createdAt,previousHash,adjustmentHash);
        adjustment={id,originalEventId:original.id,eventType:original.event_type,originalTime:original.occurred_at,adjustedTime:payload.adjustedTime,adjustmentHash};
      }
      writeAudit(req.user.companyId,req.user.id,'attendance.correction_reviewed','correction_request',row.id,{decision:input.decision,originalEventId:row.event_id,proposedTime:row.proposed_time,adjustmentId:adjustment?.id||null,adjustmentHash:adjustment?.adjustmentHash||null});
    })();
    res.json({id:row.id,status:input.decision,originalRecordPreserved:true,adjustment});
  } catch(e) { next(e); }
});
app.get('/api/agreements', authenticate, roles('admin','supervisor'), (req,res,next) => {
  try {
    const {limit,offset}=parsePagination(req.query);
    const total=db.prepare('SELECT COUNT(*) AS total FROM agreements WHERE company_id=?').get(req.user.companyId).total;
    const agreements=db.prepare('SELECT id,employee_id AS employeeId,version,statement,accepted_at AS acceptedAt,method,recorded_by AS recordedBy,evidence_hash AS evidenceHash FROM agreements WHERE company_id=? ORDER BY accepted_at DESC LIMIT ? OFFSET ?').all(req.user.companyId,limit,offset);
    res.json({agreements,pagination:{limit,offset,total,hasMore:offset+agreements.length<total}});
  } catch(e) { next(e); }
});
app.post('/api/agreements', authenticate, roles('admin','supervisor'), (req,res,next) => {
  try {
    const input=agreementSchema.parse(req.body);
    const employee=db.prepare('SELECT id FROM employees WHERE id=? AND company_id=?').get(input.employeeId,req.user.companyId);
    if (!employee) throw appError(404,'Empleado no encontrado.');
    const id=randomUUID(), accepted=now();
    const evidenceHash=createHash('sha256').update(JSON.stringify({id,companyId:req.user.companyId,employeeId:input.employeeId,version:input.version,statement:input.statement,accepted,method:input.method,recordedBy:req.user.id})).digest('hex');
    db.prepare('INSERT INTO agreements(id,company_id,employee_id,version,statement,accepted_at,method,recorded_by,evidence_hash) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,req.user.companyId,input.employeeId,input.version,input.statement,accepted,input.method,req.user.id,evidenceHash);
    writeAudit(req.user.companyId,req.user.id,'agreement.recorded','agreement',id,{employeeId:input.employeeId,version:input.version,method:input.method,evidenceHash});
    res.status(201).json({agreement:{id,employeeId:input.employeeId,version:input.version,acceptedAt:accepted,method:input.method,evidenceHash,legalNote:'El hash y el registro no sustituyen una firma electrónica válida ni determinan por sí solos el cumplimiento legal.'}});
  } catch(e) { next(e); }
});
app.get('/api/reports/attendance.csv', authenticate, roles('admin','supervisor'), (req,res,next) => {
  try {
  const {from,to}=parseDateRange(req.query);
  const totalRows=db.prepare(`SELECT COUNT(*) AS total FROM attendance_events e LEFT JOIN attendance_adjustments a ON a.id=(SELECT aa.id FROM attendance_adjustments aa WHERE aa.original_event_id=e.id ORDER BY aa.rowid DESC LIMIT 1) WHERE e.company_id=? AND COALESCE(a.adjusted_time,e.occurred_at)>=? AND COALESCE(a.adjusted_time,e.occurred_at)<=?`).get(req.user.companyId,from.toISOString(),to.toISOString()).total;
  if (totalRows > 10000) throw appError(400,'La exportación supera 10,000 registros; acota el rango de fechas.');
  const rows=db.prepare(`SELECT p.employee_number,p.full_name,p.branch,e.event_type,e.occurred_at,e.received_at,e.source,e.event_hash,
    a.adjusted_time,a.reason AS adjustment_reason,a.adjustment_hash
    FROM attendance_events e JOIN employees p ON p.id=e.employee_id
    LEFT JOIN attendance_adjustments a ON a.id=(SELECT aa.id FROM attendance_adjustments aa WHERE aa.original_event_id=e.id ORDER BY aa.rowid DESC LIMIT 1)
    WHERE e.company_id=? AND COALESCE(a.adjusted_time,e.occurred_at)>=? AND COALESCE(a.adjusted_time,e.occurred_at)<=? ORDER BY p.full_name,COALESCE(a.adjusted_time,e.occurred_at)`)
    .all(req.user.companyId,from.toISOString(),to.toISOString());
  const cell=v => {
    let value=String(v ?? '');
    // Mitiga ejecución de fórmulas cuando el CSV se abre en hojas de cálculo.
    if (/^\s*[=+@\-]/.test(value)) value="'"+value;
    return '"' + value.replaceAll('"','""') + '"';
  };
  const csv=['numero_empleado,nombre,sucursal,tipo_evento,fecha_evento_original,fecha_ajustada,razon_ajuste,hash_ajuste,fecha_recepcion,origen,hash_original',...rows.map(r=>[r.employee_number,r.full_name,r.branch,r.event_type,r.occurred_at,r.adjusted_time,r.adjustment_reason,r.adjustment_hash,r.received_at,r.source,r.event_hash].map(cell).join(','))].join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="asistia-registros.csv"');
  res.send('\uFEFF'+csv);
  } catch(e) { next(e); }
});
app.get('/api/audit', authenticate, roles('admin'), (req,res,next) => {
  try {
  const {limit,offset}=parsePagination(req.query);
  const total=db.prepare('SELECT COUNT(*) AS total FROM audit_log WHERE company_id=?').get(req.user.companyId).total;
  const rows=db.prepare('SELECT id,actor_id AS actorId,action,entity_type AS entityType,entity_id AS entityId,details_json AS details,created_at AS createdAt,previous_hash AS previousHash,entry_hash AS entryHash FROM audit_log WHERE company_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(req.user.companyId,limit,offset);
  res.json({entries:rows,pagination:{limit,offset,total,hasMore:offset+rows.length<total}});
  } catch(e) { next(e); }
});

app.use((req,res,next) => next(appError(404,'Ruta no encontrada.')));
app.use((err,req,res,next) => {
  if (err instanceof z.ZodError) return res.status(400).json({error:'Datos inválidos.',details:err.issues.map(i=>({field:i.path.join('.'),message:i.message}))});
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({error:'Ya existe un registro con esos datos.'});
  const status=err.status || 500;
  if (status>=500) console.error(err);
  res.status(status).json({error:status>=500?'Error interno del servidor.':err.message});
});

function bootstrap() {
  const count=db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const email=(process.env.BOOTSTRAP_ADMIN_EMAIL||'').trim().toLowerCase();
  const password=process.env.BOOTSTRAP_ADMIN_PASSWORD||'';
  if (count===0 && email && password) {
    if (password.length<14) throw new Error('BOOTSTRAP_ADMIN_PASSWORD debe tener al menos 14 caracteres.');
    const companyId=randomUUID(), userId=randomUUID(), created=now();
    db.transaction(()=>{
      db.prepare('INSERT INTO companies(id,name,created_at) VALUES(?,?,?)').run(companyId,(process.env.BOOTSTRAP_COMPANY_NAME||'Empresa ASISTIA').trim(),created);
      db.prepare('INSERT INTO users(id,company_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(userId,companyId,(process.env.BOOTSTRAP_ADMIN_NAME||'Administrador').trim(),email,bcrypt.hashSync(password,12),'admin',created);
    })();
    console.log('Se creó la cuenta administradora inicial. Guarda la contraseña de forma segura.');
  } else if (count===0) {
    console.warn('Base sin usuarios. Configura BOOTSTRAP_ADMIN_EMAIL y BOOTSTRAP_ADMIN_PASSWORD para crear el primer administrador.');
  }
}
bootstrap();

const server=app.listen(PORT,process.env.HOST||'127.0.0.1',()=>console.log(`ASISTIA API 0.2 escuchando en ${process.env.HOST||'127.0.0.1'}:${PORT}`));
function shutdown() { server.close(()=>{db.close();process.exit(0);}); }
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);