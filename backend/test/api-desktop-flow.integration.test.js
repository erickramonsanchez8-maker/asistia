import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../desktop/api-client.js';

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const serverFile = fileURLToPath(new URL('../src/server.js', import.meta.url));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, child, getOutput) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('La API terminó antes de iniciar.\n' + getOutput());
    try {
      const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response.json();
      lastError = new Error('Health HTTP ' + response.status);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('La API no inició a tiempo: ' + String(lastError) + '\n' + getOutput());
}

test('flujo integrado: API real + cliente desktop, empleado, marcas y reporte', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'asistia-api-flow-'));
  const port = await unusedPort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const password = 'Test-Admin-Passphrase-2026!';
  let output = '';
  const child = spawn(process.execPath, [serverFile], {
    cwd: backendDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_PATH: join(directory, 'test.sqlite'),
      JWT_SECRET: 'integration-test-secret-with-more-than-32-characters',
      BOOTSTRAP_COMPANY_NAME: 'ASISTIA Integración de Prueba',
      BOOTSTRAP_ADMIN_NAME: 'Admin de prueba',
      BOOTSTRAP_ADMIN_EMAIL: 'admin.integration@example.test',
      BOOTSTRAP_ADMIN_PASSWORD: password,
      ASISTIA_LICENSE_ENFORCEMENT: 'false',
      CORS_ORIGIN: 'http://localhost:5173'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });

  try {
    await waitForHealth(baseUrl, child, () => output);
    const client = globalThis.ASISTIAApiClient.createClient({ baseUrl, timeoutMs: 5000 });

    const health = await client.health();
    assert.equal(health.status, 'ok');
    assert.equal(health.database, 'ok');

    const login = await client.login('ADMIN.INTEGRATION@EXAMPLE.TEST', password);
    assert.equal(login.user.role, 'admin');
    assert.equal(client.isAuthenticated, true);

    const initial = await client.employees({ limit: 20, offset: 0 });
    assert.equal(initial.employees.length, 0);

    const created = await client.createEmployee({
      employeeNumber: 'QA-001',
      fullName: 'Empleado de Prueba',
      branch: 'Sucursal de Prueba'
    });
    assert.equal(created.employee.employeeNumber, 'QA-001');
    assert.equal(created.employee.fullName, 'Empleado de Prueba');
    assert.match(created.employee.id, /^[0-9a-f-]{36}$/i);

    const listed = await client.employees({ limit: 20, offset: 0 });
    assert.equal(listed.pagination.total, 1);
    assert.equal(listed.employees[0].id, created.employee.id);
    assert.equal(listed.employees[0].active, 1);

    await assert.rejects(client.punch(created.employee.id, 'clock_out', 'admin'), /entrada pendiente de salida/i);
    const clockIn = await client.punch(created.employee.id, 'clock_in', 'admin');
    assert.equal(clockIn.event.event_type, 'clock_in');
    const clockOut = await client.punch(created.employee.id, 'clock_out', 'admin');
    assert.equal(clockOut.event.event_type, 'clock_out');

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const attendance = await client.attendance({ from, to, limit: 20, offset: 0 });
    assert.equal(attendance.events.length, 2);
    assert.deepEqual(attendance.events.map(event => event.eventType), ['clock_in', 'clock_out']);

    const csv = await client.attendanceCsv({ from, to });
    assert.match(csv, /numero_empleado,nombre,sucursal/);
    assert.match(csv, /QA-001/);

    client.logout();
    assert.equal(client.isAuthenticated, false);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
