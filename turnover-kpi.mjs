import {createHash,randomUUID} from 'node:crypto';
import {roles,roleForEmployee} from './role-catalog.mjs';
import {localDate} from './model.mjs';
import {money} from './payroll.mjs';

const STEP=5000000n,MAX=999999999999;
const rates={director:25,coo:25,'store-manager':20,'operations-manager':20,category:20,plumbing:20,'seller-tiles':20,'seller-tools':20,loader:10};
const benchmarkUZS={director:1500000,coo:1250000,'store-manager':1000000,'operations-manager':800000,category:800000,plumbing:600000,'seller-tiles':600000,'seller-tools':600000,supply:600000,warehouse:600000,'hr-generalist':600000,accountant:600000,cashier:500000,sysadmin:600000,universal:500000,loader:250000};
const executiveTitles=new Set(['financial manager (cfo)','head of process automation (cdo)']);
const profileTitle=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const label='Командный KPI оборота · ретроспективная модель';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const monthOK=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
const amount=value=>Number.isSafeInteger(value)&&Math.abs(value)<=MAX;
const parse=value=>{try{return JSON.parse(value)}catch{return null}};
const previous=month=>{const [y,m]=month.split('-').map(Number);return `${m===1?y-1:y}-${String(m===1?12:m-1).padStart(2,'0')}`};
const lastDay=month=>new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);

// Integer largest-remainder allocation keeps every minor unit in the same pool.
function split(pool,caps,weight){
 const total=caps.reduce((n,c)=>n+BigInt(weight(c)),0n),out=new Map(caps.map(c=>[c.employee,0]));
 if(!pool)return out;if(total<=0n)throw Error('Нет весов для перераспределения премии');
 const ranked=caps.map(c=>{const v=BigInt(pool)*BigInt(weight(c));return {id:c.employee,value:v/total,remainder:v%total}}).sort((a,b)=>a.remainder===b.remainder?a.id.localeCompare(b.id):a.remainder>b.remainder?-1:1);
 let rest=BigInt(pool)-ranked.reduce((n,c)=>n+c.value,0n);for(const c of ranked){if(rest>0n){c.value++;rest--;}out.set(c.id,Number(c.value));}return out;
}

