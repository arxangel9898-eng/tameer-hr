import {geofenceProof} from './store-geofence.mjs';
import {trustedVideoRetry} from './telegram-video-retry.mjs';
import {randomUUID} from 'node:crypto';
import {statSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {plan,shiftDay,summarize,allowedActions,localDate,zonedTime,AUTO_CLOSE_TIME,AUTO_CLOSE_MARK} from './model.mjs';

// The web form and Telegram write to the same shift/event ledger.
export function initAttendance(db,{settings,eventsFor,transaction,fail,text,tz='Asia/Tashkent',dataDir,clock=Date.now,schedule=null,onEarlyExit=null,earlyForShift=()=>null,onShiftClosed=null,autoCloseSince=null,overtimeForShift=()=>null,pendingDeparture=()=>false}){
 db.exec(`CREATE TABLE IF NOT EXISTS attendance_evidence(
 id TEXT PRIMARY KEY,event INTEGER NOT NULL UNIQUE REFERENCES events(id),
 group_id TEXT NOT NULL,user_id TEXT NOT NULL,message_id INTEGER NOT NULL,
 file_id TEXT NOT NULL,file_unique_id TEXT NOT NULL UNIQUE,media_type TEXT NOT NULL,
 duration INTEGER NOT NULL,size INTEGER NOT NULL,filename TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,
 received_at INTEGER NOT NULL,UNIQUE(group_id,message_id));
 CREATE INDEX IF NOT EXISTS idx_attendance_evidence_event ON attendance_evidence(event);`);
 db.exec('CREATE TABLE IF NOT EXISTS attendance_evidence_bots(evidence TEXT PRIMARY KEY REFERENCES attendance_evidence(id),bot_id TEXT NOT NULL);CREATE TABLE IF NOT EXISTS attendance_evidence_geo(evidence TEXT PRIMARY KEY REFERENCES attendance_evidence(id),geo_check INTEGER NOT NULL)');
 const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
 const employee=id=>db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(id);
 const open=id=>db.prepare("SELECT * FROM shifts WHERE employee=? AND NOT EXISTS(SELECT 1 FROM events WHERE shift=shifts.id AND kind='out') ORDER BY created DESC LIMIT 1").get(id);
 function arrivalContext(id,at){
  const st=settings(),personal=schedule?.forMoment(id,at),day=personal?.day||shiftDay(at,st,tz),p=personal||plan(day,st,tz);
  const unclosed=db.prepare("SELECT * FROM shifts WHERE employee=? AND NOT EXISTS(SELECT 1 FROM events WHERE shift=shifts.id AND kind='out') ORDER BY day,created").all(id);
  // A new scheduled day may start without inventing yesterday's departure. Keep
  // the entire six-hour late-departure window and all overlapping plans protected.
  const oldOnly=unclosed.every(s=>s.day<day&&s.planned_end<=p.start&&at>s.planned_end+360*60000&&at>=p.start-180*60000&&!eventsFor(s.id).some(e=>['in','out','break_start','break_end'].includes(e.kind)&&e.at>=p.start-180*60000));
  const canIn=!personal?.off&&!personal?.conflict&&oldOnly&&!db.prepare('SELECT id FROM shifts WHERE employee=? AND day=?').get(id,day);
  return {day,p,canIn,unclosed,stalePrevious:unclosed.length>0&&oldOnly};
 }
 function shiftCutoff(shift){
  if(!autoCloseSince||shift.day<autoCloseSince)return null;
  const cutoff=zonedTime(shift.day,AUTO_CLOSE_TIME,tz);
  // Respect separately scheduled evening shifts and approved overtime.
  if(shift.planned_start>=cutoff||shift.planned_end>cutoff||(overtimeForShift(shift)?.targetAt??0)>cutoff)return null;
  return cutoff;
 }
 function videoCutoff(id,at){
  if(!autoCloseSince||!employee(id))return null;
  const day=localDate(at,tz).date;
  if(day<autoCloseSince)return null;
  const own=db.prepare('SELECT * FROM shifts WHERE employee=? AND day=?').get(id,day);
  if(own)return shiftCutoff(own);
  const previous=open(id);
  if(previous&&previous.day<day&&Math.max(previous.planned_end,overtimeForShift(previous)?.targetAt??0)>=at)return null;
  const shiftPlan=schedule?.forMoment(id,at)||plan(day,settings(),tz);
  if(shiftPlan.off||shiftPlan.conflict||shiftPlan.day&&shiftPlan.day!==day)return null;
  const cutoff=zonedTime(day,AUTO_CLOSE_TIME,tz);
  return shiftPlan.start<cutoff&&shiftPlan.end<=cutoff?cutoff:null;
 }
 function closeDue(){
  const now=clock(),day=localDate(now,tz).date;
  const result={closed:0,failed:0};
  if(!autoCloseSince||day<autoCloseSince)return result;
  const cutoff=zonedTime(day,AUTO_CLOSE_TIME,tz);
  // Allow the bot to receive Telegram updates sent in the last seconds before cutoff.
  if(now<cutoff+60_000)return result;
  const shifts=db.prepare(`SELECT s.* FROM shifts s JOIN employees e ON e.id=s.employee AND e.active=1
   WHERE s.day=? AND s.planned_end<=? AND NOT EXISTS(SELECT 1 FROM events WHERE shift=s.id AND kind='out')`).all(day,cutoff);
  for(const shift of shifts){
   try{
    if(shiftCutoff(shift)!==cutoff)continue;
    const ev=eventsFor(shift.id),arrival=ev.find(e=>e.kind==='in');
    const last=ev.reduce((at,e)=>['in','break_start','break_end'].includes(e.kind)?Math.max(at,e.at):at,0);
    if(!arrival||last>cutoff||!allowedActions(ev).includes('out')||pendingDeparture(shift,last,cutoff,now))continue;
    const saved=record({employee:shift.employee,shift:shift.id,kind:'out',requestId:'auto-close:'+shift.id},{at:cutoff,automatic:true});
    if(!saved.duplicate)result.closed++;
   }catch{result.failed++;}
  }
  return result;
 }
 function publicEvidence(e){const history=!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tg_history_imported'").get()&&!!db.prepare('SELECT evidence FROM tg_history_imported WHERE evidence=?').get(e.id);const location=!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tg_geofence_checks'").get()?db.prepare('SELECT c.distance,c.accuracy,c.location_at checkedAt FROM attendance_evidence_geo g JOIN tg_geofence_checks c ON c.id=g.geo_check WHERE g.evidence=?').get(e.id)||null:null;return {location,id:e.id,source:history?'telegram-history':'telegram-video',historyImport:history,url:'/api/attendance-video?id='+e.id,messageUrl:/^-100\d+$/.test(e.group_id)?'https://t.me/c/'+e.group_id.slice(4)+'/'+e.message_id:null,receivedAt:e.received_at}}
 function evidenceFor(shift){return db.prepare('SELECT a.*,e.kind,e.at FROM attendance_evidence a JOIN events e ON e.id=a.event WHERE e.shift=? ORDER BY e.at,e.id').all(shift).map(e=>({...publicEvidence(e),event:e.event,kind:e.kind,at:e.at}))}
 function intent(id,at=clock()){
  if(!employee(id))return {canIn:false,canOut:false,autoKind:null};
  const context=arrivalContext(id,at),{p,canIn}=context;
  if(canIn&&context.stalePrevious)return {canIn:true,canOut:false,autoKind:at>=p.start-180*60000&&at<=p.start+240*60000?'in':null,unclosedPrevious:context.unclosed.map(s=>({shift:s.id,day:s.day}))};
  const s=open(id);if(s){if(context.stalePrevious)return {canIn:false,canOut:false,autoKind:null,needsHR:true};const ev=eventsFor(s.id),start=ev.find(e=>e.kind==='in')?.at,last=Math.max(0,...ev.filter(e=>['in','out','break_start','break_end'].includes(e.kind)).map(e=>e.at)),canOut=at>=last&&allowedActions(ev).includes('out');return {canIn:false,canOut,plannedEnd:s.planned_end,earlyMinutes:Math.max(0,Math.ceil((s.planned_end-at)/60000)),autoKind:canOut&&start&&at-start>=3600000&&at>=s.planned_end-180*60000&&at<=s.planned_end+360*60000?'out':null}}
  return {canIn,canOut:false,autoKind:canIn&&at>=p.start-180*60000&&at<=p.start+240*60000?'in':null};
 }
 function record(b,{at=clock(),evidence=null,identity='salary',botId='',earlyExit=null,automatic=false}={}){
  if(!['in','out','break_start','break_end','uniform','note'].includes(b.kind))fail('Неизвестная отметка');
  const rid=text(b.requestId,'Код операции',64);
  if(!Number.isSafeInteger(at)||at<0||at>clock()+60000)fail('Проверьте время отметки');
  return transaction(()=>{
   const prior=db.prepare('SELECT e.*,s.employee,s.day FROM events e JOIN shifts s ON s.id=e.shift WHERE e.request_id=?').get(rid);
   if(prior){if(prior.employee!==b.employee||prior.kind!==b.kind)fail('Код операции уже использован',409);const s=db.prepare('SELECT * FROM shifts WHERE id=?').get(prior.shift);return {ok:true,duplicate:true,event:prior.id,shift:s.id,day:s.day,summary:summarize(s,eventsFor(s.id),clock())}}
   const e=employee(b.employee);if(!e)fail('Активный сотрудник не найден');
   let locationProof=null;
   if(evidence){
    const v=evidence;if(!['in','out'].includes(b.kind)||!uuid(v.id)||!/^-[1-9]\d{0,18}$/.test(v.groupId)||!/^\d{1,19}$/.test(v.userId)||!Number.isSafeInteger(v.messageId)||v.messageId<1||!['video','video_note'].includes(v.mediaType)||typeof v.fileId!=='string'||v.fileId.length>512||!v.fileId||typeof v.fileUniqueId!=='string'||!v.fileUniqueId||v.fileUniqueId.length>256||!Number.isInteger(v.duration)||v.duration<0||v.duration>86400||!Number.isSafeInteger(v.size)||v.size<12||v.size>20*1024*1024||v.filename!==v.id+'.mp4'||!/^[a-f0-9]{64}$/.test(v.sha256))fail('Проверьте данные видео');
    if(at<clock()-10*60000&&!trustedVideoRetry(db,{employee:b.employee,kind:b.kind,at,evidence:v,botId,now:clock()}))fail('Видео отправлено больше 10 минут назад. Обратитесь к администратору');
    if(!['salary','attendance'].includes(identity))fail('Неизвестный источник отметки',403);
    if(identity==='attendance'){const bot=db.prepare('SELECT bot_id,enabled FROM tg_attendance_bot_config WHERE id=1').get();if(!bot?.enabled||typeof botId!=='string'||bot.bot_id!==botId)fail('Бот отметок отключён или изменён',403);}
    const bound=db.prepare(identity==='attendance'?"SELECT b.employee FROM tg_attendance_bindings b JOIN employees e ON e.id=b.employee WHERE b.chat=? AND b.status='approved' AND e.active=1":"SELECT b.employee FROM tg_bindings b JOIN employees e ON e.id=b.employee WHERE b.chat=? AND b.status='approved' AND e.active=1").get(v.userId);if(bound?.employee!==b.employee)fail('Привязка сотрудника больше не подтверждена',403);
    if(identity==='attendance'){const cutoff=videoCutoff(b.employee,at);if(cutoff!==null&&at>=cutoff)fail('Видео отправлено после времени автозакрытия смены',409);locationProof=geofenceProof(db,{employee:b.employee,kind:b.kind,at,evidence:v,botId});if(!locationProof.ok)fail('Для этого видео нужна подтверждённая геолокация в территории магазина',403);}
    if(db.prepare('SELECT id FROM attendance_evidence WHERE (group_id=? AND message_id=?) OR file_unique_id=?').get(v.groupId,v.messageId,v.fileUniqueId))fail('Это видео уже использовано для отметки',409);
    let stat;try{stat=statSync(join(dataDir,'attendance-videos',v.filename))}catch{fail('Видео не сохранено. Отметка не создана')};if(!stat.isFile()||stat.size!==v.size)fail('Видео не сохранено полностью. Отметка не создана');
   }
   let s;
   if(b.kind==='in'){
    const st=settings(),personal=schedule?.forMoment(e.id,at),day=personal?.day||shiftDay(at,st,tz);if(personal?.off||personal?.conflict)fail('По графику выходной, согласованное отсутствие или конфликт. HR должен изменить план');const context=arrivalContext(e.id,at);if(open(e.id)&&!context.stalePrevious)fail('У сотрудника уже есть незакрытая смена');if(db.prepare('SELECT id FROM shifts WHERE employee=? AND day=?').get(e.id,day))fail('Смена за этот день уже зарегистрирована');
    const p=personal||plan(day,st,tz);s={id:randomUUID(),employee:e.id,day,planned_start:p.start,planned_end:p.end,grace:st.grace,break_limit:st.breakLimit,created:clock()};db.prepare('INSERT INTO shifts VALUES(?,?,?,?,?,?,?,?)').run(s.id,s.employee,s.day,s.planned_start,s.planned_end,s.grace,s.break_limit,s.created);
   }else{s=b.shift?db.prepare('SELECT * FROM shifts WHERE id=? AND employee=?').get(b.shift,e.id):open(e.id);if(!s)fail('Сначала отметьте приход');if(!b.shift&&arrivalContext(e.id,at).stalePrevious)fail('Предыдущая незакрытая смена требует проверки HR. Сегодняшний уход к ней не относится')}
   const ev=eventsFor(s.id);if(ev.some(e=>['in','out','break_start','break_end'].includes(e.kind)&&e.at>at))fail('Отметка раньше последнего события смены');
   let value='';if(b.kind==='uniform'){if(!['yes','no','unknown'].includes(b.value))fail('Выберите результат проверки формы');value=b.value}else if(b.kind==='note')value=text(b.value,'Комментарий',500);else if(!allowedActions(ev).includes(b.kind))fail('Такая отметка сейчас недоступна');
   if(automatic&&b.kind==='out'&&!evidence)value=AUTO_CLOSE_MARK;
   if(b.kind==='out'&&ev.filter(e=>['in','break_start','break_end'].includes(e.kind)).at(-1)?.kind==='break_start')db.prepare('INSERT INTO events(request_id,shift,kind,at) VALUES(?,?,?,?)').run(rid+'-break',s.id,'break_end',at);
   const id=Number(db.prepare('INSERT INTO events(request_id,shift,kind,at,value) VALUES(?,?,?,?,?)').run(rid,s.id,b.kind,at,value).lastInsertRowid);
   if(evidence){const v=evidence;db.prepare('INSERT INTO attendance_evidence(id,event,group_id,user_id,message_id,file_id,file_unique_id,media_type,duration,size,filename,sha256,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(v.id,id,v.groupId,v.userId,v.messageId,v.fileId,v.fileUniqueId,v.mediaType,v.duration,v.size,v.filename,v.sha256,clock());if(identity==='attendance')db.prepare('INSERT INTO attendance_evidence_bots(evidence,bot_id) VALUES(?,?)').run(v.id,botId);if(locationProof?.checkId)db.prepare('INSERT INTO attendance_evidence_geo(evidence,geo_check) VALUES(?,?)').run(v.id,locationProof.checkId);}
   let permission=null;if(earlyExit){if(b.kind!=='out'||identity!=='attendance'||!onEarlyExit)fail('Разрешение раннего ухода недоступно');permission=onEarlyExit({shift:s.id,event:id,employee:e.id,at,evidence,botId,responsibleKey:earlyExit.responsibleKey});}if(b.kind==='out')onShiftClosed?.({shift:s.id,event:id,employee:e.id,day:s.day,at});return {ok:true,event:id,shift:s.id,day:s.day,summary:summarize(s,eventsFor(s.id),clock()),earlyExit:permission};
  });
 }
 function video(id){if(!uuid(id))fail('Видео не найдено',404);const e=db.prepare('SELECT * FROM attendance_evidence WHERE id=?').get(id);if(!e||e.filename!==e.id+'.mp4')fail('Видео не найдено',404);try{return {bytes:readFileSync(join(dataDir,'attendance-videos',e.filename)),mime:'video/mp4'}}catch{fail('Файл видео недоступен. Проверьте резервную копию',404)}}
 function requestResult(employee,requestId){const e=db.prepare('SELECT e.*,s.employee,s.day FROM events e JOIN shifts s ON s.id=e.shift WHERE e.request_id=? AND s.employee=?').get(requestId,employee);if(!e)return null;const s=db.prepare('SELECT * FROM shifts WHERE id=?').get(e.shift);return {ok:true,duplicate:true,event:e.id,shift:e.shift,day:e.day,kind:e.kind,earlyExit:earlyForShift(s.id),summary:summarize(s,eventsFor(s.id),clock())}}
 return {record,intent,evidenceFor,video,requestResult,videoCutoff,closeDue};
}
