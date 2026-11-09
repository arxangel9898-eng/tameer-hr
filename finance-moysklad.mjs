import {createHash} from 'node:crypto';
import {localDate} from './model.mjs';
import {monthOK} from './payroll.mjs';

const BASE='https://api.moysklad.ru/api/remap/1.2/',MAX=999999999999,LIMIT=100,MAX_PAGES=100;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safeError=(message,status=502)=>{throw Object.assign(new Error(message),{reportSafe:true,status})};
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=MAX;
const readable=actor=>!!(actor?.admin||['read','write'].includes(actor?.permissions?.finance));
const writable=actor=>!!(actor?.admin||actor?.permissions?.finance==='write');
function accumulator(){let sum=0,compensation=0;return {add(value){const adjusted=value-compensation,next=sum+adjusted;compensation=(next-sum)-adjusted;sum=next;if(!Number.isFinite(sum)||Math.abs(sum)>MAX)safeError('Суммы отчёта превышают допустимый предел');},value(){return Math.round(sum);}};}
function assortment(row){
 const meta=row?.assortment?.meta;try{const u=new URL(meta?.href),m=/^\/api\/remap\/1\.2\/entity\/(product|variant|bundle|service)\/([0-9a-f-]{36})$/i.exec(u.pathname);if(u.origin!=='https://api.moysklad.ru'||u.username||u.password||u.search||u.hash||!m||!UUID.test(m[2])||meta.type&&meta.type!==m[1])return null;return {key:u.origin+u.pathname,type:m[1]};}catch{return null;}
}
function errorMessage(e){if(e?.reportSafe)return e.message;if(e?.status===409)return 'Подключение или организация МойСклад изменились. Обновите отчёт заново';if(e?.remoteStatus===401)return 'МойСклад: токен недействителен';if(e?.remoteStatus===403)return 'МойСклад: нет прав чтения финансового отчёта';if(e?.remoteStatus===429)return 'МойСклад ограничил запросы. Повторите обновление позже';return 'Не удалось получить полный отчёт МойСклад. Проверьте подключение и права чтения';}

