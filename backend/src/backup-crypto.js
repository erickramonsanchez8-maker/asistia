import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function parseBackupKey(value = process.env.BACKUP_ENCRYPTION_KEY || '') {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('BACKUP_ENCRYPTION_KEY debe ser una clave hexadecimal de 64 caracteres (32 bytes).');
  }
  return Buffer.from(value, 'hex');
}

export function encryptBackup(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    format: 'ASISTIA-ENCRYPTED-BACKUP',
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('base64')
  });
}

export function decryptBackup(serialized, key) {
  const envelope = JSON.parse(serialized);
  if (envelope?.format !== 'ASISTIA-ENCRYPTED-BACKUP' || envelope?.version !== 1 || envelope?.algorithm !== 'aes-256-gcm') {
    throw new Error('Formato de respaldo ASISTIA no reconocido.');
  }
  if (!/^[a-f0-9]{24}$/i.test(envelope.iv || '') || !/^[a-f0-9]{32}$/i.test(envelope.tag || '') || typeof envelope.ciphertext !== 'string') {
    throw new Error('El respaldo está incompleto o mal formado.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
}
