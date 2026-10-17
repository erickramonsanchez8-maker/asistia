import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir=fileURLToPath(new URL('..',import.meta.url));
let child, baseUrl, tempDir, adminToken;

async function freePort() {
  const server=createServer();
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function request(path, {token,method='GET',body}={}) {
  const response=await fetch(baseUrl+path,{
    method,
    headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  const contentType=response.headers.get('content-type')||'';
  const data=contentType.includes('application/json')?await response.json():await response.text();
  return {status:response.status,data};
}

before(async () => {
  tempDir=await mkdtemp(join(tmpdir(),'asistia-api-test-'));
  const port=await freePort();
  baseUrl='http://127.0.0.1:'+port;
  child=spawn(process.execPath,['src/server.js'],{
    cwd:backendDir,
    env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),
      DATABASE_PATH:join(tempDir,'test.sqlite'),JWT_SECRET:'test-secret-which-is-at-least-32-characters-long',
      BOOTSTRAP_COMPANY_NAME:'Empresa de prueba',BOOTSTRAP_ADMIN_NAME:'Admin prueba',
      BOOTSTRAP_ADMIN_EMAIL:'admin@test.example',BOOTSTRAP_ADMIN_PASSWORD:'Password-seguro-12345',
      CORS_ORIGIN:baseUrl},
    stdio:['ignore','pipe','pipe']
  });
  let logs='';
  child.stdout.on('data',d=>logs+=d.toString());
  child.stderr.on('data',d=>logs+=d.toString());
  const deadline=Date.now()+12000;
  while(Date.now()<deadline) {
    if(child.exitCode!==null) throw new Error('API terminó antes de iniciar: '+logs);
    try {
      const r=await fetch(baseUrl+'/api/health');
      if(r.ok) break;
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  const health=await fetch(baseUrl+'/api/health').catch(()=>null);
  assert.ok(health?.ok,'La API no inició correctamente.');
  const login=await request('/api/auth/login',{method:'POST',body:{email:'admin@test.example',password:'Password-seguro-12345'}});
  assert.equal(login.status,200,JSON.stringify(login.data));
  adminToken=login.data.token;
});

after(async () => {
  if(child && child.exitCode===null) {
    child.kill('SIGTERM');
    await new Promise(resolve=>child.once('exit',resolve));
  }
  if(tempDir) await rm(tempDir,{recursive:true,force:true});
});

test('health check y autenticación',async()=>{
  const health=await request('/api/health');
  assert.equal(health.status,200);
  assert.equal(health.data.version,'0.2.0');
  assert.equal((await request('/api/me',{token:adminToken})).status,200);
  assert.equal((await request('/api/me')).status,401);
  const badPage=await request('/api/employees?limit=999',{token:adminToken});
  assert.equal(badPage.status,400);
  const tooWide=await request('/api/attendance/events?from=2024-01-01T00:00:00Z&to=2026-10-17T00:00:00Z',{token:adminToken});
  assert.equal(tooWide.status,400);
});

test('eventos de asistencia respetan la secuencia entrada/salida y conservan el original',async()=>{
  const employeeResponse=await request('/api/employees',{token:adminToken,method:'POST',body:{
    employeeNumber:'QA-001',fullName:'Empleado de prueba',rfc:'sall061201abc',branch:'Principal'
  }});
  assert.equal(employeeResponse.status,201,JSON.stringify(employeeResponse.data));
  assert.equal(employeeResponse.data.employee.rfc,'SALL061201ABC');
  const employeeId=employeeResponse.data.employee.id;
  const employeeList=await request('/api/employees',{token:adminToken});
  assert.equal(employeeList.data.employees.find(e=>e.id===employeeId).rfc,'SALL061201ABC');
  const firstPage=await request('/api/employees?limit=1&offset=0',{token:adminToken});
  assert.equal(firstPage.status,200);
  assert.equal(firstPage.data.employees.length,1);
  assert.equal(firstPage.data.pagination.total,1);
  const invalidRfc=await request('/api/employees',{token:adminToken,method:'POST',body:{employeeNumber:'QA-RFC-BAD',fullName:'RFC inválido',rfc:'ABC123',branch:'Principal'}});
  assert.equal(invalidRfc.status,400);
  const invalidExit=await request('/api/attendance/events',{token:adminToken,method:'POST',body:{employeeId,eventType:'clock_out'}});
  assert.equal(invalidExit.status,409);
  const entry=await request('/api/attendance/events',{token:adminToken,method:'POST',body:{employeeId,eventType:'clock_in'}});
  assert.equal(entry.status,201,JSON.stringify(entry.data));
  const duplicate=await request('/api/attendance/events',{token:adminToken,method:'POST',body:{employeeId,eventType:'clock_in'}});
  assert.equal(duplicate.status,409);
  const exit=await request('/api/attendance/events',{token:adminToken,method:'POST',body:{employeeId,eventType:'clock_out'}});
  assert.equal(exit.status,201,JSON.stringify(exit.data));
  const events=await request('/api/attendance/events',{token:adminToken});
  assert.equal(events.data.events.length,2);
  assert.ok(events.data.events.every(e=>e.eventHash && e.receivedAt));
});

test('administrador puede crear cuenta de trabajador vinculada a empleado',async()=>{
  const employees=await request('/api/employees',{token:adminToken});
  const employee=employees.data.employees.find(e=>e.employeeNumber==='QA-001');
  assert.ok(employee);
  const created=await request('/api/users',{token:adminToken,method:'POST',body:{
    name:'Trabajador QA',email:'worker@test.example',password:'Otra-clave-segura-12345',
    role:'worker',employeeId:employee.id
  }});
  assert.equal(created.status,201,JSON.stringify(created.data));
  assert.equal(created.data.user.role,'worker');
  assert.equal(created.data.user.employeeId,employee.id);
  const duplicateEmail=await request('/api/users',{token:adminToken,method:'POST',body:{
    name:'Cuenta duplicada',email:'WORKER@test.example',password:'Clave-diferente-segura-12345',role:'admin'
  }});
  assert.equal(duplicateEmail.status,409);

  // Un trabajador no debe consultar el directorio ni eventos de sus compañeros.
  const secondEmployee=await request('/api/employees',{token:adminToken,method:'POST',body:{
    employeeNumber:'QA-002',fullName:'Segundo empleado',branch:'Sucursal 2'
  }});
  assert.equal(secondEmployee.status,201,JSON.stringify(secondEmployee.data));
  const otherId=secondEmployee.data.employee.id;
  const otherEntry=await request('/api/attendance/events',{token:adminToken,method:'POST',body:{
    employeeId:otherId,eventType:'clock_in'
  }});
  assert.equal(otherEntry.status,201,JSON.stringify(otherEntry.data));

  const workerLogin=await request('/api/auth/login',{method:'POST',body:{
    email:'worker@test.example',password:'Otra-clave-segura-12345'
  }});
  assert.equal(workerLogin.status,200,JSON.stringify(workerLogin.data));
  const workerToken=workerLogin.data.token;
  const workerEmployees=await request('/api/employees',{token:workerToken});
  assert.equal(workerEmployees.status,200);
  assert.equal(workerEmployees.data.employees.length,1);
  assert.equal(workerEmployees.data.employees[0].id,employee.id);
  assert.equal('email' in workerEmployees.data.employees[0],false);

  const workerEvents=await request('/api/attendance/events',{token:workerToken});
  assert.equal(workerEvents.status,200);
  assert.ok(workerEvents.data.events.length>0);
  assert.ok(workerEvents.data.events.every(event=>event.employeeId===employee.id));

  const future=await request('/api/attendance/events',{token:adminToken,method:'POST',body:{
    employeeId:otherId,eventType:'clock_out',occurredAt:'2030-01-01T12:00:00-06:00'
  }});
  assert.equal(future.status,400);

  const correction=await request('/api/attendance/corrections',{token:adminToken,method:'POST',body:{
    eventId:otherEntry.data.event.id,reason:'Verificar registro capturado por error',proposedTime:new Date(Date.now()-120000).toISOString()
  }});
  assert.equal(correction.status,201,JSON.stringify(correction.data));
  const selfReview=await request('/api/attendance/corrections/'+correction.data.correction.id+'/review',{
    token:adminToken,method:'POST',body:{decision:'approved'}
  });
  assert.equal(selfReview.status,403);

  // Una persona distinta revisa la solicitud; el original se conserva y se crea un ajuste enlazado.
  const supervisorCreated=await request('/api/users',{token:adminToken,method:'POST',body:{
    name:'Supervisor QA',email:'supervisor@test.example',password:'Supervisor-seguro-12345',role:'supervisor'
  }});
  assert.equal(supervisorCreated.status,201,JSON.stringify(supervisorCreated.data));
  const supervisorLogin=await request('/api/auth/login',{method:'POST',body:{
    email:'supervisor@test.example',password:'Supervisor-seguro-12345'
  }});
  assert.equal(supervisorLogin.status,200,JSON.stringify(supervisorLogin.data));
  const originalBefore=(await request('/api/attendance/events',{token:adminToken})).data.events.find(e=>e.id===otherEntry.data.event.id);
  const reviewed=await request('/api/attendance/corrections/'+correction.data.correction.id+'/review',{
    token:supervisorLogin.data.token,method:'POST',body:{decision:'approved'}
  });
  assert.equal(reviewed.status,200,JSON.stringify(reviewed.data));
  assert.equal(reviewed.data.status,'approved');
  assert.equal(reviewed.data.originalRecordPreserved,true);
  assert.equal(reviewed.data.adjustment.originalEventId,otherEntry.data.event.id);
  assert.ok(reviewed.data.adjustment.adjustmentHash);
  const originalAfter=(await request('/api/attendance/events',{token:adminToken})).data.events.find(e=>e.id===otherEntry.data.event.id);
  assert.equal(originalAfter.occurredAt,originalBefore.occurredAt);
  assert.equal(originalAfter.adjustedAt,reviewed.data.adjustment.adjustedTime);
  assert.equal(originalAfter.adjustmentHash,reviewed.data.adjustment.adjustmentHash);
  const listedCorrections=await request('/api/attendance/corrections?limit=1',{token:supervisorLogin.data.token});
  assert.equal(listedCorrections.status,200);
  assert.equal(listedCorrections.data.pagination.total,1);
  assert.equal(listedCorrections.data.corrections.find(c=>c.id===correction.data.correction.id).adjustmentId,reviewed.data.adjustment.id);
  const csv=await request('/api/reports/attendance.csv',{token:adminToken});
  assert.equal(csv.status,200);
  assert.match(csv.data,/fecha_ajustada/);
  assert.ok(csv.data.includes(reviewed.data.adjustment.adjustedTime));
  const agreement=await request('/api/agreements',{token:adminToken,method:'POST',body:{employeeId:employee.id,version:'1.0',statement:'Acepto el uso del registro electrónico de asistencia conforme al aviso entregado.',method:'paper_reference'}});
  assert.equal(agreement.status,201,JSON.stringify(agreement.data));
  const agreementList=await request('/api/agreements?limit=1',{token:supervisorLogin.data.token});
  assert.equal(agreementList.status,200);
  assert.equal(agreementList.data.agreements[0].id,agreement.data.agreement.id);
  const usersList=await request('/api/users?limit=2',{token:adminToken});
  assert.equal(usersList.status,200);
  assert.ok(usersList.data.pagination.total>=3);

  // Las horas con offset se guardan normalizadas a UTC.
  const thirdEmployee=await request('/api/employees',{token:adminToken,method:'POST',body:{
    employeeNumber:'QA-003',fullName:'Empleado con zona horaria',branch:'Principal'
  }});
  assert.equal(thirdEmployee.status,201,JSON.stringify(thirdEmployee.data));
  const instant=Date.now()-30_000;
  const offsetTime=new Date(instant-6*60*60*1000).toISOString().replace('Z','-06:00');
  const offsetEvent=await request('/api/attendance/events',{token:adminToken,method:'POST',body:{
    employeeId:thirdEmployee.data.employee.id,eventType:'clock_in',occurredAt:offsetTime
  }});
  assert.equal(offsetEvent.status,201,JSON.stringify(offsetEvent.data));
  assert.ok(offsetEvent.data.event.occurred_at.endsWith('Z'));

  const passwordChange=await request('/api/auth/change-password',{token:adminToken,method:'POST',body:{
    currentPassword:'Password-seguro-12345',newPassword:'Password-nuevo-seguro-67890'
  }});
  assert.equal(passwordChange.status,200,JSON.stringify(passwordChange.data));
  assert.equal((await request('/api/me',{token:adminToken})).status,401);
  const relogin=await request('/api/auth/login',{method:'POST',body:{
    email:'admin@test.example',password:'Password-nuevo-seguro-67890'
  }});
  assert.equal(relogin.status,200,JSON.stringify(relogin.data));
  adminToken=relogin.data.token;

  const deactivate=await request('/api/users/'+workerLogin.data.user.id+'/deactivate',{token:adminToken,method:'PATCH'});
  assert.equal(deactivate.status,200,JSON.stringify(deactivate.data));
  assert.equal((await request('/api/me',{token:workerToken})).status,401);
  const reset=await request('/api/users/'+supervisorLogin.data.user.id+'/reset-password',{token:adminToken,method:'POST',body:{newPassword:'Supervisor-restablecido-98765'}});
  assert.equal(reset.status,200,JSON.stringify(reset.data));
  assert.equal((await request('/api/me',{token:supervisorLogin.data.token})).status,401);
  const supervisorRelogin=await request('/api/auth/login',{method:'POST',body:{email:'supervisor@test.example',password:'Supervisor-restablecido-98765'}});
  assert.equal(supervisorRelogin.status,200);
});

test('el respaldo cifrado se puede restaurar y la base restaurada conserva integridad',()=>{
  const backupDir=join(tempDir,'backups');
  const env={...process.env,DATABASE_PATH:join(tempDir,'test.sqlite'),BACKUP_DIR:backupDir,BACKUP_ENCRYPTION_KEY:'ab'.repeat(32)};
  const created=spawnSync(process.execPath,['src/backup-db.js'],{cwd:backendDir,env,encoding:'utf8'});
  assert.equal(created.status,0,(created.stdout||'')+'\\n'+(created.stderr||''));
  const metadata=JSON.parse(created.stdout.trim());
  assert.equal(metadata.encrypted,true);
  const restored=join(tempDir,'restored.sqlite');
  const restore=spawnSync(process.execPath,['src/restore-db.js',metadata.backup,restored],{cwd:backendDir,env,encoding:'utf8'});
  assert.equal(restore.status,0,(restore.stdout||'')+'\\n'+(restore.stderr||''));
  const check=spawnSync(process.execPath,['src/check-db.js'],{cwd:backendDir,env:{...env,DATABASE_PATH:restored},encoding:'utf8'});
  assert.equal(check.status,0,(check.stdout||'')+'\\n'+(check.stderr||''));
});

test('el verificador de integridad valida eventos, ajustes aprobados y auditoría',()=>{
  const result=spawnSync(process.execPath,['src/verify-integrity.js'],{
    cwd:backendDir,
    env:{...process.env,DATABASE_PATH:join(tempDir,'test.sqlite'),JWT_SECRET:'test-secret-which-is-at-least-32-characters-long'},
    encoding:'utf8'
  });
  assert.equal(result.status,0,(result.stdout||'')+'\n'+(result.stderr||''));
  assert.match(result.stdout,/Integridad comprobada/);
});
