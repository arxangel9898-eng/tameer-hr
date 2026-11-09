import {dayAdd,localDate,validDate} from './model.mjs';
import {leaveTypes} from './hr.mjs';

const shiftTitles={
  late:'Разрешение на опоздание',
  overtime:'Разрешение на дополнительную работу',
  correction:'Исправление отметки',
  unclosed:'Незакрытая смена',
};
const inMonth=(day,month)=>typeof day==='string'&&day.startsWith(month+'-');
const hasTable=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const sourceRows=(db,table,sql,...params)=>hasTable(db,table)?db.prepare(sql).all(...params):[];

function covers(plan,intervals){
  let until=plan.start;
  for(const interval of intervals.sort((a,b)=>a.start-b.start)){
    if(interval.start>until)break;
    until=Math.max(until,interval.end);
    if(until>=plan.end)return true;
  }
  return false;
}

function monthRange(month){
  const first=month+'-01';
  if(!validDate(first))return null;
  const last=dayAdd(dayAdd(first,32).slice(0,7)+'-01',-1);
  return {first,last};
}

export function automationQueue(db,month,settings,now=Date.now(),{tz='Asia/Tashkent',storeOps}={}){
  const range=monthRange(month);
  if(!range||!settings?.features?.queue?.enabled)return [];
  const {first,last}=range;
  const employees=db.prepare('SELECT id,name,active FROM employees').all();
  const active=new Map(employees.filter(e=>e.active).map(e=>[e.id,e]));
  const names=new Map(employees.map(e=>[e.id,e.name]));
  const managers=new Map(sourceRows(db,'hr_profiles',"SELECT employee,manager FROM hr_profiles WHERE manager<>''").map(r=>[r.employee,r.manager]));
  const selected=settings.features.queue.responsibleIds||[];
  const davomat=sourceRows(db,'shift_bot_settings','SELECT json FROM shift_bot_settings WHERE id=1');
  const davomatIds=JSON.parse(davomat[0]?.json||'{}').responsibles||[];
  const pendingCorrections=sourceRows(db,'store_corrections',
    "SELECT id,employee,day,json FROM store_corrections WHERE status='pending' AND day BETWEEN ? AND ?",first,last);
  const correctionIds=new Set(pendingCorrections.map(r=>r.id));
  const wrappedCorrections=new Set();
  const overdueShifts=sourceRows(db,'shifts',`
    SELECT s.* FROM shifts s WHERE s.day BETWEEN ? AND ? AND s.planned_end<?
    AND EXISTS(SELECT 1 FROM events WHERE shift=s.id AND kind='in')
    AND NOT EXISTS(SELECT 1 FROM events WHERE shift=s.id AND kind='out')
  `,first,last,now);
  const closedShift=db.prepare("SELECT 1 FROM events WHERE shift=? AND kind='out' LIMIT 1");
  const closedDay=db.prepare("SELECT 1 FROM shifts s JOIN events e ON e.shift=s.id AND e.kind='out' WHERE s.employee=? AND s.day=? LIMIT 1");
  const unclosedRequests=new Set();
  const results=[];
  const details=(name,reason)=>[name,reason].filter(Boolean).join(' · ');
  const sourceOwner=id=>{
    const manager=managers.get(id);
    if(!manager)return null;
    if(active.has(manager))return manager;
    const matches=[...active.values()].filter(e=>e.name===manager);
    return matches.length===1?matches[0].id:null;
  };
  function add(kind,r,{title,detail,date=r.day,href,owner,sourceId=r.id,usesDavomat=false}){
    const validOwners=ids=>ids.filter(id=>active.has(id)&&id!==r.employee);
    const owners=validOwners(owner?[owner]:[]);
    const defaults=validOwners(selected);
    const responsibleIds=owners.length?owners:defaults.length?defaults:usesDavomat?validOwners(davomatIds):[];
    results.push({id:`${kind}:${r.id}`,sourceId,employeeId:r.employee||null,kind,title,detail,date,href,
      status:r.status||'pending',responsibleIds,...(r.version?{version:r.version}:{})});
  }
  for(const r of sourceRows(db,'shift_bot_requests',
    "SELECT id,employee,kind,day,json,status,version FROM shift_bot_requests WHERE status='pending' AND day BETWEEN ? AND ?",first,last)){
    if(!Object.hasOwn(shiftTitles,r.kind))continue;
    const request=JSON.parse(r.json);
    if(r.kind==='correction'){
      if(!correctionIds.has(request.correctionId))continue;
      wrappedCorrections.add(request.correctionId);
    }
    if(r.kind==='unclosed'){
      if(request.shift?closedShift.get(request.shift):closedDay.get(r.employee,r.day))continue;
      unclosedRequests.add(`${r.employee}:${r.day}`);
    }
    add('shift-request',r,{title:shiftTitles[r.kind],detail:details(names.get(r.employee),request.reason),href:'/#telegram',usesDavomat:true});
  }
  for(const r of sourceRows(db,'late_permission_reviews',
    "SELECT id,employee,day,json,status,version FROM late_permission_reviews WHERE status IN ('pending','blocked') AND day BETWEEN ? AND ?",first,last)){
    const request=JSON.parse(r.json);
    if(request.correctionId){
      if(r.status==='pending'&&!correctionIds.has(request.correctionId))continue;
      wrappedCorrections.add(request.correctionId);
    }
    add('late-credit',r,{title:'Проверка учётного прихода',detail:details(names.get(r.employee),request.error),href:'/#telegram',usesDavomat:true});
  }
  for(const r of pendingCorrections){
    if(wrappedCorrections.has(r.id))continue;
    add('correction',r,{title:'Исправление отметки',detail:details(names.get(r.employee),JSON.parse(r.json).reason),href:'/#storeops'});
  }
  for(const r of sourceRows(db,'early_exit_requests',`
    SELECT x.shift id,x.token,x.employee,x.responsible,x.status,s.day
    FROM early_exit_requests x JOIN shifts s ON s.id=x.shift
    WHERE x.status='pending' AND s.day BETWEEN ? AND ?
  `,first,last)){
    add('early-exit',r,{title:'Разрешение на ранний уход',detail:names.get(r.employee),href:'/#telegram',sourceId:r.token,owner:r.responsible});
  }
  const shiftEvents=db.prepare('SELECT * FROM events WHERE shift=? ORDER BY at,id');
  for(const r of overdueShifts){
    if(unclosedRequests.has(`${r.employee}:${r.day}`))continue;
    const summary=storeOps?.corrected(r,shiftEvents.all(r.id),now);
    const plannedEnd=Math.max(r.planned_end,summary?.overtimePermission?.until||0);
    if(summary?.out||now<=plannedEnd)continue;
    add('unclosed',r,{title:'Нет отметки ухода',detail:details(names.get(r.employee),'Срок смены прошёл, требуется проверка'),href:'/#attendance',usesDavomat:true});
  }
  for(const r of sourceRows(db,'hr_leaves',
    "SELECT id,employee,kind,start,end,status FROM hr_leaves WHERE status='requested' AND start<=? AND end>=?",last,first)){
    add('leave',{...r,status:'pending'},{title:leaveTypes[r.kind]||'Согласование отсутствия',
      detail:details(names.get(r.employee),`${r.start} — ${r.end}`),date:r.start,href:'/#hr',owner:sourceOwner(r.employee)});
  }
  for(const r of sourceRows(db,'hr_requests',"SELECT id,employee,kind,status,created FROM hr_requests WHERE status='pending'")){
    const date=localDate(r.created,tz).date;
    if(!inMonth(date,month))continue;
    const title=({leave:'Обращение об отпуске',advance:'Заявка на аванс'})[r.kind]||'Обращение сотрудника';
    add('hr-request',r,{title,detail:names.get(r.employee),date,href:'/#hrcenter',owner:sourceOwner(r.employee)});
  }
  for(const r of sourceRows(db,'salary_disputes',
    "SELECT id,employee,status,created,version FROM salary_disputes WHERE month=? AND status IN ('open','reviewing')",month)){
    add('salary-dispute',r,{title:'Вопрос по зарплате',detail:details(names.get(r.employee),month),
      date:localDate(r.created,tz).date,href:'/#payroll'});
  }
  for(const r of sourceRows(db,'finance_approvals',"SELECT id,status,json,created,version FROM finance_approvals WHERE status='pending'")){
    const {body}=JSON.parse(r.json);
    const date=localDate(r.created,tz).date;
    const period=body?.month||body?.payload?.month;
    if(period?period!==month:!inMonth(date,month))continue;
    add('finance-approval',r,{title:'Финансовое согласование',detail:'Ожидает решения второго ответственного',date,href:'/#network'});
  }
  return results.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
}

