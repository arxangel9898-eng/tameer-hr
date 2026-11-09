import {localDate,validDate,dayAdd} from './model.mjs';
import {periodAttendanceXlsx} from './attendance-excel.mjs';

export function initPeriodAttendanceReports(db,{reports,accounts,fail,tz='Asia/Tashkent',clock=Date.now}){
 function report({from,to,employee}={},actor){
  if(!accounts.can(actor,'reports'))fail('Администратор должен открыть доступ к отчётам',403);
  const today=localDate(clock(),tz).date;
  if(!validDate(from||'')||!validDate(to||'')||from>to||from>today)fail('Укажите существующие даты начала и окончания периода');
  const days=Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000)+1;
  if(days>366)fail('Выберите период не более 366 дней');
  if(employee!==undefined&&(typeof employee!=='string'||!employee||!db.prepare('SELECT id FROM employees WHERE id=?').get(employee)))fail('Сотрудник не найден',404);
  const through=to>today?today:to,rows=[],totals=new Map();
  for(let day=from;day<=through;day=dayAdd(day,1)){
   for(const r of reports.report(day).rows){
    if(employee&&r.employee!==employee)continue;
    if(rows.length>=50000)fail('Слишком большой отчёт. Сократите период или выберите сотрудника');
    const earlyArrival=r.in!=null&&r.plannedStart!=null?Math.max(0,Math.floor((r.plannedStart-r.in)/60000)):null;
    const lateDeparture=r.out!=null&&r.plannedEnd!=null?Math.max(0,Math.floor((r.out-r.plannedEnd)/60000)):null;
    const row={...r,day,earlyArrival,lateDeparture};rows.push(row);
    let t=totals.get(r.employee);if(!t){t={employee:r.employee,name:r.name,role:r.role,days:0,scheduled:0,arrived:0,closed:0,missing:0,off:0,open:0,worked:0,breaks:0,late:0,early:0,earlyArrival:0,lateDeparture:0};totals.set(r.employee,t);}
    t.days++;if(!r.off)t.scheduled++;if(r.in!=null)t.arrived++;if(r.out!=null)t.closed++;if(r.off)t.off++;else if(r.in==null)t.missing++;if(r.in!=null&&r.out==null)t.open++;
    for(const k of ['worked','breaks','late','early','earlyArrival','lateDeparture'])t[k]+=Number.isFinite(row[k])?row[k]:0;
   }
  }
  const person=employee&&db.prepare('SELECT name,role FROM employees WHERE id=?').get(employee);
  if(person&&!totals.size)totals.set(employee,{employee,name:person.name,role:person.role,days:0,scheduled:0,arrived:0,closed:0,missing:0,off:0,open:0,worked:0,breaks:0,late:0,early:0,earlyArrival:0,lateDeparture:0});
  return {from,to,through,employee:employee||null,name:person?.name||'Все сотрудники',generated:clock(),timezone:tz,rows,totals:[...totals.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'))};
 }
 function download(query,actor){const r=report(query,actor);return {bytes:periodAttendanceXlsx(r),filename:`TAMEER-attendance-${r.employee?'employee':'all'}-${r.from}_${r.to}.xlsx`};}
 return {report,download};
}
