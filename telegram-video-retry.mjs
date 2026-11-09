import {createHash} from 'node:crypto';
export const VIDEO_RETRY_WINDOW=30*60000,VIDEO_RETRY_LIMIT=8;
const fingerprint=r=>createHash('sha256').update(JSON.stringify([r.group_id,r.message_id,r.user_id,r.employee,r.file_unique_id,r.media,r.at,r.revision])).digest('hex');
const exists=(db,t)=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);

// Ledger guard: only a server-observed, fresh original video may outlive the normal
// ten-minute input window. Never trust a timestamp or retry flag supplied by a client.
export function trustedVideoRetry(db,{employee,kind,at,evidence,botId,now=Date.now()}){
 if(!exists(db,'tg_attendance_video_retry')||!evidence||!botId)return false;
 const j=db.prepare('SELECT * FROM tg_attendance_video_retry WHERE group_id=? AND message_id=?').get(evidence.groupId,evidence.messageId),r=db.prepare('SELECT * FROM tg_attendance_requests WHERE group_id=? AND message_id=?').get(evidence.groupId,evidence.messageId);
 if(!j||!r||j.status!=='running'||j.kind!==kind||j.employee!==employee||r.employee!==employee||j.bot_id!==botId||r.at!==at||j.source_hash!==fingerprint(r)||j.attempts<1||j.attempts>VIDEO_RETRY_LIMIT||j.first_seen>now||j.first_seen-r.at>600000||r.at-j.first_seen>60000||j.expires>j.first_seen+VIDEO_RETRY_WINDOW||j.expires<now||r.status!=='pending')return false;
 const bot=db.prepare('SELECT bot_id,enabled FROM tg_attendance_bot_config WHERE id=1').get(),g=db.prepare('SELECT * FROM tg_attendance_config WHERE id=1').get(),b=db.prepare("SELECT employee FROM tg_attendance_bindings WHERE chat=? AND status='approved'").get(r.user_id),m=JSON.parse(r.media);
 return !!(bot?.enabled&&bot.bot_id===botId&&g?.enabled&&g.group_id===r.group_id&&g.revision===r.revision&&b?.employee===employee&&r.user_id===evidence.userId&&r.file_unique_id===evidence.fileUniqueId&&m.file_id===evidence.fileId&&m.type===evidence.mediaType&&m.duration===evidence.duration);
}