export function automationCoverage(db,month,settings,_now,{schedule,assignment,tz='Asia/Tashkent'}={}){
  const range=monthRange(month);
  if(!range||!settings?.features?.coverage?.enabled)return [];
  const {first,last}=range;
  const start=dayAdd(first,-1),end=dayAdd(last,1);
  const employees=db.prepare(`
    SELECT e.id,e.name,e.role,e.active,coalesce(p.department,'') department
    FROM employees e LEFT JOIN hr_profiles p ON p.employee=e.id ORDER BY e.name
  `).all();
  const byId=new Map(employees.map(e=>[e.id,e]));
  const leaves=db.prepare(`
    SELECT l.id,l.employee,l.start,l.end,r.employee substitute
    FROM hr_leaves l LEFT JOIN hr_leave_replacements r ON r.leave_id=l.id
    WHERE l.status='approved' AND l.start<=? AND l.end>=?
    ORDER BY l.start,l.id,r.rowid
  `).all(end,start);
  const leaveById=new Map();
  for(const row of leaves){
    if(!leaveById.has(row.id))leaveById.set(row.id,{...row,substituteIds:[]});
    if(row.substitute)leaveById.get(row.id).substituteIds.push(row.substitute);
  }
  const absence=db.prepare("SELECT 1 FROM hr_leaves WHERE employee=? AND status='approved' AND start<=? AND end>=? LIMIT 1");
  for(const {employee,day} of sourceRows(db,'store_schedule_days',`
    SELECT employee,day FROM store_schedule_days WHERE day BETWEEN ? AND ? AND json_extract(json,'$.off')=1
  `,first,last)){
    if(absence.get(employee,day,day))continue;
    const id=`day-off:${employee}:${day}`;
    leaveById.set(id,{id,employee,start:day,end:day,kind:'day-off',substituteIds:[]});
  }
  const cache=new Map();
  function shift(id,day,ignoreLeave=false,ignoreDayOverride=false){
    const key=JSON.stringify([id,day,ignoreLeave,ignoreDayOverride]);
    if(!cache.has(key))cache.set(key,schedule.forDay(id,day,{ignoreLeave,ignoreDayOverride}));
    return cache.get(key);
  }
  const rows=[];
  const commitments=new Map();
  for(const leave of leaveById.values()){
    const employee=byId.get(leave.employee);
    if(!employee?.active)continue;
    for(let day=leave.start>start?leave.start:start;day<=leave.end&&day<=end;day=dayAdd(day,1)){
      const plan=shift(leave.employee,day,true,leave.kind==='day-off');
      if(plan.off&&!plan.conflict)continue;
      const row={leave,employee,day,plan,endDay:plan.conflict?day:localDate(plan.end-1,tz).date};
      rows.push(row);
      for(const id of leave.substituteIds){
        if(!commitments.has(id))commitments.set(id,[]);
        commitments.get(id).push(row);
      }
    }
  }
  const branch=(id,day)=>assignment?.('employee',id,day)?.branch;
  function availability(id,row){
    const {leave,employee,day,plan,endDay}=row;
    const unavailable=issue=>({issue,intervals:[]});
    if(!byId.get(id)?.active)return unavailable('сотрудник в архиве');
    const branchId=branch(employee.id,day);
    if(branch(id,day)!==branchId)return unavailable('другой филиал');
    if(absence.get(id,endDay,day))return unavailable('согласовано отсутствие');
    const scheduleDays=[dayAdd(day,-1),day,...(endDay!==day?[endDay]:[])];
    const intervals=scheduleDays.filter(date=>branch(id,date)===branchId).map(date=>shift(id,date))
      .filter(p=>!p.off&&p.start<plan.end&&p.end>plan.start);
    if(!intervals.length)return unavailable('нет работы по графику в это время');
    const overlaps=commitments.get(id)?.some(other=>other.leave.id!==leave.id&&
      other.plan.start<plan.end&&other.plan.end>plan.start);
    if(overlaps)return unavailable('уже замещает другого сотрудника в это время');
    return {issue:'',intervals};
  }
  const departmentKey=employee=>employee.department.trim().toLowerCase();
  return rows.filter(r=>inMonth(r.day,month)).map(row=>{
    const {leave,employee,day,plan}=row;
    const dayOff=leave.kind==='day-off';
    const department=departmentKey(employee);
    const substitutes=leave.substituteIds.map(id=>byId.get(id)?.name||'Сотрудник недоступен');
    const available=plan.conflict?[]:leave.substituteIds.map(id=>availability(id,row));
    const intervals=available.flatMap(x=>x.intervals);
    const conflicts=plan.conflict?['В графике отсутствующего несколько планов на эту дату']:
      available.flatMap(({issue},i)=>issue?[`${substitutes[i]}: ${issue}`]:[]);
    if(!conflicts.length&&substitutes.length&&!covers(plan,intervals))conflicts.push('Замещающие по графику покрывают только часть смены');
    const status=conflicts.length?'conflict':substitutes.length?'covered':'unassigned';
    const candidates=status==='covered'||plan.conflict?[]:employees.filter(e=>e.active&&e.id!==employee.id&&
      !leave.substituteIds.includes(e.id)&&
      (department&&departmentKey(e)?departmentKey(e)===department:e.role===employee.role)&&
      covers(plan,[...intervals,...availability(e.id,row).intervals]))
      .map(({id,name})=>({id,name}));
    const detail=conflicts.join(' · ')||(status==='covered'?'Назначенные сотрудники покрывают смену':
      dayOff?'Выходной вместо рабочей смены. Проверьте график отдела':'Замена не назначена');
    return {id:dayOff?leave.id:`${leave.id}:${day}`,leaveId:dayOff?null:leave.id,kind:dayOff?'day-off':'leave',
      date:day,employeeId:employee.id,employeeName:employee.name,department:employee.department||employee.role,
      status,substitutes,candidates,href:dayOff?'\/#storeops':'\/#hr',detail};
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.employeeName.localeCompare(b.employeeName,'ru'));
}
