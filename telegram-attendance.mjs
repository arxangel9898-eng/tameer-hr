import {initAttendanceMini} from './attendance-mini.mjs';
import {initStoreGeofence} from './store-geofence.mjs';
import {initVideoRetry} from './telegram-video-retry.mjs';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {join} from 'node:path';
import {localDate} from './model.mjs';

const MAX_BYTES=20*1024*1024,MAX_AGE=10*60000,RESERVE_BYTES=1024*1024*1024;
const validGroup=id=>typeof id==='string'&&/^-[1-9]\d{0,15}$/.test(id)&&Number.isSafeInteger(Number(id));
const validUser=id=>Number.isSafeInteger(id)&&id>0;
const fresh=(at,now)=>Number.isSafeInteger(at)&&at>0&&now-at<=MAX_AGE&&at-now<=60000;
const forwarded=m=>!!(m.forward_origin||m.forward_from||m.forward_from_chat||m.forward_date||m.is_automatic_forward||m.sender_chat||m.via_bot);

// Only Telegram's fixed file endpoint is used; never persist or return a token URL.
export async function downloadAttendanceVideo({token,filePath,maxBytes=MAX_BYTES,signal}){
 const response=await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`,{signal:signal||AbortSignal.timeout(25000),redirect:'error'});
 if(!response.ok)throw Object.assign(Error('Video download failed'),{httpStatus:response.status,retryAfter:Number(response.headers.get('retry-after'))||0});
 if(Number(response.headers.get('content-length')||0)>maxBytes)throw Object.assign(Error('Video too large'),{code:'ATTENDANCE_INVALID_FILE'});
 const chunks=[];let size=0;
 try{for await(const value of response.body){const chunk=Buffer.from(value);size+=chunk.length;if(size>maxBytes)throw Object.assign(Error('Video too large'),{code:'ATTENDANCE_INVALID_FILE'});chunks.push(chunk)}}catch(e){throw Object.assign(Error('Video download failed'),{name:e.name,code:e.code,cause:e.cause})}
 return Buffer.concat(chunks,size);
}

export function createTelegramAttendance(db,{dataDir,tz,attendance=null,call,payroll,transaction,fail,download=downloadAttendanceVideo,clock=Date.now,botUsername=()=>'',botConnected=()=>false,bindingResolver=null,storage=null,earlyExit=null,botIdentity=()=>'',extensions=()=>null,publicURL='',authenticateMini=()=>{throw Object.assign(Error('Откройте приложение через Telegram'),{status:401})}}){
 db.exec(`CREATE TABLE IF NOT EXISTS tg_attendance_config(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,group_id TEXT NOT NULL DEFAULT '',mode TEXT NOT NULL DEFAULT 'confirm',revision INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS tg_attendance_requests(group_id TEXT NOT NULL,message_id INTEGER NOT NULL,user_id TEXT NOT NULL,employee TEXT NOT NULL,file_unique_id TEXT NOT NULL UNIQUE,media TEXT NOT NULL,at INTEGER NOT NULL,callback_token TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',prompted INTEGER NOT NULL DEFAULT 0,result TEXT NOT NULL DEFAULT '',PRIMARY KEY(group_id,message_id));
 CREATE TABLE IF NOT EXISTS tg_attendance_private_messages(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,employee TEXT NOT NULL,bot_id TEXT NOT NULL,kind TEXT NOT NULL,reference TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,next INTEGER NOT NULL DEFAULT 0);`);
 db.prepare("INSERT OR IGNORE INTO tg_attendance_config(id) VALUES(1)").run();
 const config=()=>db.prepare('SELECT * FROM tg_attendance_config WHERE id=1').get();
 const request=(group,message)=>db.prepare('SELECT * FROM tg_attendance_requests WHERE group_id=? AND message_id=?').get(group,message);
 const binding=user=>bindingResolver?bindingResolver(String(user)):db.prepare("SELECT b.employee,e.name FROM tg_bindings b JOIN employees e ON e.id=b.employee WHERE b.chat=? AND b.status='approved' AND e.active=1").get(String(user));
 const disk={mkdir,writeFile,rename,unlink,statfsSync,...storage};
 const retry=initVideoRetry(db,{clock,botIdentity});
 const geo=initStoreGeofence(db,{clock,botIdentity,fail,transaction,payroll});
 const mini=initAttendanceMini(db,{clock,fail,transaction,payroll,publicURL,botIdentity,authenticate:authenticateMini,contextFor:miniContext,accept:geo.acceptMini,save(r,kind,permission,token,expectedBot){const task=queue.then(()=>{if(!botConnected()||String(botIdentity())!==expectedBot)fail('Бот изменился',403);return save(token,r,kind,permission);});queue=task.catch(()=>{});return task;}});
 let lastError='',lastSeen=null,queue=Promise.resolve();
 function storageStatus(){try{const stat=disk.statfsSync(dataDir),freeBytes=Number(stat.bavail)*Number(stat.bsize);return {freeBytes:Number.isSafeInteger(freeBytes)&&freeBytes>=0?freeBytes:null,reserveBytes:RESERVE_BYTES}}catch{return {freeBytes:null,reserveBytes:RESERVE_BYTES}}}
 function status(){const c=config();return {enabled:!!c.enabled,groupId:c.group_id,mode:c.mode,miniApp:mini.view(),geofence:geo.view(),videoRetry:retry.view(),privateReplies:true,arrivalReplies:'group',closureReplies:'group',privateWaiting:db.prepare("SELECT COUNT(*) n FROM tg_attendance_private_messages WHERE status IN ('pending','blocked','uncertain') AND expires>?").get(clock()).n,maxVideoMB:20,lastError,lastSeen,available:!!attendance,botConnected:botConnected(),storage:storageStatus(),saved:db.prepare("SELECT COUNT(*) n FROM tg_attendance_requests WHERE status='saved'").get().n}}
 function settings(b){
  if(typeof b.enabled!=='boolean'||typeof b.groupId!=='string'||!['confirm','auto'].includes(b.mode))fail('Укажите группу и режим видеоотметок');
  const group=b.groupId.trim();if(group&&!validGroup(group)||b.enabled&&!validGroup(group))fail('ID группы — отрицательное целое число, например -1001234567890');
  if(b.enabled&&!attendance)fail('Учёт смен недоступен');
  if(b.enabled&&!botConnected())fail('Сначала подключите отдельного бота смен');
  transaction(()=>{const before=config();db.prepare('UPDATE tg_attendance_config SET enabled=?,group_id=?,mode=?,revision=revision+1 WHERE id=1').run(Number(b.enabled),group,b.mode);payroll.audit('telegram-attendance-settings',null,null,{before:{enabled:!!before.enabled,groupId:before.group_id,mode:before.mode},after:{enabled:b.enabled,groupId:group,mode:b.mode}})});lastError='';return {ok:true,attendance:status()};
 }
 // Personal notices and interactive controls never fall back to a group.
 function deliverable(r){
  if(!validUser(Number(r.user_id))||!botConnected()||r.bot_id!==String(botIdentity())||r.expires<=clock())return false;
  if(r.employee&&binding(r.user_id)?.employee!==r.employee)return false;
  if(r.kind==='geo-mini'){const [reference,revision]=r.reference.split(':'),q=db.prepare('SELECT * FROM tg_attendance_requests WHERE callback_token=?').get(reference);return !!q&&validRequest(q)&&geo.waiting(q)&&mini.active()&&mini.config().revision===Number(revision);}
  if(r.kind==='geo'){const q=db.prepare('SELECT * FROM tg_attendance_requests WHERE callback_token=?').get(r.reference);return !!q&&validRequest(q)&&geo.waiting(q);}
  if(r.kind==='prompt'){const q=db.prepare('SELECT * FROM tg_attendance_requests WHERE callback_token=?').get(r.reference);return !!q&&q.status==='pending'&&validRequest(q);}
  if(r.kind==='video-failure'){const q=db.prepare('SELECT * FROM tg_attendance_requests WHERE callback_token=?').get(r.reference),j=q&&retry.get(q),c=config();if(!responsibles().includes(r.employee)||!q||!j||j.bot_id!==String(botIdentity())||c.group_id!==q.group_id||c.revision!==q.revision)return false;}
  if(r.kind==='early'){const target=earlyExit?.privateTarget(r.reference);return target?.chat===r.user_id&&target.employee===r.employee;}
  return true;
 }
 async function deliver(token,r){
  if(!deliverable(r)){db.prepare("UPDATE tg_attendance_private_messages SET status='skipped' WHERE id=?").run(r.id);return false;}
  // Persist before transport: a restart must not blindly repeat an uncertain delivery.
  db.prepare("UPDATE tg_attendance_private_messages SET status='uncertain' WHERE id=?").run(r.id);
  try{await call(token,'sendMessage',{...JSON.parse(r.payload),chat_id:r.user_id,protect_content:true});db.prepare("UPDATE tg_attendance_private_messages SET status='sent' WHERE id=?").run(r.id);return true;}
  catch(e){const retry=e.apiCode===429;db.prepare('UPDATE tg_attendance_private_messages SET status=?,next=? WHERE id=?').run(retry?'pending':e.apiCode===403?'blocked':'uncertain',clock()+Math.max(1,Number(e.retryAfter)||30)*1000,r.id);lastError='Не доставлено личное сообщение. Сотруднику нужно открыть @'+botUsername()+' и нажать «Старт»; после разблокировки отправить /start. В группу сообщения не отправляются.';return false;}
 }
 async function reply(token,user,message,text,markup,extra={},meta={}){
  if(!validUser(Number(user)))return false;
  const id=meta.id||randomUUID(),prior=db.prepare('SELECT * FROM tg_attendance_private_messages WHERE id=?').get(id);
  if(prior)return prior.status==='sent';
  db.prepare('INSERT INTO tg_attendance_private_messages(id,user_id,employee,bot_id,kind,reference,payload,status,created,expires) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,String(user),meta.employee||binding(user)?.employee||'',String(botIdentity()),meta.kind||'notice',meta.reference||'',JSON.stringify({text,...(markup?{reply_markup:markup}:{}),...extra}),'pending',clock(),meta.expires||clock()+7*86400000);
  return deliver(token,db.prepare('SELECT * FROM tg_attendance_private_messages WHERE id=?').get(id));
 }
 async function flush(token,user=null){
  const rows=user?db.prepare("SELECT * FROM tg_attendance_private_messages WHERE user_id=? AND status IN ('pending','blocked','uncertain') ORDER BY created LIMIT 30").all(String(user)):db.prepare("SELECT * FROM tg_attendance_private_messages WHERE status='pending' AND next<=? ORDER BY created LIMIT 30").all(clock());
  for(const r of rows)await deliver(token,r);
 }
 async function notifyEarly(token,r){
  const target=earlyExit?.privateTarget(r.token);
  if(!target){lastError='Заявка сохранена в программе. Ответственному нужно подтвердить привязку и нажать «Старт» у бота смен.';return;}
  await reply(token,target.chat,0,earlyExit.notice(r),{inline_keyboard:[[{text:'✅ Подтверждаю / Tasdiqlayman',callback_data:`eex:${r.token}:approved`},{text:'❌ Не разрешал / Ruxsat bermadim',callback_data:`eex:${r.token}:rejected`}]]},{parse_mode:'HTML'},{id:'early:'+r.token,employee:target.employee,kind:'early',reference:r.token});
 }
 async function resume(token,user){
  await flush(token,user);
  const employee=binding(user);if(!employee)return;
  const waiting=geo.pendingFor(user);if(waiting){const q=request(waiting.group_id,waiting.message_id);if(q&&validRequest(q)){await geoPrompt(token,q,true);for(const r of earlyExit?.pendingFor?.(employee.employee)||[])await notifyEarly(token,r);return;}}
  // Includes prompts created before private delivery was introduced.
  for(const r of db.prepare("SELECT * FROM tg_attendance_requests WHERE user_id=? AND status='pending' AND at>=? ORDER BY at DESC LIMIT 3").all(String(user),clock()-MAX_AGE))if(validRequest(r))await prompt(token,{...r,prompted:0});
  for(const r of earlyExit?.pendingFor?.(employee.employee)||[])await notifyEarly(token,r);
 }
 async function answer(token,q,text){try{await call(token,'answerCallbackQuery',{callback_query_id:q.id,text,show_alert:false})}catch{lastError='Не удалось ответить на кнопку Telegram'}}
 const instructions='Отправьте новое видео у входа с подписью «Пришёл» / Keldim / Омадам или «Ушёл» / Ketdim / Рафтам. Для видео без подписи выберите кнопку. Видео фиристед: «Омадам» — оғоз, «Рафтам» — анҷом.';
 async function intent(employee,at){if(typeof attendance?.intent!=='function')return {canIn:true,canOut:true,autoKind:null};return attendance.intent(employee,at)}
 function pastVideoCutoff(employee,at){const cutoff=attendance?.videoCutoff?.(employee,at);return Number.isSafeInteger(cutoff)&&at>=cutoff}
 function validRequest(r,retrying=false){const c=config(),employee=binding(r.user_id);return !!(c.enabled&&botConnected()&&attendance&&c.group_id===r.group_id&&c.revision===r.revision&&employee&&employee.employee===r.employee&&(fresh(r.at,clock())||retrying&&retry.eligible(r)))}
 async function recover(r,token=null,retrying=false){
  if(!validRequest(r,retrying)||typeof attendance.requestResult!=='function')return null;
  const prior=await attendance.requestResult(r.employee,'telegram:'+r.group_id+':'+r.message_id);
  if(!prior?.ok||!['in','out'].includes(prior.kind))return null;
  db.prepare("UPDATE tg_attendance_requests SET status='saved',result=? WHERE group_id=? AND message_id=?").run(JSON.stringify({kind:prior.kind,day:prior.day,summary:prior.summary}),r.group_id,r.message_id);
  lastSeen=clock();lastError='';if(retry.get(r)){retry.done(r);if(token)await notifySaved(token,r,prior,prior.kind);}return {ok:true,duplicate:true};
 }
 function captionKind(caption){const s=typeof caption==='string'?caption.trim().toLocaleLowerCase('ru').replace(/ё/g,'е'):'';if(['пришел','приход','keldim','омадам','омад'].includes(s))return 'in';if(['ушел','уход','ketdim','рафтам','рафт'].includes(s))return 'out';return null}
 async function prompt(token,r){
  if(geo.waiting(r)){await geoPrompt(token,r);return;}
  if(r.prompted)return;
  const allowed=await intent(r.employee,r.at),buttons=[],delivery={id:'prompt:'+r.callback_token,employee:r.employee,kind:'prompt',reference:r.callback_token,expires:r.at+MAX_AGE};
  if(allowed.canIn)buttons.push({text:'▶️ Начать / Boshlash',callback_data:`tga:${r.callback_token}:in`});
  if(allowed.canOut)buttons.push({text:'⏹ Ушёл / Ketdim',callback_data:`tga:${r.callback_token}:out`});
  if(allowed.canOut&&allowed.earlyMinutes>0&&earlyExit?.enabled()){buttons.push({text:'📝 По разрешению / Ruxsat bilan',callback_data:`tga:${r.callback_token}:permit`});buttons.push({text:'↩ Остаться / Qolish',callback_data:`tga:${r.callback_token}:stay`});}
  if(!buttons.length){await reply(token,r.user_id,r.message_id,'Для этой смены отметка сейчас недоступна. Проверьте график у HR.',null,{},delivery);db.prepare('UPDATE tg_attendance_requests SET prompted=1 WHERE group_id=? AND message_id=?').run(r.group_id,r.message_id);return}
  await reply(token,r.user_id,r.message_id,allowed.canOut&&allowed.earlyMinutes>0&&earlyExit?.enabled()?'До конца смены ещё '+allowed.earlyMinutes+' мин. Выберите обычный уход или уход по разрешению. / Erta ketish: oddiy ketish yoki ruxsat bilan. Кнопка действует 10 минут.':'Выберите отметку для своего видео. / O‘z videongiz uchun belgini tanlang. Кнопка действует 10 минут.',{inline_keyboard:[buttons]},{},delivery);
  db.prepare('UPDATE tg_attendance_requests SET prompted=1 WHERE group_id=? AND message_id=?').run(r.group_id,r.message_id);
 }
 async function save(token,r,kind,permission=null,retrying=false){
  if(r.status==='saved')return {ok:true,duplicate:true};
  if(r.status==='cancelled')return {ok:false,reason:'Вы выбрали остаться. Для новой отметки отправьте новое видео.'};
  if(!validRequest(r,retrying))return {ok:false,reason:'Эта отметка недействительна. Отправьте новое видео. / Yangi video yuboring.'};
  const recovered=await recover(r,token,retrying);if(recovered)return recovered;
  if(pastVideoCutoff(r.employee,r.at)){retry.stop(r,'AFTER_SHIFT_CUTOFF');return {ok:false,notified:true,reason:'Smena uchun video qabul qilish vaqti tugagan.'};}
  const allowed=await intent(r.employee,r.at);if(!(kind==='in'?allowed.canIn:allowed.canOut)){retry.stop(r,'SHIFT_STATE_CHANGED','failed');return {ok:false,reason:'Эта отметка сейчас недоступна. Проверьте состояние смены у HR.'};}
  const place=geo.begin(r,kind,permission);if(!place.allowed){if(place.expired){if(retrying)retry.stop(r,'GEOFENCE_REQUIRED','failed');return {ok:false,reason:'Для проверки территории нужны новое видео и геолокация в течение 2 минут. / Yangi video va joylashuv yuboring.'};}await geoPrompt(token,r);return {ok:false,notified:true,reason:'Отправьте текущее местоположение в личку боту. / Joylashuvni botga yuboring.'};}
  const attempt=retry.begin(r,kind,permission);if(!attempt.ok)return {ok:false,retry:!!attempt.pending,reason:attempt.pending?'Видео уже в очереди. Бот повторит обработку автоматически.':'Повторы завершены. Обратитесь к администратору с исходным видео.'};
  const media=JSON.parse(r.media),id=randomUUID(),filename=id+'.mp4',directory=join(dataDir,'attendance-videos'),path=join(directory,filename),temporary=path+'.tmp';let stored=false,accepted=false,result,stage='telegram-file';const setStage=value=>{stage=value;retry.phase(r,value)};
  try{
   setStage('telegram-file');
   const meta=await call(token,'getFile',{file_id:media.file_id});
   if(!meta||typeof meta.file_path!=='string'||!/^[-A-Za-z0-9_./]+$/.test(meta.file_path)||meta.file_path.startsWith('/')||meta.file_path.includes('..')||meta.file_size>MAX_BYTES)throw Object.assign(Error('Invalid video metadata'),{code:'ATTENDANCE_INVALID_FILE'});
   setStage('download');
   const video=Buffer.from(await download({token,filePath:meta.file_path,maxBytes:MAX_BYTES,signal:AbortSignal.timeout(25000)}));
   if(video.length<12||video.length>MAX_BYTES||video.toString('ascii',4,8)!=='ftyp')throw Object.assign(Error('Invalid video'),{code:'ATTENDANCE_INVALID_FILE'});
   // Configuration/binding can change while the download is in progress.
   const current=config(),currentEmployee=binding(r.user_id);
   if(!current.enabled||!botConnected()||current.revision!==r.revision||current.group_id!==r.group_id||!currentEmployee||currentEmployee.employee!==r.employee||!(fresh(r.at,clock())||retrying&&retry.eligible(r)))throw Object.assign(Error('Attendance changed'),{code:'ATTENDANCE_CHANGED'});
   setStage('storage');
   const room=storageStatus();if(room.freeBytes===null||room.freeBytes<RESERVE_BYTES+video.length)throw Object.assign(Error('Insufficient attendance storage'),{code:'ATTENDANCE_NO_SPACE'});
   await disk.mkdir(directory,{recursive:true,mode:0o700});await disk.writeFile(temporary,video,{flag:'wx',mode:0o600});await disk.rename(temporary,path);stored=true;
   const finalConfig=config(),finalEmployee=binding(r.user_id);
   if(!finalConfig.enabled||!botConnected()||finalConfig.revision!==r.revision||finalConfig.group_id!==r.group_id||!finalEmployee||finalEmployee.employee!==r.employee||!(fresh(r.at,clock())||retrying&&retry.eligible(r)))throw Object.assign(Error('Attendance changed'),{code:'ATTENDANCE_CHANGED'});
   setStage('ledger');
   result=await attendance.record({employee:r.employee,kind,requestId:'telegram:'+r.group_id+':'+r.message_id},{at:r.at,...(permission?{earlyExit:permission}:{}),evidence:{id,groupId:r.group_id,userId:r.user_id,messageId:r.message_id,fileId:media.file_id,fileUniqueId:r.file_unique_id,mediaType:media.type,duration:media.duration,size:video.length,filename,sha256:createHash('sha256').update(video).digest('hex')}});
   if(!result?.ok)throw Object.assign(Error('Attendance not saved'),{code:'ATTENDANCE_LEDGER_REJECTED'});
   accepted=!result.duplicate;
   setStage('bookkeeping');
   db.prepare("UPDATE tg_attendance_requests SET status='saved',result=? WHERE group_id=? AND message_id=?").run(JSON.stringify({kind,day:result.day,summary:result.summary}),r.group_id,r.message_id);
  }catch(error){
   const failure=retry.fail(r,stage,error),noSpace=error?.code==='ATTENDANCE_NO_SPACE';
   lastError=(noSpace?'Недостаточно места для видео: нужен резерв 1 ГиБ. ':'')+'Видео №'+r.message_id+': '+stage+' / '+failure.code+(failure.retry?' · запланирован автоматический повтор':' · нужна проверка администратора');
   if(!failure.retry)await notifyFailure(token,r);
   return {ok:false,retry:failure.retry,notified:!failure.retry,reason:failure.retry?(noSpace?'Недостаточно места для видео (резерв 1 ГиБ). Бот повторит автоматически; исходное время сохранится. / Serverda joy yetarli emas.':'Временный сбой обработки видео. Бот повторит попытку автоматически; время исходного видео сохранится. / Bot avtomatik qayta urinadi.'):noSpace?'Видео не сохранено: мало места. Ответственным отправлено сообщение. / Serverda joy yetarli emas.':'Видео не удалось сохранить. Ошибка записана в журнал; обратитесь к ответственному с исходным видео.'};
  }finally{
   await disk.unlink(temporary).catch(()=>{});if(stored&&!accepted)await disk.unlink(path).catch(()=>{});
  }
  lastSeen=clock();lastError='';
  if(result.duplicate)return {ok:true,duplicate:true};
  retry.done(r);await notifySaved(token,r,result,kind);return {ok:true};
 }
 async function notifySaved(token,r,result,kind){
  const s=result.summary||{},credit=kind==='in'&&s.automaticLateCredit,when=localDate(credit?.at??r.at,tz).time;
  const text=kind==='in'?`✅ Смена открыта / Smena boshlandi · ${when}\nОпоздание / Kechikish: ${Math.max(0,s.late||0)} мин.${credit?'\nУчётный приход установлен автоматически по разрешению.\nРазрешил(а): '+credit.authorizedByName+'\nФактическое видео: '+localDate(credit.videoAt,tz).time:''}`:`✅ Смена закрыта / Smena yakunlandi · ${when}\nОтработано / Ishlandi: ${Math.max(0,s.worked||0)} мин.${s.early?'\nРанний уход / Erta ketish: '+Math.max(0,s.early)+' мин.':''}`;
  {
   // Explicitly public arrival/departure receipt for this employee's accepted video.
   // Reminders, requests, decisions and all interactive controls stay private.
   const c=config();if(c.enabled&&botConnected()&&c.group_id===r.group_id&&c.revision===r.revision){
    if(!retry.receipt(r)){retry.receipt(r,'sending');try{await call(token,'sendMessage',{chat_id:r.group_id,text,protect_content:true,reply_parameters:{message_id:r.message_id,allow_sending_without_reply:true}});retry.receipt(r,'sent');}
    catch{retry.receipt(r,'uncertain');lastError='Отметка смены сохранена. Не удалось отправить подтверждение в рабочую группу.';}}
   }
  }
  if(result.earlyExit&&earlyExit)await notifyEarly(token,result.earlyExit);
  return {ok:true};
 }
 async function callback(q,token){
  if(typeof q.data!=='string')return false;
  if(q.data.startsWith('eex:')){const match=q.data.match(/^eex:([A-Za-z0-9_-]{24}):(approved|rejected)$/),c=config(),manager=binding(q.from?.id);if(!earlyExit||!match||!c.enabled||!botConnected()||!validUser(q.from?.id)||q.from.is_bot||!manager||q.message?.chat?.type!=='private'||String(q.message.chat.id)!==String(q.from.id)){await answer(token,q,'Подтверждение недоступно. Обратитесь к администратору.');return true;}try{const result=earlyExit.decide(match[1],match[2],{telegram:true,id:'telegram:'+q.from.id,employee:manager.employee,chat:String(q.from.id),groupId:c.group_id,botId:botIdentity()});await answer(token,q,result.duplicate?'Решение уже сохранено':'Решение сохранено');if(!result.duplicate){const r=result.request,text=(match[2]==='approved'?'✅ Разрешение подтверждено / Ruxsat tasdiqlandi':'❌ Разрешение не подтверждено / Ruxsat tasdiqlanmadi')+'\n'+r.name+' · '+r.responsible_name+'\n'+(match[2]==='approved'?'Ранний уход исключён из расчёта дисциплины. Фактическое время сохранено.':'Ранний уход остаётся в учёте дисциплины.');
 await reply(token,r.user_id,0,text,null,{}, {id:'decision:'+r.token+':worker',employee:r.employee});
 await reply(token,String(q.from.id),0,text,null,{}, {id:'decision:'+r.token+':manager',employee:r.responsible});}}catch(e){await answer(token,q,e.status?e.message:'Не удалось сохранить решение. Проверьте журнал в программе.')}return true;}
  if(!q.data.startsWith('tga:'))return false;
  const match=q.data.match(/^tga:([A-Za-z0-9_-]{24}):(in|out|permit|stay|boss:\d+)$/),r=match&&db.prepare('SELECT * FROM tg_attendance_requests WHERE callback_token=?').get(match[1]);
  if(!r||!q.message||q.message.chat?.type!=='private'||String(q.message.chat.id)!==r.user_id||!validUser(q.from?.id)||q.from.is_bot||String(q.from.id)!==r.user_id){await answer(token,q,'Эта кнопка доступна только автору видео. / Faqat video muallifi uchun.');return true}
  const action=match[2];
  if(['permit','stay'].includes(action)||action.startsWith('boss:')){
   if(r.status==='saved'){await answer(token,q,'Отметка уже сохранена');return true;}if(r.status==='cancelled'||!validRequest(r)){await answer(token,q,'Эта кнопка устарела. Отправьте новое видео.');return true;}
   if(action==='stay'){db.prepare("UPDATE tg_attendance_requests SET status='cancelled' WHERE callback_token=? AND status='pending'").run(r.callback_token);await answer(token,q,'Смена остаётся открытой / Smena ochiq qoladi');return true;}
   const allowed=await intent(r.employee,r.at);if(!earlyExit?.enabled()||!allowed.canOut||!allowed.earlyMinutes){await answer(token,q,'Разрешение раннего ухода сейчас недоступно');return true;}
   const managers=earlyExit.managers(r.employee);
   if(action==='permit'){if(!managers.length){await answer(token,q,'Администратор должен выбрать ответственных в программе: Telegram → Ранний уход.');return true;}await reply(token,r.user_id,r.message_id,'Кто разрешил уйти раньше? / Kim ruxsat berdi?',{inline_keyboard:[...managers.map(m=>[{text:m.name.slice(0,50),callback_data:`tga:${r.callback_token}:boss:${m.key}`}]),[{text:'Остаться / Qolish',callback_data:`tga:${r.callback_token}:stay`}]]},{},{id:'boss-prompt:'+r.callback_token,employee:r.employee,kind:'prompt',reference:r.callback_token,expires:r.at+MAX_AGE});await answer(token,q,'Выберите ответственного');return true;}
   const responsibleKey=action.slice(5);if(!managers.some(m=>String(m.key)===responsibleKey)){await answer(token,q,'Этот ответственный больше не доступен');return true;}const result=await save(token,r,'out',{responsibleKey});await answer(token,q,result.ok?'Смена закрыта, разрешение ожидает подтверждения':result.reason);return true;
  }
  const result=await save(token,r,action);await answer(token,q,result.ok?result.duplicate?'Отметка уже сохранена / Allaqachon saqlandi':'Отметка сохранена / Saqlandi':result.reason);return true;
 }

 function miniContext(who,reference){const r=db.prepare('SELECT * FROM tg_attendance_requests WHERE callback_token=?').get(reference),g=config(),q=r&&geo.get(r),s=geo.config();if(!r||r.employee!==who.employee||r.user_id!==who.chat||!botConnected()||String(botIdentity())!==who.botId||!g.enabled||g.group_id!==r.group_id||g.revision!==r.revision||!s.enabled||!q||q.bot_id!==who.botId||q.revision!==s.revision||binding(who.chat)?.employee!==who.employee)fail('Видео или привязка изменились. Откройте бота заново',403);if(r.status==='cancelled')fail('Отметка отменена',409);const common={serverNow:clock(),name:db.prepare('SELECT name FROM employees WHERE id=?').get(who.employee)?.name||'Сотрудник',kind:q.kind,at:r.at,radius:s.radius,gpsHelpAvailable:extensions()?.feature('gpsHelp')||false,language:who.language||'ru'};if(r.status==='saved')return {state:'saved',r,geoRevision:q.revision,public:{...common,state:'saved'}};if(q.status==='accepted'&&clock()-r.at<=35*60000){const job=retry.get(r),state=job&&['failed','expired','cancelled'].includes(job.status)?'review':'queued';return {state,r,geoRevision:q.revision,public:{...common,state}};}if(!validRequest(r)||!geo.waiting(r))fail('Время подтверждения истекло. Отправьте новое видео',409);return {state:'waiting',r,geoRevision:q.revision,expires:q.expires,public:{...common,state:'waiting'}};}
 async function geoPrompt(token,r,repeat=false){const q=geo.get(r);if(!q||!geo.waiting(r))return;const useMini=mini.active(),revision=mini.config().revision;const message='📍 Видео №'+r.message_id+' · '+localDate(r.at,tz).time+'\n'+(q.kind==='in'?'Для открытия смены':'Для закрытия смены')+(useMini?' нажмите кнопку: мини-приложение определит местоположение после вашего разрешения. / Tugmani bosing va joylashuvga ruxsat bering.':' отправьте текущее местоположение кнопкой на телефоне. / Tugma orqali joriy joylashuvni yuboring.')+' Подтвердите в течение 2 минут после видео. Радиус: '+geo.config().radius+' м.';await reply(token,r.user_id,0,message,useMini?{inline_keyboard:[[{text:'📍 Определить местоположение / Joylashuv',web_app:{url:mini.url(r)}}],...(extensions()?.feature('gpsHelp')?[[{text:'GPS не работает / GPS ishlamayapti',callback_data:'afx:g:'+r.callback_token}]]:[])]}:{keyboard:[[{text:'📍 Отправить местоположение / Joylashuv',request_location:true}],...(extensions()?.feature('gpsHelp')?[[{text:'GPS не работает'}]]:[])],resize_keyboard:true,one_time_keyboard:false},{},{id:repeat?undefined:'geo:'+r.callback_token+':'+q.created+':'+revision,employee:r.employee,kind:useMini?'geo-mini':'geo',reference:r.callback_token+(useMini?':'+revision:''),expires:q.expires});}

 async function locationMessage(m,token){const employee=binding(m.from.id),q=geo.pendingFor(String(m.from.id));if(!employee||!q||q.employee!==employee.employee){await reply(token,String(m.from.id),0,'Сначала отправьте новое видео у входа и выберите приход или уход. Геолокация запрашивается отдельно для каждого видео. / Avval yangi video yuboring.');return true;}const r=request(q.group_id,q.message_id);if(!r||!validRequest(r)){await reply(token,String(m.from.id),0,'Видео или привязка устарели. Отправьте новое видео. / Yangi video yuboring.');return true;}const result=geo.accept(r,m);if(!result.ok){await reply(token,r.user_id,0,result.reason);return true;}const saved=await save(token,r,result.kind,result.permission);if(saved.ok||saved.retry){await reply(token,r.user_id,0,saved.ok?'📍 Геолокация принята. Отметка смены сохранена. / Joylashuv qabul qilindi, smena saqlandi.':'📍 Геолокация принята. Видео в очереди повторной обработки; исходное время сохранится. / Video qayta ishlanadi.',{remove_keyboard:true});}else if(!saved.notified)await reply(token,r.user_id,0,saved.reason);return true;}
 async function incoming(update,token){
  if(update.callback_query)return callback(update.callback_query,token);
  const m=update.message;
  if(m?.chat?.type==='private'&&validUser(m.from?.id)&&!m.from.is_bot&&String(m.chat.id)===String(m.from.id)&&!forwarded(m)&&!m.edit_date){if(m.location)return locationMessage(m,token);const locationPending=geo.pendingFor(String(m.from.id));await resume(token,String(m.from.id));return !!locationPending;}
  if(!m||!['group','supergroup'].includes(m.chat?.type))return false;
  if(m.edit_date||!validGroup(String(m.chat.id))||!validUser(m.from?.id)||m.from.is_bot||forwarded(m)||!Number.isSafeInteger(m.message_id)||m.message_id<1)return true;
  const command=typeof m.text==='string'?m.text.trim().match(/^\/groupid(?:@([A-Za-z0-9_]+))?$/i):null;
  if(command&&(!command[1]||command[1].toLowerCase()===botUsername().toLowerCase())){await reply(token,String(m.from.id),m.message_id,`ID группы: ${m.chat.id}\nАдминистратору: укажите этот ID в разделе Telegram → Видеоотметки смен. ${instructions}`);return true}
  const c=config();if(!c.enabled||!botConnected()||!attendance||String(m.chat.id)!==c.group_id)return true;
  if(!m.video&&!m.video_note)return true;
  const employee=binding(m.from.id);if(!employee){await reply(token,String(m.from.id),m.message_id,'Для отметок нужна подтверждённая привязка сотрудника. Обратитесь к администратору. / Administratorga murojaat qiling.');return true}
  if(!fresh(m.date*1000,clock())){await reply(token,String(m.from.id),m.message_id,'Нужно новое видео, отправленное не более 10 минут назад. / Oxirgi 10 daqiqada yuborilgan yangi video kerak.');return true}
  const media=m.video||m.video_note;
  if(m.video&&m.video_note||typeof media.file_id!=='string'||!media.file_id||media.file_id.length>256||typeof media.file_unique_id!=='string'||!media.file_unique_id||media.file_unique_id.length>256||media.file_size>MAX_BYTES||!Number.isFinite(media.duration)||media.duration<0||media.duration>600){await reply(token,String(m.from.id),m.message_id,'Отправьте обычное видео или видеокружок до 20 МБ и 10 минут. / 20 MB gacha video yuboring.');return true}
  let r=request(c.group_id,m.message_id);
  if(r&&r.status==='saved')return true;
  if(r&&(r.user_id!==String(m.from.id)||r.employee!==employee.employee||r.file_unique_id!==media.file_unique_id||r.revision!==c.revision))return true;
  if(r&&await recover(r,token))return true;
  if(pastVideoCutoff(employee.employee,m.date*1000))return true;
  if(!r){
   if(db.prepare('SELECT group_id FROM tg_attendance_requests WHERE file_unique_id=?').get(media.file_unique_id)){await reply(token,String(m.from.id),m.message_id,'Это видео уже отправляли для отметки. Запишите новое видео у входа. / Kirishda yangi video yozing.');return true}
   db.prepare('INSERT INTO tg_attendance_requests(group_id,message_id,user_id,employee,file_unique_id,media,at,callback_token,revision) VALUES(?,?,?,?,?,?,?,?,?)').run(c.group_id,m.message_id,String(m.from.id),employee.employee,media.file_unique_id,JSON.stringify({file_id:media.file_id,type:m.video?'video':'video_note',duration:Math.floor(media.duration),size:media.file_size||0}),m.date*1000,randomBytes(18).toString('base64url'),c.revision);
   r=request(c.group_id,m.message_id);
  }
  let kind=captionKind(m.caption);if(!kind&&c.mode==='auto')kind=(await intent(r.employee,r.at)).autoKind;
  if(kind==='out'&&earlyExit?.enabled()&&(await intent(r.employee,r.at)).earlyMinutes>0){await prompt(token,r);return true;}if(kind==='in'||kind==='out'){const result=await save(token,r,kind);if(!result.ok&&!result.notified)await reply(token,r.user_id,r.message_id,result.reason)}else await prompt(token,r);
  return true;
 }
 function responsibles(){try{if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shift_bot_settings'").get())return [];const s=JSON.parse(db.prepare('SELECT json FROM shift_bot_settings WHERE id=1').get()?.json||'{}');return s.enabled&&Array.isArray(s.responsibles)?s.responsibles:[];}catch{return []}}
 async function notifyFailure(token,r){
  const j=retry.get(r);if(!j||binding(r.user_id)?.employee!==r.employee)return;
  const when=localDate(r.at,tz),name=db.prepare('SELECT name FROM employees WHERE id=?').get(r.employee)?.name||'Сотрудник';
  const text='⚠️ TAMEER · Видеоотметка требует проверки\n'+name+' · '+when.date+' '+when.time+'\nВидео №'+r.message_id+' · '+j.attempts+' попыток.\nЭтап: '+j.phase+' · код: '+j.error_code+'\nОтметка не подтверждена. Сохраните исходное видео и обратитесь к ответственному. / Asl video bilan mas’ulga murojaat qiling.';
  await reply(token,r.user_id,0,text,null,{}, {id:'video-failed:'+r.group_id+':'+r.message_id,employee:r.employee});
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tg_attendance_bindings'").get())return;
  for(const employee of responsibles()){if(employee===r.employee)continue;const b=db.prepare("SELECT b.chat FROM tg_attendance_bindings b JOIN employees e ON e.id=b.employee WHERE b.employee=? AND b.status='approved' AND e.active=1").get(employee);if(b)await reply(token,b.chat,0,text,null,{}, {id:'video-failed:'+r.group_id+':'+r.message_id+':'+employee,employee,kind:'video-failure',reference:r.callback_token});}
 }
 async function retryDue(token,expectedBot){
  if(String(botIdentity())!==String(expectedBot)||!botConnected())return;
  for(const j of retry.due()){
   if(String(botIdentity())!==String(expectedBot)||!botConnected())break;
   const r=request(j.group_id,j.message_id);if(!r||r.status==='cancelled'){if(r)retry.stop(r);continue;}
   if(r.status==='saved'){retry.done(r);continue;}
   if(!retry.matches(r,j)||!validRequest(r,true)){retry.stop(r,j.expires<clock()?'RETRY_WINDOW_EXPIRED':'REQUEST_CHANGED',j.expires<clock()?'expired':'cancelled');if(j.expires<clock())await notifyFailure(token,r);continue;}
   if(await recover(r,token,true))continue;
   if(pastVideoCutoff(r.employee,r.at)){retry.stop(r,'AFTER_SHIFT_CUTOFF');continue;}
   if(j.attempts>=8){retry.stop(r,'RETRY_LIMIT_REACHED','failed');await notifyFailure(token,r);continue;}
   const result=await save(token,r,j.kind,JSON.parse(j.permission),true);if(!result.ok&&!result.retry&&!result.notified)await notifyFailure(token,r);
  }
 }
 function processUpdate(update,token){const task=queue.then(()=>incoming(update,token));queue=task.catch(()=>{});return task}
 function miniOwner(who,reference){
  const r=db.prepare('SELECT * FROM tg_attendance_requests WHERE callback_token=?').get(reference);
  if(!mini.active()||!r||r.employee!==who.employee||r.user_id!==who.chat||who.botId!==String(botIdentity())||binding(who.chat)?.employee!==who.employee||!validRequest(r))fail('Video yoki profil o‘zgargan. Yangi video yuboring',403);
  return r;
 }
 async function miniInbox(who){const rows=[];
  for(const r of db.prepare("SELECT * FROM tg_attendance_requests WHERE employee=? AND user_id=? AND status='pending' AND at>=? ORDER BY at DESC LIMIT 10").all(who.employee,who.chat,clock()-MAX_AGE)){
   if(!validRequest(r)||who.botId!==String(botIdentity())||pastVideoCutoff(r.employee,r.at))continue;
   const allowed=await intent(r.employee,r.at),q=geo.get(r);
   rows.push({reference:r.callback_token,message:r.message_id,at:r.at,canIn:!!allowed.canIn,canOut:!!allowed.canOut,earlyMinutes:allowed.earlyMinutes||0,managers:allowed.canOut&&earlyExit?.enabled()?earlyExit.managers(r.employee).map(m=>({key:m.key,name:m.name})):[],gpsURL:geo.waiting(r)&&mini.active()?mini.url(r):''});
  }
  return rows;
 }
 function miniConfirm(b,who,token){const task=queue.then(async()=>{
  const r=miniOwner(who,b.reference);
  if(r.status==='saved')return {ok:true,duplicate:true};if(r.status!=='pending')fail('Video bekor qilingan',409);
  if(b.kind==='stay'){db.prepare("UPDATE tg_attendance_requests SET status='cancelled' WHERE callback_token=? AND status='pending'").run(b.reference);return {ok:true};}
  if(!['in','out'].includes(b.kind))fail('Kelish yoki ketishni tanlang');
  let permission=null;
  if(b.responsibleKey!=null&&b.responsibleKey!==''){
   const allowed=await intent(r.employee,r.at);
   if(b.kind!=='out'||!allowed.canOut||!allowed.earlyMinutes||!earlyExit?.enabled()||!earlyExit.managers(r.employee).some(m=>String(m.key)===String(b.responsibleKey)))fail('Erta ketish uchun mas’ulni tekshiring');
   permission={responsibleKey:String(b.responsibleKey)};
  }
  const result=await save(token,r,b.kind,permission),q=geo.get(r);
  return {...result,gpsURL:geo.waiting(r)&&mini.active()?mini.url(r):''};
 });queue=task.catch(()=>{});return task;}
 return {miniInbox,miniConfirm,status,settings,geofenceSettings:geo.configure,miniSettings:mini.configure,miniAPI:mini.handle,processUpdate,retryPending(token,expectedBot=botIdentity()){const task=queue.then(()=>retryDue(token,expectedBot));queue=task.catch(()=>{});return task},flushPrivate(token){const task=queue.then(()=>flush(token));queue=task.catch(()=>{});return task}};
}