export function initVideoRetry(db,{clock=Date.now,botIdentity=()=>''}){
 db.exec(`CREATE TABLE IF NOT EXISTS tg_attendance_video_retry(group_id TEXT NOT NULL,message_id INTEGER NOT NULL,employee TEXT NOT NULL,kind TEXT NOT NULL,permission TEXT NOT NULL,bot_id TEXT NOT NULL,source_hash TEXT NOT NULL,first_seen INTEGER NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL DEFAULT '',error_code TEXT NOT NULL DEFAULT '',updated INTEGER NOT NULL,receipt TEXT NOT NULL DEFAULT '',PRIMARY KEY(group_id,message_id));
 CREATE TABLE IF NOT EXISTS tg_attendance_video_attempts(id INTEGER PRIMARY KEY,group_id TEXT NOT NULL,message_id INTEGER NOT NULL,employee TEXT NOT NULL,attempt INTEGER NOT NULL,phase TEXT NOT NULL,error_code TEXT NOT NULL,outcome TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS video_retry_due ON tg_attendance_video_retry(status,next);`);
 const get=r=>db.prepare('SELECT * FROM tg_attendance_video_retry WHERE group_id=? AND message_id=?').get(r.group_id,r.message_id);
 const log=(r,j,outcome,phase='',code='')=>db.prepare('INSERT INTO tg_attendance_video_attempts(group_id,message_id,employee,attempt,phase,error_code,outcome,at) VALUES(?,?,?,?,?,?,?,?)').run(r.group_id,r.message_id,r.employee,j?.attempts||0,phase,code,outcome,clock());
 function matches(r,j){return !!j&&j.source_hash===fingerprint(r)&&j.employee===r.employee&&j.bot_id===String(botIdentity())&&j.first_seen-r.at<=600000&&r.at-j.first_seen<=60000&&j.expires<=j.first_seen+VIDEO_RETRY_WINDOW;}
 function eligible(r){const j=get(r);return matches(r,j)&&['pending','running'].includes(j.status)&&j.expires>=clock();}
 function begin(r,kind,permission){
  let j=get(r);if(!j){if(clock()-r.at>600000||r.at-clock()>60000)return {ok:false};db.prepare("INSERT INTO tg_attendance_video_retry(group_id,message_id,employee,kind,permission,bot_id,source_hash,first_seen,expires,next,status,updated) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)").run(r.group_id,r.message_id,r.employee,kind,JSON.stringify(permission),String(botIdentity()),fingerprint(r),clock(),clock()+VIDEO_RETRY_WINDOW,clock(),clock());j=get(r);}
  if(!matches(r,j)||j.kind!==kind||j.permission!==JSON.stringify(permission)||j.expires<clock()||j.status==='done'||j.attempts>=VIDEO_RETRY_LIMIT)return {ok:false};
  if(j.status==='running'&&j.next>clock()||j.status==='pending'&&j.next>clock())return {ok:false,pending:true};
  const n=db.prepare("UPDATE tg_attendance_video_retry SET status='running',attempts=attempts+1,next=?,updated=? WHERE group_id=? AND message_id=? AND attempts=? AND status=?").run(clock()+90000,clock(),r.group_id,r.message_id,j.attempts,j.status).changes;
  if(!n)return {ok:false,pending:true};j=get(r);log(r,j,'started','start');return {ok:true,job:j};
 }
 function phase(r,value){db.prepare('UPDATE tg_attendance_video_retry SET phase=?,updated=? WHERE group_id=? AND message_id=?').run(value,clock(),r.group_id,r.message_id);}
 function fail(r,stage,e){const j=get(r);if(!j)return {retry:false};
  let code=typeof e?.code==='string'&&/^[A-Z0-9_]{1,48}$/.test(e.code)?e.code:typeof e?.cause?.code==='string'&&/^[A-Z0-9_]{1,48}$/.test(e.cause.code)?e.cause.code:e?.name==='AbortError'||e?.name==='TimeoutError'?'TIMEOUT':'UNKNOWN';
  if(Number.isInteger(e?.apiCode))code='TELEGRAM_'+e.apiCode;
  if(Number.isInteger(e?.httpStatus))code='HTTP_'+e.httpStatus;
  const permanent=['ATTENDANCE_INVALID_FILE','ATTENDANCE_CHANGED','ATTENDANCE_LEDGER_REJECTED'].includes(code),busy=e?.errcode===5||e?.errcode===6||['SQLITE_BUSY','SQLITE_LOCKED','EBUSY','EIO','ENOSPC','ATTENDANCE_NO_SPACE'].includes(code);
  const transport=['telegram-file','download'].includes(stage)&&(!e?.apiCode||e.apiCode===429||e.apiCode>=500)&&(!e?.httpStatus||e.httpStatus===429||e.httpStatus>=500);
  const retry=!permanent&&(transport||busy||stage==='bookkeeping')&&j.attempts<VIDEO_RETRY_LIMIT&&j.expires>clock();
  const delay=Math.max([15000,30000,60000,120000,240000,300000,300000][Math.max(0,j.attempts-1)]||300000,Math.min(3600000,Math.max(0,Number(e?.retryAfter)||0)*1000));
  db.prepare('UPDATE tg_attendance_video_retry SET status=?,phase=?,error_code=?,next=?,updated=? WHERE group_id=? AND message_id=?').run(retry?'pending':'failed',stage,code,clock()+delay,clock(),r.group_id,r.message_id);log(r,j,retry?'retry-scheduled':'failed',stage,code);return {retry,attempt:j.attempts,code};
 }
 function stop(r,code='REQUEST_CHANGED',state='cancelled'){const j=get(r);if(!j||j.status==='done')return;db.prepare('UPDATE tg_attendance_video_retry SET status=?,error_code=?,updated=? WHERE group_id=? AND message_id=?').run(state,code,clock(),r.group_id,r.message_id);log(r,j,state,j.phase,code);}
 function done(r){const j=get(r);if(!j)return;db.prepare("UPDATE tg_attendance_video_retry SET status='done',updated=? WHERE group_id=? AND message_id=?").run(clock(),r.group_id,r.message_id);log(r,j,'saved',j.phase);}
 function due(){return db.prepare("SELECT * FROM tg_attendance_video_retry WHERE status IN ('pending','running') AND (next<=? OR expires<?) ORDER BY first_seen LIMIT 2").all(clock(),clock());}
 function view(){return {limit:VIDEO_RETRY_LIMIT,windowMinutes:VIDEO_RETRY_WINDOW/60000,pending:db.prepare("SELECT COUNT(*) n FROM tg_attendance_video_retry WHERE status IN ('pending','running')").get().n,items:db.prepare('SELECT j.group_id,j.message_id,j.employee,e.name,j.kind,j.status,j.attempts,j.next,j.expires,j.phase,j.error_code,j.updated,r.at FROM tg_attendance_video_retry j JOIN employees e ON e.id=j.employee JOIN tg_attendance_requests r ON r.group_id=j.group_id AND r.message_id=j.message_id ORDER BY j.updated DESC LIMIT 30').all()};}
 return {get,begin,phase,fail,stop,done,due,view,eligible,matches,log,receipt(r,state){if(state!==undefined)db.prepare('UPDATE tg_attendance_video_retry SET receipt=? WHERE group_id=? AND message_id=?').run(state,r.group_id,r.message_id);return get(r)?.receipt||'';}};
}
