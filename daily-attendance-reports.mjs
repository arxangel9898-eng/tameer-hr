import {localDate,dayAdd,validDate,zonedTime} from './model.mjs';

const clean=v=>String(v||'').replace(/[\r\n\t]+/g,' ').slice(0,160);
export function splitAttendanceReport(blocks,limit=3500){
 const parts=[];let current='';
 for(const block of blocks){let rest=block;while(rest.length){const room=limit-current.length-(current?'\n\n'.length:0);if(rest.length<=room){current+=(current?'\n\n':'')+rest;break}if(current){parts.push(current);current='';continue}let cut=rest.lastIndexOf('\n',limit);if(cut<1)cut=limit;if(/[\uD800-\uDBFF]/.test(rest[cut-1]))cut--;parts.push(rest.slice(0,cut));rest=rest.slice(cut).replace(/^\n+/,'');}}
 if(current)parts.push(current);return parts.map((p,i)=>parts.length>1?`Часть ${i+1}/${parts.length}\n${p}`:p);
}

export function initDailyAttendanceReports(db,{schedule,storeOps,bot,transaction,fail,tz='Asia/Tashkent',clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS tg_daily_report_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,time TEXT NOT NULL,period TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tg_daily_report_recipients(employee TEXT PRIMARY KEY REFERENCES employees(id),active INTEGER NOT NULL,bot_id TEXT NOT NULL,chat TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tg_daily_report_delivery(employee TEXT NOT NULL REFERENCES employees(id),day TEXT NOT NULL,part INTEGER NOT NULL,total INTEGER NOT NULL,body TEXT NOT NULL,target TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '',message_id INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(employee,day,part));
 CREATE TABLE IF NOT EXISTS tg_daily_report_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);`);
 db.prepare("INSERT OR IGNORE INTO tg_daily_report_settings VALUES(1,0,'20:30','today')").run();
 db.prepare("UPDATE tg_daily_report_delivery SET status='uncertain',error='Отправка прервалась. Проверьте личные сообщения руководителя.' WHERE status='sending'").run();
 const settings=()=>{const r=db.prepare('SELECT enabled,time,period FROM tg_daily_report_settings WHERE id=1').get();return {...r,enabled:!!r.enabled}};
 const today=()=>localDate(clock(),tz).date;
 const admin=a=>{if(!a?.admin)fail('Настройки и полные отчёты доступны только администратору',403)};
 const audit=(a,action,b)=>db.prepare('INSERT INTO tg_daily_report_audit(actor,action,json,at) VALUES(?,?,?,?)').run(a.id,action,JSON.stringify(b),clock());
 function date(day){if(!validDate(day)||day>today())fail('Выберите существующую дату не позже сегодняшней');return day;}
 function report(day=today()){
  date(day);const now=clock(),fmt=at=>at==null?'—':(localDate(at,tz).date===day?'':localDate(at,tz).date+' ')+localDate(at,tz).time;
  const staff=db.prepare('SELECT * FROM employees WHERE (active=1 AND created<?) OR id IN (SELECT employee FROM shifts WHERE day=?) ORDER BY name').all(zonedTime(dayAdd(day,1),'00:00',tz),day);
  const rows=[];let arrived=0,closed=0,late=0,early=0,missing=0,off=0,pending=0;
  const lines=staff.map((e,i)=>{
   const p=schedule.forDay(e.id,day),s=db.prepare('SELECT * FROM shifts WHERE employee=? AND day=?').get(e.id,day),ev=s?db.prepare('SELECT * FROM events WHERE shift=? ORDER BY id').all(s.id):[],r=s?storeOps.corrected(s,ev,now):null;
   const status=r?.status||(p.off?(p.source==='Согласованное отсутствие'?'Согласованное отсутствие':'Выходной по графику'):'Нет отметки прихода');
   rows.push({employee:e.id,name:e.name+(e.active?'':' (архив)'),role:e.role,plannedStart:s?.planned_start??(p.off?null:p.start),plannedEnd:s?.planned_end??(p.off?null:p.end),in:r?.in??null,out:r?.out??null,worked:r?.in!=null?r.worked:null,breaks:r?.in!=null?r.breaks:null,late:r?.in!=null?r.late:null,early:r?.out!=null?r.early:null,rawEarly:r?.rawEarly??null,status,permission:r?.earlyPermission||null,latePermission:r?.latePermission||null,overtimePermission:r?.overtimePermission||null,corrected:!!r?.correction,originalIn:r?.originalIn??null,originalOut:r?.originalOut??null,conflict:!!p.conflict,off:!!p.off});
   const title=`${i+1}. ${clean(e.name)}${e.active?'':' (архив)'}`;
   if(!r){if(p.off){off++;return `${title}\n${p.source==='Согласованное отсутствие'?'Согласованное отсутствие':'Выходной по графику'}${p.conflict?' · конфликт графика':''}`;}missing++;return `${title}\nПлан: ${fmt(p.start)}–${fmt(p.end)}\nПриход: — · Уход: —\nНет отметки прихода${p.conflict?' · конфликт графика':''}`;}
   if(r.in!=null)arrived++;else missing++;if(r.out!=null)closed++;if(r.late)late++;if(r.early)early++;
   let text=`${title}\nПлан: ${fmt(s.planned_start)}–${fmt(s.planned_end)}\nПриход: ${fmt(r.in)} · Уход: ${fmt(r.out)}\n${clean(r.status)} · отработано ${r.worked} мин · перерывы ${r.breaks} мин\nОпоздание: ${r.late} мин · ранний уход к учёту: ${r.early} мин`;
   if(r.autoClosed)text+='\nСмена закрыта автоматически, без видео ухода.';
   if(r.originalIn!=null||r.originalOut!=null)text+=`\nКорректировка HR · исходные отметки: ${fmt(r.originalIn)} / ${fmt(r.originalOut)}`;
   if(r.earlyPermission){const x=r.earlyPermission;if(x.status==='pending')pending++;text+=`\nРанний уход фактически: ${r.rawEarly} мин · ${({pending:'разрешение ожидает подтверждения',approved:'по разрешению, подтверждено',rejected:'разрешение не подтверждено'})[x.status]||clean(x.status)}\nКто разрешил: ${clean(x.responsible)}${x.confirmedBy?' · Решение: '+clean(x.confirmedBy):''}`;}
   if(r.latePermission)text+='\nОпоздание: уважительная причина · '+clean(r.latePermission.reason)+' · Подтвердил: '+clean(r.latePermission.confirmedBy);
   if(r.overtimePermission)text+='\nДополнительная работа до '+fmt(r.overtimePermission.until)+' · Подтвердил: '+clean(r.overtimePermission.confirmedBy)+' · Согласованное фактическое время: '+r.overtimePermission.minutes+' мин';
   if(p.conflict)text+='\nКонфликт графика: требуется проверка';return text;
  });
  const generated=localDate(now,tz),summary={employees:staff.length,arrived,closed,late,early,missing,off,pending};
  const header=`📋 TAMEER · Ежедневный отчёт посещаемости\nЗа ${day.split('-').reverse().join('.')} · ${tz}\nСформирован: ${generated.date} ${generated.time}\nСотрудников: ${staff.length} · пришли: ${arrived} · ушли: ${closed}\nС опозданием: ${late} · ранний уход: ${early}\nБез прихода: ${missing} · выходной/отсутствие: ${off} · разрешений на проверке: ${pending}`;
  const footer='Отсутствие отметки требует проверки. Незакрытые смены и отработанные минуты предварительные. Для ночных смен выбирайте отправку за предыдущий день после их окончания. Отчёт отражает данные на момент формирования; деньги не начисляет.';
  return {day,generated:now,summary,rows,messages:splitAttendanceReport([header,...lines,footer])};
 }
 const recipients=()=>db.prepare('SELECT r.*,e.name,e.active AS employee_active FROM tg_daily_report_recipients r JOIN employees e ON e.id=r.employee WHERE r.active=1 ORDER BY e.name').all();
 function targetFor(r){const t=bot.dailyReportTarget(r.employee);return t.ready&&t.botId===r.bot_id&&t.userId===r.chat?{...t,ready:true}:{...t,ready:false,reason:t.ready?'Telegram-привязка изменена. Сохраните получателей заново.':t.reason};}
 function view(actor,day=today()){
  admin(actor);const chosen=recipients();return {settings:settings(),timezone:tz,today:today(),day,employees:db.prepare('SELECT id,name FROM employees WHERE active=1 ORDER BY name').all().map(e=>{const t=bot.dailyReportTarget(e.id),r=chosen.find(x=>x.employee===e.id);return {...e,ready:r?targetFor(r).ready:t.ready,reason:r?targetFor(r).reason:t.reason,username:t.username||''}}),recipients:chosen.map(r=>r.employee),report:report(day),deliveries:db.prepare('SELECT d.employee,e.name,d.day,d.part,d.total,d.status,d.error,d.updated FROM tg_daily_report_delivery d JOIN employees e ON e.id=d.employee WHERE d.day=? ORDER BY e.name,d.part').all(day)};
 }
 function configure(b,actor){admin(actor);if(typeof b.enabled!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time||'')||!['today','previous'].includes(b.period)||!Array.isArray(b.recipients)||b.recipients.length>100||new Set(b.recipients).size!==b.recipients.length)fail('Проверьте время и получателей');if(b.enabled&&!b.recipients.length)fail('Выберите хотя бы одного руководителя');
  const selected=b.recipients.map(id=>{if(typeof id!=='string')fail('Выберите сотрудника из базы');const e=db.prepare('SELECT name FROM employees WHERE id=? AND active=1').get(id);if(!e)fail('Получатель должен быть активным сотрудником');const t=bot.dailyReportTarget(id);if(b.enabled&&!t.ready)fail(e.name+': '+(t.reason||'Подтвердите привязку к боту смен'));return {employee:id,botId:t.botId||'',chat:t.userId||''};});
  return transaction(()=>{db.prepare('UPDATE tg_daily_report_settings SET enabled=?,time=?,period=? WHERE id=1').run(+b.enabled,b.time,b.period);db.prepare('UPDATE tg_daily_report_recipients SET active=0').run();for(const r of selected)db.prepare('INSERT INTO tg_daily_report_recipients VALUES(?,1,?,?) ON CONFLICT(employee) DO UPDATE SET active=1,bot_id=excluded.bot_id,chat=excluded.chat').run(r.employee,r.botId,r.chat);audit(actor,'settings',{enabled:b.enabled,time:b.time,period:b.period,recipients:b.recipients});return {ok:true};});
 }
 function enqueue(day){const list=recipients(),snapshot=report(day),now=clock();transaction(()=>{for(const r of list){if(!r.employee_active||db.prepare('SELECT part FROM tg_daily_report_delivery WHERE employee=? AND day=? LIMIT 1').get(r.employee,day))continue;const target=targetFor(r);for(const [i,body] of snapshot.messages.entries())db.prepare("INSERT INTO tg_daily_report_delivery(employee,day,part,total,body,target,status,next,created,updated) VALUES(?,?,?,?,?,?,'pending',?,?,?)").run(r.employee,day,i+1,snapshot.messages.length,body,JSON.stringify(target),now,now,now);}});}
 function sendNow(day,actor){admin(actor);date(day);if(day<dayAdd(today(),-31))fail('Ручная отправка доступна за последние 31 день');if(!settings().enabled||!recipients().length)fail('Сначала включите отчёты и сохраните получателей');enqueue(day);audit(actor,'send',{day});return {ok:true,message:'Отправка запущена. Уже отправленные части повторно не отправляются.'};}
 function retry(b,actor){admin(actor);date(b.day);const r=db.prepare('SELECT * FROM tg_daily_report_recipients WHERE employee=? AND active=1').get(b.employee);if(!settings().enabled||!r)fail('Сначала включите отправку этому руководителю');const target=targetFor(r);if(!target.ready)fail(target.reason);const rows=db.prepare("SELECT * FROM tg_daily_report_delivery WHERE employee=? AND day=? AND status IN ('blocked','cancelled')").all(b.employee,b.day);if(!rows.length)fail('Нет заблокированных частей. Неопределённая доставка автоматически не повторяется');for(const row of rows){const old=JSON.parse(row.target);if(old.botId&&old.botId!==target.botId||old.userId&&old.userId!==target.userId)fail('Получатель или бот изменены: отчёт не перенаправлен');}transaction(()=>{db.prepare("UPDATE tg_daily_report_delivery SET status='pending',target=?,attempts=0,next=?,error='',updated=? WHERE employee=? AND day=? AND status IN ('blocked','cancelled')").run(JSON.stringify(target),clock(),clock(),b.employee,b.day);audit(actor,'retry',{employee:b.employee,day:b.day});});return {ok:true};}
 let running=false,stopped=false;
 async function scan(){if(running||stopped||!settings().enabled)return;running=true;try{
  const local=localDate(clock(),tz),st=settings();if(local.time>=st.time)enqueue(st.period==='previous'?dayAdd(local.date,-1):local.date);
  const rows=db.prepare("SELECT * FROM tg_daily_report_delivery WHERE status='pending' AND next<=? ORDER BY day,employee,part").all(clock());
  for(const row of rows){if(stopped||!settings().enabled)break;const r=recipients().find(r=>r.employee===row.employee&&r.employee_active),target=JSON.parse(row.target),current=r?targetFor(r):null;
   if(!r){db.prepare("UPDATE tg_daily_report_delivery SET status='cancelled',error='Получатель отключён',updated=? WHERE employee=? AND day=? AND part=?").run(clock(),row.employee,row.day,row.part);continue;}
   if(!target.ready||!current.ready||target.botId!==current.botId||target.userId!==current.userId){db.prepare("UPDATE tg_daily_report_delivery SET status='blocked',error=?,updated=? WHERE employee=? AND day=? AND part=?").run(current.reason||target.reason||'Привязка получателя изменена',clock(),row.employee,row.day,row.part);continue;}
   if(db.prepare("SELECT part FROM tg_daily_report_delivery WHERE employee=? AND day=? AND part<? AND status<>'sent' LIMIT 1").get(row.employee,row.day,row.part))continue;
   if(!db.prepare("UPDATE tg_daily_report_delivery SET status='sending',updated=? WHERE employee=? AND day=? AND part=? AND status='pending'").run(clock(),row.employee,row.day,row.part).changes)continue;
   try{const result=await bot.notifyDailyReport(row.employee,row.body,target),status=result.delivered?'sent':result.uncertain?'uncertain':result.retryable&&row.attempts<4?'pending':'blocked';db.prepare('UPDATE tg_daily_report_delivery SET status=?,attempts=attempts+1,next=?,error=?,message_id=?,updated=? WHERE employee=? AND day=? AND part=?').run(status,clock()+Math.max(60000,Math.min(3600000,(result.retryAfter||60)*1000)),result.delivered?'':String(result.reason||'Доставка не выполнена').slice(0,200),result.messageId||null,clock(),row.employee,row.day,row.part);}
   catch{db.prepare("UPDATE tg_daily_report_delivery SET status='uncertain',error='Telegram не подтвердил доставку. Проверьте сообщения получателя.',updated=? WHERE employee=? AND day=? AND part=?").run(clock(),row.employee,row.day,row.part);}
  }
 }finally{running=false}}
 return {view,report,configure,sendNow,retry,scan,stop(){stopped=true}};
}
