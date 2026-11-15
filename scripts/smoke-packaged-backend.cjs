'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');

const backendDir = path.resolve(process.argv[2] || 'release/win-unpacked/resources/backend');
const nodeExe = path.join(backendDir, 'runtime', 'node.exe');
const serverFile = path.join(backendDir, 'src', 'server.js');
const sqliteAddon = path.join(backendDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

function assertFile(file, label) {
  assert.ok(fs.existsSync(file), label + ' no encontrado: ' + file);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, readOutput, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'La API todavía no respondió.';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('El backend terminó antes de estar listo (código ' + child.exitCode + ').\n' + readOutput());
    }
    try {
      const response = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1200) });
      const data = await response.json();
      if (response.ok && data.status === 'ok' && data.database === 'ok') return data;
      lastError = 'Respuesta de salud no válida: HTTP ' + response.status + ' ' + JSON.stringify(data);
    } catch (error) {
      lastError = error.message;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('El backend empaquetado no abrió su API dentro del tiempo límite. Último error: ' + lastError + '\n' + readOutput());
}

async function main() {
  assertFile(nodeExe, 'Runtime Node.js');
  assertFile(serverFile, 'Servidor local');
  assertFile(sqliteAddon, 'Módulo nativo better-sqlite3');

  const version = spawnSync(nodeExe, ['--version'], { cwd: backendDir, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(version.status, 0, 'El node.exe empaquetado no se pudo ejecutar: ' + (version.stderr || version.error?.message || 'sin detalle'));
  const nativeCheck = spawnSync(nodeExe, ['-e', "const D=require('better-sqlite3'); const d=new D(':memory:'); d.prepare('select 1 as ok').get(); d.close(); process.stdout.write(process.version)"], {
    cwd: backendDir, encoding: 'utf8', timeout: 15000, windowsHide: true
  });
  assert.equal(nativeCheck.status, 0, 'El runtime empaquetado no puede cargar better-sqlite3: ' + (nativeCheck.stderr || nativeCheck.error?.message || 'sin detalle'));

  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asistia-packaged-smoke-'));
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    DESKTOP_BRIDGE_TOKEN: crypto.randomBytes(48).toString('hex'),
    BOOTSTRAP_ADMIN_EMAIL: 'smoke-admin@local.asistia',
    BOOTSTRAP_ADMIN_PASSWORD: crypto.randomBytes(32).toString('base64url'),
    BOOTSTRAP_ADMIN_NAME: 'Prueba automatizada',
    BOOTSTRAP_COMPANY_NAME: 'ASISTIA Smoke Test',
    DATABASE_PATH: path.join(tempDir, 'database', 'asistia.sqlite'),
    BACKUP_DIR: path.join(tempDir, 'backups')
  };
  fs.mkdirSync(path.dirname(env.DATABASE_PATH), { recursive: true });

  let output = '';
  const child = spawn(nodeExe, [serverFile], { cwd: backendDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });
  const readOutput = () => output || '(el backend no generó salida)';

  try {
    const baseUrl = 'http://127.0.0.1:' + port;
    const health = await waitForHealth(baseUrl, child, readOutput);
    assert.equal(health.database, 'ok');

    const headers = {
      'Content-Type': 'application/json',
      'X-ASISTIA-Desktop-Bridge': env.DESKTOP_BRIDGE_TOKEN
    };
    const initial = await fetch(baseUrl + '/api/desktop/mobile-settings?branch=Principal', { headers });
    assert.equal(initial.status, 200, 'El puente interno no pudo leer la configuración móvil.');
    const initialData = await initial.json();
    assert.equal(initialData.configured, false);

    const settings = {
      branch: 'Principal',
      latitude: 19.705,
      longitude: -103.465,
      radiusM: 50,
      maxAccuracyM: 50,
      allowedCidrs: ['192.168.50.0/24']
    };
    const saved = await fetch(baseUrl + '/api/desktop/mobile-settings', {
      method: 'PUT', headers, body: JSON.stringify(settings)
    });
    const savedData = await saved.json();
    assert.equal(saved.status, 200, 'El puente interno no pudo guardar la configuración: ' + JSON.stringify(savedData));
    assert.equal(savedData.ok, true);

    const reread = await fetch(baseUrl + '/api/desktop/mobile-settings?branch=Principal', { headers });
    const rereadData = await reread.json();
    assert.equal(reread.status, 200);
    assert.equal(rereadData.configured, true);
    assert.equal(rereadData.settings.allowedCidrs[0], '192.168.50.0/24');

    const pwa = await fetch(baseUrl + '/mobile/');
    assert.equal(pwa.status, 200, 'La PWA no se está sirviendo desde el backend empaquetado.');

    process.stdout.write('ASISTIA PACKAGED BACKEND SMOKE TEST: OK\n');
    process.stdout.write('Runtime: ' + version.stdout.trim() + ' | better-sqlite3: OK | API: OK | puente PC: OK | ajustes móviles: OK | PWA: OK\n');
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write('ASISTIA PACKAGED BACKEND SMOKE TEST: FAIL\n' + (error.stack || error.message) + '\n');
  process.exitCode = 1;
});
