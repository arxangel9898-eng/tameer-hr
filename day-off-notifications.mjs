import {localDate,validDate} from './model.mjs';
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function dayOffMessage(name,userId,day){
 if(!/^[1-9]\d{0,18}$/.test(String(userId))||!validDate(day))throw Error('Invalid day-off recipient');
 const date=day.split('-').reverse().join('.');
 return `🌿 <b>TAMEER · Yaxshi dam oling!</b>\n\n<a href="tg://user?id=${userId}">${esc(name)}</a>, bugun, <b>${date}</b>, jadval bo‘yicha dam olish kuningiz! ☀️\n\nMehnatingiz va jamoamizga qo‘shayotgan hissangiz uchun rahmat. Kuningiz xotirjamlik, yaxshi kayfiyat va yaqinlaringiz bilan yoqimli lahzalarga boy bo‘lsin. Maroqli dam olib, kuch to‘plab qayting! 💙`;
}
export function initDayOffNotifications(db,{schedule,bot,fail,tz='Asia/Tashkent',clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS store_dayoff_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,morning TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS store_dayoff_outbox(employee TEXT NOT NULL REFERENCES employees(id),day TEXT NOT NULL,status TEXT NOT NULL,target TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '',message_id INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(employee,day));
 CREATE TABLE IF NOT EXISTS store_dayoff_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);`);
 db.prepare("INSERT OR IGNORE INTO store_dayoff_settings VALUES(1,1,'09:00')").run();
 db.prepare("UPDATE store_dayoff_outbox SET status='uncertain',error='Проверьте группу: отправка прервалась при перезапуске' WHERE status='sending'").run();
 const settings=()=>{const r=db.prepare('SELECT enabled,morning FROM store_dayoff_settings WHERE id=1').get();return {...r,enabled:!!r.enabled}};
 const today=()=>localDate(clock(),tz).date;
 function eligible(employee,day){const e=db.prepare('SELECT id,name,active FROM employees WHERE id=?').get(employee);if(!e?.active)return null;const p=schedule.forDay(employee,day);if(!p.off||p.conflict||p.source==='Согласованное отсутствие')return null;const moment=day===today()?schedule.forMoment?.(employee,clock()):null;if(moment&&!moment.off&&moment.day!==day)return null;return e;}
 const audit=(actor,action,b)=>db.prepare('INSERT INTO store_dayoff_audit(actor,action,json,at) VALUES(?,?,?,?)').run(actor.id,action,JSON.stringify(b),clock());
 let running=false,stopped=false;
 function view(day=today()){if(!validDate(day))fail('Некорректная дата');return {settings:settings(),today:today(),day,recipients:db.prepare('SELECT id FROM employees WHERE active=1 ORDER BY name').all().map(e=>eligible(e.id,day)).filter(Boolean).map(e=>({id:e.id,name:e.name,ready:bot.leaveTarget(e.id).ready})),deliveries:db.prepare('SELECT o.employee,e.name,o.day,o.status,o.error,o.updated FROM store_dayoff_outbox o JOIN employees e ON e.id=o.employee WHERE o.day=? ORDER BY e.name').all(day)};}
 function handle(action,b,actor){if(!actor?.admin)fail('Только администратор',403);
  if(action==='day-off-settings'){if(typeof b.enabled!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.morning||''))fail('Проверьте время отправки');db.prepare('UPDATE store_dayoff_settings SET enabled=?,morning=? WHERE id=1').run(+b.enabled,b.morning);audit(actor,action,{enabled:b.enabled,morning:b.morning});return {ok:true};}
  if(action==='day-off-send'){audit(actor,action,{day:today()});return {ok:true,message:'Отправка поздравлений за сегодня запущена. Статусы появятся в таблице.'};}
  if(action==='day-off-retry'){const day=today(),r=db.prepare('SELECT * FROM store_dayoff_outbox WHERE employee=? AND day=?').get(b.employee,day);if(!r||r.status!=='blocked'||!eligible(b.employee,day))fail('Повторная отправка недоступна. Проверьте выходной и статус доставки.');const target=bot.leaveTarget(b.employee),old=JSON.parse(r.target);if(!target.ready)fail(target.reason||'Проверьте Telegram-привязку');if(old.groupId&&old.groupId!==target.groupId||old.botId&&old.botId!==target.botId)fail('Рабочая группа или бот изменены: прежнее сообщение не перенаправлено');db.prepare("UPDATE store_dayoff_outbox SET status='pending',target=?,attempts=0,next=?,error='',updated=? WHERE employee=? AND day=?").run(JSON.stringify(target),clock(),clock(),b.employee,day);audit(actor,action,{employee:b.employee,day});return {ok:true};}
  fail('Неизвестное действие',404);
 }
 async function scan({force=false,employee=null}={}){if(stopped||running||!settings().enabled)return;const local=localDate(clock(),tz),day=local.date;if(!force&&local.time<settings().morning)return;running=true;
  try{const staff=employee?db.prepare('SELECT id FROM employees WHERE id=? AND active=1').all(employee):db.prepare('SELECT id FROM employees WHERE active=1').all();
   for(const e of staff){if(!eligible(e.id,day))continue;const target=bot.leaveTarget(e.id),now=clock();db.prepare("INSERT OR IGNORE INTO store_dayoff_outbox(employee,day,status,target,next,created,updated) VALUES(?,?,'pending',?,?,?,?)").run(e.id,day,JSON.stringify(target),now,now,now);}
   const rows=db.prepare("SELECT * FROM store_dayoff_outbox WHERE day=? AND status='pending' AND next<=? ORDER BY created").all(day,clock());
   for(const r of rows){if(stopped||!settings().enabled||today()!==day)break;if(employee&&r.employee!==employee)continue;const e=eligible(r.employee,day);if(!e){db.prepare("UPDATE store_dayoff_outbox SET status='cancelled',updated=? WHERE employee=? AND day=?").run(clock(),r.employee,day);continue;}
    const target=JSON.parse(r.target);if(!target.ready){db.prepare("UPDATE store_dayoff_outbox SET status='blocked',error=?,updated=? WHERE employee=? AND day=?").run(target.reason||'Проверьте Telegram-привязку',clock(),r.employee,day);continue;}
    if(!db.prepare("UPDATE store_dayoff_outbox SET status='sending',updated=? WHERE employee=? AND day=? AND status='pending'").run(clock(),r.employee,day).changes)continue;
    try{const result=await bot.notifyLeaveGroup(r.employee,dayOffMessage(e.name,target.userId,day),target),status=result.delivered?'sent':result.uncertain?'uncertain':result.retryable&&r.attempts<4?'pending':'blocked';db.prepare('UPDATE store_dayoff_outbox SET status=?,attempts=attempts+1,next=?,error=?,message_id=?,updated=? WHERE employee=? AND day=?').run(status,clock()+60000,result.delivered?'':String(result.reason||'Доставка не выполнена').slice(0,200),result.messageId||null,clock(),r.employee,day);}catch{db.prepare("UPDATE store_dayoff_outbox SET status='uncertain',error='Проверьте группу: подтверждение доставки не получено',updated=? WHERE employee=? AND day=?").run(clock(),r.employee,day);}
   }
  }finally{running=false}
 }
 return {view,handle,scan,stop(){stopped=true}};
}
