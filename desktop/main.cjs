'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const API_PORT = 43177;
const API_URL = 'http://127.0.0.1:' + API_PORT;
const APP_ID = 'mx.asistia.desktop';
const UPDATE_FORMAT = 'asistia-update-v1';
const UPDATE_FILES = new Set(['ASISTIA_Control_de_Asistencia.html', 'desktop/desktop-enhancements.js']);
let mainWindow = null;
let backendProcess = null;
let stopping = false;
let mobileConnection = null;

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
    nodeCommand: app.isPackaged ? bundledNode : (process.env.ASISTIA_NODE_PATH || 'node'),
    mobileCertScript: path.join(backendDir, 'src', 'mobile', 'ensure-certificates.ps1')
  };
}

let localSecurity = null;

function loadOrCreateSecret() {
  const file = path.join(app.getPath('userData'), 'service-security.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  const state = {
    ...saved,
    jwtSecret: typeof saved.jwtSecret === 'string' && saved.jwtSecret.length >= 64
      ? saved.jwtSecret : crypto.randomBytes(48).toString('hex'),
    desktopBridgeToken: typeof saved.desktopBridgeToken === 'string' && saved.desktopBridgeToken.length >= 64
      ? saved.desktopBridgeToken : crypto.randomBytes(48).toString('hex'),
    adminEmail: typeof saved.adminEmail === 'string' && saved.adminEmail.includes('@')
      ? saved.adminEmail : 'admin-' + crypto.randomBytes(10).toString('hex') + '@local.asistia',
    adminPassword: typeof saved.adminPassword === 'string' && saved.adminPassword.length >= 24
      ? saved.adminPassword : crypto.randomBytes(32).toString('base64url'),
    mobilePfxPassword: typeof saved.mobilePfxPassword === 'string' && saved.mobilePfxPassword.length >= 24
      ? saved.mobilePfxPassword : crypto.randomBytes(32).toString('base64url'),
    createdAt: saved.createdAt || new Date().toISOString()
  };
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  localSecurity = state;
  return state;
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

function getPrivateNetworkCandidates() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const item of entries || []) {
      const family = item.family;
      if (item.internal || (family !== 'IPv4' && family !== 4) || !isPrivateIpv4(item.address)) continue;
      const cidr = subnetCidr(item.address,item.netmask);
      if (!cidr || candidates.some(candidate => candidate.cidr === cidr)) continue;
      candidates.push({name,address:item.address,netmask:item.netmask,cidr});
    }
  }
  return candidates;
}

function ensureMobileCertificates(backendDir, userData, security, scriptPath) {
  if (process.platform !== 'win32' || !fs.existsSync(scriptPath)) return null;
  const networks = getPrivateNetworkCandidates();
  if (!networks.length) return null;
  const certificateDir = path.join(userData, 'certificates');
  fs.mkdirSync(certificateDir, { recursive: true });
  const resultPath = path.join(certificateDir, 'mobile-certificate-status.json');
  const ips = networks.map(item => item.address).join(',');
  const run = spawnSync('powershell.exe', [
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',scriptPath,
    '-OutputDirectory',certificateDir,'-ServerIps',ips
  ], {
    encoding:'utf8',
    timeout:45000,
    windowsHide:true,
    env:{...process.env,ASISTIA_CERT_PASSWORD:security.mobilePfxPassword}
  });
  if (run.error || run.status !== 0 || !fs.existsSync(resultPath)) {
    return {ready:false,error:run.error?.message || run.stderr || 'No se pudo preparar HTTPS local.',networks};
  }
  try {
    const status = JSON.parse(fs.readFileSync(resultPath,'utf8').replace(/^\uFEFF/,''));
    if (!status.pfxPath || !fs.existsSync(status.pfxPath) || !status.rootCertificatePath || !fs.existsSync(status.rootCertificatePath)) {
      return {ready:false,error:'No se encontraron los archivos del certificado local.',networks};
    }
    const preferred = networks.find(item => /wi.?fi|wireless|wlan/i.test(item.name)) || networks[0];
    return {
      ready:true,
      pfxPath:status.pfxPath,
      rootCertificatePath:status.rootCertificatePath,
      serverIps:status.serverIps || networks.map(item=>item.address),
      preferredIp:preferred.address,
      networkCandidates:networks,
      mobileUrl:'https://' + preferred.address + ':43178/mobile/',
      firewallConfigured:Boolean(status.firewallConfigured),
      firewallMessage:status.firewallMessage || ''
    };
  } catch(error) {
    return {ready:false,error:error.message || 'No se pudo leer el estado del certificado local.',networks};
  }
}

