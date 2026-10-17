import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

test('UUIDs para entidades nuevas no se repiten', () => {
  const ids=new Set(Array.from({length:1000},()=>randomUUID()));
  assert.equal(ids.size,1000);
});

test('la huella cambia cuando cambia el contenido del evento', () => {
  const base={id:'evt-1',employeeId:'emp-1',eventType:'clock_in',occurredAt:'2026-10-15T08:00:00.000Z'};
  const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.notEqual(hash(base),hash({...base,occurredAt:'2026-10-15T08:01:00.000Z'}));
});

import { encryptBackup, decryptBackup, parseBackupKey } from '../src/backup-crypto.js';

test('los respaldos cifrados se descifran y detectan alteraciones', () => {
  const key = Buffer.from('0123456789abcdef'.repeat(4), 'hex');
  const original = Buffer.from('ASISTIA backup fixture: datos de prueba');
  const encrypted = encryptBackup(original, key);
  assert.deepEqual(decryptBackup(encrypted, key), original);
  const tampered = JSON.parse(encrypted);
  tampered.ciphertext = (tampered.ciphertext[0] === 'A' ? 'B' : 'A') + tampered.ciphertext.slice(1);
  assert.throws(() => decryptBackup(JSON.stringify(tampered), key));
});

test('la clave de respaldo exige 32 bytes en hexadecimal', () => {
  assert.equal(parseBackupKey('ab'.repeat(32)).length, 32);
  assert.throws(() => parseBackupKey('clave-corta'));
});
