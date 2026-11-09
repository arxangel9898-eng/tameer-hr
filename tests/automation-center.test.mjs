import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initAutomationCenter} from '../automation-center.mjs';

const owner={id:'owner',admin:true};
const month='2026-11';
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE employees(id TEXT,name TEXT,role TEXT,active INTEGER);
  INSERT INTO employees VALUES('e','Employee','Cashier',1),('inactive','Inactive','Cashier',0);
  CREATE TABLE pay_entries(id TEXT,employee TEXT,month TEXT,kind TEXT,date TEXT,created INTEGER,amount INTEGER,voided_at INTEGER);
  CREATE TABLE pay_entry_approvers(entry TEXT);
  CREATE TABLE web_accounts(employee TEXT,status TEXT,admin INTEGER);`);
 let now=Date.parse('2026-11-07T05:05:00Z'), sendResult;
 const calls=[];
 const bot=name=>({
  status:()=>({connected:true,username:name,lastSeen:now,lastError:'',token:'secret'}),
  async notifyCenter(...args){calls.push([name,...args]);return sendResult||{delivered:true};},
 });
 const api=initAutomationCenter(db,{clock:()=>now,transaction:fn=>fn(),fail:(m,status=400)=>{throw Object.assign(Error(m),{status});},tz:'Asia/Tashkent',publicURL:'https://tameer.example',
  attendance:bot('attendance'),telegram:bot('salary'),
  payroll:{statement:()=>({account:{currency:'UZS'},totals:{bonus:11000,kpi:100,advance:150000,remaining:2000000}})},
  reports:{view:()=>({connected:true,report:{asOf:now},canSync:true}),sync:async({month})=>{calls.push(['sync',month]);return {ok:true};}},
  advances:()=>({lastSync:now,lastError:''}),
  build:()=>({kpi:{summary:{attention:1}},readiness:{summary:{attention:1}},queue:[{id:'q',date:month+'-07',responsibleIds:['e'],href:'/#storeops'}],coverage:[{date:month+'-07',status:'unassigned'}]}),
 });
 return {db,api,calls,now:()=>now,tick:n=>now+=n,result:r=>sendResult=r,settings:()=>api.view(month,owner).settings};
}

test('settings are admin-only, versioned and validate active assignees, channel and time',async t=>{
 const f=fixture(t),s=f.settings();
 assert.equal(Object.values(s.events).every(e=>!e.enabled),true);
 assert.throws(()=>f.api.view(month,{}),e=>e.status===403);
 assert.throws(()=>f.api.configure(s,{}),e=>e.status===403);
 assert.throws(()=>f.api.view('2026-00',owner),e=>e.status===400);
 const bad=structuredClone(s);bad.events.payrollPublished.channel='group';
 assert.throws(()=>f.api.configure(bad,owner),e=>e.status===400);
 bad.events.payrollPublished.channel='private';bad.features.queue.responsibleIds=['inactive'];
 assert.throws(()=>f.api.configure(bad,owner),e=>e.status===400);
 f.api.configure(s,owner);
 assert.throws(()=>f.api.configure(s,owner),e=>e.status===409);
 await f.api.scan();assert.deepEqual(f.calls,[]);
 assert.ok(!JSON.stringify(f.api.view(month,owner)).includes('secret'));
});

test('both bots dispatch only chosen events once; payouts are private, confirmed and post-activation',async t=>{
 const f=fixture(t),s=f.settings();
 s.features.queue.responsibleIds=['e'];
 Object.assign(s.events.queueReview,{enabled:true});
 Object.assign(s.events.coverageReview,{enabled:true,channel:'group'});
 Object.assign(s.events.payrollPublished,{enabled:true,time:'10:00'});
 Object.assign(s.events.salesSync,{enabled:true});
 f.api.configure(s,owner);
 const entry=f.db.prepare("INSERT INTO pay_entries VALUES(?,'e','2026-10','payout','2026-11-07',?,123456,?)");
 entry.run('old',f.now()-1,null);entry.run('new',f.now()+1,null);entry.run('unsigned',f.now()+1,null);entry.run('voided',f.now()+1,1);
 f.db.exec("INSERT INTO pay_entry_approvers VALUES('old'),('new'),('voided')");
 f.tick(2);await f.api.scan();await f.api.scan();
 assert.deepEqual(f.calls.slice(0,2),[['sync','2026-10'],['sync','2026-11']]);
 const salary=f.calls.filter(c=>c[0]==='salary'),attendance=f.calls.filter(c=>c[0]==='attendance');
 assert.equal(salary.length,1);assert.equal(salary[0][1],'e');assert.match(salary[0][2],/1\s234,56 UZS/);assert.match(salary[0][3],/\/employee$/);
 assert.equal(attendance.length,2);assert.ok(attendance.some(c=>c[1]==='e'&&c[3].endsWith('#storeops')));
 assert.ok(attendance.some(c=>c[1]===''&&c[3]===null&&c[5].group===true));
});

test('only confirmed failed deliveries can be retried and paused features stop the dispatcher',async t=>{
 const f=fixture(t),s=f.settings();
 s.features.queue.responsibleIds=['e'];s.events.queueReview.enabled=true;
 f.api.configure(s,owner);f.result({delivered:false,reason:'Telegram rejected'});
 await f.api.scan();await f.api.scan();assert.equal(f.calls.length,1);
 const failed=f.api.view(month,owner).bots.deliveries[0];
 assert.equal(failed.status,'failed');
 f.api.retry({id:failed.id},owner);f.result({delivered:false,uncertain:true});await f.api.scan();
 assert.equal(f.api.view(month,owner).bots.deliveries[0].status,'uncertain');
 assert.throws(()=>f.api.retry({id:failed.id},owner),e=>e.status===409);
 const paused=f.settings();paused.features.queue.enabled=false;f.api.configure(paused,owner);
 f.tick(86400000);await f.api.scan();assert.equal(f.calls.length,2);
});
