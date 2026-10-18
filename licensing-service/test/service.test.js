import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const adminToken = 'test-admin-token-which-is-at-least-32-characters-long';
let child, baseUrl, tempDir, privateKey, publicKey;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function request(path, { method = 'GET', body, admin = false } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(admin ? { Authorization: 'Bearer ' + adminToken } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json() };
}

before(async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  tempDir = await mkdtemp(join(tmpdir(), 'asistia-licensing-test-'));
  const port = await freePort();
  baseUrl = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: serviceDir,
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
      DATABASE_PATH: join(tempDir, 'test.sqlite'), LICENSING_ADMIN_TOKEN: adminToken,
      LICENSING_PRIVATE_KEY: privateKey },
    stdio: 'ignore'
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('El servicio de licencias terminó antes de iniciar.');
    try { if ((await fetch(baseUrl + '/v1/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.equal((await fetch(baseUrl + '/v1/health')).status, 200);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('no permite emitir licencias sin token administrativo', async () => {
  const result = await request('/v1/admin/licenses', { method: 'POST', body: {
    companyId: 'company-test', planCode: 'basic', maxEmployees: 10, maxDevices: 1, durationDays: 30
  }});
  assert.equal(result.status, 401);
});

test('emite código de un solo uso, firma documento compatible y aplica el límite de dispositivos', async () => {
  const issued = await request('/v1/admin/licenses', { method: 'POST', admin: true, body: {
    companyId: 'company-test', planCode: 'basic', maxEmployees: 10, maxDevices: 1, durationDays: 30
  }});
  assert.equal(issued.status, 201, JSON.stringify(issued.data));
  const { license, activationCode } = issued.data;
  const activation = await request('/v1/activate', { method: 'POST', body: {
    activationCode, companyId: 'company-test', deviceId: 'device-installation-0001'
  }});
  assert.equal(activation.status, 200, JSON.stringify(activation.data));
  const [payloadEncoded, signatureEncoded] = activation.data.signedDocument.split('.');
  assert.ok(payloadEncoded && signatureEncoded);
  const payload = JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString('utf8'));
  assert.equal(payload.companyId, 'company-test');
  assert.equal(payload.licenseId, license.licenseId);
  assert.equal(payload.maxDevices, 1);

  const reuseCode = await request('/v1/activate', { method: 'POST', body: {
    activationCode, companyId: 'company-test', deviceId: 'device-installation-0002'
  }});
  assert.equal(reuseCode.status, 403);
  const secondDevice = await request('/v1/activate', { method: 'POST', body: {
    activationCode: 'a'.repeat(40), companyId: 'company-test', deviceId: 'device-installation-0002'
  }});
  assert.equal(secondDevice.status, 403);
});

test('renovación exige secreto válido y revocación impide nuevas renovaciones', async () => {
  const issued = await request('/v1/admin/licenses', { method: 'POST', admin: true, body: {
    companyId: 'company-renew', planCode: 'pro', maxEmployees: 50, maxDevices: 2, durationDays: 30
  }});
  assert.equal(issued.status, 201);
  const activation = await request('/v1/activate', { method: 'POST', body: {
    activationCode: issued.data.activationCode, companyId: 'company-renew', deviceId: 'device-installation-2001'
  }});
  assert.equal(activation.status, 200);
  const { license } = activation.data;
  const invalid = await request('/v1/licenses/refresh', { method: 'POST', body: {
    licenseId: license.licenseId, deviceId: 'device-installation-2001', activationSecret: 'x'.repeat(40)
  }});
  assert.equal(invalid.status, 401);
  const refreshed = await request('/v1/licenses/refresh', { method: 'POST', body: {
    licenseId: license.licenseId, deviceId: 'device-installation-2001', activationSecret: activation.data.activationSecret
  }});
  assert.equal(refreshed.status, 200);
  const revoked = await request('/v1/admin/licenses/' + license.licenseId + '/revoke', { method: 'POST', admin: true, body: {} });
  assert.equal(revoked.status, 200);
  const denied = await request('/v1/licenses/refresh', { method: 'POST', body: {
    licenseId: license.licenseId, deviceId: 'device-installation-2001', activationSecret: activation.data.activationSecret
  }});
  assert.equal(denied.status, 403);
});
