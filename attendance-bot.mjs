import {initAttendanceTraining} from './attendance-training.mjs';
import {attendanceUzParams,attendanceUzInput,attendanceCommandsUz,attendanceHelpUz} from './attendance-uz.mjs';
import {verifyMiniApp} from './employee-portal.mjs';
import {randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTelegramAttendance} from './telegram-attendance.mjs';

const PREFIX='/api/telegram/attendance';
const tokenOK=value=>typeof value==='string'&&/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(value);
const userOK=value=>Number.isSafeInteger(value)&&value>0;
const help=attendanceHelpUz;

// A separate token, offset and identity mapping prevent the payroll and attendance
// bots from consuming one another's updates or exposing payroll in the group.
export function initAttendanceBot(db,{dataDir,tz,payroll,transaction,fail,attendance=null,transport=null,download,clock=Date.now,expectedUsername=null,earlyExit=null,publicURL=''}){
 db.exec(`CREATE TABLE IF NOT EXISTS tg_attendance_bot_config(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,bot_id TEXT NOT NULL,username TEXT NOT NULL,enabled INTEGER NOT NULL,offset INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS tg_attendance_codes(hash TEXT PRIMARY KEY,employee TEXT NOT NULL REFERENCES employees(id),expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS tg_attendance_bindings(employee TEXT PRIMARY KEY REFERENCES employees(id),chat TEXT NOT NULL UNIQUE,username TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS tg_attendance_bot_migrations(name TEXT PRIMARY KEY,created INTEGER NOT NULL);`);
 const tableExists=name=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
 if(tableExists('tg_bindings')&&!db.prepare("SELECT name FROM tg_attendance_bot_migrations WHERE name='approved-salary-identities-v1'").get())transaction(()=>{
  db.prepare("INSERT OR IGNORE INTO tg_attendance_bindings(employee,chat,username,status,created) SELECT employee,chat,username,status,created FROM tg_bindings WHERE status='approved'").run();
  db.prepare('INSERT INTO tg_attendance_bot_migrations VALUES(?,?)').run('approved-salary-identities-v1',clock());
  payroll.audit('telegram-attendance-identities-migrated',null,null,{approved:db.prepare('SELECT COUNT(*) n FROM tg_attendance_bindings').get().n});
 });
 const keyPath=join(dataDir,'telegram.key');
 if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
 const key=readFileSync(keyPath);if(key.length!==32)throw Error('Invalid telegram encryption key');
 const hash=value=>createHash('sha256').update(value).digest('hex');
 function seal(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64')}
 function unseal(value){const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString('utf8')}
 const config=()=>db.prepare('SELECT * FROM tg_attendance_bot_config WHERE id=1').get();
 const binding=chat=>db.prepare("SELECT b.employee,b.chat,b.status,e.name FROM tg_attendance_bindings b JOIN employees e ON e.id=b.employee WHERE b.chat=? AND b.status='approved' AND e.active=1").get(String(chat));
 let workflows=null,automation=null,extensions=null;
 let stopped=false,polling=false,generation=0,connectAttempt=0,controller=null,timer=null,lastError='',lastSeen=null,privateQueue=Promise.resolve();
 async function call(token,method,params,signal){try{
  if(['sendMessage','editMessageText','answerCallbackQuery','sendDocument','editMessageCaption','editMessageReplyMarkup','sendVideo'].includes(method))params=attendanceUzParams(method,params,db.prepare('SELECT name FROM employees').all().map(e=>e.name));
  if(transport)return await transport(method,params,{token,signal});
  let body,headers;if(method==='sendDocument'&&Buffer.isBuffer(params.document)||method==='sendVideo'&&Buffer.isBuffer(params.video)){const field=method==='sendVideo'?'video':'document';body=new FormData();for(const [k,v] of Object.entries(params)){if(k===field)body.set(k,new Blob([v],{type:field==='video'?'video/mp4':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),params.filename);else if(k!=='filename')body.set(k,typeof v==='object'?JSON.stringify(v):String(v))}}else{headers={'Content-Type':'application/json'};body=JSON.stringify(params)}
  const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers,body,signal:signal||AbortSignal.timeout(12000)}),result=await response.json();
  if(!result.ok)throw Object.assign(Error('Telegram API'),{apiCode:result.error_code,retryAfter:result.parameters?.retry_after,notModified:result.error_code===400&&/message is not modified/i.test(String(result.description||''))});
  return result.result;
 }catch(error){throw Object.assign(Error(error.apiCode===409?'Бот смен уже запущен в другом месте. Остановите второй экземпляр.':error.apiCode===401?'Токен бота смен недействителен.':'Не удалось связаться с ботом смен. Проверьте интернет и токен.'),{status:502,apiCode:error.apiCode,retryAfter:error.retryAfter,notModified:error.notModified===true,uncertain:!error.apiCode})}}
 function miniIdentity(input){const c=config();if(stopped||!c?.enabled)fail('Бот смен отключён',403);const u=verifyMiniApp(input,unseal(c.token),clock()),authDate=Number(new URLSearchParams(input).get('auth_date'))*1000;if(clock()-authDate>300000)fail('Откройте мини-приложение заново из Telegram',401);const b=binding(u.id);if(!b)fail('Нужна подтверждённая привязка к боту смен',403);return {employee:b.employee,chat:String(b.chat),botId:String(c.bot_id),language:'uz'};}
 const service=attendance&&{...(typeof attendance.intent==='function'?{intent:(...args)=>attendance.intent(...args)}:{}),videoCutoff:(...args)=>attendance.videoCutoff?.(...args),requestResult:(...args)=>{const r=typeof attendance.requestResult==='function'?attendance.requestResult(...args):null;return r?.kind==='in'&&automation?.afterArrivalSaved?automation.afterArrivalSaved(r):r;},record:(body,options)=>{const r=attendance.record(body,{...options,identity:'attendance',botId:String(config()?.bot_id||'')});return body.kind==='in'&&automation?.afterArrivalSaved?automation.afterArrivalSaved(r):r;}};
 const group=createTelegramAttendance(db,{extensions:()=>extensions,publicURL,authenticateMini:miniIdentity,dataDir,tz,attendance:service,earlyExit,call,payroll,transaction,fail,download,clock,botUsername:()=>config()?.username||'',botConnected:()=>!stopped&&!!config()?.enabled,bindingResolver:binding,botIdentity:()=>String(config()?.bot_id||'')});
 const training=initAttendanceTraining(db,{identity:()=>String(config()?.bot_id||''),username:()=>config()?.username||'',binding,clock});
 function invalidatePending(){db.prepare('UPDATE tg_attendance_config SET revision=revision+1 WHERE id=1').run()}
 function status(){const current=config();return {connected:!stopped&&!!current?.enabled,username:current?.username||'',expectedUsername:expectedUsername||'',lastError,lastSeen,language:'uz',menuError,training:{lessons:training.total,language:'uz'},bindings:db.prepare('SELECT b.*,e.name FROM tg_attendance_bindings b JOIN employees e ON e.id=b.employee ORDER BY e.name').all(),group:group.status()}}
 function menu(chat,markup=null){
  if(markup?.inline_keyboard||markup?.remove_keyboard||markup?.keyboard?.some(r=>r.some(b=>b.request_location||b.text==='Отмена')))return markup;
  const base=markup||automation?.menuForChat(chat),extra=extensions?.menuForChat(chat)||[],rows=base?.keyboard||[],seen=new Set(rows.flat().map(b=>b.text));
  const keyboard=[...rows,...extra.filter(r=>!r.every(b=>seen.has(b.text)))],m=group.status().miniApp;
  if(binding(chat))keyboard.push([{text:'🎓 O‘quv markazi'}]);
  if(m.enabled&&m.httpsReady&&binding(chat))keyboard.unshift([{text:'📱 Mening kabinetim',web_app:{url:m.url+'?mode=cabinet'}}]);
  return keyboard.length?{...base,keyboard,resize_keyboard:true}:base||{remove_keyboard:true};
 }
 const send=(token,chat,text,markup=null)=>call(token,'sendMessage',{chat_id:chat,text,protect_content:true,reply_markup:menu(chat,markup)});
 async function incoming(update,token){
  update=attendanceUzInput(update);
  const original=config(),version=generation;
  const current=()=>!stopped&&version===generation&&!!config()?.enabled&&config().bot_id===original?.bot_id;
  if(!current())return;
  if(await training.processUpdate(update,{current,send:(chat,text,markup)=>send(token,chat,text,markup),answer:(id,text)=>call(token,'answerCallbackQuery',{callback_query_id:id,text,show_alert:false}),video:(chat,video,lesson,caption,reply_markup)=>call(token,'sendVideo',{chat_id:chat,video,...(Buffer.isBuffer(video)?{filename:lesson.video}:{}),caption,duration:Math.round(lesson.duration),width:720,height:1280,supports_streaming:true,protect_content:true,reply_markup})}))return;
  if(extensions&&await extensions.processUpdate(update,{send:(chat,text,markup)=>send(token,chat,text,markup),answer:(id,text)=>call(token,'answerCallbackQuery',{callback_query_id:id,text,show_alert:false})}))return;
  if(await group.processUpdate(update,token)){await automation?.refreshClosed?.();return;}
  if(automation&&await automation.processUpdate(update,{send:(chat,text,markup)=>send(token,chat,text,markup),answer:(id,text)=>call(token,'answerCallbackQuery',{callback_query_id:id,text,show_alert:false})}))return;
  if(!current())return;
  const message=update.message;
  if(!message||message.chat?.type!=='private'||!userOK(message.from?.id)||message.from.is_bot||String(message.chat.id)!==String(message.from.id))return;
  const chat=String(message.from.id),input=typeof message.text==='string'?message.text.trim():'';
  if(workflows){const reply=await workflows.command(chat,input,message.from);if(reply!==null&&reply!==undefined){if(current())await send(token,chat,reply);return;}}
  if(input.startsWith('/start ')){
   const code=input.slice(7).trim(),invite=code.length<=64?db.prepare('SELECT * FROM tg_attendance_codes WHERE hash=? AND expires>?').get(hash(code),clock()):null;
   if(!invite){await send(token,chat,'Ссылка недействительна или истекла. Попросите администратора создать новую ссылку для бота смен.');return}
   if(!db.prepare('SELECT active FROM employees WHERE id=?').get(invite.employee)?.active){await send(token,chat,'Сотрудник неактивен. Обратитесь к администратору.');return}
   if(db.prepare('SELECT employee FROM tg_attendance_bindings WHERE chat=? OR employee=?').get(chat,invite.employee)){await send(token,chat,'Аккаунт или сотрудник уже привязан. Изменить привязку может только администратор.');return}
   transaction(()=>{db.prepare('DELETE FROM tg_attendance_codes WHERE employee=?').run(invite.employee);db.prepare('INSERT INTO tg_attendance_bindings VALUES(?,?,?,?,?)').run(invite.employee,chat,String(message.from.username||message.from.first_name||'').slice(0,100),'pending',clock());payroll.audit('telegram-attendance-request',invite.employee,null,{chat})});
   await send(token,chat,'Запрос для бота смен получен. Дождитесь подтверждения администратора. / Administrator tasdig‘ini kuting.');return;
  }
  const employee=binding(chat);
  if(input==='/status'){
   if(!employee){await send(token,chat,'Для отметок нужна подтверждённая привязка сотрудника. Получите личную ссылку у администратора и дождитесь подтверждения. / Administrator tasdig‘i kerak.');return}
   const allowed=typeof attendance?.intent==='function'?await attendance.intent(employee.employee,clock()):null;
   if(!current()||binding(chat)?.employee!==employee.employee)return;
   await send(token,chat,`${employee.name}\nПривязка к боту смен подтверждена. / Smena botiga ulanish tasdiqlandi.${allowed?'\n'+(allowed.canIn?'Можно отметить приход / Kelishni belgilang.':allowed.canOut?'Можно отметить уход / Ketishni belgilang.':'Следующая отметка сейчас недоступна. Проверьте график у HR.'):''}\nОтправляйте видео у двери магазина в настроенную рабочую группу.`);return;
  }
  await send(token,chat,help+(employee?'':'\nДля отметок получите личную ссылку у администратора. / Shaxsiy havolani administratordan oling.'));
 }
 function processUpdate(update,token){const task=privateQueue.then(()=>incoming(update,token));privateQueue=task.catch(()=>{});return task}
 async function poll(){
  if(stopped||polling)return;const current=config();if(!current?.enabled)return;
  polling=true;const version=generation,abort=new AbortController();controller=abort;const timeout=setTimeout(()=>abort.abort(),26000);timeout.unref();
  try{const token=unseal(current.token);await group.retryPending(token,current.bot_id);if(stopped||version!==generation)return;await group.flushPrivate(token);const updates=await call(token,'getUpdates',{offset:current.offset,timeout:20,allowed_updates:['message','callback_query']},abort.signal);
   if(!Array.isArray(updates))throw Error('Invalid updates');
   for(const update of updates){if(stopped||version!==generation)break;await processUpdate(update,token);if(stopped||version!==generation)break;if(Number.isSafeInteger(update.update_id)&&update.update_id>=0)db.prepare('UPDATE tg_attendance_bot_config SET offset=? WHERE id=1 AND bot_id=?').run(update.update_id+1,current.bot_id)}
   if(!stopped&&version===generation){lastError='';lastSeen=clock()}
  }catch(error){if(!stopped&&version===generation)lastError=error.status?error.message:'Не удалось обработать сообщение бота смен. Повторите позже.'}
  finally{clearTimeout(timeout);if(controller===abort)controller=null;polling=false;if(!stopped&&config()?.enabled){timer=setTimeout(poll,lastError?15000:1000);timer.unref()}}
 }
 let menuError='',menuSyncQueue=Promise.resolve();
 function syncMenu(){const task=menuSyncQueue.then(runSyncMenu);menuSyncQueue=task.catch(()=>{});return task;}
 async function runSyncMenu(){
  const c=config();if(stopped||!c?.enabled)return {ok:false};
  const current=()=>!stopped&&config()?.enabled&&config().bot_id===c.bot_id&&config().token===c.token;
  try{
   const token=unseal(c.token);
   for(const language_code of ['', 'ru', 'uz', 'tg']){
    if(!current())return {ok:false};
    await call(token,'setMyCommands',{commands:attendanceCommandsUz,language_code,scope:{type:'default'}});
   }
   if(!current())return {ok:false};
   const m=group.status().miniApp;
   await call(token,'setChatMenuButton',{menu_button:m.enabled&&m.httpsReady?{type:'web_app',text:'Mening kabinetim',web_app:{url:m.url+'?mode=cabinet'}}:{type:'commands'}});
   if(!current())return {ok:false};
   await call(token,'setMyDescription',{description:'TAMEER Davomat — xodimlar uchun kelish va ketish, smena jadvali, ruxsatlar va davomat. Ishchi guruhga video yuboring. Shaxsiy menyu uchun /menu bosing.'});
   menuError='';return {ok:true,language:'uz'};
  }catch{menuError='Bot menyusini yangilab bo‘lmadi. Qayta urinib ko‘ring.';return {ok:false,error:menuError};}
 }
 async function handle(path,body){
  if(path===PREFIX+'/menu/sync')return syncMenu();
  if(path===PREFIX+'/settings')return group.settings(body);
  if(path===PREFIX+'/geofence')return group.geofenceSettings(body);
  if(path===PREFIX+'/mini/settings'){const result=group.miniSettings(body);if(!transport)await syncMenu();return result;}
  if(path===PREFIX+'/connect'){
   if(!tokenOK(body.token))fail('Введите токен отдельного бота смен, полученный у BotFather');
   const attempt=++connectAttempt,version=generation;
   const ensureCurrent=()=>{if(stopped||attempt!==connectAttempt||version!==generation)fail('Подключение отменено. Повторите действие.',409)};
   ensureCurrent();
   const me=await call(body.token,'getMe',{});
   ensureCurrent();
   if(!me?.is_bot||!userOK(me.id)||typeof me.username!=='string'||!/^\w{5,32}$/.test(me.username))fail('Telegram не подтвердил данные бота смен');
   if(expectedUsername&&me.username.toLowerCase()!==expectedUsername.toLowerCase())fail('Для смен нужен отдельный бот @'+expectedUsername);
   for(const table of ['tg_config','hr_recruit_config'])if(tableExists(table)&&String(db.prepare(`SELECT bot_id FROM ${table} WHERE id=1`).get()?.bot_id)===String(me.id))fail('Этот бот уже используется для зарплаты или найма. Создайте отдельного бота для прихода и ухода.');
   const hook=await call(body.token,'getWebhookInfo',{});ensureCurrent();if(hook?.url)fail('У бота включён webhook. Отключите его в прежней программе перед подключением.');
   const old=config();if(old&&old.bot_id!==String(me.id)&&db.prepare('SELECT COUNT(*) n FROM tg_attendance_bindings').get().n)fail('Сначала удалите привязки сотрудников к прежнему боту смен.');
   ensureCurrent();generation++;controller?.abort();clearTimeout(timer);
   transaction(()=>{db.prepare('INSERT INTO tg_attendance_bot_config VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,bot_id=excluded.bot_id,username=excluded.username,enabled=1,offset=excluded.offset').run(seal(body.token),String(me.id),me.username,1,old?.bot_id===String(me.id)?old.offset:0);invalidatePending();payroll.audit('telegram-attendance-connected',null,null,{botId:String(me.id),username:me.username})});
   lastError='';if(!transport)await syncMenu();if(!transport&&!polling){timer=setTimeout(poll,100);timer.unref()}return {ok:true,username:me.username};
  }
  if(path===PREFIX+'/disconnect'){
   connectAttempt++;generation++;controller?.abort();clearTimeout(timer);transaction(()=>{db.prepare("UPDATE tg_attendance_bot_config SET enabled=0,token='' WHERE id=1").run();invalidatePending();payroll.audit('telegram-attendance-disconnected',null,null,{})});lastError='';return {ok:true};
  }
  if(!['invite','approve','unlink'].some(action=>path===PREFIX+'/'+action))fail('Действие не найдено',404);
  payroll.validateEmployee(body.employee);
  if(path===PREFIX+'/invite'){
   const current=config();if(!current?.enabled)fail('Сначала подключите отдельного бота смен');
   if(!db.prepare('SELECT active FROM employees WHERE id=?').get(body.employee)?.active)fail('Сотрудник неактивен');
   if(db.prepare('SELECT employee FROM tg_attendance_bindings WHERE employee=?').get(body.employee))fail('Сначала удалите старую привязку к боту смен');
   const code=randomBytes(24).toString('base64url');transaction(()=>{db.prepare('DELETE FROM tg_attendance_codes WHERE employee=? OR expires<=?').run(body.employee,clock());db.prepare('INSERT INTO tg_attendance_codes VALUES(?,?,?)').run(hash(code),body.employee,clock()+15*60000)});
   return {url:`https://t.me/${current.username}?start=${code}`,expiresInMinutes:15};
  }
  if(path===PREFIX+'/approve'){
   transaction(()=>{if(!db.prepare("UPDATE tg_attendance_bindings SET status='approved' WHERE employee=? AND status='pending'").run(body.employee).changes)fail('Нет ожидающей привязки к боту смен');payroll.audit('telegram-attendance-approved',body.employee,null,{})});return {ok:true};
  }
  transaction(()=>{db.prepare('DELETE FROM tg_attendance_bindings WHERE employee=?').run(body.employee);db.prepare('DELETE FROM tg_attendance_codes WHERE employee=?').run(body.employee);invalidatePending();payroll.audit('telegram-attendance-unlinked',body.employee,null,{})});return {ok:true};
 }
 let menuTimer=null;
 if(config()?.enabled&&!transport){timer=setTimeout(poll,2000);timer.unref();menuTimer=setTimeout(()=>{void syncMenu();},1000);menuTimer.unref();}
 async function notifyEmployee(employee,message){const current=config();if(stopped||!current?.enabled)return {delivered:false,reason:'Бот не подключён'};const b=db.prepare("SELECT b.chat FROM tg_attendance_bindings b JOIN employees e ON e.id=b.employee WHERE b.employee=? AND b.status='approved' AND e.active=1").get(employee);if(!b)return {delivered:false,reason:'Нет подтверждённой привязки к боту смен'};await send(unseal(current.token),b.chat,message);return {delivered:true}}
 async function notifyCenter(employee,message,link,label,{group:toGroup=false}={}){
  const current=config();
  if(stopped||!current?.enabled)return {delivered:false,reason:'Бот смен не подключён'};
  const g=toGroup?group.status():null;
  const target=toGroup
   ? g.enabled&&/^-[1-9]\d{0,18}$/.test(g.groupId)?g.groupId:null
   : targetAutomation(employee)?.chat;
  if(!target)return {delivered:false,reason:toGroup?'Рабочая группа бота смен не подключена':'Нет подтверждённой привязки к боту смен'};
  await call(unseal(current.token),'sendMessage',{chat_id:target,text:message,protect_content:true,link_preview_options:{is_disabled:true},...(!toGroup&&link?{reply_markup:{inline_keyboard:[[{text:label,url:link}]]}}:{})});
  return {delivered:true};
 }
 async function notifySupervisor(chat,message){const current=config();if(stopped||!current?.enabled)return {delivered:false,reason:'Бот не подключён'};if(!/^[1-9]\d{0,18}$/.test(String(chat))||!db.prepare("SELECT chat FROM store_supervisors WHERE chat=? AND status='approved' AND bot_id=?").get(String(chat),current.bot_id))return {delivered:false,reason:'Получатель не подтверждён'};await send(unseal(current.token),String(chat),message);return {delivered:true}}
 function leaveTarget(employee){const current=config(),g=group.status(),base={botId:String(current?.bot_id||''),groupId:g.groupId||'',userId:''};if(stopped||!current?.enabled)return {...base,ready:false,reason:'Подключите бота прихода и ухода'};if(!g.enabled||!/^-[1-9]\d{0,18}$/.test(g.groupId))return {...base,ready:false,reason:'Подключите рабочую группу в настройках Telegram'};const b=db.prepare("SELECT b.chat FROM tg_attendance_bindings b JOIN employees e ON e.id=b.employee WHERE b.employee=? AND b.status='approved' AND e.active=1").get(employee);if(!b||!/^([1-9]\d{0,18})$/.test(b.chat))return {...base,ready:false,reason:'Подтвердите Telegram-привязку сотрудника к боту смен'};return {...base,userId:b.chat,ready:true};}
 async function notifyLeaveGroup(employee,message,target){const current=leaveTarget(employee);if(!current.ready)return {delivered:false,reason:current.reason};if(!target||['botId','groupId','userId'].some(k=>current[k]!==target[k]))return {delivered:false,reason:'Группа, бот или привязка сотрудника изменены'};try{const result=await call(unseal(config().token),'sendMessage',{chat_id:current.groupId,text:message,parse_mode:'HTML',protect_content:true,disable_notification:false,link_preview_options:{is_disabled:true}});return {delivered:true,messageId:result.message_id};}catch(e){return {delivered:false,uncertain:!!e.uncertain,retryable:e.apiCode===429,reason:e.uncertain?'Проверьте группу: Telegram не подтвердил доставку':'Бот не смог отправить сообщение. Проверьте права бота в группе.'};}}
 function dailyReportTarget(employee){const current=config(),base={botId:String(current?.bot_id||''),userId:'',username:''};if(stopped||!current?.enabled)return {...base,ready:false,reason:'Подключите бота прихода и ухода'};const b=db.prepare("SELECT b.chat,b.username FROM tg_attendance_bindings b JOIN employees e ON e.id=b.employee WHERE b.employee=? AND b.status='approved' AND e.active=1").get(employee);if(!b||!/^[1-9]\d{0,18}$/.test(b.chat))return {...base,ready:false,reason:'Подтвердите личную привязку к боту прихода и ухода'};return {...base,userId:b.chat,username:b.username,ready:true};}
 async function notifyDailyReport(employee,message,target){const current=dailyReportTarget(employee);if(!current.ready)return {delivered:false,reason:current.reason};if(!tableExists('tg_daily_report_recipients')||!db.prepare('SELECT employee FROM tg_daily_report_recipients WHERE employee=? AND active=1 AND bot_id=? AND chat=?').get(employee,current.botId,current.userId)||!db.prepare('SELECT enabled FROM tg_daily_report_settings WHERE id=1').get()?.enabled)return {delivered:false,reason:'Получатель ежедневных отчётов отключён'};if(!target||current.botId!==target.botId||current.userId!==target.userId)return {delivered:false,reason:'Бот или получатель изменены'};try{const r=await call(unseal(config().token),'sendMessage',{chat_id:current.userId,text:message,protect_content:true,link_preview_options:{is_disabled:true}});return {delivered:true,messageId:r.message_id};}catch(e){return {delivered:false,uncertain:!!e.uncertain,retryable:e.apiCode===429,retryAfter:e.retryAfter,reason:e.uncertain?'Telegram не подтвердил доставку; проверьте личные сообщения':e.apiCode===403?'Руководитель должен открыть бота и нажать «Старт», затем разрешить сообщения.':'Не удалось отправить отчёт. Проверьте подключение бота.'};}}
 async function notifyAttendanceExcel(employee,bytes,filename,caption,target){const current=dailyReportTarget(employee);if(!current.ready)return {delivered:false,reason:current.reason};if(!tableExists('tg_shift_excel_settings')||!db.prepare('SELECT enabled FROM tg_shift_excel_settings WHERE id=1').get()?.enabled||!tableExists('tg_daily_report_recipients')||!db.prepare('SELECT employee FROM tg_daily_report_recipients WHERE employee=? AND active=1 AND bot_id=? AND chat=?').get(employee,current.botId,current.userId))return {delivered:false,reason:'Получатель или отправка Excel отключены'};if(!target||current.botId!==target.botId||current.userId!==target.userId)return {delivered:false,reason:'Бот или получатель изменены'};if(!Buffer.isBuffer(bytes)||bytes.length>20*1024*1024||!/^TAMEER-attendance-\d{4}-\d{2}-\d{2}\.xlsx$/.test(filename))return {delivered:false,reason:'Проверьте файл Excel'};try{const r=await call(unseal(config().token),'sendDocument',{chat_id:current.userId,document:bytes,filename,caption,protect_content:true});return {delivered:true,messageId:r.message_id};}catch(e){return {delivered:false,uncertain:!!e.uncertain,retryable:e.apiCode===429,retryAfter:e.retryAfter,reason:e.uncertain?'Telegram не подтвердил доставку Excel; проверьте личные сообщения':e.apiCode===403?'Руководитель должен нажать «Старт» в боте и разрешить сообщения.':'Не удалось отправить Excel. Проверьте бота.'};}}
 async function notifyAutomation(employee,message,markup,pinned){const current=config(),b=targetAutomation(employee);if(stopped||!current?.enabled||!b||!pinned||pinned.botId!==String(current.bot_id)||pinned.chat!==String(b.chat))return {delivered:false,reason:'Бот или привязка изменены'};try{const r=await send(unseal(current.token),b.chat,message,markup);return {delivered:true,messageId:r.message_id}}catch(e){return {delivered:false,uncertain:!!e.uncertain,retryable:e.apiCode===429,retryAfter:e.retryAfter,reason:e.apiCode===403?'Сотрудник должен открыть бота и нажать Старт.':'Telegram не подтвердил доставку уведомления.'}}}
 const targetAutomation=employee=>db.prepare("SELECT b.chat FROM tg_attendance_bindings b JOIN employees e ON e.id=b.employee WHERE b.employee=? AND b.status='approved' AND e.active=1").get(employee);
 async function editAutomationMessage(employee,message,pinned){const current=config(),b=targetAutomation(employee);if(stopped||!current?.enabled||!b||!pinned||pinned.botId!==String(current.bot_id)||pinned.chat!==String(b.chat)||!/^\d+$/.test(String(b.chat))||!Number.isSafeInteger(pinned.messageId)||pinned.messageId<1||typeof message!=='string'||message.length>4096)return {delivered:false,reason:'Бот, привязка или сообщение изменены'};try{await call(unseal(current.token),'editMessageText',{chat_id:String(b.chat),message_id:pinned.messageId,text:message,reply_markup:{inline_keyboard:[]}});return {delivered:true};}catch(e){if(e.notModified)return {delivered:true};return {delivered:false,retryable:!e.apiCode||e.apiCode===429||e.apiCode>=500,retryAfter:e.retryAfter,reason:e.apiCode===403?'Бот не может изменить личное сообщение. Проверьте доступ.':e.apiCode===400?'Telegram не разрешил изменить это сообщение.':'Telegram временно не подтвердил обновление сообщения.'};}}
 async function notifyReviewedAttendance(r,pinned){const c=config(),g=db.prepare('SELECT * FROM tg_attendance_config WHERE id=1').get(),b=binding(pinned.chat);if(stopped||!c?.enabled||String(c.bot_id)!==pinned.botId||!g?.enabled||r.bot_id!==pinned.botId||r.group!==g.group_id||b?.employee!==r.employee||r.status!=='approved'||!r.result)return {delivered:false,reason:'Отметка, привязка или группа изменились'};const time=new Intl.DateTimeFormat('ru-RU',{timeZone:tz,hour:'2-digit',minute:'2-digit'}).format(r.at),s=r.result.summary||{},text=(r.kind==='in'?'✅ Смена открыта':'✅ Смена закрыта')+' · '+time+'\n'+(r.kind==='in'?'Опоздание: '+(s.late||0)+' мин.':'Отработано: '+(s.worked||0)+' мин.')+'\nОтметка внесена вручную после решения ответственного по заявке GPS. / Mas’ul qarori bilan qayd kiritildi.';let result;try{const response=await call(unseal(c.token),'sendMessage',{chat_id:r.group,text,protect_content:true,reply_parameters:{message_id:r.message,allow_sending_without_reply:true}});result={delivered:true,messageId:response.message_id};}catch(e){result={delivered:false,uncertain:!!e.uncertain,retryable:e.apiCode===429,retryAfter:e.retryAfter,reason:'Не удалось подтвердить отметку в группе'};}return result;}
 function toolsAppButton(mode){const m=group.status().miniApp;if(!m.enabled||!m.httpsReady)return null;return {inline_keyboard:[[{text:mode==='month'?'📅 Мой месяц / Mening oyim':'🔄 Обмен сменами / Smena almashish',web_app:{url:m.url+'?mode='+mode}}]]};}
 return {cabinetVideos(who){return group.miniInbox(who)},async cabinetConfirm(b,who){const c=config();if(stopped||!c?.enabled||!group.status().miniApp.enabled)fail('Mini-ilova o‘chirilgan',403);const r=await group.miniConfirm(b,who,unseal(c.token));if(r.ok)await automation?.refreshClosed?.();return r;},setExtensions(value){extensions=value},notifyReviewedAttendance,toolsAppButton,status,handle,processUpdate,miniAPI(action,b){const c=config();if(stopped||!c?.enabled)fail('Бот смен отключён',403);if(action.startsWith('tools/')){if(!group.status().miniApp.enabled||!extensions)fail('Мини-приложение выключено',403);return extensions.miniHandle(action.slice(6),b,miniIdentity(b.initData));}return group.miniAPI(action,b,unseal(c.token));},notifyAutomation,editAutomationMessage,setAutomation(value){automation=value},notifyEmployee,notifyCenter,notifySupervisor,leaveTarget,notifyLeaveGroup,dailyReportTarget,notifyDailyReport,notifyAttendanceExcel,identity:()=>config()?.bot_id||'',setWorkflows(value){workflows=value},stop(){stopped=true;connectAttempt++;generation++;controller?.abort();clearTimeout(timer);clearTimeout(menuTimer)}};
}
