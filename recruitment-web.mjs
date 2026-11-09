import {randomBytes,createHash} from 'node:crypto';
import {recruitmentQuestions as questions} from './recruitment-questions.mjs';
import {validDate,localDate} from './model.mjs';
export function initRecruitmentWeb(db,{recruitment,fail,clock=Date.now,tz='Asia/Tashkent'}){
 db.exec(`CREATE TABLE IF NOT EXISTS hr_recruit_web_sessions(token TEXT PRIMARY KEY,id TEXT NOT NULL,csrf TEXT NOT NULL,chat TEXT NOT NULL,username TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS hr_recruit_web_drafts(owner TEXT PRIMARY KEY,state TEXT NOT NULL,updated INTEGER NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS hr_recruit_web_draft_revocations(owner TEXT NOT NULL,request_id TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(owner,request_id));
 CREATE TABLE IF NOT EXISTS hr_recruit_web_rates(bucket TEXT NOT NULL,kind TEXT NOT NULL,window INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(bucket,kind,window));`);
 const hash=v=>createHash('sha256').update(v).digest('hex');
 const session=token=>typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)?db.prepare('SELECT * FROM hr_recruit_web_sessions WHERE token=? AND expires>?').get(hash(token),clock()):null;
 function rate(ip,kind,max){const window=Math.floor(clock()/3600000),bucket=hash(ip);db.prepare('DELETE FROM hr_recruit_web_rates WHERE window<?').run(window-24);const row=db.prepare('SELECT count FROM hr_recruit_web_rates WHERE bucket=? AND kind=? AND window=?').get(bucket,kind,window);if(row?.count>=max)fail('Слишком много запросов. Повторите позже. / Keyinroq urinib ko‘ring.',429);db.prepare('INSERT INTO hr_recruit_web_rates VALUES(?,?,?,1) ON CONFLICT(bucket,kind,window) DO UPDATE SET count=count+1').run(bucket,kind,window)}
 function cleanup(){db.prepare('DELETE FROM hr_recruit_web_drafts WHERE expires<=? OR owner NOT IN (SELECT token FROM hr_recruit_web_sessions WHERE expires>?)').run(clock(),clock());db.prepare('DELETE FROM hr_recruit_web_draft_revocations WHERE expires<=? OR owner NOT IN (SELECT token FROM hr_recruit_web_sessions WHERE expires>?)').run(clock(),clock());db.prepare('DELETE FROM hr_recruit_web_sessions WHERE expires<=?').run(clock())}
 function start(b,token,ip){rate(ip,'session',120);cleanup();const identity=b.initData?recruitment.authenticateMiniApp(b.initData):null;let s=session(token);const chat=identity?String(identity.id):'';
  // Telegram WebViews may discard cookies. A fresh signed Telegram identity can
  // recover its own opted-in draft, without trusting a client-provided user ID.
  if((!s||s.chat!==chat)&&identity){const previous=db.prepare('SELECT s.* FROM hr_recruit_web_sessions s JOIN hr_recruit_web_drafts d ON d.owner=s.token WHERE s.chat=? AND s.expires>? AND d.expires>? ORDER BY d.updated DESC LIMIT 1').get(chat,clock(),clock());if(previous){token=randomBytes(32).toString('hex');const newHash=hash(token),newCSRF=randomBytes(24).toString('hex');db.exec('SAVEPOINT web_draft_recovery');try{db.prepare('UPDATE hr_recruit_web_drafts SET owner=? WHERE owner=?').run(newHash,previous.token);db.prepare('UPDATE hr_recruit_web_sessions SET token=?,csrf=? WHERE token=?').run(newHash,newCSRF,previous.token);db.exec('RELEASE SAVEPOINT web_draft_recovery')}catch(e){db.exec('ROLLBACK TO SAVEPOINT web_draft_recovery');db.exec('RELEASE SAVEPOINT web_draft_recovery');throw e}s={...previous,token:newHash,csrf:newCSRF}}}
  if(!s||s.chat!==chat){token=randomBytes(32).toString('hex');s={token:hash(token),id:randomBytes(24).toString('hex'),csrf:randomBytes(24).toString('hex'),chat,username:identity?.username||'',expires:clock()+86400000};db.prepare('INSERT INTO hr_recruit_web_sessions VALUES(?,?,?,?,?,?)').run(s.token,s.id,s.csrf,s.chat,s.username,s.expires)}
  return {token,data:{csrf:s.csrf,sessionToken:token,telegram:!!identity,name:identity?[identity.first_name,identity.last_name].filter(Boolean).join(' ').slice(0,80):'',language:identity?.language_code?.startsWith('uz')?'uz':'ru',resumeAvailable:!!db.prepare('SELECT owner FROM hr_recruit_web_drafts WHERE owner=? AND expires>?').get(s.token,clock()),expires:s.expires}};
 }
 function owned(token,csrf){const s=session(token);if(!s)fail('Обновите страницу / Sahifani yangilang',401);if(csrf!==s.csrf)fail('Обновите страницу / Sahifani yangilang',403);return s}
 function loadDraft(token,csrf){cleanup();const s=owned(token,csrf),row=db.prepare('SELECT state,updated,expires FROM hr_recruit_web_drafts WHERE owner=? AND expires>?').get(s.token,clock());return {draft:row?{state:JSON.parse(row.state),updated:row.updated,expires:row.expires}:null}}
 function deleteDraft(token,csrf){const s=owned(token,csrf),current=db.prepare('SELECT state FROM hr_recruit_web_drafts WHERE owner=?').get(s.token);if(current)db.prepare('INSERT INTO hr_recruit_web_draft_revocations VALUES(?,?,?) ON CONFLICT(owner,request_id) DO UPDATE SET expires=excluded.expires').run(s.token,JSON.parse(current.state).requestId,clock()+7*86400000);db.prepare('DELETE FROM hr_recruit_web_drafts WHERE owner=?').run(s.token);return {ok:true}}
 function saveDraft(b,token,csrf,ip){cleanup();const s=owned(token,csrf),state=b?.state;
  if(b?.optIn!==true||!state||typeof state!=='object'||Array.isArray(state)||!['ru','uz'].includes(state.language)||!Number.isInteger(state.page)||state.page<0||state.page>5||typeof state.requestId!=='string'||! /^[a-f0-9-]{36}$/.test(state.requestId)||typeof state.vacancy!=='string'||state.vacancy.length>100||!state.answers||typeof state.answers!=='object'||Array.isArray(state.answers))fail('Некорректный черновик / Qoralama noto‘g‘ri');
  // A delayed browser autosave must never recreate or edit a confirmed form.
  if(db.prepare('SELECT id FROM hr_recruit_applications WHERE session=?').get('web:'+s.id+':'+state.requestId))fail('Анкета уже отправлена / Savolnoma yuborilgan',409);
  if(db.prepare('SELECT request_id FROM hr_recruit_web_draft_revocations WHERE owner=? AND request_id=? AND expires>?').get(s.token,state.requestId,clock()))fail('Этот черновик удалён. Обновите страницу, чтобы начать новую анкету. / Bu qoralama o‘chirildi. Yangi savolnoma uchun sahifani yangilang.',409);
  const existing=db.prepare('SELECT state FROM hr_recruit_web_drafts WHERE owner=?').get(s.token);
  if(existing&&JSON.parse(existing.state).requestId!==state.requestId)fail('В этом браузере уже есть другой черновик. Обновите страницу и выберите «Продолжить» или «Удалить». / Bu brauzerda boshqa qoralama bor. Sahifani yangilang va davom eting yoki qoralamani o‘chiring.',409);
  const answers=Object.create(null);
  for(const q of questions){if(q.id==='role')continue;const value=state.answers[q.id];if(value===undefined||value===null||value==='')continue;
   if(q.kind==='photo'){if(typeof value!=='object'||typeof value.base64!=='string'||value.base64.length>409600||! /^[A-Za-z0-9+/]*={0,2}$/.test(value.base64))fail('Фото до 300 КБ / Foto 300 KB gacha');const bytes=Buffer.from(value.base64,'base64'),mime=bytes.subarray(0,3).toString('hex')==='ffd8ff'?'image/jpeg':bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?'image/png':null;if(!mime||bytes.length<12||bytes.length>307200||value.base64!==bytes.toString('base64'))fail('Неверное фото / Foto noto‘g‘ri');answers[q.id]={base64:value.base64};continue}
   if(typeof value!=='string'||value.length>q.max||value.includes('\u0000'))fail('Некорректный ответ / Javob noto‘g‘ri');answers[q.id]=value;
  }
  rate(ip,'draft',600);const clean={language:state.language,page:state.page,requestId:state.requestId,vacancy:state.vacancy,answers},expires=clock()+7*86400000;
  db.prepare('INSERT INTO hr_recruit_web_drafts VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET state=excluded.state,updated=excluded.updated,expires=excluded.expires').run(s.token,JSON.stringify(clean),clock(),expires);db.prepare('UPDATE hr_recruit_web_sessions SET expires=? WHERE token=?').run(expires,s.token);return {ok:true,expires};
 }
 function catalog(){return {vacancies:recruitment.catalog().map(({id,title,department,remaining})=>({id,title,department,remaining})),questions,botUsername:recruitment.botUsername?.()||''}}
 function submit(b,token,csrf,ip){const s=session(token);if(!s)fail('Обновите страницу / Sahifani yangilang',401);if(csrf!==s.csrf)fail('Обновите страницу / Sahifani yangilang',403);
  if(typeof b.requestId!=='string'||! /^[a-f0-9-]{36}$/.test(b.requestId))fail('Некорректный запрос');const applicationSession='web:'+s.id+':'+b.requestId;
  const old=db.prepare('SELECT id FROM hr_recruit_applications WHERE session=?').get(applicationSession);if(old){db.prepare("DELETE FROM hr_recruit_web_drafts WHERE owner=? AND json_extract(state,'$.requestId')=?").run(s.token,b.requestId);return {ok:true,id:old.id,duplicate:true}};
  if(b.consent!==true||!['ru','uz'].includes(b.language)||typeof b.vacancy!=='string'||!b.answers||typeof b.answers!=='object'||Array.isArray(b.answers))fail('Проверьте анкету и согласие / Savolnoma va rozilikni tekshiring');
  const vacancy=recruitment.catalog().find(v=>v.id===b.vacancy);if(!vacancy)fail('Вакансия уже закрыта. Выберите другую. / Vakansiya yopilgan. Boshqasini tanlang.',409);
  const a=Object.create(null),photos=[];a.role=vacancy.title;
  for(const q of questions){if(q.id==='role')continue;let v=b.answers[q.id];if(v===null||v===undefined||v===''){if(q.required)fail(q[b.language],400);a[q.id]=null;continue}
   if(q.kind==='photo'){if(typeof v!=='object'||typeof v.base64!=='string'||v.base64.length>409600||! /^[A-Za-z0-9+/]*={0,2}$/.test(v.base64))fail('Фото до 300 КБ / Foto 300 KB gacha');const bytes=Buffer.from(v.base64,'base64'),mime=bytes.subarray(0,3).toString('hex')==='ffd8ff'?'image/jpeg':bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?'image/png':null;if(!mime||bytes.length<12||bytes.length>307200||v.base64!==bytes.toString('base64'))fail('Неверное фото / Foto noto‘g‘ri');photos.push({kind:q.id,mime,bytes});continue}
   if(typeof v!=='string'||v.trim().length>q.max||v.includes('\u0000'))fail(q[b.language],400);v=v.trim();
   if(q.required&&!v)fail(q[b.language],400);
   if(q.kind==='yesno'&&!['yes','no'].includes(v))fail(q[b.language]);
   if(q.kind==='phone'){v=v.replace(/[\s()\-]/g,'');if(!/^\+?\d{7,15}$/.test(v))fail(q[b.language])}
   if(q.kind==='money'){v=v.replace(/\s/g,'').replace(',','.');if(!/^\d{1,11}(\.\d{1,2})?$/.test(v))fail(q[b.language])}
   if(q.kind==='date'&&(!validDate(v)||v<'1900-01-01'||v>localDate(clock(),tz).date))fail(q[b.language]);a[q.id]=v||null;
  }
  for(const q of questions)if((q.id==='categories'&&a.driver!=='yes')||(q.id==='carModel'&&a.car!=='yes')||(q.id==='criminalDetails'&&a.criminal!=='yes')||/^(jobRole|experience|leave|jobSalary|reference)[12]$/.test(q.id)&&!a['company'+q.id.at(-1)])a[q.id]=null;
  rate(ip,'submit',20);const result=recruitment.submitWeb({answers:a,photos,vacancy,language:b.language,session:applicationSession,chat:s.chat||'web:'+s.id,username:s.username});db.prepare("DELETE FROM hr_recruit_web_drafts WHERE owner=? AND json_extract(state,'$.requestId')=?").run(s.token,b.requestId);return result;
 }
 return {start,catalog,submit,loadDraft,saveDraft,deleteDraft};
}
