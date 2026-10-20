import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes, sign as signBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import express from 'express';

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const activationCodeForTest = 'activation-code-for-integration-test';
const localStorageKey = randomBytes(32).toString('base64');
const installationCredential = randomBytes(32).toString('base64url');
let backendProcess, backendUrl, tempDir, databasePath, authToken, companyId, remoteServer, remoteUrl;
let signingPrivateKey, signingPublicKey, currentVersion = 1, remoteSuspended = false;

async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function signedLicense(overrides = {}) {
  const timestamp = Date.now();
  const payload = {
    licenseId: 'remote-e2e-license', companyId, planCode: 'test',
    status: 'active', issuedAt: new Date(timestamp - 60000).toISOString(),
    expiresAt: new Date(timestamp + 7 * 86400000).toISOString(),
    offlineGraceUntil: new Date(timestamp + 14 * 86400000).toISOString(),
    maxEmployees: 5, maxDevices: 1, licenseVersion: currentVersion, ...overrides
  };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return bytes.toString('base64url') + '.' + signBytes('RSA-SHA256', bytes, signingPrivateKey).toString('base64url');
}
async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(backendUrl + path, {
    method,
    headers: { Authorization: 'Bearer ' + authToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json() };
}

before(async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  signingPrivateKey = keys.privateKey;
  signingPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });

  const remoteApp = express();
  remoteApp.use(express.json());
  remoteApp.post('/v1/activate', (req, res) => {
    if (req.body.activationCode !== activationCodeForTest) return res.status(403).json({ error: 'Código inválido.' });
    res.json({ signedDocument: signedLicense({ companyId: req.body.companyId }), activationSecret: installationCredential });
  });
  remoteApp.post('/v1/licenses/refresh', (req, res) => {
    if (req.body.activationSecret !== installationCredential) return res.status(401).json({ error: 'Credencial de activación inválida.' });
    if (remoteSuspended) return res.status(403).json({ error: 'La licencia está suspendida.' });
    currentVersion = 2;
    res.json({ signedDocument: signedLicense({ companyId }), validatedAt: new Date().toISOString() });
  });
  remoteApp.post('/v1/licenses/deactivate', (req, res) => {
    if (req.body.activationSecret !== installationCredential) return res.status(401).json({ error: 'Credencial de activación inválida.' });
    res.json({ ok: true, deactivated: true });
  });
  remoteServer = remoteApp.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { remoteServer.once('listening', resolve); remoteServer.once('error', reject); });
  remoteUrl = 'http://127.0.0.1:' + remoteServer.address().port;

  tempDir = await mkdtemp(join(tmpdir(), 'asistia-remote-license-test-'));
  databasePath = join(tempDir, 'backend.sqlite');
  const port = await freePort();
  backendUrl = 'http://127.0.0.1:' + port;
  backendProcess = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
      DATABASE_PATH: databasePath, JWT_SECRET: 'integration-test-jwt-secret-at-least-32-characters',
      BOOTSTRAP_COMPANY_NAME: 'Empresa prueba licencia remota', BOOTSTRAP_ADMIN_NAME: 'Admin',
      BOOTSTRAP_ADMIN_EMAIL: 'remote-license@example.test', BOOTSTRAP_ADMIN_PASSWORD: 'Password-seguro-12345',
      ASISTIA_LICENSE_PUBLIC_KEY: signingPublicKey.replace(/\n/g, '\\n'),
      ASISTIA_LICENSE_ENFORCEMENT: 'true', CORS_ORIGIN: backendUrl,
      LICENSING_SERVICE_URL: remoteUrl, ASISTIA_LICENSE_STORAGE_KEY: localStorageKey },
    stdio: 'ignore'
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (backendProcess.exitCode !== null) throw new Error('La API local terminó antes de iniciar.');
    try { if ((await fetch(backendUrl + '/api/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.equal((await fetch(backendUrl + '/api/health')).status, 200);
  const loginResponse = await fetch(backendUrl + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'remote-license@example.test', password: 'Password-seguro-12345' })
  });
  const login = await loginResponse.json();
  assert.equal(loginResponse.status, 200);
  authToken = login.token;
  companyId = login.user.companyId;
});

after(async () => {
  if (backendProcess && backendProcess.exitCode === null) {
    backendProcess.kill('SIGTERM');
    await new Promise(resolve => backendProcess.once('exit', resolve));
  }
  if (remoteServer) await new Promise(resolve => remoteServer.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('la API local activa, renueva y desactiva usando el servicio remoto', async () => {
  const activation = await request('/api/license/activate', {
    method: 'POST', body: { activationCode: activationCodeForTest }
  });
  assert.equal(activation.status, 200, JSON.stringify(activation.data));
  assert.equal(activation.data.remoteActivation, true);
  assert.equal(activation.data.license.licenseId, 'remote-e2e-license');

  const status = await request('/api/license/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.remoteActivation, true);
  assert.equal(status.data.license.licenseId, 'remote-e2e-license');
  assert.equal('activationSecret' in status.data, false);

  const db = new Database(databasePath);
  try {
    const row = db.prepare('SELECT activation_secret_encrypted,device_id FROM license_state WHERE company_id=?').get(companyId);
    assert.ok(row.device_id);
    assert.ok(row.activation_secret_encrypted);
    assert.equal(row.activation_secret_encrypted.includes(installationCredential), false);
  } finally { db.close(); }

  const refreshed = await request('/api/license/refresh', { method: 'POST', body: {} });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
  assert.equal(refreshed.data.license.licenseVersion, 2);

  remoteSuspended = true;
  const suspendedRefresh = await request('/api/license/refresh', { method: 'POST', body: {} });
  assert.equal(suspendedRefresh.status, 403);
  const suspendedStatus = await request('/api/license/status');
  assert.equal(suspendedStatus.data.status, 'suspended');
  remoteSuspended = false;
  const resumedRefresh = await request('/api/license/refresh', { method: 'POST', body: {} });
  assert.equal(resumedRefresh.status, 200, JSON.stringify(resumedRefresh.data));
  const resumedStatus = await request('/api/license/status');
  assert.equal(resumedStatus.data.status, 'active');

  const deactivated = await request('/api/license/deactivate', { method: 'POST', body: {} });
  assert.equal(deactivated.status, 200, JSON.stringify(deactivated.data));
  assert.equal(deactivated.data.historyPreserved, true);
  const finalStatus = await request('/api/license/status');
  assert.equal(finalStatus.status, 200);
  assert.equal(finalStatus.data.status, 'deactivated');
  assert.equal(finalStatus.data.remoteActivation, false);
});
