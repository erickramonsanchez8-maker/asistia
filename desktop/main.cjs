const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = 3000;
const API_URL = `http://127.0.0.1:${PORT}`;
let mainWindow = null;
let backendProcess = null;
let startupPromise = null;

const userData = app.getPath('userData');
const configPath = path.join(userData, 'config.json');
const bootstrapPath = path.join(userData, 'bootstrap.once.json');
const dataDir = path.join(userData, 'data');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0b1f3a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function backendPaths() {
  if (app.isPackaged) {
    return {
      cwd: path.join(process.resourcesPath, 'backend'),
      executable: path.join(process.resourcesPath, 'backend', 'runtime', 'node.exe')
    };
  }
  return { cwd: path.join(app.getAppPath(), 'backend'), executable: process.execPath };
}

async function waitForHealth(child, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error('El servicio local de ASISTIA se cerró al iniciar. Revisa la instalación o los registros.');
    try {
      const response = await fetch(API_URL + '/api/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        await new Promise(resolve => setTimeout(resolve, 250));
        if (child.exitCode !== null) throw new Error('El servicio local de ASISTIA se cerró durante el arranque.');
        return true;
      }
    } catch (error) {
      if (error.message && error.message.includes('se cerró')) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('ASISTIA no pudo iniciar su servicio local en 20 segundos.');
}

async function startBackend() {
  if (startupPromise) return startupPromise;
  startupPromise = (async () => {
    const config = readJson(configPath);
    if (!config || !config.jwtSecret || config.jwtSecret.length < 32) {
      throw new Error('Falta la configuración inicial de ASISTIA.');
    }
    fs.mkdirSync(dataDir, { recursive: true });
    const paths = backendPaths();
    if (!fs.existsSync(paths.cwd) || !fs.existsSync(paths.executable)) {
      throw new Error('No se encontró el motor local de ASISTIA. Reinstala la aplicación.');
    }
    const bootstrap = readJson(bootstrapPath);
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATABASE_PATH: path.join(dataDir, 'asistia.sqlite'),
      JWT_SECRET: config.jwtSecret,
      CORS_ORIGIN: 'file://,null',
      TRUST_PROXY_HOPS: '0',
      BOOTSTRAP_COMPANY_NAME: config.companyName || 'Empresa ASISTIA',
      BOOTSTRAP_ADMIN_NAME: 'Administrador'
    };
    if (bootstrap && bootstrap.email && bootstrap.password) {
      env.BOOTSTRAP_ADMIN_EMAIL = bootstrap.email;
      env.BOOTSTRAP_ADMIN_PASSWORD = bootstrap.password;
    } else {
      delete env.BOOTSTRAP_ADMIN_EMAIL;
      delete env.BOOTSTRAP_ADMIN_PASSWORD;
    }
    if (!app.isPackaged) env.ELECTRON_RUN_AS_NODE = '1';
    backendProcess = spawn(paths.executable, ['src/server.js'], {
      cwd: paths.cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    backendProcess.stdout.on('data', chunk => console.log('[ASISTIA API]', String(chunk).trim()));
    backendProcess.stderr.on('data', chunk => console.error('[ASISTIA API]', String(chunk).trim()));
    backendProcess.on('error', error => console.error('[ASISTIA API] No se pudo iniciar:', error));
    await waitForHealth(backendProcess);
    if (bootstrap) {
      try { fs.unlinkSync(bootstrapPath); }
      catch (error) { if (error.code !== 'ENOENT') console.error('No se pudo retirar el archivo de configuración temporal.'); }
    }
    return true;
  })();
  try { return await startupPromise; }
  catch (error) {
    startupPromise = null;
    if (backendProcess && backendProcess.exitCode === null) backendProcess.kill();
    backendProcess = null;
    throw error;
  }
}

async function showSetup() {
  const win = createWindow();
  await win.loadFile(path.join(app.getAppPath(), 'desktop', 'setup.html'));
}

async function openProduct() {
  if (!mainWindow) createWindow();
  await mainWindow.loadFile(path.join(app.getAppPath(), 'ASISTIA_Control_de_Asistencia.html'));
}

ipcMain.handle('asistia:setup', async (_event, input) => {
  if (app.isPackaged && fs.existsSync(configPath)) {
    throw new Error('ASISTIA ya está configurado en este equipo.');
  }
  const companyName = String(input && input.companyName || '').trim().slice(0, 120);
  const email = String(input && input.email || '').trim().toLowerCase();
  const password = String(input && input.password || '');
  if (companyName.length < 2) throw new Error('Escribe el nombre del negocio.');
  if (!isValidEmail(email)) throw new Error('Escribe un correo válido para el administrador.');
  if (password.length < 14) throw new Error('La contraseña debe tener al menos 14 caracteres.');
  if (password.length > 200) throw new Error('La contraseña es demasiado larga.');
  if (readJson(configPath)) throw new Error('ASISTIA ya está configurado en este equipo.');

  writeJsonAtomic(configPath, {
    companyName,
    adminEmail: email,
    jwtSecret: crypto.randomBytes(48).toString('base64url'),
    setupAt: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Mexico_City'
  });
  // Credenciales temporales: se pasan al proceso del backend y el archivo se borra
  // solo después de confirmar que la API está disponible.
  writeJsonAtomic(bootstrapPath, { email, password });
  try {
    await startBackend();
    await openProduct();
    return { ok: true };
  } catch (error) {
    // Si el arranque no alcanzó a confirmar la API, conserva la credencial temporal
    // para reintentar y retira solo la configuración incompleta.
    if (fs.existsSync(bootstrapPath)) {
      try { fs.unlinkSync(configPath); } catch {}
    }
    dialog.showErrorBox('No se pudo iniciar ASISTIA', error.message || 'Error desconocido.');
    throw new Error('No se pudo iniciar ASISTIA. Revisa la configuración y vuelve a abrir la aplicación.');
  }
});

app.on('before-quit', () => {
  if (backendProcess && backendProcess.exitCode === null) {
    try { backendProcess.kill(); } catch {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      const config = readJson(configPath);
      if (!config) {
        await showSetup();
        return;
      }
      await startBackend();
      await openProduct();
    } catch (error) {
      dialog.showErrorBox('ASISTIA no pudo iniciar', error.message || 'Error desconocido.');
      app.quit();
    }
  });
}
