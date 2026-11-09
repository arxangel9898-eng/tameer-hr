import {createHmac,timingSafeEqual} from 'node:crypto';
import {localDate} from './model.mjs';
import {monthOK} from './payroll.mjs';
export function verifyMiniApp(input,token,now=Date.now()){
 const deny=()=>{throw Object.assign(Error('Откройте кабинет заново из Telegram'),{status:401})};
 if(typeof input!=='string'||input.length>16000||!token)deny();
 const fields=new URLSearchParams(input),seen=new Set();for(const [k] of fields){if(seen.has(k))deny();seen.add(k)}
 const hash=fields.get('hash');if(!/^[a-f0-9]{64}$/.test(hash||''))deny();fields.delete('hash');
 const check=[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
 const key=createHmac('sha256','WebAppData').update(token).digest(),expected=createHmac('sha256',key).update(check).digest();
 if(!timingSafeEqual(expected,Buffer.from(hash,'hex')))deny();
 const date=Number(fields.get('auth_date'));if(!Number.isInteger(date)||date*1000>now+30000||now-date*1000>3600000)deny();
 let user;try{user=JSON.parse(fields.get('user'))}catch{deny()}
 if(!user||!Number.isSafeInteger(user.id)||user.id<=0||user.is_bot===true)deny();
 if(fields.get('chat_type')&&!['private','sender'].includes(fields.get('chat_type')))deny();
 return user;
}
export function initEmployeePortal(db,{telegram,payroll,salaryWorkflows=null,payrollCenter=null,kpiVisibility=null,hr,hrAssistant,development,operations=null,insights=null,academy=null,workflows=null,storeOps=null,network=null,tz,fail}){
 function handle(path,b){const identity=telegram.authenticateMiniApp(b.initData),employee=identity.employee,chat=identity.chat;
  const actor={id:'telegram:'+chat,employee,permissions:{}};
  if(path==='/api/employee/payroll-center/supplement-complete'){if(!payrollCenter)fail('Центр выплат недоступен',404);return payrollCenter.handle('control','complete',b,actor);}
  if(path.startsWith('/api/employee/salary-workflows/')){const action=path.slice('/api/employee/salary-workflows/'.length);if(!salaryWorkflows||!['terms-ack','dispute-create','receipt-ack'].includes(action))fail('Действие недоступно',403);return salaryWorkflows.handle(action,b,actor);}
  const languages=['ru','uz','tg'];
  if(path==='/api/employee/offline')return network.offline(b.action,b,actor);
  if(path.startsWith('/api/employee/network/'))return network.handle(path.slice('/api/employee/network/'.length),b,actor);
  if(path==='/api/employee/store-correction')return storeOps.handle('correction-request',b,actor);
  if(path==='/api/employee/store-check-submit')return storeOps.handle('check-submit',b,actor);
  if(path==='/api/employee/language'){if(!languages.includes(b.language))fail('Неверный язык');db.prepare('INSERT INTO tg_languages VALUES(?,?) ON CONFLICT(chat) DO UPDATE SET language=excluded.language').run(chat,b.language);return {ok:true}}
  if(path==='/api/employee/task-submit')return operations.submit(employee,b);
  if(path==='/api/employee/academy-lesson'||path==='/api/employee/academy-attempt'){if(!academy)fail('Учебный центр недоступен',404);return academy.handle('/api/hr-academy/'+(path.endsWith('-lesson')?'lesson':'attempt'),b,actor)}
  if(path==='/api/employee/document-download'){if(!workflows)fail('Документы недоступны',404);const d=workflows.attachment(b.id,actor);return {filename:d.filename,mime:d.mime,data:d.bytes.toString('base64')}}
  if(path==='/api/employee/document-ack'){if(!workflows)fail('Документы недоступны',404);return workflows.handle('/document/ack',{id:b.id},actor)}
  if(path==='/api/employee/quiz-answer'){if(typeof b.requestId!=='string'||! /^[a-f0-9-]{36}$/.test(b.requestId))fail('Некорректный запрос');return {message:development.answer(employee,b.id,b.answer,'mini-quiz:'+employee+':'+b.requestId)}}
  if(path==='/api/employee/request'){if(typeof b.requestId!=='string'||! /^[a-f0-9-]{36}$/.test(b.requestId))fail('Некорректный запрос');return hrAssistant.request(employee,b.kind,b.message,'miniapp:'+employee+':'+b.requestId)}
  if(path!=='/api/employee/data')fail('Не найдено',404);
  const month=b.month||localDate(Date.now(),tz).date.slice(0,7);if(!monthOK(month))fail('Некорректный месяц');
  const e=db.prepare('SELECT id,name,role FROM employees WHERE id=?').get(employee),p=payroll.statement(employee,month);
  const result={viewer:{chat,employee},...(salaryWorkflows?{salaryWorkflows:salaryWorkflows.own(employee,month)}:{}),...(payrollCenter?{payrollCenter:payrollCenter.own(employee,month)}:{}),network:network?.own(actor)||null,storeOps:storeOps?.own(employee)||null,academy:academy?.self(employee,actor)||null,documents:workflows?.ownDocuments(actor)||[],insights:insights?.personal(employee,month)||null,orders:operations?.self(employee)||[],quizzes:development.view?development.view().quizzes.filter(q=>q.active).map(({id,title,question,options})=>({id,title,question,options})):[],employee:e,month,language:db.prepare('SELECT language FROM tg_languages WHERE chat=?').get(chat)?.language||'ru',statement:p,hr:hr.self(employee,Number(month.slice(0,4))),development:development.self(employee),requests:hrAssistant.self(employee)};
  return kpiVisibility?kpiVisibility.personal(result,'web'):result;
 }
 return {handle};
}
