import {localDate} from './model.mjs';
import {roles,roleForEmployee} from './role-catalog.mjs';
import {presetForRole,reviewerRoleForRole} from './kpi-auto-presets.mjs';

export function initKpiAutoMonthly(db,{kpiAuto,transaction,fail,tz='Asia/Tashkent',clock=Date.now}){
 db.exec('CREATE TABLE IF NOT EXISTS kpi_auto_policy(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,updated INTEGER NOT NULL)');
 db.prepare('INSERT OR IGNORE INTO kpi_auto_policy VALUES(1,0,?)').run(clock());
 const policy=()=>{const r=db.prepare('SELECT enabled,updated FROM kpi_auto_policy WHERE id=1').get();return {...r,enabled:!!r.enabled}};
 const has=t=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
 const audit=(employee,month,actor,action,json)=>db.prepare('INSERT INTO kpi_auto_audit(employee,month,actor,action,json,at) VALUES(?,?,?,?,?,?)').run(employee,month,actor,action,JSON.stringify(json),clock());
 function configure(b,a){if(!a?.admin)fail('Только администратор меняет автоперенос KPI',403);if(typeof b.enabled!=='boolean')fail('Проверьте переключатель автопереноса');transaction(()=>{db.prepare('UPDATE kpi_auto_policy SET enabled=?,updated=? WHERE id=1').run(+b.enabled,clock());audit('',localDate(clock(),tz).date.slice(0,7),a.id,'monthly-policy',{enabled:b.enabled});});return {ok:true,policy:policy()};}
 function rollover(){
  const month=localDate(clock(),tz).date.slice(0,7);if(!policy().enabled)return {enabled:false,month,created:0,plans:0,skipped:[]};
  return transaction(()=>{
   const staff=db.prepare('SELECT id,name,role FROM employees WHERE active=1 ORDER BY name').all(),mapped=staff.map(e=>({...e,roleId:roleForEmployee(e.role)})),skipped=[],actor={id:'system:kpi-monthly',admin:true};let created=0,plans=0;
   for(const e of mapped){
    const role=roles.find(r=>r.id===e.roleId);if(!role){skipped.push({employee:e.id,reason:'Для должности нет шаблона'});continue;}
    if(db.prepare('SELECT employee FROM kpi_auto_config WHERE employee=? AND month=?').get(e.id,month))continue;
    if(has('hr_monthly_posts')&&db.prepare('SELECT employee FROM hr_monthly_posts WHERE employee=? AND month=? LIMIT 1').get(e.id,month)||has('pay_entries')&&db.prepare('SELECT id FROM pay_entries WHERE request_id=? LIMIT 1').get('finance:'+month+':'+e.id)){skipped.push({employee:e.id,reason:'Итоги уже подтверждены'});continue;}
    let row=db.prepare('SELECT json FROM role_reviews WHERE employee=? AND month=?').get(e.id,month),review=row?JSON.parse(row.json):null;
    const old=db.prepare('SELECT month,json FROM role_reviews WHERE employee=? AND month<? ORDER BY month DESC LIMIT 1').get(e.id,month),previous=old?JSON.parse(old.json):null;
    if(!review){
     const same=previous?.role===role.id;
     review={role:role.id,actual:[null,null,null,null],targets:same?previous.targets:role.metrics.map(m=>Math.round(m[2]*100)),maximum:same?previous.maximum:0,evidence:'Автоматическая настройка KPI на '+month+'. Источники и проверяющий назначены по должности. Факты берутся из реестров; отсутствующие данные не заменяются нулём или 100%.'};
     db.prepare('INSERT INTO role_reviews VALUES(?,?,?)').run(e.id,month,JSON.stringify(review));plans++;
     audit(e.id,month,actor.id,'role-plan-monthly',{role:role.id,sourceMonth:same?old.month:null,actualsReset:true,maximum:review.maximum,paymentsCreated:0});
    }
    if(review.role!==role.id){skipped.push({employee:e.id,reason:'Сохранённый шаблон отличается от должности; требуется проверка'});continue;}
    const preset=presetForRole(role.id),previousConfig=old&&previous?.role===role.id?db.prepare('SELECT json FROM kpi_auto_config WHERE employee=? AND month=?').get(e.id,old.month):null,parsed=previousConfig?JSON.parse(previousConfig.json):null,prior=parsed?.roleId===role.id?parsed:null;
    const metrics=preset.map((p,i)=>{
     let metric=prior?.metrics?.find(m=>m.index===i)||prior?.metrics?.[i]||p,params=structuredClone(metric.params||{});
     if(Array.isArray(params.taskIds))params.taskIds=[];
     if(metric.provider==='sales-margin')params={...params,planMinor:null,planApproved:false};
     return {index:i,provider:review.actual?.[i]!=null?'manual':metric.provider,params:review.actual?.[i]!=null?{}:params};
    });
    const reviewerRole=reviewerRoleForRole(role.id),candidates=reviewerRole==='owner'?[]:mapped.filter(r=>r.id!==e.id&&r.roleId===reviewerRole),reviewer=prior?.reviewer&&mapped.some(r=>r.id===prior.reviewer&&r.id!==e.id)?prior.reviewer:candidates.length===1?candidates[0].id:null;
    kpiAuto.handle('configure',{employee:e.id,month,version:0,enabled:prior?.enabled!==false,reviewer,metrics,reason:'Автонастройка по должности '+role.name+'. '+(old?'Шаблон прошлого месяца сохранён; факты и привязки заданий не копируются.':'Первичное подключение источников и проверяющего.')},actor);
    created++;
   }
   return {enabled:true,month,created,plans,skipped};
  });
 }
 function initialize(a){if(!a?.admin)fail('Только администратор назначает KPI всем сотрудникам',403);return rollover();}
 return {policy,configure,rollover,initialize};
}
