import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw); } catch { console.error('Solicitud de recuperación inválida.'); process.exit(2); }
const email = String(input.email || '').trim().toLowerCase();
const password = String(input.password || '');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('Correo inválido.'); process.exit(2); }
if (password.length < 14 || password.length > 200) { console.error('La nueva contraseña debe tener entre 14 y 200 caracteres.'); process.exit(2); }
const dbPath = resolve(process.env.DATABASE_PATH || './data/asistia.sqlite');
const db = new Database(dbPath);
try {
  db.pragma('foreign_keys = ON');
  const user = db.prepare("SELECT id,company_id FROM users WHERE lower(email)=? AND role='admin' AND active=1").get(email);
  if (!user) { console.error('No se encontró una cuenta administradora activa con ese correo.'); process.exitCode = 3; }
  else {
    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET password_hash=?,token_version=token_version+1 WHERE id=? AND company_id=?')
        .run(bcrypt.hashSync(password, 12), user.id, user.company_id);
      const previous = db.prepare('SELECT entry_hash FROM audit_log WHERE company_id=? ORDER BY rowid DESC LIMIT 1').get(user.company_id)?.entry_hash || null;
      const created = new Date().toISOString(), id = randomUUID(), action = 'auth.admin_password_recovery';
      const payload = JSON.stringify({ id, companyId:user.company_id, actorId:user.id, action, entityType:'user', entityId:user.id, details:{method:'local-desktop-recovery'}, created, prev:previous });
      const hash = createHash('sha256').update(payload).digest('hex');
      db.prepare('INSERT INTO audit_log (id,company_id,actor_id,action,entity_type,entity_id,details_json,created_at,previous_hash,entry_hash) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id,user.company_id,user.id,action,'user',user.id,JSON.stringify({method:'local-desktop-recovery'}),created,previous,hash);
    });
    tx();
    console.log('Contraseña restablecida. Las sesiones anteriores quedaron revocadas.');
  }
} finally { db.close(); }
