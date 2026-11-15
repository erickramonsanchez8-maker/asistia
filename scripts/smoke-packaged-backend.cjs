'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const https = require('node:https');
const crypto = require('node:crypto');

const backendDir = path.resolve(process.argv[2] || 'release/win-unpacked/resources/backend');
const nodeExe = path.join(backendDir, 'runtime', 'node.exe');
const serverFile = path.join(backendDir, 'src', 'server.js');
const sqlitePackageDir = path.join(backendDir, 'node_modules', 'better-sqlite3');

function listNativeAddons(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...listNativeAddons(full, relative));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.node')) found.push(relative);
  }
  return found;
}

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

function requestHttps(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, rejectUnauthorized: false, timeout: 5000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body }));
    });
    request.on('timeout', () => request.destroy(new Error('Tiempo de espera agotado en HTTPS.')));
    request.on('error', reject);
  });
}

async function waitForHttps(url, child, readOutput, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'HTTPS todavía no responde.';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('El backend terminó antes de abrir HTTPS (código ' + child.exitCode + ').\n' + readOutput());
    try {
      const response = await requestHttps(url);
      if (response.statusCode === 200) return response;
      lastError = 'HTTP ' + response.statusCode + ': ' + response.body.slice(0, 500);
    } catch (error) {
      lastError = error.message;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('El servidor HTTPS móvil no respondió. Último error: ' + lastError + '\n' + readOutput());
}

async function waitForHealth(baseUrl, child, readOutput, getSpawnError, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'La API todavía no respondió.';
  while (Date.now() < deadline) {
    if (getSpawnError()) throw new Error('Windows no pudo iniciar el node.exe empaquetado: ' + getSpawnError().message + '\n' + readOutput());
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
  assertFile(sqlitePackageDir, 'Paquete better-sqlite3');
  const nativeAddons = listNativeAddons(sqlitePackageDir);
  assert.ok(nativeAddons.length > 0, 'El paquete better-sqlite3 llegó sin su módulo nativo .node. Archivos detectados: ' +
    (fs.existsSync(sqlitePackageDir) ? fs.readdirSync(sqlitePackageDir).join(', ') : 'directorio inexistente'));

  const version = spawnSync(nodeExe, ['--version'], { cwd: backendDir, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(version.status, 0, 'El node.exe empaquetado no se pudo ejecutar: ' + (version.stderr || version.error?.message || 'sin detalle'));
  const nativeCheck = spawnSync(nodeExe, ['-e', "const D=require('better-sqlite3'); const d=new D(':memory:'); d.prepare('select 1 as ok').get(); d.close(); process.stdout.write(process.version)"], {
    cwd: backendDir, encoding: 'utf8', timeout: 15000, windowsHide: true
  });
  assert.equal(nativeCheck.status, 0, 'El runtime empaquetado no puede cargar better-sqlite3 (' + nativeAddons.join(', ') + '): ' + (nativeCheck.stderr || nativeCheck.error?.message || 'sin detalle'));

  const pfxPath = process.env.ASISTIA_SMOKE_PFX_PATH;
  const pfxPassword = process.env.ASISTIA_SMOKE_PFX_PASSWORD;
  assertFile(pfxPath, 'Certificado PFX de prueba HTTPS');
  assert.ok(pfxPassword, 'Falta la contraseña del PFX de prueba HTTPS.');
  const port = await reservePort();
  const mobilePort = await reservePort();
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
    BACKUP_DIR: path.join(tempDir, 'backups'),
    MOBILE_HTTPS_PFX_PATH: pfxPath,
    MOBILE_HTTPS_PFX_PASSPHRASE: pfxPassword,
    MOBILE_HTTPS_PORT: String(mobilePort),
    MOBILE_HTTPS_HOST: '127.0.0.1'
  };
  fs.mkdirSync(path.dirname(env.DATABASE_PATH), { recursive: true });

  let output = '';
  let spawnError = null;
  const child = spawn(nodeExe, [serverFile], { cwd: backendDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { spawnError = error; });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });
  const readOutput = () => output || '(el backend no generó salida)';

  try {
    const baseUrl = 'http://127.0.0.1:' + port;
    const health = await waitForHealth(baseUrl, child, readOutput, () => spawnError);
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

    const httpsPwa = await waitForHttps('https://127.0.0.1:' + mobilePort + '/mobile/', child, readOutput);
    assert.equal(httpsPwa.statusCode, 200, 'La PWA no respondió por HTTPS móvil.');
    const httpsHealth = await requestHttps('https://127.0.0.1:' + mobilePort + '/api/health');
    assert.equal(httpsHealth.statusCode, 200, 'La API no respondió por HTTPS móvil.');
    assert.equal(JSON.parse(httpsHealth.body).database, 'ok');
    const httpsSettings = await requestHttps('https://127.0.0.1:' + mobilePort + '/api/desktop/mobile-settings?branch=Principal', headers);
    assert.equal(httpsSettings.statusCode, 200, 'La configuración móvil no respondió por HTTPS.');
    assert.equal(JSON.parse(httpsSettings.body).configured, true);

    process.stdout.write('ASISTIA PACKAGED BACKEND SMOKE TEST: OK\n');
    process.stdout.write('Runtime: ' + version.stdout.trim() + ' | SQLite nativo: OK | API PC: OK | ajustes PC: OK | PWA HTTP: OK | HTTPS móvil: OK | ajustes por HTTPS: OK\n');
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
