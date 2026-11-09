import {randomUUID,createHash} from 'node:crypto';
import {localDate,validDate} from './model.mjs';
import {roles} from './role-catalog.mjs';

export const kpiAutoProviders=[
 {id:'manual',label:'Ручной факт из должностной оценки'},
 {id:'verified',label:'Подтверждённые проверки и документы'},
 {id:'task-timeliness',label:'Назначенные задания: результат сдан в срок'},
 {id:'task-first-pass',label:'Назначенные работы: приёмка с первого раза'},
 {id:'training-on-time',label:'Обучение с подтверждением наставника в срок'},
 {id:'vacancy-on-time',label:'Вакансии магазина: закрытие в срок'},
 {id:'sales-margin',label:'Личная валовая прибыль по продажам и возвратам'}
];
const providerIds=new Set(kpiAutoProviders.map(p=>p.id));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const monthOK=value=>typeof value==='string'&&/^(20\d\d|2100)-(0[1-9]|1[0-2])$/.test(value);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const safeJson=(value,fallback={})=>{try{return JSON.parse(value)}catch{return fallback}};
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x1f]/.test(value);

// This module reads factual registers and writes only configuration/evidence.
// It never creates salary, penalties, payments or performance observations.
export function initKpiAuto(db,{fail,transaction,tz='Asia/Tashkent',clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS kpi_auto_config(employee TEXT NOT NULL REFERENCES employees(id),month TEXT NOT NULL,json TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(employee,month));
 CREATE TABLE IF NOT EXISTS kpi_auto_measurements(id TEXT PRIMARY KEY,employee TEXT NOT NULL REFERENCES employees(id),role_id TEXT NOT NULL,day TEXT NOT NULL,metric_index INTEGER NOT NULL,numerator INTEGER NOT NULL,denominator INTEGER NOT NULL,note TEXT NOT NULL,source_ref TEXT NOT NULL,reviewer TEXT NOT NULL,created INTEGER NOT NULL,voided INTEGER NOT NULL DEFAULT 0);
 CREATE UNIQUE INDEX IF NOT EXISTS kpi_auto_measurement_source ON kpi_auto_measurements(employee,role_id,day,metric_index,source_ref) WHERE voided=0;
 CREATE TABLE IF NOT EXISTS kpi_auto_links(employee TEXT NOT NULL REFERENCES employees(id),month TEXT NOT NULL,role_id TEXT NOT NULL,metric_index INTEGER NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(employee,month,role_id,metric_index,source_kind,source_id));
 CREATE TABLE IF NOT EXISTS kpi_auto_audit(id INTEGER PRIMARY KEY,employee TEXT NOT NULL,month TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);`);
 const has=table=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
 const today=()=>localDate(clock(),tz).date;
 const person=id=>typeof id==='string'?db.prepare('SELECT id,name,active FROM employees WHERE id=?').get(id):null;
 const audit=(employee,month,actor,action,value)=>db.prepare('INSERT INTO kpi_auto_audit(employee,month,actor,action,json,at) VALUES(?,?,?,?,?,?)').run(employee,month,String(actor.id||'owner'),action,JSON.stringify(value),clock());
 const text=(value,label,max=1000)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail(label);return value.trim()};
 function period(employee,month){if(!person(employee)||!monthOK(month))fail('Выберите сотрудника и месяц');}
 function config(employee,month){const row=db.prepare('SELECT * FROM kpi_auto_config WHERE employee=? AND month=?').get(employee,month);return row?{...safeJson(row.json),version:row.version}:{enabled:false,reviewer:null,metrics:Array.from({length:4},(_,index)=>({index,provider:'manual',params:{}})),version:0};}
 function currentReview(employee,month){if(!has('role_reviews'))return null;const row=db.prepare('SELECT json FROM role_reviews WHERE employee=? AND month=?').get(employee,month);return row?safeJson(row.json,null):null;}
 function admin(actor){if(!actor?.admin)fail('Настройка автоматического KPI доступна администратору',403);}
 function canRead(actor){return !!(actor?.admin||['read','write'].includes(actor?.permissions?.hr_month)||['read','write'].includes(actor?.permissions?.hr_kpi));}
 function canEvidence(actor,employee,c){return !!(actor&&actor.employee!==employee&&!actorIsEmployee(actor.id,employee)&&(actor.admin||[actor.permissions?.hr_month,actor.permissions?.hr_kpi].includes('write')&&actor.employee&&actor.employee===c.reviewer&&person(actor.employee)?.active));}
 function evidenceGuard(actor,employee,c){if(!canEvidence(actor,employee,c))fail(actor?.employee===employee?'Свою работу подтверждает другой ответственный':'Вы не назначены проверяющим KPI',403);}
 function roleGuard(employee,month,c){if(!c.roleId||currentReview(employee,month)?.role!==c.roleId)fail('Должность изменилась; перенастройте источники KPI',409);}
 function unfrozen(employee,month){if(has('hr_monthly_posts')&&db.prepare('SELECT employee FROM hr_monthly_posts WHERE employee=? AND month=? LIMIT 1').get(employee,month)||has('pay_entries')&&db.prepare("SELECT id FROM pay_entries WHERE employee=? AND month=? AND request_id=?").get(employee,month,'finance:'+month+':'+employee))fail('Итоги месяца уже подтверждены; нужна отдельная сверка',409);}
 function paramsFor(provider,input={}){
  if(!plain(input))fail('Проверьте параметры источника');
  if(provider.startsWith('task-')){const ids=input.taskIds??[];if(!Array.isArray(ids)||ids.length>1000||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length||input.allAssigned!==undefined&&typeof input.allAssigned!=='boolean')fail('Выберите задания для показателя');if(input.allAssigned&&ids.length)fail('Выберите все назначенные задания или конкретный список');return {allAssigned:input.allAssigned===true,taskIds:ids};}
  if(provider==='training-on-time'){const scope=input.scope||'employee';if(!['employee','mentor'].includes(scope))fail('Проверьте область обучения');return {scope};}
  if(provider==='vacancy-on-time'){const ids=input.vacancyIds??[];if(typeof input.companyVerified!=='boolean'||!Array.isArray(ids)||ids.length>1000||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length)fail('Подтвердите область вакансий');return {companyVerified:input.companyVerified,vacancyIds:ids};}
  if(provider==='sales-margin'){const plan=input.planMinor??null;if(plan!==null&&(!Number.isSafeInteger(plan)||plan<=0||plan>999999999999)||input.planApproved!==undefined&&typeof input.planApproved!=='boolean'||input.source!==undefined&&!['fkassa-csv','moysklad'].includes(input.source))fail('Укажите утверждённый денежный план валовой прибыли');return {planMinor:plan,planApproved:input.planApproved===true,...(input.source?{source:input.source}:{})};}
  return {};
 }
 function metricBase(index,provider){return {index,provider,state:'missing',value:null,numerator:null,denominator:null,unit:'cases',sourceCount:0,sourceIds:[],reason:'Нет подтверждённых данных',checkedAt:clock()};}
 function ids(result,values){const unique=[...new Set(values.map(String))];result.sourceCount=unique.length;result.sourceIds=unique.slice(0,20);result.truncated=unique.length>20;return result;}
 function ratio(result,numerator,denominator,sourceIds,unit='cases'){
  result=ids({...result,numerator,denominator,unit},sourceIds);
  if(!Number.isSafeInteger(numerator)||!Number.isSafeInteger(denominator)||denominator<=0){result.reason='Нет достаточного подтверждённого объёма';return result;}
  const value=Math.round(Math.max(0,numerator)/denominator*10000);if(!Number.isSafeInteger(value)){result.state='blocked';result.reason='Слишком большой результат для расчёта';return result;}
  return {...result,state:'ready',value,reason:''};
 }
 function actorIsEmployee(actor,employee){if(String(actor||'')===employee)return true;if(has('web_accounts')){const cols=db.prepare('PRAGMA table_info(web_accounts)').all().map(c=>c.name);if(cols.includes('employee')&&cols.includes('id')&&db.prepare('SELECT employee FROM web_accounts WHERE id=?').get(String(actor))?.employee===employee)return true;}if(/^telegram:\d+$/.test(String(actor))&&has('tg_attendance_bindings')&&db.prepare('SELECT employee FROM tg_attendance_bindings WHERE chat=?').get(String(actor).slice(9))?.employee===employee)return true;return false;}
 const independent=(row,employee)=>row&&Number.isSafeInteger(row.at)&&row.at<=clock()&&row.actor&&!actorIsEmployee(row.actor,employee);
 function taskRows(employee,month,roleId,index,p){
  if(!has('work_orders')||!has('operations_audit'))return {reason:'Нет реестра заданий и подтверждений',rows:[]};
  const links=db.prepare("SELECT source_id FROM kpi_auto_links WHERE employee=? AND month=? AND role_id=? AND metric_index=? AND source_kind='task'").all(employee,month,roleId,index).map(r=>r.source_id),selected=new Set([...(p.taskIds||[]),...links]);
  if(!p.allAssigned&&!selected.size)return {reason:'Привяжите к показателю соответствующие задания',rows:[]};
  const rows=db.prepare('SELECT * FROM work_orders WHERE employee=? AND due LIKE ? ORDER BY due,id').all(employee,month+'-%').filter(r=>(p.allAssigned||selected.has(r.id))&&r.status!=='cancelled'&&(r.due<today()||r.due===today()&&['accepted','returned'].includes(r.status)));
  return {rows,reason:rows.length?'':'Нет заданий с наступившим сроком в этом месяце'};
 }
 function taskMetric(employee,month,roleId,index,provider,p,result){
  const selected=taskRows(employee,month,roleId,index,p);if(!selected.rows.length)return {...result,reason:selected.reason};
  if(selected.rows.some(r=>r.status==='submitted'))return ids({...result,state:'waiting-review',reason:'Есть сданные задания с наступившим сроком: требуется решение проверяющего'},selected.rows.map(r=>r.id));
  let rows=selected.rows,numerator=0;
  if(provider==='task-first-pass')rows=rows.filter(r=>['accepted','returned'].includes(r.status));
  if(!rows.length)return {...result,reason:'Нет работ с подтверждённой приёмкой или возвратом'};
  for(const row of rows){const history=db.prepare('SELECT action,actor,at FROM operations_audit WHERE entity=? ORDER BY at,id').all(row.id),accepted=history.filter(h=>h.action==='accepted').at(-1),returned=history.some(h=>h.action==='returned'&&independent(h,employee));
   if(row.status==='accepted'&&!independent(accepted,employee)||row.status==='returned'&&!returned)return ids({...result,state:'blocked',reason:'Есть работы без независимого подтверждения результата'},rows.map(r=>r.id));
   if(provider==='task-first-pass'){if(row.status==='accepted'&&!returned)numerator++;continue;}
   if(row.status!=='accepted')continue;
   const submission=history.filter(h=>h.action==='submitted'&&h.at<=accepted.at).at(-1);
   if(!submission||!Number.isSafeInteger(submission.at)||submission.at>clock()||!row.submitted_day||localDate(submission.at,tz).date!==row.submitted_day)return ids({...result,state:'blocked',reason:'Для принятой работы не найдено исходное время сдачи'},rows.map(r=>r.id));
   if(row.submitted_day<=row.due)numerator++;
  }
  return ratio(result,numerator,rows.length,rows.map(r=>r.id));
 }
 function trainingMetric(employee,month,p,result){
  if(!has('hr_academy_enrollments'))return {...result,reason:'Нет назначений учебного центра'};
  const column=p.scope==='mentor'?'mentor':'employee';
  const rows=db.prepare('SELECT * FROM hr_academy_enrollments WHERE '+column+'=? AND due LIKE ? ORDER BY due,id').all(employee,month+'-%').filter(r=>r.due<today()||r.due===today()&&r.completed);
  if(!rows.length)return {...result,reason:'Нет назначенного обучения с наступившим сроком'};
  let numerator=0;
  for(const r of rows){if(!r.completed)continue;const practice=safeJson(r.practice),valid=r.mentor!==r.employee&&Number.isSafeInteger(r.completed)&&r.completed<=clock()&&practice.status==='passed'&&Number.isSafeInteger(practice.at)&&practice.at<=r.completed&&practice.actor&&!actorIsEmployee(practice.actor,r.employee);
   if(!valid)return ids({...result,state:'blocked',reason:'Завершение обучения не подтверждено независимым наставником'},rows.map(v=>v.id));
   if(localDate(r.completed,tz).date<=r.due)numerator++;
  }
  return ratio(result,numerator,rows.length,rows.map(r=>r.id));
 }
 function vacancyMetric(month,p,result){
  if(!p.companyVerified)return {...result,reason:'Подтвердите ответственность за вакансии магазина'};
  if(!has('vacancies'))return {...result,reason:'Нет реестра вакансий'};
  const selected=new Set(p.vacancyIds||[]),rows=db.prepare('SELECT id,deadline,closed,status,slots,filled FROM vacancies WHERE deadline LIKE ? ORDER BY deadline,id').all(month+'-%').filter(r=>(!selected.size||selected.has(r.id))&&r.status!=='cancelled'&&(r.deadline<today()||r.deadline===today()&&r.status==='filled'));
  if(!rows.length)return {...result,reason:'Нет вакансий с наступившим сроком закрытия'};
  const numerator=rows.filter(r=>r.status==='filled'&&validDate(r.closed)&&r.closed<=r.deadline&&r.closed<=today()&&r.filled===r.slots).length;
  return ratio(result,numerator,rows.length,rows.map(r=>r.id));
 }
 function salesMetric(employee,month,p,result){
  if(!Number.isSafeInteger(p.planMinor)||p.planMinor<=0||p.planApproved!==true)return {...result,state:'needs-plan',reason:'Утвердите денежный план валовой прибыли; 100% само по себе не является планом в сумах'};
  if(!has('store_sales')||!has('store_sellers'))return {...result,reason:'Нет загруженных продаж и привязок продавцов'};
  const all=db.prepare('SELECT id,source,external,json FROM store_sales ORDER BY id').all().map(r=>({...safeJson(r.json),rowId:r.id,source:r.source,external:r.external})),index=new Map(all.map(r=>[r.source+':'+r.external,r])),rows=all.filter(r=>typeof r.date==='string'&&r.date.startsWith(month+'-')&&r.date<=today()&&(!p.source||p.source===r.source));
  if(!rows.length)return {...result,reason:'Продажи за период не загружены'};
  if(new Set(rows.map(r=>r.source)).size!==1)return {...result,state:'blocked',reason:'За месяц загружено несколько источников продаж; нужна сверка дубликатов'};
  const owned=[];let unmapped=false;
  for(const r of rows){const original=r.type==='return'&&r.original?index.get(r.source+':'+r.original):null,owner=r.type==='return'?original:r,mapped=owner?.seller?db.prepare('SELECT employee FROM store_sellers WHERE source=? AND seller=?').get(r.source,owner.seller)?.employee:null;
   if(!mapped){unmapped=true;continue;}if(mapped!==employee)continue;
   if(!['sale','return'].includes(r.type)||r.currency!=='UZS'||!Number.isSafeInteger(r.amount)||r.amount<0||!Number.isSafeInteger(r.cost)||r.cost<0)return ids({...result,state:'blocked',reason:'Нет подтверждённой себестоимости или корректного документа продажи/возврата'},[...owned.map(v=>v.rowId),r.rowId]);
   owned.push(r);
  }
  if(unmapped)return {...result,state:'blocked',reason:'Есть продажи или возвраты без однозначной привязки продавца'};
  if(!owned.length)return {...result,reason:'Нет продаж, закреплённых за этим сотрудником'};
  const margin=owned.reduce((sum,r)=>sum+(r.type==='sale'?1:-1)*(r.amount-r.cost),0);
  return ratio(result,margin,p.planMinor,owned.map(r=>r.rowId),'minor-UZS');
 }
 function compute(employee,month,metric,review){
  const index=metric.index,provider=metric.provider,p=metric.params||{},result=metricBase(index,provider);
  if(provider==='manual'){const value=review.actual?.[index]??null;return {...result,state:Number.isSafeInteger(value)&&value>=0?'ready':'missing',value:Number.isSafeInteger(value)&&value>=0?value:null,reason:value===null?'Ручной факт пока не заполнен':'Ручной факт из должностной оценки',unit:'percent-minor'};}
  if(provider==='verified'){const rows=db.prepare('SELECT id,numerator,denominator,reviewer FROM kpi_auto_measurements WHERE employee=? AND role_id=? AND day LIKE ? AND metric_index=? AND voided=0 ORDER BY day,id').all(employee,review.role,month+'-%',index);if(!rows.length)return {...result,reason:'Ответственный должен внести подтверждённую проверку и объём выборки'};if(rows.some(r=>actorIsEmployee(r.reviewer,employee)))return ids({...result,state:'blocked',reason:'Есть проверка, подтверждённая самим сотрудником'},rows.map(r=>r.id));return ratio(result,rows.reduce((n,r)=>n+r.numerator,0),rows.reduce((n,r)=>n+r.denominator,0),rows.map(r=>r.id));}
  if(provider.startsWith('task-'))return taskMetric(employee,month,review.role,index,provider,p,result);
  if(provider==='training-on-time')return trainingMetric(employee,month,p,result);
  if(provider==='vacancy-on-time')return vacancyMetric(month,p,result);
  if(provider==='sales-margin')return salesMetric(employee,month,p,result);
  return {...result,state:'blocked',reason:'Неизвестный источник; перенастройте показатель'};
 }
 function resolve(employee,month,review){
  if(monthOK(month)&&has('role_kpi_snapshots')){const snapshot=db.prepare('SELECT json FROM role_kpi_snapshots WHERE employee=? AND month=?').get(employee,month);if(snapshot)return JSON.parse(snapshot.json);}
  if(!review||!monthOK(month))return review;
  const c=config(employee,month),role=roles.find(r=>r.id===review.role),metrics=[];
  for(let index=0;index<4;index++){
   const m=c.enabled?c.metrics?.find(m=>m.index===index):{index,provider:'manual',params:{}};
   try{metrics.push(c.roleId&&c.roleId!==review.role?{...metricBase(index,m?.provider||'manual'),state:'blocked',reason:'Должность изменилась; перенастройте источники KPI'}:m?compute(employee,month,m,review):{...metricBase(index,'unknown'),state:'blocked',reason:'Источник показателя не настроен'});}catch{metrics.push({...metricBase(index,m?.provider||'unknown'),state:'blocked',reason:'Не удалось прочитать источник; проверьте данные и схему'});}
  }
  const weight=index=>role?.metrics[index]?.[1]||0,actual=c.enabled?metrics.map(m=>m.value):[...(review.actual||[null,null,null,null])],coverageWeight=metrics.reduce((n,m)=>n+(c.enabled&&m.provider!=='manual'?weight(m.index):0),0),readyWeight=metrics.reduce((n,m)=>n+(m.value!==null?weight(m.index):0),0),stable=metrics.map(({checkedAt,...m})=>m);
  const provisional=month>=today().slice(0,7),asOf=clock();
  return {...review,actual,automation:{enabled:c.enabled===true,version:c.version,reviewer:c.reviewer||null,metrics,coverageWeight,readyWeight,provisional,asOf,checkedAt:asOf,missing:metrics.filter(m=>m.value===null).map(m=>m.index),fingerprint:digest({config:c,role:review.role,metrics:stable,provisional})}};
 }
 function view(actor,employee,month){
  if(!canRead(actor))fail('Нет доступа к KPI',403);period(employee,month);const review=currentReview(employee,month),role=roles.find(r=>r.id===review?.role),c=config(employee,month);
  const measurements=db.prepare('SELECT * FROM kpi_auto_measurements WHERE employee=? AND role_id=? AND day LIKE ? ORDER BY day DESC,created DESC LIMIT 100').all(employee,role?.id||'',month+'-%').map(r=>({id:r.id,employee:r.employee,roleId:r.role_id,day:r.day,metricIndex:r.metric_index,numerator:r.numerator,denominator:r.denominator,note:r.note,sourceRef:r.source_ref,reviewer:r.reviewer,created:r.created,voided:!!r.voided}));
  const evidence=c.roleId===review?.role&&canEvidence(actor,employee,c);
  return {employee,month,roleId:role?.id||null,roleName:role?.name||null,config:c,providers:kpiAutoProviders,measurements,resolved:review?resolve(employee,month,review):null,canConfigure:!!actor.admin,canEvidence:evidence,permissions:{configure:!!actor.admin,evidence,void:evidence},availableReviewers:db.prepare('SELECT id,name FROM employees WHERE active=1 AND id<>? ORDER BY name').all(employee),tasks:has('work_orders')?db.prepare('SELECT id,title,due,status FROM work_orders WHERE employee=? AND due LIKE ? ORDER BY due,id LIMIT 100').all(employee,month+'-%'):[],links:db.prepare('SELECT metric_index metricIndex,source_kind sourceKind,source_id sourceId FROM kpi_auto_links WHERE employee=? AND month=? AND role_id=? ORDER BY metric_index,source_id').all(employee,month,role?.id||''),audit:db.prepare('SELECT actor,action,at FROM kpi_auto_audit WHERE employee=? AND month=? ORDER BY id DESC LIMIT 50').all(employee,month)};
 }
 function handle(action,b,actor){
  period(b.employee,b.month);const employee=b.employee,month=b.month,c=config(employee,month);unfrozen(employee,month);
  if(action==='configure'){
   admin(actor);if(!person(employee).active)fail('Сотрудник архивирован');if(b.version!==c.version)fail('Настройки KPI изменились. Обновите страницу',409);if(typeof b.enabled!=='boolean'||!Array.isArray(b.metrics)||b.metrics.length!==4)fail('Нужно настроить четыре показателя');
   const seen=new Set(),metrics=b.metrics.map(m=>{if(!plain(m)||!Number.isInteger(m.index)||m.index<0||m.index>3||seen.has(m.index)||!providerIds.has(m.provider))fail('Проверьте четыре источника KPI');seen.add(m.index);return {index:m.index,provider:m.provider,params:paramsFor(m.provider,m.params||{})};}).sort((a,b)=>a.index-b.index);
   for(const m of metrics)if(m.provider.startsWith('task-')&&m.params.taskIds.length){if(!has('work_orders'))fail('Нет реестра заданий');for(const id of m.params.taskIds)if(!db.prepare('SELECT id FROM work_orders WHERE id=? AND employee=? AND due LIKE ?').get(id,employee,month+'-%'))fail('Задание другого сотрудника или периода недоступно',403);}
   const reviewer=b.reviewer||null;if(reviewer!==null&&(reviewer===employee||!person(reviewer)?.active))fail('Выберите другого действующего сотрудника для проверки');const review=currentReview(employee,month);if(!review||!roles.some(r=>r.id===review.role))fail('Сначала назначьте должностной шаблон KPI');const reason=text(b.reason,'Укажите основание настройки',500),next={enabled:b.enabled,reviewer,roleId:review.role,metrics};
   return transaction(()=>{if(config(employee,month).version!==c.version)fail('Настройки изменились',409);roleGuard(employee,month,next);unfrozen(employee,month);db.prepare('INSERT INTO kpi_auto_config VALUES(?,?,?,?) ON CONFLICT(employee,month) DO UPDATE SET json=excluded.json,version=excluded.version').run(employee,month,JSON.stringify(next),c.version+1);audit(employee,month,actor,'configure',{before:c,after:next,reason});return {ok:true,version:c.version+1};});
  }
  evidenceGuard(actor,employee,c);roleGuard(employee,month,c);
  if(action==='evidence'){
   if(!validDate(b.day)||!b.day.startsWith(month+'-')||b.day>today()||!Number.isInteger(b.metricIndex)||b.metricIndex<0||b.metricIndex>3||!Number.isSafeInteger(b.numerator)||!Number.isSafeInteger(b.denominator)||b.numerator<0||b.denominator<=0||b.denominator>1000000000||b.numerator>b.denominator)fail('Укажите дату и проверенный результат из положительного объёма');
   if(!c.enabled||c.metrics?.find(m=>m.index===b.metricIndex)?.provider!=='verified')fail('Для показателя не включён источник подтверждённых проверок');const note=text(b.note,'Укажите результат проверки и исключения'),sourceRef=text(b.sourceRef,'Укажите документ или уникальный номер проверки',300);
   return transaction(()=>{unfrozen(employee,month);const latest=config(employee,month);evidenceGuard(actor,employee,latest);roleGuard(employee,month,latest);if(latest.version!==c.version)fail('Настройки изменились. Обновите страницу',409);const old=db.prepare('SELECT * FROM kpi_auto_measurements WHERE employee=? AND role_id=? AND day=? AND metric_index=? AND source_ref=? AND voided=0').get(employee,c.roleId,b.day,b.metricIndex,sourceRef);if(old){if(old.numerator===b.numerator&&old.denominator===b.denominator&&old.note===note)return {ok:true,id:old.id,duplicate:true};fail('Документ уже учтён с другими результатами. Сначала отмените ошибочную проверку',409);}const id=randomUUID();db.prepare('INSERT INTO kpi_auto_measurements(id,employee,role_id,day,metric_index,numerator,denominator,note,source_ref,reviewer,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,employee,c.roleId,b.day,b.metricIndex,b.numerator,b.denominator,note,sourceRef,String(actor.id||'owner'),clock());audit(employee,month,actor,'evidence',{id,roleId:c.roleId,day:b.day,metricIndex:b.metricIndex,numerator:b.numerator,denominator:b.denominator,sourceRef});return {ok:true,id};});
  }
  if(action==='void'){
   const reason=text(b.reason,'Укажите причину отмены проверки',500);return transaction(()=>{unfrozen(employee,month);const latest=config(employee,month);evidenceGuard(actor,employee,latest);roleGuard(employee,month,latest);const r=db.prepare('SELECT * FROM kpi_auto_measurements WHERE id=? AND employee=? AND role_id=? AND day LIKE ?').get(b.id,employee,latest.roleId,month+'-%');if(!r)fail('Проверка не найдена',404);if(r.voided)return {ok:true,duplicate:true};db.prepare('UPDATE kpi_auto_measurements SET voided=1 WHERE id=?').run(r.id);audit(employee,month,actor,'evidence-void',{id:r.id,roleId:r.role_id,reason});return {ok:true};});
  }
  if(action==='link-task'){
   if(!c.enabled||!Number.isInteger(b.metricIndex)||b.metricIndex<0||b.metricIndex>3||!c.metrics?.find(m=>m.index===b.metricIndex)?.provider?.startsWith('task-')||!has('work_orders'))fail('Выберите показатель заданий');const task=db.prepare('SELECT id FROM work_orders WHERE id=? AND employee=? AND due LIKE ?').get(b.order,employee,month+'-%');if(!task)fail('Задание другого сотрудника или периода недоступно',403);const reason=text(b.reason,'Укажите основание связи задания с KPI',500);return transaction(()=>{unfrozen(employee,month);const latest=config(employee,month);evidenceGuard(actor,employee,latest);roleGuard(employee,month,latest);if(latest.version!==c.version)fail('Настройки изменились. Обновите страницу',409);const created=db.prepare("INSERT OR IGNORE INTO kpi_auto_links(employee,month,role_id,metric_index,source_kind,source_id,actor,created) VALUES(?,?,?,?,'task',?,?,?)").run(employee,month,c.roleId,b.metricIndex,task.id,String(actor.id||'owner'),clock()).changes;if(created)audit(employee,month,actor,'link-task',{roleId:c.roleId,metricIndex:b.metricIndex,order:task.id,reason});return {ok:true,duplicate:!created};});
  }
  fail('Действие KPI не найдено',404);
 }
 return {resolve,view,handle};
}
