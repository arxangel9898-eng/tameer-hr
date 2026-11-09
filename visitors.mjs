import {randomUUID} from 'node:crypto';
import {localDate,validDate} from './model.mjs';
export const ageGroups=['18–29','30–44','45–59','60–75','unknown'];
export function ageGroup(age){return typeof age!=='number'||!Number.isFinite(age)||age<18||age>75?'unknown':age<30?'18–29':age<45?'30–44':age<60?'45–59':'60–75'}
export function initVisitors(db,{tz,fail,transaction,clock=Date.now,workerConfigured=false}){
 db.exec(`CREATE TABLE IF NOT EXISTS visitor_settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS visitor_receipts(id TEXT PRIMARY KEY,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS visitor_counts(day TEXT NOT NULL,hour INTEGER NOT NULL,camera INTEGER NOT NULL,age_group TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(day,hour,camera,age_group));
 CREATE TABLE IF NOT EXISTS visitor_status(id INTEGER PRIMARY KEY CHECK(id=1),at INTEGER NOT NULL,state TEXT NOT NULL);`);
 db.prepare('INSERT OR IGNORE INTO visitor_settings VALUES(1,?)').run(JSON.stringify({enabled:false,camera:1,axis:'y',line:0.5,direction:'increasing',revision:randomUUID()}));
 const settings=()=>JSON.parse(db.prepare('SELECT json FROM visitor_settings WHERE id=1').get().json);
 function configure(b){
  if(typeof b.enabled!=='boolean'||!Number.isInteger(b.camera)||!['x','y'].includes(b.axis)||!['increasing','decreasing'].includes(b.direction)||typeof b.line!=='number'||b.line<0.1||b.line>0.9||!Number.isFinite(b.line))fail('Проверьте настройки камеры и линии входа');
  const camera=db.prepare('SELECT * FROM cameras WHERE id=?').get(b.camera);if(!camera)fail('Камера не найдена');
  if(b.enabled&&(!workerConfigured||!camera.host))fail('Сначала настройте ключ модуля аналитики и подключение камеры');
  db.prepare('UPDATE visitor_settings SET json=? WHERE id=1').run(JSON.stringify({enabled:b.enabled,camera:b.camera,axis:b.axis,line:b.line,direction:b.direction,revision:randomUUID()}));return {ok:true};
 }
 function config(){const s=settings();if(!s.enabled)return {enabled:false};const c=db.prepare('SELECT * FROM cameras WHERE id=?').get(s.camera);if(!c?.host)return {enabled:false};return {...s,rtsp:`rtsp://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/Streaming/Channels/${c.channel}01`}}
 function heartbeat(b){if(!['running','camera_error','model_error','idle'].includes(b.state))fail('Некорректный статус');db.prepare('INSERT INTO visitor_status VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,state=excluded.state').run(clock(),b.state);return {ok:true}}
 function ingest(b){
  const s=settings(),now=clock();if(!s.enabled||b.camera!==s.camera||b.revision!==s.revision)fail('Конфигурация изменена или аналитика выключена',409);
  if(typeof b.id!=='string'||! /^[a-f0-9-]{36}$/.test(b.id)||!Number.isSafeInteger(b.at)||b.at>now+60000||b.at<now-86400000||!ageGroups.includes(b.group))fail('Некорректное событие прохода');
  return transaction(()=>{if(db.prepare('SELECT id FROM visitor_receipts WHERE id=?').get(b.id))return {ok:true,duplicate:true};
   const day=localDate(b.at,tz).date,hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',hourCycle:'h23'}).format(b.at));
   db.prepare('INSERT INTO visitor_receipts VALUES(?,?)').run(b.id,now);
   db.prepare('INSERT INTO visitor_counts VALUES(?,?,?,?,1) ON CONFLICT(day,hour,camera,age_group) DO UPDATE SET n=n+1').run(day,hour,b.camera,b.group);
   db.prepare('DELETE FROM visitor_receipts WHERE created<?').run(now-2*86400000);return {ok:true};});
 }
 function report(from=localDate(clock(),tz).date,to=from){
  if(!validDate(from)||!validDate(to)||from>to||(Date.parse(to)-Date.parse(from))/86400000>365)fail('Выберите период до 366 дней');
  const rows=db.prepare('SELECT * FROM visitor_counts WHERE day>=? AND day<=? ORDER BY day,hour').all(from,to);
  const groups=ageGroups.map(group=>({group,n:rows.filter(r=>r.age_group===group).reduce((n,r)=>n+r.n,0)}));
  const total=groups.reduce((n,r)=>n+r.n,0),unknown=groups.at(-1).n,known=total-unknown,max=Math.max(0,...groups.slice(0,4).map(g=>g.n));
  const days=[...new Set(rows.map(r=>r.day))].map(day=>({day,n:rows.filter(r=>r.day===day).reduce((n,r)=>n+r.n,0)}));
  return {from,to,timezone:tz,settings:settings(),workerConfigured,status:db.prepare('SELECT at,state FROM visitor_status WHERE id=1').get()||null,total,known,unknown,leaders:max?groups.filter(g=>g.group!=='unknown'&&g.n===max).map(g=>g.group):[],groups:groups.map(g=>({...g,percent:g.group==='unknown'?null:known?Math.round(g.n/known*1000)/10:0})),days,rows};
 }
 function csv(from,to){const r=report(from,to);return '\uFEFF'+[['Дата','Час ('+tz+')','Камера','Примерный возраст','Обнаруженные входы'],...r.rows.map(x=>[x.day,x.hour,x.camera,x.age_group==='unknown'?'Не оценён':x.age_group,x.n])].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(';')).join('\r\n')}
 return {configure,config,heartbeat,ingest,report,csv};
}
