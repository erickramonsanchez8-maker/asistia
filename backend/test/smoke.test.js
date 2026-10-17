import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

test('UUIDs para entidades nuevas no se repiten', () => {
  const ids=new Set(Array.from({length:1000},()=>randomUUID()));
  assert.equal(ids.size,1000);
});

test('la huella cambia cuando cambia el contenido del evento', () => {
  const base={id:'evt-1',employeeId:'emp-1',eventType:'clock_in',occurredAt:'2026-10-15T08:00:00.000Z'};
  const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.notEqual(hash(base),hash({...base,occurredAt:'2026-10-15T08:01:00.000Z'}));
});
