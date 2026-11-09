import {roleKpiResult} from './finance.mjs';
import {kpiAutoProviders} from './kpi-auto.mjs';

const financeHref='/#finance', payrollHref='/#payroll', closeHref='/#hrcenter';
const providers=new Map(kpiAutoProviders.map(provider=>[provider.id,provider.label]));
const enabled=(settings,key)=>settings.features?.[key]?.enabled!==false;
const major=value=>Number.isSafeInteger(value)?value/100:null;

function salesStatus(sales){
 const report=sales?.report, sourceAsOf=report?.asOf??null;
 if(!sales?.connected)return {sourceStatus:'disconnected',sourceAsOf,sourceDetail:'МойСклад не подключён'};
 if(sales.lastError||report?.stale)return {sourceStatus:'stale',sourceAsOf,sourceDetail:sales.lastError||'Сохранённый отчёт требует обновления'};
 if(!report)return {sourceStatus:'missing',sourceAsOf,sourceDetail:'Сохранённого отчёта за месяц пока нет'};
 if(report.provisional)return {sourceStatus:'provisional',sourceAsOf,sourceDetail:'Отчёт за текущий месяц предварительный'};
 if(report.status==='blocked')return {sourceStatus:'attention',sourceAsOf,sourceDetail:'Оборот сохранён. Проверьте документы с неподтверждённой себестоимостью'};
 return {sourceStatus:'ready',sourceAsOf,sourceDetail:'Сохранённый отчёт «МойСклад» за выбранный месяц доступен'};
}

function roleMetrics(financeRow,role){
 if(!financeRow?.review||!role)return [];
 const {review,resolvedActual,automation}=financeRow;
 return roleKpiResult(role,{...review,actual:resolvedActual??review.actual}).metrics.map((metric,index)=>{
  const evidence=automation?.metrics?.[index],source=providers.get(evidence?.provider)||metric.guidance?.dataSource||'Должностная оценка';
  const weighted=metric.score===null?null:Math.round(metric.score*metric.weight)/100;
  let detail=evidence?.reason||review.evidence||'';
  if(evidence?.unit==='minor-UZS'&&evidence.denominator>0&&Number.isSafeInteger(evidence.numerator)){
   const sum=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
   detail=[detail,`Валовая прибыль по связанным документам: ${sum.format(major(evidence.numerator))} из ${sum.format(major(evidence.denominator))} UZS`].filter(Boolean).join('. ');
  }
  return {label:metric.label,plan:major(metric.denominator),fact:major(metric.numerator),weight:metric.weight,
   percent:metric.score,contribution:weighted,unit:metric.unit,source,status:evidence?.state||(metric.score===null?'missing':'ready'),detail};
 });
}

function turnoverRow(row,team,roleRow,role){
 const teamWeight=row.teamWeight??team.teamWeight,personalWeight=row.personalWeight??team.personalWeight;
 const teamPercent=row.excluded||!teamWeight?null:row.teamScore??(personalWeight===0?row.score:null);
 const personalPercent=row.excluded||!personalWeight?null:row.personalScore??null;
 const metrics=[];
 if(!row.excluded&&teamWeight>0){
  const source=team.status==='proposal'?team.source:null;
  metrics.push({label:'Командный оборот',plan:major(source?.basisNet),fact:major(source?.currentNet),weight:teamWeight,
   percent:teamPercent,contribution:teamPercent===null?null:Math.round(teamPercent*teamWeight)/100,unit:'UZS',source:'МойСклад · продажи за вычетом возвратов',
   status:teamPercent===null?'missing':'ready',detail:source?
    `База сравнения — фактический чистый оборот за ${team.basisMonth}. Доля результата ограничена 100%.`:
    'Фактический оборот из подтверждённой версии сейчас недоступен'});
 }
 // A posted result carries its own scores. A live role review is only shown for a draft.
 if(!row.excluded&&personalWeight>0){
  metrics.push({label:'Личный KPI по должности',plan:100,fact:personalPercent,weight:personalWeight,percent:personalPercent,
   contribution:personalPercent===null?null:Math.round(personalPercent*personalWeight)/100,unit:'%',source:'Подтверждённые должностные показатели',
   status:personalPercent===null?'missing':'ready',detail:personalPercent===null?row.reason:'Вес в общем KPI'});
  if(!row.posted&&row.status!=='voided'){
   for(const metric of roleMetrics(roleRow,role))metrics.push({...metric,detail:['Вес в личной части KPI',metric.detail].filter(Boolean).join('. ')});
  }
 }
 const status=row.excluded?'excluded':row.status==='voided'?'voided':row.posted?'posted':row.canApprove?'ready':
  row.proposal===null||row.proposal>0||!row.accountConfigured?'attention':'draft';
 const detail=[team.unsaved&&!row.posted&&!row.excluded?'Пересчитанный проект. Проверьте и сохраните расчёт в разделе «Финансы».':null,row.reason,...(status==='attention'?row.postingBlockers||[]:[])];
 return {employeeId:row.employee,name:row.name,role:row.role,percent:row.score??null,teamPercent,personalPercent,
  amount:row.status==='voided'?null:row.posted?row.postedAmount:row.proposal,currency:row.currency||team.currency,status,
  maximum:row.maximum??null,redistributedAmount:row.redistribution?.addedProposal??null,detail:[...new Set(detail.filter(Boolean))].join(' · '),metrics,href:financeHref};
}

