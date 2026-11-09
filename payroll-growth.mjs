import {createHash,randomUUID} from 'node:crypto';
import {money,monthOK,kpiBonus} from './payroll.mjs';
import {localDate,validDate} from './model.mjs';

const MAX=999999999999;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse=value=>{try{return JSON.parse(value)}catch{return null}};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const minor=value=>Number.isSafeInteger(value)&&value>=0&&value<=MAX;
const defaults=[
 {id:'trainee',name:'Стажёр',level:1,requirements:'Освоить правила магазина и основные обязанности. Работать с поддержкой наставника.'},
 {id:'specialist',name:'Специалист',level:2,requirements:'Самостоятельно выполнять согласованные обязанности и подтверждать результаты работы.'},
 {id:'senior',name:'Старший специалист',level:3,requirements:'Стабильно выполнять обязанности, помогать коллегам и подтверждать готовность к расширенной ответственности.'}
];

// Grade records and coaching are advisory. Neither a salary range nor a
// hypothetical improvement changes a wage, role, KPI fact or payment entry.
export function initPayrollGrowth(db,{fail,transaction=fn=>fn(),payroll,tz='Asia/Tashkent',clock=Date.now,settings=()=>({features:{grades:true,coach:true},responsibles:{}}),personalResult=()=>null}){
 db.exec(`CREATE TABLE IF NOT EXISTS payroll_grades(id TEXT PRIMARY KEY,json TEXT NOT NULL,version INTEGER NOT NULL,updated INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS payroll_grade_assignments(id TEXT PRIMARY KEY,employee TEXT NOT NULL,effective_date TEXT NOT NULL,grade TEXT NOT NULL,json TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,request_source TEXT UNIQUE);
 CREATE INDEX IF NOT EXISTS payroll_grade_assignments_period ON payroll_grade_assignments(employee,effective_date,created);
 CREATE TABLE IF NOT EXISTS payroll_growth_audit(id INTEGER PRIMARY KEY,employee TEXT,actor TEXT NOT NULL,action TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);`);
 for(const g of defaults)db.prepare('INSERT OR IGNORE INTO payroll_grades VALUES(?,?,1,?)').run(g.id,JSON.stringify({...g,currency:'UZS',baseMin:null,baseMid:null,baseMax:null,maxKpi:null,active:true}),clock());
 const today=()=>localDate(clock(),tz).date;
 const flags=()=>({grades:settings()?.features?.grades!==false,coach:settings()?.features?.coach!==false});
 const has=table=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
 const text=(value,label,max=1000,min=1)=>{if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)fail(label);return value.trim()};
 const person=id=>{const e=typeof id==='string'?db.prepare('SELECT id,name,role,active FROM employees WHERE id=?').get(id):null;if(!e)fail('Сотрудник не найден',404);return {...e,active:!!e.active}};
 const canRead=actor=>!!(actor?.admin||['read','write'].includes(actor?.permissions?.payroll));
 const canManage=actor=>{if(actor?.admin)return true;if(actor?.permissions?.payroll!=='write')return false;const ids=settings()?.responsibles?.grades;return !Array.isArray(ids)||!ids.length||ids.includes(actor.id)};
 const guard=actor=>{if(!canManage(actor))fail('Нет права на настройку уровней оплаты',403);if(!flags().grades)fail('Уровни оплаты выключены администратором',409)};
 const audit=(employee,actor,action,value)=>db.prepare('INSERT INTO payroll_growth_audit(employee,actor,action,json,at) VALUES(?,?,?,?,?)').run(employee||null,String(actor?.id||'owner'),action,JSON.stringify(value),clock());
 const rows=employee=>db.prepare('SELECT * FROM payroll_grade_assignments WHERE employee=? ORDER BY effective_date DESC,created DESC,rowid DESC').all(employee);
 const assignmentVersion=employee=>hash(rows(employee).map(r=>({id:r.id,effectiveDate:r.effective_date,grade:r.grade,json:r.json,reason:r.reason,created:r.created})));
 const gradeVersion=row=>hash({id:row.id,json:row.json,revision:row.version});
 const gradeDto=row=>({...parse(row.json),id:row.id,version:gradeVersion(row)});
 const grades=()=>db.prepare('SELECT * FROM payroll_grades ORDER BY json_extract(json,\'$.level\'),id').all().map(gradeDto);
 const date=value=>{if(typeof value!=='string'||!validDate(value)||value<'2000-01-01'||value>'2100-12-31')fail('Укажите корректную дату начала уровня');return value};
 const period=month=>{if(!monthOK(month))fail('Выберите расчётный месяц');return month};
 const asOf=month=>{const end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);return end<today()?end:today()};
 const checkedVersion=(actual,expected)=>{if(expected!==actual)fail('Данные изменились. Обновите экран и повторите действие',409)};
 function assignmentDtos(employee,month){
  const day=asOf(month),list=rows(employee),active=list.find(r=>r.effective_date<=day)?.id;
  return list.map(r=>{const g=parse(r.json)?.grade||{};return {id:r.id,gradeId:r.grade,gradeName:g.name||'',level:g.level,currency:g.currency,baseMin:g.baseMin,baseMid:g.baseMid,baseMax:g.baseMax,maxKpi:g.maxKpi,requirements:g.requirements||'',gradeVersion:g.version,effectiveDate:r.effective_date,reason:r.reason,status:r.effective_date>day?'scheduled':r.id===active?'active':'historical'};});
 }
 function factTime(employee,month,metricId){
  if(!has('pay_audit'))return null;const columns=db.prepare('PRAGMA table_info(pay_audit)').all().map(r=>r.name);if(!['employee','month','action','details','at'].every(c=>columns.includes(c)))return null;
  const at=db.prepare("SELECT at FROM pay_audit WHERE employee=? AND month=? AND action='kpi' AND json_valid(details) AND json_extract(details,'$.id')=? ORDER BY at DESC LIMIT 1").get(employee,month,metricId)?.at;
  return Number.isSafeInteger(at)&&at<=clock()?at:null;
 }
 function metricAdvice(metric){
  if(metric.posted)return {action:'frozen',whatToDo:'Показатель уже начислен. Изменения оформляются отдельной согласованной корректировкой.'};
  if(metric.missing)return {action:'verify-fact',whatToDo:'Подтвердите план и фактический результат. Без данных прирост премии не рассчитывается.'};
  if(metric.shortfall<=0)return {action:'target-reached',whatToDo:'План достигнут. Сохраняйте качество и подтверждения результата.'};
  return {action:'improve-result',whatToDo:'До плана осталось '+metric.shortfall+' '+(metric.unit||'ед.')+'. Согласуйте действия с ответственным и подтвердите новый результат.'};
 }
 function roleCoach(employee,month,alreadyPosted=false){
  let value;try{value=personalResult(employee,month)}catch{return {complete:false,score:null,maximum:null,provisional:false,metrics:[],projectMinor:null,reason:'Подтверждённые должностные показатели пока недоступны'}};
  if(!plain(value)||!Array.isArray(value.metrics))return {complete:false,score:null,maximum:null,provisional:false,metrics:[],projectMinor:null,reason:'План должностных KPI за этот месяц не задан'};
  const provisional=value.provisional===true||value.automation?.provisional===true,maximum=minor(value.maximum)?value.maximum:null,posted=alreadyPosted||!!value.posted;
  const metrics=value.metrics.slice(0,20).map((m,index)=>{
   const rawActual=m.numerator,rawTarget=m.denominator,valid=Number.isSafeInteger(rawActual)&&rawActual>=0&&Number.isSafeInteger(rawTarget)&&rawTarget>0,weight=typeof m.weight==='number'&&Number.isFinite(m.weight)&&m.weight>=0&&m.weight<=100?m.weight:null,score=valid?Math.min(100,Math.round(rawActual/rawTarget*10000)/100):null,at=m.lastFactAt??m.evidenceAt;
   const metric={key:String(m.key||'role:'+index),label:String(m.label||'Показатель '+(index+1)).slice(0,160),actual:valid?rawActual/100:null,target:Number.isSafeInteger(rawTarget)&&rawTarget>0?rawTarget/100:null,unit:String(m.unit||'%').slice(0,60),score,weight,shortfall:valid?Math.max(0,rawTarget-rawActual)/100:null,missing:!valid,posted,source:String(m.guidance?.dataSource||m.source||value.evidence||'Должностная оценка').slice(0,400),lastFactAt:Number.isSafeInteger(at)&&at<=clock()?at:null,proposedBonusMinor:null,potentialBonusIncrementMinor:null,hypotheticalScore:null};return {...metric,...metricAdvice(metric)};
  });
  const complete=value.complete!==false&&metrics.length>0&&metrics.every(m=>!m.missing&&m.weight!==null)&&Math.abs(metrics.reduce((n,m)=>n+m.weight,0)-100)<1e-8;
  const weighted=complete?metrics.reduce((n,m)=>n+Math.round(m.score*100)*m.weight,0):null,score=complete?Math.round(weighted/100)/100:null;
  const projectMinor=complete&&!provisional&&!posted&&maximum!==null?Number(BigInt(maximum)*BigInt(Math.round(score*100))/10000n):null;
  if(projectMinor!==null)for(const m of metrics){const hypotheticalScore=Math.round((weighted+(10000-Math.round(m.score*100))*m.weight)/100)/100,after=Number(BigInt(maximum)*BigInt(Math.round(hypotheticalScore*100))/10000n);m.hypotheticalScore=hypotheticalScore;m.potentialBonusIncrementMinor=after-projectMinor;}
  return {complete,score,maximum,provisional,posted,metrics,projectMinor,reason:posted?'Результат уже начислен':!complete?'Не все показатели подтверждены':provisional?'Предварительные данные ещё требуют проверки':maximum===null?'Максимальная премия не задана':'',notice:'Прирост по одному показателю — условный расчёт при неизменных остальных фактах. Фонд и начисление проверяются отдельно.'};
 }
 function coach(employee,month){
  const s=payroll.statement(employee,month),manualMetrics=(s.metrics||[]).map(m=>{
   const valid=Number.isSafeInteger(m.actual)&&m.actual>=0&&Number.isSafeInteger(m.target)&&m.target>0&&minor(m.max_bonus),calculated=valid?kpiBonus(m.max_bonus,m.actual,m.target):null;
   const metric={id:m.id,key:'manual:'+m.id,label:m.name,actual:valid?m.actual/100:null,target:Number.isSafeInteger(m.target)&&m.target>0?m.target/100:null,unit:'ед.',score:valid?Math.min(100,Math.round(m.actual/m.target*10000)/100):null,weight:null,shortfall:valid?Math.max(0,m.target-m.actual)/100:null,missing:!valid,posted:!!m.posted,source:'Подтверждённый факт в показателе KPI',lastFactAt:factTime(employee,month,m.id),proposedBonusMinor:valid&&!m.posted?calculated:null,potentialBonusIncrementMinor:valid&&!m.posted?m.max_bonus-calculated:null,hypotheticalScore:valid&&!m.posted?100:null};return {...metric,...metricAdvice(metric)};
  });
  const pendingWork=(s.jobs||[]).filter(j=>!j.posted&&minor(j.calculated)).reduce((n,j)=>n+BigInt(j.calculated),0n),pendingWorkMinor=pendingWork<=BigInt(Number.MAX_SAFE_INTEGER)?Number(pendingWork):null,team=s.turnoverKpi||s.latestTurnoverKpi,rolePosted=(s.entries||[]).some(e=>!e.voided_at&&(e.request_id==='finance:'+month+':'+employee||e.source==='hrplus:performance:kpi'))||!!(s.turnoverKpi?.posted&&s.turnoverKpi?.personalWeight>0);
  return {month,currency:s.account?.currency||payroll.config?.().currency||'UZS',confirmed:{...s.totals},pendingWorkMinor,manualMetrics,role:roleCoach(employee,month,rolePosted),team:team?{month:team.month,score:team.score,proposal:team.proposal,maximum:team.maximum,status:team.status,posted:!!team.posted}:null,notice:'Подтверждённые начисления показаны отдельно. Проекты личного и командного KPI могут пересекаться и не складываются автоматически. Прогноз не является начислением или обещанием выплаты.'};
 }
 function own(employee,month){
  person(employee);period(month);const enabled=flags(),history=enabled.grades?assignmentDtos(employee,month):[],grade=history.find(g=>g.status==='active')||null;
  return {month,asOf:asOf(month),enabled,grade,gradeHistory:history,assignmentVersion:enabled.grades?assignmentVersion(employee):null,coach:enabled.coach?coach(employee,month):null};
 }
 function view(month,actor){
  if(!canRead(actor))fail('Нет доступа к уровням и личным KPI сотрудников',403);period(month);const enabled=flags(),people=db.prepare('SELECT id,name,role,active FROM employees ORDER BY active DESC,name,id').all().filter(e=>e.active||has('pay_accounts')&&db.prepare('SELECT employee FROM pay_accounts WHERE employee=? AND month=?').get(e.id,month));
  const employeeRows=people.map(e=>({employee:{...e,active:!!e.active},...own(e.id,month)})),catalog=enabled.grades?grades():[];
  return {month,asOf:asOf(month),enabled,canManage:enabled.grades&&canManage(actor),grades:catalog,employees:employeeRows,version:hash({catalog,employees:employeeRows.map(e=>({employee:e.employee.id,assignmentVersion:e.assignmentVersion}))})};
 }
 function handle(action,b,actor){
  if(!plain(b))fail('Проверьте данные уровня');guard(actor);
  if(action==='grade-save')return transaction(()=>{
   const id=b.id===undefined||b.id===null||b.id===''?randomUUID():text(b.id,'Выберите уровень',120),row=db.prepare('SELECT * FROM payroll_grades WHERE id=?').get(id);checkedVersion(row?gradeVersion(row):0,b.version);
   const name=text(b.name,'Укажите название уровня до 100 символов',100),requirements=text(b.requirements??'','Укажите требования до 2000 символов',2000,0),currency=text(b.currency,'Укажите валюту',3).toUpperCase();if(!['UZS','RUB','USD','EUR','KZT'].includes(currency)||!Number.isInteger(b.level)||b.level<1||b.level>100||typeof b.active!=='boolean')fail('Проверьте номер уровня, валюту и активность');
   const amounts={};for(const k of ['baseMin','baseMid','baseMax','maxKpi']){amounts[k]=b[k]===undefined||b[k]===null||b[k]===''?null:money(b[k]);if(amounts[k]!==null&&!minor(amounts[k]))fail('Проверьте денежные диапазоны уровня');}
   const range=[amounts.baseMin,amounts.baseMid,amounts.baseMax];if(range.some(x=>x!==null)&&range.some(x=>x===null)||range.every(x=>x!==null)&&!(range[0]<=range[1]&&range[1]<=range[2]))fail('Укажите минимум, середину и максимум в возрастающем порядке либо оставьте всю вилку пустой');
   const grade={id,name,level:b.level,currency,...amounts,requirements,active:b.active};db.prepare('INSERT INTO payroll_grades VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,version=payroll_grades.version+1,updated=excluded.updated').run(id,JSON.stringify(grade),clock());const saved=gradeDto(db.prepare('SELECT * FROM payroll_grades WHERE id=?').get(id));audit(null,actor,'grade-save',{id,before:row?gradeDto(row):null,after:saved});return {ok:true,grade:saved};
  });
  if(action==='grade-assign')return transaction(()=>{
   const e=person(b.employee);if(!e.active)fail('Сотрудник архивирован',409);const gradeId=text(b.gradeId,'Выберите уровень',120),effectiveDate=date(b.effectiveDate),reason=text(b.reason,'Укажите основание назначения уровня',1000,3),requestId=b.requestId===undefined?null:text(b.requestId,'Обновите код назначения',100),source=requestId?'grade:'+e.id+':'+requestId:null,input={gradeId,gradeVersion:b.gradeVersion??null,effectiveDate,reason};
   const prior=source?db.prepare('SELECT * FROM payroll_grade_assignments WHERE request_source=?').get(source):null;if(prior){if(JSON.stringify(parse(prior.json)?.input)!==JSON.stringify(input))fail('Код назначения уже использован для другого решения',409);return {ok:true,id:prior.id,duplicate:true,assignmentVersion:assignmentVersion(e.id)};}
   checkedVersion(assignmentVersion(e.id),b.version);const row=db.prepare('SELECT * FROM payroll_grades WHERE id=?').get(gradeId);if(!row)fail('Уровень не найден',404);const grade=gradeDto(row);if(!grade.active)fail('Уровень выключен',409);if(b.gradeVersion!==undefined)checkedVersion(grade.version,b.gradeVersion);
   const a=has('pay_accounts')?db.prepare('SELECT currency FROM pay_accounts WHERE employee=? AND month=?').get(e.id,effectiveDate.slice(0,7)):null,currency=a?.currency||payroll.config?.().currency;if(currency&&currency!==grade.currency)fail('Валюта уровня отличается от валюты расчёта сотрудника',409);
   const latest=rows(e.id)[0];if(latest&&latest.grade===gradeId&&latest.effective_date===effectiveDate&&latest.reason===reason&&parse(latest.json)?.grade?.version===grade.version)return {ok:true,id:latest.id,duplicate:true,assignmentVersion:assignmentVersion(e.id)};
   const id=randomUUID();db.prepare('INSERT INTO payroll_grade_assignments VALUES(?,?,?,?,?,?,?,?,?)').run(id,e.id,effectiveDate,gradeId,JSON.stringify({grade,input}),reason,String(actor?.id||'owner'),clock(),source);audit(e.id,actor,'grade-assign',{id,grade:gradeId,gradeVersion:grade.version,effectiveDate,reason});return {ok:true,id,scheduled:effectiveDate>today(),assignmentVersion:assignmentVersion(e.id)};
  });
  fail('Действие уровня оплаты не найдено',404);
 }
 return {view,own,handle};
}
