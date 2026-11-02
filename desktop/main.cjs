'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API_PORT = 43177;
const API_URL = 'http://127.0.0.1:' + API_PORT;
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

ipcMain.handle('asistia:health', async () => {
  try {
    const response = await fetch(API_URL + '/api/health', { signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error('Servicio local no disponible');
    return await response.json();
  } catch {
    return { status: 'offline', database: 'unknown', service: 'ASISTIA local', version: '0.5.0' };
  }
});

ipcMain.handle('asistia:open-data-folder', async () => {
  const location = app.getPath('userData');
  await shell.openPath(location);
  return location;
});
ipcMain.handle('asistia:version', () => app.getVersion());

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
  mainWindow.loadFile(path.join(__dirname, '..', 'ASISTIA_Control_de_Asistencia.html'));
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
    await startLocalBackend();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  stopping = true;
  if (backendProcess && !backendProcess.killed) {
    try { backendProcess.kill(); } catch {}
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
