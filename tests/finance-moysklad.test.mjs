import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initFinanceMoysklad} from '../finance-moysklad.mjs';
import {zonedTime} from '../model.mjs';
const uid=n=>n.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111',owner={id:'owner',admin:true},reader={id:'fin-reader',permissions:{finance:'read'}},writer={id:'fin-writer',permissions:{finance:'write'}},month='2026-11';
const row=(id=1,extra={})=>({assortment:{meta:{href:'https://api.moysklad.ru/api/remap/1.2/entity/product/'+uid(id),type:'product'}},sellSum:10000,returnSum:1000,sellCostSum:7000,returnCostSum:700,sellQuantity:1,returnQuantity:0.1,profit:2700,...extra});
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE pay_accounts(employee TEXT,base INTEGER);INSERT INTO pay_accounts VALUES('worker',300000000);CREATE TABLE pay_entries(id TEXT,amount INTEGER);INSERT INTO pay_entries VALUES('advance',50000000);CREATE TABLE finance_periods(month TEXT,json TEXT);INSERT INTO finance_periods VALUES('2026-11','{}')");
 let now=zonedTime('2026-11-02','21:45','Asia/Tashkent'),status={connected:true,account:uid(9000),generation:1,scopeVersion:3,organization:{id:uid(9001),name:'TAMEER'}},items=[row()],currency={rows:[{default:true,isoCode:'UZS',code:'860'}],meta:{size:1}},gate=null,error=null,mutate=null;
 const calls=[],fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})},transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}},moysklad={analyticsStatus:()=>structuredClone(status),analyticsRead:async(path,params)=>{calls.push({path,params});if(gate)await gate(path,params);if(error)throw error;if(path==='entity/currency')return structuredClone(currency);const result={meta:{size:items.length,offset:params.offset},rows:items.slice(params.offset,params.offset+params.limit)};if(mutate)mutate(result,params);return structuredClone(result);}},api=initFinanceMoysklad(db,{moysklad,fail,transaction,tz:'Asia/Tashkent',clock:()=>now});
 const protectedState=()=>JSON.stringify(['pay_accounts','pay_entries','finance_periods'].map(t=>db.prepare('SELECT * FROM '+t).all()));
 return {db,api,calls,protectedState,setRows:v=>{items=v},setCurrency:v=>{currency=v},setStatus:v=>{status={...status,...v}},setGate:v=>{gate=v},setError:v=>{error=v},setMutate:v=>{mutate=v},setNow:v=>{now=v}};
}
test('all profit pages aggregate once with returns, document dates and organization scope; payroll and manual finance remain untouched',async t=>{
 const f=fixture();t.after(()=>f.db.close());f.setRows(Array.from({length:101},(_,i)=>row(i+1)));const before=f.protectedState(),v=await f.api.sync({month},owner);
 assert.equal(v.report.rowsCount,101);assert.equal(v.report.sales,1010000);assert.equal(v.report.returns,101000);assert.equal(v.report.revenue,909000);assert.equal(v.report.cost,636300);assert.equal(v.report.gross,272700);assert.equal(v.report.margin,30);assert.equal(v.report.currency,'UZS');assert.equal(v.report.provisional,true);assert.equal(v.report.status,'ready');assert.equal(v.running,false);
 const reports=f.calls.filter(c=>c.path==='report/profit/byproduct');assert.deepEqual(reports.map(c=>c.params.offset),[0,100]);assert.equal(reports[0].params.momentFrom,'2026-11-01 00:00:00');assert.equal(reports[0].params.momentTo,'2026-11-02 21:45:00');assert.equal(reports[0].params.filter,'organization=https://api.moysklad.ru/api/remap/1.2/entity/organization/'+uid(9001));assert.equal(f.protectedState(),before);
});
test('cached GET makes no API calls or writes; finance reader cannot sync and employee cannot view',async t=>{
 const f=fixture();t.after(()=>f.db.close());assert.equal(f.api.view(month,reader).report,null);assert.equal(f.calls.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_moysklad_audit').get().n,0);
 await assert.rejects(f.api.sync({month},reader),e=>e.status===403);assert.throws(()=>f.api.view(month,{permissions:{payroll:'write'}}),e=>e.status===403);assert.throws(()=>f.api.view('2026-99',owner));await f.api.sync({month},writer);const calls=f.calls.length,a=f.api.view(month,reader),b=f.api.view(month,reader);assert.deepEqual(a,b);assert.equal(a.canSync,false);assert.equal(f.calls.length,calls);assert.ok(!JSON.stringify(a).includes(uid(9000)));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_moysklad_audit').get().n,1);
});
test('unsupported or ambiguous currency never replaces a proven UZS snapshot and source errors mark it stale',async t=>{
 const f=fixture();t.after(()=>f.db.close());await f.api.sync({month},owner);const old=f.api.view(month,owner).report.fingerprint;
 f.setCurrency({rows:[{default:true,isoCode:'USD',code:'840'}],meta:{size:1}});await assert.rejects(f.api.sync({month},owner),/должна быть UZS/);let v=f.api.view(month,owner);assert.equal(v.report.fingerprint,old);assert.equal(v.report.stale,true);assert.match(v.lastError,/валюта/);
 f.setCurrency({rows:[{default:true,isoCode:'UZS'},{default:true,isoCode:'UZS'}],meta:{size:2}});await assert.rejects(f.api.sync({month},owner),/не определена однозначно/);
});
test('missing or zero goods cost blocks gross profit; genuinely zero-cost services and signed net returns remain valid',async t=>{
 const f=fixture();t.after(()=>f.db.close());f.setRows([row(1,{sellCostSum:0,returnCostSum:0,profit:9000})]);let v=await f.api.sync({month},owner);assert.equal(v.report.cost,null);assert.equal(v.report.gross,null);assert.equal(v.report.status,'blocked');assert.equal(v.report.revenue,9000);assert.match(v.warnings.join(' '),/FIFO/);
 const service={meta:{href:'https://api.moysklad.ru/api/remap/1.2/entity/service/'+uid(2),type:'service'}};f.setRows([row(2,{assortment:service,sellCostSum:0,returnCostSum:0,profit:9000})]);v=await f.api.sync({month},owner);assert.equal(v.report.gross,9000);assert.equal(v.report.status,'ready');
 f.setRows([row(3,{sellSum:0,sellQuantity:0,returnSum:1000,sellCostSum:0,returnCostSum:700,profit:-300})]);v=await f.api.sync({month},owner);assert.equal(v.report.revenue,-1000);assert.equal(v.report.cost,-700);assert.equal(v.report.gross,-300);assert.equal(v.report.margin,null);
 f.setRows([row(4,{sellCostSum:null})]);v=await f.api.sync({month},owner);assert.equal(v.report.gross,null);
});
test('reported profit reconciliation mismatch blocks the estimate and fractional API amounts round after aggregation',async t=>{
 const f=fixture();t.after(()=>f.db.close());f.setRows([row(1,{profit:2600})]);let v=await f.api.sync({month},owner);assert.equal(v.report.reconciliationDifference,-100);assert.equal(v.report.gross,null);assert.equal(v.report.status,'blocked');assert.match(v.warnings.join(' '),/комиссий/);
 f.setRows([row(1,{sellSum:100.4,returnSum:0,returnQuantity:0,sellCostSum:70.2,returnCostSum:0,profit:30.2}),row(2,{sellSum:100.4,returnSum:0,returnQuantity:0,sellCostSum:70.2,returnCostSum:0,profit:30.2})]);v=await f.api.sync({month},owner);assert.equal(v.report.sales,201);assert.equal(v.report.cost,140);assert.equal(v.report.gross,61);assert.equal(v.report.status,'ready');assert.match(v.warnings.join(' '),/округлён один раз/);
});
test('duplicate pages, unstable total and incomplete responses fail closed without overwriting a good snapshot',async t=>{
 const f=fixture();t.after(()=>f.db.close());await f.api.sync({month},owner);const old=f.api.view(month,owner).report.fingerprint;
 f.setRows([row(1),row(1)]);await assert.rejects(f.api.sync({month},owner),/повторные/);assert.equal(f.api.view(month,owner).report.fingerprint,old);
 f.setRows([row(2,{assortment:{meta:{href:'https://api.moysklad.ru/api/remap/1.2/entity/product/'+uid(2)+'?expand=owner',type:'product'}}})]);await assert.rejects(f.api.sync({month},owner),/неизвестные строки/);assert.equal(f.api.view(month,owner).report.fingerprint,old);
 f.setRows(Array.from({length:101},(_,i)=>row(i+1)));f.setMutate((data,p)=>{if(p.offset)data.meta.size++});await assert.rejects(f.api.sync({month},owner),e=>e.status===409);assert.equal(f.api.view(month,owner).report.fingerprint,old);
 f.setMutate(data=>{data.meta.size=200;data.rows=data.rows.slice(0,99)});await assert.rejects(f.api.sync({month},owner),/не все строки/);assert.equal(f.api.view(month,owner).report.fingerprint,old);
});
test('generation or organization changes during asynchronous reads cannot publish a report into a different scope',async t=>{
 const f=fixture();t.after(()=>f.db.close());await f.api.sync({month},owner);let changed=false;f.setGate(async path=>{if(path==='report/profit/byproduct'&&!changed){changed=true;f.setStatus({generation:2})}});await assert.rejects(f.api.sync({month},owner),e=>e.status===409);assert.equal(f.api.view(month,owner).report.stale,true);
 f.setStatus({organization:{id:uid(9999),name:'Другая организация'}});assert.equal(f.api.view(month,owner).report,null);f.setStatus({connected:false});assert.equal(f.api.view(month,owner).canSync,false);
});
test('remote error bodies and tokens never enter views or audit; fresh sync clears lastError',async t=>{
 const f=fixture();t.after(()=>f.db.close());await f.api.sync({month},owner);const secret='SECRET-TOKEN-NOT-FOR-UI';f.setError(Object.assign(Error(secret),{remoteStatus:403}));await assert.rejects(f.api.sync({month},owner),e=>!e.message.includes(secret)&&/нет прав/.test(e.message));assert.ok(!JSON.stringify(f.api.view(month,owner)).includes(secret));assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM finance_moysklad_audit').all()).includes(secret));f.setError(null);await f.api.sync({month},owner);assert.equal(f.api.view(month,owner).lastError,'');assert.equal(f.api.view(month,owner).report.stale,false);
});
test('future periods do not call the source; completed months end at 23:59:59 and empty complete reports are a known zero',async t=>{
 const f=fixture();t.after(()=>f.db.close());await assert.rejects(f.api.sync({month:'2026-12'},owner),/будущего/);assert.equal(f.calls.length,0);f.setRows([]);const v=await f.api.sync({month:'2026-10'},owner);assert.equal(v.report.to,'2026-10-31 23:59:59');assert.equal(v.report.provisional,false);assert.equal(v.report.rowsCount,0);assert.equal(v.report.gross,0);assert.equal(v.report.status,'ready');
});
test('concurrent sync is not duplicated and persistence errors roll back report replacement',async t=>{
 const f=fixture();t.after(()=>f.db.close());let release,entered;const hold=new Promise(r=>release=r),gate=new Promise(r=>entered=r);f.setGate(async path=>{if(path==='entity/currency'){entered();await hold}});const first=f.api.sync({month},owner);await gate;const second=await f.api.sync({month},owner);assert.equal(second.busy,true);release();await first;assert.equal(f.calls.filter(c=>c.path==='entity/currency').length,1);
 const old=f.api.view(month,owner).report.fingerprint;f.db.exec("CREATE TRIGGER reject_report BEFORE INSERT ON finance_moysklad_reports BEGIN SELECT RAISE(ABORT,'report failure'); END");await assert.rejects(f.api.sync({month},owner),e=>!e.message.includes('report failure'));assert.equal(f.api.view(month,owner).report.fingerprint,old);
});
test('cost diagnostics count unique affected items once, bound examples and preserve product names as plain text',async t=>{
 const f=fixture();t.after(()=>f.db.close());const name='<img src=x onerror="bad()">'+'А'.repeat(300),code='<code>'+('X'.repeat(100));
 f.setRows(Array.from({length:25},(_,i)=>row(i+1,{assortment:{meta:{href:'https://api.moysklad.ru/api/remap/1.2/entity/product/'+uid(i+1),type:'product'},name,code},sellCostSum:0,returnCostSum:0,profit:9000})));
 let v=await f.api.sync({month},owner);assert.equal(v.report.costIssueCount,25);assert.equal(v.report.costIssues.length,20);assert.equal(v.report.costIssues[0].name,name.slice(0,255));assert.equal(v.report.costIssues[0].code,code.slice(0,80));assert.equal(v.report.costIssues[0].reason,'sold-zero');assert.deepEqual(v.report.costIssues[0].reasons,['sold-zero','returned-zero']);assert.equal(v.report.costIssues[0].sourceId,uid(1));assert.equal(v.report.gross,null);
 f.setRows([row(1,{sellSum:0,sellQuantity:0,returnCostSum:0,profit:-1000}),row(2,{sellCostSum:null}),row(3,{assortment:{meta:{href:'https://api.moysklad.ru/api/remap/1.2/entity/service/'+uid(3),type:'service'}},sellCostSum:0,returnCostSum:0,profit:9000})]);v=await f.api.sync({month},owner);assert.equal(v.report.costIssueCount,2);assert.deepEqual(v.report.costIssues.map(x=>x.reason),['returned-zero','missing-cost']);assert.equal(v.report.costIssues[0].name,'');
 f.setRows([row(1,{sellCostSum:0}),row(1,{sellCostSum:0})]);await assert.rejects(f.api.sync({month},owner),/повторные/);assert.equal(f.api.view(month,owner).report.costIssueCount,2);
});
