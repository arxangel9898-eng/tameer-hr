import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initTurnoverKpi} from '../turnover-kpi.mjs';

const month='2026-10',basis='2026-09',owner={id:'owner',admin:true},now=Date.parse('2026-11-04T05:00:00Z');
function report(m,net,fingerprint){const y=Number(m.slice(0,4)),n=Number(m.slice(5)),last=new Date(Date.UTC(y,n,0)).toISOString().slice(0,10);return {connected:true,currency:'UZS',organization:{id:'company-a',name:'Store'},lastError:'',report:{month:m,from:m+'-01 00:00:00',to:last+' 23:59:59',provisional:false,stale:false,currency:'UZS',organization:{id:'company-a'},sales:net>=0?net+10000:10000,returns:net>=0?10000:10000-net,revenue:net,rowsCount:10,status:'blocked',costIssueCount:267,gross:null,fingerprint:fingerprint.repeat(64),asOf:now-60000}};}
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE employees(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);
 CREATE TABLE pay_accounts(employee TEXT,month TEXT,base INTEGER,currency TEXT,PRIMARY KEY(employee,month));
 CREATE TABLE pay_entries(id TEXT PRIMARY KEY,employee TEXT,month TEXT,amount INTEGER);
 CREATE TABLE pay_kpi(id TEXT PRIMARY KEY,employee TEXT,month TEXT,actual INTEGER);
 CREATE TABLE role_reviews(employee TEXT,month TEXT,json TEXT,PRIMARY KEY(employee,month));
 CREATE TABLE role_kpi_snapshots(employee TEXT,month TEXT,json TEXT);
 CREATE TABLE hr_monthly_posts(employee TEXT,month TEXT,kind TEXT);
 INSERT INTO employees VALUES('director','Director Name','Директор',1),('seller','Seller Name','Продавец сантехники',1),('loader','Loader Name','Грузчик',1),('cashier','Cashier Name','Кассир',1),('universal','Universal Name','Универсальный сотрудник',1);
 INSERT INTO pay_accounts VALUES('director','2026-10',600000000,'UZS'),('seller','2026-10',300000000,'UZS'),('loader','2026-10',250000000,'UZS'),('universal','2026-10',310000001,'UZS');
 INSERT INTO pay_entries VALUES('existing-entry','seller','2026-10',123400);
 INSERT INTO pay_kpi VALUES('existing-kpi','seller','2026-10',77);`);
 const reports=new Map([[month,report(month,226329466498,'a')],[basis,report(basis,329261271936,'b')]]);let hook=null;
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status})};
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}};
 const api=initTurnoverKpi(db,{fail,transaction,clock:()=>now,reportForMonth:m=>{hook?.(m);return reports.get(m)}});
 const protectedState=()=>JSON.stringify(['employees','pay_accounts','pay_entries','pay_kpi','role_reviews','role_kpi_snapshots','hr_monthly_posts'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()));
 return {db,api,reports,protectedState,setHook:f=>hook=f,configure:body=>api.configure({month,basisMonth:basis,...body},owner)};
}

test('real net turnover produces an exact bounded proposal and role-based ceilings without touching payroll',t=>{
 const f=fixture();t.after(()=>f.db.close());const before=f.protectedState(),v=f.configure({version:0});
 assert.equal(v.score,68.74);assert.equal(v.rawIndex,68.74);assert.equal(v.source.currentNet,226329466498);assert.equal(v.source.basisNet,329261271936);assert.equal(v.source.asOf,now-60000);
 const caps=Object.fromEntries(v.rows.map(r=>[r.employee,r.maximum]));assert.deepEqual(caps,{cashier:50000000,director:150000000,loader:25000000,seller:60000000,universal:45000000});
 for(const row of v.rows){assert.equal(row.minimum,0);assert.equal(row.proposal,Number(BigInt(row.maximum)*226329466498n/329261271936n));assert.equal(row.posted,false);assert.equal(row.payoutReady,false);}
 assert.equal(v.rows.find(r=>r.employee==='cashier').capBasis,'role-benchmark');assert.equal(v.rows.find(r=>r.employee==='cashier').status,'requires-payroll-setup');assert.equal(v.rows.find(r=>r.employee==='cashier').accountConfigured,false);
 assert.equal(v.totals.maximum,330000000);assert.equal(v.totals.proposal,v.rows.reduce((n,r)=>n+r.proposal,0));assert.equal(f.protectedState(),before);assert.match(v.warnings.join(' '),/не является оценкой личных/);assert.match(v.warnings.join(' '),/себестоимости/);
});

test('percentage caps at 100 while raw index remains visible, with zero and negative turnover creating no deductions',t=>{
 for(const [net,score,raw] of [[400000000000,100,121.48],[0,0,0],[-10000,0,0]]){
  const f=fixture();t.after(()=>f.db.close());f.reports.set(month,report(month,net,'a'));const v=f.configure();assert.equal(v.score,score);assert.equal(v.rawIndex,raw);for(const row of v.rows){assert.ok(row.proposal>=0&&row.proposal<=row.maximum);if(net<=0)assert.equal(row.proposal,0);if(net>329261271936)assert.equal(row.proposal,row.maximum);}
 }
});

test('existing positive role limit and October role assignment are retained instead of using a different current role',t=>{
 const f=fixture();t.after(()=>f.db.close());f.db.prepare('INSERT INTO role_reviews VALUES(?,?,?)').run('seller',month,JSON.stringify({role:'category',maximum:123450000,actual:[null,null,null,null]}));
 const row=f.configure().rows.find(r=>r.employee==='seller');assert.equal(row.roleId,'category');assert.equal(row.role,'Категорийный менеджер');assert.equal(row.maximum,123450000);assert.equal(row.capBasis,'existing-role-limit');
});

test('read permissions gate the full company view while a personal projection contains no company sums or other people',t=>{
 const f=fixture();t.after(()=>f.db.close());f.configure();
 for(const actor of [{},{permissions:{}},{employee:'seller',permissions:{hr:'read'}},null])assert.throws(()=>f.api.view(month,actor),e=>e.status===403);
 for(const actor of [owner,{permissions:{finance:'read'}},{permissions:{payroll:'read'}}])assert.equal(f.api.view(month,actor).rows.length,5);
 const personal=f.api.personal('seller',month),encoded=JSON.stringify(personal);assert.equal(personal.month,month);assert.equal(personal.score,68.74);assert.ok(!encoded.includes('Director Name'));assert.ok(!encoded.includes('226329466498'));assert.ok(!encoded.includes('329261271936'));assert.equal(Object.hasOwn(personal,'employee'),false);assert.equal(Object.hasOwn(personal,'name'),false);assert.equal(Object.hasOwn(personal,'rows'),false);assert.equal(Object.hasOwn(personal,'source'),false);
 assert.equal(f.api.personal('missing',month),null);
});

test('requested month never falls back and latest personal explicitly identifies the older configured month',t=>{
 const f=fixture();t.after(()=>f.db.close());assert.equal(f.api.latestPersonal('seller'),null);assert.equal(f.api.view('2026-11',owner).latestMonth,null);f.configure();assert.equal(f.api.personal('seller','2026-11'),null);assert.equal(f.api.latestPersonal('seller').month,'2026-10');assert.equal(f.api.view('2026-11',owner).latestMonth,'2026-10');assert.equal(f.api.view('2026-11',owner).configured,false);assert.equal(f.api.latestPersonal('not-configured'),null);
});

test('version guard and repeat configure are idempotent; a refreshed source requires explicit recalculation',t=>{
 const f=fixture();t.after(()=>f.db.close());const first=f.configure();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM turnover_kpi_audit').get().n,1);
 assert.throws(()=>f.configure(),e=>e.status===409);assert.throws(()=>f.configure({version:0}),e=>e.status===409);assert.throws(()=>f.configure({version:'old-version'}),e=>e.status===409);
 const same=f.configure({version:first.version});assert.equal(same.duplicate,true);assert.equal(same.version,first.version);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM turnover_kpi_audit').get().n,1);
 f.reports.set(month,report(month,200000000000,'c'));let v=f.api.view(month,owner);assert.equal(v.status,'stale');assert.equal(v.score,null);assert.equal(v.totals.proposal,null);assert.equal(f.api.personal('seller',month).proposal,null);
 v=f.configure({version:first.version});assert.notEqual(v.version,first.version);assert.equal(v.status,'proposal');assert.equal(v.score,60.74);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM turnover_kpi_audit').get().n,2);
});

test('missing, stale, inconsistent or incomplete source cannot configure a proposal',t=>{
 const changes=[
  r=>{r.connected=false},r=>{r.lastError='source error'},r=>{r.currency='USD'},r=>{r.report.currency='USD'},r=>{r.report.stale=true},r=>{r.report.provisional=true},r=>{r.report.to='2026-10-30 23:59:59'},r=>{r.report.from='2026-10-02 00:00:00'},r=>{r.report.month='2026-09'},r=>{r.report.revenue+=1},r=>{r.report.sales=1.2},r=>{r.report.rowsCount=0},r=>{r.report.fingerprint='invalid'},r=>{r.report.asOf=null},r=>{r.report.organization.id='other'},
 ];
 for(const change of changes){const f=fixture();t.after(()=>f.db.close());change(f.reports.get(month));assert.throws(()=>f.configure(),e=>e.status===409);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM turnover_kpi_policies').get().n,0);}
 for(const basisNet of [0,-1]){const f=fixture();t.after(()=>f.db.close());f.reports.set(basis,report(basis,basisNet,'b'));assert.throws(()=>f.configure(),/базового месяца/);}
 const f=fixture();t.after(()=>f.db.close());const b=f.reports.get(basis);b.organization.id='other';b.report.organization.id='other';assert.throws(()=>f.configure(),/Организации/);
});

test('source problems after configuration retain personal bounds but do not invent a zero score or zero proposal',t=>{
 const f=fixture();t.after(()=>f.db.close());const before=f.configure().rows.find(r=>r.employee==='seller');f.reports.delete(basis);const v=f.api.personal('seller',month);assert.equal(v.status,'blocked');assert.equal(v.score,null);assert.equal(v.proposal,null);assert.equal(v.maximum,before.maximum);assert.equal(v.minimum,0);
});

test('configuration is limited to administrator and complete closed months with the immediately previous baseline',t=>{
 const f=fixture();t.after(()=>f.db.close());assert.throws(()=>f.api.configure({month,basisMonth:basis},{permissions:{finance:'write'}}),e=>e.status===403);assert.throws(()=>f.configure({month:'2026-11'}),/закрытый месяц/);assert.throws(()=>f.configure({basisMonth:'2026-08'}),/предыдущий/);assert.throws(()=>f.api.view('bad',owner),/месяц/);
});

test('frozen monthly results and unknown roles or account currencies require a separate review',t=>{
 for(const table of ['hr_monthly_posts','role_kpi_snapshots']){const f=fixture();t.after(()=>f.db.close());f.db.prepare('INSERT INTO '+table+' VALUES(?,?,?)').run('seller',month,'test');assert.throws(()=>f.configure(),/зафиксированы/);}
 const f=fixture();t.after(()=>f.db.close());f.db.prepare('UPDATE employees SET role=? WHERE id=?').run('Unknown role','seller');assert.throws(()=>f.configure(),/должность/);f.db.prepare('UPDATE employees SET role=? WHERE id=?').run('Продавец сантехники','seller');f.db.prepare('UPDATE pay_accounts SET currency=? WHERE employee=?').run('USD','seller');assert.throws(()=>f.configure(),/Валюта/);
});

test('concurrent source changes roll back configuration and audit atomically',t=>{
 const f=fixture();t.after(()=>f.db.close());let reads=0;f.setHook(()=>{reads++;if(reads===3)f.reports.get(month).report.fingerprint='c'.repeat(64)});assert.throws(()=>f.configure(),e=>e.status===409);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM turnover_kpi_policies').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM turnover_kpi_audit').get().n,0);
});

test('director and HR shares are redistributed exactly without increasing the team pool or changing payroll',t=>{
 const f=fixture();t.after(()=>f.db.close());f.db.prepare('INSERT INTO employees VALUES(?,?,?,1)').run('hr','HR Name','HR-Generalist');
 const before=f.protectedState(),initial=f.configure(),excluded=initial.rows.filter(r=>['director','hr-generalist'].includes(r.roleId)),next=f.configure({version:initial.version,excludedRoles:['director','hr-generalist']});
 assert.equal(next.rows.length,6);assert.deepEqual(next.excludedRoles,['director','hr-generalist']);assert.equal(next.redistribution.participants,4);assert.equal(next.redistribution.excludedCount,2);
 assert.deepEqual(next.totals,initial.totals);assert.equal(next.redistribution.freedProposal,excluded.reduce((n,r)=>n+r.proposal,0));assert.equal(next.redistribution.freedMaximum,excluded.reduce((n,r)=>n+r.maximum,0));
 for(const row of next.rows){const old=initial.rows.find(r=>r.employee===row.employee);if(row.excluded){assert.equal(row.status,'excluded');assert.equal(row.score,null);assert.equal(row.proposal,0);assert.equal(row.maximum,0);assert.equal(f.api.latestPersonal(row.employee).status,'excluded');}else{assert.equal(row.proposal,old.proposal+row.redistribution.addedProposal);assert.equal(row.maximum,old.maximum+row.redistribution.addedMaximum);assert.ok(row.proposal<=row.maximum);}}
 const same=f.configure({version:next.version});assert.equal(same.duplicate,true);assert.deepEqual(same.totals,initial.totals);assert.deepEqual(same.rows,next.rows);assert.equal(f.protectedState(),before);
 const own=JSON.stringify(f.api.personal('seller',month));assert.ok(!own.includes('HR Name'));assert.ok(!own.includes('freedProposal'));assert.ok(!own.includes('226329466498'));
});

test('largest remainders allocate the final minor unit deterministically and can reverse exclusions',t=>{
 const f=fixture();t.after(()=>f.db.close());f.reports.set(month,report(month,329261271936,'a'));
 for(const e of f.db.prepare('SELECT id,role FROM employees').all()){const role={director:'director',seller:'plumbing',loader:'loader',cashier:'cashier',universal:'universal'}[e.id];f.db.prepare('INSERT INTO role_reviews VALUES(?,?,?)').run(e.id,month,JSON.stringify({role,maximum:1,actual:[null,null,null,null]}));}
 const v=f.configure({excludedRoles:['director']});assert.equal(v.totals.proposal,5);assert.equal(v.rows.find(r=>r.employee==='cashier').proposal,2);assert.equal(v.rows.find(r=>r.employee==='loader').proposal,1);
 const raw=JSON.parse(f.db.prepare('SELECT json FROM turnover_kpi_policies').get().json);assert.ok(raw.caps.every(c=>c.maximum===1));
 const restored=f.configure({version:v.version,excludedRoles:[]});assert.ok(restored.rows.every(r=>r.proposal===1&&!r.excluded));assert.equal(restored.totals.proposal,5);
});

test('redistribution keeps exclusions explicit while missing or changed sources block remaining proposals',t=>{
 const f=fixture();t.after(()=>f.db.close());const first=f.configure({excludedRoles:['director']});
 f.reports.set(month,report(month,200000000000,'c'));let v=f.api.view(month,owner);assert.equal(v.status,'stale');assert.equal(v.totals.proposal,null);assert.equal(f.api.personal('director',month).proposal,0);assert.equal(f.api.personal('director',month).score,null);assert.equal(f.api.personal('seller',month).proposal,null);
 v=f.configure({version:first.version});assert.deepEqual(v.excludedRoles,['director']);assert.equal(v.totals.maximum,first.totals.maximum);
 f.reports.set(month,report(month,0,'d'));v=f.configure({version:v.version});assert.equal(v.totals.proposal,0);assert.ok(v.rows.every(r=>r.proposal===0));assert.equal(v.rows.find(r=>r.employee==='director').score,null);
});

test('exclusions reject unknown, duplicate or all participating roles and require administrator',t=>{
 const f=fixture();t.after(()=>f.db.close());for(const excludedRoles of [['bad'],['director','director'],'director',['director','plumbing','loader','cashier','universal']])assert.throws(()=>f.configure({excludedRoles}));
 assert.throws(()=>f.api.configure({month,excludedRoles:['director']},{permissions:{finance:'write'}}),e=>e.status===403);
 assert.equal(f.db.prepare('SELECT count(*) n FROM turnover_kpi_policies').get().n,0);
});

test('explicit current-profile recalculation rebases caps on the new role and October base, preserving historical role reviews',t=>{
 const f=fixture();t.after(()=>f.db.close());f.db.prepare('INSERT INTO role_reviews VALUES(?,?,?)').run('seller',month,JSON.stringify({role:'plumbing',maximum:90000000,actual:[null,null,null,null]}));
 const legacy=f.configure();assert.equal(legacy.rows.find(r=>r.employee==='seller').maximum,90000000);
 f.db.prepare('UPDATE employees SET role=? WHERE id=?').run('Chief Operating Officer (COO)','seller');const before=f.protectedState(),current=f.configure({version:legacy.version,roleSource:'current-profile'}),r=current.rows.find(r=>r.employee==='seller');
 assert.equal(current.roleSource,'current-profile');assert.equal(r.roleId,'coo');assert.equal(r.role,'Chief Operating Officer (COO)');assert.equal(r.maximum,75000000);assert.equal(f.protectedState(),before);
 const again=f.configure({version:current.version});assert.equal(again.duplicate,true);assert.equal(again.roleSource,'current-profile');assert.deepEqual(again.rows,current.rows);
});

test('current CFO and CDO executive titles receive the explicit 25-percent cap and missing accounts receive a labelled benchmark',t=>{
 const f=fixture();t.after(()=>f.db.close());f.db.prepare('UPDATE employees SET role=? WHERE id=?').run('Financial Manager (CFO)','universal');f.db.prepare('UPDATE employees SET role=? WHERE id=?').run('Head of Process Automation (CDO)','seller');f.db.prepare('UPDATE employees SET role=? WHERE id=?').run('Financial Manager (CFO)','cashier');
 const v=f.configure({roleSource:'current-profile'});assert.equal(v.rows.find(r=>r.employee==='universal').maximum,75000000);assert.equal(v.rows.find(r=>r.employee==='seller').maximum,75000000);const missing=v.rows.find(r=>r.employee==='cashier');assert.equal(missing.maximum,125000000);assert.equal(missing.capBasis,'role-benchmark');assert.equal(missing.accountConfigured,false);
});

test('current CEO and HR are excluded by canonical role while former directors with a new role participate',t=>{
 const f=fixture();t.after(()=>f.db.close());f.db.prepare('UPDATE employees SET role=? WHERE id=?').run('Warehouse Operator','director');f.db.prepare('UPDATE employees SET role=? WHERE id=?').run('Chief Executive Officer (CEO)','seller');f.db.prepare('UPDATE employees SET role=? WHERE id=?').run('HR-Generalist','cashier');
 const v=f.configure({roleSource:'current-profile',excludedRoles:['director','hr-generalist']});assert.equal(v.rows.find(r=>r.employee==='director').excluded,undefined);assert.equal(v.rows.find(r=>r.employee==='director').roleId,'loader');for(const id of ['seller','cashier']){const r=v.rows.find(r=>r.employee===id);assert.equal(r.excluded,true);assert.equal(r.proposal,0);assert.equal(r.score,null);}assert.equal(v.redistribution.participants,3);
});

test('current-profile mode rejects unknown titles even if a valid old review exists, and validates the source choice',t=>{
 const f=fixture();t.after(()=>f.db.close());f.db.prepare('INSERT INTO role_reviews VALUES(?,?,?)').run('seller',month,JSON.stringify({role:'plumbing',maximum:1000000,actual:[null,null,null,null]}));f.db.prepare('UPDATE employees SET role=? WHERE id=?').run('Unconfigured English title','seller');
 assert.throws(()=>f.configure({roleSource:'current-profile'}),/должность/);assert.throws(()=>f.configure({roleSource:'whatever'}),/источник должностей/);assert.equal(f.db.prepare('SELECT count(*) n FROM turnover_kpi_policies').get().n,0);
});

test('current role changes during configuration abort the snapshot atomically',t=>{
 const f=fixture();t.after(()=>f.db.close());let reads=0;f.setHook(()=>{reads++;if(reads===3)f.db.prepare('UPDATE employees SET role=? WHERE id=?').run('Chief Operating Officer (COO)','seller');});assert.throws(()=>f.configure({roleSource:'current-profile'}),e=>e.status===409);assert.equal(f.db.prepare('SELECT count(*) n FROM turnover_kpi_policies').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM turnover_kpi_audit').get().n,0);
});
