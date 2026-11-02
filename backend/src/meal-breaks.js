/**
 * ASISTIA — cálculo de descansos de comida.
 * Funciones puras: no dependen de Express, Electron ni del reloj del sistema.
 * Los instantes recibidos deben ser ISO-8601 con zona/offset explícito.
 */
const MODES = new Set(['manual', 'automatic']);

function toMillis(value, label) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(label + ' debe ser una fecha ISO-8601 válida.');
  return ms;
}

export function validatePolicy(policy) {
  if (!policy || !MODES.has(policy.mode)) throw new TypeError('La modalidad de comida debe ser manual o automatic.');
  const durationMinutes = Number(policy.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 240) {
    throw new RangeError('La duración de comida debe estar entre 1 y 240 minutos.');
  }
  if (typeof policy.countsAsWork !== 'boolean') throw new TypeError('countsAsWork debe ser booleano.');
  if (policy.mode === 'automatic' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(policy.scheduledStart || ''))) {
    throw new TypeError('La modalidad automática requiere scheduledStart en formato HH:mm.');
  }
  return { ...policy, durationMinutes };
}

function mergeIntervals(intervals) {
  const sorted = intervals.filter(item => item.end > item.start).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const current of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && current.start <= previous.end) previous.end = Math.max(previous.end, current.end);
    else merged.push({ start: current.start, end: current.end });
  }
  return merged;
}

function clipInterval(start, end, lower, upper) {
  return { start: Math.max(start, lower), end: Math.min(end, upper) };
}

/**
 * automaticBreak.startAt debe ser el instante UTC resuelto por el servicio de turnos
 * a partir de scheduledStart y la zona horaria IANA de la empresa.
 */
export function calculateEffectiveMinutes({ clockInAt, clockOutAt, policy, breaks = [], automaticBreak = null }) {
  const config = validatePolicy(policy);
  const start = toMillis(clockInAt, 'clockInAt');
  const end = toMillis(clockOutAt, 'clockOutAt');
  if (end <= start) throw new RangeError('La salida debe ser posterior a la entrada.');

  const excluded = [];
  if (!config.countsAsWork) {
    if (config.mode === 'manual') {
      for (const item of breaks) {
        if (!item || !item.startAt || !item.endAt) throw new TypeError('Cada descanso manual debe tener inicio y regreso registrados.');
        const breakStart = toMillis(item.startAt, 'break.startAt');
        const breakEnd = toMillis(item.endAt, 'break.endAt');
        if (breakEnd <= breakStart) throw new RangeError('El regreso debe ser posterior a la salida a comer.');
        const clipped = clipInterval(breakStart, breakEnd, start, end);
        if (clipped.end > clipped.start) excluded.push(clipped);
      }
    } else {
      if (!automaticBreak || !automaticBreak.startAt) throw new TypeError('La modalidad automática requiere el instante programado de comida.');
      const breakStart = toMillis(automaticBreak.startAt, 'automaticBreak.startAt');
      const clipped = clipInterval(breakStart, breakStart + config.durationMinutes * 60000, start, end);
      if (clipped.end > clipped.start) excluded.push(clipped);
    }
  }

  const merged = mergeIntervals(excluded);
  const excludedMs = merged.reduce((total, item) => total + item.end - item.start, 0);
  const grossMs = end - start;
  return Object.freeze({
    grossMinutes: Math.round(grossMs / 60000),
    breakMinutes: Math.round(excludedMs / 60000),
    effectiveMinutes: Math.round((grossMs - excludedMs) / 60000),
    breakIntervals: merged.map(item => ({ startAt: new Date(item.start).toISOString(), endAt: new Date(item.end).toISOString() }))
  });
}

