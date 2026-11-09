import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {resolve,join,sep,basename} from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {initAttendanceBot} from '../attendance-bot.mjs';
import {initTelegram} from '../telegram.mjs';
import {initShiftBotAutomation,shiftBotFeatures} from '../shift-bot-automation.mjs';
import {zonedTime} from '../model.mjs';

const token='554433221:abcdefghijklmnopqrstuvwxyz123456',salaryToken='112233445:abcdefghijklmnopqrstuvwxyz123456';
const groupId='-1001122334455',mp4=Buffer.from('000000186674797069736f6d0000000069736f6d6d703432','hex');
function fixture({migrate=false,expectedUsername=null,transport=true}={}){
 const root=resolve(process.cwd()),dir=mkdtempSync(join(root,'.delta-standalone-attendance-test-')),db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE employees(id TEXT PRIMARY KEY,name TEXT,active INTEGER);INSERT INTO employees VALUES('alice','Алиса',1),('bob','Боб',1),('inactive','Неактивный',0);CREATE TABLE tg_config(id INTEGER PRIMARY KEY,bot_id TEXT);INSERT INTO tg_config VALUES(1,'112233445');CREATE TABLE hr_recruit_config(id INTEGER PRIMARY KEY,bot_id TEXT);INSERT INTO hr_recruit_config VALUES(1,'998877665');CREATE TABLE tg_bindings(employee TEXT PRIMARY KEY,chat TEXT UNIQUE,username TEXT,status TEXT,created INTEGER);");
 if(migrate)db.exec("INSERT INTO tg_bindings VALUES('alice','101','alice','approved',1),('bob','202','bob','pending',1)");
 let now=Date.parse('2026-10-16T04:00:00Z'),me={is_bot:true,id:554433221,username:'example_davomat_bot'},webhook='',transportError=false,number=0,transportGate=null;
 const sent=[],calls=[],records=[],audits=[];
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status})},transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error}};
 const opts={dataDir:dir,tz:'Asia/Tashkent',fail,transaction,clock:()=>now,expectedUsername,payroll:{validateEmployee(id){if(!db.prepare('SELECT id FROM employees WHERE id=?').get(id))fail('Employee missing')},audit(...args){audits.push(args)},statement(){throw Error('Payroll must not be used by attendance bot')}},attendance:{intent(){return {canIn:true,canOut:false,autoKind:'in'}},requestResult(){return null},record(body,metadata){records.push({body,metadata});return {ok:true,day:'2026-10-16',summary:{late:0,worked:0}}}},download:async()=>mp4,transport:transport?async(method,params,meta)=>{calls.push({method,params,token:meta.token});if(transportGate)await transportGate(method,params,meta);if(transportError)throw Error('private:'+meta.token);if(method==='getMe')return me;if(method==='getWebhookInfo')return {url:webhook};if(method==='sendMessage'){sent.push(params);return {message_id:sent.length+700}}if(method==='sendVideo')return {message_id:999,video:{file_id:'training-cached-file'}};if(method==='getFile')return {file_path:'videos/arrival.mp4',file_size:mp4.length};if(['answerCallbackQuery','setMessageReaction','editMessageText','setMyCommands','setChatMenuButton','setMyDescription'].includes(method))return true;throw Error('Unexpected '+method)}:null};
 let bot=initAttendanceBot(db,opts);
 return {db,dir,opts,sent,calls,records,audits,get bot(){return bot},connect:()=>bot.handle('/api/telegram/attendance/connect',{token}),setMe(value){me=value},setWebhook(value){webhook=value},setTransportError(value){transportError=value},setTransportGate(value){transportGate=value},setNow(value){now=value},restart(){bot.stop();bot=initAttendanceBot(db,opts)},private(text,id=101,extra={}){return {update_id:++number,message:{message_id:number,chat:{id,type:'private'},from:{id,username:'worker'},text,...extra}}},video(extra={}){return {update_id:++number,message:{message_id:number,date:now/1000,chat:{id:Number(groupId),type:'supergroup'},from:{id:101},caption:'Пришёл',video:{file_id:'f'+number,file_unique_id:'unique'+number,duration:10,file_size:mp4.length},...extra}}},close(){bot.stop();db.close();if(!resolve(dir).startsWith(root+sep)||!basename(dir).startsWith('.delta-standalone-attendance-test-'))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true})}};
}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}};

