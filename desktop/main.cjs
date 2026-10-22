const { app, BrowserWindow, ipcMain, dialog, globalShortcut } = require('electron');
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
const logPath = path.join(userData, 'logs', 'asistia-desktop.log');
function logDiagnostic(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${String(message).replace(/[\r\n]+/g, ' ').slice(0, 2000)}\n`;
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.appendFileSync(logPath, line, 'utf8'); } catch {}
  if (level === 'ERROR') console.error(line.trim()); else console.log(line.trim());
}
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
    icon: app.isPackaged ? path.join(process.resourcesPath, 'asistia-logo.png') : path.join(app.getAppPath(), 'desktop', 'assets', 'asistia-logo.png'),
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
    if (child.spawnError) throw new Error('Windows no pudo ejecutar el motor local: ' + child.spawnError.message);
    if (child.exitCode !== null) throw new Error('El servicio local de ASISTIA se cerró al iniciar (código ' + child.exitCode + '). Consulta el registro: ' + logPath);
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
  throw new Error('ASISTIA no pudo iniciar su servicio local en 20 segundos. Consulta el registro: ' + logPath);
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
      ASISTIA_LICENSE_ENFORCEMENT: 'true',
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
    backendProcess.stdout.on('data', chunk => logDiagnostic('INFO', '[ASISTIA API] ' + String(chunk).trim()));
    backendProcess.stderr.on('data', chunk => logDiagnostic('ERROR', '[ASISTIA API] ' + String(chunk).trim()));
    backendProcess.on('error', error => { backendProcess.spawnError = error; logDiagnostic('ERROR', '[ASISTIA API] No se pudo iniciar: ' + (error.stack || error.message)); });
    backendProcess.on('exit', (code, signal) => logDiagnostic(code === 0 ? 'INFO' : 'ERROR', `[ASISTIA API] Proceso terminado. código=${code}, señal=${signal || 'ninguna'}`));
    logDiagnostic('INFO', `Inicio del backend. empaquetado=${app.isPackaged}; cwd=${paths.cwd}; ejecutable=${paths.executable}; existeCwd=${fs.existsSync(paths.cwd)}; existeNode=${fs.existsSync(paths.executable)}; puerto=${PORT}`);
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

function recoveryCodeHash(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
async function showRecoveryCode(code, migrated = false) {
  await dialog.showMessageBox({type:'warning',title:'Clave de recuperación de ASISTIA',
    message:migrated?'Se habilitó la recuperación de administrador en esta instalación.':'Configuración completada. Guarda esta clave de recuperación.',
    detail:'CLAVE DE RECUPERACIÓN:\n\n'+code+'\n\nGuárdala fuera de esta computadora. No podremos mostrarla de nuevo. Se necesita junto con el correo del administrador para restablecer la contraseña sin borrar registros.',
    buttons:['Ya la guardé'],defaultId:0,noLink:true});
  const config=readJson(configPath);
  if(config && config.recoveryCodePending) {
    delete config.recoveryCodePending;
    writeJsonAtomic(configPath,config);
  }
}
async function showRecovery() {
  if (!mainWindow) createWindow();
  await mainWindow.loadFile(path.join(app.getAppPath(), 'desktop', 'recovery.html'));
}
async function showSetup() {
  const win = createWindow();
  await win.loadFile(path.join(app.getAppPath(), 'desktop', 'setup.html'));
}

async function openProduct() {
  if (!mainWindow) createWindow();
  await mainWindow.loadFile(path.join(app.getAppPath(), 'ASISTIA_Control_de_Asistencia.html'));
}

ipcMain.handle('asistia:recovery-back', async () => { await openProduct(); return {ok:true}; });
ipcMain.handle('asistia:recovery-reset', async (_event, input) => {
  const config=readJson(configPath);
  if (!config || !config.recoveryCodeHash) throw new Error('No hay una clave de recuperación configurada.');
  const code=String(input && input.code || '').trim();
  const actual=Buffer.from(recoveryCodeHash(code),'hex'), expected=Buffer.from(String(config.recoveryCodeHash),'hex');
  if(actual.length!==expected.length || !crypto.timingSafeEqual(actual,expected)) throw new Error('La clave de recuperación no es correcta.');
  const email=String(input && input.email || '').trim().toLowerCase();
  if(!isValidEmail(email) || email!==String(config.adminEmail || '').toLowerCase()) throw new Error('El correo no coincide con el administrador de este equipo.');
  const password=String(input && input.password || '');
  if(password.length<14 || password.length>200) throw new Error('La nueva contraseña debe tener entre 14 y 200 caracteres.');
  const paths=backendPaths();
  const child=spawn(paths.executable,['src/recover-admin.js'],{cwd:paths.cwd,env:{...process.env,...(!app.isPackaged?{ELECTRON_RUN_AS_NODE:'1'}:{}),DATABASE_PATH:path.join(dataDir,'asistia.sqlite')},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',x=>stdout+=x.toString()); child.stderr.on('data',x=>stderr+=x.toString());
  const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);child.stdin.end(JSON.stringify({email,password}));});
  if(exitCode!==0) throw new Error((stderr||stdout||'No se pudo restablecer la contraseña.').trim());
  logDiagnostic('INFO','Contraseña de administrador restablecida mediante recuperación local.');
  return {ok:true,message:(stdout||'Contraseña restablecida.').trim()};
});
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

  const recoveryCode=crypto.randomBytes(12).toString('hex').toUpperCase();
  writeJsonAtomic(configPath, {
    companyName, adminEmail:email, jwtSecret:crypto.randomBytes(48).toString('base64url'),
    recoveryCodeHash:recoveryCodeHash(recoveryCode), recoveryCodePending:recoveryCode, setupAt:new Date().toISOString(),
    timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Mexico_City'
  });
  // Credenciales temporales: se pasan al proceso del backend y el archivo se borra
  // solo después de confirmar que la API está disponible.
  writeJsonAtomic(bootstrapPath, { email, password });
  try {
    await startBackend();
    await showRecoveryCode(recoveryCode);
    await openProduct();
    return { ok: true };
  } catch (error) {
    logDiagnostic('ERROR', 'Falló la configuración inicial: ' + (error.stack || error.message));
    // Si el arranque no alcanzó a confirmar la API, conserva la credencial temporal
    // para reintentar y retira solo la configuración incompleta.
    if (fs.existsSync(bootstrapPath)) {
      try { fs.unlinkSync(configPath); } catch {}
    }
    dialog.showErrorBox('No se pudo iniciar ASISTIA', error.message || 'Error desconocido.');
    throw new Error((error.message || 'No se pudo iniciar ASISTIA.') + '\n\nRegistro de diagnóstico: ' + logPath);
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());

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
      globalShortcut.register('CommandOrControl+Shift+R', async () => {
        try { if(readJson(configPath)) await showRecovery(); }
        catch(error) { dialog.showErrorBox('Recuperación de ASISTIA',error.message||'No se pudo abrir la recuperación.'); }
      });
      const config = readJson(configPath);
      if (!config) { await showSetup(); return; }
      if (config.recoveryCodePending) {
        await showRecoveryCode(config.recoveryCodePending,true);
      } else if (!config.recoveryCodeHash) {
        const recoveryCode=crypto.randomBytes(12).toString('hex').toUpperCase();
        config.recoveryCodeHash=recoveryCodeHash(recoveryCode);
        config.recoveryCodePending=recoveryCode;
        writeJsonAtomic(configPath,config);
        await showRecoveryCode(recoveryCode,true);
      }
      await startBackend();
      await openProduct();
    } catch (error) {
      logDiagnostic('ERROR', 'Error durante el inicio de la aplicación: ' + (error.stack || error.message));
      dialog.showErrorBox('ASISTIA no pudo iniciar', (error.message || 'Error desconocido.') + '\n\nRegistro: ' + logPath);
      app.quit();
    }
  });
}
