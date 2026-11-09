import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=value=>value===undefined?undefined:structuredClone(value);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const computedKpi=entry=>entry?.kind==='kpi'||/^(kpi:|turnover-kpi:|hrplus:performance:)/.test(entry?.source||'')||/^finance:\d{4}-\d{2}:/.test(entry?.request_id||'');

// Visibility affects personal projections only. Payroll calculations, published
// conditions and the original ledger remain authoritative and unchanged.
export function initKpiVisibility(db,{fail,transaction=fn=>fn(),clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS kpi_visibility_settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL,revision INTEGER NOT NULL,updated INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS kpi_visibility_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);`);
 db.prepare('INSERT OR IGNORE INTO kpi_visibility_settings VALUES(1,?,1,?)').run(JSON.stringify({web:true,bot:true}),clock());
 function read(){const row=db.prepare('SELECT * FROM kpi_visibility_settings WHERE id=1').get();let flags;try{flags=JSON.parse(row?.json)}catch{}if(!object(flags)||typeof flags.web!=='boolean'||typeof flags.bot!=='boolean'||!Number.isSafeInteger(row.revision))fail('Настройка показа KPI повреждена',409);return {row,flags};}
 const version=(row,flags)=>digest({flags,revision:row.revision});
 function enabled(channel='web'){if(!['web','bot'].includes(channel))fail('Неизвестный канал показа KPI');return read().flags[channel];}
 function view(actor){if(!actor?.admin)fail('Настройка показа KPI доступна администратору',403);const {row,flags}=read();return {...flags,version:version(row,flags),updatedAt:row.updated};}
 function save(body,actor){
  if(!actor?.admin)fail('Изменение показа KPI доступно администратору',403);
  if(!object(body)||typeof body.web!=='boolean'||typeof body.bot!=='boolean')fail('Проверьте переключатели показа KPI');
  if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.length>500)fail('Укажите основание изменения показа KPI');
  return transaction(()=>{const {row,flags}=read();if(body.version!==version(row,flags))fail('Настройка изменилась. Обновите страницу',409);
   if(body.web===flags.web&&body.bot===flags.bot)return {ok:true,duplicate:true,...view(actor)};
   const next={web:body.web,bot:body.bot};db.prepare('UPDATE kpi_visibility_settings SET json=?,revision=revision+1,updated=? WHERE id=1').run(JSON.stringify(next),clock());
   db.prepare('INSERT INTO kpi_visibility_audit(actor,json,at) VALUES(?,?,?)').run(String(actor.id||'owner'),JSON.stringify({before:flags,after:next,reason:body.reason.trim()}),clock());
   return {ok:true,...view(actor)};
  });
 }
 function entry(value,channel='web'){
  const result=clone(value);if(enabled(channel)||!object(result)||!computedKpi(result))return result;
  // Old generated explanations can contain the hidden score or plan/fact.
  // The paid/earned amount, ID, date, approver and cancellation history remain.
  result.reason='Начисленная премия KPI';return result;
 }
 function statement(value,channel='web'){
  const result=clone(value);if(enabled(channel)||!object(result))return result;
  result.metrics=[];delete result.turnoverKpi;delete result.latestTurnoverKpi;
  if(Array.isArray(result.entries))result.entries=result.entries.map(e=>entry(e,channel));
  result.kpiVisible=false;return result;
 }
 function insights(value,channel='web'){
  const result=clone(value);if(enabled(channel)||!object(result))return result;
  if(Object.hasOwn(result,'performance'))result.performance=null;
  result.kpiVisible=false;return result;
 }
 function center(value,channel='web'){
  const result=clone(value);if(enabled(channel)||!object(result))return result;
  if(object(result.features))result.features.coach=false;
  if(object(result.settings?.features))result.settings.features.coach=false;
  if(object(result.growth)){result.growth.coach=null;if(object(result.growth.enabled))result.growth.enabled.coach=false;}
  result.kpiVisible=false;return result;
 }
 function personal(value,channel='web'){
  const result=clone(value);if(!object(result))return result;
  result.kpiVisible=enabled(channel);
  if(result.kpiVisible)return result;
  if(Object.hasOwn(result,'statement'))result.statement=statement(result.statement,channel);
  if(Object.hasOwn(result,'insights'))result.insights=insights(result.insights,channel);
  if(Object.hasOwn(result,'payrollCenter'))result.payrollCenter=center(result.payrollCenter,channel);
  return result;
 }
 return {view,save,enabled,entry,statement,insights,center,personal};
}