test('automation uses only the separate attendance token and pinned approved private profile; menus and callbacks route before legacy help',async()=>{const f=fixture();try{await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1)");let handled=0;const markup={keyboard:[[{text:'Опаздываю'}]],resize_keyboard:true};f.bot.setAutomation({menuForChat:()=>markup,async processUpdate(update,io){if(update.message?.text==='/menu'){handled++;await io.send('101','Меню автоматизации',markup);return true}if(update.callback_query?.data==='sba:test'){handled++;await io.answer(update.callback_query.id,'Принято');return true}return false}});await f.bot.processUpdate(f.private('/menu'),token);assert.equal(handled,1);assert.equal(f.sent.at(-1).chat_id,'101');assert.deepEqual(f.sent.at(-1).reply_markup,{keyboard:[[{text:'Kechikaman'}],[{text:'🎓 O‘quv markazi'}]],resize_keyboard:true});assert.equal(f.calls.at(-1).token,token);await f.bot.processUpdate({callback_query:{id:'q',data:'sba:test'}},token);assert.equal(handled,2);assert.equal(f.calls.at(-1).method,'answerCallbackQuery');const n=f.sent.length;assert.equal((await f.bot.notifyAutomation('alice','Напоминание',markup,{botId:'wrong',chat:'101'})).delivered,false);assert.equal(f.sent.length,n);assert.equal((await f.bot.notifyAutomation('alice','Напоминание',markup,{botId:'554433221',chat:'101'})).delivered,true);assert.equal(f.sent.at(-1).protect_content,true);f.db.exec("UPDATE tg_attendance_bindings SET status='pending'");assert.equal((await f.bot.notifyAutomation('alice','Недоступно',markup,{botId:'554433221',chat:'101'})).delivered,false);}finally{f.close()}});

test('Excel uses multipart upload to the pinned leadership private chat, with a real document and no payroll bot',async()=>{
 const f=fixture(),original=globalThis.fetch;try{await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1);CREATE TABLE tg_shift_excel_settings(id INTEGER PRIMARY KEY,enabled INTEGER);INSERT INTO tg_shift_excel_settings VALUES(1,1);CREATE TABLE tg_daily_report_recipients(employee TEXT PRIMARY KEY,active INTEGER,bot_id TEXT,chat TEXT);INSERT INTO tg_daily_report_recipients VALUES('alice',1,'554433221','101')");
 f.opts.transport=null;f.restart();const calls=[];globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return {json:async()=>({ok:true,result:{message_id:980}})}};const target=f.bot.dailyReportTarget('alice'),bytes=Buffer.from('PK-document'),filename='TAMEER-attendance-2026-10-20.xlsx';const result=await f.bot.notifyAttendanceExcel('alice',bytes,filename,'Report',target);assert.equal(result.delivered,true);assert.equal(result.messageId,980);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.telegram.org/bot'+token+'/sendDocument');const body=calls[0].opts.body;assert.ok(body instanceof FormData);assert.equal(body.get('chat_id'),'101');assert.equal(body.get('protect_content'),'true');assert.equal(body.get('document').name,filename);assert.equal(body.get('document').type,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');assert.deepEqual(Buffer.from(await body.get('document').arrayBuffer()),bytes);assert.equal(calls[0].opts.headers,undefined);
 assert.equal((await f.bot.notifyAttendanceExcel('alice',bytes,filename,'Report',{...target,userId:'202'})).delivered,false);f.db.exec("UPDATE tg_attendance_bindings SET status='pending'");assert.equal((await f.bot.notifyAttendanceExcel('alice',bytes,filename,'Report',target)).delivered,false);assert.equal(calls.length,1);
 }finally{globalThis.fetch=original;f.close()}
});

test('daily report transport sends only to selected approved private profile, never the group or another binding',async()=>{
 const f=fixture();try{await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1),('bob','202','bob','pending',1);CREATE TABLE tg_daily_report_settings(id INTEGER PRIMARY KEY,enabled INTEGER);INSERT INTO tg_daily_report_settings VALUES(1,1);CREATE TABLE tg_daily_report_recipients(employee TEXT PRIMARY KEY,active INTEGER,bot_id TEXT,chat TEXT)");
 const target=f.bot.dailyReportTarget('alice');assert.equal(target.ready,true);assert.equal(f.bot.dailyReportTarget('bob').ready,false);assert.equal((await f.bot.notifyDailyReport('alice','Report',target)).delivered,false);assert.equal(f.sent.length,0);
 f.db.exec("INSERT INTO tg_daily_report_recipients VALUES('alice',1,'554433221','101')");assert.equal((await f.bot.notifyDailyReport('alice','Full report',target)).delivered,true);assert.equal(f.sent[0].chat_id,'101');assert.equal(f.sent[0].protect_content,true);assert.equal(f.sent[0].parse_mode,undefined);assert.equal(f.calls.at(-1).token,token);
 const count=f.sent.length;assert.equal((await f.bot.notifyDailyReport('alice','Report',{...target,userId:'202'})).delivered,false);f.db.exec("UPDATE tg_daily_report_recipients SET active=0");assert.equal((await f.bot.notifyDailyReport('alice','Report',target)).delivered,false);f.db.exec("UPDATE tg_daily_report_recipients SET active=1;UPDATE tg_attendance_bindings SET chat='999' WHERE employee='alice'");assert.equal((await f.bot.notifyDailyReport('alice','Report',target)).delivered,false);assert.equal(f.sent.length,count);
 f.db.exec("UPDATE tg_attendance_bindings SET chat='101' WHERE employee='alice'");f.setTransportGate(async method=>{if(method==='sendMessage')throw Object.assign(Error('rate limited'),{apiCode:429,retryAfter:120})});const limited=await f.bot.notifyDailyReport('alice','Report',target);assert.equal(limited.retryable,true);assert.equal(limited.retryAfter,120);assert.ok(!limited.reason.includes(token));
 await f.bot.handle('/api/telegram/attendance/disconnect',{});assert.equal(f.bot.dailyReportTarget('alice').ready,false);
 }finally{f.close()}
});

test('leave announcements use the attendance bot and exact approved identity in the configured group',async()=>{
 const f=fixture();try{await f.connect();f.bot.handle('/api/telegram/attendance/settings',{enabled:true,groupId,mode:'auto'});f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1),('bob','202','bob','pending',1)");
 const target=f.bot.leaveTarget('alice');assert.equal(target.ready,true);assert.equal(target.userId,'101');assert.equal(f.bot.leaveTarget('bob').ready,false);
 const delivered=await f.bot.notifyLeaveGroup('alice','<b>Отпуск</b>',target);assert.equal(delivered.delivered,true);const m=f.sent.at(-1);assert.equal(m.chat_id,groupId);assert.equal(m.parse_mode,'HTML');assert.equal(m.disable_notification,false);assert.equal(f.calls.at(-1).token,token);
 const before=f.sent.length;assert.equal((await f.bot.notifyLeaveGroup('alice','No',{...target,userId:'202'})).delivered,false);assert.equal(f.sent.length,before);
 f.bot.handle('/api/telegram/attendance/settings',{enabled:true,groupId:'-100998877',mode:'auto'});assert.equal((await f.bot.notifyLeaveGroup('alice','No',target)).delivered,false);assert.equal(f.sent.length,before);
 }finally{f.close()}
});

