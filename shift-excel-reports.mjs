import {attendanceXlsx} from './attendance-excel.mjs';
import {localDate} from './model.mjs';

export function initShiftExcelReports(db,{reports,bot,transaction,fail,tz='Asia/Tashkent',clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS tg_shift_excel_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,mode TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tg_shift_excel_snapshots(id TEXT PRIMARY KEY,event INTEGER NOT NULL UNIQUE REFERENCES events(id),day TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS tg_shift_excel_delivery(snapshot TEXT NOT NULL REFERENCES tg_shift_excel_snapshots(id),employee TEXT NOT NULL REFERENCES employees(id),target TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '',message_id INTEGER,updated INTEGER NOT NULL,PRIMARY KEY(snapshot,employee));
 CREATE TABLE IF NOT EXISTS tg_shift_excel_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);`);
 db.prepare("INSERT OR IGNORE INTO tg_shift_excel_settings VALUES(1,1,'each')").run();
 db.prepare("UPDATE tg_shift_excel_delivery SET status='uncertain',error='Отправка прервалась. Проверьте личные сообщения руководителя.' WHERE status='sending'").run();
 const settings=()=>{const r=db.prepare('SELECT enabled,mode FROM tg_shift_excel_settings WHERE id=1').get();return {...r,enabled:!!r.enabled}};
 const admin=a=>{if(!a?.admin)fail('Excel-отчёты доступны только администратору',403)};
 const recipients=()=>db.prepare('SELECT r.* FROM tg_daily_report_recipients r JOIN employees e ON e.id=r.employee WHERE r.active=1 AND e.active=1 ORDER BY e.name').all();
 const target=r=>{const t=bot.dailyReportTarget(r.employee);return {...t,ready:!!(t.ready&&t.botId===r.bot_id&&t.userId===r.chat),reason:t.ready?'Telegram-привязка изменена. Сохраните получателей заново.':t.reason}};
 const audit=(a,action,b)=>db.prepare('INSERT INTO tg_shift_excel_audit(actor,action,json,at) VALUES(?,?,?,?)').run(a.id,action,JSON.stringify(b),clock());
 function enqueue(close){
  const st=settings();if(!st.enabled)return;
  // Never scan old events: this hook runs inside the transaction of a new out mark.
  const event=db.prepare("SELECT s.day,s.employee FROM events e JOIN shifts s ON s.id=e.shift WHERE e.id=? AND e.shift=? AND e.kind='out'").get(close.event,close.shift);
  if(!event||event.day!==close.day||event.employee!==close.employee)return;
  const snapshot=reports.report(event.day);
  if(st.mode==='all'&&snapshot.rows.some(r=>!r.off&&r.out==null||r.in!=null&&r.out==null))return;
  const id=st.mode==='all'?'day:'+event.day:'out:'+close.event;
  if(db.prepare('SELECT id FROM tg_shift_excel_snapshots WHERE id=? OR event=?').get(id,close.event))return;
  const list=recipients();if(!list.length)return;
  const name=db.prepare('SELECT name FROM employees WHERE id=?').get(event.employee).name;
  snapshot.trigger=`Закрыл смену: ${name}`;
  db.prepare('INSERT INTO tg_shift_excel_snapshots VALUES(?,?,?,?,?)').run(id,close.event,event.day,JSON.stringify(snapshot),clock());
  for(const r of list)db.prepare("INSERT INTO tg_shift_excel_delivery(snapshot,employee,target,status,next,updated) VALUES(?,?,?,'pending',?,?)").run(id,r.employee,JSON.stringify(target(r)),clock(),clock());
 }
 function view(actor,day=localDate(clock(),tz).date){admin(actor);reports.report(day);return {settings:settings(),recipients:recipients().length,deliveries:db.prepare('SELECT d.snapshot,d.employee,e.name,s.day,s.created,d.status,d.error,d.updated FROM tg_shift_excel_delivery d JOIN tg_shift_excel_snapshots s ON s.id=d.snapshot JOIN employees e ON e.id=d.employee WHERE s.day=? ORDER BY s.created DESC,e.name LIMIT 500').all(day)}}
 function configure(b,actor){admin(actor);if(typeof b.enabled!=='boolean'||!['each','all'].includes(b.mode))fail('Выберите способ отправки Excel');if(b.enabled&&!recipients().length)fail('Сначала сохраните получателей отчётов руководителям');return transaction(()=>{db.prepare('UPDATE tg_shift_excel_settings SET enabled=?,mode=? WHERE id=1').run(+b.enabled,b.mode);if(!b.enabled)db.prepare("UPDATE tg_shift_excel_delivery SET status='cancelled',error='Отправка Excel отключена',updated=? WHERE status='pending'").run(clock());audit(actor,'settings',b);return {ok:true}})}
 function download(day,actor){admin(actor);const r=reports.report(day);return {bytes:attendanceXlsx(r,{timezone:tz}),filename:'TAMEER-attendance-'+r.day+'.xlsx'}}
 function retry(b,actor){admin(actor);const row=db.prepare('SELECT * FROM tg_shift_excel_delivery WHERE snapshot=? AND employee=?').get(b.snapshot,b.employee);if(!row||!['blocked','cancelled'].includes(row.status))fail('Повтор доступен только для неотправленного Excel. Неопределённую доставку проверьте в Telegram');const r=recipients().find(r=>r.employee===row.employee),t=r&&target(r),old=JSON.parse(row.target);if(!settings().enabled||!t?.ready)fail(t?.reason||'Получатель или отправка отключены');if(old.botId!==t.botId||old.userId!==t.userId)fail('Получатель изменён. Сохранённый отчёт не перенаправлен');return transaction(()=>{db.prepare("UPDATE tg_shift_excel_delivery SET status='pending',target=?,attempts=0,next=?,error='',updated=? WHERE snapshot=? AND employee=?").run(JSON.stringify(t),clock(),clock(),b.snapshot,b.employee);audit(actor,'retry',b);return {ok:true}})}
 let running=false,stopped=false;
 async function scan(){if(running||stopped||!settings().enabled)return;running=true;try{
  const pending=db.prepare("SELECT d.*,s.body,s.day FROM tg_shift_excel_delivery d JOIN tg_shift_excel_snapshots s ON s.id=d.snapshot WHERE d.status='pending' AND d.next<=? ORDER BY s.created,d.employee LIMIT 100").all(clock());
  for(const row of pending){if(stopped||!settings().enabled)break;const r=recipients().find(r=>r.employee===row.employee),t=r&&target(r),saved=JSON.parse(row.target);if(!r||!t?.ready||t.botId!==saved.botId||t.userId!==saved.userId){db.prepare('UPDATE tg_shift_excel_delivery SET status=?,error=?,updated=? WHERE snapshot=? AND employee=?').run(r?'blocked':'cancelled',t?.reason||'Получатель отключён',clock(),row.snapshot,row.employee);continue;}
   let bytes,snapshot;try{snapshot=JSON.parse(row.body);bytes=attendanceXlsx(snapshot,{timezone:tz,trigger:snapshot.trigger})}catch{db.prepare("UPDATE tg_shift_excel_delivery SET status='blocked',error='Не удалось сформировать Excel',updated=? WHERE snapshot=? AND employee=?").run(clock(),row.snapshot,row.employee);continue;}
   if(!db.prepare("UPDATE tg_shift_excel_delivery SET status='sending',updated=? WHERE snapshot=? AND employee=? AND status='pending'").run(clock(),row.snapshot,row.employee).changes)continue;
   try{const result=await bot.notifyAttendanceExcel(row.employee,bytes,`TAMEER-attendance-${row.day}.xlsx`,`TAMEER · Посещаемость за ${row.day}\n${snapshot.trigger}\nВсе сотрудники: ${snapshot.summary.employees}. Закрыли: ${snapshot.summary.closed}. Пришли: ${snapshot.summary.arrived}.\nОткрытые смены предварительные.`,saved),status=result.delivered?'sent':result.uncertain?'uncertain':result.retryable&&row.attempts<4?'pending':'blocked';db.prepare('UPDATE tg_shift_excel_delivery SET status=?,attempts=attempts+1,next=?,error=?,message_id=?,updated=? WHERE snapshot=? AND employee=?').run(status,clock()+Math.max(60000,Math.min(3600000,(result.retryAfter||60)*1000)),result.delivered?'':String(result.reason||'Доставка не выполнена').slice(0,200),result.messageId||null,clock(),row.snapshot,row.employee);}catch{db.prepare("UPDATE tg_shift_excel_delivery SET status='uncertain',error='Telegram не подтвердил доставку. Проверьте личные сообщения.',updated=? WHERE snapshot=? AND employee=?").run(clock(),row.snapshot,row.employee);}
  }
 }finally{running=false}}
 return {enqueue,view,configure,download,retry,scan,stop(){stopped=true}};
}
