import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {automationKpi,automationReadiness} from '../automation-kpi.mjs';

const month='2026-10';
const employee={id:'seller',name:'Продавец'};
const account={currency:'UZS'};
const finance={currency:'UZS',roles:[],rows:[{employee,review:null,score:null,account:true}]};
const team={configured:true,status:'proposal',currency:'UZS',basisMonth:'2026-09',teamWeight:100,personalWeight:0,score:68.74,
 source:{basisNet:100000000,currentNet:68740000},rows:[{employee:employee.id,name:employee.name,role:'Продавец',status:'proposal',
 score:68.74,proposal:6874,maximum:10000,canApprove:true,accountConfigured:true,redistribution:{addedProposal:221}}]};
const sales=()=>({connected:true,report:{asOf:42,status:'ready'}});

function fixture(t){
 const db=new DatabaseSync(':memory:');
 t.after(()=>db.close());
 db.exec(`CREATE TABLE employees(id TEXT PRIMARY KEY, role TEXT);
  CREATE TABLE pay_accounts(employee TEXT, month TEXT, currency TEXT);
  CREATE TABLE finance_approvals(status TEXT, json TEXT);
  INSERT INTO employees VALUES ('seller','Продавец');
  INSERT INTO pay_accounts VALUES ('seller','2026-10','UZS');`);
 return db;
}

test('team turnover keeps authoritative amount, scope and redistribution',t=>{
 const view=automationKpi(fixture(t),month,{}, {turnover:()=>team,finance:()=>finance,sales});
 const [row]=view.rows, [metric]=row.metrics;
 assert.equal(view.summary.teamPercent,68.74);
 assert.equal(row.amount,6874);
 assert.equal(row.redistributedAmount,221);
 assert.equal(row.personalPercent,null);
 assert.equal(row.metrics.length,1);
 assert.equal(metric.fact,687400);
 assert.equal(metric.plan,1000000);
 assert.equal(metric.contribution,68.74);
});

test('updated source cannot be shown as the basis of a posted result',t=>{
 const updated={...team,status:'stale',warnings:['Отчёт изменился'],rows:[{...team.rows[0],posted:true,postedAmount:7000}]};
 const view=automationKpi(fixture(t),month,{}, {turnover:()=>updated,finance:()=>finance,sales});
 assert.equal(view.summary.sourceStatus,'stale');
 assert.equal(view.rows[0].status,'posted');
 assert.equal(view.rows[0].amount,7000);
 assert.equal(view.rows[0].metrics[0].fact,null);
});

test('readiness distinguishes pending approval from missing unrelated generic KPI',t=>{
 const db=fixture(t);
 db.prepare('INSERT INTO finance_approvals VALUES (?,?)').run('pending',JSON.stringify({diff:{accounts:[{employee:employee.id,month}]}}));
 const period={ended:true,proposals:[],rows:[{employee,account,totals:{advance:0,payout:0,remaining:1234},performance:{complete:false},
  checks:[{code:'kpi-data',blocking:true,message:'Не заполнен дополнительный KPI'}],proposals:[]}]};
 const control={capabilities:{checks:true},checks:[]};
 const data={close:()=>period,payrollControl:()=>control,sales,turnover:()=>team};
 const view=automationReadiness(db,month,{},data);
 assert.equal(view.summary.pending,1);
 assert.equal(view.summary.attention,0);
 assert.equal(view.rows[0].status,'pending');
 assert.equal(view.rows[0].amounts.remaining,1234);
 const disabled=automationReadiness(null,month,{features:{monthClose:{enabled:false}}},{});
 assert.equal(disabled.enabled,false);
});
