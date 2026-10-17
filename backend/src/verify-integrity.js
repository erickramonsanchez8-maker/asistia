import 'dotenv/config';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const path=resolve(process.env.DATABASE_PATH || './data/asistia.sqlite');
const db=new Database(path,{readonly:true,fileMustExist:true});
let errors=0;
const fail=(kind,id,message)=>{errors++;console.error(`[${kind}] ${id}: ${message}`);};

try {
  const expectedEventPrev=new Map();
  for (const row of db.prepare('SELECT rowid,* FROM attendance_events ORDER BY rowid').iterate()) {
    const prev=expectedEventPrev.get(row.company_id) || null;
    if ((row.previous_hash || null)!==prev) fail('attendance_events',row.id,'previous_hash no coincide con el evento anterior.');
    const payload={id:row.id,companyId:row.company_id,employeeId:row.employee_id,eventType:row.event_type,occurredAt:row.occurred_at,receivedAt:row.received_at,source:row.source,createdBy:row.created_by,prev:row.previous_hash || null};
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (hash!==row.event_hash) fail('attendance_events',row.id,'event_hash no coincide con el contenido almacenado.');
    expectedEventPrev.set(row.company_id,row.event_hash);
  }

  const expectedAdjustmentPrev=new Map();
  for (const row of db.prepare('SELECT rowid,* FROM attendance_adjustments ORDER BY rowid').iterate()) {
    const prev=expectedAdjustmentPrev.get(row.company_id) || null;
    if ((row.previous_hash || null)!==prev) fail('attendance_adjustments',row.id,'previous_hash no coincide con el ajuste anterior.');
    const payload={id:row.id,companyId:row.company_id,correctionRequestId:row.correction_request_id,originalEventId:row.original_event_id,employeeId:row.employee_id,eventType:row.event_type,originalTime:row.original_time,adjustedTime:row.adjusted_time,reason:row.reason,approvedBy:row.approved_by,createdAt:row.created_at,prev:row.previous_hash || null};
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (hash!==row.adjustment_hash) fail('attendance_adjustments',row.id,'adjustment_hash no coincide con el contenido almacenado.');
    expectedAdjustmentPrev.set(row.company_id,row.adjustment_hash);
  }

  const expectedAuditPrev=new Map();
  for (const row of db.prepare('SELECT rowid,* FROM audit_log ORDER BY rowid').iterate()) {
    const prev=expectedAuditPrev.get(row.company_id) || null;
    if ((row.previous_hash || null)!==prev) fail('audit_log',row.id,'previous_hash no coincide con la entrada anterior.');
    let details;
    try { details=JSON.parse(row.details_json); }
    catch { fail('audit_log',row.id,'details_json no es JSON válido.'); continue; }
    const payload={id:row.id,companyId:row.company_id,actorId:row.actor_id,action:row.action,entityType:row.entity_type,entityId:row.entity_id,details,created:row.created_at,prev:row.previous_hash || null};
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (hash!==row.entry_hash) fail('audit_log',row.id,'entry_hash no coincide con el contenido almacenado.');
    expectedAuditPrev.set(row.company_id,row.entry_hash);
  }

  if (errors) {
    console.error(`Verificación terminada: ${errors} problema(s) detectado(s).`);
    process.exitCode=1;
  } else {
    console.log('Integridad comprobada: cadenas de eventos y auditoría consistentes.');
  }
} finally {
  db.close();
}
