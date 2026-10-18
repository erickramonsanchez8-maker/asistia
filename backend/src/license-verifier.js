import { verify as verifySignature } from 'node:crypto';

/**
 * Verifies a signed ASISTIA license document.
 *
 * Format: base64url(UTF-8 JSON payload).base64url(RSA-SHA256 signature)
 * The signing private key must remain on the licensing server. Only its public
 * key may be distributed with ASISTIA Desktop.
 */
export function verifyLicenseDocument(document, publicKey, now = new Date()) {
  if (typeof document !== 'string' || document.length > 16_384) {
    throw new Error('Documento de licencia inválido.');
  }
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    throw new Error('No se configuró la clave pública de licencias.');
  }

  const parts = document.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Formato de licencia inválido.');
  }

  let payloadBytes;
  let signature;
  try {
    payloadBytes = Buffer.from(parts[0], 'base64url');
    signature = Buffer.from(parts[1], 'base64url');
  } catch {
    throw new Error('Codificación de licencia inválida.');
  }
  if (!payloadBytes.length || !signature.length) {
    throw new Error('Licencia incompleta.');
  }

  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new Error('El contenido de la licencia no es JSON válido.');
  }

  const validSignature = verifySignature(
    'RSA-SHA256',
    payloadBytes,
    publicKey,
    signature
  );
  if (!validSignature) throw new Error('La firma de la licencia no es válida.');

  const requiredStrings = ['licenseId', 'companyId', 'planCode', 'issuedAt', 'expiresAt', 'offlineGraceUntil'];
  for (const field of requiredStrings) {
    if (typeof payload[field] !== 'string' || !payload[field].trim()) {
      throw new Error(`La licencia no contiene un campo válido: ${field}.`);
    }
  }
  if (!Number.isInteger(payload.maxEmployees) || payload.maxEmployees < 1) {
    throw new Error('El límite de empleados de la licencia no es válido.');
  }
  if (!Number.isInteger(payload.maxDevices) || payload.maxDevices < 1) {
    throw new Error('El límite de dispositivos de la licencia no es válido.');
  }
  if (!Number.isInteger(payload.licenseVersion) || payload.licenseVersion < 1) {
    throw new Error('La versión del documento de licencia no es válida.');
  }

  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  const offlineGraceUntil = Date.parse(payload.offlineGraceUntil);
  const currentTime = now instanceof Date ? now.getTime() : Date.parse(now);

  if (![issuedAt, expiresAt, offlineGraceUntil, currentTime].every(Number.isFinite)) {
    throw new Error('Las fechas de la licencia no son válidas.');
  }
  if (issuedAt > currentTime + 5 * 60 * 1000) {
    throw new Error('La licencia parece emitida en el futuro.');
  }
  if (expiresAt < issuedAt || offlineGraceUntil < expiresAt) {
    throw new Error('La vigencia de la licencia no es coherente.');
  }
  if (payload.status !== 'active') {
    throw new Error('La licencia no está activa.');
  }

  let state = 'active';
  if (currentTime > expiresAt && currentTime <= offlineGraceUntil) state = 'offline_grace';
  if (currentTime > offlineGraceUntil) state = 'expired';

  return Object.freeze({
    licenseId: payload.licenseId,
    companyId: payload.companyId,
    planCode: payload.planCode,
    status: state,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    offlineGraceUntil: new Date(offlineGraceUntil).toISOString(),
    maxEmployees: payload.maxEmployees,
    maxDevices: payload.maxDevices,
    licenseVersion: payload.licenseVersion
  });
}
