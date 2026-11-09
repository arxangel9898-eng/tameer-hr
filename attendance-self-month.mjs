import {localDate,dayAdd,validDate} from './model.mjs';
export function attendanceSelfMonth(db,{schedule,storeOps,tz,clock=Date.now,fail},employee,month){
 if(typeof month!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))fail('Укажите месяц ГГГГ-ММ');
 const person=db.prepare('SELECT id,name,role FROM employees WHERE id=? AND active=1').get(employee);if(!person)fail('Сотрудник недоступен',403);
 const has=n=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n);
 const pendingDays=new Map();if(has('tg_attendance_requests')){const open=db.prepare("SELECT * FROM shifts WHERE employee=? AND NOT EXISTS(SELECT 1 FROM events e WHERE e.shift=shifts.id AND e.kind='out') ORDER BY created DESC LIMIT 1").get(employee);const list=has('tg_geofence_challenges')?db.prepare("SELECT r.at,q.kind FROM tg_attendance_requests r LEFT JOIN tg_geofence_challenges q ON q.group_id=r.group_id AND q.message_id=r.message_id WHERE r.employee=? AND r.status='pending'").all(employee):db.prepare("SELECT at FROM tg_attendance_requests WHERE employee=? AND status='pending'").all(employee);for(const r of list){const d=r.kind==='out'&&open&&open.created<=r.at?open.day:localDate(r.at,tz).date;pendingDays.set(d,(pendingDays.get(d)||0)+1);}}
 const rows=[];let day=month+'-01';const today=localDate(clock(),tz).date;
 while(validDate(day)&&day.startsWith(month)){
  const p=schedule.forDay(employee,day),s=db.prepare('SELECT * FROM shifts WHERE employee=? AND day=?').get(employee,day);
  const summary=s?storeOps.corrected(s,db.prepare('SELECT * FROM events WHERE shift=? ORDER BY at,id').all(s.id),clock()):null;
  const pending=pendingDays.get(day)||0;
  rows.push({day,off:!!p.off,plan:p.off?'':p.startTime+'–'+p.endTime,in:summary?.in??null,out:summary?.out??null,late:summary?.late||0,worked:summary?.worked||0,pending,status:summary?.status||(p.off?'Выходной':day>today?'План':'Нет отметки'),note:summary?.note||''});day=dayAdd(day,1);
 }
 return {employee:person,month,timezone:tz,rows,totals:{days:rows.filter(r=>r.in).length,closed:rows.filter(r=>r.out).length,late:rows.reduce((n,r)=>n+r.late,0),worked:rows.reduce((n,r)=>n+r.worked,0),pending:rows.reduce((n,r)=>n+r.pending,0)},note:'Опоздания показаны с учётом согласованных исправлений. Незакрытые смены имеют предварительное время работы.'};
}
