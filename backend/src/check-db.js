import 'dotenv/config';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
const path=resolve(process.env.DATABASE_PATH||'./data/asistia.sqlite');
const db=new Database(path,{readonly:true,fileMustExist:true});
try {
  const integrity=db.pragma('integrity_check');
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(x=>x.name);
  console.log(JSON.stringify({database:path,integrity,tables},null,2));
  if (integrity.some(x=>x.integrity_check!=='ok')) process.exitCode=1;
} finally { db.close(); }
