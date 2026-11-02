import { randomUUID, createHash } from 'node:crypto';
import { calculateEffectiveMinutes, resolveAutomaticBreak, validatePolicy } from './meal-breaks.js';

const DEFAULT_POLICY = Object.freeze({
  mode: 'manual',
  durationMinutes: 60,
  scheduledStart: null,
  countsAsWork: false,
  timeZone: 'America/Mexico_City'
});

function validateStoredPolicy(input) {
  const policy = {
    mode: input?.mode,
    durationMinutes: Number(input?.durationMinutes),
    scheduledStart: input?.scheduledStart || null,
    countsAsWork: input?.countsAsWork,
    timeZone: String(input?.timeZone || '').trim()
  };
  validatePolicy(policy);
  if (policy.mode === 'automatic' && !policy.scheduledStart) {
    throw Object.assign(new Error('La modalidad automática requiere una hora programada.'), { status: 400 });
  }
  try { new Intl.DateTimeFormat('en', { timeZone: policy.timeZone }).format(new Date()); }
  catch { throw Object.assign(new Error('Selecciona una zona horaria IANA válida.'), { status: 400 }); }
  return policy;
}

function getPolicy(db, companyId) {
  const row = db.prepare('SELECT mode,duration_minutes AS durationMinutes,scheduled_start AS scheduledStart,counts_as_work AS countsAsWork,time_zone AS timeZone FROM meal_break_policies WHERE company_id=?').get(companyId);
  return row ? { ...row, countsAsWork: Boolean(row.countsAsWork) } : { ...DEFAULT_POLICY };
}

function getPolicyAt(db, companyId, instant) {
  const row = db.prepare(`SELECT mode,duration_minutes AS durationMinutes,scheduled_start AS scheduledStart,
    counts_as_work AS countsAsWork,time_zone AS timeZone
    FROM meal_break_policy_history WHERE company_id=? AND effective_at<=?
    ORDER BY effective_at DESC,rowid DESC LIMIT 1`).get(companyId, instant);
  return row ? { ...row, countsAsWork: Boolean(row.countsAsWork) } : { ...DEFAULT_POLICY };
}

function dateInZone(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return values.year + '-' + values.month + '-' + values.day;
}

function pairMealEvents(events) {
  const breaks = [];
  let open = null;
  for (const event of events) {
    if (event.event_type === 'meal_out') {
      if (open) return { breaks, incomplete: true, error: 'Hay dos salidas a comer sin un regreso intermedio.' };
      open = event.occurred_at;
    } else {
      if (!open) return { breaks, incomplete: true, error: 'Hay un regreso de comida sin una salida previa.' };
      breaks.push({ startAt: open, endAt: event.occurred_at });
      open = null;
    }
  }
  return { breaks, incomplete: Boolean(open), error: open ? 'Falta registrar el regreso de comida.' : null };
}

export function buildEffectiveShifts({ attendanceEvents, mealEvents, policyForShift }) {
  const shifts = [];
  let openShift = null;
  for (const event of attendanceEvents) {
    if (event.eventType === 'clock_in') {
      if (openShift) shifts.push({ clockInAt: openShift, clockOutAt: null, status: 'incomplete', issue: 'Existe una entrada posterior sin salida previa.' });
      openShift = event.occurredAt;
    } else if (event.eventType === 'clock_out') {
      if (!openShift) {
        shifts.push({ clockInAt: null, clockOutAt: event.occurredAt, status: 'invalid', issue: 'Salida sin entrada asociada.' });
        continue;
      }
      const inAt = openShift;
      openShift = null;
      const shiftPolicy = policyForShift(inAt);
      const meals = shiftPolicy.mode === 'manual' ? mealEvents.filter(item => Date.parse(item.occurred_at) >= Date.parse(inAt) && Date.parse(item.occurred_at) <= Date.parse(event.occurredAt)) : [];
      const paired = pairMealEvents(meals);
      if (paired.incomplete) {
        shifts.push({ clockInAt: inAt, clockOutAt: event.occurredAt, status: 'incomplete', issue: paired.error });
        continue;
      }
      try {
        const automaticBreak = policy.mode === 'automatic'
          ? resolveAutomaticBreak({ shiftDate: dateInZone(inAt, policy.timeZone), policy, timeZone: policy.timeZone })
          : null;
        const totals = calculateEffectiveMinutes({
          clockInAt: inAt,
          clockOutAt: event.occurredAt,
          policy: shiftPolicy,
          breaks: paired.breaks,
          automaticBreak
        });
        shifts.push({ clockInAt: inAt, clockOutAt: event.occurredAt, status: 'complete', policy: shiftPolicy, ...totals });
      } catch (error) {
        shifts.push({ clockInAt: inAt, clockOutAt: event.occurredAt, status: 'incomplete', issue: error.message });
      }
    }
  }
  if (openShift) shifts.push({ clockInAt: openShift, clockOutAt: null, status: 'in_progress', issue: null });
  const complete = shifts.filter(item => item.status === 'complete');
  return {
    shifts,
    totals: {
      completedShifts: complete.length,
      grossMinutes: complete.reduce((sum, item) => sum + item.grossMinutes, 0),
      breakMinutes: complete.reduce((sum, item) => sum + item.breakMinutes, 0),
      effectiveMinutes: complete.reduce((sum, item) => sum + item.effectiveMinutes, 0),
      incompleteShifts: shifts.filter(item => item.status === 'incomplete' || item.status === 'invalid').length,
      inProgressShifts: shifts.filter(item => item.status === 'in_progress').length
    }
  };
}

