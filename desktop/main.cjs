'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API_PORT = 43177;
const API_URL = 'http://127.0.0.1:' + API_PORT;
const APP_ID = 'mx.asistia.desktop';
const UPDATE_FORMAT = 'asistia-update-v1';
const UPDATE_FILES = new Set(['ASISTIA_Control_de_Asistencia.html', 'desktop/desktop-enhancements.js']);
let mainWindow = null;
let backendProcess = null;
let stopping = false;

app.setAppUserModelId('mx.asistia.desktop');
app.setPath('userData', path.join(app.getPath('appData'), 'ASISTIA'));

function runtimePaths() {
  const backendDir = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..', 'backend');
  const serverFile = path.join(backendDir, 'src', 'server.js');
  const bundledNode = path.join(backendDir, 'runtime', 'node.exe');
  return {
    backendDir,
    serverFile,
    nodeCommand: app.isPackaged ? bundledNode : (process.env.ASISTIA_NODE_PATH || 'node')
  };
}

function loadOrCreateSecret() {
  const file = path.join(app.getPath('userData'), 'service-security.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.jwtSecret === 'string' && saved.jwtSecret.length >= 64) return saved.jwtSecret;
  } catch {}
  const jwtSecret = crypto.randomBytes(48).toString('hex');
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ jwtSecret, createdAt: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(temp, file);
  return jwtSecret;
}

const TRIAL_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

function getTrialStatus() {
  const dir = app.getPath('userData');
  const file = path.join(dir, 'trial-period.json');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  let state;

  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || !Number.isFinite(state.startedAt) || !Number.isFinite(state.expiresAt) || !Number.isFinite(state.lastSeenAt)) {
      throw new Error('Estado de prueba inválido');
    }
  } catch (error) {
    if (fs.existsSync(file)) {
      state = { startedAt: now, expiresAt: now, lastSeenAt: now, expired: true, integrityError: true };
    } else {
      state = { startedAt: now, expiresAt: now + TRIAL_DAYS * DAY_MS, lastSeenAt: now, expired: false };
    }
  }

  if (now < state.lastSeenAt - 5 * 60 * 1000) {
    state.expired = true;
    state.clockRollback = true;
  }
  if (now >= state.expiresAt) state.expired = true;
  state.lastSeenAt = Math.max(now, state.lastSeenAt);
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  fs.renameSync(temp, file);

  const daysRemaining = state.expired ? 0 : Math.max(0, Math.ceil((state.expiresAt - now) / DAY_MS));
  return {
    expired: Boolean(state.expired),
    daysRemaining,
    startedAt: new Date(state.startedAt).toISOString(),
    expiresAt: new Date(state.expiresAt).toISOString(),
    clockRollback: Boolean(state.clockRollback),
    integrityError: Boolean(state.integrityError)
  };
}

async function waitForLocalApi(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(API_URL + '/api/health', { signal: AbortSignal.timeout(1200) });
      if (response.ok) {
        const data = await response.json();
        if (data.status === 'ok' && data.database === 'ok') return true;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function startLocalBackend() {
  const { backendDir, serverFile, nodeCommand } = runtimePaths();
  if (!fs.existsSync(serverFile)) return false;
  if (app.isPackaged && !fs.existsSync(nodeCommand)) return false;

  const userData = app.getPath('userData');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(API_PORT),
    JWT_SECRET: loadOrCreateSecret(),
    DATABASE_PATH: path.join(userData, 'database', 'asistia.sqlite'),
    BACKUP_DIR: path.join(userData, 'backups')
  };
  fs.mkdirSync(path.dirname(env.DATABASE_PATH), { recursive: true });
  fs.mkdirSync(env.BACKUP_DIR, { recursive: true });

  backendProcess = spawn(nodeCommand, [serverFile], {
    cwd: backendDir,
    env,
    windowsHide: true,
    stdio: 'ignore'
  });
  backendProcess.on('error', () => {});
  backendProcess.on('exit', () => { backendProcess = null; });
  return await waitForLocalApi();
}

ipcMain.handle('asistia:trial-status', () => getTrialStatus());

ipcMain.handle('asistia:health', async () => {
  try {
    const response = await fetch(API_URL + '/api/health', { signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error('Servicio local no disponible');
    return await response.json();
  } catch {
    return { status: 'offline', database: 'unknown', service: 'ASISTIA local', version: activeUpdateVersion(path.join(app.getPath('userData'), 'updates')) };
  }
});

ipcMain.handle('asistia:open-data-folder', async () => {
  const location = app.getPath('userData');
  await shell.openPath(location);
  return location;
});
ipcMain.handle('asistia:version', () => activeUpdateVersion(path.join(app.getPath('userData'), 'updates')));
ipcMain.handle('asistia:legacy-storage', () => {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'legacy-browser-storage.json'), 'utf8'));
    return typeof saved.value === 'string' ? saved.value : null;
  } catch { return null; }
});