test('standalone bot encrypts its token and rejects payroll/recruitment IDs even when disabled',async()=>{const f=fixture();try{
 for(const id of [112233445,998877665]){f.setMe({is_bot:true,id,username:'SomeOtherBot'});await assert.rejects(f.connect(),/уже используется/)}
 f.setMe({is_bot:true,id:554433221,username:'example_davomat_bot'});f.setWebhook('https://previous.example/hook');await assert.rejects(f.connect(),/webhook/);f.setWebhook('');await f.connect();
 const stored=f.db.prepare('SELECT * FROM tg_attendance_bot_config').get();assert.notEqual(stored.token,token);assert.equal(stored.bot_id,'554433221');assert.equal(stored.offset,0);assert.equal(f.db.prepare('SELECT bot_id FROM tg_config').get().bot_id,'112233445');assert.equal(f.db.prepare('SELECT bot_id FROM hr_recruit_config').get().bot_id,'998877665');assert.ok(!JSON.stringify(f.bot.status()).includes(token));assert.ok(!JSON.stringify(f.audits).includes(token));
 f.restart();assert.equal(f.bot.status().connected,true);await f.bot.handle('/api/telegram/attendance/disconnect',{});assert.equal(f.db.prepare('SELECT token FROM tg_attendance_bot_config').get().token,'');assert.equal(f.bot.status().connected,false);
}finally{f.close()}});

test('configured bot name is enforced and returned before a token is entered',async()=>{const f=fixture({expectedUsername:'example_davomat_bot'});try{
 assert.equal(f.bot.status().expectedUsername,'example_davomat_bot');f.setMe({is_bot:true,id:554433221,username:'OtherShiftBot'});await assert.rejects(f.connect(),/@example_davomat_bot/);f.setMe({is_bot:true,id:554433221,username:'Example_Davomat_Bot'});await f.connect();assert.equal(f.bot.status().username,'Example_Davomat_Bot');
}finally{f.close()}});

test('only existing approved identities migrate once; unlink is independent and never resurrected on restart',async()=>{const f=fixture({migrate:true});try{
 assert.deepEqual(f.bot.status().bindings.map(row=>[row.employee,row.status]),[['alice','approved']]);assert.equal(f.bot.status().group.enabled,false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tg_attendance_bot_migrations').get().n,1);
 await f.bot.handle('/api/telegram/attendance/unlink',{employee:'alice'});f.db.prepare("UPDATE tg_bindings SET status='approved' WHERE employee='bob'").run();f.restart();assert.equal(f.bot.status().bindings.length,0);assert.equal(f.db.prepare("SELECT status FROM tg_bindings WHERE employee='alice'").get().status,'approved');assert.equal(f.db.prepare("SELECT status FROM tg_bindings WHERE employee='bob'").get().status,'approved');
}finally{f.close()}});

test('separate short-lived invitations need administrator approval and consume codes once',async()=>{const f=fixture();try{
 await f.connect();const invite=await f.bot.handle('/api/telegram/attendance/invite',{employee:'alice'}),code=new URL(invite.url).searchParams.get('start'),stored=f.db.prepare('SELECT * FROM tg_attendance_codes').get();assert.equal(invite.expiresInMinutes,15);assert.equal(stored.hash,createHash('sha256').update(code).digest('hex'));assert.notEqual(stored.hash,code);
 await f.bot.processUpdate(f.private('/start '+code),token);assert.equal(f.bot.status().bindings[0].status,'pending');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tg_attendance_codes').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tg_bindings').get().n,0);
 await f.bot.processUpdate(f.private('/start '+code,202),token);assert.equal(f.bot.status().bindings.length,1);assert.ok(f.sent.at(-1).text.includes('Havola noto‘g‘ri'));await f.bot.handle('/api/telegram/attendance/approve',{employee:'alice'});assert.equal(f.bot.status().bindings[0].status,'approved');await assert.rejects(f.bot.handle('/api/telegram/attendance/approve',{employee:'alice'}),/Нет ожидающей/);await assert.rejects(f.bot.handle('/api/telegram/attendance/invite',{employee:'alice'}),/старую привязку/);
}finally{f.close()}});

test('expired codes, spoofed private identities and inactive employees cannot bind',async()=>{const f=fixture();try{
 await f.connect();await assert.rejects(f.bot.handle('/api/telegram/attendance/invite',{employee:'inactive'}),/неактивен/);let invite=await f.bot.handle('/api/telegram/attendance/invite',{employee:'alice'}),code=new URL(invite.url).searchParams.get('start');await f.bot.processUpdate(f.private('/start '+code,101,{from:{id:202}}),token);assert.equal(f.bot.status().bindings.length,0);f.setNow(Date.parse('2026-10-16T04:15:00Z'));await f.bot.processUpdate(f.private('/start '+code),token);assert.equal(f.bot.status().bindings.length,0);
 invite=await f.bot.handle('/api/telegram/attendance/invite',{employee:'alice'});code=new URL(invite.url).searchParams.get('start');f.db.prepare("UPDATE employees SET active=0 WHERE id='alice'").run();await f.bot.processUpdate(f.private('/start '+code),token);assert.equal(f.bot.status().bindings.length,0);
}finally{f.close()}});

test('private bot exposes attendance help and status only, never salary menus or statements',async()=>{const f=fixture({migrate:true});try{
 await f.connect();for(const command of ['/start','/salary','/bonuses','/fines','Моя зарплата','/status'])await f.bot.processUpdate(f.private(command),token);assert.equal(f.sent.length,6);assert.ok(f.sent.slice(0,-1).every(message=>message.text.includes('faqat kelish va ketish uchun')));assert.ok(f.sent.at(-1).text.includes('Алиса'));assert.ok(f.sent.at(-1).text.includes('tasdiqlangan'));assert.ok(f.sent.every(message=>!message.reply_markup?.keyboard||message.reply_markup.keyboard.flat().every(b=>b.text==='🎓 O‘quv markazi')));assert.ok(!f.calls.some(call=>['setChatMenuButton','setMyCommands'].includes(call.method)));assert.equal(f.records.length,0);
}finally{f.close()}});

