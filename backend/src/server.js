import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { registerMobileRoutes } from './mobile/mobile-routes.js';
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
function writeEvent({companyId, employeeId, eventType, occurredAt, source, createdBy, id = randomUUID()}) {
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
const corsHandler = cors({
  origin(origin, cb) {
    const allowed = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim());
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(Object.assign(new Error('Origen no autorizado por CORS.'), { status: 403 }));
  },
  methods: ['GET','POST','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
});
// Las solicitudes same-origin de la PWA no necesitan CORS; los orígenes externos siguen en lista explícita.
app.use((req, res, next) => {
  const origin = req.get('origin');
  const ownOrigin = (req.secure ? 'https://' : 'http://') + req.get('host');
  if (origin && origin === ownOrigin) return next();
  return corsHandler(req, res, next);
});
app.use(express.json({ limit: '100kb', strict: true }));
// Límites generales: reducen abuso de endpoints que no son de autenticación.
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));
// Configura únicamente los saltos de proxy conocidos; no confíes en proxies arbitrarios.
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (Number.isInteger(proxyHops) && proxyHops > 0) app.set('trust proxy', proxyHops);
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }));

const loginSchema = z.object({
  email: z.string().email().max(254).optional(),
  employeeNumber: z.string().trim().min(1).max(40).optional(),
  password: z.string().min(1).max(200)
}).refine(input => Boolean(input.email || input.employeeNumber), 'Ingresa tu correo o número de empleado.');
app.post('/api/auth/login', (req,res,next) => {
  try {
    const input = loginSchema.parse(req.body);
    const candidates = input.email
      ? db.prepare('SELECT * FROM users WHERE email=? AND active=1').all(input.email.toLowerCase())
      : db.prepare(`SELECT u.* FROM users u JOIN employees e ON e.id=u.employee_id AND e.company_id=u.company_id WHERE e.employee_number=? AND u.role='worker' AND u.active=1`).all(input.employeeNumber);
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
    const id = randomUUID(), created = now();
    db.prepare('INSERT INTO employees(id,company_id,employee_number,full_name,email,rfc,branch,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,req.user.companyId,input.employeeNumber,input.fullName,input.email || null,input.rfc || null,input.branch,created);
    writeAudit(req.user.companyId,req.user.id,'employee.created','employee',id,{employeeNumber:input.employeeNumber});
    res.status(201).json({employee:{id,...input,createdAt:created,active:1}});
  } catch(e) { next(e); }
});
function requireDesktopBridge(req,res,next) {
  const remote = String(req.socket?.remoteAddress || '');
  const isLoopback = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote);
  const expected = Buffer.from(process.env.DESKTOP_BRIDGE_TOKEN || '', 'utf8');
  const supplied = Buffer.from(String(req.get('x-asistia-desktop-bridge') || ''), 'utf8');
  if (!isLoopback || expected.length < 32 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return next(appError(403, 'Acceso interno de ASISTIA no autorizado.'));
  }
  next();
}
app.post('/api/desktop/sync-employees', requireDesktopBridge, (req,res,next) => {
  try {
    const input = z.array(desktopMobileEmployeeSchema).max(1000).parse(req.body);
    const admin = db.prepare("SELECT id,company_id FROM users WHERE role='admin' AND active=1 ORDER BY created_at LIMIT 1").get();
    if (!admin) throw appError(503, 'ASISTIA todavía no ha terminado su configuración inicial.');
    const syncOne = db.prepare(`INSERT INTO employees(id,company_id,employee_number,full_name,branch,active,created_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET employee_number=excluded.employee_number,
        full_name=excluded.full_name,branch=excluded.branch,active=excluded.active`);
    const findNumber = db.prepare('SELECT id FROM employees WHERE company_id=? AND employee_number=?');
    const findId = db.prepare('SELECT company_id FROM employees WHERE id=?');
    const updateWorkers = db.prepare("UPDATE users SET name=?,active=?,token_version=token_version+CASE WHEN active<>? THEN 1 ELSE 0 END WHERE company_id=? AND employee_id=? AND role='worker'");
    const normalized = input.map(employee => ({
      ...employee,
      employeeNumber: employee.employeeNumber || ('AS-' + createHash('sha256').update(employee.id).digest('hex').slice(0,10).toUpperCase())
    }));
    db.transaction(() => {
      for (const employee of normalized) {
        const owner = findNumber.get(admin.company_id,employee.employeeNumber);
        if (owner && owner.id !== employee.id) throw appError(409, 'El número de empleado ' + employee.employeeNumber + ' está duplicado en ASISTIA.');
        const idOwner = findId.get(employee.id);
        if (idOwner && idOwner.company_id !== admin.company_id) throw appError(409, 'Un identificador de empleado pertenece a otra empresa.');
        syncOne.run(employee.id,admin.company_id,employee.employeeNumber,employee.fullName,employee.branch,employee.active ? 1 : 0,now());
        updateWorkers.run(employee.fullName,employee.active ? 1 : 0,employee.active ? 1 : 0,admin.company_id,employee.id);
      }
      if (normalized.length) writeAudit(admin.company_id,admin.id,'employees.desktop_sync','employee_batch','desktop-local-storage',{
        count:normalized.length,active:normalized.filter(x=>x.active).length
      });
    })();
    res.json({ok:true,synced:normalized.length});
  } catch(error) { next(error); }
});
const desktopMobileEmployeeSchema = z.object({
  id: z.string().trim().min(3).max(120).regex(/^[A-Za-z0-9_-]+$/),
  fullName: z.string().trim().min(2).max(160),
  employeeNumber: z.string().trim().max(40).optional().default(''),
  branch: z.string().trim().min(1).max(100).optional().default('Principal'),
  active: z.boolean().optional().default(true)
});
const desktopAttendanceEventSchema = desktopMobileEmployeeSchema.extend({
  eventType: z.enum(['clock_in','clock_out']),
  occurredAt: z.string().datetime({offset:true}).optional()
});
const desktopLegacySessionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  employeeId: z.string().trim().min(3).max(120),
  clockIn: z.string().datetime({offset:true}),
  clockOut: z.string().datetime({offset:true}).nullable().optional()
});