export function installMealBreakRoutes({ app, db, authenticate, roles, appError, writeAudit, assertLicenseAllowsOperation }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meal_break_policies (
      company_id TEXT PRIMARY KEY REFERENCES companies(id),
      mode TEXT NOT NULL CHECK(mode IN ('manual','automatic')),
      duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 1 AND 240),
      scheduled_start TEXT,
      counts_as_work INTEGER NOT NULL CHECK(counts_as_work IN (0,1)),
      time_zone TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS meal_break_events (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      employee_id TEXT NOT NULL REFERENCES employees(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('meal_out','meal_return')),
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      previous_hash TEXT,
      event_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meal_events_company_employee_time
      ON meal_break_events(company_id, employee_id, occurred_at);
  `);

  app.get('/api/meal-break/policy', authenticate, (req, res) => {
    res.json({ policy: getPolicy(db, req.user.companyId) });
  });

  app.put('/api/meal-break/policy', authenticate, roles('admin'), (req, res, next) => {
    try {
      assertLicenseAllowsOperation(req.user.companyId, 'configurar descansos de comida');
      const policy = validateStoredPolicy(req.body);
      const updatedAt = new Date().toISOString();
      db.transaction(() => {
        db.prepare(`INSERT INTO meal_break_policies(company_id,mode,duration_minutes,scheduled_start,counts_as_work,time_zone,updated_at,updated_by)
          VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(company_id) DO UPDATE SET mode=excluded.mode,duration_minutes=excluded.duration_minutes,
          scheduled_start=excluded.scheduled_start,counts_as_work=excluded.counts_as_work,time_zone=excluded.time_zone,
          updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
          .run(req.user.companyId, policy.mode, policy.durationMinutes, policy.scheduledStart, policy.countsAsWork ? 1 : 0, policy.timeZone, updatedAt, req.user.id);
        db.prepare(`INSERT INTO meal_break_policy_history(id,company_id,mode,duration_minutes,scheduled_start,counts_as_work,time_zone,effective_at,updated_by)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), req.user.companyId, policy.mode, policy.durationMinutes, policy.scheduledStart, policy.countsAsWork ? 1 : 0, policy.timeZone, updatedAt, req.user.id);
        writeAudit(req.user.companyId, req.user.id, 'meal_break.policy_updated', 'meal_break_policy', req.user.companyId, { ...policy, effectiveAt: updatedAt });
      })();
      res.json({ ok: true, policy: getPolicy(db, req.user.companyId), updatedAt });
    } catch (error) { next(error.status ? error : appError(400, error.message)); }
  });

  app.post('/api/meal-break/events', authenticate, (req, res, next) => {
    try {
      assertLicenseAllowsOperation(req.user.companyId, 'registrar descansos de comida');
      const policy = getPolicy(db, req.user.companyId);
      if (policy.mode !== 'manual') throw appError(409, 'La empresa tiene configurados descansos automáticos; no se aceptan marcas manuales.');
      const employeeId = String(req.body?.employeeId || '');
      const eventType = String(req.body?.eventType || '');
      if (!employeeId || !['meal_out', 'meal_return'].includes(eventType)) throw appError(400, 'Empleado o tipo de evento de comida inválido.');
      if (req.user.role === 'worker' && req.user.employeeId !== employeeId) throw appError(403, 'Solo puedes registrar tu propio descanso.');
      const employee = db.prepare('SELECT id,active FROM employees WHERE id=? AND company_id=?').get(employeeId, req.user.companyId);
      if (!employee || !employee.active) throw appError(404, 'Empleado no encontrado o inactivo.');
      const latestAttendance = db.prepare(`SELECT e.event_type AS eventType FROM attendance_events e
        WHERE e.company_id=? AND e.employee_id=?
        ORDER BY COALESCE((SELECT a.adjusted_time FROM attendance_adjustments a
          WHERE a.original_event_id=e.id ORDER BY a.rowid DESC LIMIT 1),e.occurred_at) DESC,e.rowid DESC LIMIT 1`)
        .get(req.user.companyId, employeeId);
      if (!latestAttendance || latestAttendance.eventType !== 'clock_in') throw appError(409, 'Solo puedes registrar comida durante una jornada abierta.');
      const openMeal = db.prepare(`SELECT event_type FROM meal_break_events
        WHERE company_id=? AND employee_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 1`).get(req.user.companyId, employeeId);
      if (eventType === 'meal_out' && openMeal?.event_type === 'meal_out') throw appError(409, 'Ya existe una salida a comer sin regreso.');
      if (eventType === 'meal_return' && (!openMeal || openMeal.event_type !== 'meal_out')) throw appError(409, 'No existe una salida a comer pendiente de regreso.');
      const occurredAt = new Date().toISOString();
      const previousHash = db.prepare('SELECT event_hash FROM meal_break_events WHERE company_id=? ORDER BY rowid DESC LIMIT 1').get(req.user.companyId)?.event_hash || null;
      const id = randomUUID();
      const payload = { id, companyId: req.user.companyId, employeeId, eventType, occurredAt, createdBy: req.user.id, previousHash };
      const eventHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      db.transaction(() => {
        db.prepare(`INSERT INTO meal_break_events(id,company_id,employee_id,event_type,occurred_at,received_at,created_by,previous_hash,event_hash)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(id, req.user.companyId, employeeId, eventType, occurredAt, occurredAt, req.user.id, previousHash, eventHash);
        writeAudit(req.user.companyId, req.user.id, 'meal_break.event_created', 'meal_break_event', id, { employeeId, eventType, occurredAt, eventHash });
      })();
      res.status(201).json({ event: { id, employeeId, eventType, occurredAt, eventHash } });
    } catch (error) { next(error); }
  });

  app.get('/api/meal-break/events', authenticate, roles('admin','supervisor'), (req, res, next) => {
    try {
      const employeeId = req.query.employeeId ? String(req.query.employeeId) : null;
      const rows = db.prepare(`SELECT id,employee_id AS employeeId,event_type AS eventType,occurred_at AS occurredAt,
        received_at AS receivedAt,created_by AS createdBy,event_hash AS eventHash
        FROM meal_break_events WHERE company_id=? AND (? IS NULL OR employee_id=?)
        ORDER BY occurred_at DESC LIMIT 500`).all(req.user.companyId, employeeId, employeeId);
      res.json({ events: rows });
    } catch (error) { next(error); }
  });

  app.get('/api/attendance/effective', authenticate, roles('admin','supervisor'), (req, res, next) => {
    try {
      const employeeId = String(req.query.employeeId || '');
      if (!employeeId) throw appError(400, 'Selecciona un empleado para calcular sus horas efectivas.');
      const employee = db.prepare('SELECT id,employee_number AS employeeNumber,full_name AS fullName FROM employees WHERE id=? AND company_id=?').get(employeeId, req.user.companyId);
      if (!employee) throw appError(404, 'Empleado no encontrado.');
      const attendanceEvents = db.prepare(`SELECT e.event_type AS eventType,
        COALESCE((SELECT a.adjusted_time FROM attendance_adjustments a WHERE a.original_event_id=e.id ORDER BY a.rowid DESC LIMIT 1),e.occurred_at) AS occurredAt
        FROM attendance_events e WHERE e.company_id=? AND e.employee_id=? ORDER BY occurredAt,e.rowid`).all(req.user.companyId, employeeId);
      const mealEvents = db.prepare(`SELECT event_type,occurred_at FROM meal_break_events
        WHERE company_id=? AND employee_id=? ORDER BY occurred_at,rowid`).all(req.user.companyId, employeeId);
      const policy = getPolicy(db, req.user.companyId);
      res.json({
        employee,
        policy,
        ...buildEffectiveShifts({
          attendanceEvents,
          mealEvents,
          policyForShift: instant => getPolicyAt(db, req.user.companyId, instant)
        })
      });
    } catch (error) { next(error); }
  });
}
