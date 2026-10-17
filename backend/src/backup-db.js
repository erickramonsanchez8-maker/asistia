import 'dotenv/config';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { encryptBackup, parseBackupKey } from './backup-crypto.js';

const source = resolve(process.env.DATABASE_PATH || './data/asistia.sqlite');
const destinationDir = resolve(process.env.BACKUP_DIR || './backups');
const key = parseBackupKey();
const check = new Database(source, { readonly: true, fileMustExist: true });
try {
  const result = check.pragma('integrity_check');
  if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error('La base de datos no pasó integrity_check; se cancela el respaldo.');
} finally {
  check.close();
}

await mkdir(destinationDir, { recursive: true, mode: 0o700 });
const tempPath = resolve(tmpdir(), `asistia-${randomUUID()}.sqlite`);
try {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try { await db.backup(tempPath); } finally { db.close(); }
  const plaintext = await readFile(tempPath);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const output = resolve(destinationDir, `asistia-${stamp}.asistia.enc`);
  await writeFile(output, encryptBackup(plaintext, key), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ok: true, backup: output, bytesEncrypted: (await readFile(output)).byteLength, encrypted: true }));
} finally {
  await rm(tempPath, { force: true });
}
