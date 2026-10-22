const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, normalizeBaseUrl } = require('./api-client.js');

function fakeResponse(status, payload, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : null },
    json: async () => payload,
    text: async () => String(payload)
  };
}

test('solo permite HTTPS o HTTP local para la URL base', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(normalizeBaseUrl('https://licencias.example.com/api'), 'https://licencias.example.com/api');
  assert.throws(() => normalizeBaseUrl('http://licencias.example.com'), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('https://user:pass@example.com'), /credenciales/);
});

test('login mantiene el token solo en memoria y lo envía como Bearer', async () => {
  const calls = [];
  const client = createClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/auth/login')) return fakeResponse(200, {
        token: 'test-jwt', tokenType: 'Bearer', expiresIn: '20m',
        user: { id: 'u1', name: 'Admin', role: 'admin' }
      });
      return fakeResponse(200, { user: { id: 'u1' } });
    }
  });
  const result = await client.login('ADMIN@EXAMPLE.COM', 'password');
  assert.equal(result.user.id, 'u1');
  assert.equal(client.isAuthenticated, true);
  assert.equal(calls[0].options.body, JSON.stringify({ email: 'admin@example.com', password: 'password' }));
  await client.me();
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-jwt');
  assert.equal(calls[1].options.cache, 'no-store');
  client.logout();
  assert.equal(client.isAuthenticated, false);
  assert.equal(client.currentUser, null);
});

test('rechaza errores de API y limpia la sesión cuando el token expira', async () => {
  const client = createClient({
    baseUrl: 'http://localhost:3000',
    fetch: async (url) => {
      if (url.endsWith('/api/auth/login')) return fakeResponse(200, {
        token: 'jwt', user: { id: 'u2', role: 'admin' }
      });
      return fakeResponse(401, { error: 'Token vencido.' });
    }
  });
  await client.login('admin@example.com', 'secret');
  await assert.rejects(client.me(), /Token vencido/);
  assert.equal(client.isAuthenticated, false);
});

test('valida evento y origen compatibles con el esquema de la API', async () => {
  const calls = [];
  const client = createClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async (url, options) => { calls.push({url, options}); return fakeResponse(201, { event: { id: 'event-1' } }); }
  });
  assert.throws(() => client.punch('employee-1', 'break'), /Tipo de asistencia no válido/);
  assert.throws(() => client.punch('employee-1', 'clock_in', 'desktop'), /Origen de asistencia no válido/);
  assert.equal(calls.length, 0);
  await client.punch('employee-1', 'clock_in');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/attendance/events');
  assert.equal(calls[0].options.body, JSON.stringify({employeeId:'employee-1',eventType:'clock_in',source:'admin'}));
});