// El puente de escritorio mantiene la identidad del empleado y registra en el
// mismo historial que consulta ASISTIA Móvil. No expone estas rutas a la LAN.
app.post('/api/desktop/record-attendance', requireDesktopBridge, (req,res,next) => {
  try {
    const input = desktopAttendanceEventSchema.parse(req.body);
    if (!input.active) throw appError(403,'El empleado está inactivo.');
    const admin = db.prepare("SELECT id,company_id FROM users WHERE role='admin' AND active=1 ORDER BY created_at LIMIT 1").get();
    if (!admin) throw appError(503,'ASISTIA todavía no ha terminado su configuración inicial.');
    const employeeNumber = input.employeeNumber || ('AS-' + createHash('sha256').update(input.id).digest('hex').slice(0,10).toUpperCase());
    const numberOwner = db.prepare('SELECT id FROM employees WHERE company_id=? AND employee_number=?').get(admin.company_id,employeeNumber);
    if (numberOwner && numberOwner.id !== input.id) throw appError(409,'El número de empleado ya está vinculado a otra ficha.');
    const idOwner = db.prepare('SELECT company_id FROM employees WHERE id=?').get(input.id);
    if (idOwner && idOwner.company_id !== admin.company_id) throw appError(409,'El identificador de empleado pertenece a otra empresa.');
    const occurredAt = input.occurredAt || now();
    const eventTime = Date.parse(occurredAt);
    if (!Number.isFinite(eventTime) || eventTime > Date.now() + 5 * 60 * 1000) throw appError(400,'La hora del registro no es válida.');
    const last = db.prepare('SELECT event_type,occurred_at FROM attendance_events WHERE company_id=? AND employee_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 1')
      .get(admin.company_id,input.id);
    if (last?.event_type === input.eventType) throw appError(409,input.eventType === 'clock_in' ? 'Ya existe una entrada sin salida.' : 'No existe una entrada pendiente de salida.');
    if (last && eventTime < Date.parse(last.occurred_at)) throw appError(409,'La hora no puede ser anterior al último registro del empleado.');
    const event = db.transaction(() => {
      const created = now();
      db.prepare(`INSERT INTO employees(id,company_id,employee_number,full_name,branch,active,created_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET employee_number=excluded.employee_number,
          full_name=excluded.full_name,branch=excluded.branch,active=excluded.active`)
        .run(input.id,admin.company_id,employeeNumber,input.fullName,input.branch,input.active ? 1 : 0,created);
      const saved = writeEvent({companyId:admin.company_id,employeeId:input.id,eventType:input.eventType,occurredAt,source:'kiosk',createdBy:admin.id});
      writeAudit(admin.company_id,admin.id,'attendance.desktop_event_created','attendance_event',saved.id,{
        employeeNumber,eventType:input.eventType,occurredAt:saved.occurred_at
      });
      return saved;
    })();
    res.status(201).json({ok:true,event});
  } catch(error) { next(error); }
});