test('own approved map controls group videos; salary identity alone grants no attendance access',async()=>{const f=fixture({migrate:true});try{
 await f.connect();await f.bot.handle('/api/telegram/attendance/settings',{enabled:true,groupId,mode:'auto'});f.db.prepare("UPDATE tg_bindings SET chat='999' WHERE employee='alice'").run();await f.bot.processUpdate(f.video(),token);assert.equal(f.records.length,1);assert.equal(f.records[0].metadata.identity,'attendance');assert.equal(f.records[0].metadata.botId,'554433221');const evidence=f.records[0].metadata.evidence;assert.deepEqual(readFileSync(join(f.dir,'attendance-videos',evidence.filename)),mp4);await f.bot.processUpdate(f.video({from:{id:999}}),token);assert.equal(f.records.length,1);await f.bot.handle('/api/telegram/attendance/unlink',{employee:'alice'});await f.bot.processUpdate(f.video(),token);assert.equal(f.records.length,1);
}finally{f.close()}});

test('disabled bot cannot create requests, download media or write group attendance',async()=>{const f=fixture({migrate:true});try{
 await assert.rejects(f.bot.handle('/api/telegram/attendance/settings',{enabled:true,groupId,mode:'auto'}),/отдельного бота/);await f.connect();await f.bot.handle('/api/telegram/attendance/settings',{enabled:true,groupId,mode:'auto'});await f.bot.handle('/api/telegram/attendance/disconnect',{});const before=f.calls.length;await f.bot.processUpdate(f.video(),token);assert.equal(f.calls.length,before);assert.equal(f.records.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tg_attendance_requests').get().n,0);assert.equal(f.bot.status().group.botConnected,false);
}finally{f.close()}});

test('bot replacement requires explicit unlink; disconnect preserves employee approval',async()=>{const f=fixture({migrate:true});try{
 await f.connect();await f.bot.handle('/api/telegram/attendance/disconnect',{});assert.equal(f.bot.status().bindings.length,1);f.setMe({is_bot:true,id:765432100,username:'NewAttendanceBot'});await assert.rejects(f.connect(),/удалите привязки/);await f.bot.handle('/api/telegram/attendance/unlink',{employee:'alice'});await f.connect();assert.equal(f.db.prepare('SELECT bot_id FROM tg_attendance_bot_config').get().bot_id,'765432100');assert.equal(f.db.prepare('SELECT bot_id FROM tg_config').get().bot_id,'112233445');
}finally{f.close()}});

test('transport failures expose no token in API error or status',async()=>{const f=fixture();try{
 f.setTransportError(true);await assert.rejects(f.connect(),error=>error.status===502&&!error.message.includes(token));assert.ok(!JSON.stringify(f.bot.status()).includes(token));f.setTransportError(false);await f.connect();f.setTransportError(true);await assert.rejects(f.bot.processUpdate(f.private('/start'),token),error=>error.status===502&&!error.message.includes(token));
}finally{f.close()}});

test('delayed connection cannot restore a bot after disconnect or commit after stop',async()=>{
 for(const method of ['getMe','getWebhookInfo'])for(const action of ['disconnect','stop']){const f=fixture();try{
  await f.connect();f.db.prepare('UPDATE tg_attendance_bot_config SET offset=77').run();const before=f.db.prepare('SELECT * FROM tg_attendance_bot_config').get(),entered=deferred(),release=deferred();f.setTransportGate(async name=>{if(name===method){entered.resolve();await release.promise}});
  const pending=f.connect(),rejected=assert.rejects(pending,error=>error.status===409&&/отменено/.test(error.message));await entered.promise;
  if(action==='disconnect')await f.bot.handle('/api/telegram/attendance/disconnect',{});else f.bot.stop();release.resolve();await rejected;
  const after=f.db.prepare('SELECT * FROM tg_attendance_bot_config').get();assert.equal(f.bot.status().connected,false,method+'/'+action);assert.equal(after.offset,77);assert.equal(after.token,action==='disconnect'?'':before.token);assert.equal(after.enabled,action==='disconnect'?0:1);
 }finally{f.close()}}
});

test('newer concurrent connection wins even if an older Telegram validation returns later',async()=>{const f=fixture();try{
 const entered=deferred(),release=deferred(),newToken='554433221:abcdefghijklmnopqrstuvwxyz654321';f.setTransportGate(async(method,params,meta)=>{if(method==='getMe'&&meta.token===token){entered.resolve();await release.promise}});
 const older=f.connect(),rejected=assert.rejects(older,error=>error.status===409);await entered.promise;await f.bot.handle('/api/telegram/attendance/connect',{token:newToken});const saved=f.db.prepare('SELECT token FROM tg_attendance_bot_config').get().token;release.resolve();await rejected;assert.equal(f.bot.status().connected,true);assert.equal(f.db.prepare('SELECT token FROM tg_attendance_bot_config').get().token,saved);assert.equal(f.calls.filter(row=>row.method==='getWebhookInfo').length,1);
}finally{f.close()}});

test('failed validation preserves an already connected bot, its token, offset and pending status work',async()=>{const f=fixture({migrate:true});try{
 await f.connect();f.db.prepare('UPDATE tg_attendance_bot_config SET offset=88').run();const before=f.db.prepare('SELECT * FROM tg_attendance_bot_config').get(),entered=deferred(),release=deferred();f.opts.attendance.intent=async()=>{entered.resolve();await release.promise;return {canIn:true,canOut:false}};
 const pending=f.bot.processUpdate(f.private('/status'),token);await entered.promise;f.setMe({is_bot:true,id:112233445,username:'oyliktameerbot'});await assert.rejects(f.connect(),/уже используется/);release.resolve();await pending;assert.deepEqual(f.db.prepare('SELECT * FROM tg_attendance_bot_config').get(),before);assert.equal(f.bot.status().connected,true);assert.ok(f.sent.at(-1).text.includes('Алиса'));
}finally{f.close()}});

test('private invite waiting on group dispatch cannot bind after administrator disconnect',async()=>{const f=fixture();try{
 await f.connect();const invite=await f.bot.handle('/api/telegram/attendance/invite',{employee:'alice'}),code=new URL(invite.url).searchParams.get('start'),pending=f.bot.processUpdate(f.private('/start '+code),token);
 await Promise.resolve();await f.bot.handle('/api/telegram/attendance/disconnect',{});await pending;assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tg_attendance_bindings').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tg_attendance_codes').get().n,1);assert.equal(f.sent.length,0);
}finally{f.close()}});

