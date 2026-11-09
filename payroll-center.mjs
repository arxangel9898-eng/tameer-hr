import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {money,monthOK} from './payroll.mjs';
import {initPayrollGrowth} from './payroll-growth.mjs';
import {initPayrollControl} from './payroll-control.mjs';

const keys=['grades','coach','calendar','payouts','supplements','checks'];
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const defaults=()=>({features:Object.fromEntries(keys.map(k=>[k,true])),responsibles:Object.fromEntries(keys.map(k=>[k,[]])),advancePercent:30,forecastCash:null,forecastReserve:0,forecastAsOf:null,anomalyPercent:30,duplicateWindowDays:7,documentRequired:true});
const canRead=a=>!!(a?.admin||['read','write'].includes(a?.permissions?.payroll));
const canCash=a=>!!(a?.admin||['read','write'].includes(a?.permissions?.finance));

// Configuration coordinates independent modules. Publishing a range, selecting
// a responsible person or changing a forecast never changes earned wages.
export function initPayrollCenter(db,{fail,transaction,payroll,tz='Asia/Tashkent',clock=Date.now,eligibleAccounts=()=>[],personalResult,postEntry}){
 db.exec(`CREATE TABLE IF NOT EXISTS payroll_center_settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS payroll_center_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);`);
 db.prepare('INSERT OR IGNORE INTO payroll_center_settings VALUES(1,?)').run(JSON.stringify(defaults()));
 const config=()=>JSON.parse(db.prepare('SELECT json FROM payroll_center_settings WHERE id=1').get().json);
 const growth=initPayrollGrowth(db,{fail,transaction,payroll,tz,clock,settings:config,personalResult});
 const control=initPayrollControl(db,{fail,transaction,payroll,tz,clock,settings:config,postEntry});
 const version=()=>hash(config());
 const validateMonth=m=>{if(!monthOK(m))fail('Выберите расчётный месяц');};
 function safeSettings(actor){const c={...config(),version:version()};if(!canCash(actor)){delete c.forecastCash;delete c.forecastReserve;delete c.forecastAsOf;}return c;}
 function view(month,actor){
  if(!canRead(actor))fail('Нет доступа к центру KPI и выплат',403);validateMonth(month);
  const c=safeSettings(actor),result=control.view(month,actor);
  if(!canCash(actor)&&result.calendar)result.calendar={...result.calendar,cash:null};
  return {month,settings:c,growth:growth.view(month,actor),control:result,canConfigure:!!actor.admin,accounts:actor.admin?eligibleAccounts().map(a=>({id:a.id,name:a.name||a.username||a.id})):[]};
 }
 function own(employee,month){validateMonth(month);if(!db.prepare('SELECT id FROM employees WHERE id=?').get(employee))fail('Сотрудник недоступен',404);return {month,features:{...config().features},growth:growth.own(employee,month),control:control.own(employee,month)};}
 function configure(body,actor){
  if(!actor?.admin)fail('Настройки доступны администратору',403);
  return transaction(()=>{
   const old=config();if(body.version!==hash(old))fail('Настройки изменились. Обновите страницу',409);
   if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.length>500)fail('Укажите основание изменения настроек');
   if(!body.features||keys.some(k=>typeof body.features[k]!=='boolean')||Object.keys(body.features).some(k=>!keys.includes(k)))fail('Проверьте переключатели функций');
   const available=new Set(eligibleAccounts().map(a=>a.id)),responsibles={};
   for(const k of keys){const rows=body.responsibles?.[k]??old.responsibles[k];if(!Array.isArray(rows)||rows.length>50||new Set(rows).size!==rows.length||rows.some(id=>typeof id!=='string'||!available.has(id)))fail('Ответственный должен иметь действующий доступ к зарплате');responsibles[k]=[...rows].sort();}
   if(!Number.isInteger(body.advancePercent)||body.advancePercent<0||body.advancePercent>100)fail('Плановый аванс: целое число от 0 до 100%');
   if(typeof body.anomalyPercent!=='number'||!Number.isFinite(body.anomalyPercent)||body.anomalyPercent<1||body.anomalyPercent>1000)fail('Порог изменения зарплаты: от 1 до 1000%');
   if(!Number.isInteger(body.duplicateWindowDays)||body.duplicateWindowDays<1||body.duplicateWindowDays>90||typeof body.documentRequired!=='boolean')fail('Проверьте параметры проверки выплат');
   const forecastCash=body.forecastCash===null||body.forecastCash===''?null:money(body.forecastCash),forecastReserve=money(body.forecastReserve??0);
   if(forecastCash!==null&&forecastCash!==old.forecastCash&&body.verifyCash!==true)fail('Подтвердите, что денежный остаток проверен сейчас');
   const forecastAsOf=forecastCash===null?null:body.verifyCash===true?clock():old.forecastAsOf;
   if(forecastCash!==null&&!forecastAsOf)fail('Подтвердите проверку денежного остатка');
   const next={features:Object.fromEntries(keys.map(k=>[k,body.features[k]])),responsibles,advancePercent:body.advancePercent,forecastCash,forecastReserve,forecastAsOf,anomalyPercent:body.anomalyPercent,duplicateWindowDays:body.duplicateWindowDays,documentRequired:body.documentRequired};
   db.prepare('UPDATE payroll_center_settings SET json=? WHERE id=1').run(JSON.stringify(next));
   db.prepare('INSERT INTO payroll_center_audit(actor,action,json,at) VALUES(?,?,?,?)').run(String(actor.id||'owner'),'settings',JSON.stringify({before:old,after:next,reason:body.reason.trim()}),clock());
   return {ok:true,settings:safeSettings(actor)};
  });
 }
 function handle(part,action,body,actor){if(part==='settings')return configure(body,actor);if(part==='growth')return growth.handle(action,body,actor);if(part==='control')return control.handle(action,body,actor);fail('Действие центра выплат не найдено',404);}
 function download(batchId,actor){
  const batch=control.exportBatch(batchId,actor),XLSX=createRequire(import.meta.url)('./public/vendor/xlsx.full.min.js');
  const rows=[['TAMEER · Ведомость выплат'],['Расчётный месяц',batch.month,'Вид',batch.kind==='advance'?'Аванс':'Зарплата','Дата',batch.date],['Это ведомость для сверки. Файл не является подтверждением перевода денег.'],[],['Сотрудник','Период заработка','Валюта','План выплаты','Учтено по ведомости','Осталось по ведомости','Статус','Документы']];
  for(const r of batch.rows){const proposed=r.planned??r.proposed??0,paid=r.paid??0,documents=r.documents??r.linkedEntries??[];rows.push([r.name,batch.month,r.currency,proposed/100,paid/100,Math.max(0,proposed-paid)/100,r.status,typeof documents==='string'?documents:documents.map(x=>typeof x==='string'?x:x.documentRef||x.id||'').join('; ')]);}
  const sheet=XLSX.utils.aoa_to_sheet(rows),book=XLSX.utils.book_new();sheet['!cols']=[{wch:30},{wch:18},{wch:10},{wch:20},{wch:23},{wch:25},{wch:20},{wch:35}];sheet['!autofilter']={ref:'A5:H'+Math.max(5,rows.length)};
  for(let i=6;i<=rows.length;i++)for(const c of ['D','E','F'])if(sheet[c+i])sheet[c+i].z='#,##0.00';
  XLSX.utils.book_append_sheet(book,sheet,'Выплаты');
  return {bytes:Buffer.from(XLSX.write(book,{bookType:'xlsx',type:'buffer'})),filename:'TAMEER-payments-'+batch.month+'-'+String(batch.id).slice(0,36)+'.xlsx'};
 }
 return {config,version,view,own,handle,download,growth,control};
}
