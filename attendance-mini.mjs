import {createHash,randomBytes} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
export function initAttendanceMini(db,{clock=Date.now,fail,transaction,payroll,publicURL='',botIdentity,authenticate,contextFor,accept,save}){
 db.exec(`CREATE TABLE IF NOT EXISTS tg_attendance_mini_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,updated INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS tg_attendance_mini_sessions(id INTEGER PRIMARY KEY,hash TEXT NOT NULL UNIQUE,employee TEXT NOT NULL,chat TEXT NOT NULL,bot_id TEXT NOT NULL,reference TEXT NOT NULL,group_id TEXT NOT NULL,message_id INTEGER NOT NULL,geo_revision INTEGER NOT NULL,mini_revision INTEGER NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',check_id INTEGER);`);
 db.prepare('INSERT OR IGNORE INTO tg_attendance_mini_settings(id) VALUES(1)').run();
 let origin='';try{const u=new URL(publicURL);if(u.protocol==='https:')origin=u.origin;}catch{}
 const config=()=>db.prepare('SELECT * FROM tg_attendance_mini_settings WHERE id=1').get();
 const view=()=>({enabled:!!config().enabled,revision:config().revision,httpsReady:!!origin,url:origin?origin+'/attendance-mini':''});
 function configure(b){const before=config();if(typeof b.enabled!=='boolean'||b.revision!==before.revision)fail('Настройки мини-приложения изменились. Обновите страницу',409);if(b.enabled&&!origin)fail('Для мини-приложения нужен HTTPS-адрес сайта');transaction(()=>{db.prepare('UPDATE tg_attendance_mini_settings SET enabled=?,revision=revision+1,updated=? WHERE id=1').run(Number(b.enabled),clock());db.prepare("UPDATE tg_attendance_mini_sessions SET status='cancelled' WHERE status='pending'").run();payroll.audit('attendance-mini-settings',null,null,{before,after:config()});});return {ok:true};}
 function requireEnabled(){if(!config().enabled||!origin)fail('Мини-приложение выключено. Вернитесь в бота и нажмите /start',403);}
 function identity(b){requireEnabled();if(!b||typeof b.reference!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(b.reference))fail('Откройте приложение кнопкой под запросом геолокации',400);return authenticate(b.initData);}
 function context(b){const who=identity(b),c=contextFor(who,b.reference);if(c.state!=='waiting')return c.public;
  if(db.prepare('SELECT count(*) n FROM tg_attendance_mini_sessions WHERE chat=? AND created>?').get(who.chat,clock()-60000).n>=15)fail('Слишком много запросов. Подождите минуту',429);
  const nonce=randomBytes(32).toString('base64url'),s=config();
  transaction(()=>{db.prepare("UPDATE tg_attendance_mini_sessions SET status='cancelled' WHERE chat=? AND status='pending'").run(who.chat);db.prepare('INSERT INTO tg_attendance_mini_sessions(hash,employee,chat,bot_id,reference,group_id,message_id,geo_revision,mini_revision,created,expires) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(hash(nonce),who.employee,who.chat,String(botIdentity()),b.reference,c.r.group_id,c.r.message_id,c.geoRevision,s.revision,clock(),c.expires);});
  return {...c.public,nonce,expires:c.expires};
 }
 let queue=Promise.resolve();
 async function submit(b,token){const who=identity(b);if(typeof b.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.nonce))fail('Откройте приложение заново',401);const s=db.prepare('SELECT * FROM tg_attendance_mini_sessions WHERE hash=?').get(hash(b.nonce));
  if(!s||s.employee!==who.employee||s.chat!==who.chat||s.bot_id!==String(botIdentity())||s.reference!==b.reference||s.mini_revision!==config().revision||s.expires<clock())fail('Запрос истёк или настройки изменились. Отправьте новое видео',409);
  const c=contextFor(who,b.reference);if(c.geoRevision!==s.geo_revision)fail('Территория магазина изменилась. Отправьте новое видео',409);
  if(s.status==='accepted')return c.public;
  if(s.status!=='pending'||c.state!=='waiting')fail('Геолокация уже обработана. Откройте приложение заново',409);
  const accepted=accept(c.r,b.location,s,(id,ok)=>{const n=db.prepare("UPDATE tg_attendance_mini_sessions SET status=?,check_id=? WHERE id=? AND status='pending'").run(ok?'accepted':'denied',id,s.id).changes;if(!n)fail('Этот запрос уже использован',409);});
  if(!accepted.ok)return {state:accepted.state||'error',reason:accepted.reason,distance:accepted.distance,radius:c.public.radius};
  // The proof and the consumed nonce are already durable. A retry cannot post twice.
  const result=await save(c.r,accepted.kind,accepted.permission,token,who.botId);
  return {...contextFor(who,b.reference).public,...(!result.ok&&!result.retry?{state:'review',reason:result.reason}:{})};
 }
 function handle(action,b,token){const run=()=>action==='context'?context(b):action==='location'?submit(b,token):fail('Не найдено',404);const task=queue.then(run);queue=task.catch(()=>{});return task;}
 return {view,config,configure,handle,url:r=>origin+'/attendance-mini?request='+encodeURIComponent(r.callback_token),active:()=>!!origin&&!!config().enabled};
}
