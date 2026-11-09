import {randomUUID,createHash} from 'node:crypto';
import {localDate,validDate} from './model.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const monthOK=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
const amountOK=value=>Number.isSafeInteger(value)&&value>=0&&value<=999999999999;
const currencies=new Set(['UZS','RUB','USD','EUR','KZT']);
const roleOK=value=>typeof value==='string'&&value.trim().length>0&&value.length<=60;

// Dated records explain approved changes. They never prorate wages, create
// earnings or edit an old monthly payroll account. The existing payroll path
// remains responsible for financial approval and the actual account mutation.
export function initCompensationHistory(db,{fail,transaction=fn=>fn(),tz='Asia/Tashkent',clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS compensation_history_events(
 id TEXT PRIMARY KEY,employee TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('role','base')),
 effective_date TEXT NOT NULL,month TEXT NOT NULL DEFAULT '',json TEXT NOT NULL,reason TEXT NOT NULL,
 actor TEXT NOT NULL,created INTEGER NOT NULL,applied INTEGER,baseline INTEGER NOT NULL DEFAULT 0,
 source TEXT UNIQUE);
 CREATE INDEX IF NOT EXISTS compensation_history_period ON compensation_history_events(employee,kind,effective_date,created);
 CREATE TABLE IF NOT EXISTS compensation_history_audit(id INTEGER PRIMARY KEY,employee TEXT NOT NULL,
 event TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);`);
 const today=()=>localDate(clock(),tz).date;
 const has=table=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
 const person=id=>{if(typeof id!=='string')fail('Сотрудник не найден',404);const e=db.prepare('SELECT id,name,role,active FROM employees WHERE id=?').get(id);if(!e)fail('Сотрудник не найден',404);return e;};
 const actorId=actor=>String(actor?.id||'owner');
 const canRead=actor=>!!(actor?.admin||['read','write'].includes(actor?.permissions?.payroll));
 const canRole=actor=>!!(actor?.admin||actor?.permissions?.staff==='write');
 const canBase=actor=>!!(actor?.admin||actor?.permissions?.payroll==='write');
 const rows=employee=>db.prepare('SELECT * FROM compensation_history_events WHERE employee=? ORDER BY effective_date DESC,created DESC,rowid DESC').all(employee);
 const version=employee=>digest(rows(employee).map(({id,kind,effective_date,month,json,reason,actor,created,applied,baseline})=>({id,kind,effective_date,month,json,reason,actor,created,applied,baseline})));
 const checkVersion=(employee,value)=>{if(value!==undefined&&value!==version(employee))fail('История изменилась. Обновите карточку сотрудника',409);};
 const date=value=>{if(typeof value!=='string'||!validDate(value)||value<'2000-01-01'||value>'2100-12-31')fail('Укажите корректную дату начала действия');return value;};
 const reason=(body,defaultValue)=>{const v=body.reason===undefined?'':body.reason;if(typeof v!=='string'||v.length>1000)fail('Укажите основание изменения (до 1000 символов)');const text=v.trim();if(!text&&body.effectiveDate&&body.effectiveDate<today())fail('Для изменения задним числом укажите основание');return text||defaultValue;};
 function audit(employee,event,actor,action,value){db.prepare('INSERT INTO compensation_history_audit(employee,event,actor,action,json,at) VALUES(?,?,?,?,?,?)').run(employee,event,actorId(actor),action,JSON.stringify(value),clock());}
 function insert({employee,kind,effectiveDate,month='',value,reason,actor,baseline=false,source=null,applied=null}){
  const id=randomUUID();db.prepare('INSERT INTO compensation_history_events(id,employee,kind,effective_date,month,json,reason,actor,created,applied,baseline,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,employee,kind,effectiveDate,month,JSON.stringify(value),reason,actorId(actor),clock(),applied,baseline?1:0,source);return id;
 }
 function baselineRole(employee){
  const e=person(employee),source='baseline:role:'+employee;if(db.prepare('SELECT id FROM compensation_history_events WHERE source=?').get(source))return 0;
  insert({employee,kind:'role',effectiveDate:today(),value:{role:e.role},reason:'Должность на дату введения истории. Более ранняя дата назначения не установлена.',actor:{id:'system:compensation-history'},baseline:true,source,applied:clock()});return 1;
 }
 function bootstrap(){
  return transaction(()=>{let roles=0,bases=0;for(const e of db.prepare('SELECT id FROM employees ORDER BY id').all())roles+=baselineRole(e.id);
   if(has('pay_accounts'))for(const a of db.prepare('SELECT employee,month,base,currency FROM pay_accounts ORDER BY employee,month').all()){
    if(!monthOK(a.month)||!amountOK(a.base)||!currencies.has(a.currency))continue;
    const source='baseline:base:'+a.employee+':'+a.month;if(db.prepare('SELECT id FROM compensation_history_events WHERE source=?').get(source))continue;
    insert({employee:a.employee,kind:'base',effectiveDate:a.month+'-01',month:a.month,value:{base:a.base,currency:a.currency},reason:'Сохранённая месячная база до введения истории. Даты прежних изменений внутри месяца не установлены.',actor:{id:'system:compensation-history'},baseline:true,source,applied:clock()});bases++;
   }return {ok:true,roles,bases,asOf:today()};});
 }
 function resolvedRow(employee,kind,day){
  person(employee);date(day);
  if(kind==='base')return db.prepare('SELECT * FROM compensation_history_events WHERE employee=? AND kind=? AND effective_date<=? ORDER BY effective_date DESC,baseline ASC,created DESC,rowid DESC LIMIT 1').get(employee,kind,day)||null;
  // An explicit dated decision supersedes an observation-only baseline. A role
  // baseline is never stretched backwards into a date we cannot substantiate.
  const exact=db.prepare('SELECT * FROM compensation_history_events WHERE employee=? AND kind=? AND baseline=0 AND effective_date<=? ORDER BY effective_date DESC,created DESC,rowid DESC LIMIT 1').get(employee,kind,day);
  if(exact)return exact;
  const baseline=db.prepare('SELECT * FROM compensation_history_events WHERE employee=? AND kind=? AND baseline=1 AND effective_date<=? ORDER BY effective_date DESC,created DESC,rowid DESC LIMIT 1').get(employee,kind,day);
  return baseline||null;
 }
 function resolve(employee,kind,day){const row=resolvedRow(employee,kind,day);return row?JSON.parse(row.json):null;}
 function roleAt(employee,day,fallbackRole=null){return resolve(employee,'role',day)?.role??fallbackRole;}
 function baseAt(employee,day,fallbackBase=null){return resolve(employee,'base',day)?.base??fallbackBase;}
 function applyPerson(employee,actor){
  const e=person(employee),target=db.prepare('SELECT * FROM compensation_history_events WHERE employee=? AND kind=\'role\' AND baseline=0 AND effective_date<=? ORDER BY effective_date DESC,created DESC,rowid DESC LIMIT 1').get(employee,today());
  if(!e.active)return {applied:0,changed:false,blocked:true};
  const due=db.prepare('SELECT id FROM compensation_history_events WHERE employee=? AND kind=\'role\' AND baseline=0 AND effective_date<=? AND applied IS NULL').all(employee,today());
  if(!target||!due.length)return {applied:0,changed:false};
  const value=JSON.parse(target.json);if(!roleOK(value.role))fail('Проверьте должность в отложенном изменении',409);
  const changed=e.role!==value.role;if(changed)db.prepare('UPDATE employees SET role=? WHERE id=?').run(value.role,employee);
  db.prepare('UPDATE compensation_history_events SET applied=? WHERE employee=? AND kind=\'role\' AND baseline=0 AND effective_date<=? AND applied IS NULL').run(clock(),employee,today());
  audit(employee,target.id,actor,'apply-role',{before:e.role,after:value.role,effectiveDate:target.effective_date,processed:due.length});return {applied:due.length,changed};
 }
 function applyDue(){return transaction(()=>{const people=db.prepare('SELECT DISTINCT employee FROM compensation_history_events WHERE kind=\'role\' AND baseline=0 AND effective_date<=? AND applied IS NULL ORDER BY employee').all(today());let applied=0,changed=0;for(const e of people){const result=applyPerson(e.employee,{id:'system:compensation-history'});applied+=result.applied;changed+=Number(result.changed);}return {ok:true,applied,changed,asOf:today()};});}
 function view(employee,actor){
  if(!canRead(actor))fail('Нет доступа к истории оплаты',403);const e=person(employee),day=today();
  const active={role:resolvedRow(employee,'role',day)?.id,base:resolvedRow(employee,'base',day)?.id};
  const events=rows(employee).map(r=>{const value=JSON.parse(r.json);return {id:r.id,kind:r.kind,effectiveDate:r.effective_date,month:r.month||null,...value,reason:r.reason,actor:r.actor,created:r.created,applied:r.applied!==null,baseline:!!r.baseline,status:r.effective_date>day?'scheduled':active[r.kind]===r.id?'active':'historical'};});
  return {employee:{...e,active:!!e.active},asOf:day,version:version(employee),events,rows:events};
 }
 function response(employee,actor,id,scheduled,duplicate=false){
  const summary={ok:true,id,scheduled,version:version(employee),...(duplicate?{duplicate:true}:{})};return canRead(actor)?{...summary,...view(employee,actor)}:summary;
 }
 function requestSource(kind,employee,body){if(body.requestId===undefined)return null;if(typeof body.requestId!=='string'||!body.requestId.trim()||body.requestId.length>64)fail('Проверьте код изменения');return kind+':'+employee+':'+body.requestId;}
 function duplicate(source,kind,employee,effectiveDate,month,value,note){
  const old=source?db.prepare('SELECT * FROM compensation_history_events WHERE source=?').get(source):db.prepare('SELECT * FROM compensation_history_events WHERE employee=? AND kind=? AND baseline=0 ORDER BY created DESC,rowid DESC LIMIT 1').get(employee,kind);
  if(!old)return null;
  if(old.employee===employee&&old.kind===kind&&old.effective_date===effectiveDate&&old.month===month&&old.json===JSON.stringify(value)&&old.reason===note)return old;
  if(source)fail('Этот код изменения уже использован для другого решения',409);return null;
 }
 function recordRole(body,actor){
  if(!canRole(actor))fail('Нет права изменять должности',403);const e=person(body?.employee);if(!e.active)fail('Сотрудник архивирован',409);
  if(!roleOK(body.role))fail('Укажите должность до 60 символов');
  const effectiveDate=date(body.effectiveDate||today()),role=body.role.trim(),note=reason({...body,effectiveDate},'Изменение должности'),source=requestSource('role',e.id,body),value={role};
  return transaction(()=>{if(source){const replay=duplicate(source,'role',e.id,effectiveDate,'',value,note);if(replay)return response(e.id,actor,replay.id,effectiveDate>today(),true);}checkVersion(e.id,body.version);baselineRole(e.id);const old=source?null:duplicate(null,'role',e.id,effectiveDate,'',value,note);if(old)return response(e.id,actor,old.id,effectiveDate>today(),true);
   const id=insert({employee:e.id,kind:'role',effectiveDate,value,reason:note,actor,source});audit(e.id,id,actor,'record-role',{role,effectiveDate,reason:note});if(effectiveDate<=today())applyPerson(e.id,actor);return response(e.id,actor,id,effectiveDate>today());});
 }
 function recordBase(body,actor){
  if(!canBase(actor))fail('Нет права записывать историю оплаты',403);const e=person(body?.employee);if(!monthOK(body.month)||!amountOK(body.base)||!currencies.has(body.currency))fail('Проверьте месяц, базу и валюту оплаты');
  const effectiveDate=date(body.effectiveDate||body.month+'-01');if(!effectiveDate.startsWith(body.month+'-'))fail('Дата ставки должна относиться к выбранному расчётному месяцу');
  const note=reason({...body,effectiveDate},'Изменение месячной базы оплаты'),source=requestSource('base',e.id,body),value={base:body.base,currency:body.currency};
  return transaction(()=>{if(has('pay_accounts')){const a=db.prepare('SELECT base,currency FROM pay_accounts WHERE employee=? AND month=?').get(e.id,body.month);if(!a||a.base!==body.base||a.currency!==body.currency)fail('История должна соответствовать подтверждённой базе месячного расчёта',409);}if(source){const replay=duplicate(source,'base',e.id,effectiveDate,body.month,value,note);if(replay)return response(e.id,actor,replay.id,effectiveDate>today(),true);}checkVersion(e.id,body.version);const old=source?null:duplicate(null,'base',e.id,effectiveDate,body.month,value,note);if(old)return response(e.id,actor,old.id,effectiveDate>today(),true);
   const id=insert({employee:e.id,kind:'base',effectiveDate,month:body.month,value,reason:note,actor,source,applied:clock()});audit(e.id,id,actor,'record-base',{...value,month:body.month,effectiveDate,reason:note});return response(e.id,actor,id,effectiveDate>today());});
 }
 return {bootstrap,recordRole,recordBase,view,roleAt,baseAt,applyDue};
}
