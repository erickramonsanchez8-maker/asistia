import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';

const htmlPath=fileURLToPath(new URL('../../ASISTIA_Control_de_Asistencia.html',import.meta.url));
const html=await readFile(htmlPath,'utf8');

test('la interfaz ASISTIA conserva JavaScript sintácticamente válido',()=>{
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(s=>s.trim());
  assert.ok(scripts.length>0,'No se encontró JavaScript en la interfaz.');
  scripts.forEach((source,index)=>new Script(source,{filename:`ASISTIA_Control_de_Asistencia.html#script-${index+1}`}));
});

test('el módulo de cumplimiento permite generar copia de acuerdo individual',()=>{
  assert.match(html,/function buildAgreementText\(a\)/);
  assert.match(html,/function downloadAgreementCopy\(a\)/);
  assert.match(html,/data-agreement-download/);
  assert.match(html,/artículo 132, fracción XXXIV/);
  assert.match(html,/Contacto de privacidad \/ derechos ARCO/);
});
