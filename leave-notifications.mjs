import {calendarDays} from './hr.mjs';
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=v=>v.split('-').reverse().join('.');
export function leaveMessage(leave,userId,kind='approved'){
 if(!/^[1-9]\d{0,18}$/.test(String(userId)))throw Error('Invalid Telegram identity');
 const person=`<a href="tg://user?id=${userId}">${esc(leave.name)}</a>`,period=`${date(leave.start)} — ${date(leave.end)}`;
 const substitutes=(leave.replacements||[]).map(r=>/^[1-9]\d{0,18}$/.test(String(r.chat||''))?`<a href="tg://user?id=${r.chat}">${esc(r.name)}</a>`:esc(r.name)).join(', ');
 const cover=substitutes?`\n🤝 <b>O‘rinbosarlar:</b> ${substitutes}.\n`:'';
 if(kind==='replacements')return `🤝 <b>TAMEER · Vaqtinchalik o‘rinbosarlik</b>\n\n${person} · ta’til: ${period}.\n${substitutes?cover:'O‘rinbosarlik bekor qilindi. Mas’ulni rahbar bilan aniqlashtiring.'}`;
 if(kind==='cancelled')return `ℹ️ <b>TAMEER · Reja o‘zgardi</b>\n\n${person}, ${period} sanalaridagi ta’til bekor qilindi. Ish jadvalini rahbar bilan aniqlashtiring.`;
 return `🌿 <b>TAMEER · Dam olish vaqti</b>\n\n${person}, ta’tilingiz tasdiqlandi!\n📅 <b>${period}</b> (oxirgi kun ham kiradi) · ${calendarDays(leave.start,leave.end)} kalendar kun.\n${cover}\nJamoamizga qo‘shayotgan hissangiz uchun rahmat. Yaqinlaringiz bilan maroqli dam oling va kuch to‘plab qayting! 💙`;
}
export function initLeaveNotifications(db,{bot,fail,clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS hr_leave_group_outbox(
 id TEXT PRIMARY KEY,leave_id TEXT NOT NULL REFERENCES hr_leaves(id),kind TEXT NOT NULL,status TEXT NOT NULL,
 target TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '',
 message_id INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS hr_leave_group_pending ON hr_leave_group_outbox(status,next);`);
 db.prepare("UPDATE hr_leave_group_outbox SET status='uncertain',error='Проверьте группу: отправка была прервана перезапуском' WHERE status='sending'").run();
 let running=false,stopped=false;
 const row=id=>{const leave=db.prepare('SELECT l.*,e.name FROM hr_leaves l JOIN employees e ON e.id=l.employee WHERE l.id=?').get(id);if(leave){const bound=!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tg_attendance_bindings'").get();leave.replacements=db.prepare('SELECT r.employee,e.name'+(bound?",b.chat":'')+' FROM hr_leave_replacements r JOIN employees e ON e.id=r.employee '+(bound?"LEFT JOIN tg_attendance_bindings b ON b.employee=e.id AND b.status='approved' AND e.active=1 ":'')+'WHERE r.leave_id=? ORDER BY r.rowid').all(id);}return leave;};
 function insert(leave,kind,target,eventKey=''){const now=clock();db.prepare('INSERT OR IGNORE INTO hr_leave_group_outbox(id,leave_id,kind,status,target,next,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(leave.id+':'+kind+(eventKey?':'+eventKey:''),leave.id,kind,'pending',JSON.stringify(target),now,now,now);}
 function enqueue(leave,{status,notifyGroup=false,eventKey=''}){
  if(status==='approved'&&notifyGroup&&['annual','unpaid'].includes(leave.kind))insert(leave,'approved',bot.leaveTarget(leave.employee));
  if(status==='replacements'&&notifyGroup&&['annual','unpaid'].includes(leave.kind)){
   const original=db.prepare("SELECT * FROM hr_leave_group_outbox WHERE leave_id=? AND kind='approved'").get(leave.id);
   if(!original)insert(leave,'approved',bot.leaveTarget(leave.employee));
   else if(original.status!=='pending')insert(leave,'replacements',JSON.parse(original.target),eventKey);
  }
  if(status==='cancelled'){
   db.prepare("UPDATE hr_leave_group_outbox SET status='cancelled',updated=? WHERE leave_id=? AND kind='approved' AND status IN ('pending','blocked')").run(clock(),leave.id);
   const sent=db.prepare("SELECT * FROM hr_leave_group_outbox WHERE leave_id=? AND kind='approved' AND status='sent'").get(leave.id);
   if(sent)insert(leave,'cancelled',JSON.parse(sent.target));
  }
 }
 function retry(id){const leave=row(id);if(!leave)fail('Отпуск не найден',404);if(!['approved','cancelled'].includes(leave.status))fail('Сначала согласуйте отпуск');const r=db.prepare('SELECT * FROM hr_leave_group_outbox WHERE leave_id=? ORDER BY created DESC,rowid DESC LIMIT 1').get(id);if(!r||r.status!=='blocked'||leave.status==='cancelled'&&r.kind!=='cancelled')fail('Повторная отправка недоступна. Если статус неясен, сначала проверьте группу.');const target=bot.leaveTarget(leave.employee);const old=JSON.parse(r.target);if(old.groupId&&old.groupId!==target.groupId||old.botId&&old.botId!==target.botId)fail('Рабочая группа или бот изменены: прежнее сообщение не будет перенаправлено');db.prepare("UPDATE hr_leave_group_outbox SET status='pending',target=?,attempts=0,next=?,error='',updated=? WHERE id=? AND status='blocked'").run(JSON.stringify(target),clock(),clock(),r.id);return {ok:true};}
 async function scan(){if(stopped||running)return;running=true;try{
  for(const r of db.prepare("SELECT * FROM hr_leave_group_outbox WHERE status='pending' AND next<=? ORDER BY created LIMIT 10").all(clock())){
   if(stopped)break;const leave=row(r.leave_id);
   if(!leave||leave.status!==(r.kind==='cancelled'?'cancelled':'approved')){db.prepare("UPDATE hr_leave_group_outbox SET status='cancelled',updated=? WHERE id=?").run(clock(),r.id);continue;}
   const target=JSON.parse(r.target);
   if(!target.ready){db.prepare("UPDATE hr_leave_group_outbox SET status='blocked',error=?,updated=? WHERE id=?").run(target.reason||'Проверьте подключение группы и привязку сотрудника',clock(),r.id);continue;}
   if(!db.prepare("UPDATE hr_leave_group_outbox SET status='sending',updated=? WHERE id=? AND status='pending'").run(clock(),r.id).changes)continue;
   try{
    const result=await bot.notifyLeaveGroup(leave.employee,leaveMessage(leave,target.userId,r.kind),target);
    const status=result.delivered?'sent':result.uncertain?'uncertain':result.retryable&&r.attempts<4?'pending':'blocked';
    db.prepare('UPDATE hr_leave_group_outbox SET status=?,attempts=attempts+1,next=?,error=?,message_id=?,updated=? WHERE id=?').run(status,clock()+60000,result.delivered?'':String(result.reason||'Сообщение не доставлено').slice(0,200),result.messageId||null,clock(),r.id);
    if(result.delivered&&r.kind==='approved'&&row(leave.id)?.status==='cancelled')enqueue(leave,{status:'cancelled'});
   }catch{db.prepare("UPDATE hr_leave_group_outbox SET status='uncertain',error='Проверьте группу: подтверждение доставки не получено',updated=? WHERE id=?").run(clock(),r.id);}
  }
 }finally{running=false}}
 return {enqueue,retry,scan,stop(){stopped=true}};
}
