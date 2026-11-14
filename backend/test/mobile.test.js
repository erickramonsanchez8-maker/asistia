import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const backendDir = fileURLToPath(new URL('..', import.meta.url));
let child;
let baseUrl;
let tempDir;
let adminToken;
let workerToken;
let employeeId;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function request(path, options) {
  const config = options || {};
  const headers = Object.assign({}, config.token ? { Authorization: 'Bearer ' + config.token } : {});
  if (config.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + path, {
    method: config.method || 'GET',
    headers,
    body: config.body ? JSON.stringify(config.body) : undefined
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'asistia-mobile-test-'));
  const port = await freePort();
  baseUrl = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_PATH: join(tempDir, 'mobile-test.sqlite'),
      JWT_SECRET: 'test-secret-for-asistia-mobile-with-at-least-32-characters',
      BOOTSTRAP_COMPANY_NAME: 'Empresa móvil QA',
      BOOTSTRAP_ADMIN_NAME: 'Admin móvil',
      BOOTSTRAP_ADMIN_EMAIL: 'admin-mobile@test.example',
      BOOTSTRAP_ADMIN_PASSWORD: 'Password-admin-movil-12345',
      CORS_ORIGIN: baseUrl
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('La API terminó antes de iniciar: ' + logs);
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const health = await fetch(baseUrl + '/api/health').catch(() => null);
  assert.ok(health && health.ok, 'La API móvil no inició correctamente. ' + logs);

  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-mobile@test.example', password: 'Password-admin-movil-12345' }
  });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.data));
  adminToken = adminLogin.data.token;

  const employee = await request('/api/employees', {
    method: 'POST',
    token: adminToken,
    body: { employeeNumber: 'MOB-001', fullName: 'Empleado Móvil', branch: 'Principal' }
  });
  assert.equal(employee.status, 201, JSON.stringify(employee.data));
  employeeId = employee.data.employee.id;

  const user = await request('/api/users', {
    method: 'POST',
    token: adminToken,
    body: {
      name: 'Empleado Móvil',
      email: 'worker-mobile@test.example',
      password: 'Password-worker-mobile-12345',
      role: 'worker',
      employeeId: employeeId
    }
  });
  assert.equal(user.status, 201, JSON.stringify(user.data));

  const workerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'worker-mobile@test.example', password: 'Password-worker-mobile-12345' }
  });
  assert.equal(workerLogin.status, 200, JSON.stringify(workerLogin.data));
  workerToken = workerLogin.data.token;

  const configured = await request('/api/mobile/settings', {
    method: 'PUT',
    token: adminToken,
    body: {
      branch: 'Principal',
      latitude: 19.700000,
      longitude: -103.460000,
      radiusM: 50,
      maxAccuracyM: 50,
      allowedCidrs: ['127.0.0.0/8']
    }
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('la PWA y el manifiesto se sirven desde la API', async () => {
  const page = await fetch(baseUrl + '/mobile/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ASISTIA Móvil/);
  const manifest = await fetch(baseUrl + '/mobile/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  const data = await manifest.json();
  assert.equal(data.display, 'standalone');
  assert.equal(data.start_url, '/mobile/');
});

test('la cuenta de trabajador solo recibe su expediente y política de ubicación', async () => {
  const profile = await request('/api/mobile/me', { token: workerToken });
  assert.equal(profile.status, 200, JSON.stringify(profile.data));
  assert.equal(profile.data.employee.id, employeeId);
  assert.equal(profile.data.policy.wifiRequired, true);
  assert.equal(profile.data.policy.gpsRequired, true);
  const status = await request('/api/mobile/status', { token: workerToken });
  assert.equal(status.status, 200);
  assert.equal(status.data.nextEventType, 'clock_in');
});

test('la configuración rechaza redes que no sean IPv4 CIDR', async () => {
  const invalid = await request('/api/mobile/settings', {
    method: 'PUT',
    token: adminToken,
    body: {
      branch: 'Otra sucursal',
      latitude: 19.7,
      longitude: -103.46,
      radiusM: 50,
      maxAccuracyM: 50,
      allowedCidrs: ['example.com']
    }
  });
  assert.equal(invalid.status, 400);
});

test('GPS fuera de radio o sin precisión suficiente no genera eventos', async () => {
  const outside = await request('/api/mobile/attendance', {
    method: 'POST',
    token: workerToken,
    body: {
      eventType: 'clock_in',
      latitude: 19.71,
      longitude: -103.46,
      accuracyM: 10,
      clientRequestId: randomUUID()
    }
  });
  assert.equal(outside.status, 403);
  const inaccurate = await request('/api/mobile/attendance', {
    method: 'POST',
    token: workerToken,
    body: {
      eventType: 'clock_in',
      latitude: 19.700001,
      longitude: -103.460001,
      accuracyM: 100,
      clientRequestId: randomUUID()
    }
  });
  assert.equal(inaccurate.status, 422);
  const status = await request('/api/mobile/status', { token: workerToken });
  assert.equal(status.data.nextEventType, 'clock_in');
});

test('solo la red LAN configurada puede usar la aplicación móvil', async () => {
  const changed = await request('/api/mobile/settings', {
    method: 'PUT',
    token: adminToken,
    body: {
      branch: 'Principal',
      latitude: 19.7,
      longitude: -103.46,
      radiusM: 50,
      maxAccuracyM: 50,
      allowedCidrs: ['10.0.0.0/8']
    }
  });
  assert.equal(changed.status, 200);
  const denied = await request('/api/mobile/me', { token: workerToken });
  assert.equal(denied.status, 403);
  const restored = await request('/api/mobile/settings', {
    method: 'PUT',
    token: adminToken,
    body: {
      branch: 'Principal',
      latitude: 19.7,
      longitude: -103.46,
      radiusM: 50,
      maxAccuracyM: 50,
      allowedCidrs: ['127.0.0.0/8']
    }
  });
  assert.equal(restored.status, 200);
});

test('los registros GPS válidos se guardan en la bitácora canónica de la API', async () => {
  const requestId = randomUUID();
  const entry = await request('/api/mobile/attendance', {
    method: 'POST',
    token: workerToken,
    body: {
      eventType: 'clock_in',
      latitude: 19.700001,
      longitude: -103.460001,
      accuracyM: 10,
      clientRequestId: requestId
    }
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.data));
  assert.equal(entry.data.event.source, 'mobile');
  assert.equal(entry.data.validation.wifi, 'accepted');
  assert.equal(entry.data.validation.gps, 'accepted');

  const duplicate = await request('/api/mobile/attendance', {
    method: 'POST',
    token: workerToken,
    body: {
      eventType: 'clock_in',
      latitude: 19.700001,
      longitude: -103.460001,
      accuracyM: 10,
      clientRequestId: requestId
    }
  });
  assert.equal(duplicate.status, 409);

  const exit = await request('/api/mobile/attendance', {
    method: 'POST',
    token: workerToken,
    body: {
      eventType: 'clock_out',
      latitude: 19.700001,
      longitude: -103.460001,
      accuracyM: 10,
      clientRequestId: randomUUID()
    }
  });
  assert.equal(exit.status, 201, JSON.stringify(exit.data));

  const events = await request('/api/attendance/events', { token: adminToken });
  assert.equal(events.status, 200);
  const mobileEvents = events.data.events.filter(event => event.employeeId === employeeId && event.source === 'mobile');
  assert.equal(mobileEvents.length, 2);

  const recent = await request('/api/mobile/recent', { token: adminToken });
  assert.equal(recent.status, 200);
  assert.equal(recent.data.records.length, 2);
  assert.equal('latitude' in recent.data.records[0], false);
  assert.equal('longitude' in recent.data.records[0], false);
});
