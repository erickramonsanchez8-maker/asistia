import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEffectiveMinutes, validatePolicy } from '../src/meal-breaks.js';

const manual = { mode: 'manual', durationMinutes: 60, countsAsWork: false };
const automatic = { mode: 'automatic', durationMinutes: 60, scheduledStart: '14:00', countsAsWork: false };

test('manual: descuenta el tiempo real entre salida y regreso', () => {
  const result = calculateEffectiveMinutes({
    clockInAt: '2026-11-02T09:00:00-06:00',
    clockOutAt: '2026-11-02T18:00:00-06:00',
    policy: manual,
    breaks: [{ startAt: '2026-11-02T14:05:00-06:00', endAt: '2026-11-02T14:45:00-06:00' }]
  });
  assert.deepEqual(
    { gross: result.grossMinutes, breaks: result.breakMinutes, effective: result.effectiveMinutes },
    { gross: 540, breaks: 40, effective: 500 }
  );
});

test('manual: combina intervalos superpuestos para no descontar dos veces', () => {
  const result = calculateEffectiveMinutes({
    clockInAt: '2026-11-02T09:00:00Z',
    clockOutAt: '2026-11-02T18:00:00Z',
    policy: manual,
    breaks: [
      { startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T14:40:00Z' },
      { startAt: '2026-11-02T14:30:00Z', endAt: '2026-11-02T15:00:00Z' }
    ]
  });
  assert.equal(result.breakMinutes, 60);
  assert.equal(result.effectiveMinutes, 480);
});

test('manual: recorta descansos que rebasan los límites de la jornada', () => {
  const result = calculateEffectiveMinutes({
    clockInAt: '2026-11-02T09:00:00Z',
    clockOutAt: '2026-11-02T18:00:00Z',
    policy: manual,
    breaks: [{ startAt: '2026-11-02T08:50:00Z', endAt: '2026-11-02T09:20:00Z' }]
  });
  assert.equal(result.breakMinutes, 20);
  assert.equal(result.effectiveMinutes, 520);
});

test('automatic: descuenta el periodo programado, limitado a la jornada', () => {
  const result = calculateEffectiveMinutes({
    clockInAt: '2026-11-02T09:00:00Z',
    clockOutAt: '2026-11-02T18:00:00Z',
    policy: automatic,
    automaticBreak: { startAt: '2026-11-02T14:00:00Z' }
  });
  assert.equal(result.breakMinutes, 60);
  assert.equal(result.effectiveMinutes, 480);
});

test('automatic: descuenta solo la parte del descanso dentro de la jornada', () => {
  const result = calculateEffectiveMinutes({
    clockInAt: '2026-11-02T09:00:00Z',
    clockOutAt: '2026-11-02T14:30:00Z',
    policy: automatic,
    automaticBreak: { startAt: '2026-11-02T14:00:00Z' }
  });
  assert.equal(result.breakMinutes, 30);
  assert.equal(result.effectiveMinutes, 300);
});

test('si la comida cuenta como tiempo trabajado, no se descuenta', () => {
  const result = calculateEffectiveMinutes({
    clockInAt: '2026-11-02T09:00:00Z',
    clockOutAt: '2026-11-02T18:00:00Z',
    policy: { ...manual, countsAsWork: true },
    breaks: [{ startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T15:00:00Z' }]
  });
  assert.equal(result.breakMinutes, 0);
  assert.equal(result.effectiveMinutes, 540);
});

test('rechaza descansos manuales sin regreso y políticas incompletas', () => {
  assert.throws(() => validatePolicy({ mode: 'manual', durationMinutes: 60 }), /countsAsWork/);
  assert.throws(() => calculateEffectiveMinutes({
    clockInAt: '2026-11-02T09:00:00Z',
    clockOutAt: '2026-11-02T18:00:00Z',
    policy: manual,
    breaks: [{ startAt: '2026-11-02T14:00:00Z' }]
  }), /inicio y regreso/);
});

test('rechaza salida anterior o igual a entrada', () => {
  assert.throws(() => calculateEffectiveMinutes({
    clockInAt: '2026-11-02T18:00:00Z',
    clockOutAt: '2026-11-02T18:00:00Z',
    policy: manual
  }), /posterior/);
});