function individualRow(row,finance,people){
 const role=finance.roles.find(role=>role.id===row.review?.role);
 const currency=people.get(row.employee.id)?.currency||finance.currency;
 const detail=row.posted?.voided?'Начисление отменено. Нужна отдельная корректировка.':row.posted?'Премия начислена в расчётный листок.':
  !row.review?'Для сотрудника не настроен должностной KPI.':row.score===null?'Не все показатели подтверждены.':
  !row.account?'Создайте расчёт зарплаты за месяц.':row.automation?.provisional?'Факты за открытый месяц предварительные.':
  row.suggested<row.desired?'Проект ограничен доступным фондом премий.':'Сумма из действующего расчёта премий по должностям.';
 const status=row.posted?.voided?'voided':row.posted?'posted':row.score===null||!row.account?'attention':row.automation?.provisional?'draft':
  row.suggested>0?'ready':row.desired>0?'attention':'draft';
 return {employeeId:row.employee.id,name:row.employee.name,role:row.role||people.get(row.employee.id)?.role||'',percent:row.score??null,
  teamPercent:null,personalPercent:row.score??null,amount:row.posted?.voided?null:row.posted?row.posted.amount:row.score===null||!row.account||row.automation?.provisional?null:row.suggested,
  currency,status,maximum:row.review?.maximum??null,redistributedAmount:null,detail,metrics:roleMetrics(row,role),href:financeHref};
}

export function automationKpi(db,month,settings,{turnover,finance,sales,sourceDraft}){
 if(!enabled(settings,'kpi'))return {enabled:false,mode:'disabled',summary:{employees:0,ready:0,attention:0,posted:0},rows:[]};
 const saved=turnover(), team=saved?.status==='stale'?(sourceDraft?.()||saved):saved, finances=finance(), status=salesStatus(sales());
 if(['blocked','stale'].includes(saved?.status)){
  status.sourceStatus=saved.status;
  status.sourceDetail=team?.unsaved?'Проект обновлён по свежим отчётам. Для согласования проверьте и сохраните расчёт в «Финансы».':saved.warnings?.[0]||status.sourceDetail;
 }
 const people=new Map(db.prepare('SELECT e.id,e.role,a.currency FROM employees e LEFT JOIN pay_accounts a ON a.employee=e.id AND a.month=?').all(month).map(person=>[person.id,person]));
 const roleRows=new Map(finances.rows.map(row=>[row.employee.id,row]));
 const roles=new Map(finances.roles.map(role=>[role.id,role]));
 const teamRows=new Map((team?.rows||[]).map(row=>[row.employee,row]));
 const rows=finances.rows.map(row=>{
  const result=teamRows.get(row.employee.id);
  return result?turnoverRow(result,team,row,roles.get(row.review?.role)):individualRow(row,finances,people);
 });
 for(const result of teamRows.values()){
  if(!roleRows.has(result.employee))rows.push(turnoverRow(result,team,null,null));
 }
 return {enabled:true,mode:team?.configured?'turnover':'role',summary:{...status,employees:rows.length,
  ready:rows.filter(row=>row.status==='ready').length,attention:rows.filter(row=>['attention','voided'].includes(row.status)).length,
  posted:rows.filter(row=>row.status==='posted').length,teamPercent:team?.score??null,teamWeight:team?.teamWeight??null,
  personalWeight:team?.personalWeight??null,currency:team?.currency||finances.currency,basisMonth:team?.configured?team.basisMonth:null},rows};
}

const closeLabels={
 account:'Расчёт зарплаты',attendance:'Смены и разрешения','kpi-plan':'План KPI','kpi-data':'Факты KPI',
 'changed-post':'Изменения после подтверждения','kpi-overlap':'Повторное начисление KPI'
};

