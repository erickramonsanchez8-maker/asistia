import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEffectiveMinutes, resolveAutomaticBreak, resolveLocalDateTime, validatePolicy } from '../src/meal-breaks.js';

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

test('automatic: resuelve la hora civil usando la zona horaria del negocio', () => {
  const resolved = resolveAutomaticBreak({
    shiftDate: '2026-11-02',
    timeZone: 'America/Mexico_City',
    policy: automatic
  });
  assert.equal(resolved.startAt, '2026-11-02T20:00:00.000Z');
  assert.equal(resolved.endAt, '2026-11-02T21:00:00.000Z');
});

test('rechaza una hora local inexistente durante el salto de horario de verano', () => {
  assert.throws(() => resolveLocalDateTime({
    date: '2026-03-08',
    time: '02:30',
    timeZone: 'America/New_York'
  }), /no existe por el cambio de horario/);
});

test('elige de forma determinista la primera ocurrencia de una hora local repetida', () => {
  assert.equal(resolveLocalDateTime({
    date: '2026-11-01',
    time: '01:30',
    timeZone: 'America/New_York'
  }), '2026-11-01T05:30:00.000Z');
});

test('rechaza instantes sin zona u offset explícito', () => {
  assert.throws(() => calculateEffectiveMinutes({
    clockInAt: '2026-11-02T09:00:00',
    clockOutAt: '2026-11-02T18:00:00Z',
    policy: manual
  }), /offset ISO-8601 explícito/);
});

test('rechaza zonas IANA desconocidas y fechas civiles inválidas', () => {
  assert.throws(() => resolveLocalDateTime({
    date: '2026-02-30',
    time: '14:00',
    timeZone: 'America/Mexico_City'
  }), /no existe en el calendario/);
  assert.throws(() => resolveLocalDateTime({
    date: '2026-11-02',
    time: '14:00',
    timeZone: 'Mars/Olympus'
  }), /zona horaria IANA no es válida/);
});
