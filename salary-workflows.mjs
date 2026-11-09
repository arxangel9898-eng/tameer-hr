import {createHash,randomUUID} from 'node:crypto';
import {localDate} from './model.mjs';
import {monthOK} from './payroll.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const parsed=value=>{try{return JSON.parse(value)}catch{return null}};
const MAX=999999999999;

// Terms, questions and employee receipt acknowledgements are independent of
// accrual/payment entries. This module never changes an existing payroll table.
export function initSalaryWorkflows(db,{fail,transaction=fn=>fn(),payroll,termsBuilder=()=>null,tz='Asia/Tashkent',clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS salary_terms(id TEXT PRIMARY KEY,employee TEXT NOT NULL,month TEXT NOT NULL,version INTEGER NOT NULL,fingerprint TEXT NOT NULL,json TEXT NOT NULL,reason TEXT NOT NULL,published INTEGER NOT NULL,actor TEXT NOT NULL,UNIQUE(employee,month,version));
 CREATE TABLE IF NOT EXISTS salary_term_acks(employee TEXT NOT NULL,term TEXT NOT NULL,version INTEGER NOT NULL,fingerprint TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(employee,term));
 CREATE TABLE IF NOT EXISTS salary_disputes(id TEXT PRIMARY KEY,employee TEXT NOT NULL,month TEXT NOT NULL,request_id TEXT NOT NULL,reference_type TEXT NOT NULL,reference_id TEXT NOT NULL,reference_fingerprint TEXT NOT NULL,reference_json TEXT NOT NULL,question TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,decision TEXT NOT NULL DEFAULT '',decided INTEGER,decider TEXT,UNIQUE(employee,request_id));
 CREATE TABLE IF NOT EXISTS salary_receipt_acks(employee TEXT NOT NULL,entry TEXT NOT NULL,month TEXT NOT NULL,fingerprint TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(employee,entry));
 CREATE TABLE IF NOT EXISTS salary_workflow_audit(id INTEGER PRIMARY KEY,employee TEXT,month TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);`);

 const canRead=actor=>!!(actor?.admin||['read','write'].includes(actor?.permissions?.payroll)||['read','write'].includes(actor?.permissions?.finance));
 const canPublish=actor=>!!(actor?.admin||actor?.permissions?.payroll==='write');
 const canDecide=actor=>!!(actor?.admin||actor?.permissions?.payroll==='write'||actor?.permissions?.finance==='write');
 const period=month=>{if(!monthOK(month))fail('Выберите месяц в формате ГГГГ-ММ');return month};
 const text=(value,label,max=1000,min=1)=>{if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)fail(label);return value.trim()};
 const id=value=>text(value,'Укажите запись',120);
 const person=employee=>{if(typeof employee!=='string')fail('Сотрудник недоступен',404);const e=db.prepare('SELECT id,name,role,active FROM employees WHERE id=?').get(employee);if(!e)fail('Сотрудник недоступен',404);return e};
 const self=(actor,body={})=>{if(!actor?.employee)fail('Аккаунт не связан с сотрудником',403);if(body.employee!==undefined&&body.employee!==actor.employee)fail('Доступен только собственный расчёт',403);person(actor.employee);return actor.employee};
 const actorId=actor=>String(actor?.id||'owner');
 const audit=(employee,month,actor,action,details)=>db.prepare('INSERT INTO salary_workflow_audit(employee,month,actor,action,json,at) VALUES(?,?,?,?,?,?)').run(employee||null,month,actorId(actor),action,JSON.stringify(details),clock());
 const latest=(employee,month)=>db.prepare('SELECT * FROM salary_terms WHERE employee=? AND month=? ORDER BY version DESC LIMIT 1').get(employee,month)||null;

 function conditions(value){
  if(!plain(value)||value instanceof Promise)fail('Условия KPI пока не подготовлены');
  const amount=(value,label)=>{if(value===null||value===undefined)return null;if(!Number.isSafeInteger(value)||value<0||value>MAX)fail('Проверьте сумму в условиях: '+label);return value};
  const weight=value=>{if(value===null||value===undefined)return null;if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100)fail('Проверьте вес KPI');return value};
  const optional=(value,max=1500)=>value===undefined||value===null?'':text(value,'Проверьте текст условий',max,0);
  const list=value.metrics??[];if(!Array.isArray(list)||list.length>20)fail('Проверьте показатели KPI');
  const metrics=list.map(m=>{if(!plain(m))fail('Проверьте показатель KPI');let target=m.target??null;if(target!==null&&!(typeof target==='number'&&Number.isFinite(target)&&target>=0)&&!(typeof target==='string'&&target.length<=300))fail('Проверьте план KPI');return {label:text(m.label??m.name,'Укажите название показателя',160),target,weight:weight(m.weight),...(m.unit?{unit:optional(m.unit,60)}:{}),...(m.source?{source:optional(m.source,400)}:{})};});
  const currency=value.currency==null?null:String(value.currency).toUpperCase();if(currency!==null&&!/^[A-Z]{3}$/.test(currency))fail('Проверьте валюту условий');
  let team=null;if(value.team!==null&&value.team!==undefined){if(!plain(value.team))fail('Проверьте командную часть KPI');team={label:optional(value.team.label,160),minimum:amount(value.team.minimum,'минимум команды'),maximum:amount(value.team.maximum,'максимум команды'),weight:weight(value.team.weight)};}
  return {role:optional(value.role??value.roleName,160),currency,base:amount(value.base,'база'),minimum:amount(value.minimum,'минимум'),maximum:amount(value.maximum,'максимум'),metrics,team,personalWeight:weight(value.personalWeight),teamWeight:weight(value.teamWeight),formula:optional(value.formula,1500),note:optional(value.note,2000)};
 }
 function termDto(row,employee){
  const ack=db.prepare('SELECT * FROM salary_term_acks WHERE employee=? AND term=?').get(employee,row.id),valid=!!ack&&ack.version===row.version&&ack.fingerprint===row.fingerprint;
  return {id:row.id,month:row.month,version:row.version,fingerprint:row.fingerprint,sourceFingerprint:row.fingerprint,conditions:parsed(row.json),publishedAt:row.published,latePublication:localDate(row.published,tz).date>=row.month+'-01',reason:row.reason,acknowledged:valid,acknowledgedAt:valid?ack.at:null};
 }
 function paymentFingerprint(entry,currency){return hash({entryId:entry.id,month:entry.month,kind:entry.kind,amount:entry.amount,currency,date:entry.date,reason:entry.reason,source:entry.source||'',voidedAt:entry.voided_at??null,voidReason:entry.void_reason||null});}
 function receiptDtos(employee,month,statement){
  return (statement.entries||[]).filter(e=>['advance','payout'].includes(e.kind)).map(e=>{
   const currency=statement.account?.currency||e.currency||null,fingerprint=paymentFingerprint(e,currency),ack=db.prepare('SELECT * FROM salary_receipt_acks WHERE employee=? AND entry=?').get(employee,e.id),same=!!ack&&ack.fingerprint===fingerprint,voided=e.voided_at!==null&&e.voided_at!==undefined;
   return {entryId:e.id,month,kind:e.kind,amount:e.amount,currency,date:e.date,reason:e.reason,fingerprint,acknowledged:same&&!voided,acknowledgedAt:ack?.at||null,status:voided?'voided':ack&&!same?'source-changed':same?'acknowledged':'pending'};
  });
 }
 function reference(employee,month,type,referenceId){
  const s=payroll.statement(employee,month),currency=s.account?.currency||null;let record,label,amount=null,date=null;
  if(type==='entry'){const e=(s.entries||[]).find(e=>e.id===referenceId);if(!e)fail('Строка расчёта недоступна',404);record={id:e.id,month,kind:e.kind,amount:e.amount,date:e.date,reason:e.reason,voidedAt:e.voided_at??null,source:e.source||''};label=e.reason;amount=e.amount;date=e.date;}
  else if(type==='account'){if(referenceId!==month||!s.account)fail('База расчёта недоступна',404);record={month,base:s.account.base,currency,advanceDate:s.account.advance_date,salaryDate:s.account.salary_date};label='База оплаты за месяц';amount=s.account.base;}
  else if(type==='turnover'){const v=s.turnoverKpi||(s.latestTurnoverKpi?.month===month?s.latestTurnoverKpi:null);if(referenceId!==month||!v)fail('Проект командной премии недоступен',404);record={month,score:v.score,minimum:v.minimum,maximum:v.maximum,proposal:v.proposal,status:v.status,excluded:!!v.excluded,role:v.role,sourceAsOf:v.sourceAsOf};label='Проект командной премии';amount=v.proposal??null;}
  else if(type==='metric'){const m=(s.metrics||[]).find(m=>m.id===referenceId);if(!m)fail('Показатель KPI недоступен',404);record={id:m.id,month,name:m.name,target:m.target,actual:m.actual,maxBonus:m.max_bonus,calculated:m.calculated,posted:!!m.posted};label=m.name;amount=m.calculated;}
  else fail('Выберите строку расчёта');
  return {fingerprint:hash(record),summary:{label,amount,currency,date},record};
 }
 function disputeDto(row){return {id:row.id,month:row.month,referenceType:row.reference_type,referenceId:row.reference_id,reference:parsed(row.reference_json),question:row.question,status:row.status,version:row.version,created:row.created,updated:row.updated,decision:row.decision,decidedAt:row.decided||null};}
 function own(employee,month){
  person(employee);period(month);const s=payroll.statement(employee,month),terms=db.prepare('SELECT * FROM salary_terms WHERE employee=? AND month=? ORDER BY version DESC').all(employee,month).map(r=>termDto(r,employee));
  if(terms[0]){try{terms[0].sourceChanged=hash(conditions(termsBuilder(employee,month)))!==terms[0].fingerprint;terms[0].sourceAvailable=true;}catch{terms[0].sourceChanged=null;terms[0].sourceAvailable=false;}}
  return {month,terms:{current:terms[0]||null,versions:terms},disputes:db.prepare('SELECT * FROM salary_disputes WHERE employee=? AND month=? ORDER BY created DESC,id LIMIT 100').all(employee,month).map(disputeDto),receipts:receiptDtos(employee,month,s)};
 }
 function view(month,actor,employee=null){
  if(!canRead(actor))fail('Нет доступа к расчётам сотрудников',403);period(month);if(employee!==null)person(employee);
  const staff=employee===null?db.prepare('SELECT id,name,role,active FROM employees ORDER BY active DESC,name,id').all().filter(e=>e.active||db.prepare('SELECT id FROM salary_terms WHERE employee=? AND month=? LIMIT 1').get(e.id,month)||db.prepare('SELECT id FROM salary_disputes WHERE employee=? AND month=? LIMIT 1').get(e.id,month)): [person(employee)];
  const employees=staff.map(e=>({id:e.id,name:e.name,role:e.role,...own(e.id,month)}));
  return {month,employees,summary:{employees:employees.length,termsPublished:employees.filter(e=>e.terms.current).length,termsAcknowledged:employees.filter(e=>e.terms.current?.acknowledged).length,openDisputes:employees.reduce((n,e)=>n+e.disputes.filter(d=>['open','reviewing'].includes(d.status)).length,0),pendingReceipts:employees.reduce((n,e)=>n+e.receipts.filter(r=>['pending','source-changed'].includes(r.status)).length,0)},audit:db.prepare('SELECT action,at FROM salary_workflow_audit WHERE month=? AND (? IS NULL OR employee=?) ORDER BY id DESC LIMIT 50').all(month,employee,employee)};
 }
 function publish(body,actor){
  if(!canPublish(actor))fail('Нет права публикации условий KPI',403);const month=period(body.month),reason=text(body.reason,'Укажите основание публикации условий',1000,3);
  if(body.all===true&&body.employee!==undefined&&body.employee!==null&&body.employee!=='')fail('Выберите одного сотрудника или всех');
  const people=body.all===true?db.prepare('SELECT id FROM employees WHERE active=1 ORDER BY id').all():[{id:person(id(body.employee)).id}];
  if(!people.length)fail('Нет сотрудников для публикации');
  if(body.expectedVersion!==undefined&&(!Number.isInteger(body.expectedVersion)||body.expectedVersion<0))fail('Обновите версию условий',409);
  return transaction(()=>{
   const proposals=people.map(e=>{const old=latest(e.id,month),c=conditions(termsBuilder(e.id,month));if(body.expectedVersion!==undefined&&people.length===1&&body.expectedVersion!==(old?.version||0))fail('Условия изменились. Обновите страницу',409);return {employee:e.id,old,conditions:c,fingerprint:hash(c)};});
   const result=[];
   for(const p of proposals){const again=latest(p.employee,month);if((again?.id||null)!==(p.old?.id||null)||hash(conditions(termsBuilder(p.employee,month)))!==p.fingerprint)fail('Источники условий изменились. Повторите публикацию',409);if(p.old?.fingerprint===p.fingerprint){result.push({employee:p.employee,id:p.old.id,version:p.old.version,duplicate:true});continue;}
    const termId=randomUUID(),version=(p.old?.version||0)+1;db.prepare('INSERT INTO salary_terms VALUES(?,?,?,?,?,?,?,?,?)').run(termId,p.employee,month,version,p.fingerprint,JSON.stringify(p.conditions),reason,clock(),actorId(actor));audit(p.employee,month,actor,'terms-publish',{id:termId,version,previous:p.old?.id||null,fingerprint:p.fingerprint,reason});result.push({employee:p.employee,id:termId,version,duplicate:false});
   }
   return {ok:true,month,published:result.filter(r=>!r.duplicate).length,results:result};
  });
 }
 function handle(action,body,actor){
  if(!plain(body))fail('Проверьте данные действия');
  if(action==='terms-publish')return publish(body,actor);
  if(action==='dispute-decide'){
   if(!canDecide(actor))fail('Нет права рассмотрения вопросов по зарплате',403);const disputeId=id(body.id),reason=text(body.reason,'Укажите ответ сотруднику',2000,3);if(!['reviewing','resolved','rejected'].includes(body.status))fail('Выберите решение');
   return transaction(()=>{const r=db.prepare('SELECT * FROM salary_disputes WHERE id=?').get(disputeId);if(!r)fail('Обращение недоступно',404);if(body.month!==undefined&&body.month!==r.month)fail('Месяц обращения отличается',409);if(!Number.isInteger(body.version)||body.version!==r.version)fail('Обращение изменилось. Обновите страницу',409);if(['resolved','rejected'].includes(r.status))fail('Обращение уже рассмотрено',409);db.prepare('UPDATE salary_disputes SET status=?,version=version+1,updated=?,decision=?,decided=?,decider=? WHERE id=? AND version=?').run(body.status,clock(),reason,clock(),actorId(actor),r.id,r.version);audit(r.employee,r.month,actor,'dispute-'+body.status,{id:r.id,reason});return {ok:true,id:r.id,version:r.version+1,status:body.status};});
  }
  const employee=self(actor,body),month=period(body.month);
  if(action==='terms-ack')return transaction(()=>{
   const current=latest(employee,month);if(!current||body.id!==current.id||body.version!==current.version||body.fingerprint!==current.fingerprint)fail('Условия изменились. Откройте актуальную версию',409);if(body.confirmRead!==true)fail('Подтвердите ознакомление с условиями');const old=db.prepare('SELECT * FROM salary_term_acks WHERE employee=? AND term=?').get(employee,current.id);if(old?.fingerprint!==current.fingerprint){db.prepare('INSERT INTO salary_term_acks VALUES(?,?,?,?,?) ON CONFLICT(employee,term) DO UPDATE SET version=excluded.version,fingerprint=excluded.fingerprint,at=excluded.at').run(employee,current.id,current.version,current.fingerprint,clock());audit(employee,month,actor,'terms-ack',{id:current.id,version:current.version});}return {ok:true,...own(employee,month)};
  });
  if(action==='dispute-create'){
   const referenceType=body.referenceType,referenceId=id(body.referenceId),question=text(body.question,'Напишите вопрос по расчёту (до 2000 символов)',2000,3),requestId=text(body.requestId,'Обновите код обращения',100);if(!/^[A-Za-z0-9:_-]+$/.test(requestId))fail('Обновите код обращения');
   return transaction(()=>{const old=db.prepare('SELECT * FROM salary_disputes WHERE employee=? AND request_id=?').get(employee,requestId);if(old){if(old.month!==month||old.reference_type!==referenceType||old.reference_id!==referenceId||old.question!==question)fail('Код обращения уже использован с другими данными',409);return {ok:true,duplicate:true,...own(employee,month)};}const ref=reference(employee,month,referenceType,referenceId),disputeId=randomUUID();db.prepare("INSERT INTO salary_disputes(id,employee,month,request_id,reference_type,reference_id,reference_fingerprint,reference_json,question,status,version,created,updated) VALUES(?,?,?,?,?,?,?,?,?,'open',1,?,?)").run(disputeId,employee,month,requestId,referenceType,referenceId,ref.fingerprint,JSON.stringify(ref.summary),question,clock(),clock());audit(employee,month,actor,'dispute-create',{id:disputeId,referenceType,referenceId});return {ok:true,...own(employee,month)};});
  }
  if(action==='receipt-ack')return transaction(()=>{
   if(body.confirmReceived!==true)fail('Подтвердите фактическое получение денег');const entryId=id(body.entryId),s=payroll.statement(employee,month),entry=(s.entries||[]).find(e=>e.id===entryId);if(!entry||!['advance','payout'].includes(entry.kind)||!Number.isSafeInteger(entry.amount)||entry.amount<=0)fail('Выплата недоступна',404);if(entry.voided_at!==null&&entry.voided_at!==undefined)fail('Запись о выплате отменена. Нужна сверка',409);const currency=s.account?.currency||entry.currency||null,fingerprint=paymentFingerprint(entry,currency);if(body.fingerprint!==fingerprint)fail('Данные выплаты изменились. Обновите расчёт',409);const old=db.prepare('SELECT * FROM salary_receipt_acks WHERE employee=? AND entry=?').get(employee,entryId);if(old?.fingerprint!==fingerprint){db.prepare('INSERT INTO salary_receipt_acks VALUES(?,?,?,?,?,?) ON CONFLICT(employee,entry) DO UPDATE SET month=excluded.month,fingerprint=excluded.fingerprint,json=excluded.json,at=excluded.at').run(employee,entryId,month,fingerprint,JSON.stringify({kind:entry.kind,amount:entry.amount,currency,date:entry.date}),clock());audit(employee,month,actor,'receipt-ack',{entry:entryId,fingerprint});}return {ok:true,...own(employee,month)};
  });
  fail('Действие недоступно',404);
 }
 return {view,own,handle};
}
