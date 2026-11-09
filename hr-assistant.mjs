import {randomUUID} from 'node:crypto';
import {localDate,dayAdd,validDate,summarize} from './model.mjs';
import {roles} from './role-catalog.mjs';
export function initHRAssistant(db,{hr,finance,fail,transaction,tz,clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS hr_advice(id TEXT PRIMARY KEY,employee TEXT NOT NULL REFERENCES employees(id),period TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,evidence TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',decision TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,UNIQUE(employee,period,kind));
 CREATE TABLE IF NOT EXISTS hr_training_plans(employee TEXT NOT NULL,role TEXT NOT NULL,start TEXT NOT NULL,PRIMARY KEY(employee,role,start));
 CREATE TABLE IF NOT EXISTS hr_requests(id TEXT PRIMARY KEY,employee TEXT NOT NULL REFERENCES employees(id),kind TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',decision TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,source TEXT UNIQUE);
 CREATE TABLE IF NOT EXISTS hr_assistant_audit(id INTEGER PRIMARY KEY,entity TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,details TEXT NOT NULL,at INTEGER NOT NULL);`);
 const today=()=>localDate(clock(),tz).date;
 const clean=(s,max)=>{if(typeof s!=='string'||!s.trim()||s.length>max)fail('Заполните текст допустимой длины');return s.trim()};
 const audit=(id,action,actor,details)=>db.prepare('INSERT INTO hr_assistant_audit(entity,action,actor,details,at) VALUES(?,?,?,?,?)').run(id,action,actor,JSON.stringify(details),clock());
 function report(end=today()){
  if(!validDate(end)||end>today())fail('Выберите дату отчёта не позднее сегодня');
  const start=dayAdd(end,-6),h=hr.view(Number(end.slice(0,4))),f=finance.view(end.slice(0,7)),suggestions=[],staff=[];
  const add=(e,kind,title,evidence)=>suggestions.push({employee:e.id,name:e.name,period:end,kind,title,evidence});
  for(const e of h.staff.filter(x=>x.active)){
   const shifts=db.prepare('SELECT * FROM shifts WHERE employee=? AND day BETWEEN ? AND ?').all(e.id,start,end);
   let late=0,minutes=0,extra=0,missing=0;
   for(const s of shifts){if(hr.absence(e.id,s.day))continue;const r=summarize(s,db.prepare('SELECT * FROM events WHERE shift=? ORDER BY id').all(s.id),clock());if(r.in&&r.late){late++;minutes+=r.late}if(r.out)extra+=Math.max(0,Math.floor((r.out-s.planned_end)/60000));if(s.planned_end<clock()&&(!r.in||!r.out))missing++}
   const overdue=h.tasks.filter(t=>t.employee===e.id&&t.status==='open'&&t.due<today()).length;
   const done=h.tasks.filter(t=>t.employee===e.id&&t.status==='done').length;
   const k=f.rows.find(r=>r.employee.id===e.id);
   staff.push({name:e.name,role:e.role,shifts:shifts.length,late,minutes,extra,missing,overdue,done,score:k?.score??null});
   if(!e.hire_date)add(e,'profile','Заполнить дату приёма и план адаптации','В карточке отсутствует дата приёма.');
   else if(e.hire_date>=dayAdd(today(),-30)&&e.hire_date<=today())add(e,'onboarding','Провести адаптацию новичка','Дата приёма: '+e.hire_date+'. Назначьте наставника; изучите ассортимент, выдачу товара и безопасные методы работы.');
   if(late>=2)add(e,'schedule','Обсудить график и причины опозданий',`${start} — ${end}: ${late} опоздания, ${minutes} мин. по внесённым отметкам; согласованные отсутствия исключены. Причины не установлены.`);
   if(extra>0)add(e,'overtime','Проверить время после окончания смены',`${extra} мин. между плановым окончанием и отметкой ухода за период. Это требует проверки, а не автоматического признания оплачиваемой переработкой.`);
   if(missing||!shifts.length)add(e,'attendance','Проверить полноту отметок',`Смен за период: ${shifts.length}; завершившихся смен без пары приход/уход: ${missing}. Отсутствие отметки не доказывает отсутствие сотрудника.`);
   if(overdue)add(e,'tasks','Уточнить сроки и препятствия по задачам',`${overdue} открытых задач с истёкшим сроком на ${today()}.`);
   if(k?.score==null)add(e,'kpi-data','Заполнить план, факты и источник KPI',`За ${f.month} нет полной оценки KPI. Результативность и причины снижения пока оценить нельзя.`);
   else if(k.score<80)add(e,'training','Согласовать обучение по слабым KPI',`KPI за ${f.month}: ${k.score.toFixed(1)}%. Порог внимания 80% — правило помощника. Показатели ниже плана: ${roles.find(r=>r.id===k.review.role).metrics.filter((m,i)=>k.review.actual[i]<k.review.targets[i]).map(m=>m[0]).join(', ')}. Источник: ${k.review.evidence}. Обсудите причины с сотрудником.`);
   if(k?.suggested>0)add(e,'bonus','Рассмотреть премию в финансовом разделе',`Предложение на момент отчёта: ${(k.suggested/100).toFixed(2)} ${f.currency}; KPI ${k.score.toFixed(1)}%. ${f.advice} Сумму необходимо пересчитать и подтвердить в разделе «Финансы».`);
  }
  return {start,end,asOf:today(),month:f.month,staff,suggestions,financeAdvice:f.advice,roles:roles.map(r=>({...r,vacancy:`Ищем: ${r.name}. Работа в строительном магазине. Обязанности: ${r.duties.join(' ')} Условия оплаты и график согласуются отдельно.`,questions:['Расскажите о похожей задаче из вашего опыта.',...r.duties.slice(0,3).map(d=>'Как вы организуете работу: '+d)],training:['День 1: наставник, правила магазина, инструктаж и доступы.','Дни 2–3: ассортимент, единицы измерения, хранение и выдача товара.','Дни 4–7: практика с наставником по обязанностям: '+r.duties[0],'Дни 8–14: самостоятельные задания с проверкой качества.','День 30: встреча по результатам; оценка согласованных KPI.']})),advice:db.prepare('SELECT a.*,e.name FROM hr_advice a JOIN employees e ON e.id=a.employee ORDER BY a.created DESC LIMIT 300').all(),requests:db.prepare('SELECT r.*,e.name FROM hr_requests r JOIN employees e ON e.id=r.employee ORDER BY r.created DESC LIMIT 300').all(),audit:db.prepare('SELECT * FROM hr_assistant_audit ORDER BY id DESC LIMIT 100').all()};
 }
 function request(employee,kind,message,source){
  if(!['leave','advance','schedule','pay','feedback'].includes(kind))fail('Тип обращения не поддерживается');
  if(!db.prepare('SELECT id FROM employees WHERE id=? AND active=1').get(employee))fail('Сотрудник недоступен');
  message=clean(message,1000);const old=db.prepare('SELECT id FROM hr_requests WHERE source=?').get(source);if(old)return old;
  if(db.prepare("SELECT COUNT(*) n FROM hr_requests WHERE employee=? AND status='pending'").get(employee).n>=20)fail('Уже 20 открытых обращений. Дождитесь ответа администратора.');
  const id=randomUUID();db.prepare('INSERT INTO hr_requests(id,employee,kind,message,created,source) VALUES(?,?,?,?,?,?)').run(id,employee,kind,message,clock(),source);return {id};
 }
 function self(employee){return db.prepare('SELECT kind,message,status,decision,created FROM hr_requests WHERE employee=? ORDER BY created DESC LIMIT 10').all(employee)}
 function handle(path,b,actor){if(!actor?.admin)fail('Только администратор',403);
  if(path==='/api/hr-assistant/training')return transaction(()=>{const role=roles.find(r=>r.id===b.role);if(!role||!validDate(b.start||''))fail('Проверьте должность и дату');if(!db.prepare('SELECT id FROM employees WHERE id=? AND active=1').get(b.employee))fail('Сотрудник недоступен');if(db.prepare('SELECT employee FROM hr_training_plans WHERE employee=? AND role=? AND start=?').get(b.employee,b.role,b.start))fail('Этот план уже создан');const steps=['Наставник, правила магазина и вводный инструктаж','Ассортимент, единицы измерения, хранение и выдача товара','Практика: '+role.duties[0],'Самостоятельные задания с проверкой качества','Итоговая встреча и оценка согласованных KPI'];steps.forEach((title,i)=>db.prepare('INSERT INTO hr_tasks VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),b.employee,title,'training',dayAdd(b.start,[0,2,6,13,29][i]),actor.name,'open','План адаптации: '+role.name,clock()));db.prepare('INSERT INTO hr_training_plans VALUES(?,?,?)').run(b.employee,b.role,b.start);audit(b.employee,'training',actor.id,{role:b.role,start:b.start});return {ok:true}});
  if(path==='/api/hr-assistant/generate'){const r=report(b.end);return transaction(()=>{for(const a of r.suggestions)db.prepare('INSERT OR IGNORE INTO hr_advice(id,employee,period,kind,title,evidence,created) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),a.employee,a.period,a.kind,a.title,a.evidence,clock());audit(r.end,'generate',actor.id,{count:r.suggestions.length});return {ok:true}})}
  if(path==='/api/hr-assistant/decision')return transaction(()=>{const table=b.type==='request'?'hr_requests':b.type==='advice'?'hr_advice':null;if(!table)fail('Тип записи');const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(b.id);if(!row||row.status!=='pending')fail('Запись уже рассмотрена или не найдена');if(!['approved','rejected'].includes(b.status))fail('Выберите решение');const decision=clean(b.decision,1000);let title=row.title;
   if(table==='hr_advice'&&b.status==='approved'){title=clean(b.title||row.title,180);if(!validDate(b.due||''))fail('Укажите срок задачи');if(!db.prepare('SELECT active FROM employees WHERE id=?').get(row.employee)?.active)fail('Сотрудник в архиве');db.prepare('INSERT INTO hr_tasks VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.employee,title,row.kind==='training'?'training':'review',b.due,actor.name,'open',decision,clock())}
   if(table==='hr_requests'&&row.kind==='feedback'&&b.status==='approved'){if(!validDate(b.due||''))fail('Укажите срок решения');const owner=clean(b.owner,100);db.prepare('INSERT INTO hr_tasks VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.employee,'Обратная связь: '+row.message.slice(0,140),'general',b.due,owner,'open',decision,clock())}
   db.prepare(`UPDATE ${table} SET status=?,decision=?,actor=? WHERE id=?`).run(b.status,decision,actor.id,row.id);if(table==='hr_advice')db.prepare('UPDATE hr_advice SET title=? WHERE id=?').run(title,row.id);audit(row.id,b.status,actor.id,{decision,title});return {ok:true};});
  fail('Не найдено',404);
 }
 return {report,handle,request,self};
}