async function waitForLocalApi(timeoutMs = 30000) {
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

function writeBackendDiagnostic(message) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'backend-startup.log'), '[' + new Date().toISOString() + '] ' + String(message) + '\\n', 'utf8');
  } catch {}
}

async function startLocalBackend() {
  const { backendDir, serverFile, nodeCommand, mobileCertScript } = runtimePaths();
  writeBackendDiagnostic('Inicio de backend. packaged=' + app.isPackaged + '; backendDir=' + backendDir + '; serverFile=' + serverFile + '; node=' + nodeCommand);
  if (!fs.existsSync(serverFile)) {
    writeBackendDiagnostic('ERROR: no existe server.js.');
    return false;
  }
  if (app.isPackaged && !fs.existsSync(nodeCommand)) {
    writeBackendDiagnostic('ERROR: no existe el Node.js integrado.');
    return false;
  }

  const userData = app.getPath('userData');
  const security = loadOrCreateSecret();
  mobileConnection = ensureMobileCertificates(backendDir,userData,security,mobileCertScript);
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(API_PORT),
    JWT_SECRET: security.jwtSecret,
    DESKTOP_BRIDGE_TOKEN: security.desktopBridgeToken,
    BOOTSTRAP_ADMIN_EMAIL: security.adminEmail,
    BOOTSTRAP_ADMIN_PASSWORD: security.adminPassword,
    BOOTSTRAP_ADMIN_NAME: 'Administrador ASISTIA',
    BOOTSTRAP_COMPANY_NAME: 'ASISTIA',
    DATABASE_PATH: path.join(userData, 'database', 'asistia.sqlite'),
    BACKUP_DIR: path.join(userData, 'backups')
  };
  if (mobileConnection?.ready) {
    env.MOBILE_HTTPS_PFX_PATH = mobileConnection.pfxPath;
    env.MOBILE_HTTPS_PFX_PASSPHRASE = security.mobilePfxPassword;
    env.MOBILE_HTTPS_PORT = '43178';
    env.MOBILE_HTTPS_HOST = '0.0.0.0';
  }
  fs.mkdirSync(path.dirname(env.DATABASE_PATH), { recursive: true });
  fs.mkdirSync(env.BACKUP_DIR, { recursive: true });

  let logFd;
  try {
    const logDir = path.join(userData, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFd = fs.openSync(path.join(logDir, 'backend-startup.log'), 'a');
  } catch (error) {
    writeBackendDiagnostic('No se pudo abrir el registro de inicio: ' + (error.stack || error.message));
  }

  try {
    backendProcess = spawn(nodeCommand, [serverFile], {
      cwd: backendDir,
      env,
      windowsHide: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore']
    });
    backendProcess.on('spawn', () => writeBackendDiagnostic('Proceso Node iniciado. PID=' + backendProcess.pid));
    backendProcess.on('error', error => {
      writeBackendDiagnostic('ERROR al ejecutar Node: ' + (error.stack || error.message));
      backendProcess = null;
    });
    backendProcess.on('exit', (code, signal) => {
      writeBackendDiagnostic('Proceso Node terminó. code=' + code + '; signal=' + signal);
      backendProcess = null;
    });
  } catch (error) {
    writeBackendDiagnostic('ERROR al crear proceso Node: ' + (error.stack || error.message));
    backendProcess = null;
  } finally {
    if (Number.isInteger(logFd)) {
      try { fs.closeSync(logFd); } catch {}
    }
  }

  const ready = await waitForLocalApi();
  writeBackendDiagnostic('Resultado de arranque: ' + (ready ? 'API disponible' : 'API no respondió en 30 segundos'));
  return ready;
}

ipcMain.handle('asistia:trial-status', () => getTrialStatus());
ipcMain.handle('asistia:open-activation-whatsapp', async () => {
  const message = "Hola, quiero activar ASISTIA.\nNombre del negocio:\nNúmero de sucursales:\nPlan: Mensual / Anual.";
  const activationUrl = 'https://wa.me/523123603551?text=' + encodeURIComponent(message);
  await shell.openExternal(activationUrl);
  return { ok: true };
});