function compareVersions(a, b) {
  const aa = String(a).split('.').map(n => Number.parseInt(n, 10) || 0);
  const bb = String(b).split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const diff = (aa[i] || 0) - (bb[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function activeUpdateVersion(updatesDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(updatesDir, 'current', '.asistia-version.json'), 'utf8'));
    if (typeof meta.version === 'string') return meta.version;
  } catch {}
  return app.getVersion();
}

ipcMain.handle('asistia:install-update', async (_event, rawPackage, legacyStorageData) => {
  const updatesDir = path.join(app.getPath('userData'), 'updates');
  let stagingDir = null;
  try {
    if (typeof rawPackage !== 'string' || rawPackage.length > 12 * 1024 * 1024) {
      throw new Error('El paquete está vacío o supera el límite permitido.');
    }
    const pkg = JSON.parse(rawPackage);
    if (!pkg || pkg.format !== UPDATE_FORMAT || pkg.appId !== APP_ID || typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version) || !Array.isArray(pkg.files)) {
      throw new Error('El archivo no corresponde a un paquete oficial de actualización de ASISTIA.');
    }
    if (compareVersions(pkg.version, activeUpdateVersion(updatesDir)) <= 0) {
      throw new Error('La versión ' + pkg.version + ' no es más reciente que la instalada.');
    }
    if (pkg.files.length !== UPDATE_FILES.size) {
      throw new Error('El paquete está incompleto. No se aplicó ningún cambio.');
    }

    const decoded = [];
    const seen = new Set();
    for (const item of pkg.files) {
      if (!item || typeof item.path !== 'string' || !UPDATE_FILES.has(item.path) || seen.has(item.path)) {
        throw new Error('El paquete contiene una ruta no permitida o duplicada.');
      }
      if (typeof item.contentBase64 !== 'string' || typeof item.sha256 !== 'string') {
        throw new Error('El paquete contiene un archivo incompleto.');
      }
      const bytes = Buffer.from(item.contentBase64, 'base64');
      if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('Un archivo del paquete supera el tamaño permitido.');
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest !== item.sha256.toLowerCase()) throw new Error('La verificación de integridad falló en ' + item.path + '.');
      decoded.push({ path: item.path, bytes });
      seen.add(item.path);
    }
    if (!seen.has('ASISTIA_Control_de_Asistencia.html') || !seen.has('desktop/desktop-enhancements.js')) {
      throw new Error('Faltan componentes obligatorios de la actualización.');
    }

    if (typeof legacyStorageData === 'string' && legacyStorageData.length > 8 * 1024 * 1024) {
      throw new Error('Los datos locales superan el límite seguro de migración. Exporte un respaldo antes de continuar.');
    }
    if (typeof legacyStorageData === 'string' && legacyStorageData.length > 0) {
      const legacyFile = path.join(app.getPath('userData'), 'legacy-browser-storage.json');
      const legacyTemp = legacyFile + '.tmp';
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyTemp, JSON.stringify({ key: 'control_asistencia_pro_v1', value: legacyStorageData, savedAt: new Date().toISOString() }), { flag: 'w' });
      fs.renameSync(legacyTemp, legacyFile);
    }

    fs.mkdirSync(updatesDir, { recursive: true });
    stagingDir = path.join(updatesDir, '.staging-' + crypto.randomBytes(8).toString('hex'));
    fs.mkdirSync(stagingDir, { recursive: true });
    for (const item of decoded) {
      const destination = path.join(stagingDir, item.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, item.bytes, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(stagingDir, '.asistia-version.json'), JSON.stringify({
      version: pkg.version,
      installedAt: new Date().toISOString(),
      format: UPDATE_FORMAT
    }, null, 2), { flag: 'wx' });

    const currentDir = path.join(updatesDir, 'current');
    const backupDir = path.join(updatesDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    let backupPath = null;
    if (fs.existsSync(currentDir)) {
      const oldVersion = activeUpdateVersion(updatesDir).replace(/[^0-9.]/g, '_');
      backupPath = path.join(backupDir, oldVersion + '-' + Date.now());
      fs.renameSync(currentDir, backupPath);
    }
    try {
      fs.renameSync(stagingDir, currentDir);
      stagingDir = null;
    } catch (installError) {
      if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(currentDir)) fs.renameSync(backupPath, currentDir);
      throw installError;
    }
    setImmediate(() => {
      app.relaunch();
      app.exit(0);
    });
    return { ok: true, version: pkg.version };
  } catch (error) {
    if (stagingDir && fs.existsSync(stagingDir)) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    }
    return { ok: false, error: error.message || 'No se pudo instalar la actualización.' };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: 'ASISTIA',
    backgroundColor: '#071a30',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const bundledHtml = path.join(__dirname, '..', 'ASISTIA_Control_de_Asistencia.html');
  const updatedHtml = path.join(app.getPath('userData'), 'updates', 'current', 'ASISTIA_Control_de_Asistencia.html');
  mainWindow.loadFile(fs.existsSync(updatedHtml) ? updatedHtml : bundledHtml);
  mainWindow.on('closed', () => { mainWindow = null; });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    getTrialStatus();
    await startLocalBackend();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  try { getTrialStatus(); } catch {}
  stopping = true;
  if (backendProcess && !backendProcess.killed) {
    try { backendProcess.kill(); } catch {}
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
