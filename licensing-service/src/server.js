import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID, createHash, createPrivateKey, sign as signBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '32kb', strict: true }));
app.use('/v1', rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

const PORT = Number(process.env.PORT || 3400);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = resolve(process.env.DATABASE_PATH || './data/licensing.sqlite');
const ADMIN_TOKEN = process.env.LICENSING_ADMIN_TOKEN || '';
const PRIVATE_KEY_TEXT = (process.env.LICENSING_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
const GRACE_DAYS = 7;
const appError = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date();
const iso = date => date.toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const randomSecret = bytes => randomBytes(bytes).toString('base64url');

if (ADMIN_TOKEN.length < 32) throw new Error('LICENSING_ADMIN_TOKEN debe tener al menos 32 caracteres.');
if (!PRIVATE_KEY_TEXT) throw new Error('LICENSING_PRIVATE_KEY es obligatoria y solo debe existir en el servidor remoto.');
const privateKey = createPrivateKey(PRIVATE_KEY_TEXT);
if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
  throw new Error('LICENSING_PRIVATE_KEY debe ser RSA de al menos 2048 bits.');

}
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, plan_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  activation_code_hash TEXT UNIQUE, max_employees INTEGER NOT NULL,
  max_devices INTEGER NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activations (
  id TEXT PRIMARY KEY, license_id TEXT NOT NULL REFERENCES licenses(id),
  device_id TEXT NOT NULL, secret_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','deactivated')),
  activated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, deactivated_at TEXT,
  UNIQUE(license_id, device_id)
);
CREATE TABLE IF NOT EXISTS license_audit (
  id TEXT PRIMARY KEY, license_id TEXT NOT NULL, event_type TEXT NOT NULL,
  details_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activations_license_status ON activations(license_id,status);
`);

function audit(licenseId, eventType, details = {}) {
  db.prepare('INSERT INTO license_audit(id,license_id,event_type,details_json,created_at) VALUES(?,?,?,?,?)')
    .run(randomUUID(), licenseId, eventType, JSON.stringify(details), iso(now()));
}
function signLicense(row) {
  const issuedAt = iso(now());
  const expiresAt = row.expires_at;
  const offlineGraceUntil = iso(new Date(Date.parse(expiresAt) + GRACE_DAYS * 86400000));
  const payload = {
    licenseId: row.id, companyId: row.company_id, planCode: row.plan_code, status: 'active',
    issuedAt, expiresAt, offlineGraceUntil, maxEmployees: row.max_employees,
    maxDevices: row.max_devices, licenseVersion: row.version
  };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return bytes.toString('base64url') + '.' + signBytes('RSA-SHA256', bytes, privateKey).toString('base64url');
}
function publicLicense(row) {
  return { licenseId: row.id, companyId: row.company_id, planCode: row.plan_code, status: row.status,
    maxEmployees: row.max_employees, maxDevices: row.max_devices, issuedAt: row.issued_at, expiresAt: row.expires_at, version: row.version };
}
function adminOnly(req, res, next) {
  const header = req.get('authorization') || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(supplied); const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return next(appError(401, 'Autenticación administrativa inválida.'));
  next();
}
function activationFor(licenseId, deviceId, secret) {
  const activation = db.prepare("SELECT * FROM activations WHERE license_id=? AND device_id=? AND status='active'").get(licenseId, deviceId);
  if (!activation || hash(secret) !== activation.secret_hash) throw appError(401, 'La activación del dispositivo no es válida.');
  return activation;
}
const issueSchema = z.object({
  companyId: z.string().trim().min(1).max(128),
  planCode: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  maxEmployees: z.number().int().min(1).max(100000),
  maxDevices: z.number().int().min(1).max(100),
  durationDays: z.number().int().min(1).max(3660)
});
const activationSchema = z.object({
  activationCode: z.string().min(20).max(128),
  companyId: z.string().trim().min(1).max(128),
  deviceId: z.string().trim().min(8).max(128)
});
const deviceSchema = z.object({
  licenseId: z.string().uuid(),
  deviceId: z.string().trim().min(8).max(128),
  activationSecret: z.string().min(20).max(128)
});

app.get('/v1/health', (req, res) => res.json({ status: 'ok', service: 'ASISTIA Licensing', time: iso(now()) }));

app.post('/v1/admin/licenses', adminOnly, (req, res, next) => {
  try {
    const input = issueSchema.parse(req.body);
    const id = randomUUID(), activationCode = randomSecret(32), created = now();
    const expiresAt = iso(new Date(created.getTime() + input.durationDays * 86400000));
    db.prepare(`INSERT INTO licenses(id,company_id,plan_code,status,activation_code_hash,max_employees,max_devices,issued_at,expires_at,version,created_at,updated_at)
      VALUES(?,?,?,'active',?,?,?,?,?,1,?,?)`)
      .run(id, input.companyId, input.planCode, hash(activationCode), input.maxEmployees, input.maxDevices, iso(created), expiresAt, iso(created), iso(created));
    audit(id, 'license.issued', { planCode: input.planCode, maxEmployees: input.maxEmployees, maxDevices: input.maxDevices });
    res.status(201).json({ license: publicLicense(db.prepare('SELECT * FROM licenses WHERE id=?').get(id)), activationCode });
  } catch (error) { next(error); }
});

app.post('/v1/activate', (req, res, next) => {
  try {
    const input = activationSchema.parse(req.body);
    const license = db.prepare('SELECT * FROM licenses WHERE activation_code_hash=?').get(hash(input.activationCode));
    if (!license || license.status !== 'active') throw appError(403, 'El código de activación es inválido o la licencia está revocada.');
    if (license.company_id !== input.companyId) throw appError(403, 'La licencia no corresponde a esta empresa.');
    if (Date.parse(license.expires_at) < now().getTime()) throw appError(402, 'La suscripción venció; solicita una renovación al proveedor.');
    let activation = db.prepare('SELECT * FROM activations WHERE license_id=? AND device_id=?').get(license.id, input.deviceId);
    let activationSecret;
    if (activation?.status === 'active') {
      // No devolver el secreto anterior: el cliente debe conservarlo localmente.
      throw appError(409, 'Este dispositivo ya está activado. Usa la renovación con las credenciales guardadas.');
    }
    const activeCount = db.prepare("SELECT COUNT(*) AS total FROM activations WHERE license_id=? AND status='active'").get(license.id).total;
    if (activeCount >= license.max_devices) throw appError(409, 'Se alcanzó el límite de dispositivos de esta licencia.');
    activationSecret = randomSecret(32);
    const timestamp = iso(now());
    if (activation) {
      db.prepare("UPDATE activations SET secret_hash=?,status='active',activated_at=?,last_seen_at=?,deactivated_at=NULL WHERE id=?")
        .run(hash(activationSecret), timestamp, timestamp, activation.id);
    } else {
      db.prepare("INSERT INTO activations(id,license_id,device_id,secret_hash,status,activated_at,last_seen_at) VALUES(?,?,?,?, 'active',?,?)")
        .run(randomUUID(), license.id, input.deviceId, hash(activationSecret), timestamp, timestamp);
    }
    // Codes can activate one device only; administrative issuance creates a new code for a replacement.
    db.prepare('UPDATE licenses SET activation_code_hash=NULL,updated_at=? WHERE id=?').run(timestamp, license.id);
    audit(license.id, 'device.activated', { deviceId: input.deviceId });
    const updated = db.prepare('SELECT * FROM licenses WHERE id=?').get(license.id);
    res.status(200).json({ signedDocument: signLicense(updated), activationSecret, license: publicLicense(updated) });
  } catch (error) { next(error); }
});

app.post('/v1/licenses/refresh', (req, res, next) => {
  try {
    const input = deviceSchema.parse(req.body);
    activationFor(input.licenseId, input.deviceId, input.activationSecret);
    const license = db.prepare('SELECT * FROM licenses WHERE id=?').get(input.licenseId);
    if (!license || license.status !== 'active') throw appError(403, 'La licencia está revocada o no existe.');
    if (Date.parse(license.expires_at) < now().getTime()) throw appError(402, 'La suscripción venció; el administrador debe renovarla.');
    const timestamp = iso(now());
    db.prepare('UPDATE activations SET last_seen_at=? WHERE license_id=? AND device_id=?').run(timestamp, license.id, input.deviceId);
    audit(license.id, 'license.refreshed', { deviceId: input.deviceId });
    res.json({ signedDocument: signLicense(license), license: publicLicense(license), validatedAt: timestamp });
  } catch (error) { next(error); }
});

app.post('/v1/licenses/deactivate', (req, res, next) => {
  try {
    const input = deviceSchema.parse(req.body);
    activationFor(input.licenseId, input.deviceId, input.activationSecret);
    const timestamp = iso(now());
    db.prepare("UPDATE activations SET status='deactivated',deactivated_at=?,last_seen_at=? WHERE license_id=? AND device_id=?")
      .run(timestamp, timestamp, input.licenseId, input.deviceId);
    audit(input.licenseId, 'device.deactivated', { deviceId: input.deviceId });
    res.json({ ok: true, deactivated: true });
  } catch (error) { next(error); }
});

app.post('/v1/admin/licenses/:id/activation-code', adminOnly, (req, res, next) => {
  try {
    const license = db.prepare("SELECT * FROM licenses WHERE id=? AND status='active'").get(req.params.id);
    if (!license) throw appError(404, 'Licencia activa no encontrada.');
    const activeCount = db.prepare("SELECT COUNT(*) AS total FROM activations WHERE license_id=? AND status='active'").get(license.id).total;
    if (activeCount >= license.max_devices) throw appError(409, 'No hay cupos de dispositivo disponibles; desactiva uno antes de emitir otro código.');
    const activationCode = randomSecret(32);
    const timestamp = iso(now());
    db.prepare('UPDATE licenses SET activation_code_hash=?,updated_at=? WHERE id=?').run(hash(activationCode), timestamp, license.id);
    audit(license.id, 'activation_code.issued', {});
    res.status(201).json({ licenseId: license.id, activationCode });
  } catch (error) { next(error); }
});

app.post('/v1/admin/licenses/:id/renew', adminOnly, (req, res, next) => {
  try {
    const input = z.object({ durationDays: z.number().int().min(1).max(3660) }).parse(req.body);
    const license = db.prepare("SELECT * FROM licenses WHERE id=? AND status='active'").get(req.params.id);
    if (!license) throw appError(404, 'Licencia activa no encontrada.');
    const base = Math.max(Date.parse(license.expires_at), now().getTime());
    const expiresAt = iso(new Date(base + input.durationDays * 86400000));
    const timestamp = iso(now());
    db.prepare('UPDATE licenses SET expires_at=?,version=version+1,updated_at=? WHERE id=?').run(expiresAt, timestamp, license.id);
    audit(license.id, 'license.renewed', { durationDays: input.durationDays, expiresAt });
    const updated = db.prepare('SELECT * FROM licenses WHERE id=?').get(license.id);
    res.json({ license: publicLicense(updated) });
  } catch (error) { next(error); }
});

app.post('/v1/admin/licenses/:id/revoke', adminOnly, (req, res, next) => {
  try {
    const license = db.prepare("SELECT * FROM licenses WHERE id=? AND status='active'").get(req.params.id);
    if (!license) throw appError(404, 'Licencia activa no encontrada.');
    const timestamp = iso(now());
    db.prepare("UPDATE licenses SET status='revoked',updated_at=?,version=version+1 WHERE id=?").run(timestamp, license.id);
    audit(license.id, 'license.revoked');
    res.json({ ok: true, licenseId: license.id, status: 'revoked' });
  } catch (error) { next(error); }
});

app.use((req, res, next) => next(appError(404, 'Ruta no encontrada.')));
app.use((error, req, res, next) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) });
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Ya existe un registro con esos datos.' });
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'Error interno del servidor.' : error.message });
});

const server = app.listen(PORT, HOST, () => console.log(`ASISTIA Licensing escuchando en ${HOST}:${PORT}`));
function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
