import {trainingView} from './attendance-training.mjs';
import {localDate,dayAdd,validDate} from './model.mjs';
import {attendanceTextUz} from './attendance-uz.mjs';
import {attendanceXlsx} from './attendance-excel.mjs';

// The cabinet is a presentation of existing workflows, never an admin identity.
export function initAttendanceCabinet(db,{bot,schedule,storeOps,automation,tools,excellence,earlyExit,reports,fail,clock=Date.now,tz='Asia/Tashkent'}){
 db.exec('CREATE TABLE IF NOT EXISTS attendance_cabinet_reports(employee TEXT NOT NULL,request_id TEXT NOT NULL,day TEXT NOT NULL,bot_id TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(employee,request_id))');
 const has=t=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
 function actor(who){
  const e=who&&db.prepare("SELECT e.id,e.name,e.role,b.chat FROM employees e JOIN tg_attendance_bindings b ON b.employee=e.id WHERE e.id=? AND e.active=1 AND b.status='approved' AND b.chat=?").get(who.employee,who.chat);
  if(!e||who.botId!==String(bot.identity())||!bot.status().connected)fail('Botni qayta oching. Profil bog‘lanishi o‘zgargan',403);
  return {id:'telegram:'+e.chat,employee:e.id,chat:String(e.chat),name:e.name,role:e.role,channel:'attendance-cabinet'};
 }
 const safeEarly=r=>({id:r.token,name:r.name,day:r.day,at:r.at,status:r.status,responsible:r.responsible_name,decided:r.decided,decision:r.reason||''});
 function earlyInbox(a){return earlyExit.enabled()?earlyExit.pendingFor(a.employee).filter(r=>r.employee!==a.employee&&r.bot_id===String(bot.identity())&&earlyExit.privateTarget(r.token)?.employee===a.employee).map(safeEarly):[];}
 function reportAllowed(a){return has('tg_daily_report_recipients')&&has('tg_shift_excel_settings')&&!!db.prepare('SELECT enabled FROM tg_shift_excel_settings WHERE id=1').get()?.enabled&&!!db.prepare("SELECT employee FROM tg_daily_report_recipients WHERE employee=? AND active=1 AND bot_id=? AND chat=?").get(a.employee,String(bot.identity()),a.chat);}
 async function bootstrap(who){
  const a=actor(who),today=localDate(clock(),tz).date,p=schedule.forMoment(a.employee,clock()),s=db.prepare('SELECT * FROM shifts WHERE employee=? AND day=?').get(a.employee,p.day);
  const summary=s?storeOps.corrected(s,db.prepare('SELECT * FROM events WHERE shift=? ORDER BY at,id').all(s.id),clock()):null;
  const shifts=automation.miniView(a),inbox=tools.miniHandle('inbox',{},who),team=excellence.miniHandle('bootstrap',{},who),group=bot.status().group,groupId=group.groupId;
  const latest=db.prepare('SELECT MAX(message_id) n FROM tg_attendance_requests WHERE group_id=?').get(groupId)?.n;
  const ownEarly=has('early_exit_requests')?db.prepare('SELECT r.*,e.name,s.day FROM early_exit_requests r JOIN employees e ON e.id=r.employee JOIN shifts s ON s.id=r.shift WHERE r.employee=? ORDER BY r.created DESC LIMIT 30').all(a.employee).map(safeEarly):[];
  const names=db.prepare('SELECT name FROM employees').all().map(e=>e.name),uz=t=>attendanceTextUz(t,names);
  return {employee:a.employee,name:a.name,role:a.role,language:'uz',today,timezone:tz,serverNow:clock(),plan:{day:p.day,off:!!p.off,start:p.start??null,end:p.end??null},summary:summary?{status:uz(summary.status),in:summary.in,out:summary.out,worked:summary.worked,late:summary.late,breaks:summary.breaks,early:summary.early}:null,
   openShifts:db.prepare("SELECT s.day,s.planned_start,s.planned_end FROM shifts s WHERE s.employee=? AND NOT EXISTS(SELECT 1 FROM events e WHERE e.shift=s.id AND e.kind='out') ORDER BY s.day DESC LIMIT 31").all(a.employee),
   schedule:schedule.view(a.employee,today).days.slice(0,31).map(d=>({day:d.day,off:!!d.off,startTime:d.startTime||'',endTime:d.endTime||'',conflict:!!d.conflict})),
   features:shifts.features,tools:inbox.features,teamAvailable:Object.values(team.features).some(Boolean),teamFeatures:team.features,
   manager:shifts.manager||inbox.manager||earlyInbox(a).length>0,requests:shifts.own,earlyRequests:ownEarly,
   inbox:{shifts:shifts.pending,credits:shifts.credits,gps:inbox.gps,swaps:inbox.swaps,early:earlyInbox(a)},
   presence:shifts.presence?uz(shifts.presence):null,health:inbox.health?{...inbox.health,issues:inbox.health.issues.map(i=>({...i,text:uz(i.text)}))}:null,
   reports:reportAllowed(a),videos:await bot.cabinetVideos(who),groupURL:group.enabled&&/^-100\d+$/.test(groupId)&&latest?'https://t.me/c/'+groupId.slice(4)+'/'+latest:'',geofence:!!group.geofence?.enabled};
 }
 async function report(b,a){
  if(!reportAllowed(a))fail('Sizga Excel hisobotlariga ruxsat berilmagan',403);
  const today=localDate(clock(),tz).date;if(!validDate(b.day)||b.day>today||b.day<dayAdd(today,-366)||!/^[a-f0-9-]{36}$/i.test(b.requestId||''))fail('Hisobot sanasini tekshiring');
  const old=db.prepare('SELECT * FROM attendance_cabinet_reports WHERE employee=? AND request_id=?').get(a.employee,b.requestId);
  if(old){if(old.day!==b.day||old.bot_id!==String(bot.identity()))fail('So‘rov kodi boshqa hisobotga tegishli',409);return {ok:true,status:old.status==='sending'?'uncertain':old.status};}
  if(db.prepare('SELECT 1 FROM attendance_cabinet_reports WHERE employee=? AND created>? LIMIT 1').get(a.employee,clock()-60000))fail('Hisobot yuborishdan oldin bir daqiqa kuting',429);
  const data=reports.report(b.day),bytes=attendanceXlsx(data,{timezone:tz}),target=bot.dailyReportTarget(a.employee);
  if(!target.ready||target.userId!==a.chat)fail('Botdagi profilingizni tekshiring',403);
  db.prepare('INSERT INTO attendance_cabinet_reports VALUES(?,?,?,?,?,?)').run(a.employee,b.requestId,b.day,String(bot.identity()),'sending',clock());
  let result;try{result=await bot.notifyAttendanceExcel(a.employee,bytes,'TAMEER-attendance-'+b.day+'.xlsx','TAMEER · Davomat hisoboti · '+b.day,target);}catch{result={delivered:false,uncertain:true};}
  const status=result.delivered?'sent':result.uncertain?'uncertain':'failed';db.prepare('UPDATE attendance_cabinet_reports SET status=? WHERE employee=? AND request_id=?').run(status,a.employee,b.requestId);return {ok:true,status};
 }
 async function handle(action,b,who){
  const a=actor(who);
  try{
   if(action==='bootstrap')return await bootstrap(who);
   if(action==='training')return trainingView(bot.status().username||'');
   if(action==='request')return automation.miniCreate(b,a);
   if(action==='decision')return automation.miniDecide(b,a);
   if(action==='credit/decision')return automation.miniCreditDecision(b,a);
   if(action==='video/confirm')return await bot.cabinetConfirm(b,who);
   if(action==='early/decision'){
    const r=earlyExit.decide(b.id,b.status,{...a,telegram:true,botId:who.botId,groupId:bot.status().group.groupId});
    if(!r.duplicate)await bot.notifyEmployee(r.request.employee,(b.status==='approved'?'✅ Ruxsat tasdiqlandi':'❌ Ruxsat rad etildi')+' · '+r.request.day+'\n'+r.request.responsible_name).catch(()=>{});
    return {ok:true,duplicate:!!r.duplicate};
   }
   if(action==='report')return await report(b,a);
   fail('Amal mavjud emas',404);
  }catch(e){if(!e.status)throw e;const translated=attendanceTextUz(e.message);throw Object.assign(Error(/[А-Яа-яЁё]/u.test(translated)?'Amal bajarilmadi. Ma’lumot, jadval va ruxsatlarni tekshiring.':translated),{status:e.status});}
 }
 return {handle};
}
