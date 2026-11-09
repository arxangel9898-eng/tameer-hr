// Idempotent edits of the bot's own private notices. No attendance or payroll writes.
export function initShiftMessageSync(db,{bot,clock=Date.now,closedFor,closedText,responsible}){
 db.exec(`CREATE TABLE IF NOT EXISTS shift_bot_messages(
  bot_id TEXT NOT NULL,chat TEXT NOT NULL,message_id INTEGER NOT NULL,
  recipient TEXT NOT NULL,subject TEXT NOT NULL,day TEXT NOT NULL,shift TEXT,
  manager INTEGER NOT NULL,request_id TEXT,state TEXT NOT NULL DEFAULT 'watching',
  attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',updated INTEGER NOT NULL,
  PRIMARY KEY(bot_id,chat,message_id));
  CREATE INDEX IF NOT EXISTS shift_bot_messages_due ON shift_bot_messages(state,next);`);
 const target=id=>db.prepare("SELECT b.chat FROM tg_attendance_bindings b JOIN employees e ON e.id=b.employee WHERE b.employee=? AND b.status='approved' AND e.active=1").get(id);
 function watch({recipient,subject,day,shift=null,manager=false,requestId=null,messageId,pinned=null}){
  if(!Number.isSafeInteger(messageId)||messageId<1)return;
  const t=target(recipient),botId=String(pinned?.botId??bot.identity()),chat=String(pinned?.chat??t?.chat??'');
  if(!t||chat!==String(t.chat)||!/^\d+$/.test(chat)||botId!==String(bot.identity())||manager&&(!responsible(recipient)||recipient===subject))return;
  db.prepare(`INSERT OR IGNORE INTO shift_bot_messages(bot_id,chat,message_id,recipient,subject,day,shift,manager,request_id,updated)
   VALUES(?,?,?,?,?,?,?,?,?,?)`).run(botId,chat,messageId,recipient,subject,day,shift,Number(manager),requestId,clock());
 }
 let syncing=false;
 async function scan(){
  if(syncing||!bot.status().connected)return;syncing=true;
  try{let count=0;for(const m of db.prepare("SELECT * FROM shift_bot_messages WHERE state IN ('watching','pending') AND next<=? ORDER BY updated").all(clock())){
   const close=closedFor(m.subject,m.day,m.shift);if(!close)continue;
   const t=target(m.recipient);
   if(m.bot_id!==String(bot.identity())||!t||String(t.chat)!==m.chat||m.manager&&(!responsible(m.recipient)||m.recipient===m.subject)){
    db.prepare("UPDATE shift_bot_messages SET state='skipped',error='Бот, привязка или ответственный изменились',updated=? WHERE bot_id=? AND chat=? AND message_id=?").run(clock(),m.bot_id,m.chat,m.message_id);continue;
   }
   if(++count>20)break;
   const attempt=m.attempts+1;
   // The same edit can safely be retried after a timeout or restart.
   db.prepare("UPDATE shift_bot_messages SET state='pending',attempts=?,next=?,updated=? WHERE bot_id=? AND chat=? AND message_id=?").run(attempt,clock()+30000,clock(),m.bot_id,m.chat,m.message_id);
   let r;try{r=await bot.editAutomationMessage(m.recipient,closedText(m.subject,m.day,close),{botId:m.bot_id,chat:m.chat,messageId:m.message_id});}
   catch{r={delivered:false,retryable:true,reason:'Telegram временно недоступен'};}
   const again=!r.delivered&&r.retryable&&attempt<8;
   db.prepare('UPDATE shift_bot_messages SET state=?,next=?,error=?,updated=? WHERE bot_id=? AND chat=? AND message_id=?').run(r.delivered?'done':again?'pending':'failed',clock()+Math.max(Math.min(600,30*2**Math.min(5,attempt-1)),Number(r.retryAfter)||0)*1000,r.delivered?'':r.reason||'Не удалось обновить сообщение',clock(),m.bot_id,m.chat,m.message_id);
  }}finally{syncing=false;}
 }
 function view(){return db.prepare("SELECT m.recipient employee,e.name,m.subject,m.day,m.state,m.attempts,m.error,m.updated FROM shift_bot_messages m LEFT JOIN employees e ON e.id=m.recipient WHERE m.state<>'watching' ORDER BY m.updated DESC LIMIT 30").all();}
 return {watch,scan,view};
}
