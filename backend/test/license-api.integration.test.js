import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';

const backendDir = fileURLToPath(new URL('..', import.meta.url));
let child, baseUrl, tempDir, token, companyId, privateKey, publicKey;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function request(path, { method = 'GET', body, auth = true } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(auth && token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json() };
}
function license(overrides = {}) {
  const now = Date.now();
  const payload = {
    licenseId: 'integration-license-1', companyId, planCode: 'test',
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 7 * 86400000).toISOString(),
    offlineGraceUntil: new Date(now + 14 * 86400000).toISOString(),
    maxEmployees: 50, maxDevices: 2, licenseVersion: 1, status: 'active', ...overrides
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return encoded + '.' + signBytes('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url');
}

before(async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = keys.privateKey;
  publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  tempDir = await mkdtemp(join(tmpdir(), 'asistia-license-api-test-'));
  const port = await freePort();
  baseUrl = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
      DATABASE_PATH: join(tempDir, 'test.sqlite'), JWT_SECRET: 'test-secret-which-is-at-least-32-characters-long',
      BOOTSTRAP_COMPANY_NAME: 'Empresa de licencias', BOOTSTRAP_ADMIN_NAME: 'Admin prueba',
      BOOTSTRAP_ADMIN_EMAIL: 'license-test@example.com', BOOTSTRAP_ADMIN_PASSWORD: 'Password-seguro-12345',
      ASISTIA_LICENSE_PUBLIC_KEY: publicKey.replace(/\n/g, '\\n'), ASISTIA_LICENSE_ENFORCEMENT: 'false', CORS_ORIGIN: baseUrl },
    stdio: 'ignore'
  });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('La API de prueba terminó antes de iniciar.');
    try { if ((await fetch(baseUrl + '/api/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.equal((await fetch(baseUrl + '/api/health')).status, 200);
  const loginResponse = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'license-test@example.com', password: 'Password-seguro-12345' })
  });
  const login = await loginResponse.json();
  assert.equal(loginResponse.status, 200);
  token = login.token;
  companyId = login.user.companyId;
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('license status requires authentication and starts unlicensed', async () => {
  assert.equal((await request('/api/license/status', { auth: false })).status, 401);
  const result = await request('/api/license/status');
  assert.equal(result.status, 200);
  assert.equal(result.data.status, 'unlicensed');
  assert.equal(result.data.license, null);
});

test('license activation rejects malformed and cross-company documents', async () => {
  assert.equal((await request('/api/license/activate', { method: 'POST', body: { signedDocument: 'not-a-signed-license' } })).status, 422);
  const foreign = license({ companyId: '00000000-0000-4000-8000-000000000099' });
  assert.equal((await request('/api/license/activate', { method: 'POST', body: { signedDocument: foreign } })).status, 403);
});

test('valid signed license activates and status does not disclose the signed document', async () => {
  const signedDocument = license();
  const activation = await request('/api/license/activate', { method: 'POST', body: { signedDocument } });
  assert.equal(activation.status, 200, JSON.stringify(activation.data));
  assert.equal(activation.data.ok, true);
  assert.equal(activation.data.status, 'active');
  assert.equal(activation.data.license.licenseId, 'integration-license-1');
  assert.equal('signedDocument' in activation.data, false);
  const status = await request('/api/license/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.status, 'active');
  assert.equal(status.data.license.companyId, companyId);
  assert.equal(status.data.license.maxEmployees, 50);
  assert.equal('signedDocument' in status.data, false);
});

test('expired license is rejected and does not replace the active license', async () => {
  const now = Date.now();
  const expired = license({ licenseId: 'expired-license', issuedAt: new Date(now - 30 * 86400000).toISOString(),
    expiresAt: new Date(now - 2 * 86400000).toISOString(), offlineGraceUntil: new Date(now - 86400000).toISOString() });
  const result = await request('/api/license/activate', { method: 'POST', body: { signedDocument: expired } });
  assert.equal(result.status, 402);
  const status = await request('/api/license/status');
  assert.equal(status.data.license.licenseId, 'integration-license-1');
});
