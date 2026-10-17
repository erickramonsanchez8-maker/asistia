import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
});

test('eventos de asistencia respetan la secuencia entrada/salida y conservan el original',async()=>{
  const employeeResponse=await request('/api/employees',{token:adminToken,method:'POST',body:{
    employeeNumber:'QA-001',fullName:'Empleado de prueba',branch:'Principal'
  }});
  assert.equal(employeeResponse.status,201,JSON.stringify(employeeResponse.data));
  const employeeId=employeeResponse.data.employee.id;
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
    eventId:otherEntry.data.event.id,reason:'Verificar registro capturado por error',proposedTime:'2026-10-17T08:00:00-06:00'
  }});
  assert.equal(correction.status,201,JSON.stringify(correction.data));
  const selfReview=await request('/api/attendance/corrections/'+correction.data.correction.id+'/review',{
    token:adminToken,method:'POST',body:{decision:'approved'}
  });
  assert.equal(selfReview.status,403);

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
});