test('private status waiting on attendance intent rechecks disconnect and identity revocation',async()=>{
 for(const action of ['disconnect','unlink']){const f=fixture({migrate:true});try{
  await f.connect();const entered=deferred(),release=deferred();f.opts.attendance.intent=async()=>{entered.resolve();await release.promise;return {canIn:true,canOut:false}};const pending=f.bot.processUpdate(f.private('/status'),token);await entered.promise;await f.bot.handle('/api/telegram/attendance/'+action,action==='unlink'?{employee:'alice'}:{});release.resolve();await pending;assert.equal(f.sent.length,0,action);
 }finally{f.close()}}
});

test('payroll and attendance polling use separate tokens and advance only their own offsets',async()=>{
 const root=resolve(process.cwd()),dir=mkdtempSync(join(root,'.delta-standalone-attendance-test-')),db=new DatabaseSync(':memory:'),originalFetch=globalThis.fetch,sent=[],polls=[];let salary,attendanceBot;
 db.exec("CREATE TABLE employees(id TEXT PRIMARY KEY,name TEXT,active INTEGER);INSERT INTO employees VALUES('alice','Алиса',1)");
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status})},transaction=fn=>fn(),payroll={validateEmployee(){},audit(){},statement(){throw Error('Unexpected payroll')}};
 const queues=new Map([[salaryToken,[{update_id:7,message:{message_id:70,chat:{id:101,type:'private'},from:{id:101},text:'/start expired'}}]],[token,[{update_id:12,message:{message_id:120,chat:{id:101,type:'private'},from:{id:101},text:'/start'}}]]]);
 globalThis.fetch=async(url,options)=>{
  const matched=String(url).match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/);assert.ok(matched);const [,usedToken,method]=matched,params=JSON.parse(options.body);let result;
  if(method==='getMe')result={is_bot:true,id:usedToken===token?554433221:112233445,username:usedToken===token?'example_davomat_bot':'oyliktameerbot'};
  else if(method==='getWebhookInfo')result={url:''};
  else if(method==='getUpdates'){polls.push({token:usedToken,params});result=queues.get(usedToken).splice(0)}
  else if(method==='sendMessage'){sent.push({token:usedToken,params});result={message_id:1}}
  else throw Error('Unexpected '+method);
  return {json:async()=>({ok:true,result})};
 };
 try{
  salary=initTelegram(db,{dataDir:dir,tz:'Asia/Tashkent',payroll,transaction,fail});attendanceBot=initAttendanceBot(db,{dataDir:dir,tz:'Asia/Tashkent',payroll,transaction,fail});
  await salary.handle('/api/telegram/connect',{token:salaryToken});await attendanceBot.handle('/api/telegram/attendance/connect',{token});db.prepare('UPDATE tg_config SET offset=7').run();db.prepare('UPDATE tg_attendance_bot_config SET offset=12').run();
  await new Promise(resolve=>setTimeout(resolve,250));assert.equal(db.prepare('SELECT offset FROM tg_config').get().offset,8);assert.equal(db.prepare('SELECT offset FROM tg_attendance_bot_config').get().offset,13);assert.deepEqual(polls.map(row=>[row.token,row.params.offset]),[[salaryToken,7],[token,12]]);assert.deepEqual(polls[1].params.allowed_updates,['message','callback_query']);assert.equal(sent.find(row=>row.token===token).params.text.includes('faqat kelish va ketish uchun'),true);assert.equal(sent.find(row=>row.token===salaryToken).params.text.includes('Ссылка недействительна'),true);
 }finally{salary?.stop();attendanceBot?.stop();globalThis.fetch=originalFetch;db.close();if(!resolve(dir).startsWith(root+sep)||!basename(dir).startsWith('.delta-standalone-attendance-test-'))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true})}
});