// Importación inicial de jornadas existentes: IDs deterministas evitan duplicados
// cada vez que ASISTIA vuelve a abrirse o sincroniza el almacenamiento legado.
app.post('/api/desktop/sync-sessions', requireDesktopBridge, (req,res,next) => {
  try {
    const input = z.array(desktopLegacySessionSchema).max(500).parse(req.body);
    const admin = db.prepare("SELECT id,company_id FROM users WHERE role='admin' AND active=1 ORDER BY created_at LIMIT 1").get();
    if (!admin) throw appError(503,'ASISTIA todavía no ha terminado su configuración inicial.');
    const prepared = input.flatMap(session => {
      const base = admin.company_id + ':' + session.id;
      const events = [{employeeId:session.employeeId,eventType:'clock_in',occurredAt:session.clockIn,stableKey:base + ':in'}];
      if (session.clockOut) events.push({employeeId:session.employeeId,eventType:'clock_out',occurredAt:session.clockOut,stableKey:base + ':out'});
      return events;
    }).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
    let imported = 0;
    let skipped = 0;
    db.transaction(() => {
      for (const item of prepared) {
        const employee = db.prepare('SELECT id FROM employees WHERE id=? AND company_id=?').get(item.employeeId,admin.company_id);
        if (!employee) { skipped++; continue; }
        const id = 'legacy_' + createHash('sha256').update(item.stableKey).digest('hex');
        if (db.prepare('SELECT 1 FROM attendance_events WHERE id=?').get(id)) continue;
        const sameEvent=db.prepare('SELECT 1 FROM attendance_events WHERE company_id=? AND employee_id=? AND event_type=? AND occurred_at=? LIMIT 1')
          .get(admin.company_id,item.employeeId,item.eventType,item.occurredAt);
        if (sameEvent) continue;
        writeEvent({
          id,companyId:admin.company_id,employeeId:item.employeeId,eventType:item.eventType,
          occurredAt:item.occurredAt,source:'legacy_migration',createdBy:admin.id
        });
        imported++;
      }
      if (imported) writeAudit(admin.company_id,admin.id,'attendance.legacy_sessions_imported','attendance_event_batch','desktop-local-storage',{count:imported});
    })();
    res.json({ok:true,imported,received:input.length,skipped});
  } catch(error) { next(error); }
});
app.post('/api/desktop/mobile-access', requireDesktopBridge, (req,res,next) => {
  try {
    const input = desktopMobileEmployeeSchema.parse(req.body);
    const admin = db.prepare("SELECT id,company_id FROM users WHERE role='admin' AND active=1 ORDER BY created_at LIMIT 1").get();
    if (!admin) throw appError(503, 'ASISTIA todavía no ha terminado su configuración inicial.');
    const employeeNumber = input.employeeNumber || ('AS-' + createHash('sha256').update(input.id).digest('hex').slice(0,10).toUpperCase());
    const numberOwner = db.prepare('SELECT id FROM employees WHERE company_id=? AND employee_number=?').get(admin.company_id, employeeNumber);
    if (numberOwner && numberOwner.id !== input.id) throw appError(409, 'El número de empleado ya está vinculado a otra ficha.');
    const idOwner = db.prepare('SELECT company_id FROM employees WHERE id=?').get(input.id);
    if (idOwner && idOwner.company_id !== admin.company_id) throw appError(409, 'El identificador de empleado ya pertenece a otra empresa.');

    const employee = {
      id: input.id,
      companyId: admin.company_id,
      employeeNumber,
      fullName: input.fullName,
      branch: input.branch,
      active: input.active
    };
    const existingUser = db.prepare("SELECT id FROM users WHERE company_id=? AND employee_id=? AND role='worker' LIMIT 1")
      .get(admin.company_id, input.id);
    const userEmail = 'mobile+' + createHash('sha256').update(admin.company_id + ':' + input.id).digest('hex').slice(0,24) + '@asistia.local';
    const emailOwner = db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE LIMIT 1').get(userEmail);
    if (emailOwner && emailOwner.id !== existingUser?.id) throw appError(409, 'No se pudo reservar el identificador interno de acceso móvil.');
    const temporaryPassword = randomBytes(24).toString('base64url');
    const created = now();
    const workerId = existingUser?.id || randomUUID();

    db.transaction(() => {
      db.prepare(`INSERT INTO employees(id,company_id,employee_number,full_name,branch,active,created_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET employee_number=excluded.employee_number,
          full_name=excluded.full_name,branch=excluded.branch,active=excluded.active`)
        .run(employee.id, employee.companyId, employee.employeeNumber, employee.fullName, employee.branch, employee.active ? 1 : 0, created);
      if (existingUser) {
        db.prepare("UPDATE users SET name=?,email=?,password_hash=?,active=?,token_version=token_version+1 WHERE id=? AND company_id=?")
          .run(employee.fullName,userEmail,bcrypt.hashSync(temporaryPassword,12),employee.active ? 1 : 0,workerId,admin.company_id);
      } else {
        db.prepare("INSERT INTO users(id,company_id,name,email,password_hash,role,employee_id,active,created_at) VALUES(?,?,?,?,?,'worker',?,?,?)")
          .run(workerId,admin.company_id,employee.fullName,userEmail,bcrypt.hashSync(temporaryPassword,12),employee.id,employee.active ? 1 : 0,created);
      }
      writeAudit(admin.company_id,admin.id,'employee.mobile_access_generated','employee',employee.id,{
        employeeNumber:employee.employeeNumber,reset:Boolean(existingUser),active:employee.active
      });
    })();

    res.status(existingUser ? 200 : 201).json({
      ok:true,
      employee:{id:employee.id,employeeNumber:employee.employeeNumber,fullName:employee.fullName,branch:employee.branch},
      access:{login:employee.employeeNumber,password:temporaryPassword,temporary:true},
      reset:Boolean(existingUser)
    });
  } catch(error) { next(error); }
});
app.get('/api/desktop/mobile-recent', requireDesktopBridge, (req,res,next) => {
  try {
    const admin = db.prepare("SELECT company_id FROM users WHERE role='admin' AND active=1 ORDER BY created_at LIMIT 1").get();
    if (!admin) throw appError(503, 'ASISTIA todavía no ha terminado su configuración inicial.');
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const rows = db.prepare(
      'SELECT e.id,e.employee_id AS employeeId,p.employee_number AS employeeNumber,p.full_name AS fullName,' +
      'p.branch,e.event_type AS eventType,e.occurred_at AS occurredAt,e.source,' +
      'm.accuracy_m AS accuracyM,m.distance_m AS distanceM,m.accepted_at AS validatedAt ' +
      'FROM attendance_events e JOIN employees p ON p.id=e.employee_id ' +
      'JOIN mobile_attendance_evidence m ON m.attendance_event_id=e.id ' +
      'WHERE e.company_id=? ORDER BY e.occurred_at DESC LIMIT ?'
    ).all(admin.company_id,limit);
    res.json({records:rows});
  } catch(error) { next(error); }
});
app.get('/api/desktop/mobile-events', requireDesktopBridge, (req,res,next) => {
  try {
    const admin = db.prepare("SELECT company_id FROM users WHERE role='admin' AND active=1 ORDER BY created_at LIMIT 1").get();
    if (!admin) throw appError(503,'ASISTIA todavía no ha terminado su configuración inicial.');
    const limit = Math.min(10000,Math.max(1,Number(req.query.limit)||10000));
    // Incluye todos los orígenes para unir entradas y salidas mixtas (quiosco/móvil).
    // Los eventos históricos se usan como contexto; no generan jornadas duplicadas.
    const events = db.prepare(
      'SELECT e.id,e.employee_id AS employeeId,p.employee_number AS employeeNumber,p.full_name AS fullName,' +
      'p.branch,e.event_type AS eventType,e.occurred_at AS occurredAt,e.received_at AS receivedAt,e.source,' +
      'm.accuracy_m AS accuracyM,m.distance_m AS distanceM,m.accepted_at AS validatedAt ' +
      'FROM attendance_events e JOIN employees p ON p.id=e.employee_id ' +
      'LEFT JOIN mobile_attendance_evidence m ON m.attendance_event_id=e.id ' +
      'WHERE e.company_id=? ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT ?'
    ).all(admin.company_id,limit);
    res.json({events});
  } catch(error) { next(error); }
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

registerMobileRoutes(app, { db, authenticate, roles, writeAudit, writeEvent, now });

function isPrivateMobileCidr(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  const octets = parts[0].split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const prefix = parts.length === 1 ? 32 : Number(parts[1]);
  if (parts.length > 2 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const address = octets.reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32-prefix)) >>> 0;
  const start = (address & mask) >>> 0;
  const end = start + (2 ** (32-prefix)) - 1;
  const ranges = [[0x0a000000,0x0affffff],[0xac100000,0xac1fffff],[0xc0a80000,0xc0a8ffff]];
  return ranges.some(([low,high]) => start >= low && end <= high);
}
const desktopMobileSettingsSchema = z.object({
  branch:z.string().trim().min(1).max(100),
  latitude:z.number().min(-90).max(90),
  longitude:z.number().min(-180).max(180),
  radiusM:z.number().int().min(10).max(500).default(50),
  maxAccuracyM:z.number().int().min(5).max(100).default(50),
  allowedCidrs:z.array(z.string().max(20)).min(1).max(8)
    .refine(values => values.every(isPrivateMobileCidr),'Usa únicamente redes privadas IPv4 del establecimiento.')
});
app.get('/api/desktop/mobile-settings', requireDesktopBridge, (req,res,next) => {
  try {
    const admin = db.prepare("SELECT id,company_id FROM users WHERE role='admin' AND active=1 ORDER BY created_at LIMIT 1").get();
    if (!admin) throw appError(503,'ASISTIA todavía no ha terminado su configuración inicial.');
    const branch = String(req.query.branch || 'Principal').trim();
    const site = db.prepare('SELECT * FROM mobile_sites WHERE company_id=? AND branch=?').get(admin.company_id,branch);
    if (!site) return res.json({configured:false,branch});
    res.json({configured:true,settings:{
      id:site.id,branch:site.branch,latitude:site.latitude,longitude:site.longitude,
      radiusM:site.radius_m,maxAccuracyM:site.max_accuracy_m,
      allowedCidrs:JSON.parse(site.allowed_cidrs_json),active:Boolean(site.active),updatedAt:site.updated_at
    }});
  } catch(error) { next(error); }
});
app.put('/api/desktop/mobile-settings', requireDesktopBridge, (req,res,next) => {
  try {
    const input = desktopMobileSettingsSchema.parse(req.body);
    const admin = db.prepare("SELECT id,company_id FROM users WHERE role='admin' AND active=1 ORDER BY created_at LIMIT 1").get();
    if (!admin) throw appError(503,'ASISTIA todavía no ha terminado su configuración inicial.');
    const updatedAt = now();
    const existing = db.prepare('SELECT id FROM mobile_sites WHERE company_id=? AND branch=?').get(admin.company_id,input.branch);
    const id = existing?.id || randomUUID();
    db.prepare(
      'INSERT INTO mobile_sites(id,company_id,branch,latitude,longitude,radius_m,max_accuracy_m,allowed_cidrs_json,active,updated_at,updated_by) ' +
      'VALUES(?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(company_id,branch) DO UPDATE SET ' +
      'latitude=excluded.latitude,longitude=excluded.longitude,radius_m=excluded.radius_m,' +
      'max_accuracy_m=excluded.max_accuracy_m,allowed_cidrs_json=excluded.allowed_cidrs_json,active=1,' +
      'updated_at=excluded.updated_at,updated_by=excluded.updated_by'
    ).run(id,admin.company_id,input.branch,input.latitude,input.longitude,input.radiusM,input.maxAccuracyM,
      JSON.stringify(input.allowedCidrs),updatedAt,admin.id);
    writeAudit(admin.company_id,admin.id,'mobile.site_configured','mobile_site',id,{
      branch:input.branch,radiusM:input.radiusM,maxAccuracyM:input.maxAccuracyM,allowedCidrs:input.allowedCidrs
    });
    res.json({ok:true,configured:true,settings:{...input,id,active:true,updatedAt}});
  } catch(error) { next(error); }
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
let mobileHttpsServer = null;
const mobilePfxPath = process.env.MOBILE_HTTPS_PFX_PATH || '';
const mobilePfxPassphrase = process.env.MOBILE_HTTPS_PFX_PASSPHRASE || '';
const mobileKeyPath = process.env.MOBILE_HTTPS_KEY_PATH || '';
const mobileCertPath = process.env.MOBILE_HTTPS_CERT_PATH || '';
if (mobilePfxPath || mobileKeyPath || mobileCertPath) {
  const mobileHttpsPort = Number(process.env.MOBILE_HTTPS_PORT || 43178);
  const mobileHttpsHost = process.env.MOBILE_HTTPS_HOST || '0.0.0.0';
  if (!Number.isInteger(mobileHttpsPort) || mobileHttpsPort < 1 || mobileHttpsPort > 65535) throw new Error('MOBILE_HTTPS_PORT no es válido.');
  let tlsOptions;
  if (mobilePfxPath) {
    if (mobileKeyPath || mobileCertPath) throw new Error('Usa PFX o el par KEY/CERT, no ambos.');
    tlsOptions = { pfx: readFileSync(resolve(mobilePfxPath)), passphrase: mobilePfxPassphrase };
  } else {
    if (!mobileKeyPath || !mobileCertPath) throw new Error('Configura MOBILE_HTTPS_KEY_PATH y MOBILE_HTTPS_CERT_PATH juntos.');
    tlsOptions = { key: readFileSync(resolve(mobileKeyPath)), cert: readFileSync(resolve(mobileCertPath)) };
  }
  mobileHttpsServer = https.createServer(tlsOptions, app);
  mobileHttpsServer.listen(mobileHttpsPort, mobileHttpsHost, () => console.log('ASISTIA Móvil HTTPS escuchando en ' + mobileHttpsHost + ':' + mobileHttpsPort));
}
function shutdown() {
  const closeDatabase = () => { try { db.close(); } finally { process.exit(0); } };
  if (mobileHttpsServer && mobileHttpsServer.listening) {
    mobileHttpsServer.close(() => { if (server.listening) server.close(closeDatabase); else closeDatabase(); });
  } else if (server.listening) server.close(closeDatabase);
  else closeDatabase();
}
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