ipcMain.handle('asistia:health', async () => {
  try {
    const response = await fetch(API_URL + '/api/health', { signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error('Servicio local no disponible');
    return await response.json();
  } catch {
    return { status: 'offline', database: 'unknown', service: 'ASISTIA local', version: activeUpdateVersion(path.join(app.getPath('userData'), 'updates')) };
  }
});

async function desktopBridgeRequest(route, options = {}) {
  if (!localSecurity) loadOrCreateSecret();
  const response = await fetch(API_URL + route, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-ASISTIA-Desktop-Bridge': localSecurity.desktopBridgeToken
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(8000),
    cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación local.');
  return data;
}

ipcMain.handle('asistia:provision-mobile-access', async (_event, employee) => {
  if (!employee || typeof employee !== 'object') throw new Error('Ficha de empleado inválida.');
  return desktopBridgeRequest('/api/desktop/mobile-access', { method: 'POST', body: employee });
});
ipcMain.handle('asistia:mobile-recent', async () => {
  return desktopBridgeRequest('/api/desktop/mobile-recent?limit=20');
});
ipcMain.handle('asistia:sync-employees', async (_event, employees) => {
  if (!Array.isArray(employees)) throw new Error('La lista de empleados no es válida.');
  return desktopBridgeRequest('/api/desktop/sync-employees', { method: 'POST', body: employees });
});
ipcMain.handle('asistia:record-attendance-event', async (_event, attendance) => {
  if (!attendance || typeof attendance !== 'object') throw new Error('Registro de asistencia inválido.');
  return desktopBridgeRequest('/api/desktop/record-attendance', { method: 'POST', body: attendance });
});
ipcMain.handle('asistia:sync-sessions', async (_event, sessions) => {
  if (!Array.isArray(sessions)) throw new Error('La lista de jornadas no es válida.');
  return desktopBridgeRequest('/api/desktop/sync-sessions', { method: 'POST', body: sessions });
});
ipcMain.handle('asistia:mobile-events', async () => {
  return desktopBridgeRequest('/api/desktop/mobile-events?limit=10000');
});
ipcMain.handle('asistia:get-mobile-settings', async (_event, branch) => {
  return desktopBridgeRequest('/api/desktop/mobile-settings?branch=' + encodeURIComponent(String(branch || 'Principal')));
});
ipcMain.handle('asistia:save-mobile-settings', async (_event, settings) => {
  if (!settings || typeof settings !== 'object') throw new Error('La configuración móvil no es válida.');
  return desktopBridgeRequest('/api/desktop/mobile-settings', { method: 'PUT', body: settings });
});
function isPrivateIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}
function subnetCidr(address, mask) {
  const ip = String(address).split('.').map(Number);
  const nm = String(mask).split('.').map(Number);
  if (ip.length !== 4 || nm.length !== 4 || ip.some(n => !Number.isInteger(n) || n<0 || n>255) || nm.some(n => !Number.isInteger(n) || n<0 || n>255)) return null;
  const maskBits = nm.map(n => n.toString(2).padStart(8,'0')).join('');
  if (!/^1*0*$/.test(maskBits)) return null;
  const prefix = (maskBits.match(/1/g) || []).length;
  const network = ip.map((n,i) => n & nm[i]).join('.');
  return network + '/' + prefix;
}
ipcMain.handle('asistia:get-mobile-network-info', () => ({candidates:getPrivateNetworkCandidates()}));
ipcMain.handle('asistia:get-mobile-connection-info', () => {
  const info = mobileConnection || {ready:false,error:'No se pudo preparar el certificado HTTPS local.',networks:getPrivateNetworkCandidates()};
  return {
    ready:Boolean(info.ready),
    mobileUrl:info.mobileUrl || '',
    preferredIp:info.preferredIp || '',
    networkCandidates:info.networkCandidates || info.networks || [],
    rootCertificatePath:info.rootCertificatePath || '',
    firewallConfigured:Boolean(info.firewallConfigured),
    firewallMessage:info.firewallMessage || '',
    error:info.error || ''
  };
});
ipcMain.handle('asistia:open-mobile-certificate-folder', async () => {
  const folder = path.join(app.getPath('userData'),'certificates');
  await shell.openPath(folder);
  return folder;
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