// Read-only remote integration: stores separate report snapshots and audit only.
// It never creates payroll entries, changes finance_periods or enables advances.
export function initFinanceMoysklad(db,{moysklad,fail,transaction,tz='Asia/Tashkent',clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS finance_moysklad_reports(account TEXT NOT NULL,organization TEXT NOT NULL,month TEXT NOT NULL,json TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(account,organization,month));
 CREATE TABLE IF NOT EXISTS finance_moysklad_errors(account TEXT NOT NULL,organization TEXT NOT NULL,month TEXT NOT NULL,error TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(account,organization,month));
 CREATE TABLE IF NOT EXISTS finance_moysklad_audit(id INTEGER PRIMARY KEY,account TEXT NOT NULL,organization TEXT NOT NULL,month TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);`);
 const running=new Set(),today=()=>localDate(clock(),tz).date;
 const valid=month=>{if(!monthOK(month))fail('Выберите месяц финансового отчёта');};
 const scope=()=>moysklad.analyticsStatus();
 const scopeKey=(s,month)=>[s.account||'',s.organization?.id||'',month];
 const equivalent=(a,b)=>a.connected&&b.connected&&a.account===b.account&&a.generation===b.generation&&a.scopeVersion===b.scopeVersion&&a.organization?.id===b.organization?.id;
 const ensureScope=s=>{if(!equivalent(s,scope()))safeError('Подключение или организация МойСклад изменились. Обновите отчёт заново',409);};
 function view(month,actor){
  if(!readable(actor))fail('Нет доступа к финансовому аналитику',403);valid(month);const s=scope(),key=scopeKey(s,month),row=db.prepare('SELECT json FROM finance_moysklad_reports WHERE account=? AND organization=? AND month=?').get(...key),saved=row?JSON.parse(row.json):null,lastError=db.prepare('SELECT error FROM finance_moysklad_errors WHERE account=? AND organization=? AND month=?').get(...key)?.error||'';
  const stale=!!saved&&(!s.connected||saved.generation!==s.generation||saved.scopeVersion!==s.scopeVersion||!!lastError),warnings=[];
  if(!s.connected)warnings.push('Подключите МойСклад в защищённых настройках интеграции.');
  if(!UUID.test(s.organization?.id||''))warnings.push('Выберите организацию МойСклад.');
  if(stale)warnings.push('Показан сохранённый отчёт. Для актуальных данных обновите его.');
  if(month>today().slice(0,7))warnings.push('Отчёт за будущий месяц ещё недоступен.');
  const report=saved?{...saved.report,stale}:null;
  if(report?.warnings)warnings.push(...report.warnings);
  return {connected:!!s.connected,organization:s.organization?.id?{id:s.organization.id,name:s.organization.name||''}:null,currency:report?.currency||null,report,warnings:[...new Set(warnings)],lastError,canSync:writable(actor)&&!!s.connected&&UUID.test(s.organization?.id||'')&&month<=today().slice(0,7),running:running.has(key.join(':'))};
 }
 async function currency(s){
  const data=await moysklad.analyticsRead('entity/currency',{filter:'default=true',limit:1000});ensureScope(s);
  if(!Array.isArray(data?.rows)||data.rows.length>1000||data.meta?.size!==undefined&&(!Number.isSafeInteger(data.meta.size)||data.meta.size!==data.rows.length))safeError('Не удалось однозначно проверить основную валюту МойСклад');
  const defaults=data.rows.filter(r=>r?.default===true);if(defaults.length!==1)safeError('Основная валюта МойСклад не определена однозначно');const c=defaults[0],iso=String(c.isoCode||'').toUpperCase(),code=String(c.code||'');
  if(!(iso==='UZS'||!iso&&code==='860')||iso&&iso!=='UZS')safeError('Основная валюта МойСклад должна быть UZS. Автоматический пересчёт валют не выполняется',409);
  return 'UZS';
 }
 async function sync(b,actor){
  if(!writable(actor))fail('Нет права обновления финансового отчёта',403);valid(b?.month);const month=b.month,s=scope();if(!s.connected)fail('Сначала подключите МойСклад');if(!UUID.test(s.account||'')||!UUID.test(s.organization?.id||''))fail('Выберите организацию МойСклад');if(month>today().slice(0,7))fail('Нельзя загружать отчёт будущего месяца');const key=scopeKey(s,month),lock=key.join(':');if(running.has(lock))return {ok:true,busy:true,...view(month,actor)};
  running.add(lock);const asOf=clock(),local=localDate(asOf,tz),provisional=month===local.date.slice(0,7),last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10),from=month+'-01 00:00:00',to=provisional?local.date+' '+local.time+':'+local.parts.second:last+' 23:59:59';
  try{
   const verifiedCurrency=await currency(s),sums=Object.fromEntries(['sellSum','returnSum','sellCostSum','returnCostSum','profit'].map(k=>[k,accumulator()])),seen=new Set(),warnings=[],costIssues=[];let expected=null,rowsCount=0,unknownCost=false,costIssueCount=0,fractional=false,complete=false;
   const costIssue=(row,item,reasons)=>{unknownCost=true;costIssueCount++;if(costIssues.length<20)costIssues.push({name:typeof row.assortment?.name==='string'?row.assortment.name.slice(0,255):'',code:typeof row.assortment?.code==='string'?row.assortment.code.slice(0,80):'',type:item.type,sourceId:item.key.split('/').at(-1),reason:reasons[0],reasons});};
   for(let page=0;page<MAX_PAGES;page++){
    const offset=page*LIMIT,data=await moysklad.analyticsRead('report/profit/byproduct',{momentFrom:from,momentTo:to,filter:'organization='+BASE+'entity/organization/'+s.organization.id,limit:LIMIT,offset});ensureScope(s);
    if(!Array.isArray(data?.rows)||data.rows.length>LIMIT||!Number.isSafeInteger(data.meta?.size)||data.meta.size<0||data.meta.offset!==undefined&&data.meta.offset!==offset)safeError('МойСклад вернул неполный или некорректный список отчёта');
    if(expected===null)expected=data.meta.size;if(expected!==data.meta.size)safeError('Отчёт МойСклад изменился во время загрузки. Обновите его повторно',409);
    if(expected>MAX_PAGES*LIMIT||rowsCount+data.rows.length>expected)safeError('Отчёт слишком большой или неполный. Требуется отдельная сверка периода');
    for(const row of data.rows){
     const item=assortment(row);if(!item||seen.has(item.key))safeError('В отчёте обнаружены повторные или неизвестные строки товаров. Обновите отчёт повторно');seen.add(item.key);rowsCount++;
     if(!finite(row.sellSum)||!finite(row.returnSum)||!finite(row.profit))safeError('В отчёте отсутствуют корректные суммы продаж, возвратов или прибыли');
     for(const field of ['sellSum','returnSum','profit']){sums[field].add(row[field]);if(!Number.isInteger(row[field]))fractional=true;}
     if(!finite(row.sellCostSum)||!finite(row.returnCostSum)){costIssue(row,item,['missing-cost']);continue;}
     for(const field of ['sellCostSum','returnCostSum']){sums[field].add(row[field]);if(!Number.isInteger(row[field]))fractional=true;}
     if(item.type!=='service'){const reasons=[];if(row.sellCostSum===0&&(row.sellSum!==0||Number(row.sellQuantity)>0))reasons.push('sold-zero');if(row.returnCostSum===0&&(row.returnSum!==0||Number(row.returnQuantity)>0))reasons.push('returned-zero');if(reasons.length)costIssue(row,item,reasons);}
    }
    if(rowsCount===expected){complete=true;break;}if(data.rows.length<LIMIT)safeError('МойСклад вернул не все строки отчёта. Предыдущий снимок сохранён');
   }
   if(!complete)safeError('Превышен предел загрузки полного отчёта. Сократите период');
   const sales=sums.sellSum.value(),returns=sums.returnSum.value(),revenue=sales-returns,reportedProfit=sums.profit.value();let cost=unknownCost?null:sums.sellCostSum.value()-sums.returnCostSum.value(),gross=cost===null?null:revenue-cost,reconciliationDifference=gross===null?null:reportedProfit-gross;
   if(unknownCost)warnings.push('Себестоимость части товаров отсутствует или равна нулю при движении товара. Проверьте FIFO, остатки и документы: валовая прибыль пока не подтверждена. Нулевая себестоимость услуг допустима.');
   if(reconciliationDifference!==null&&Math.abs(reconciliationDifference)>2){warnings.push('Прибыль API отличается от выручки за вычетом себестоимости. Нужна сверка комиссий и корректировок; валовая прибыль не подтверждена.');gross=null;}
   if(fractional)warnings.push('API вернул дробные минимальные денежные единицы. Итог каждой суммы округлён один раз после суммирования строк.');
   if(![sales,returns,revenue,cost,gross,reportedProfit].every(n=>n===null||Number.isSafeInteger(n)&&Math.abs(n)<=MAX))safeError('Итоговые суммы отчёта превышают допустимый предел');
   const report={month,asOf,from,to,dateBasis:'Даты документов МойСклад',currency:verifiedCurrency,sales,returns,revenue,cost,gross,margin:gross!==null&&revenue>0?Math.round(gross/revenue*10000)/100:null,reportedProfit,reconciliationDifference,rowsCount,costIssueCount,costIssues,provisional,status:gross===null?'blocked':'ready',warnings,organization:{id:s.organization.id,name:s.organization.name||''}};report.fingerprint=digest(report);
   ensureScope(s);transaction(()=>{
    ensureScope(s);
    if(!provisional){
     const saved=db.prepare('SELECT json FROM finance_moysklad_reports WHERE account=? AND organization=? AND month=?').get(...key);
     const previous=saved?JSON.parse(saved.json):null;
     const values=({asOf,fingerprint,...data})=>digest(data);
     // A refresh of identical closed-period data does not invalidate an approved source snapshot.
     if(previous?.report&&previous.generation===s.generation&&previous.scopeVersion===s.scopeVersion&&values(previous.report)===values(report))report.fingerprint=previous.report.fingerprint;
    }
    db.prepare('INSERT INTO finance_moysklad_reports VALUES(?,?,?,?,?) ON CONFLICT(account,organization,month) DO UPDATE SET json=excluded.json,updated=excluded.updated').run(...key,JSON.stringify({generation:s.generation,scopeVersion:s.scopeVersion,report}),asOf);
    db.prepare('DELETE FROM finance_moysklad_errors WHERE account=? AND organization=? AND month=?').run(...key);
    db.prepare('INSERT INTO finance_moysklad_audit(account,organization,month,actor,action,json,at) VALUES(?,?,?,?,?,?,?)').run(...key,String(actor.id||'owner'),'sync',JSON.stringify({rowsCount,status:report.status,fingerprint:report.fingerprint,from,to}),asOf);
   });
   running.delete(lock);return {ok:true,...view(month,actor)};
  }catch(e){const message=errorMessage(e);transaction(()=>{db.prepare('INSERT INTO finance_moysklad_errors VALUES(?,?,?,?,?) ON CONFLICT(account,organization,month) DO UPDATE SET error=excluded.error,at=excluded.at').run(...key,message,clock());db.prepare('INSERT INTO finance_moysklad_audit(account,organization,month,actor,action,json,at) VALUES(?,?,?,?,?,?,?)').run(...key,String(actor.id||'owner'),'sync-error',JSON.stringify({message}),clock());});fail(message,e?.reportSafe?e.status:e?.status===409?409:502);
  }finally{running.delete(lock);}
 }
 return {view,sync};
}
