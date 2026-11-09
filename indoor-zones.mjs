import {randomBytes,randomUUID,createHmac,timingSafeEqual,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

// Receives zone decisions from a commissioned RTLS adapter, not raw RSSI or GPS.
export function initIndoorZones(db,{dataDir,fail,transaction,clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS indoor_zone_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS indoor_zones(id TEXT PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS indoor_gateways(id TEXT PRIMARY KEY,name TEXT NOT NULL,secret TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,last_seen INTEGER);
 CREATE TABLE IF NOT EXISTS indoor_receivers(id TEXT PRIMARY KEY,gateway TEXT NOT NULL REFERENCES indoor_gateways(id),zone TEXT NOT NULL REFERENCES indoor_zones(id),active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS indoor_assignments(employee TEXT PRIMARY KEY REFERENCES employees(id),tag TEXT NOT NULL UNIQUE,zone TEXT NOT NULL REFERENCES indoor_zones(id),version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS indoor_positions(employee TEXT PRIMARY KEY REFERENCES employees(id),tag TEXT NOT NULL,zone TEXT NOT NULL,receiver TEXT NOT NULL,at INTEGER NOT NULL,since INTEGER NOT NULL,candidate TEXT NOT NULL,candidate_since INTEGER NOT NULL,candidate_count INTEGER NOT NULL,battery INTEGER);
 CREATE TABLE IF NOT EXISTS indoor_transitions(id TEXT PRIMARY KEY,employee TEXT NOT NULL REFERENCES employees(id),from_zone TEXT NOT NULL,to_zone TEXT NOT NULL,at INTEGER NOT NULL,gateway TEXT NOT NULL,receiver TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS indoor_transition_time ON indoor_transitions(at);
 CREATE TABLE IF NOT EXISTS indoor_receipts(gateway TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(gateway,id));
 CREATE TABLE IF NOT EXISTS indoor_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);`);
 db.prepare('INSERT OR IGNORE INTO indoor_zone_settings(id) VALUES(1)').run();
 const keyFile=join(dataDir,'indoor-zones.key');if(!existsSync(keyFile))writeFileSync(keyFile,randomBytes(32),{mode:0o600,flag:'wx'});
 const key=readFileSync(keyFile);if(key.length!==32)throw Error('Invalid indoor integration key');
 const seal=s=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(s),c.final(),c.getAuthTag()]).toString('base64')};
 const unseal=s=>{const b=Buffer.from(s,'base64'),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString()};
 const admin=a=>{if(!a?.admin)fail('Настройка зон доступна администратору',403)};
 const canView=a=>{if(!a?.admin&&!['read','write'].includes(a?.permissions?.zones))fail('Нет доступа к зонам сотрудников',403)};
 const id=v=>{if(typeof v!=='string'||!/^[-A-Za-z0-9_:]{1,80}$/.test(v))fail('ID: 1–80 латинских букв, цифр, _ : или -');return v};
 const name=v=>{if(typeof v!=='string'||v.trim().length<2||v.length>80)fail('Название: 2–80 символов');return v.trim()};
 const enabled=()=>!!db.prepare('SELECT enabled FROM indoor_zone_settings WHERE id=1').get().enabled;
 const audit=(a,action,b)=>db.prepare('INSERT INTO indoor_audit(actor,action,json,at) VALUES(?,?,?,?)').run(a.id,action,JSON.stringify(b),clock());
 const active=(t,i)=>!!db.prepare('SELECT id FROM '+t+' WHERE id=? AND active=1').get(i);
 function working(employee,at=clock()){
  return !!db.prepare("SELECT s.id FROM shifts s JOIN employees p ON p.id=s.employee WHERE s.employee=? AND p.active=1 AND s.planned_end+21600000>=? AND EXISTS(SELECT 1 FROM events e WHERE e.shift=s.id AND e.kind='in' AND e.at<=?) AND NOT EXISTS(SELECT 1 FROM events e WHERE e.shift=s.id AND e.kind='out' AND e.at<=?)").get(employee,at,at,at);
 }
 function handle(action,b,a){admin(a);return transaction(()=>{
  if(action==='settings'){if(typeof b.enabled!=='boolean')fail('Укажите режим');if(b.enabled&&b.commissioned!==true)fail('Подтвердите проверку оборудования и информирование сотрудников');if(b.enabled&&(!db.prepare('SELECT employee FROM indoor_assignments LIMIT 1').get()||!db.prepare('SELECT id FROM indoor_receivers WHERE active=1 LIMIT 1').get()))fail('Сначала настройте зоны, метки и приёмники');db.prepare('UPDATE indoor_zone_settings SET enabled=? WHERE id=1').run(+b.enabled);db.prepare('DELETE FROM indoor_positions').run();audit(a,action,{enabled:b.enabled});return {ok:true};}
  if(action==='zone'){const zid=b.id?id(b.id):randomUUID();if(typeof b.active!=='boolean')fail('Укажите статус зоны');db.prepare('INSERT INTO indoor_zones VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=excluded.active').run(zid,name(b.name),+b.active);audit(a,action,{id:zid,name:b.name,active:b.active});return {ok:true,id:zid};}
  if(action==='gateway'){const gid=randomUUID(),secret=randomBytes(32).toString('hex');db.prepare('INSERT INTO indoor_gateways(id,name,secret) VALUES(?,?,?)').run(gid,name(b.name),seal(secret));audit(a,action,{id:gid,name:b.name});return {ok:true,id:gid,secret};}
  if(action==='gateway-active'){if(typeof b.active!=='boolean'||!db.prepare('SELECT id FROM indoor_gateways WHERE id=?').get(id(b.id)))fail('Шлюз не найден');db.prepare('UPDATE indoor_gateways SET active=? WHERE id=?').run(+b.active,b.id);audit(a,action,{id:b.id,active:b.active});return {ok:true};}
  if(action==='receiver'){const rid=id(b.id);if(typeof b.active!=='boolean'||!active('indoor_zones',b.zone)||!active('indoor_gateways',b.gateway))fail('Выберите активные шлюз и зону');db.prepare('INSERT INTO indoor_receivers VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET gateway=excluded.gateway,zone=excluded.zone,active=excluded.active').run(rid,b.gateway,b.zone,+b.active);db.prepare('DELETE FROM indoor_positions WHERE receiver=?').run(rid);audit(a,action,{id:rid,gateway:b.gateway,zone:b.zone,active:b.active});return {ok:true};}
  if(action==='assignment'){if(!db.prepare('SELECT id FROM employees WHERE id=? AND active=1').get(b.employee)||!active('indoor_zones',b.zone))fail('Выберите активного сотрудника и зону');const tag=id(b.tag),old=db.prepare('SELECT * FROM indoor_assignments WHERE employee=?').get(b.employee);if((old?.version||0)!==b.version)fail('Назначение изменилось. Обновите страницу',409);const duplicate=db.prepare('SELECT employee FROM indoor_assignments WHERE tag=? AND employee<>?').get(tag,b.employee);if(duplicate)fail('Эта метка уже закреплена за другим сотрудником',409);db.prepare('INSERT INTO indoor_assignments VALUES(?,?,?,1) ON CONFLICT(employee) DO UPDATE SET tag=excluded.tag,zone=excluded.zone,version=version+1').run(b.employee,tag,b.zone);db.prepare('DELETE FROM indoor_positions WHERE employee=?').run(b.employee);audit(a,action,{employee:b.employee,tag,zone:b.zone});return {ok:true};}
  if(action==='unassign'){const old=db.prepare('SELECT * FROM indoor_assignments WHERE employee=?').get(b.employee);if(!old||old.version!==b.version)fail('Назначение изменилось',409);db.prepare('DELETE FROM indoor_assignments WHERE employee=?').run(b.employee);db.prepare('DELETE FROM indoor_positions WHERE employee=?').run(b.employee);audit(a,action,{employee:b.employee});return {ok:true};}
  fail('Действие не найдено',404);
 });}
 const limits=new Map();
 function ingest(raw,headers){
  if(typeof raw!=='string'||Buffer.byteLength(raw)>8192)fail('Запрос слишком большой',413);
  const gid=headers.gateway,ts=Number(headers.time),g=typeof gid==='string'?db.prepare('SELECT * FROM indoor_gateways WHERE id=? AND active=1').get(gid):null;
  if(!g||!Number.isSafeInteger(ts)||Math.abs(clock()-ts)>60000||typeof headers.signature!=='string'||! /^[a-f0-9]{64}$/.test(headers.signature))fail('Подпись шлюза недействительна',401);
  const wanted=createHmac('sha256',unseal(g.secret)).update(String(ts)+'\n'+raw).digest();if(!timingSafeEqual(wanted,Buffer.from(headers.signature,'hex')))fail('Подпись шлюза недействительна',401);
  const window=Math.floor(clock()/60000),limit=limits.get(gid);if(limit?.window===window&&limit.count>=300)fail('Слишком много событий',429);limits.set(gid,{window,count:limit?.window===window?limit.count+1:1});
  let b;try{b=JSON.parse(raw)}catch{fail('Некорректное событие')};if(!b||Array.isArray(b)||typeof b!=='object')fail('Некорректное событие');id(b.id);
  const hash=createHash('sha256').update(raw).digest('hex'),prior=db.prepare('SELECT hash FROM indoor_receipts WHERE gateway=? AND id=?').get(gid,b.id);if(prior){if(prior.hash!==hash)fail('ID события уже использован',409);return {ok:true,duplicate:true};}
  if(!['heartbeat','position'].includes(b.type)||!Number.isSafeInteger(b.at)||b.at>clock()+5000||clock()-b.at>60000)fail('Событие устарело или время некорректно');
  return transaction(()=>{
   db.prepare('INSERT INTO indoor_receipts VALUES(?,?,?,?)').run(gid,b.id,hash,clock());db.prepare('DELETE FROM indoor_receipts WHERE at<?').run(clock()-86400000);db.prepare('UPDATE indoor_gateways SET last_seen=? WHERE id=?').run(clock(),gid);
   if(b.type==='heartbeat')return {ok:true};if(!enabled())return {ok:true,ignored:'disabled'};
   const receiver=db.prepare('SELECT r.*,z.active AS zone_active FROM indoor_receivers r JOIN indoor_zones z ON z.id=r.zone WHERE r.id=? AND r.gateway=? AND r.active=1').get(id(b.receiver),gid),a=db.prepare('SELECT a.* FROM indoor_assignments a JOIN employees e ON e.id=a.employee WHERE a.tag=? AND e.active=1').get(id(b.tag));
   if(!receiver?.zone_active||!a||!active('indoor_zones',a.zone)||!working(a.employee,b.at)||!working(a.employee))return {ok:true,ignored:'unavailable'};
   if(b.battery!==undefined&&(!Number.isInteger(b.battery)||b.battery<0||b.battery>100))fail('Заряд: 0–100');
   const old=db.prepare('SELECT * FROM indoor_positions WHERE employee=?').get(a.employee);if(old&&b.at<=old.at)return {ok:true,ignored:'out-of-order'};
   const connected=old&&b.at-old.at<=120000,same=connected&&old.candidate===receiver.zone,candidateSince=same?old.candidate_since:b.at,count=same?old.candidate_count+1:1;
   let zone=connected?old.zone:'',since=connected?old.since:b.at;
   if(receiver.zone!==zone&&count>=2&&b.at-candidateSince>=15000){const previous=zone;zone=receiver.zone;since=b.at;db.prepare('INSERT INTO indoor_transitions VALUES(?,?,?,?,?,?,?)').run(randomUUID(),a.employee,previous,zone,b.at,gid,b.receiver);}
   db.prepare('INSERT INTO indoor_positions VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(employee) DO UPDATE SET tag=excluded.tag,zone=excluded.zone,receiver=excluded.receiver,at=excluded.at,since=excluded.since,candidate=excluded.candidate,candidate_since=excluded.candidate_since,candidate_count=excluded.candidate_count,battery=excluded.battery').run(a.employee,a.tag,zone,b.receiver,b.at,since,receiver.zone,candidateSince,count,b.battery??null);
   return {ok:true,confirmed:zone===receiver.zone};
  });
 }
 function view(a){canView(a);const zones=db.prepare('SELECT * FROM indoor_zones ORDER BY name').all(),gateways=db.prepare('SELECT id,name,active,last_seen FROM indoor_gateways ORDER BY name').all(),receivers=db.prepare('SELECT * FROM indoor_receivers ORDER BY id').all(),now=clock(),on=enabled();
  const staff=db.prepare('SELECT e.id,e.name,e.role,a.tag,a.zone AS assigned_zone,a.version FROM employees e LEFT JOIN indoor_assignments a ON a.employee=e.id WHERE e.active=1 ORDER BY e.name').all().map(e=>{const p=db.prepare('SELECT * FROM indoor_positions WHERE employee=?').get(e.id),r=p&&receivers.find(r=>r.id===p.receiver),g=r&&gateways.find(g=>g.id===r.gateway);let state=!on?'disabled':!e.tag?'unassigned':!working(e.id)?'off_shift':!p||now-p.at>120000||!r?.active||!g?.active||!zones.some(z=>z.id===p.zone&&z.active)?'unknown':p.zone!==p.candidate?'uncertain':p.zone===e.assigned_zone?'inside':'outside';return {...e,state,actual_zone:['inside','outside'].includes(state)?p.zone:null,last_seen:p?.at||null,battery:p?.battery??null,since:['inside','outside'].includes(state)?p.since:null,attention:state==='outside'&&now-p.since>=300000};});
  return {enabled:on,admin:!!a.admin,now,freshSeconds:120,dwellSeconds:15,attentionMinutes:5,zones,gateways,receivers,staff,history:db.prepare('SELECT t.*,e.name,z.name AS zone_name FROM indoor_transitions t JOIN employees e ON e.id=t.employee JOIN indoor_zones z ON z.id=t.to_zone ORDER BY t.at DESC LIMIT 100').all()};
 }
 return {handle,ingest,view};
}
