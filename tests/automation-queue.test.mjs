import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {automationCoverage,automationQueue} from '../automation-queue.mjs';
import {initHR} from '../hr.mjs';
import {zonedTime} from '../model.mjs';
import {initShiftSchedule} from '../shift-schedule.mjs';

const day='2026-11-03';
const month='2026-11';
const tz='Asia/Tashkent';
const now=zonedTime(day,'19:00',tz);
const center={features:{queue:{enabled:true,responsibleIds:['manager']},coverage:{enabled:true,responsibleIds:['manager']}}};

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE employees(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER,created INTEGER);
    INSERT INTO employees VALUES ('a','Алия','Кассир',1,0),('b','Бек','Кассир',1,0),('c','Вера','Кассир',1,0),
      ('d','Дина','Кассир',1,0),('other','Роман','Кассир',1,0),('manager','Руководитель','Директор',1,0);
    CREATE TABLE shifts(id TEXT PRIMARY KEY,employee TEXT,day TEXT,planned_start INTEGER,planned_end INTEGER);
    CREATE TABLE events(id INTEGER PRIMARY KEY,shift TEXT,kind TEXT,at INTEGER);
  `);
  const fail=message=>{throw Error(message)};
  const hr=initHR(db,{tz,fail});
  const schedule=initShiftSchedule(db,{settings:()=>({start:'09:00',end:'18:00'}),hr,fail,tz});
  const addLeave=(id,employee,start=day,end=start,status='approved')=>db.prepare(
    "INSERT INTO hr_leaves VALUES(?,?,'annual',?,?,?,'','',0)").run(id,employee,start,end,status);
  const addSubstitute=(leave,employee)=>db.prepare("INSERT INTO hr_leave_replacements VALUES(?,?,'manager',0)").run(leave,employee);
  return {db,schedule,addLeave,addSubstitute};
}

test('coverage excludes days off and detects double bookings, conflicting absences and other branches',t=>{
  const {db,schedule,addLeave,addSubstitute}=fixture();
  t.after(()=>db.close());
  schedule.save({employee:'a',day:'2026-11-04',off:true},{id:'manager'});
  addLeave('a-leave','a',day,'2026-11-04');
  addLeave('b-leave','b');
  addSubstitute('a-leave','c');
  addSubstitute('b-leave','c');
  const assignment=(kind,id)=>({branch:id==='other'?'other':'main'});
  const getCoverage=()=>automationCoverage(db,month,center,now,{schedule,assignment,tz});
  assert.equal(schedule.forDay('a',day).off,true);
  assert.equal(schedule.forDay('a',day,{ignoreLeave:true}).off,false);
  const rows=getCoverage();
  assert.equal(rows.length,2);
  assert.ok(rows.every(r=>r.date===day&&r.status==='conflict'));
  assert.match(rows[0].detail,/уже замещает/);
  assert.deepEqual(rows[0].candidates,[{id:'d',name:'Дина'}]);
  db.prepare("UPDATE hr_leaves SET status='cancelled' WHERE id='b-leave'").run();
  assert.equal(getCoverage()[0].status,'covered');
  addLeave('c-leave','c');
  assert.match(getCoverage().find(r=>r.leaveId==='a-leave').detail,/согласовано отсутствие/);
  assert.deepEqual(automationCoverage(db,month,{features:{coverage:{enabled:false}}},now),[]);
});

test('coverage recognizes split substitutions and advisory days off replacing a workday',t=>{
  const {db,schedule,addLeave,addSubstitute}=fixture();
  t.after(()=>db.close());
  const actor={id:'manager'};
  addLeave('leave','a');
  addSubstitute('leave','b');
  addSubstitute('leave','c');
  schedule.save({employee:'b',day,off:false,start:'09:00',end:'13:00'},actor);
  schedule.save({employee:'c',day,off:false,start:'13:00',end:'18:00'},actor);
  schedule.save({employee:'d',day,off:true},actor);
  schedule.save({employee:'other',week:Array.from({length:7},()=>({off:true}))},actor);
  schedule.save({employee:'other',day,off:true},actor);
  const getCoverage=()=>automationCoverage(db,month,center,now,{schedule,tz});
  assert.deepEqual(getCoverage().map(r=>[r.employeeId,r.kind,r.status]),[
    ['a','leave','covered'],['d','day-off','unassigned'],
  ]);
  assert.equal(getCoverage()[1].href,'/#storeops');
  schedule.save({employee:'c',day,off:false,start:'13:30',end:'18:00'},actor);
  assert.match(getCoverage()[0].detail,/только часть/);
});

test('queue reads shared records and removes cases when their underlying actions resolve',t=>{
  const {db,addLeave}=fixture();
  t.after(()=>db.close());
  db.exec(`
    CREATE TABLE shift_bot_requests(id TEXT,employee TEXT,kind TEXT,day TEXT,json TEXT,status TEXT,version INTEGER);
    CREATE TABLE store_corrections(id TEXT,employee TEXT,day TEXT,json TEXT,status TEXT);
    CREATE TABLE salary_disputes(id TEXT,employee TEXT,month TEXT,status TEXT,created INTEGER,version INTEGER);
    CREATE TABLE finance_approvals(id TEXT,status TEXT,json TEXT,created INTEGER,version INTEGER);
    INSERT INTO shift_bot_requests VALUES ('wrap','a','correction','${day}','{"correctionId":"fix"}','pending',2),
      ('close','b','unclosed','${day}','{"shift":"sb"}','pending',1);
    INSERT INTO store_corrections VALUES ('fix','a','${day}','{"kind":"in"}','pending');
  `);
  const plannedStart=zonedTime(day,'09:00',tz),plannedEnd=zonedTime(day,'18:00',tz);
  const addShift=db.prepare('INSERT INTO shifts VALUES(?,?,?,?,?)');
  addShift.run('sa','a',day,plannedStart,plannedEnd);
  addShift.run('sb','b',day,plannedStart,plannedEnd);
  addShift.run('sc','c',day,plannedStart,plannedEnd);
  db.prepare("INSERT INTO events VALUES(1,'sa','in',?),(2,'sb','in',?),(3,'sc','in',?)").run(plannedStart,plannedStart,plannedStart);
  addLeave('leave','a',day,day,'requested');
  db.prepare("INSERT INTO salary_disputes VALUES('pay','a',?,'open',?,1),('resolved','a',?,'resolved',?,2)").run(month,now,month,now);
  db.prepare("INSERT INTO finance_approvals VALUES('review','pending',?,?,1)").run(JSON.stringify({body:{month}}),now);
  const storeOps={corrected:shift=>shift.id==='sc'?{overtimePermission:{until:now+60000}}:{}};
  const getQueue=()=>automationQueue(db,month,center,now,{tz,storeOps});
  const rows=getQueue();
  assert.deepEqual(rows.map(r=>r.id),['finance-approval:review','leave:leave','salary-dispute:pay','shift-request:close','shift-request:wrap','unclosed:sa']);
  assert.ok(rows.every(r=>r.responsibleIds.includes('manager')));
  assert.equal(rows.find(r=>r.id==='shift-request:wrap').version,2);
  db.prepare("UPDATE store_corrections SET status='approved' WHERE id='fix'").run();
  db.prepare("INSERT INTO events VALUES(4,'sb','out',?)").run(now);
  assert.ok(getQueue().every(r=>!['shift-request:close','shift-request:wrap'].includes(r.id)));
  assert.deepEqual(automationQueue(db,month,{features:{queue:{enabled:false}}},now),[]);
});
