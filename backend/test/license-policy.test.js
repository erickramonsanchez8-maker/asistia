import test from 'node:test';
import assert from 'node:assert/strict';
import { getLicensePresentation } from '../src/license-policy.js';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const stateWithExpiry = (status, expiresAt) => ({
  status,
  license: { expiresAt }
});

test('muestra aviso cuando faltan exactamente 10 días', () => {
  const result = getLicensePresentation(stateWithExpiry('active', '2026-10-29T12:00:00.000Z'), NOW);
  assert.equal(result.daysRemaining, 10);
  assert.equal(result.showExpiryWarning, true);
  assert.equal(result.historyReadOnly, false);
});

test('muestra aviso el día de vencimiento y no antes de los 10 días', () => {
  assert.equal(getLicensePresentation(stateWithExpiry('active', '2026-10-19T12:00:00.000Z'), NOW).showExpiryWarning, true);
  assert.equal(getLicensePresentation(stateWithExpiry('active', '2026-10-30T12:00:00.000Z'), NOW).showExpiryWarning, false);
});

test('una licencia vencida durante la gracia sin conexión sigue en modo de solo lectura', () => {
  const result = getLicensePresentation(stateWithExpiry('offline_grace', '2026-10-18T12:00:00.000Z'), NOW);
  assert.equal(result.daysRemaining, -1);
  assert.equal(result.showExpiryWarning, false);
  assert.equal(result.historyReadOnly, true);
});

test('sin licencia no habilita operaciones ni muestra un falso aviso de vencimiento', () => {
  const result = getLicensePresentation({ status: 'unlicensed', license: null }, NOW);
  assert.equal(result.daysRemaining, null);
  assert.equal(result.showExpiryWarning, false);
  assert.equal(result.historyReadOnly, true);
});