// Preview/configuration never accrue money. Explicit approval posts through the
// guarded payroll callback; company turnover never substitutes for personal facts.
export function initTurnoverKpi(db,{fail,transaction=fn=>fn(),tz='Asia/Tashkent',clock=Date.now,reportForMonth,personalResult=()=>({complete:false,score:null}),roleAt=null,postBonus=null}){
 db.exec(`CREATE TABLE IF NOT EXISTS turnover_kpi_policies(month TEXT PRIMARY KEY,json TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS turnover_kpi_audit(id INTEGER PRIMARY KEY,month TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS turnover_kpi_previews(id TEXT PRIMARY KEY,month TEXT NOT NULL,actor TEXT NOT NULL,json TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS turnover_kpi_posts(employee TEXT NOT NULL,month TEXT NOT NULL,entry TEXT NOT NULL UNIQUE,amount INTEGER NOT NULL,policy_version TEXT NOT NULL,json TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(employee,month));`);
 const has=table=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
 const validate=month=>{if(!monthOK(month))fail('Выберите месяц командного KPI')};
 const read=month=>{const row=db.prepare('SELECT * FROM turnover_kpi_policies WHERE month=?').get(month);if(!row)return null;const policy=parse(row.json);if(!policy||!Array.isArray(policy.caps)||!policy.source)fail('Сохранённая настройка командного KPI повреждена',409);return {...policy,configuredAt:row.created}};
 const policyVersion=policy=>policy?hash(Object.fromEntries(Object.entries(policy).filter(([key])=>key!=='configuredAt'))):null;
 const readable=actor=>!!(actor?.admin||['read','write'].includes(actor?.permissions?.finance)||['read','write'].includes(actor?.permissions?.payroll));

 function report(month){
  let value;try{value=reportForMonth?.(month)}catch{return {ok:false,reason:'Сохранённый отчёт МойСклад недоступен'}};
  const r=value?.report,organization=value?.organization?.id;
  if(!value?.connected||value.lastError||!r||r.stale!==false)return {ok:false,reason:'Обновите сохранённый отчёт МойСклад'};
  if(value.currency!=='UZS'||r.currency!=='UZS')return {ok:false,reason:'Для командного KPI нужны отчёты в UZS'};
  if(r.month!==month||r.provisional!==false||r.from!==month+'-01 00:00:00'||r.to!==lastDay(month)+' 23:59:59')return {ok:false,reason:'Нужен полный отчёт за закрытый календарный месяц'};
  if(typeof organization!=='string'||!organization||organization!==r.organization?.id)return {ok:false,reason:'Не подтверждена организация отчёта МойСклад'};
  if(!amount(r.sales)||!amount(r.returns)||!amount(r.revenue)||r.sales<0||r.returns<0||r.sales-r.returns!==r.revenue||!Number.isSafeInteger(r.rowsCount)||r.rowsCount<0||r.rowsCount===0&&(r.sales!==0||r.returns!==0))return {ok:false,reason:'В отчёте нет проверенного чистого оборота'};
  if(!Number.isSafeInteger(r.asOf)||r.asOf<0||typeof r.fingerprint!=='string'||!/^[a-f0-9]{64}$/i.test(r.fingerprint))return {ok:false,reason:'Не подтверждён источник отчёта МойСклад'};
  return {ok:true,month,net:r.revenue,sales:r.sales,returns:r.returns,organization,fingerprint:r.fingerprint,asOf:r.asOf,costIssueCount:Number.isSafeInteger(r.costIssueCount)?r.costIssueCount:0,profitConfirmed:r.status==='ready'&&r.gross!==null};
 }
 function sources(month,basisMonth){
  const current=report(month),basis=report(basisMonth);
  if(!current.ok||!basis.ok)return {valid:false,reason:!current.ok?current.reason:basis.reason,current,basis};
  if(current.organization!==basis.organization)return {valid:false,reason:'Организации сравниваемых отчётов различаются',current,basis};
  if(basis.net<=0)return {valid:false,reason:'Оборот базового месяца должен быть положительным; процент не рассчитан',current,basis};
  return {valid:true,reason:'',current,basis};
 }
 function peopleCaps(month,roleSource='monthly-review',old=null,rebasePast=false){
  const people=db.prepare('SELECT id,name,role,active FROM employees ORDER BY id').all().filter(e=>e.active||db.prepare('SELECT employee FROM pay_accounts WHERE employee=? AND month=?').get(e.id,month));
  return people.map(e=>{
   const account=db.prepare('SELECT base,currency FROM pay_accounts WHERE employee=? AND month=?').get(e.id,month),raw=has('role_reviews')?db.prepare('SELECT json FROM role_reviews WHERE employee=? AND month=?').get(e.id,month):null,review=raw?parse(raw.json):null;
   const current=roleSource==='current-profile',fallback=old?.caps?.find(c=>c.employee===e.id)?.role||roles.find(r=>r.id===review?.role)?.name||null,title=current&&roleAt&&!rebasePast?roleAt(e.id,lastDay(month),fallback):e.role,roleId=current?roleForEmployee(title):review?.role||roleForEmployee(e.role),role=roles.find(r=>r.id===roleId);
   if(!role)fail('Для расчёта лимита выберите должность сотрудника',409);
   if(account&&account.currency!=='UZS')fail('Валюта расчёта сотрудника отличается от UZS',409);
   if(account&&(!amount(account.base)||account.base<0))fail('Проверьте сохранённый оклад сотрудника',409);
   const executive=current&&executiveTitles.has(profileTitle(title)),rate=executive?25:rates[roleId]||15,existing=current?undefined:review?.maximum;
   if(existing!==undefined&&(!amount(existing)||existing<0))fail('Проверьте действующий лимит должностной премии',409);
   let maximum,capBasis;
   if(existing>0){maximum=existing;capBasis='existing-role-limit';}
   else if(account?.base>0){maximum=Number(BigInt(account.base)*BigInt(rate)/(100n*STEP)*STEP);capBasis='base-rate';}
   else{maximum=(executive?1250000:benchmarkUZS[roleId]||500000)*100;capBasis='role-benchmark';}
   return {employee:e.id,roleId,role:current?title:role.name,minimum:0,maximum,accountConfigured:!!account,capBasis,rate:capBasis==='base-rate'?rate:null};
  });
 }
 function state(policy){
  if(policy.personalWeight===100)return {valid:true,status:'proposal',score:null,rawIndex:null,current:null,basis:null};
  const source=sources(policy.month,policy.basisMonth);
  if(!source.valid)return {...source,status:'blocked',score:null,rawIndex:null};
  if(source.current.fingerprint!==policy.source.currentFingerprint||source.basis.fingerprint!==policy.source.basisFingerprint||source.current.organization!==policy.source.organization)return {...source,valid:false,status:'stale',reason:'Отчёты изменились после настройки. Пересчитайте проект командной премии',score:null,rawIndex:null};
  const rawIndex=Math.round(source.current.net/source.basis.net*10000)/100||0,score=Math.max(0,Math.min(100,rawIndex));
  return {...source,status:'proposal',score,rawIndex};
 }
 function allocation(policy,calculated){
  const fixed=policy.budgetMode==='fixed',scaled=fixed?split(policy.budgetMinor,policy.caps,c=>c.maximum):null,caps=policy.caps.map(c=>({...c,maximum:fixed?scaled.get(c.employee):c.maximum}));
  const teamWeight=policy.teamWeight??100,personalWeight=policy.personalWeight??0;
  const excludedRoles=new Set(policy.excludedRoles||[]),remaining=caps.filter(c=>!excludedRoles.has(c.roleId)),excluded=caps.filter(c=>excludedRoles.has(c.roleId));
  const sum=values=>{const n=values.reduce((n,v)=>n+BigInt(v),0n);if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('Слишком большой фонд перераспределения');return Number(n)};
  const eligible=Math.max(0,Math.min(calculated.current?.net||0,calculated.basis?.net||0)),baseProposal=new Map(caps.map(c=>[c.employee,calculated.valid?(teamWeight?Number(BigInt(c.maximum)*BigInt(eligible)*BigInt(teamWeight)/(BigInt(calculated.basis.net)*100n)):0):null]));
  const freedMaximum=sum(excluded.map(c=>c.maximum)),freedProposal=calculated.valid?sum(excluded.map(c=>baseProposal.get(c.employee))):null;
  const addedMaximum=split(freedMaximum,remaining,c=>c.maximum),proposalWeights=calculated.valid&&remaining.some(c=>baseProposal.get(c.employee)>0),addedProposal=calculated.valid?split(freedProposal,remaining,c=>proposalWeights?baseProposal.get(c.employee):c.maximum):null;
  const rows=new Map(caps.map(cap=>{const isExcluded=excludedRoles.has(cap.roleId),maximum=isExcluded?0:cap.maximum+(addedMaximum.get(cap.employee)||0);let personalScore=null,personalReady=!personalWeight,personalReason='';
   if(!isExcluded&&personalWeight){try{const r=personalResult(cap.employee,policy.month);personalReady=r?.complete===true&&typeof r.score==='number'&&Number.isFinite(r.score)&&r.score>=0&&r.score<=100;personalScore=personalReady?r.score:null;personalReason=r?.reason||'Личные показатели KPI не заполнены или не подтверждены';}catch{personalReason='Не удалось проверить личные показатели KPI';}}
   const ready=calculated.valid&&personalReady,personalMinor=personalReady&&personalWeight?BigInt(Math.round(personalScore*100)):0n,basis=BigInt(calculated.basis?.net||1);
   const blended=limit=>Number(BigInt(limit)*(BigInt(eligible)*BigInt(teamWeight)*10000n+basis*personalMinor*BigInt(personalWeight))/(basis*1000000n));
   const proposal=isExcluded?0:ready?(personalWeight?blended(maximum):baseProposal.get(cap.employee)+(addedProposal.get(cap.employee)||0)):null;
   const score=isExcluded?null:ready?Math.round(((calculated.score||0)*teamWeight/100+(personalScore||0)*personalWeight/100)*100)/100:null;
   return [cap.employee,{...cap,maximum,proposal,score,teamScore:calculated.score,personalScore,personalReady,personalReason,teamWeight,personalWeight,excluded:isExcluded,...(!isExcluded&&excluded.length?{redistribution:{method:'proportional',addedMaximum:addedMaximum.get(cap.employee)||0,addedProposal:ready?(personalWeight?blended(maximum)-blended(cap.maximum):addedProposal.get(cap.employee)||0):null}}:{})}];}));
  const additions=[...rows.values()].filter(r=>!r.excluded).map(r=>r.redistribution?r.redistribution.addedProposal:0),actualFreed=personalWeight?(additions.some(v=>v===null)?null:sum(additions)):freedProposal;
  return {rows,excludedRoles:[...excludedRoles],redistribution:excluded.length?{method:'proportional',excludedCount:excluded.length,participants:remaining.length,freedMaximum,freedProposal:actualFreed}:null};
 }
 function own(policy,cap,calculated){
  const proposal=cap.proposal;
  const setup=cap.accountConfigured?'':'Расчёт зарплаты за месяц не создан. Лимит задан как проект по должности. ';
  return {month:policy.month,basisMonth:policy.basisMonth,label:cap.personalWeight?'Личный и командный KPI':label,currency:'UZS',moneyUnit:'minor',score:cap.score,rawIndex:cap.excluded?null:calculated.rawIndex,minimum:cap.minimum,maximum:cap.maximum,proposal,...(cap.personalWeight?{teamScore:cap.teamScore,personalScore:cap.personalScore,teamWeight:cap.teamWeight,personalWeight:cap.personalWeight}:{}),...(cap.excluded?{excluded:true}:{}),...(cap.redistribution?{redistribution:cap.redistribution}:{}),status:cap.excluded?'excluded':!cap.personalReady?'missing-personal-data':calculated.valid?(cap.accountConfigured?'proposal':'requires-payroll-setup'):calculated.status,accountConfigured:cap.accountConfigured,capBasis:cap.capBasis,role:cap.role,reason:cap.excluded?'По решению владельца должность исключена из командной премии за этот месяц. Её доля распределена между участвующими сотрудниками.':!cap.personalReady?cap.personalReason:calculated.valid?setup+(cap.personalWeight?'Взвешенная личная и командная оценка. ':'Ретроспективное сравнение оборота команды с предыдущим месяцем. ')+'Это проект премии; доступный денежный фонд отдельно не подтверждён.':calculated.reason,retrospective:true,posted:false,payoutReady:false,sourceAsOf:calculated.current?.asOf??policy.source.currentAsOf};
 }
 function postedOwn(employee,month){const row=db.prepare('SELECT * FROM turnover_kpi_posts WHERE employee=? AND month=?').get(employee,month);if(!row)return null;const saved=parse(row.json),entry=has('pay_entries')?db.prepare('SELECT * FROM pay_entries WHERE id=?').get(row.entry):null,voided=!entry||!!entry.voided_at;return {...saved,posted:!voided,status:voided?'voided':'posted',postedAmount:row.amount,entryId:row.entry,payoutReady:false,reason:voided?'Начисление отменено. Повторный расчёт требует отдельной корректировки.':'Премия начислена в зарплату. Выплата денег учитывается отдельно.'};}
 function personal(employee,month){
  validate(month);const posted=postedOwn(employee,month);if(posted)return posted;const policy=read(month);if(!policy)return null;
  const cap=policy.caps.find(c=>c.employee===employee);if(!cap)return null;
  const calculated=state(policy);return own(policy,allocation(policy,calculated).rows.get(employee),calculated);
 }
 function latestPersonal(employee){
  const rows=db.prepare('SELECT month FROM turnover_kpi_policies ORDER BY month DESC').all();
  for(const row of rows){const value=personal(employee,row.month);if(value)return value;}
  return null;
 }
 function fund(month){
  const missing=reason=>({pool:null,blockers:[reason]});
  if(!has('finance_periods'))return missing('Заполните финансовые данные и фонд премий месяца');
  const raw=db.prepare('SELECT json FROM finance_periods WHERE month=?').get(month),input=raw?parse(raw.json):null;
  if(!input)return missing('Заполните финансовые данные и фонд премий месяца');
  if(input.currency&&input.currency!=='UZS')return missing('Фонд премий должен быть в UZS');
  if(!Number.isSafeInteger(input.cashCheckedAt)||input.cashCheckedAt<=0||input.cashCheckedAt>clock())return missing('Обновите финансовые данные: нужен проверенный текущий денежный остаток');
  if(!['revenue','cost','expenses','cash','reserve','budget'].every(k=>amount(input[k])&&input[k]>=0)||!Number.isFinite(input.share)||input.share<0||input.share>100)return missing('Проверьте финансовые показатели месяца');
  const columns=db.prepare('PRAGMA table_info(pay_entries)').all().map(c=>c.name);if(!['kind','voided_at','created','source','date','request_id'].every(c=>columns.includes(c)))return missing('Реестр начислений недоступен для проверки фонда');
  const accounts=db.prepare('SELECT employee,month,base,currency FROM pay_accounts').all(),entries=db.prepare('SELECT * FROM pay_entries WHERE voided_at IS NULL').all().filter(e=>accounts.some(a=>a.employee===e.employee&&a.month===e.month&&a.currency==='UZS'));
  const positive=new Set(['work','bonus','kpi']),negative=new Set(['fine','late','advance','payout']);
  const current=entries.filter(e=>e.month===month),accrued=accounts.filter(a=>a.month===month&&a.currency==='UZS').reduce((n,a)=>n+a.base,0)+current.filter(e=>positive.has(e.kind)).reduce((n,e)=>n+e.amount,0);
  let owed=0;for(const a of accounts.filter(a=>a.month<=month&&a.currency==='UZS')){const balance=entries.filter(e=>e.employee===a.employee&&e.month===a.month).reduce((n,e)=>n+(positive.has(e.kind)?e.amount:negative.has(e.kind)?-e.amount:0),a.base);owed+=Math.max(0,balance);}
  const currencyFor=e=>accounts.find(a=>a.employee===e.employee&&a.month===e.month)?.currency;
  const paidSince=entries.filter(e=>['advance','payout'].includes(e.kind)&&e.created>input.cashCheckedAt&&currencyFor(e)==='UZS').reduce((n,e)=>n+e.amount,0);
  const already=current.filter(e=>e.request_id?.startsWith('finance:'+month+':')||e.source?.startsWith('turnover-kpi:')).reduce((n,e)=>n+e.amount,0);
  const profit=input.revenue-input.cost-input.expenses-accrued,cash=input.cash-paidSince-owed-input.reserve,pool=Math.max(0,Math.min(Math.floor(Math.max(0,profit)*input.share/100),input.budget-already,cash));
  return {pool,blockers:pool>0?[]:['Нет подтверждённого свободного фонда после зарплатных обязательств и резерва'],checkedAt:input.cashCheckedAt};
 }
 function view(month,actor,override=undefined){
  if(!readable(actor))fail('Нет доступа к командному KPI',403);validate(month);const policy=override===undefined?read(month):override;
  const latestMonth=db.prepare('SELECT month FROM turnover_kpi_policies ORDER BY month DESC LIMIT 1').get()?.month||null;
  if(!policy)return {configured:false,month,basisMonth:previous(month),currency:'UZS',moneyUnit:'minor',label,source:null,score:null,rawIndex:null,rows:[],totals:{minimum:0,maximum:0,proposal:null},warnings:[],version:null,latestMonth};
  const calculated=state(policy),allocated=allocation(policy,calculated),rows=[...allocated.rows.values()].map(cap=>({employee:cap.employee,name:db.prepare('SELECT name FROM employees WHERE id=?').get(cap.employee)?.name||'Сотрудник',roleId:cap.roleId,...(postedOwn(cap.employee,month)||own(policy,cap,calculated))}));
  const sum=key=>{const values=rows.map(r=>r[key]);if(values.some(v=>v===null))return null;const n=values.reduce((n,v)=>n+BigInt(v),0n);if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('Слишком большой общий лимит премий');return Number(n)};
  const warnings=['Ретроспективная модель: базой служит фактический оборот предыдущего месяца, а не ранее утверждённый план продаж.','Командный процент не является оценкой личных продаж или качества работы.','Суммы являются проектом. Расходы, свободные деньги и фонд выплаты не подтверждены; автоматического начисления нет.'];
  if(!calculated.valid)warnings.unshift(calculated.reason);
  if(policy.roleSource==='current-profile')warnings.push('Лимиты пересчитаны по актуальным должностям и сохранённой базе оплаты за расчётный месяц. Для COO, CFO и CDO применена ставка 25%.');
  if(allocated.redistribution)warnings.push('Исключённые должности не участвуют в премии. Их доли распределены пропорционально исходным суммам участвующих сотрудников; общий фонд сохранён.');
  if(calculated.current?.costIssueCount||calculated.basis?.costIssueCount)warnings.push('В отчётах есть вопросы себестоимости. Используется только чистый оборот; прибыль не считается подтверждённой.');
  const availability=fund(month),required=rows.some(r=>!r.excluded&&!r.posted&&r.proposal===null)?null:rows.filter(r=>!r.posted&&!r.excluded).reduce((n,r)=>n+(r.proposal||0),0);
  const blockers=[...availability.blockers];if(required===null)blockers.push('Не заполнены обязательные личные или командные показатели');else if(availability.pool!==null&&required>availability.pool)blockers.push('Проект превышает свободный фонд. Уменьшите лимиты или проверьте финансовые данные');
  for(const r of rows){r.postingBlockers=[...blockers];if(r.excluded)r.postingBlockers.push('Должность исключена из премии');if(r.proposal===null)r.postingBlockers.push(r.reason);if(!r.accountConfigured)r.postingBlockers.push('Сначала создайте расчёт зарплаты за месяц');if(r.proposal!==null&&r.proposal<=0)r.postingBlockers.push('Нет положительной премии для начисления');if(r.posted||r.status==='voided')r.postingBlockers.push('Результат уже зафиксирован');if(!db.prepare('SELECT active FROM employees WHERE id=?').get(r.employee)?.active)r.postingBlockers.push('Сотрудник в архиве');r.canApprove=!!postBonus&&r.postingBlockers.length===0&&!!(actor?.admin||actor?.permissions?.finance==='write');r.payoutReady=r.canApprove;r.approvalFingerprint=hash({policy:policyVersion(policy),employee:r.employee,proposal:r.proposal,score:r.score,maximum:r.maximum,personalScore:r.personalScore??null,fund:availability,required,blockers:r.postingBlockers});}
  if(policy.budgetMode==='fixed')warnings.push('Задан максимальный общий фонд при 100% KPI. Фактические проекты зависят от результата KPI.');
  if(policy.personalWeight)warnings.push('Личная часть рассчитывается по подтверждённым должностным показателям. Отсутствие факта не заменяется нулём.');
  return {configured:true,month,basisMonth:policy.basisMonth,roleSource:policy.roleSource||'monthly-review',budgetMode:policy.budgetMode||'caps',budgetMinor:policy.budgetMinor??null,teamWeight:policy.teamWeight??100,personalWeight:policy.personalWeight??0,currency:'UZS',moneyUnit:'minor',label:policy.personalWeight?'Личный и командный KPI':label,retrospective:true,payoutReady:rows.some(r=>r.canApprove),approval:{...availability,required,blockers},excludedRoles:allocated.excludedRoles,redistribution:allocated.redistribution,source:{currentNet:calculated.current?.ok?calculated.current.net:null,basisNet:calculated.basis?.ok?calculated.basis.net:null,asOf:calculated.current?.asOf??policy.source.currentAsOf,basisAsOf:calculated.basis?.asOf??policy.source.basisAsOf,currentFingerprint:policy.source.currentFingerprint,basisFingerprint:policy.source.basisFingerprint},score:calculated.score,rawIndex:calculated.rawIndex,status:calculated.status,rows,totals:{minimum:sum('minimum'),maximum:sum('maximum'),proposal:sum('proposal')},warnings,version:policyVersion(policy),configuredAt:policy.configuredAt,latestMonth};
 }
 function prepare(body,actor){
  if(!actor?.admin)fail('Настройка командного KPI доступна администратору',403);validate(body?.month);
  const month=body.month,basisMonth=body.basisMonth||previous(month);
  if(month>=localDate(clock(),tz).date.slice(0,7)||basisMonth!==previous(month))fail('Выберите закрытый месяц и непосредственно предыдущий базовый месяц');
  const old=read(month),version=policyVersion(old),requested=body.version===0?null:body.version;
  if(old&&body.version===undefined||requested!==undefined&&requested!==version)fail('Настройка командного KPI изменилась. Обновите страницу',409);
  for(const table of ['hr_monthly_posts','role_kpi_snapshots','turnover_kpi_posts'])if(has(table)&&db.prepare('SELECT employee FROM '+table+' WHERE month=? LIMIT 1').get(month))fail('Итоги месяца уже зафиксированы. Нужна отдельная сверка',409);
  const teamWeight=body.teamWeight??old?.teamWeight??100,personalWeight=body.personalWeight??old?.personalWeight??(100-teamWeight);
  if(!Number.isInteger(teamWeight)||!Number.isInteger(personalWeight)||teamWeight<0||personalWeight<0||teamWeight>100||personalWeight>100||teamWeight+personalWeight!==100)fail('Личная и командная доли должны давать 100%');
  const source=personalWeight===100?{valid:true,current:{organization:null,fingerprint:null,asOf:null},basis:{fingerprint:null,asOf:null}}:sources(month,basisMonth);if(!source.valid)fail(source.reason,409);
  const excludedRoles=body.excludedRoles??old?.excludedRoles??[];
  if(!Array.isArray(excludedRoles)||excludedRoles.length>roles.length||new Set(excludedRoles).size!==excludedRoles.length||excludedRoles.some(id=>!roles.some(r=>r.id===id)))fail('Выберите уникальные должности для исключения');
  const roleSource=body.roleSource??old?.roleSource??'monthly-review';
  if(!['monthly-review','current-profile'].includes(roleSource))fail('Выберите источник должностей для командного KPI');
  // caps remain the original weights. Redistributed amounts never feed back into them.
  if(body.rebasePast===true&&(!body.reason||String(body.reason).trim().length<3))fail('Укажите основание пересчёта должностей прошлого месяца');
  const caps=peopleCaps(month,roleSource,old,body.rebasePast===true),remaining=caps.filter(c=>!excludedRoles.includes(c.roleId));
  if(excludedRoles.length&&(!remaining.length||!remaining.some(c=>c.maximum>0)))fail('Для перераспределения нужен участвующий сотрудник с положительным лимитом');
  const budgetMode=body.budgetMode??old?.budgetMode??'caps';if(!['caps','fixed'].includes(budgetMode))fail('Выберите режим фонда');
  const budgetMinor=budgetMode==='fixed'?(body.budget===undefined?old?.budgetMinor:money(body.budget)):null;
  if(budgetMode==='fixed'&&(!amount(budgetMinor)||budgetMinor<0||budgetMinor>0&&!caps.some(c=>c.maximum>0)))fail('Проверьте максимальный фонд премий');
  const policy={schema:1,method:'previous-month-net-turnover',month,basisMonth,...(roleSource==='current-profile'?{roleSource}:{}),...(budgetMode==='fixed'?{budgetMode,budgetMinor}:{}),...(teamWeight!==100||personalWeight!==0?{teamWeight,personalWeight}:{}),...(excludedRoles.length?{excludedRoles:[...excludedRoles].sort()}:{}),source:{organization:source.current.organization,currentFingerprint:source.current.fingerprint,basisFingerprint:source.basis.fingerprint,currentAsOf:source.current.asOf,basisAsOf:source.basis.asOf},caps};
  return {policy,old,version};
 }
 function savePrepared(prepared,actor,reason='Настройка командной премии'){
  const {policy,old,version}=prepared,month=policy.month;
  if(policyVersion(read(month))!==version)fail('Настройка командного KPI изменилась. Повторите расчёт',409);
  db.prepare('INSERT INTO turnover_kpi_policies VALUES(?,?,?) ON CONFLICT(month) DO UPDATE SET json=excluded.json,created=excluded.created').run(month,JSON.stringify(policy),clock());
  db.prepare('INSERT INTO turnover_kpi_audit(month,actor,action,json,at) VALUES(?,?,?,?,?)').run(month,String(actor.id||'owner'),'configure',JSON.stringify({basisMonth:policy.basisMonth,method:policy.method,roleSource:policy.roleSource||'monthly-review',previousRoleSource:old?.roleSource||'monthly-review',people:policy.caps.length,excludedRoles:policy.excludedRoles||[],previousExcludedRoles:old?.excludedRoles||[],redistributionMethod:'proportional-largest-remainder',previousVersion:version,version:policyVersion(policy),source:policy.source,reason}),clock());
 }
 function configure(body,actor){
  const first=prepare(body,actor);if(first.version===policyVersion(first.policy))return {ok:true,duplicate:true,...view(first.policy.month,actor)};
  transaction(()=>{const again=prepare(body,actor);if(policyVersion(again.policy)!==policyVersion(first.policy))fail('Источники расчёта изменились. Повторите расчёт',409);savePrepared(again,actor,String(body.reason||'Настройка командной премии'));});return {ok:true,...view(first.policy.month,actor)};
 }
 const previewFingerprint=v=>hash({version:v.version,status:v.status,rows:v.rows.map(r=>({employee:r.employee,maximum:r.maximum,proposal:r.proposal,score:r.score,excluded:!!r.excluded,accountConfigured:r.accountConfigured,posted:r.posted})),source:v.source});
 function preview(body,actor){
  const prepared=prepare(body,actor),month=prepared.policy.month,before=view(month,actor),after=view(month,actor,{...prepared.policy,configuredAt:clock()}),previewId=randomUUID(),expires=clock()+900000;
  const saved={body,version:prepared.version,fingerprint:previewFingerprint(after)};
  db.prepare('INSERT INTO turnover_kpi_previews VALUES(?,?,?,?,?,?)').run(previewId,month,String(actor.id||'owner'),JSON.stringify(saved),clock(),expires);
  const delta=(a,b)=>typeof a==='number'&&typeof b==='number'?b-a:null;
  const rows=after.rows.map(r=>{const previous=before.rows.find(b=>b.employee===r.employee),a=previous?.proposal??(before.configured?null:0);return {employee:r.employee,name:r.name,before:a,after:r.proposal,difference:delta(a,r.proposal)}});
  return {previewId,expires,month,before,after,rows,totals:{before:before.configured?before.totals.proposal:0,after:after.totals.proposal,difference:delta(before.configured?before.totals.proposal:0,after.totals.proposal)}};
 }
 function commit(body,actor){
  if(!actor?.admin)fail('Сохранение расчёта доступно администратору',403);const reason=String(body.reason||'').trim();if(reason.length<3||reason.length>1000)fail('Укажите основание сохранения расчёта');
  return transaction(()=>{const saved=db.prepare('SELECT * FROM turnover_kpi_previews WHERE id=? AND actor=?').get(body.previewId,String(actor.id||'owner'));if(!saved||saved.expires<clock())fail('Предпросмотр истёк или недоступен. Рассчитайте заново',409);const input=parse(saved.json),prepared=prepare(input.body,actor),after=view(saved.month,actor,{...prepared.policy,configuredAt:clock()});if(prepared.version!==input.version||previewFingerprint(after)!==input.fingerprint)fail('Исходные данные изменились. Рассчитайте заново',409);if(prepared.version!==policyVersion(prepared.policy))savePrepared(prepared,actor,reason);db.prepare('DELETE FROM turnover_kpi_previews WHERE id=?').run(body.previewId);return {ok:true,...view(saved.month,actor)};});
 }
 function approve(body,actor){
  if(!actor?.admin&&!['finance','payroll','hr_month'].some(k=>actor?.permissions?.[k]==='write'))fail('Нет права начисления премии',403);validate(body.month);
  const old=db.prepare('SELECT * FROM turnover_kpi_posts WHERE employee=? AND month=?').get(body.employee,body.month);if(old){const own=postedOwn(body.employee,body.month);if(!own?.posted)fail('Начисление отменено. Требуется отдельная корректировка',409);return {ok:true,duplicate:true,entryId:old.entry};}
  const reason=String(body.reason||'').trim();if(reason.length<3||reason.length>1000)fail('Укажите основание начисления премии');if(!postBonus)fail('Начисление премии не подключено',409);
  return transaction(()=>{const v=view(body.month,{...actor,admin:true});if(v.version!==body.version)fail('Расчёт изменился. Обновите данные',409);const row=v.rows.find(r=>r.employee===body.employee);if(!row?.canApprove)fail(row?.postingBlockers.join('; ')||'Нет доступной премии',409);
   if(body.approvalFingerprint!==row.approvalFingerprint||body.expectedAmount!==row.proposal)fail('Сумма, показатели или фонд изменились. Обновите расчёт перед подтверждением',409);
   const entries=db.prepare('SELECT * FROM pay_entries WHERE employee=? AND month=? AND voided_at IS NULL').all(body.employee,body.month),rolePaid=entries.some(e=>e.request_id?.startsWith('finance:')||e.source?.startsWith('performance:')||e.source?.startsWith('hrplus:performance')||e.source?.startsWith('kpi:'));
   if(v.personalWeight>0&&rolePaid)fail('Личный KPI уже начислен отдельной премией. Нужна сверка или расчёт только командной части',409);
   if(rolePaid&&body.overlapConfirmed!==true)fail('Подтвердите, что командная премия не дублирует уже начисленные показатели',409);
   const result=postBonus({employee:body.employee,month:body.month,amount:row.proposal,reason:'Командная/личная премия KPI: '+row.score+'%. '+reason,date:localDate(clock(),tz).date});
   const entryId=result?.id,entry=entryId?db.prepare('SELECT * FROM pay_entries WHERE id=?').get(entryId):null;if(!entry||entry.employee!==body.employee||entry.month!==body.month||entry.amount!==row.proposal||entry.kind!=='bonus'||entry.source!=='turnover-kpi:'+body.month||entry.voided_at)fail('Не удалось проверить запись начисления премии',409);const snapshot={...row,posted:false,payoutReady:false};for(const k of ['name','employee','roleId','postingBlockers','canApprove','approvalFingerprint'])delete snapshot[k];
   db.prepare('INSERT INTO turnover_kpi_posts VALUES(?,?,?,?,?,?,?)').run(body.employee,body.month,entryId,row.proposal,v.version,JSON.stringify({...snapshot,personalWeight:v.personalWeight,teamWeight:v.teamWeight}),clock());
   db.prepare('INSERT INTO turnover_kpi_audit(month,actor,action,json,at) VALUES(?,?,?,?,?)').run(body.month,String(actor.id||'owner'),'post',JSON.stringify({employee:body.employee,entry:entryId,amount:row.proposal,version:v.version,reason,overlapConfirmed:body.overlapConfirmed===true}),clock());return {ok:true,id:entryId};});
 }
 function assertIndependent(employee,month){const row=db.prepare('SELECT json FROM turnover_kpi_posts WHERE employee=? AND month=?').get(employee,month);if(row&&parse(row.json)?.personalWeight>0)fail('Личная часть KPI уже включена в начисленную общую премию. Нужна отдельная сверка',409);}
 function sourceDraft(month,actor){
  if(!actor?.admin)fail('Нет доступа к проекту командного KPI',403);
  validate(month);
  const policy=read(month);
  if(!policy||policy.personalWeight===100)return null;
  const result=state(policy);
  if(result.status!=='stale'||result.current.organization!==policy.source.organization)return null;
  const {current,basis}=result;
  const draft=view(month,actor,{...policy,source:{organization:current.organization,currentFingerprint:current.fingerprint,basisFingerprint:basis.fingerprint,currentAsOf:current.asOf,basisAsOf:basis.asOf}});
  return {...draft,unsaved:true,payoutReady:false,rows:draft.rows.map(row=>({...row,canApprove:false,payoutReady:false}))};
 }
 return {configure,view,personal,latestPersonal,preview,commit,approve,assertIndependent,sourceDraft};
}
