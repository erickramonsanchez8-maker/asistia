/**
 * ASISTIA — cálculo de descansos de comida.
 * Funciones puras: no dependen de Express, Electron ni del reloj del sistema.
 * Los instantes deben ser ISO-8601 con zona/offset explícito.
 */
const MODES = new Set(['manual', 'automatic']);
const OFFSET_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/;

function toMillis(value, label) {
  if (typeof value !== 'string' || !OFFSET_INSTANT.test(value)) {
    throw new TypeError(label + ' debe incluir fecha, hora y zona/offset ISO-8601 explícito.');
  }
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

function localParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

/**
 * Convierte una hora civil del turno a un instante real.
 * Horas inexistentes por el salto DST se rechazan. En una hora repetida se elige
 * la primera ocurrencia (instante UTC más temprano) para mantener determinismo.
 */
export function resolveLocalDateTime({ date, time, timeZone }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new TypeError('La fecha del turno debe usar YYYY-MM-DD.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || ''))) throw new TypeError('La hora programada debe usar HH:mm.');
  if (typeof timeZone !== 'string' || !timeZone.trim()) throw new TypeError('Se requiere la zona horaria IANA del negocio.');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const checkDate = new Date(naive);
  if (checkDate.getUTCFullYear() !== year || checkDate.getUTCMonth() !== month - 1 || checkDate.getUTCDate() !== day) {
    throw new TypeError('La fecha del turno no existe en el calendario.');
  }

  // Valida la zona antes de buscar sus offsets.
  try { new Intl.DateTimeFormat('en', { timeZone }).format(new Date(naive)); }
  catch { throw new TypeError('La zona horaria IANA no es válida.'); }

  const offsets = new Set();
  for (let delta = -36; delta <= 36; delta += 3) {
    const sample = naive + delta * 60 * 60 * 1000;
    const p = localParts(sample, timeZone);
    const representedAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    offsets.add(representedAsUtc - sample);
  }

  const candidates = [...offsets]
    .map(offset => naive - offset)
    .filter(candidate => {
      const p = localParts(candidate, timeZone);
      return p.year === year && p.month === month && p.day === day &&
        p.hour === hour && p.minute === minute && p.second === 0;
    })
    .sort((a, b) => a - b);

  if (!candidates.length) throw new RangeError('La hora programada no existe por el cambio de horario de la zona seleccionada.');
  return new Date(candidates[0]).toISOString();
}

export function resolveAutomaticBreak({ shiftDate, policy, timeZone }) {
  const config = validatePolicy(policy);
  if (config.mode !== 'automatic') throw new TypeError('La resolución programada solo aplica a la modalidad automática.');
  const startAt = resolveLocalDateTime({ date: shiftDate, time: config.scheduledStart, timeZone });
  return Object.freeze({
    startAt,
    endAt: new Date(Date.parse(startAt) + config.durationMinutes * 60000).toISOString()
  });
}

/**
 * automaticBreak.startAt debe ser el instante resuelto a partir de scheduledStart
 * y la zona horaria IANA del negocio, nunca una hora local interpretada por el equipo.
 */
export function calculateEffectiveMinutes({ clockInAt, clockOutAt, policy, breaks = [], automaticBreak = null }) {
  const config = validatePolicy(policy);
  const start = toMillis(clockInAt, 'clockInAt');
  const end = toMillis(clockOutAt, 'clockOutAt');
  if (end <= start) throw new RangeError('La salida debe ser posterior a la entrada.');

  const excluded = [];
  if (!config.countsAsWork) {
    if (config.mode === 'manual') {
      if (!Array.isArray(breaks)) throw new TypeError('breaks debe ser una lista de descansos.');
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
