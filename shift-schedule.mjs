import {localDate,dayAdd,validDate,plan} from './model.mjs';

export function initShiftSchedule(db,{settings,hr,fail,tz='Asia/Tashkent',clock=Date.now,branchSettings=null}){
 db.exec(`CREATE TABLE IF NOT EXISTS store_schedules(employee TEXT PRIMARY KEY REFERENCES employees(id),json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS store_schedule_days(employee TEXT NOT NULL REFERENCES employees(id),day TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(employee,day));`);
 const time=v=>typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
 function validate(b){if(typeof b.off!=='boolean')fail('Укажите рабочий или выходной день');if(!b.off&&(!time(b.start)||!time(b.end)||b.start===b.end))fail('Укажите начало и конец смены');return {off:b.off,start:b.start||'09:00',end:b.end||'18:00',reason:String(b.reason||'').trim().slice(0,300)}}
 function forDay(employee,day,{ignoreLeave=false,ignoreDayOverride=false}={}){
  if(!validDate(day))fail('Неверная дата');
  const base={...settings(),...(branchSettings?.(employee,day)||{})},exception=!ignoreDayOverride&&db.prepare('SELECT json FROM store_schedule_days WHERE employee=? AND day=?').get(employee,day),weekly=db.prepare('SELECT json FROM store_schedules WHERE employee=?').get(employee);
  let config,source='Магазин';
  if(exception){config=JSON.parse(exception.json);source='Индивидуальная дата'}
  else if(weekly){config=JSON.parse(weekly.json)[new Date(day+'T12:00:00Z').getUTCDay()];source='Личный график'}
  else if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hr_development'").get()){
   const legacy=db.prepare("SELECT json FROM hr_development WHERE employee=? AND kind='shift'").all(employee).map(r=>JSON.parse(r.json)).filter(r=>r.day===day);
   if(legacy.length>1)return {day,off:true,source:'Несколько планов: уточните график',conflict:true};
   if(legacy.length){config=legacy[0];source='HR: план смены'}
  }
  config={...base,...config};const leave=!ignoreLeave&&hr?.absence(employee,day);if(leave)return {day,off:true,source:'Согласованное отсутствие'};
  if(config.off)return {day,off:true,source,reason:config.reason||''};
  const p=plan(day,config,tz);return {day,off:false,start:p.start,end:p.end,startTime:config.start,endTime:config.end,grace:base.grace,breakLimit:base.breakLimit,source,reason:config.reason||''};
 }
 function forMoment(employee,at=clock()){
  const local=localDate(at,tz),previous=forDay(employee,dayAdd(local.date,-1));
  if(!previous.off&&localDate(previous.end,tz).date===local.date&&at<previous.end)return previous;
  return forDay(employee,local.date);
 }
 function save(b,actor){if(!db.prepare('SELECT id FROM employees WHERE id=? AND active=1').get(b.employee))fail('Сотрудник не найден');
  if(b.day){if(!validDate(b.day))fail('Неверная дата');const r={...validate(b),actor:actor.id,at:clock()};db.prepare('INSERT INTO store_schedule_days VALUES(?,?,?) ON CONFLICT(employee,day) DO UPDATE SET json=excluded.json').run(b.employee,b.day,JSON.stringify(r));}
  else{if(!Array.isArray(b.week)||b.week.length!==7)fail('Нужно заполнить семь дней');const week=b.week.map(validate);db.prepare('INSERT INTO store_schedules VALUES(?,?) ON CONFLICT(employee) DO UPDATE SET json=excluded.json').run(b.employee,JSON.stringify(week));}return {ok:true};
 }
 function view(employee,day){return {employee,week:JSON.parse(db.prepare('SELECT json FROM store_schedules WHERE employee=?').get(employee)?.json||'null'),days:Array.from({length:14},(_,i)=>forDay(employee,dayAdd(day,i)))};}
 return {forDay,forMoment,save,view};
}
