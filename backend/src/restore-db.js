import 'dotenv/config';
import Database from 'better-sqlite3';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { decryptBackup, parseBackupKey } from './backup-crypto.js';

const [backupArg, targetArg] = process.argv.slice(2);
if (!backupArg || !targetArg) {
  console.error('Uso: npm run backup:restore -- <respaldo.asistia.enc> <ruta-destino-nueva.sqlite>');
  process.exit(2);
}
const backupPath = resolve(backupArg);
const targetPath = resolve(targetArg);
try { await stat(targetPath); throw new Error('La ruta destino ya existe. Elige una ruta nueva; no se sobrescribe ninguna base.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const key = parseBackupKey();
const plaintext = decryptBackup(await readFile(backupPath, 'utf8'), key);
await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
await writeFile(targetPath, plaintext, { flag: 'wx', mode: 0o600 });
let valid = false;
try {
  const db = new Database(targetPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check');
    const foreignKeys = db.pragma('foreign_key_check');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('La base restaurada no pasó integrity_check.');
    if (foreignKeys.length) throw new Error('La base restaurada tiene referencias foráneas inválidas.');
    for (const required of ['companies','users','employees','attendance_events','audit_log']) {
      if (!tables.has(required)) throw new Error(`El respaldo no contiene la tabla requerida: ${required}.`);
    }
    valid = true;
  } finally { db.close(); }
} finally {
  if (!valid) await rm(targetPath, { force: true });
}
console.log(JSON.stringify({ ok: true, restoredTo: targetPath, encryptedBackupVerified: true, integrity: 'ok' }));
