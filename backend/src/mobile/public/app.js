const TOKEN_KEY = 'asistia.mobile.session.v1';
const el = id => document.getElementById(id);
const state = { token: sessionStorage.getItem(TOKEN_KEY), employee: null, status: null, installPrompt: null };

function setMessage(target, message, isError) {
  target.textContent = message || '';
  target.classList.toggle('hidden', !message);
  target.classList.toggle('error', Boolean(isError));
}
async function api(path, options) {
  const config = options || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, config.headers || {});
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  let response;
  try { response = await fetch(path, Object.assign({}, config, { headers, cache: 'no-store' })); }
  catch { throw new Error('No se pudo conectar con ASISTIA. Comprueba que sigues en el Wi-Fi de tu sucursal.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación.');
  return data;
}
function showLogin() {
  el('login-view').classList.remove('hidden');
  el('home-view').classList.add('hidden');
  state.employee = null;
  state.status = null;
}
function showHome() {
  el('login-view').classList.add('hidden');
  el('home-view').classList.remove('hidden');
}
function renderStatus() {
  const last = state.status && state.status.lastEvent;
  const next = state.status ? state.status.nextEventType : 'clock_in';
  if (last && last.eventType === 'clock_in') {
    el('shift-badge').textContent = 'Jornada abierta';
    el('shift-badge').classList.add('active');
    el('shift-title').textContent = 'Tu entrada está registrada';
    el('shift-description').textContent = 'Cuando termine tu jornada, registra tu salida.';
  } else if (last) {
    el('shift-badge').textContent = 'Último registro: salida';
    el('shift-badge').classList.remove('active');
    el('shift-title').textContent = 'Tu última jornada está cerrada';
    el('shift-description').textContent = 'Cuando llegues a trabajar nuevamente, registra tu entrada.';
  } else {
    el('shift-badge').textContent = 'Sin registro';
    el('shift-badge').classList.remove('active');
    el('shift-title').textContent = 'Aún no registras entrada';
    el('shift-description').textContent = 'Cuando llegues a tu sucursal, registra tu entrada.';
  }
  el('attendance-button').textContent = next === 'clock_in' ? 'Registrar entrada' : 'Registrar salida';
}
async function loadProfile() {
  const data = await api('/api/mobile/me');
  state.employee = data.employee;
  el('employee-name').textContent = 'Hola, ' + data.employee.fullName.split(' ')[0] + '.';
  el('employee-meta').textContent = data.employee.employeeNumber + ' · ' + data.employee.branch;
  state.status = await api('/api/mobile/status');
  renderStatus();
  showHome();
}
function friendlyError(error) {
  const message = error && error.message ? error.message : 'Ocurrió un error inesperado.';
  if (message.includes('GPS') || message.includes('ubicación') || message.includes('precisión')) {
    el('location-title').textContent = 'No se pudo validar tu ubicación';
    el('location-description').textContent = message;
  }
  return message;
}
async function login(event) {
  event.preventDefault();
  const errorBox = el('login-error');
  setMessage(errorBox, '', false);
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: el('email').value.trim(), password: el('password').value })
    });
    if (!result.user || result.user.role !== 'worker') throw new Error('Esta aplicación es solo para cuentas de trabajador.');
    state.token = result.token;
    sessionStorage.setItem(TOKEN_KEY, state.token);
    await loadProfile();
    el('password').value = '';
  } catch (error) {
    state.token = null;
    sessionStorage.removeItem(TOKEN_KEY);
    setMessage(errorBox, friendlyError(error), true);
  } finally { if (button) button.disabled = false; }
}
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Este navegador no permite consultar la ubicación GPS.'));
    navigator.geolocation.getCurrentPosition(
      position => resolve(position),
      error => {
        const messages = {
          1: 'Permite el acceso a la ubicación para registrar asistencia.',
          2: 'No fue posible obtener tu ubicación. Activa GPS e inténtalo de nuevo.',
          3: 'La ubicación tardó demasiado. Inténtalo nuevamente.'
        };
        reject(new Error(messages[error.code] || 'No se pudo consultar la ubicación GPS.'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}
async function registerAttendance() {
  const button = el('attendance-button');
  const message = el('attendance-message');
  button.disabled = true;
  setMessage(message, 'Comprobando red y ubicación GPS...', false);
  el('location-title').textContent = 'Comprobando ubicación...';
  try {
    const position = await getCurrentPosition();
    const eventType = state.status.nextEventType;
    const result = await api('/api/mobile/attendance', {
      method: 'POST',
      body: JSON.stringify({
        eventType: eventType,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyM: position.coords.accuracy,
        clientRequestId: crypto.randomUUID()
      })
    });
    state.status = await api('/api/mobile/status');
    renderStatus();
    el('location-title').textContent = 'Ubicación verificada';
    el('location-description').textContent = 'Distancia al establecimiento: ' + result.validation.distanceM + ' m.';
    setMessage(message, eventType === 'clock_in' ? 'Entrada registrada correctamente.' : 'Salida registrada correctamente.', false);
  } catch (error) { setMessage(message, friendlyError(error), true); }
  finally { button.disabled = false; }
}
function logout() {
  state.token = null;
  sessionStorage.removeItem(TOKEN_KEY);
  el('password').value = '';
  showLogin();
}
el('login-form').addEventListener('submit', login);
el('logout-button').addEventListener('click', logout);
el('attendance-button').addEventListener('click', registerAttendance);
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  state.installPrompt = event;
  el('install-button').classList.remove('hidden');
});
el('install-button').addEventListener('click', async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  el('install-button').classList.add('hidden');
});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('/mobile/sw.js', { scope: '/mobile/' }).catch(() => {});
}
if (state.token) {
  loadProfile().catch(error => {
    state.token = null;
    sessionStorage.removeItem(TOKEN_KEY);
    showLogin();
    setMessage(el('login-error'), friendlyError(error), true);
  });
} else { showLogin(); }
