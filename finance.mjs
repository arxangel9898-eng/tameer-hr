import {createHash} from 'node:crypto';
import {roles,commonRules} from './role-catalog.mjs';
import {money,monthOK,decimal} from './payroll.mjs';
import {localDate} from './model.mjs';
// Shared with the HR dashboard. Missing facts are not a zero performance score.
export function roleKpiResult(role,review){
 const metrics=role.metrics.map((m,i)=>{
  const numerator=review.actual?.[i]??null,denominator=review.targets?.[i],valid=Number.isSafeInteger(numerator)&&numerator>=0&&Number.isSafeInteger(denominator)&&denominator>0;
  const guidance=role.metricGuidance?.[i]||null;
  return {key:'role:'+i,label:m[0],weight:m[1],numerator,denominator,unit:m[3],guidance,hint:guidance?[guidance.numerator,guidance.denominator,guidance.dataSource].filter(Boolean).join(' · '):'',score:valid?Math.min(100,Math.round(numerator/denominator*10000)/100):null,source:'role-review'};
 });
 const complete=metrics.every(m=>m.score!==null),score=complete?Math.round(metrics.reduce((n,m)=>n+m.score*m.weight,0))/100:null;
 return {metrics,complete,score};
}
export function initFinance(db,{payroll,fail,tz,clock=Date.now,transaction=fn=>fn(),resolveRoleReview=(_e,_m,r)=>r}){
 db.exec(`CREATE TABLE IF NOT EXISTS finance_periods(month TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS role_reviews(employee TEXT NOT NULL REFERENCES employees(id),month TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(employee,month));
 CREATE TABLE IF NOT EXISTS role_kpi_snapshots(employee TEXT NOT NULL REFERENCES employees(id),month TEXT NOT NULL,json TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(employee,month));`);
 const paid=month=>db.prepare("SELECT COALESCE(SUM(amount),0) n FROM pay_entries WHERE month=? AND kind IN ('advance','payout') AND voided_at IS NULL").get(month).n;
 const paidOnDate=(month,currency)=>db.prepare("SELECT COALESCE(SUM(e.amount),0) n FROM pay_entries e JOIN pay_accounts a ON a.employee=e.employee AND a.month=e.month WHERE e.date LIKE ? AND a.currency=? AND e.kind IN ('advance','payout') AND e.voided_at IS NULL").get(month+'-%',currency).n;
 const valid=m=>{if(!monthOK(m))fail('Выберите расчётный месяц')};
 const read=m=>{valid(m);const x=db.prepare('SELECT json FROM finance_periods WHERE month=?').get(m);return x?JSON.parse(x.json):null};
 function view(month){const input=read(month),p=payroll.view(month);const reviews=db.prepare('SELECT * FROM role_reviews WHERE month=?').all(month);
  const accrued=p.rows.reduce((n,r)=>n+r.totals.accrued,0),currentOwed=p.rows.reduce((n,r)=>n+Math.max(0,r.totals.remaining),0),priorOwed=(p.priorBalances||[]).filter(r=>r.currency===p.settings.currency).reduce((n,r)=>n+Math.max(0,r.remaining),0),owed=currentOwed+priorOwed;
  const prior=p.rows.flatMap(r=>r.entries).filter(e=>(e.request_id.startsWith('finance:'+month+':')||e.source?.startsWith('turnover-kpi:'))&&!e.voided_at).reduce((n,e)=>n+e.amount,0);
  const gross=input?input.revenue-input.cost:0,profit=input?gross-input.expenses-accrued:0;
  const availableCash=input?input.cash-((input.cashFlowVersion===2?paidOnDate(month,input.currency||p.settings.currency):paid(month))-input.paidSnapshot):0;
  const cashRefreshRequired=!!input&&input.cashFlowVersion!==2&&priorOwed>0;
  const pool=input&&!cashRefreshRequired?Math.max(0,Math.min(Math.floor(Math.max(0,profit)*input.share/100),input.budget-prior,availableCash-owed-input.reserve)):0;
  const rows=p.rows.map(r=>{const raw=reviews.find(x=>x.employee===r.employee.id),review=raw?JSON.parse(raw.json):null,role=roles.find(x=>x.id===review?.role),resolved=role?resolveRoleReview(r.employee.id,month,review):review;const posted=r.entries.find(e=>e.request_id==='finance:'+month+':'+r.employee.id);
   const {complete,score}=role?roleKpiResult(role,resolved):{complete:false,score:null};
   const desired=complete&&!(resolved?.automation?.enabled&&resolved.automation.provisional)&&r.employee.active&&!posted&&r.account?Math.floor(review.maximum*score/100):0;
   return {employee:r.employee,review,role:role?.name,score,desired,resolvedActual:resolved?.actual||null,automation:resolved?.automation||null,posted:posted?{voided:!!posted.voided_at,amount:posted.amount}:null,remaining:r.totals.remaining,account:!!r.account};});
  const requested=rows.reduce((n,r)=>n+r.desired,0);for(const r of rows){r.suggested=requested>pool?Number(BigInt(r.desired)*BigInt(pool)/BigInt(requested)):r.desired;r.after=r.remaining+r.suggested}
  const stableRows=rows.map(({automation,...row})=>({...row,automation:automation?{enabled:automation.enabled,fingerprint:automation.fingerprint,metrics:automation.metrics?.map(({checkedAt,...metric})=>metric)}:null}));
  const version=createHash('sha256').update(JSON.stringify({input,availableCash,accrued,owed,rows:stableRows})).digest('hex');
  return {month,currency:p.settings.currency,input,availableCash,roles,commonRules,accrued,owed,currentOwed,priorOwed,cashRefreshRequired,gross,profit,pool,requested,rows,version,advice:!input?'Заполните финансовые данные месяца.':cashRefreshRequired?'Есть задолженность за прошлые месяцы. Обновите текущий денежный остаток в финансовых настройках перед назначением новых премий.':profit<=0?'После расходов и начисленного заработка прибыль отсутствует: новая премия не предлагается.':availableCash-owed-input.reserve<=0?'Свободных денег после остатка зарплаты и резерва нет. Сначала проверьте обязательства и поступления.':requested>pool?'Запрошенные премии превышают доступный фонд и уменьшены пропорционально.':'Премии укладываются в заданный фонд. Проверьте факты и подтвердите выплаты по каждому сотруднику.'};
 }
 function handle(path,b){valid(b.month);
  if(path==='/api/finance/period'){const input={};for(const k of ['revenue','cost','expenses','cash','reserve','budget'])input[k]=money(b[k]);if(typeof b.share!=='number'||!Number.isFinite(b.share)||b.share<0||b.share>100)fail('Доля прибыли: от 0 до 100%');input.share=b.share;input.cashFlowVersion=2;input.cashCheckedAt=clock();input.currency=payroll.config?.().currency||payroll.view(b.month).settings.currency;input.paidSnapshot=paidOnDate(b.month,input.currency);db.prepare('INSERT INTO finance_periods VALUES(?,?) ON CONFLICT(month) DO UPDATE SET json=excluded.json').run(b.month,JSON.stringify(input));payroll.audit('finance-period',null,b.month,input);return {ok:true}}
  payroll.validateEmployee(b.employee);
  if(path==='/api/finance/review'){const role=roles.find(r=>r.id===b.role);if(!role)fail('Выберите должность');if(!Array.isArray(b.actual)||!Array.isArray(b.targets)||b.actual.length!==4||b.targets.length!==4)fail('Заполните четыре KPI');let actual=b.actual.map(x=>x===null?null:money(x));const targets=b.targets.map(money);if(targets.some(x=>x<=0))fail('План должен быть больше нуля');if(typeof b.evidence!=='string'||!b.evidence.trim()||b.evidence.length>1000)fail('Укажите источник проверки показателей');if(db.prepare('SELECT id FROM pay_entries WHERE request_id=?').get('finance:'+b.month+':'+b.employee)||db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hr_monthly_posts'").get()&&db.prepare('SELECT employee FROM hr_monthly_posts WHERE employee=? AND month=? LIMIT 1').get(b.employee,b.month))fail('Оценка уже подтверждалась; история зафиксирована');const oldRow=db.prepare('SELECT json FROM role_reviews WHERE employee=? AND month=?').get(b.employee,b.month),old=oldRow?JSON.parse(oldRow.json):null;if(old?.role===role.id){const resolved=resolveRoleReview(b.employee,b.month,old);if(resolved?.automation?.enabled)actual=actual.map((v,i)=>resolved.automation.metrics?.[i]?.provider!=='manual'?(old.actual?.[i]??null):v);}const review={role:role.id,actual,targets,maximum:money(b.maximum),evidence:b.evidence.trim()};db.prepare('INSERT INTO role_reviews VALUES(?,?,?) ON CONFLICT(employee,month) DO UPDATE SET json=excluded.json').run(b.employee,b.month,JSON.stringify(review));payroll.audit('role-review',b.employee,b.month,review);return {ok:true}}
  if(path==='/api/finance/approve'){const raw=db.prepare('SELECT json FROM role_reviews WHERE employee=? AND month=?').get(b.employee,b.month),automatic=raw&&resolveRoleReview(b.employee,b.month,JSON.parse(raw.json))?.automation?.enabled;const approve=()=>{const v=view(b.month);if(v.version!==b.version)fail('Расчёт изменился. Обновите предложение и подтвердите снова.',409);const r=v.rows.find(x=>x.employee.id===b.employee);if(!r?.suggested||r.posted)fail('Нет новой премии для подтверждения');const snapshot=r.automation?.enabled?resolveRoleReview(b.employee,b.month,r.review):null,result=payroll.handle('/api/payroll/entry',{employee:b.employee,month:b.month,requestId:'finance:'+b.month+':'+b.employee,kind:'bonus',amount:decimal(r.suggested),date:localDate(clock(),tz).date,reason:`Премия по должности: ${r.role}; KPI ${r.score.toFixed(1)}%; фонд ограничен прибылью и денежным резервом`});if(snapshot)db.prepare('INSERT INTO role_kpi_snapshots VALUES(?,?,?,?)').run(b.employee,b.month,JSON.stringify(snapshot),clock());return result;};return automatic?transaction(approve):approve();}
  fail('Действие не найдено',404);
 }
 return {view,handle};
}
