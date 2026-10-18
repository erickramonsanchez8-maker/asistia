import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyLicenseDocument } from '../src/license-verifier.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

function makeLicense(overrides = {}) {
  const payload = {
    licenseId: 'lic-test-001',
    companyId: 'company-test-001',
    planCode: 'starter',
    status: 'active',
    issuedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-11-01T00:00:00.000Z',
    offlineGraceUntil: '2026-11-08T00:00:00.000Z',
    maxEmployees: 10,
    maxDevices: 1,
    licenseVersion: 1,
    ...overrides
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  const signature = sign('RSA-SHA256', bytes, privateKey);
  return `${bytes.toString('base64url')}.${signature.toString('base64url')}`;
}

test('acepta licencia firmada vigente y devuelve límites', () => {
  const result = verifyLicenseDocument(makeLicense(), publicKey, new Date('2026-10-18T12:00:00Z'));
  assert.equal(result.status, 'active');
  assert.equal(result.maxEmployees, 10);
  assert.equal(result.maxDevices, 1);
  assert.equal(result.companyId, 'company-test-001');
});

test('permite estado de gracia solo hasta la fecha firmada', () => {
  const result = verifyLicenseDocument(makeLicense(), publicKey, new Date('2026-11-05T00:00:00Z'));
  assert.equal(result.status, 'offline_grace');
  assert.equal(
    verifyLicenseDocument(makeLicense(), publicKey, new Date('2026-11-09T00:00:00Z')).status,
    'expired'
  );
});

test('rechaza documentos alterados o firmados con otra clave', () => {
  const valid = makeLicense();
  const [payload] = valid.split('.');
  const alteredPayload = Buffer.from(JSON.stringify({
    licenseId: 'lic-test-001',
    companyId: 'company-test-001',
    planCode: 'starter',
    status: 'active',
    issuedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-11-01T00:00:00.000Z',
    offlineGraceUntil: '2026-11-08T00:00:00.000Z',
    maxEmployees: 999,
    maxDevices: 1,
    licenseVersion: 1
  })).toString('base64url');
  assert.throws(() => verifyLicenseDocument(`${alteredPayload}.${valid.split('.')[1]}`, publicKey, new Date('2026-10-18T00:00:00Z')), /firma/);
  assert.throws(() => verifyLicenseDocument(valid, 'invalid public key', new Date('2026-10-18T00:00:00Z')));
  assert.ok(payload);
});

test('rechaza licencia con campos o límites inválidos aunque esté firmada', () => {
  assert.throws(() => verifyLicenseDocument(makeLicense({ maxEmployees: 0 }), publicKey, new Date('2026-10-18T00:00:00Z')), /límite de empleados/);
  assert.throws(() => verifyLicenseDocument(makeLicense({ status: 'revoked' }), publicKey, new Date('2026-10-18T00:00:00Z')), /no está activa/);
});

test('rechaza licencia emitida en el futuro y fechas incoherentes', () => {
  assert.throws(() => verifyLicenseDocument(makeLicense({ issuedAt: '2027-01-01T00:00:00Z' }), publicKey, new Date('2026-10-18T00:00:00Z')), /futuro/);
  assert.throws(() => verifyLicenseDocument(makeLicense({ offlineGraceUntil: '2026-10-15T00:00:00Z' }), publicKey, new Date('2026-10-18T00:00:00Z')), /coherente/);
});