function pendingEmployees(db,month){
 const rows=db.prepare(`SELECT DISTINCT json_extract(change.value,'$.employee') AS employee
  FROM finance_approvals a, json_each(a.json,'$.diff.entries') change
  WHERE a.status='pending' AND json_extract(change.value,'$.month')=?
  UNION
  SELECT DISTINCT json_extract(change.value,'$.employee')
  FROM finance_approvals a, json_each(a.json,'$.diff.accounts') change
  WHERE a.status='pending' AND json_extract(change.value,'$.month')=?`).all(month,month);
 return new Set(rows.map(row=>row.employee));
}

export function automationReadiness(db,month,settings,{close,payrollControl,sales,turnover=()=>null}){
 if(!enabled(settings,'monthClose'))return {enabled:false,summary:{employees:0,ready:0,attention:0,pending:0,open:0},rows:[]};
 const period=close(), control=payrollControl(), status=salesStatus(sales()), team=turnover();
 const teamRows=new Map((team?.rows||[]).map(row=>[row.employee,row]));
 const proposals=new Map(period.proposals.map(proposal=>[proposal.id,proposal]));
 const anomalies=new Map(), pending=pendingEmployees(db,month);
 for(const check of control?.checks||[]){
  if(check.reviewed||check.code==='missing-account')continue;
  if(!anomalies.has(check.employee))anomalies.set(check.employee,[]);
  anomalies.get(check.employee).push(check);
 }
 const rows=period.rows.map(row=>{
  const id=row.employee.id, teamResult=teamRows.get(id);
  const checks=row.checks
   .filter(check=>!(teamResult&&['kpi-data','kpi-plan'].includes(check.code)))
   .map(check=>({label:closeLabels[check.code]||'Проверка закрытия',status:check.blocking?'attention':'warning',detail:check.message}));
  if(row.account)checks.push({label:'Расчёт зарплаты',status:'ready',detail:'Расчёт за выбранный месяц создан'});
  if(!row.checks.some(check=>check.code==='attendance'))checks.push({label:'Смены и разрешения',status:'ready',detail:'В завершившихся сменах нет пропущенных обязательных отметок'});
  if(teamResult){
   const teamStatus=teamResult.status==='voided'||!teamResult.excluded&&!teamResult.posted&&teamResult.proposal===null?'attention':'ready';
   checks.push({label:'Командный и личный KPI',status:teamStatus,detail:teamResult.reason});
  }else if(row.performance.complete)checks.push({label:'Факты KPI',status:'ready',detail:'Подтверждаемые показатели заполнены'});
  const personAnomalies=anomalies.get(id)||[];
  for(const check of personAnomalies){
   checks.push({label:check.code.startsWith('advance')||check.code==='missing-payment-document'?'Авансы и выплаты':'Сверка начислений',
    status:check.severity==='attention'?'attention':'warning',detail:check.message});
  }
  if(row.account&&control?.capabilities?.checks&&!personAnomalies.some(check=>check.code==='advance-over-earned'||check.code==='missing-payment-document')){
   checks.push({label:'Авансы и выплаты',status:'ready',detail:'Действующие проверки не выявили проблем с авансами и документами выплат'});
  }
  const items=row.proposals.map(id=>proposals.get(id)).filter(Boolean);
  for(const item of items.filter(item=>item.blockers.length>0)){
   checks.push({label:item.label,status:'attention',detail:item.blockers.join(' · ')});
  }
  const awaiting=pending.has(id),readyProposals=items.filter(item=>item.canConfirm).length;
  if(awaiting)checks.push({label:'Согласование',status:'pending',detail:'Есть операция, ожидающая решения в финансовых согласованиях'});
  if(readyProposals&&!awaiting)checks.push({label:'К подготовке согласования',status:'ready',detail:`Можно проверить и отправить на согласование: ${readyProposals}`});
  const needsReview=checks.some(check=>check.status==='attention'||check.status==='warning');
  const state=needsReview?'attention':awaiting?'pending':period.ended?'ready':'open';
  const detail={attention:'Есть замечания для ответственного',pending:'Ожидает финансового согласования',
   ready:readyProposals?'Готово к подготовке согласования':'По действующим проверкам замечаний нет',
   open:'Месяц ещё открыт'}[state];
  return {employeeId:id,name:row.employee.name,status:state,detail,checks,href:awaiting?payrollHref:closeHref,
   readyProposals,awaitingApproval:awaiting,amounts:row.account?{currency:row.account.currency,advance:row.totals.advance,payout:row.totals.payout,remaining:row.totals.remaining}:null};
 });
 return {enabled:true,summary:{...status,ended:period.ended,employees:rows.length,ready:rows.filter(row=>row.status==='ready').length,
  attention:rows.filter(row=>row.status==='attention').length,pending:rows.filter(row=>row.awaitingApproval).length,
  open:rows.filter(row=>row.status==='open').length},rows};
}
