import {readFileSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {trainingVersion,trainingCategories,trainingLessons} from './training-catalog.mjs';
const mediaRoot=fileURLToPath(new URL('./public/training/',import.meta.url));
const lessonById=new Map(trainingLessons.map(x=>[x.id,x]));
const time=s=>Math.floor(s/60)+':'+String(Math.round(s)%60).padStart(2,'0');
export function trainingView(botUsername=''){
 return {version:trainingVersion,language:'uz',title:'O‘quv markazi',botUsername,categories:trainingCategories,lessons:trainingLessons.map(({sha256,bytes,video,poster,subtitles,...s})=>({...s,videoURL:'/training-media/'+video,posterURL:'/training-media/'+poster,subtitlesURL:'/training-media/'+subtitles}))};
}
export function initAttendanceTraining(db,{identity,username,binding,clock=Date.now}){
 db.exec('CREATE TABLE IF NOT EXISTS tg_attendance_training_files(bot_id TEXT NOT NULL,lesson TEXT NOT NULL,sha256 TEXT NOT NULL,file_id TEXT NOT NULL,PRIMARY KEY(bot_id,lesson,sha256))');
 db.exec('CREATE TABLE IF NOT EXISTS tg_attendance_training_delivery(bot_id TEXT NOT NULL,chat TEXT NOT NULL,request_key TEXT NOT NULL,lesson TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(bot_id,chat,request_key))');
 const limited=new Map();
 const keyboard=()=>({inline_keyboard:[...trainingCategories.map(c=>[{text:c.title,callback_data:'learn:c:'+c.id}]) ]});
 const category=(id)=>{const c=trainingCategories.find(c=>c.id===id);if(!c)return null;return {text:'🎓 '+c.title+'\n\nDarsni tanlang. Ovoz va subtitrlar o‘zbekcha. Amallar administrator yoqqan funksiyalarda ishlaydi.',markup:{inline_keyboard:[...trainingLessons.filter(s=>s.category===id).map(s=>[{text:s.order+'. '+s.title+' · '+time(s.duration),callback_data:'learn:v:'+s.id}]),[{text:'← O‘quv markazi',callback_data:'learn:home'}]]}};};
 async function show(chat,io){await io.send(chat,'🎓 TAMEER · O‘quv markazi\n\n'+trainingLessons.length+' ta qisqa video dars. Avval bo‘limni, keyin kerakli funksiyani tanlang.\n\nVideolarda o‘quv namunalari ishlatilgan. Xodimlarning haqiqiy ma’lumotlari ko‘rsatilmagan.',keyboard());}
 async function video(id,chat,io,requestKey){
  const lesson=lessonById.get(id);if(!lesson){await io.send(chat,'Dars topilmadi. /learn orqali ro‘yxatni oching.');return;}
  const botId=String(identity()),old=db.prepare('SELECT status FROM tg_attendance_training_delivery WHERE bot_id=? AND chat=? AND request_key=?').get(botId,chat,requestKey);
  if(old){if(io.current())await io.send(chat,old.status==='sent'?'Bu dars shaxsiy chattingizga yuborilgan.':'Oldingi yuborish holatini shaxsiy chatda tekshiring. Kerak bo‘lsa dars tugmasini yana bosing.');return;}
  const now=clock(),recent=(limited.get(chat)||[]).filter(t=>t>now-60000);if(recent.length>=8){await io.send(chat,'Keyingi videoni olishdan oldin bir oz kuting.');return;}
  recent.push(now);limited.set(chat,recent);if(limited.size>200)for(const [k,v] of limited)if(v.every(t=>t<=now-60000))limited.delete(k);
  const key=[botId,lesson.id,lesson.sha256],cached=db.prepare('SELECT file_id FROM tg_attendance_training_files WHERE bot_id=? AND lesson=? AND sha256=?').get(...key);
  const caption='🎓 '+lesson.order+'. '+lesson.title+'\n'+lesson.audience+' · '+time(lesson.duration)+'\n\n'+lesson.steps.map((s,i)=>(i+1)+'. '+s).join('\n')+'\n\nO‘zbekcha ovoz va subtitrlar · o‘quv namunasi.';
  const markup={inline_keyboard:[[{text:'← '+trainingCategories.find(c=>c.id===lesson.category).title,callback_data:'learn:c:'+lesson.category}],[{text:'🎓 Barcha darslar',callback_data:'learn:home'}]]};
  const upload=()=>{const bytes=readFileSync(join(mediaRoot,lesson.video));if(bytes.length!==lesson.bytes||createHash('sha256').update(bytes).digest('hex')!==lesson.sha256)throw Error('Training media integrity');return bytes;};
  db.prepare('INSERT INTO tg_attendance_training_delivery VALUES(?,?,?,?,?,?)').run(botId,chat,requestKey,id,'sending',clock());
  try{
   let result;
   try{result=await io.video(chat,cached?.file_id||upload(),lesson,caption,markup);}
   catch(e){if(!cached||e.apiCode!==400)throw e;db.prepare('DELETE FROM tg_attendance_training_files WHERE bot_id=? AND lesson=? AND sha256=?').run(...key);if(!io.current()||!binding(chat))return;result=await io.video(chat,upload(),lesson,caption,markup);}
   db.prepare("UPDATE tg_attendance_training_delivery SET status='sent' WHERE bot_id=? AND chat=? AND request_key=?").run(botId,chat,requestKey);
   if(!io.current()||String(identity())!==botId||!binding(chat))return;
   const file=result?.video?.file_id;if(typeof file==='string'&&file.length>0&&file.length<=512)db.prepare('INSERT OR REPLACE INTO tg_attendance_training_files VALUES(?,?,?,?)').run(...key,file);
  }catch(e){db.prepare('UPDATE tg_attendance_training_delivery SET status=? WHERE bot_id=? AND chat=? AND request_key=?').run(e.apiCode?'failed':'uncertain',botId,chat,requestKey);if(io.current())await io.send(chat,e.apiCode===429?'Telegram vaqtincha chekladi. Keyinroq qayta urinib ko‘ring.':'Video yetkazilgani tasdiqlanmadi. Shaxsiy chatni tekshiring yoki kabinetdagi O‘quv markazida ko‘ring.');}
 }
 async function processUpdate(update,io){
  const q=update.callback_query,m=update.message;
  if(typeof q?.data==='string'&&q.data.startsWith('learn:')){
   if(q.message?.chat?.type!=='private'||String(q.message.chat.id)!==String(q.from?.id)||q.from?.is_bot||String(q.message.from?.id)!==String(identity())||!binding(String(q.from?.id))){await io.answer(q.id,'Tasdiqlangan profilingiz bilan shaxsiy chatni oching.');return true;}
   const chat=String(q.from.id);await io.answer(q.id,'');if(!io.current())return true;
   if(q.data==='learn:home')await show(chat,io);
   else if(q.data.startsWith('learn:c:')){const c=category(q.data.slice(8));if(c)await io.send(chat,c.text,c.markup);}
   else if(q.data.startsWith('learn:v:')&&typeof q.id==='string')await video(q.data.slice(8),chat,io,'q:'+q.id);
   return true;
  }
  if(!m||m.chat?.type!=='private'||m.from?.is_bot||!Number.isSafeInteger(m.from?.id)||m.from.id<1||String(m.chat.id)!==String(m.from.id)||typeof m.text!=='string'||m.forward_origin||m.forward_date||m.edit_date)return false;
  const text=m.text.trim(),command=text.match(/^\/learn(?:@([A-Za-z0-9_]+))?$/),start=text.match(/^\/start learn_([a-z-]+)$/);
  if(!start&&!['🎓 O‘quv markazi','O‘quv markazi','Обучение'].includes(text)&&(!command||command[1]&&command[1].toLowerCase()!==username().toLowerCase()))return false;
  const chat=String(m.from.id);if(!binding(chat)){await io.send(chat,'Avval shaxsiy profilingizni botga bog‘lang va administrator tasdig‘ini kuting.');return true;}
  if(start&&Number.isSafeInteger(m.message_id)&&m.message_id>0)await video(start[1],chat,io,'m:'+m.message_id);else await show(chat,io);return true;
 }
 return {processUpdate,total:trainingLessons.length};
}