test('closed notice editing clears inline buttons using the attendance token and pinned private message only',async()=>{const f=fixture();try{await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1)");const pinned={botId:'554433221',chat:'101',messageId:800};let result=await f.bot.editAutomationMessage('alice','Смена уже закрыта',pinned);assert.equal(result.delivered,true);const c=f.calls.at(-1);assert.equal(c.method,'editMessageText');assert.equal(c.token,token);assert.equal(c.params.chat_id,'101');assert.equal(c.params.message_id,800);assert.deepEqual(c.params.reply_markup,{inline_keyboard:[]});const n=f.calls.length;for(const bad of [{...pinned,chat:'-100123'},{...pinned,botId:'wrong'},{...pinned,messageId:0},{...pinned,chat:'202'}])assert.equal((await f.bot.editAutomationMessage('alice','Closed',bad)).delivered,false);assert.equal(f.calls.length,n);f.setTransportGate(async(method)=>{if(method==='editMessageText')throw Object.assign(Error('not modified'),{apiCode:400,notModified:true});});assert.equal((await f.bot.editAutomationMessage('alice','Closed',pinned)).delivered,true);f.setTransportGate(async(method)=>{if(method==='editMessageText')throw Object.assign(Error('429'),{apiCode:429,retryAfter:60});});result=await f.bot.editAutomationMessage('alice','Closed',pinned);assert.equal(result.retryable,true);assert.equal(result.retryAfter,60);f.db.exec("UPDATE tg_attendance_bindings SET status='pending'");assert.equal((await f.bot.editAutomationMessage('alice','Closed',pinned)).delivered,false);}finally{f.close()}});
test('a saved group video immediately triggers stale notice cleanup after canonical processing',async()=>{const f=fixture();try{await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1)");await f.bot.handle('/api/telegram/attendance/settings',{enabled:true,groupId,mode:'auto'});let cleaned=0;f.bot.setAutomation({menuForChat:()=>null,async refreshClosed(){assert.equal(f.records.length,1);cleaned++},async processUpdate(){return false}});await f.bot.processUpdate(f.video(),token);assert.equal(cleaned,1);}finally{f.close()}});

function attendanceMiniSign(date,user=101,secret=token){const p=new URLSearchParams({auth_date:String(Math.floor(date/1000)),user:JSON.stringify({id:user,language_code:'uz'})});const data=[...p].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n');p.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(secret).digest()).update(data).digest('hex'));return p.toString();}
test('attendance Mini App uses only the attendance bot signature and approved private identity; off returns manual button',async()=>{const f=fixture();try{f.opts.publicURL='https://tameer.test';f.restart();await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1)");await f.bot.handle('/api/telegram/attendance/settings',{enabled:true,groupId,mode:'auto'});const g=f.bot.status().group.geofence;await f.bot.handle('/api/telegram/attendance/geofence',{...g,enabled:true,latitude:39.743196,longitude:64.401783,label:'TAMEER'});let mini=f.bot.status().group.miniApp;await f.bot.handle('/api/telegram/attendance/mini/settings',{enabled:true,revision:mini.revision});const u=f.video();await f.bot.processUpdate(u,token);assert.equal(f.records.length,0);const button=f.sent.at(-1).reply_markup.inline_keyboard[0][0];assert.match(button.web_app.url,/^https:\/\/tameer.test\/attendance-mini\?request=/);const reference=new URL(button.web_app.url).searchParams.get('request'),at=Date.parse('2026-10-16T04:00:05Z');f.setNow(at);const b={reference,initData:attendanceMiniSign(at)};for(const initData of [attendanceMiniSign(at,101,salaryToken),attendanceMiniSign(at-301000),attendanceMiniSign(at,202)])await assert.rejects(f.bot.miniAPI('context',{...b,initData}));const c=await f.bot.miniAPI('context',b);assert.equal(c.name,'Алиса');assert.equal((await f.bot.miniAPI('location',{...b,nonce:c.nonce,location:{latitude:39.743196,longitude:64.401783,accuracy:10}})).state,'saved');assert.equal(f.records.length,1);mini=f.bot.status().group.miniApp;await f.bot.handle('/api/telegram/attendance/mini/settings',{enabled:false,revision:mini.revision});assert.equal(f.bot.status().group.geofence.enabled,true);await f.bot.processUpdate(f.video(),token);assert.equal(f.sent.at(-1).reply_markup.keyboard[0][0].request_location,true);await assert.rejects(f.bot.miniAPI('context',b));}finally{f.close()}});

test('tool commands precede a waiting GPS prompt, menus are merged and Mini App tools use signed self identity',async()=>{const f=fixture();try{f.opts.publicURL='https://tameer.test';f.restart();await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1)");await f.bot.handle('/api/telegram/attendance/settings',{enabled:true,groupId,mode:'auto'});await f.bot.handle('/api/telegram/attendance/geofence',{...f.bot.status().group.geofence,enabled:true,latitude:39.743196,longitude:64.401783,label:'Store'});await f.bot.handle('/api/telegram/attendance/mini/settings',{enabled:true,revision:f.bot.status().group.miniApp.revision});let commanded=0,whoSeen;f.bot.setExtensions({feature:()=>true,menuForChat:()=>[[{text:'Мой месяц'}]],async processUpdate(u,io){if(u.message?.text==='GPS не работает'){commanded++;await io.send('101','Укажите причину');return true;}return false},miniHandle(action,b,who){whoSeen=who;return {self:who.employee}}});await f.bot.processUpdate(f.video(),token);await f.bot.processUpdate(f.private('GPS не работает'),token);assert.equal(commanded,1);assert.equal(f.sent.at(-1).text,'Sababni yozing');assert.ok(f.sent.at(-1).reply_markup.keyboard.flat().some(b=>b.text==='Mening oyim'));const now=Date.parse('2026-10-16T04:00:05Z');f.setNow(now);const r=await f.bot.miniAPI('tools/month',{initData:attendanceMiniSign(now),employee:'bob'});assert.equal(r.self,'alice');assert.equal(whoSeen.chat,'101');assert.throws(()=>f.bot.miniAPI('tools/month',{initData:attendanceMiniSign(now,101,salaryToken)}));assert.match(f.bot.toolsAppButton('month').inline_keyboard[0][0].web_app.url,/mode=month/);}finally{f.close()}});


test('automatic permitted-arrival receipt displays credited 08:30 and retains actual video time without reactions',async()=>{const f=fixture();try{await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1)");await f.bot.handle('/api/telegram/attendance/settings',{enabled:true,groupId,mode:'auto'});const actual=Date.parse('2026-10-16T04:30:28Z'),credit=Date.parse('2026-10-16T03:30:00Z');f.setNow(actual);let hooks=0;f.bot.setAutomation({menuForChat:()=>null,async processUpdate(){return false},afterArrivalSaved(r){assert.equal(f.records.length,1);assert.equal(f.records[0].metadata.at,actual);hooks++;return {...r,summary:{...r.summary,automaticLateCredit:{at:credit,videoAt:actual,authorizedByName:'Руководитель'}}};}});await f.bot.processUpdate(f.video(),token);assert.equal(hooks,1);const receipt=f.sent.find(m=>m.chat_id===groupId&&m.text.includes('Smena ochildi'));assert.ok(receipt);assert.match(receipt.text,/Smena ochildi · 08:30/);assert.match(receipt.text,/Video yuborilgan asl vaqt: 09:30/);assert.match(receipt.text,/Ruxsat bergan: Rahbar/);assert.match(receipt.text,/Ruxsat asosida/);assert.equal(f.records[0].metadata.at,actual);assert.ok(!f.calls.some(c=>c.method==='setMessageReaction'));}finally{f.close()}});

test('Uzbek reply keyboard completes the real late request wizard, preserves the reason and cancels through the old handler',async()=>{
 const f=fixture();let auto;try{
  await f.connect();f.db.exec("ALTER TABLE employees ADD COLUMN role TEXT;ALTER TABLE employees ADD COLUMN created INTEGER DEFAULT 0;INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1),('bob','202','bob','approved',1);CREATE TABLE shifts(id TEXT PRIMARY KEY,employee TEXT,day TEXT,planned_start INTEGER,planned_end INTEGER);CREATE TABLE events(id INTEGER PRIMARY KEY,shift TEXT,kind TEXT,at INTEGER);CREATE TABLE reports(day TEXT PRIMARY KEY)");
  const day='2026-10-16',p={day,off:false,start:zonedTime(day,'08:30','Asia/Tashkent'),end:zonedTime(day,'18:30','Asia/Tashkent')};
  auto=initShiftBotAutomation(f.db,{schedule:{forMoment:()=>p,forDay:()=>p},storeOps:{},bot:f.bot,transaction:f.opts.transaction,fail:f.opts.fail,tz:'Asia/Tashkent',clock:()=>Date.parse('2026-10-16T04:00:00Z')});
  const settings=JSON.parse(f.db.prepare('SELECT json FROM shift_bot_settings').get().json);
  auto.settings({...settings,version:1,enabled:true,features:Object.fromEntries(Object.keys(shiftBotFeatures).map(k=>[k,true])),responsibles:['bob']},{id:'owner',admin:true});f.bot.setAutomation(auto);
  await f.bot.processUpdate(f.private('/menu'),token);
  assert.ok(f.sent.at(-1).reply_markup.keyboard.flat().some(b=>b.text==='Kechikaman'));
  await f.bot.processUpdate(f.private('Kechikaman'),token);assert.match(f.sent.at(-1).text,/Necha daqiqadan keyin/);
  await f.bot.processUpdate(f.private('15'),token);assert.match(f.sent.at(-1).text,/Kechikish sababini/);
  await f.bot.processUpdate(f.private('Автобус задержался'),token);
  const r=f.db.prepare('SELECT * FROM shift_bot_requests').get();assert.equal(r.kind,'late');assert.equal(r.status,'pending');assert.equal(JSON.parse(r.json).reason,'Автобус задержался');
  assert.match(f.sent.at(-1).text,/Ariza saqlandi/);assert.match(f.sent.at(-1).text,/Автобус задержался/);
  await f.bot.processUpdate(f.private('Kechikaman'),token);await f.bot.processUpdate(f.private('Bekor qilish'),token);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM shift_bot_sessions').get().n,0);assert.equal(f.records.length,0);
 }finally{auto?.stop();f.close();}
});

test('Telegram command menu sync uses only attendance token and Uzbek descriptions with no messages or ledger changes',async()=>{
 const f=fixture();try{await f.connect();const before=f.sent.length;const result=await f.bot.handle('/api/telegram/attendance/menu/sync',{});assert.equal(result.ok,true);assert.equal(result.language,'uz');const commands=f.calls.filter(c=>c.method==='setMyCommands');assert.equal(commands.length,4);assert.deepEqual(commands.map(c=>c.params.language_code),['','ru','uz','tg']);assert.ok(commands.every(c=>c.token===token&&c.params.commands.some(x=>x.command==='menu'&&x.description==='Smena menyusi')&&c.params.commands.every(x=>!/[А-Яа-яЁё]/u.test(x.description))));assert.equal(f.sent.length,before);assert.equal(f.records.length,0);assert.equal(f.bot.status().language,'uz');}finally{f.close()}
});

test('unified cabinet requires enabled Mini App and current signed attendance identity; launch button follows its independent switch',async()=>{
 const f=fixture();try{f.opts.publicURL='https://tameer.test';f.restart();await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1)");const now=Date.parse('2026-10-16T04:00:05Z');f.setNow(now);let seen;
 f.bot.setExtensions({menuForChat:()=>null,processUpdate:async()=>false,miniHandle(action,b,who){seen={action,who};return {employee:who.employee};}});
 const body={initData:attendanceMiniSign(now),employee:'bob',admin:true};
 assert.throws(()=>f.bot.miniAPI('tools/cabinet/bootstrap',body),e=>e.status===403);
 await f.bot.handle('/api/telegram/attendance/mini/settings',{enabled:true,revision:f.bot.status().group.miniApp.revision});
 assert.equal(f.bot.status().group.geofence.enabled,false);
 const r=f.bot.miniAPI('tools/cabinet/bootstrap',body);assert.equal(r.employee,'alice');assert.equal(seen.who.employee,'alice');assert.equal(seen.who.botId,'554433221');
 for(const initData of [attendanceMiniSign(now,101,salaryToken),attendanceMiniSign(now,202),attendanceMiniSign(now-301000)])assert.throws(()=>f.bot.miniAPI('tools/cabinet/bootstrap',{...body,initData}));
 await f.bot.processUpdate(f.private('/menu'),token);assert.equal(f.sent.at(-1).reply_markup.keyboard[0][0].web_app.url,'https://tameer.test/attendance-mini?mode=cabinet');
 await f.bot.handle('/api/telegram/attendance/menu/sync',{});assert.equal(f.calls.findLast(c=>c.method==='setChatMenuButton').params.menu_button.web_app.url,'https://tameer.test/attendance-mini?mode=cabinet');
 f.db.exec("UPDATE tg_attendance_bindings SET status='pending' WHERE employee='alice'");assert.throws(()=>f.bot.miniAPI('tools/cabinet/bootstrap',body),e=>e.status===403);
 }finally{f.close();}
});
test('menu synchronization is serialized so a startup refresh cannot overwrite the cabinet switch',async()=>{
 const f=fixture();try{f.opts.publicURL='https://tameer.test';f.restart();await f.connect();const gate=deferred();let held=false;f.setTransportGate(async method=>{if(method==='setMyCommands'&&!held){held=true;await gate.promise;}});
 const first=f.bot.handle('/api/telegram/attendance/menu/sync',{});await new Promise(setImmediate);
 await f.bot.handle('/api/telegram/attendance/mini/settings',{enabled:true,revision:f.bot.status().group.miniApp.revision});
 const second=f.bot.handle('/api/telegram/attendance/menu/sync',{});await new Promise(setImmediate);assert.equal(f.calls.filter(c=>c.method==='setMyCommands').length,1);
 gate.resolve();await Promise.all([first,second]);const last=f.calls.findLast(c=>c.method==='setChatMenuButton');assert.equal(last.params.menu_button.type,'web_app');assert.equal(last.params.menu_button.web_app.url,'https://tameer.test/attendance-mini?mode=cabinet');
 }finally{f.close();}
});
const skipWithoutTrainingMedia=existsSync(new URL('../public/training/v46-arrival.mp4',import.meta.url))?false:'Optional training media is not bundled';
test('learning categories and video delivery require an approved private attendance identity and never write attendance',{skip:skipWithoutTrainingMedia},async()=>{
 const f=fixture();try{await f.connect();await f.bot.processUpdate(f.private('/learn'),token);assert.match(f.sent.at(-1).text,/administrator tasdig‘ini/);assert.equal(f.calls.filter(c=>c.method==='sendVideo').length,0);
 f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1)");await f.bot.processUpdate(f.private('/learn'),token);assert.equal(f.sent.at(-1).reply_markup.inline_keyboard.length,6);assert.match(f.sent.at(-1).text,/26 ta/);
 const query=id=>({callback_query:{id:'q-'+id,from:{id:101},data:'learn:v:start',message:{chat:{id:101,type:'private'},from:{id:554433221}}}});
 const bad=query('bad');bad.callback_query.from.id=202;await f.bot.processUpdate(bad,token);assert.equal(f.calls.filter(c=>c.method==='sendVideo').length,0);
 await f.bot.processUpdate(query('one'),token);let videos=f.calls.filter(c=>c.method==='sendVideo');assert.equal(videos.length,1);assert.ok(Buffer.isBuffer(videos[0].params.video));assert.equal(videos[0].params.chat_id,'101');assert.equal(videos[0].token,token);assert.equal(videos[0].params.supports_streaming,true);
 await f.bot.processUpdate(query('one'),token);assert.equal(f.calls.filter(c=>c.method==='sendVideo').length,1);
 await f.bot.processUpdate(query('two'),token);videos=f.calls.filter(c=>c.method==='sendVideo');assert.equal(videos[1].params.video,'training-cached-file');assert.equal(f.records.length,0);
 f.db.exec("UPDATE tg_attendance_bindings SET status='pending' WHERE employee='alice'");await f.bot.processUpdate(query('revoked'),token);assert.equal(f.calls.filter(c=>c.method==='sendVideo').length,2);
 }finally{f.close();}
});
test('uncertain training-video delivery is never blindly repeated for the same Telegram update',{skip:skipWithoutTrainingMedia},async()=>{
 const f=fixture();try{await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1)");f.setTransportGate(async method=>{if(method==='sendVideo')throw Error('timeout');});const u=f.private('/start learn_arrival');await f.bot.processUpdate(u,token);assert.equal(f.db.prepare('SELECT status FROM tg_attendance_training_delivery').get().status,'uncertain');await f.bot.processUpdate(u,token);assert.equal(f.calls.filter(c=>c.method==='sendVideo').length,1);assert.equal(f.records.length,0);
 }finally{f.close();}
});
test('training MP4 upload uses multipart video and JSON inline controls with the separate attendance token',{skip:skipWithoutTrainingMedia},async()=>{
 const f=fixture(),original=globalThis.fetch;try{await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1)");f.opts.transport=null;f.restart();const uploads=[];globalThis.fetch=async(url,o)=>{uploads.push({url,o});return {json:async()=>({ok:true,result:{message_id:1000,video:{file_id:'sent-file-id'}}})};};await f.bot.processUpdate(f.private('/start learn_start'),token);assert.equal(uploads.length,1);assert.equal(uploads[0].url,'https://api.telegram.org/bot'+token+'/sendVideo');const body=uploads[0].o.body;assert.ok(body instanceof FormData);assert.equal(body.get('video').type,'video/mp4');assert.match(body.get('video').name,/v46-start\.mp4/);assert.equal(body.get('chat_id'),'101');assert.equal(JSON.parse(body.get('reply_markup')).inline_keyboard.length,2);assert.equal(f.records.length,0);
 }finally{globalThis.fetch=original;f.close();}
});


test('responsible-reviewed GPS attendance keeps its group receipt without video reactions',async()=>{
 for(const kind of ['in','out']){const f=fixture();try{
  await f.connect();f.db.exec("INSERT INTO tg_attendance_bindings VALUES('alice','101','alice','approved',1)");
  await f.bot.handle('/api/telegram/attendance/settings',{enabled:true,groupId,mode:'auto'});
  const record={bot_id:'554433221',group:groupId,employee:'alice',status:'approved',kind,at:Date.parse('2026-10-16T04:00:00Z'),message:351,result:{summary:{late:12,worked:480}}};
  const result=await f.bot.notifyReviewedAttendance(record,{botId:'554433221',chat:'101'});
  assert.equal(result.delivered,true);const receipt=f.sent.find(m=>m.chat_id===groupId);assert.ok(receipt);
  assert.equal(receipt.reply_parameters.message_id,351);assert.match(receipt.text,kind==='in'?/(Смена открыта|Smena ochildi)/:/(Смена закрыта|Smena yopildi)/);
  assert.equal(f.calls.filter(c=>c.method==='setMessageReaction').length,0);
  const before=f.sent.length;assert.equal((await f.bot.notifyReviewedAttendance({...record,status:'pending'},{botId:'554433221',chat:'101'})).delivered,false);assert.equal(f.sent.length,before);
 }finally{f.close()}}
});
