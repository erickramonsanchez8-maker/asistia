import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';

test('la recuperación local cambia la contraseña, revoca sesiones y conserva datos', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asistia-recovery-test-'));
  const dbPath = join(dir, 'asistia.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL,
        email TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        token_version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE audit_log(id TEXT PRIMARY KEY, company_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, details_json TEXT NOT NULL,
        created_at TEXT NOT NULL, previous_hash TEXT, entry_hash TEXT NOT NULL);
      CREATE TABLE employees(id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
      CREATE TABLE attendance_events(id TEXT PRIMARY KEY, event_type TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run('admin-1','company-1','Admin','admin@example.test',bcrypt.hashSync('Old-password-12345',12),'admin',1,0);
    db.prepare('INSERT INTO employees VALUES(?,?)').run('employee-1','Persona de prueba');
    db.prepare('INSERT INTO attendance_events VALUES(?,?)').run('event-1','clock_in');
  } finally { db.close(); }
  try {
    const script = fileURLToPath(new URL('../src/recover-admin.js', import.meta.url));
    const child = spawn(process.execPath, [script], { env:{...process.env,DATABASE_PATH:dbPath}, stdio:['pipe','pipe','pipe'] });
    let stdout='', stderr='';
    child.stdout.on('data',x=>stdout+=x.toString());
    child.stderr.on('data',x=>stderr+=x.toString());
    const exitCode = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);child.stdin.end(JSON.stringify({email:'admin@example.test',password:'New-password-12345'}));});
    assert.equal(exitCode,0,stderr || stdout);
    const verify = new Database(dbPath);
    try {
      const user=verify.prepare('SELECT password_hash,token_version FROM users WHERE id=?').get('admin-1');
      assert.equal(bcrypt.compareSync('New-password-12345',user.password_hash),true);
      assert.equal(user.token_version,1);
      assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM employees').get().n,1);
      assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM attendance_events').get().n,1);
      assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='auth.admin_password_recovery'").get().n,1);
    } finally { verify.close(); }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
