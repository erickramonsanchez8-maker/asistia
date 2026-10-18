/* ASISTIA API client. No guarda JWT ni datos de asistencia en localStorage. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ASISTIAApiClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 10000;
  const MAX_TIMEOUT_MS = 60000;

  function normalizeBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Configura la URL de ASISTIA API.');
    let url;
    try { url = new URL(raw); } catch { throw new Error('La URL de ASISTIA API no es válida.'); }
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHosts.has(url.hostname))) {
      throw new Error('Por seguridad, usa HTTPS. HTTP solo se permite en localhost.');
    }
    if (url.username || url.password || url.search || url.hash) throw new Error('La URL base no debe incluir credenciales, parámetros ni fragmentos.');
    return url.toString().replace(/\/$/, '');
  }

  function createClient(options) {
    const config = options || {};
    const baseUrl = normalizeBaseUrl(config.baseUrl || 'http://127.0.0.1:3000');
    const fetchImpl = config.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchImpl) throw new Error('Este entorno no tiene fetch disponible.');
    const timeoutMs = Math.max(1000, Math.min(Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    let token = null;
    let currentUser = null;

    async function request(path, requestOptions) {
      const opts = requestOptions || {};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const headers = { Accept: 'application/json', ...(opts.headers || {}) };
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      if (opts.auth !== false && token) headers.Authorization = 'Bearer ' + token;
      try {
        const response = await fetchImpl(baseUrl + path, {
          method: opts.method || 'GET',
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error'
        });
        const type = response.headers && response.headers.get ? response.headers.get('content-type') || '' : '';
        const payload = type.includes('application/json') ? await response.json() : await response.text();
        if (response.status === 401 && opts.auth !== false) {
          token = null;
          currentUser = null;
        }
        if (!response.ok) {
          const message = payload && typeof payload === 'object' && payload.error
            ? payload.error : 'La API respondió con HTTP ' + response.status + '.';
          const error = new Error(message);
          error.status = response.status;
          error.details = payload && payload.details;
          throw error;
        }
        return payload;
      } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('La API tardó demasiado en responder. Comprueba que ASISTIA esté encendido.');
        if (error instanceof TypeError) throw new Error('No se pudo conectar con ASISTIA API. Comprueba que el servicio esté encendido y que la URL sea correcta.');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    return Object.freeze({
      get baseUrl() { return baseUrl; },
      get isAuthenticated() { return Boolean(token); },
      get currentUser() { return currentUser ? { ...currentUser } : null; },
      async health() { return request('/api/health', { auth: false }); },
      async login(email, password) {
        if (!String(email || '').trim() || !String(password || '')) throw new Error('Escribe tu correo y contraseña.');
        const result = await request('/api/auth/login', {
          method: 'POST', auth: false,
          body: { email: String(email).trim().toLowerCase(), password: String(password) }
        });
        if (!result || typeof result.token !== 'string' || !result.user) throw new Error('La API devolvió una respuesta de inicio de sesión inválida.');
        token = result.token;
        currentUser = result.user;
        return { user: { ...currentUser }, tokenType: result.tokenType, expiresIn: result.expiresIn };
      },
      logout() { token = null; currentUser = null; },
      me() { return request('/api/me'); },
      company() { return request('/api/company'); },
      employees(params) {
        const query = new URLSearchParams();
        if (params && params.limit !== undefined) query.set('limit', String(params.limit));
        if (params && params.offset !== undefined) query.set('offset', String(params.offset));
        const suffix = query.toString();
        return request('/api/employees' + (suffix ? '?' + suffix : ''));
      },
      createEmployee(employee) {
        return request('/api/employees', { method: 'POST', body: employee });
      },
      deactivateEmployee(id) {
        return request('/api/employees/' + encodeURIComponent(id) + '/deactivate', { method: 'PATCH', body: {} });
      },
      punch(employeeId, eventType, source) {
        if (!employeeId) throw new Error('Falta el identificador del empleado.');
        if (!['clock_in', 'clock_out'].includes(eventType)) throw new Error('Tipo de asistencia no válido.');
        return request('/api/attendance/events', {
          method: 'POST', body: { employeeId: String(employeeId), eventType, source: source || 'desktop' }
        });
      },
      attendance(params) {
        const query = new URLSearchParams();
        for (const key of ['from', 'to', 'limit', 'offset', 'employeeId']) {
          if (params && params[key] !== undefined && params[key] !== '') query.set(key, String(params[key]));
        }
        const suffix = query.toString();
        return request('/api/attendance/events' + (suffix ? '?' + suffix : ''));
      },
      licenseStatus() { return request('/api/license/status'); },
      activateLicense(activationCode) {
        return request('/api/license/activate', { method: 'POST', body: { activationCode } });
      },
      refreshLicense() { return request('/api/license/refresh', { method: 'POST', body: {} }); },
      deactivateLicense() { return request('/api/license/deactivate', { method: 'POST', body: {} }); },
      async attendanceCsv(params) {
        const query = new URLSearchParams();
        for (const key of ['from', 'to', 'employeeId']) {
          if (params && params[key] !== undefined && params[key] !== '') query.set(key, String(params[key]));
        }
        const suffix = query.toString();
        const result = await request('/api/reports/attendance.csv' + (suffix ? '?' + suffix : ''));
        return result;
      }
    });
  }

  return Object.freeze({ createClient, normalizeBaseUrl });
});
