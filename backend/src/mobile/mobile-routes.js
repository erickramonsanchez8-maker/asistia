import express from 'express';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));

function ipv4ToInt(address) {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}
function isValidIpv4Cidr(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  if (parts.length > 2 || isIP(parts[0]) !== 4) return false;
  if (parts.length === 1) return true;
  const prefix = Number(parts[1]);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}
function ipv4MatchesCidr(address, cidr) {
  if (isIP(address) !== 4 || !isValidIpv4Cidr(cidr)) return false;
  const parts = cidr.split('/');
  const prefix = parts.length === 1 ? 32 : Number(parts[1]);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(parts[0]) & mask);
}
function remoteIpv4(req) {
  const raw = String(req.socket?.remoteAddress || '');
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return isIP(address) === 4 ? address : null;
}
function isAllowedLanRequest(req, cidrs) {
  const address = remoteIpv4(req);
  return Boolean(address && cidrs.some(cidr => ipv4MatchesCidr(address, cidr)));
}
function distanceMeters(lat1, lon1, lat2, lon2) {
  const rad = value => value * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const settingsSchema = z.object({
  branch: z.string().trim().min(1).max(100),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusM: z.number().int().min(10).max(500).default(50),
  maxAccuracyM: z.number().int().min(5).max(100).default(50),
  allowedCidrs: z.array(z.string().max(20)).min(1).max(8)
    .refine(values => values.every(isValidIpv4Cidr), 'Usa rangos IPv4 CIDR válidos, por ejemplo 192.168.1.0/24.')
});
const attendanceSchema = z.object({
  eventType: z.enum(['clock_in', 'clock_out']),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().positive().max(10000),
  clientRequestId: z.string().uuid()
});
const appError = (status, message) => Object.assign(new Error(message), { status });

export function registerMobileRoutes(app, dependencies) {
  const { db, authenticate, roles, writeAudit, writeEvent, now } = dependencies;

  db.exec(
    'CREATE TABLE IF NOT EXISTS mobile_sites (' +
    'id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), branch TEXT NOT NULL,' +
    'latitude REAL NOT NULL, longitude REAL NOT NULL, radius_m INTEGER NOT NULL DEFAULT 50,' +
    'max_accuracy_m INTEGER NOT NULL DEFAULT 50, allowed_cidrs_json TEXT NOT NULL,' +
    'active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL REFERENCES users(id),' +
    'UNIQUE(company_id, branch));' +
    'CREATE TABLE IF NOT EXISTS mobile_attendance_evidence (' +
    'id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),' +
    'attendance_event_id TEXT NOT NULL UNIQUE REFERENCES attendance_events(id),' +
    'site_id TEXT NOT NULL REFERENCES mobile_sites(id), client_request_id TEXT NOT NULL,' +
    'accuracy_m REAL NOT NULL, distance_m REAL NOT NULL, accepted_at TEXT NOT NULL,' +
    'UNIQUE(company_id, client_request_id));' +
    'CREATE INDEX IF NOT EXISTS idx_mobile_evidence_company_time ON mobile_attendance_evidence(company_id, accepted_at);'
  );

  app.use('/mobile', express.static(publicDir, {
    index: 'index.html',
    fallthrough: true,
    setHeaders(response, filePath) {
      if (filePath.endsWith('index.html') || filePath.endsWith('app.js') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
        response.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));

  function requireWorker(req, res, next) {
    if (req.user.role !== 'worker' || !req.user.employeeId) {
      return next(appError(403, 'ASISTIA Móvil requiere una cuenta de trabajador vinculada a un empleado.'));
    }
    next();
  }
  function getWorkerContext(req) {
    const employee = db.prepare(
      'SELECT id, company_id, employee_number, full_name, branch, active FROM employees WHERE id=? AND company_id=?'
    ).get(req.user.employeeId, req.user.companyId);
    if (!employee || !employee.active) throw appError(403, 'El expediente del empleado está inactivo o no existe.');
    const site = db.prepare(
      'SELECT * FROM mobile_sites WHERE company_id=? AND branch=? AND active=1'
    ).get(req.user.companyId, employee.branch);
    if (!site) throw appError(409, 'ASISTIA Móvil todavía no está configurado para la sucursal ' + employee.branch + '.');
    let allowedCidrs;
    try { allowedCidrs = JSON.parse(site.allowed_cidrs_json); }
    catch { throw appError(503, 'La configuración de red de ASISTIA Móvil está dañada.'); }
    if (!Array.isArray(allowedCidrs) || !allowedCidrs.length || !allowedCidrs.every(isValidIpv4Cidr)) {
      throw appError(503, 'La lista de redes permitidas no es válida.');
    }
    return { employee, site, allowedCidrs };
  }
  function requireLan(req, context) {
    if (!isAllowedLanRequest(req, context.allowedCidrs)) {
      throw appError(403, 'Conéctate al Wi-Fi autorizado de tu lugar de trabajo para registrar asistencia.');
    }
  }
  function requireSecureOrigin(req) {
    const localTestRequest = process.env.NODE_ENV === 'test'
      && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(req.socket?.remoteAddress || ''));
    if (!req.secure && !localTestRequest) {
      throw appError(426, 'La conexión móvil debe utilizar HTTPS para proteger la sesión y habilitar la ubicación GPS.');
    }
  }
  function getLastEvent(companyId, employeeId) {
    return db.prepare(
      'SELECT e.id,e.event_type,e.occurred_at,' +
      'COALESCE((SELECT aa.adjusted_time FROM attendance_adjustments aa WHERE aa.original_event_id=e.id ORDER BY aa.rowid DESC LIMIT 1),e.occurred_at) AS effective_time ' +
      'FROM attendance_events e WHERE e.company_id=? AND e.employee_id=? ' +
      'ORDER BY effective_time DESC,e.rowid DESC LIMIT 1'
    ).get(companyId, employeeId) || null;
  }

  app.get('/api/mobile/settings', authenticate, roles('admin'), (req, res, next) => {
    try {
      const branch = String(req.query.branch || 'Principal').trim();
      if (!branch || branch.length > 100) throw appError(400, 'Sucursal inválida.');
      const site = db.prepare('SELECT * FROM mobile_sites WHERE company_id=? AND branch=?').get(req.user.companyId, branch);
      if (!site) return res.json({ configured: false, branch });
      res.json({
        configured: true,
        settings: {
          id: site.id, branch: site.branch, latitude: site.latitude, longitude: site.longitude,
          radiusM: site.radius_m, maxAccuracyM: site.max_accuracy_m,
          allowedCidrs: JSON.parse(site.allowed_cidrs_json), active: Boolean(site.active), updatedAt: site.updated_at
        }
      });
    } catch (error) { next(error); }
  });

  app.put('/api/mobile/settings', authenticate, roles('admin'), (req, res, next) => {
    try {
      const input = settingsSchema.parse(req.body);
      const updatedAt = now();
      const existing = db.prepare('SELECT id FROM mobile_sites WHERE company_id=? AND branch=?')
        .get(req.user.companyId, input.branch);
      const id = existing?.id || randomUUID();
      db.prepare(
        'INSERT INTO mobile_sites (id,company_id,branch,latitude,longitude,radius_m,max_accuracy_m,allowed_cidrs_json,active,updated_at,updated_by) ' +
        'VALUES (?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(company_id,branch) DO UPDATE SET ' +
        'latitude=excluded.latitude, longitude=excluded.longitude, radius_m=excluded.radius_m, ' +
        'max_accuracy_m=excluded.max_accuracy_m, allowed_cidrs_json=excluded.allowed_cidrs_json, active=1, ' +
        'updated_at=excluded.updated_at, updated_by=excluded.updated_by'
      ).run(id, req.user.companyId, input.branch, input.latitude, input.longitude,
        input.radiusM, input.maxAccuracyM, JSON.stringify(input.allowedCidrs), updatedAt, req.user.id);
      writeAudit(req.user.companyId, req.user.id, 'mobile.site_configured', 'mobile_site', id, {
        branch: input.branch, radiusM: input.radiusM, maxAccuracyM: input.maxAccuracyM
      });
      res.status(200).json({ ok: true, settings: { ...input, id, active: true, updatedAt } });
    } catch (error) { next(error); }
  });

  app.get('/api/mobile/me', authenticate, requireWorker, (req, res, next) => {
    try {
      const context = getWorkerContext(req);
      requireLan(req, context);
      res.json({
        employee: {
          id: context.employee.id,
          employeeNumber: context.employee.employee_number,
          fullName: context.employee.full_name,
          branch: context.employee.branch
        },
        policy: { radiusM: context.site.radius_m, maxAccuracyM: context.site.max_accuracy_m, wifiRequired: true, gpsRequired: true }
      });
    } catch (error) { next(error); }
  });

  app.get('/api/mobile/status', authenticate, requireWorker, (req, res, next) => {
    try {
      const context = getWorkerContext(req);
      requireLan(req, context);
      const last = getLastEvent(req.user.companyId, context.employee.id);
      res.json({
        lastEvent: last ? { id: last.id, eventType: last.event_type, occurredAt: last.effective_time } : null,
        nextEventType: !last || last.event_type === 'clock_out' ? 'clock_in' : 'clock_out'
      });
    } catch (error) { next(error); }
  });

  app.post('/api/mobile/attendance', authenticate, requireWorker, (req, res, next) => {
    try {
      requireSecureOrigin(req);
      const input = attendanceSchema.parse(req.body);
      const context = getWorkerContext(req);
      requireLan(req, context);
      const existing = db.prepare(
        'SELECT attendance_event_id FROM mobile_attendance_evidence WHERE company_id=? AND client_request_id=?'
      ).get(req.user.companyId, input.clientRequestId);
      if (existing) throw appError(409, 'Este intento ya fue procesado. Actualiza el estado de tu jornada.');
      if (input.accuracyM > context.site.max_accuracy_m) {
        throw appError(422, 'La ubicación no tiene suficiente precisión. Intenta al aire libre o activa la ubicación precisa.');
      }
      const distanceM = distanceMeters(input.latitude, input.longitude, context.site.latitude, context.site.longitude);
      if (distanceM > context.site.radius_m) {
        throw appError(403, 'Estás fuera del área autorizada de la sucursal. No se registró tu asistencia.');
      }
      const last = getLastEvent(req.user.companyId, context.employee.id);
      if (!last && input.eventType === 'clock_out') throw appError(409, 'No existe una entrada pendiente de salida.');
      if (last?.event_type === input.eventType) {
        throw appError(409, input.eventType === 'clock_in'
          ? 'Ya existe una entrada sin salida.'
          : 'No existe una entrada pendiente de salida.');
      }
      const acceptedAt = now();
      const result = db.transaction(() => {
        const event = writeEvent({
          companyId: req.user.companyId, employeeId: context.employee.id, eventType: input.eventType,
          occurredAt: acceptedAt, source: 'mobile', createdBy: req.user.id
        });
        db.prepare(
          'INSERT INTO mobile_attendance_evidence (id,company_id,attendance_event_id,site_id,client_request_id,accuracy_m,distance_m,accepted_at) ' +
          'VALUES (?,?,?,?,?,?,?,?)'
        ).run(randomUUID(), req.user.companyId, event.id, context.site.id,
          input.clientRequestId, input.accuracyM, Math.round(distanceM * 10) / 10, acceptedAt);
        writeAudit(req.user.companyId, req.user.id, 'attendance.mobile_event_created', 'attendance_event', event.id, {
          eventType: input.eventType, branch: context.employee.branch,
          accuracyM: input.accuracyM, distanceM: Math.round(distanceM * 10) / 10
        });
        return event;
      })();
      res.status(201).json({
        ok: true, event: result,
        validation: {
          wifi: 'accepted', gps: 'accepted', distanceM: Math.round(distanceM * 10) / 10,
          radiusM: context.site.radius_m, accuracyM: input.accuracyM
        }
      });
    } catch (error) { next(error); }
  });

  app.get('/api/mobile/recent', authenticate, roles('admin'), (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
      const rows = db.prepare(
        'SELECT e.id,e.employee_id AS employeeId,p.employee_number AS employeeNumber,p.full_name AS fullName,' +
        'p.branch,e.event_type AS eventType,e.occurred_at AS occurredAt,e.source,' +
        'm.accuracy_m AS accuracyM,m.distance_m AS distanceM,m.accepted_at AS validatedAt ' +
        'FROM attendance_events e JOIN employees p ON p.id=e.employee_id ' +
        'JOIN mobile_attendance_evidence m ON m.attendance_event_id=e.id ' +
        'WHERE e.company_id=? ORDER BY e.occurred_at DESC LIMIT ?'
      ).all(req.user.companyId, limit);
      res.json({ records: rows });
    } catch (error) { next(error); }
  });
}
