import {serveTrainingMedia} from './training-media.mjs';
import {readAndroidRelease,androidUpdatesPage} from './android-release.mjs';
import {initAttendanceCabinet} from './attendance-cabinet.mjs';
import {initMoysklad,MOYSKLAD_ACTOR,MOYSKLAD_PATH} from './moysklad.mjs';
import {initStoreExcellence} from './store-excellence.mjs';
import {initAttendanceTools} from './attendance-tools.mjs';
import {initIndoorZones} from './indoor-zones.mjs';
import {initWorkspaceViews} from './workspace-views.mjs';
import {initShiftBotAutomation} from './shift-bot-automation.mjs';
import {initTelegramHistory} from './telegram-history.mjs';
import {initPeriodAttendanceReports} from './period-attendance-reports.mjs';
import {initShiftExcelReports} from './shift-excel-reports.mjs';
import {initDailyAttendanceReports} from './daily-attendance-reports.mjs';
import {initEarlyExit} from './early-exit.mjs';
import {initEarlyExitGroup} from './early-exit-group.mjs';
import {initDayOffNotifications} from './day-off-notifications.mjs';
import {initLeaveNotifications} from './leave-notifications.mjs';
import {initStoreNetwork} from './store-network.mjs';
import {initFinanceApproval} from './finance-approval.mjs';
import {initShiftSchedule} from './shift-schedule.mjs';
import {initStoreOps} from './store-ops.mjs';
import {initStoreSales} from './store-sales.mjs';
import {initManagerView} from './manager.mjs';
import {hrImportXlsx,initHRSetup} from './hr-setup.mjs';
import {initHRWorkflows} from './hr-workflows.mjs';
import {initHRAcademy} from './hr-academy.mjs';
import {initHRMonthClose} from './hr-month-close.mjs';
import {initRecruitmentWeb} from './recruitment-web.mjs';
import {isIP} from 'node:net';
import http from 'node:http';
import {initDiscipline} from './discipline.mjs';
import {initHRInsights} from './hr-insights.mjs';
import {initLegalNews} from './legal-news.mjs';
import {initOperations} from './operations.mjs';
import {initEmployeePortal} from './employee-portal.mjs';
import {initDevelopment} from './hr-development.mjs';
import {initHRAssistant} from './hr-assistant.mjs';
import {initAccounts} from './accounts.mjs';
import {initFinance,roleKpiResult} from './finance.mjs';
import {initCompensationHistory} from './compensation-history.mjs';
import {initSalaryWorkflows} from './salary-workflows.mjs';
import {initPayrollCenter} from './payroll-center.mjs';
import {initKpiVisibility} from './kpi-visibility.mjs';
import {initFinanceMoysklad} from './finance-moysklad.mjs';
import {initTurnoverKpi} from './turnover-kpi.mjs';
import {initKpiAuto} from './kpi-auto.mjs';
import {initKpiAutoMonthly} from './kpi-auto-monthly.mjs';
import {initAutomationCenter} from './automation-center.mjs';
import {automationKpi,automationReadiness} from './automation-kpi.mjs';
import {automationQueue,automationCoverage} from './automation-queue.mjs';
import {roles} from './role-catalog.mjs';
import {initVisitors} from './visitors.mjs';
import {initNotifications} from './notifications.mjs';
import {initHR} from './hr.mjs';
import {initPayroll} from './payroll.mjs';
import {initTelegram} from './telegram.mjs';
import {initAttendanceBot} from './attendance-bot.mjs';
import {initAttendance} from './attendance.mjs';
import {initRecruitment} from './recruitment.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,chmodSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {localDate,dayAdd,validDate,plan,shiftDay,summarize,allowedActions} from './model.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const dataDir=process.env.DATA_DIR||join(root,'data'), tz=process.env.STORE_TZ||'Asia/Tashkent';
const port=Number(process.env.PORT||3000),publicURL=new URL(process.env.PUBLIC_URL||'http://127.0.0.1:3000');
const adminPass=process.env.ADMIN_PASSWORD;
if(!adminPass||adminPass.length<12||adminPass.length>256||adminPass==='CHANGE_ME_LONG_RANDOM_PASSWORD')throw Error('Set ADMIN_PASSWORD to a unique password of at least 12 characters.');
if(process.env.ATTENDANCE_AUTO_CLOSE_SINCE&&!validDate(process.env.ATTENDANCE_AUTO_CLOSE_SINCE))throw Error('ATTENDANCE_AUTO_CLOSE_SINCE must use YYYY-MM-DD.');
localDate(Date.now(),tz);mkdirSync(dataDir,{recursive:true,mode:0o700});mkdirSync(join(dataDir,'reports'),{recursive:true,mode:0o700});

const db=new DatabaseSync(join(dataDir,'smena.sqlite'));db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
// Schema version 1. Future changes must be appended as migrations.
db.exec(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS employees(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shifts(id TEXT PRIMARY KEY,employee TEXT NOT NULL REFERENCES employees(id),day TEXT NOT NULL,planned_start INTEGER NOT NULL,planned_end INTEGER NOT NULL,grace INTEGER NOT NULL,break_limit INTEGER NOT NULL,created INTEGER NOT NULL,UNIQUE(employee,day));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,shift TEXT NOT NULL REFERENCES shifts(id),kind TEXT NOT NULL,at INTEGER NOT NULL,value TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_shifts_day ON shifts(day);
CREATE INDEX IF NOT EXISTS idx_events_shift ON events(shift,id);
CREATE TABLE IF NOT EXISTS cameras(id INTEGER PRIMARY KEY,name TEXT NOT NULL,host TEXT NOT NULL DEFAULT '',port INTEGER NOT NULL DEFAULT 554,channel INTEGER NOT NULL,username TEXT NOT NULL DEFAULT '',password TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS reports(day TEXT PRIMARY KEY,json TEXT NOT NULL,generated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
`);
db.prepare('DELETE FROM sessions').run();
try{chmodSync(join(dataDir,'smena.sqlite'),0o600)}catch{}
db.prepare('INSERT OR IGNORE INTO settings VALUES(1,?)').run(JSON.stringify({start:'09:00',end:'18:00',grace:5,breakLimit:60}));
const addCam=db.prepare('INSERT OR IGNORE INTO cameras(id,name,channel) VALUES(?,?,?)');for(let i=1;i<=20;i++)addCam.run(i,`Камера ${String(i).padStart(2,'0')}`,i);
const settings=()=>JSON.parse(db.prepare('SELECT json FROM settings WHERE id=1').get().json);
const eventsFor=id=>db.prepare('SELECT * FROM events WHERE shift=? ORDER BY id').all(id);
let transactionDepth=0;
function transaction(fn){const level=transactionDepth++,name='nested_'+level;try{db.exec(level?'SAVEPOINT '+name:'BEGIN IMMEDIATE');try{const result=fn();db.exec(level?'RELEASE '+name:'COMMIT');return result}catch(e){if(level){db.exec('ROLLBACK TO '+name);db.exec('RELEASE '+name)}else db.exec('ROLLBACK');throw e}}finally{transactionDepth--}}
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status})};
function text(v,name,max=100){if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail(`Проверьте поле «${name}»`);return v.trim()}
const indoorZones=initIndoorZones(db,{dataDir,fail,transaction});
const accounts=initAccounts(db,{fail,transaction,adminPassword:adminPass});
const kpiVisibility=initKpiVisibility(db,{fail,transaction});
let leaveNotices;
const hr=initHR(db,{tz,transaction,fail,text,onLeaveDecision:(leave,decision)=>leaveNotices?.enqueue(leave,decision)});
let discipline,network,financialApproval,moysklad,shiftAutomation=null,turnoverKpi=null,compensationHistory=null,salaryWorkflows=null,payrollCenter=null,currentPayActor=null;
const payroll=initPayroll(db,{tz,transaction,fail,text,onAccountChange:(a,b)=>compensationHistory?.recordBase({employee:a.employee,month:a.month,base:a.base,currency:a.currency,effectiveDate:b.effectiveDate||a.month+'-01',reason:b.reason||'Подтверждённое изменение месячной базы оплаты'},currentPayActor||{id:'system:payroll-history',admin:true}),turnoverKpi:(e,m)=>turnoverKpi?.personal(e,m)||null,latestTurnoverKpi:e=>turnoverKpi?.latestPersonal(e)||null,absence:hr.absence,lateReview:s=>{if(!discipline)return {};const a=db.prepare('SELECT * FROM attendance_adjustments WHERE shift=?').get(s.id);return {arrival:a?.arrival,excused:!!a?.excuse_start||shiftAutomation?.lateForShift(s)?.status==='approved',monthlyPosted:!!db.prepare("SELECT employee FROM hr_monthly_posts WHERE employee=? AND month=? AND kind='discipline'").get(s.employee,s.day.slice(0,7))}}});
compensationHistory=initCompensationHistory(db,{fail,transaction,tz});compensationHistory.bootstrap();compensationHistory.applyDue();
const kpiAuto=initKpiAuto(db,{fail,transaction,tz});
const kpiAutoMonthly=initKpiAutoMonthly(db,{kpiAuto,fail,transaction,tz});
const resolveRoleReview=(employee,month,review)=>kpiAuto.resolve(employee,month,review);
const finance=initFinance(db,{payroll,fail,tz,transaction,resolveRoleReview});
const hrAssistant=initHRAssistant(db,{hr,finance,fail,transaction,tz});
const development=initDevelopment(db,{hr,fail,transaction,tz});
const shiftSchedule=initShiftSchedule(db,{settings,hr,fail,tz,branchSettings:(e,d)=>network?.branchSettings(e,d)});
let earlyExitGroup;
const earlyExit=initEarlyExit(db,{transaction,fail,tz,onDecision:r=>earlyExitGroup?.enqueue(r)});
let shiftExcelReports;
function pendingTelegramDeparture(shift,last,cutoff,now){
 return !!db.prepare(`SELECT 1 FROM tg_attendance_requests r
  JOIN tg_attendance_config c ON c.id=1 AND c.enabled=1 AND c.group_id=r.group_id AND c.revision=r.revision
  JOIN tg_attendance_bot_config b ON b.id=1 AND b.enabled=1
  JOIN tg_attendance_bindings u ON u.chat=r.user_id AND u.employee=r.employee AND u.status='approved'
  LEFT JOIN tg_attendance_video_retry j ON j.group_id=r.group_id AND j.message_id=r.message_id
  WHERE r.employee=? AND r.status='pending' AND r.at>=? AND r.at<?
   AND ((j.message_id IS NULL AND r.at>=?) OR (j.kind='out' AND j.bot_id=b.bot_id AND j.status IN ('pending','running') AND j.expires>=?))
  LIMIT 1`).get(shift.employee,last,cutoff,now-10*60000,now);
}
const attendance=initAttendance(db,{schedule:shiftSchedule,settings,eventsFor,transaction,fail,text,tz,dataDir,onEarlyExit:earlyExit.create,earlyForShift:earlyExit.forShift,onShiftClosed:close=>shiftExcelReports?.enqueue(close),
 autoCloseSince:process.env.ATTENDANCE_AUTO_CLOSE_SINCE||null,overtimeForShift:s=>shiftAutomation?.overtimeForShift(s),pendingDeparture:pendingTelegramDeparture});
const telegram=initTelegram(db,{dataDir,tz,payroll,transaction,fail,hr,hrAssistant,development,publicURL:publicURL.origin,kpiVisible:()=>kpiVisibility.enabled('bot'),presentStatement:s=>kpiVisibility.statement(s,'bot')});
const attendanceBot=initAttendanceBot(db,{publicURL:publicURL.origin,dataDir,tz,payroll,transaction,fail,attendance,earlyExit,expectedUsername:process.env.ATTENDANCE_BOT_USERNAME||null});
earlyExitGroup=initEarlyExitGroup(db,{bot:attendanceBot,tz});
const earlyExitGroupTimer=setInterval(()=>earlyExitGroup.scan().catch(()=>console.error('Early exit group delivery failed')),5000);earlyExitGroupTimer.unref();
leaveNotices=initLeaveNotifications(db,{bot:attendanceBot,fail});
const leaveNoticeTimer=setInterval(()=>leaveNotices.scan().catch(()=>console.error('Leave group delivery failed')),5000);leaveNoticeTimer.unref();
const operations=initOperations(db,{fail,transaction,tz,payroll,hr,development,dataDir});
discipline=initDiscipline(db,{fail,transaction,hr,payroll,finance,tz,resolveRoleReview,earlyForShift:earlyExit.forShift,lateForShift:s=>shiftAutomation?.lateForShift(s)||null});
const storeOps=initStoreOps(db,{lateForShift:s=>shiftAutomation?.lateForShift(s)||null,overtimeForShift:s=>shiftAutomation?.overtimeForShift(s)||null,canReviewCorrection:(a,c)=>shiftAutomation?.canDecideCorrection(a,c)===true,handledReminder:kind=>shiftAutomation?.handlesLegacyReminder(kind)===true,earlyForShift:earlyExit.forShift,schedule:shiftSchedule,attendance,discipline,hr,bot:attendanceBot,payroll,transaction,fail,tz});
attendanceBot.setWorkflows(storeOps);
shiftAutomation=initShiftBotAutomation(db,{schedule:shiftSchedule,storeOps,bot:attendanceBot,transaction,fail,tz});
attendanceBot.setAutomation(shiftAutomation);
const latePermissionTimer=setInterval(()=>shiftAutomation.refreshLate().catch(()=>console.error('Late permission follow-up failed')),5000);latePermissionTimer.unref();
const shiftAutomationTimer=setInterval(()=>shiftAutomation.scan().catch(()=>console.error('Shift automation delivery failed')),30000);shiftAutomationTimer.unref();
const dailyAttendanceReports=initDailyAttendanceReports(db,{schedule:shiftSchedule,storeOps,bot:attendanceBot,transaction,fail,tz});
const telegramHistory=initTelegramHistory(db,{dataDir,schedule:shiftSchedule,settings,storeOps,transaction,fail,tz});
const periodAttendanceReports=initPeriodAttendanceReports(db,{reports:dailyAttendanceReports,accounts,fail,tz});
shiftExcelReports=initShiftExcelReports(db,{reports:dailyAttendanceReports,bot:attendanceBot,transaction,fail,tz});
const shiftExcelTimer=setInterval(()=>shiftExcelReports.scan().catch(()=>console.error('Shift Excel delivery failed')),5000);shiftExcelTimer.unref();
const workspaceViews=initWorkspaceViews({accounts,hr,workflows:{view:(...args)=>workflows.view(...args)},payroll,earlyExit,dailyReports:dailyAttendanceReports,tz,fail,employeeRole:id=>db.prepare('SELECT role FROM employees WHERE id=?').get(id)?.role||''});
const dailyAttendanceTimer=setInterval(()=>dailyAttendanceReports.scan().catch(()=>console.error('Daily attendance delivery failed')),30000);dailyAttendanceTimer.unref();
const dayOffNotices=initDayOffNotifications(db,{schedule:shiftSchedule,bot:attendanceBot,fail,tz});
const dayOffTimer=setInterval(()=>dayOffNotices.scan().catch(()=>console.error('Day off delivery failed')),5000);dayOffTimer.unref();
network=initStoreNetwork(db,{fail,transaction,schedule:shiftSchedule,storeOps,hr,dataDir,tz,publicURL:publicURL.origin,telegram});
const attendanceTools=initAttendanceTools(db,{schedule:shiftSchedule,storeOps,attendance,network,bot:attendanceBot,transaction,fail,tz});
const storeExcellence=initStoreExcellence(db,{schedule:shiftSchedule,storeOps,network,hr,bot:attendanceBot,transaction,fail,dataDir,publicURL:publicURL.origin,tz});
const attendanceCabinet=initAttendanceCabinet(db,{bot:attendanceBot,schedule:shiftSchedule,storeOps,automation:shiftAutomation,tools:attendanceTools,excellence:storeExcellence,earlyExit,reports:dailyAttendanceReports,fail,tz});
attendanceBot.setExtensions({feature:k=>attendanceTools.feature(k),menuForChat:chat=>{const rows=[...(attendanceTools.menuForChat(chat)||[]),...(storeExcellence.menuForChat(chat)||[])];return rows.length?rows:null},processUpdate:async(u,io)=>await storeExcellence.processUpdate(u,io)||await attendanceTools.processUpdate(u,io),miniHandle:(action,b,who)=>action.startsWith('cabinet/')?attendanceCabinet.handle(action.slice(8),b,who):action.startsWith('excellence/')?storeExcellence.miniHandle(action.slice(11),b,who):attendanceTools.miniHandle(action,b,who)});
const storeExcellenceTimer=setInterval(()=>storeExcellence.scan().catch(()=>console.error('Store excellence scan failed')),15000);storeExcellenceTimer.unref();
const storeArchiveTimer=setInterval(()=>storeExcellence.archive.scan().catch(()=>console.error('Store archive scan failed')),60000);storeArchiveTimer.unref();
const attendanceToolsTimer=setInterval(()=>attendanceTools.scan().catch(()=>console.error('Attendance tools scan failed')),5000);attendanceToolsTimer.unref();
const storeSales=initStoreSales(db,{fail,transaction,payroll,dataDir,tz});
const storeOpsTimer=setInterval(()=>storeOps.scan().catch(()=>console.error('Store operations scan failed')),30000);storeOpsTimer.unref();
const insights=initHRInsights(db,{fail,transaction,discipline,payroll,finance,tz});
const recruitment=initRecruitment(db,{dataDir,fail,transaction,tz,publicURL:publicURL.origin,expectedUsername:process.env.RECRUITMENT_BOT_USERNAME||''});
const recruitmentWeb=initRecruitmentWeb(db,{recruitment,fail,tz});
const hrSetup=initHRSetup(db,{fail,transaction,tz});
const workflows=initHRWorkflows(db,{hr,fail,transaction,tz});
const academy=initHRAcademy(db,{fail,transaction,tz,development});
const monthClose=initHRMonthClose(db,{fail,transaction,tz,payroll,discipline,finance,turnoverView:m=>turnoverKpi?.view(m,{admin:true})||null,authorizePost:(path,b,actor)=>{if(!accounts.can(actor,'hr_month',true))fail('Нет права подтверждения',403);const allowed=['/api/hr-assistant/insights/discipline-post','/api/hr-assistant/insights/performance-post','/api/finance/approve','/api/finance/turnover-kpi/approve','/api/payroll/job/approve','/api/payroll/kpi/approve'];if(!allowed.includes(path))fail('Недопустимый вид начисления',403);if(path==='/api/payroll/kpi/approve')storeSales.assertKpiCurrent(b.id);if(financialApproval?.enabled())return financialApproval.propose('/internal/month-close',{path,payload:b},actor);return executeFinancial(path,b,actor)}});
const financialRoutes=['/api/hr-assistant/insights/discipline-post','/api/hr-assistant/insights/performance-post','/api/finance/approve','/api/finance/turnover-kpi/approve','/api/payroll/job/approve','/api/payroll/kpi/approve'];
function executeFinancial(path,b,actor){if(path===MOYSKLAD_PATH)return recordPayAction(()=>moysklad.apply(b,actor),actor);if(path==='/internal/month-close'){if(!financialRoutes.includes(b.path))fail('Неизвестное начисление');return executeFinancial(b.path,b.payload,actor)}if(['/api/finance/approve','/api/hr-assistant/insights/performance-post','/api/payroll/kpi/approve'].includes(path))turnoverKpi?.assertIndependent(b.employee,b.month);if(path==='/api/payroll/kpi/approve')storeSales.assertKpiCurrent(b.id);return recordPayAction(()=>path.startsWith('/api/payroll/center/control/')?payrollCenter.handle('control',path.slice('/api/payroll/center/control/'.length),b,actor):path==='/api/finance/turnover-kpi/approve'?turnoverKpi.approve(b,actor):path.startsWith('/api/payroll/')?payroll.handle(path,b):path.startsWith('/api/finance/')?finance.handle(path,b):path.startsWith('/api/hr-assistant/insights/')?discipline.handle(path,b,actor):path==='/api/hr-assistant/operations/decision'?operations.handle(path,b,actor):fail('Операция недоступна'),actor);}
financialApproval=initFinanceApproval(db,{fail,transaction,accounts,execute:executeFinancial,defaultEnabled:process.env.DUAL_APPROVAL_DEFAULT!=='0',resolveActor:id=>id===MOYSKLAD_ACTOR?moysklad?.serviceActor():accounts.user(id),authorize:(actor,path,b)=>{if(path===MOYSKLAD_PATH)return moysklad.authorize(actor,b);if(path==='/internal/month-close'){if(!accounts.can(actor,'hr_month',true)||!financialRoutes.includes(b.path))fail('Нет права закрытия месяца',403)}else accounts.authorize(actor,path,'POST')}});
moysklad=initMoysklad(db,{dataDir,payroll,transaction,fail,tz,dualEnabled:()=>financialApproval.enabled(),cancelApproval:(p,a)=>financialApproval.handle('decide',{id:p.id,version:p.version,action:'cancel',reason:'Повторная проверка импорта МойСклад'},a),stage:(b,a)=>financialApproval.shouldStage(MOYSKLAD_PATH,b)?financialApproval.propose(MOYSKLAD_PATH,b,a):executeFinancial(MOYSKLAD_PATH,b,a)});
const financeMoysklad=initFinanceMoysklad(db,{moysklad,fail,transaction,tz});
turnoverKpi=initTurnoverKpi(db,{fail,transaction,tz,reportForMonth:month=>financeMoysklad.view(month,{admin:true}),roleAt:(e,d,f)=>compensationHistory.roleAt(e,d,f),personalResult:(e,m)=>{const raw=db.prepare('SELECT json FROM role_reviews WHERE employee=? AND month=?').get(e,m),review=raw?JSON.parse(raw.json):null,role=roles.find(r=>r.id===review?.role);return role?roleKpiResult(role,resolveRoleReview(e,m,review)):{complete:false,score:null};},postBonus:b=>payroll.postTeamBonus(b)});
function salaryTermsBuilder(employee,month){const e=db.prepare('SELECT id,role FROM employees WHERE id=?').get(employee);if(!e)return null;const a=db.prepare('SELECT base,currency FROM pay_accounts WHERE employee=? AND month=?').get(employee,month),raw=db.prepare('SELECT json FROM role_reviews WHERE employee=? AND month=?').get(employee,month),review=raw?JSON.parse(raw.json):null,role=roles.find(r=>r.id===review?.role),team=turnoverKpi.personal(employee,month),policy=db.prepare('SELECT json FROM turnover_kpi_policies WHERE month=?').get(month),weights=policy?JSON.parse(policy.json):null;return {role:team?.role||compensationHistory.roleAt(employee,month+'-'+String(new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate()).padStart(2,'0'),e.role),currency:a?.currency||payroll.config().currency,base:a?.base??null,minimum:0,maximum:team?.maximum??review?.maximum??null,metrics:(role?.metrics||[]).map((m,i)=>({label:m[0],weight:m[1],target:review?.targets?.[i]===undefined?m[2]:review.targets[i]/100,unit:m[3],source:role.metricGuidance?.[i]?.dataSource||'Подтверждённая проверка показателя'})),team:team?{label:team.label,minimum:team.minimum,maximum:team.maximum,weight:weights?.teamWeight??100}:null,personalWeight:team?(weights?.personalWeight??0):100,teamWeight:team?(weights?.teamWeight??100):0,formula:team?'Премия определяется личной и командной долями в пределах установленного лимита. Отсутствующий обязательный факт ожидает проверки.':'Премия по должности определяется подтверждёнными планом и фактом KPI в пределах установленного лимита.',note:team?.excluded?'Должность исключена из командной премии за этот месяц.':'Условия для ознакомления. Начисление премии и выплата денег подтверждаются отдельно.'};}
salaryWorkflows=initSalaryWorkflows(db,{fail,transaction,payroll,termsBuilder:salaryTermsBuilder,tz});
payrollCenter=initPayrollCenter(db,{fail,transaction,payroll,tz,eligibleAccounts:()=>accounts.list().accounts.filter(a=>a.status==='active'&&(a.admin||a.permissions?.payroll==='write')),personalResult:(employee,month)=>{const raw=db.prepare('SELECT json FROM role_reviews WHERE employee=? AND month=?').get(employee,month),review=raw?JSON.parse(raw.json):null,role=roles.find(r=>r.id===review?.role);if(!role)return null;const resolved=resolveRoleReview(employee,month,review);return {...roleKpiResult(role,resolved),maximum:review.maximum,provisional:resolved.automation?.provisional===true,evidence:review.evidence,automation:resolved.automation};},postEntry:b=>payroll.postControlEntry(b)});
const moyskladTimer=setInterval(()=>moysklad.scan().catch(()=>console.error('MoySklad sync failed')),15000);moyskladTimer.unref();
recruitment.setInterviewConfirm((id,chat,version)=>workflows.confirmChat(id,chat,version));
const workflowTimer=setInterval(()=>workflows.scan(recruitment).catch(()=>console.error('Recruitment workflow delivery failed')),30000);workflowTimer.unref();
const legalNews=initLegalNews(db,{fail});
const employeePortal=initEmployeePortal(db,{telegram,payroll,salaryWorkflows,payrollCenter,kpiVisibility,hr,hrAssistant,development,operations,insights,academy,workflows,storeOps,network,tz,fail});
const legalTimer=setInterval(()=>legalNews.refresh().catch(()=>{}),12*3600000);legalTimer.unref();
if(process.env.NODE_ENV==='production')setTimeout(()=>legalNews.refresh().catch(()=>{}),45000).unref();
const developmentTimer=setInterval(()=>development.scan(telegram).catch(()=>console.error('HR delivery scan failed')),30000);developmentTimer.unref();
const notices=initNotifications(db,{telegram,hr,fail,transaction});
const automationCenter=initAutomationCenter(db,{transaction,fail,tz,publicURL:publicURL.origin,attendance:attendanceBot,telegram,payroll,reports:financeMoysklad,
 advances:()=>moysklad.view({admin:true}),
 build:(month,settings)=>{
  const actor={admin:true};
  let team,source;
  const turnover=()=>team??=turnoverKpi.view(month,actor),sales=()=>source??=financeMoysklad.view(month,actor);
  const now=Date.now();
  return {kpi:automationKpi(db,month,settings,{turnover,sourceDraft:()=>turnoverKpi.sourceDraft(month,actor),finance:()=>finance.view(month),sales}),
   readiness:automationReadiness(db,month,settings,{turnover,close:()=>monthClose.view(month,actor),payrollControl:()=>payrollCenter.control.view(month,actor),sales}),
   queue:automationQueue(db,month,settings,now,{tz,storeOps}),coverage:automationCoverage(db,month,settings,now,{schedule:shiftSchedule,assignment:network.assignment,tz})};
 }});
const visitorToken=process.env.VISITOR_INGEST_TOKEN||'';
if(visitorToken&&visitorToken.length<32)throw Error('VISITOR_INGEST_TOKEN must contain at least 32 characters');
const visitors=initVisitors(db,{tz,fail,transaction,workerConfigured:!!visitorToken});
db.exec('PRAGMA user_version=21');
db.exec('CREATE TABLE IF NOT EXISTS pay_entry_approvers(entry TEXT PRIMARY KEY,actor TEXT NOT NULL)');
function recordPayAction(fn,user){return transaction(()=>{const previous=currentPayActor;currentPayActor=user;try{const before=new Set(db.prepare('SELECT id FROM pay_entries').all().map(r=>r.id)),result=fn();for(const r of db.prepare('SELECT id FROM pay_entries').all())if(!before.has(r.id))db.prepare('INSERT OR IGNORE INTO pay_entry_approvers VALUES(?,?)').run(r.id,user.name+' ('+user.username+')');return result;}finally{currentPayActor=previous;}})}
function hrDataAssistant(b,actor){const question=String(b.question||'').trim().slice(0,500),day=b.day||localDate(Date.now(),tz).date;if(!question)fail('Напишите вопрос');const w=actor.admin||['hr_tasks','hr_recruit','hr_documents','hr_month'].some(k=>accounts.can(actor,k))?workflows.view(actor,day):{},evidence=[];let answer='';
 if(/обуч|курс|навык/i.test(question)){if(!accounts.can(actor,'hr_training'))fail('Нет доступа к обучению',403);const a=academy.view(actor),missing=a.employees.filter(e=>!a.enrollments.some(n=>n.employee===e.id&&!n.completed));answer=`Курсов: ${a.summary.courses}, назначений: ${a.summary.assigned}, просрочено: ${a.summary.overdue}. Проверьте сотрудников без текущего обучения и назначьте подходящий курс.`;for(const e of missing)evidence.push(e.name+' — нет текущего курса');for(const e of a.enrollments.filter(x=>x.overdue))evidence.push(e.name+' — просрочен курс «'+e.title+'», срок '+e.due)}
 else if(/документ|личн.*дел/i.test(question)){if(!accounts.can(actor,'hr_documents'))fail('Нет доступа к личным делам',403);const docs=w.documents||[];answer=`В личных делах ${docs.length} документов. Проверьте сроки и наличие загруженных версий.`;for(const d of docs.filter(x=>!x.versions?.length||x.expires&&x.expires<day))evidence.push((d.name||d.employee)+' · '+d.title+' — '+(!d.versions?.length?'нет файла':'срок '+d.expires))}
 else if(/собесед|кандидат|подбор/i.test(question)){if(!accounts.can(actor,'hr_recruit'))fail('Нет доступа к подбору',403);const candidates=(w.candidates||[]).filter(x=>!['hired','rejected','withdrawn'].includes(x.stage));answer=`В работе ${candidates.length} кандидатов. Собеседований в календаре: ${(w.interviews||[]).length}. Откройте карточку кандидата и назначьте следующий шаг.`;for(const c of candidates)evidence.push(c.name+' · '+c.role+' · '+c.stage)}
 else if(/месяц|зарплат|прем|kpi|кпи|финанс/i.test(question)){if(!accounts.can(actor,'hr_month'))fail('Нет доступа к закрытию месяца',403);const m=monthClose.view(day.slice(0,7),actor);answer=`За ${m.month}: ${m.summary.missingAccounts} сотрудников без расчёта, ${m.summary.missingAttendance} незаполненных смен, ${m.summary.incompleteKpi} неполных KPI. Проверьте замечания перед начислениями.`;for(const r of m.rows)for(const c of r.checks)evidence.push(r.employee.name+' — '+c.message)}
 else{if(!accounts.can(actor,'hr_tasks'))fail('Нет доступа к рабочей очереди',403);const queue=(w.queue||[]).filter(x=>x.status!=='done'&&x.due<=day);answer=`На ${day} в очереди ${queue.length} задач. Сначала проверьте просроченные и срочные, затем назначьте ответственных.`;for(const x of queue)evidence.push(x.title+' · '+x.due+' · '+(x.owner||'не назначен'))}return {answer,evidence:evidence.slice(0,30),asOf:day};}
const cameraStatus=new Map(),frameCache=new Map(),framePending=new Map();let ffmpegActive=0;
function report(day){const rows=db.prepare('SELECT * FROM employees ORDER BY name').all().filter(e=>localDate(e.created,tz).date<=day&&(e.active||db.prepare('SELECT id FROM shifts WHERE employee=? AND day=?').get(e.id,day))).map(e=>{
 const s=db.prepare('SELECT * FROM shifts WHERE employee=? AND day=?').get(e.id,day);const ev=s?eventsFor(s.id):[];
 const evidence=s?attendance.evidenceFor(s.id):[];
 return {employee:e.id,name:e.name,role:e.role,absence:hr.absence(e.id,day),shift:s?.id??null,...storeOps.corrected(s,ev),actions:allowedActions(ev),evidence,events:ev.map(event=>({...event,...(evidence.find(v=>v.event===event.id)?{evidence:evidence.find(v=>v.event===event.id)}:{})}))};
 });return {day,timezone:tz,generated:Date.now(),rows};}
function snapshotReport(day){const r=report(day);db.prepare('INSERT INTO reports VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET json=excluded.json,generated=excluded.generated').run(day,JSON.stringify(r),r.generated);const dest=join(dataDir,'reports',day+'.csv');writeFileSync(dest+'.tmp',csv(r),{mode:0o600});renameSync(dest+'.tmp',dest);return r}
const fmt=ms=>ms?new Intl.DateTimeFormat('ru-RU',{timeZone:tz,hour:'2-digit',minute:'2-digit'}).format(ms):'';
function csv(r){const rows=[['Дата','Сотрудник','Должность','Статус','Приход','Уход','Работа, мин','Перерыв, мин','Опоздание, мин','Ранний уход, мин','Сверх перерыва, мин','Форма','Примечание','Источник прихода','Видео прихода','Источник ухода','Видео ухода','Фактический ранний уход, мин','Разрешение раннего ухода','Ответственный','Кто подтвердил решение'],...r.rows.map(x=>[r.day,x.name,x.role,x.status,fmt(x.in),fmt(x.out),x.worked,x.breaks,x.late,x.early,x.extraBreak,{yes:'Синяя форма',no:'Без формы',unknown:'Не проверена'}[x.uniform],x.note,...['in','out'].flatMap(kind=>{const v=x.evidence?.find(e=>e.kind===kind);return [v?'Telegram-видео':kind==='out'&&x.autoClosed?'Автозакрытие':x[kind]?'Ручная отметка':'',v?v.url:'']}),x.rawEarly??x.early,x.earlyPermission?.status||'',x.earlyPermission?.responsible||'',x.earlyPermission?.confirmedBy||''])];return '\uFEFF'+rows.map(row=>row.map(v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"').join(';')).join('\r\n')}
function state(day){return {financialApproval:{enabled:financialApproval?.enabled()??false},roleTemplates:roles.map(r=>r.name),today:localDate(Date.now(),tz).date,timezone:tz,settings:settings(),employees:db.prepare('SELECT * FROM employees ORDER BY active DESC,name').all(),openShifts:db.prepare("SELECT shifts.*,employees.name,employees.role FROM shifts JOIN employees ON employees.id=shifts.employee WHERE NOT EXISTS(SELECT 1 FROM events WHERE shift=shifts.id AND kind='out') ORDER BY shifts.created").all().map(s=>{const ev=eventsFor(s.id);const evidence=attendance.evidenceFor(s.id);return {...s,shift:s.id,...storeOps.corrected(s,ev),actions:allowedActions(ev),evidence,events:ev.map(event=>({...event,...(evidence.find(v=>v.event===event.id)?{evidence:evidence.find(v=>v.event===event.id)}:{})}))}}),report:report(day),cameras:db.prepare('SELECT id,name,host,port,channel,username,password FROM cameras ORDER BY id').all().map(({password,...c})=>({...c,hasPassword:!!password,status:cameraStatus.get(c.id)||{state:c.host?'unchecked':'unconfigured',at:null}})),savedReports:db.prepare('SELECT day,generated FROM reports ORDER BY day DESC LIMIT 90').all()}}
const managerShiftPlan=(employee,day)=>db.prepare('SELECT planned_start,planned_end,grace FROM shifts WHERE employee=? AND day=?').get(employee,day)||null;
const managerEmployeeHistory=(employee,day)=>db.prepare('SELECT * FROM shifts WHERE employee=? AND day<=? ORDER BY day DESC LIMIT 7').all(employee,day).map(s=>({...s,...storeOps.corrected(s,eventsFor(s.id))}));
function managerShiftRequests(actor,day){
 if(!actor?.admin)return [];
 const early=db.prepare("SELECT r.shift id,r.employee,e.name,s.day,r.status,r.created FROM early_exit_requests r JOIN employees e ON e.id=r.employee JOIN shifts s ON s.id=r.shift WHERE r.status='pending' AND s.day<=? ORDER BY r.created DESC LIMIT 50").all(day).map(r=>({...r,id:'early-exit:'+r.id,kind:'early-exit',href:'/#telegram'}));
 const bot=db.prepare("SELECT r.id,r.employee,e.name,r.day,r.kind,r.status,r.created FROM shift_bot_requests r JOIN employees e ON e.id=r.employee WHERE r.status='pending' AND r.day<=? ORDER BY r.created DESC LIMIT 50").all(day).map(r=>({...r,id:'shift-request:'+r.id,href:'/#telegram'}));
 return [...early,...bot].sort((a,b)=>b.created-a.created).slice(0,100);
}
const managerView=initManagerView({accounts,state,hr,payroll,workflows,academy,recruitment,finance,financeMoysklad,turnoverKpiView:(m,a)=>turnoverKpi.view(m,a),shiftPlan:managerShiftPlan,employeeHistory:managerEmployeeHistory,roleKpiView:month=>finance.view(month),shiftRequests:managerShiftRequests,tz,fail});
function getFrame(c){if(framePending.has(c.id))return framePending.get(c.id);const old=frameCache.get(c.id);if(old&&Date.now()-old.at<4000)return Promise.resolve(old.buf);if(ffmpegActive>=4)return Promise.reject(Object.assign(Error('Камеры заняты. Повторите через несколько секунд.'),{status:429}));
 const promise=new Promise((resolve,reject)=>{ffmpegActive++;const url=`rtsp://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/Streaming/Channels/${c.channel}02`;
 const child=spawn(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-rtsp_transport','tcp','-rw_timeout','8000000','-i',url,'-frames:v','1','-vf','scale=960:-2','-f','image2pipe','-vcodec','mjpeg','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','ignore']});let bufs=[],size=0,finished=false;
 const timer=setTimeout(()=>{child.kill('SIGKILL');done(Error('Камера не ответила за 12 секунд. Проверьте VPN и параметры.'))},12000);
 function done(err){if(finished)return;finished=true;clearTimeout(timer);ffmpegActive--;if(err){cameraStatus.set(c.id,{state:'offline',at:Date.now()});reject(Object.assign(err,{status:502}));return}const buf=Buffer.concat(bufs);frameCache.set(c.id,{buf,at:Date.now()});cameraStatus.set(c.id,{state:'online',at:Date.now()});resolve(buf)}
 child.stdout.on('data',b=>{size+=b.length;if(size>3e6){child.kill('SIGKILL');done(Error('Слишком большой кадр'))}else bufs.push(b)});
 child.on('error',()=>done(Error('FFmpeg не установлен или недоступен.')));child.on('close',code=>done(code!==0||!size?Error('Нет изображения. Проверьте сеть, канал и данные камеры.'):null));
 });framePending.set(c.id,promise);promise.finally(()=>framePending.delete(c.id)).catch(()=>{});return promise;
}
const security={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
function send(res,status,data,type='application/json; charset=utf-8',extra={}){res.writeHead(status,Object.fromEntries(Object.entries({...security,'Content-Type':type,...extra}).filter(([,v])=>v!==null)));res.end(typeof data==='object'&&!Buffer.isBuffer(data)?JSON.stringify(data):data)}
async function body(req,limit=32768){let len=0,chunks=[];for await(const ch of req){len+=ch.length;if(len>limit)fail('Слишком большой запрос',413);chunks.push(ch)}try{const value=JSON.parse(Buffer.concat(chunks).toString());if(!value||typeof value!=='object'||Array.isArray(value))fail('Некорректный запрос');return value}catch{fail('Некорректный запрос')}}
const hash=t=>createHash('sha256').update(t).digest('hex');
function session(req){let raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('smena='))?.slice(6);if(!raw||raw.length>200)return null;const s=db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(hash(raw),Date.now());if(!s)return null;const user=accounts.user(s.account_id);return user?{...s,user}:null}
const cookie=(token,seconds)=>`smena=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${publicURL.protocol==='https:'?'; Secure':''}`;
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,publicURL),path=url.pathname;
 if(path==='/internal/zones/event'){
  if(req.method!=='POST')fail('Метод недоступен',405);
  let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8192)fail('Запрос слишком большой',413);chunks.push(chunk);}
  return send(res,200,indoorZones.ingest(Buffer.concat(chunks).toString('utf8'),{gateway:req.headers['x-zone-gateway'],time:req.headers['x-zone-time'],signature:req.headers['x-zone-signature']}));
 }
 if(path.startsWith('/internal/visitors/')){
  const supplied=req.headers.authorization||'';
  if(!visitorToken||!timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update('Bearer '+visitorToken).digest()))fail('Нет доступа',401);
  if(path==='/internal/visitors/config'&&req.method==='GET')return send(res,200,visitors.config());
  if(req.method==='POST'&&path==='/internal/visitors/event')return send(res,200,visitors.ingest(await body(req)));
  if(req.method==='POST'&&path==='/internal/visitors/status')return send(res,200,visitors.heartbeat(await body(req)));
  fail('Не найдено',404);
 }
 if(req.method==='GET'&&path==='/finance-ui.js')return send(res,200,readFileSync(join(root,'public','finance-ui.js')),'text/javascript; charset=utf-8');
 if(req.method==='GET'&&path==='/visitors-ui.js')return send(res,200,readFileSync(join(root,'public','visitors-ui.js')),'text/javascript; charset=utf-8');
 if(req.method==='GET'&&['/automation-center.js','/automation-center.css'].includes(path))return send(res,200,readFileSync(join(root,'public',path.slice(1))),path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
 if(req.method==='GET'&&path==='/service-feedback')return send(res,200,readFileSync(join(root,'public','service-feedback.html')),'text/html; charset=utf-8');
 if(path.startsWith('/api/service-feedback/')){if(req.method!=='POST')fail('Метод недоступен',405);if(req.headers.origin!==publicURL.origin)fail('Недопустимый источник',403);const b=await body(req,6000),remote=(req.socket.remoteAddress||'').replace(/^::ffff:/,''),trusted=['127.0.0.1','::1'].includes(remote)||remote.startsWith('172.')&&/^172\.(1[6-9]|2\d|3[01])\./.test(remote),ip=trusted&&isIP(String(req.headers['x-real-ip']||''))?String(req.headers['x-real-ip']):remote;return send(res,200,path.endsWith('/context')?storeExcellence.feedbackContext(b,ip):path.endsWith('/submit')?storeExcellence.submitFeedback(b,ip):fail('Путь недоступен',404));}
 if(req.method==='GET'&&['/service-feedback.js','/store-excellence-ui.js','/late-permission-ui.js','/attendance-export.js','/attendance-export.css','/moysklad-ui.js','/moysklad.css','/store-excellence.css','/store-excellence-mini.js'].includes(path))return send(res,200,readFileSync(join(root,'public',path.slice(1))),path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
 if(serveTrainingMedia(req,res,path,join(root,'public')))return;
 if(req.method==='GET'&&['/attendance-mini','/attendance-mini/'].includes(path))return send(res,200,readFileSync(join(root,'public','attendance-mini.html')),'text/html; charset=utf-8',{'X-Frame-Options':null,'Permissions-Policy':'geolocation=(self)','Content-Security-Policy':"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org; form-action 'self'"});
 if(req.method==='GET'&&['/attendance-mini.js','/attendance-mini.css','/attendance-hub.js','/attendance-hub.css','/attendance-cabinet.js','/attendance-cabinet.css','/attendance-learning.js','/attendance-learning.css'].includes(path))return send(res,200,readFileSync(join(root,'public',path.slice(1))),path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
 if(path.startsWith('/api/attendance-mini/')){if(req.method!=='POST')fail('Метод недоступен',405);if(req.headers.origin!==publicURL.origin)fail('Недопустимый источник запроса',403);return send(res,200,await attendanceBot.miniAPI(path.slice('/api/attendance-mini/'.length),await body(req,path.includes('/tools/excellence/')?750000:20000)));}
 if(req.method==='GET'&&['/employee','/employee.html'].includes(path))return send(res,200,readFileSync(join(root,'public','employee.html')),'text/html; charset=utf-8',{'X-Frame-Options':null,'Content-Security-Policy':"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org; form-action 'self'"});
 if(req.method==='GET'&&['/employee.js','/employee.css','/employee-i18n.mjs','/payroll-center-ui.js'].includes(path))return send(res,200,readFileSync(join(root,'public',path.slice(1))),path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
 if(req.method==='GET'&&['/apply','/apply/'].includes(path))return send(res,200,readFileSync(join(root,'public','apply.html')),'text/html; charset=utf-8',{'X-Frame-Options':null,'Content-Security-Policy':"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org; form-action 'self'"});
 if(req.method==='GET'&&path==='/vendor/xlsx.full.min.js')return send(res,200,readFileSync(join(root,'public','vendor','xlsx.full.min.js')),'text/javascript; charset=utf-8');
 if(req.method==='GET'&&['/hr-workspace.js','/hr-workspace-actions.js','/hr-setup-ui.js','/hr-workspace.css','/store-ops-ui.js','/store-ops.css','/employee-store.mjs','/network-ui.js','/network.css','/employee-network.mjs','/employee-offline.mjs','/employee-sw.js','/vendor/qrcode.js'].includes(path))return send(res,200,readFileSync(join(root,'public',path.slice(1))),path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
 if(req.method==='GET'&&['/apply.js','/apply.css','/telegram-history-ui.js','/telegram-history.css','/shift-bot-ui.js','/attendance-tools-ui.js','/attendance-tools.css','/shift-bot.css','/zones-ui.js'].includes(path))return send(res,200,readFileSync(join(root,'public',path.slice(1))),path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
 if(req.method==='GET'&&['/tameer-auth.svg','/tameer-logo.svg','/tameer-icon.svg','/tameer-brand.css'].includes(path))return send(res,200,readFileSync(join(root,'public',path.slice(1))),path.endsWith('.svg')?'image/svg+xml':'text/css; charset=utf-8');
 if(req.method==='GET'&&path==='/api/apply/catalog')return send(res,200,recruitmentWeb.catalog());
 if(req.method==='GET'&&path==='/api/apply/draft'){const raw=typeof req.headers.authorization==='string'&&req.headers.authorization.startsWith('Bearer ')?req.headers.authorization.slice(7):(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('tameer_apply='))?.slice(13);return send(res,200,recruitmentWeb.loadDraft(raw,req.headers['x-csrf-token']))}
 if(req.method==='POST'&&path.startsWith('/api/apply/')){
  if(req.headers.origin!==publicURL.origin)fail('Недопустимый источник запроса',403);
  const raw=typeof req.headers.authorization==='string'&&req.headers.authorization.startsWith('Bearer ')?req.headers.authorization.slice(7):(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('tameer_apply='))?.slice(13);
  const remote=req.socket.remoteAddress||'local',forwarded=String(req.headers['x-real-ip']||''),proxyIP=remote.replace(/^::ffff:/,'');
  const trustedProxy=['127.0.0.1','::1'].includes(proxyIP)||process.env.NODE_ENV==='production'&&/^172\.(1[6-9]|2\d|3[01])\./.test(proxyIP),ip=trustedProxy&&isIP(forwarded)?forwarded:remote;
  if(path==='/api/apply/session'){const started=recruitmentWeb.start(await body(req),raw,ip);return send(res,200,started.data,undefined,{'Set-Cookie':`tameer_apply=${started.token}; HttpOnly; SameSite=Lax; Path=/api/apply; Max-Age=604800${publicURL.protocol==='https:'?'; Secure':''}`})}
  if(path==='/api/apply/draft')return send(res,200,recruitmentWeb.saveDraft(await body(req,900000),raw,req.headers['x-csrf-token'],ip));
  if(path==='/api/apply/draft/delete')return send(res,200,recruitmentWeb.deleteDraft(raw,req.headers['x-csrf-token']));
  if(path==='/api/apply/submit')return send(res,200,recruitmentWeb.submit(await body(req,900000),raw,req.headers['x-csrf-token'],ip));
  fail('Не найдено',404);
 }
 if(['GET','HEAD'].includes(req.method)&&['/downloads/TAMEER-HR-manager.apk','/downloads/android-update.json','/downloads/TAMEER-HR-manager.apk.sha256','/android-app-updates'].includes(path)){
  const release=readAndroidRelease(join(root,'public','downloads'),{origin:publicURL.origin,signer:process.env.ANDROID_SIGNER_SHA256});
  if(path==='/downloads/android-update.json')return send(res,200,release.manifest);
  if(path==='/android-app-updates')return send(res,200,androidUpdatesPage(release),'text/html; charset=utf-8');
  if(path.endsWith('.sha256'))return send(res,200,release.sha256,'text/plain; charset=utf-8');
  return send(res,200,release.apk,'application/vnd.android.package-archive',{'Content-Disposition':'attachment; filename="TAMEER-HR-manager.apk"','Content-Length':release.apk.length});
 }
 if(req.method==='GET'&&['/manager','/manager/'].includes(path))return send(res,200,readFileSync(join(root,'public','manager.html')),'text/html; charset=utf-8');
 if(req.method==='GET'&&['/manager.js','/manager.css'].includes(path))return send(res,200,readFileSync(join(root,'public',path.slice(1))),path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
 if(req.method==='GET'&&path==='/health')return send(res,200,{ok:true});
 if(req.method==='GET'&&['/hr-plus','/hr-plus-ui.js','/hr-plus.css','/business.css','/hr-overview.js'].includes(path))return send(res,200,readFileSync(join(root,'public',path==='/hr-plus'?'index.html':path.slice(1))),path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
 if(req.method==='GET'&&['/operations','/operations-ui.js'].includes(path))return send(res,200,readFileSync(join(root,'public',path==='/operations'?'operations.html':'operations-ui.js')),path==='/operations'?'text/html; charset=utf-8':'text/javascript; charset=utf-8');
 if(req.method==='GET'&&['/','/live-refresh.js','/app.js','/style.css','/controls.css','/payroll-ui.js','/payroll.css','/hr-ui.js','/recruitment-ui.js','/hr-assistant-ui.js','/hr-development-ui.js','/hr.css','/notices-ui.js','/accounts-ui.js','/dashboard-ui.js','/workspace-designs.js','/workspace-designs.css','/dashboard-unified.css','/design.css','/favicon.svg'].includes(path))return send(res,200,readFileSync(join(root,'public',path==='/'?'index.html':path.slice(1))),path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':path.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8');
 if(!path.startsWith('/api/'))fail('Страница не найдена',404);
 if(req.method==='POST'&&req.headers.origin!==publicURL.origin)fail('Недопустимый источник запроса',403);
 if(path.startsWith('/api/employee/')&&req.method==='POST')return send(res,200,employeePortal.handle(path,await body(req,['/api/employee/task-submit','/api/employee/store-check-submit','/api/employee/network/incident','/api/employee/network/shelf-check','/api/employee/offline'].includes(path)?900000:32768)));
 if(path==='/api/register'&&req.method==='POST')return send(res,201,accounts.register(await body(req),req.socket.remoteAddress||'local'));
 if(path==='/api/login'&&req.method==='POST'){
  const user=accounts.login(await body(req),req.socket.remoteAddress||'local'),raw=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,csrf,expires,account_id) VALUES(?,?,?,?)').run(hash(raw),csrf,Date.now()+12*3600000,user.id);
  return send(res,200,{ok:true,csrf,user},undefined,{'Set-Cookie':cookie(raw,43200)});
 }
 const s=session(req);if(!s)fail('Войдите в кабинет',401);
 if(req.method==='POST'&&req.headers['x-csrf-token']!==s.csrf)fail('Обновите страницу и повторите действие',403);
 accounts.authorize(s.user,path,req.method);
 if(path==='/api/automation-center'&&req.method==='GET')return send(res,200,automationCenter.view(url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7),s.user));
 if(path==='/api/kpi-auto'&&req.method==='GET')return send(res,200,{...kpiAuto.view(s.user,url.searchParams.get('employee'),url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7)),monthlyPolicy:kpiAutoMonthly.policy()});
 if(path==='/api/zones'&&req.method==='GET')return send(res,200,indoorZones.view(s.user));
 if(path==='/api/network'&&req.method==='GET')return send(res,200,network.view(s.user,url.searchParams.get('branch')||'main',url.searchParams.get('day')||localDate(Date.now(),tz).date));
 if(path==='/api/network/self'&&req.method==='GET')return send(res,200,network.own(s.user));
 if(path==='/api/moysklad'&&req.method==='GET')return send(res,200,moysklad.view(s.user));
 if(path==='/api/moysklad/references'&&req.method==='GET')return send(res,200,await moysklad.references(url.searchParams.get('type'),url.searchParams.get('search')||'',s.user));
 if(path==='/api/finance-approvals'&&req.method==='GET')return send(res,200,financialApproval.view(s.user));
 if(path==='/api/storeops'&&req.method==='GET'){const day=url.searchParams.get('day')||localDate(Date.now(),tz).date;return send(res,200,{...storeOps.view(s.user,day),dayOff:dayOffNotices.view(day)})}
 if(path==='/api/storeops/self'&&req.method==='GET'){if(!s.user.employee)fail('Аккаунт не связан с сотрудником',403);return send(res,200,storeOps.own(s.user.employee))}
 if(path==='/api/store-sales'&&req.method==='GET'){if(!s.user.admin)fail('Только администратор',403);return send(res,200,storeSales.view(url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7)))}
 if(path==='/api/workspace'&&req.method==='GET')return send(res,200,workspaceViews.view(s.user,url.searchParams.get('day')||undefined));
 if(path==='/api/session'&&req.method==='GET')return send(res,200,{csrf:s.csrf,user:s.user});
 if(path==='/api/manager/view'&&req.method==='GET')return send(res,200,managerView.view(s.user,{day:url.searchParams.get('day')||undefined,month:url.searchParams.get('month')||undefined}));
 if(path==='/api/accounts'&&req.method==='GET')return send(res,200,accounts.list());
 if(path==='/api/me'&&req.method==='GET'){const month=url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7);return send(res,200,kpiVisibility.personal({user:s.user,statement:s.user.employee?payroll.statement(s.user.employee,month):null,salaryWorkflows:s.user.employee?salaryWorkflows.own(s.user.employee,month):null,payrollCenter:s.user.employee?payrollCenter.own(s.user.employee,month):null},'web'));}
 if(path==='/api/payroll/kpi-visibility'&&req.method==='GET')return send(res,200,kpiVisibility.view(s.user));
 if(path==='/api/payroll/center'&&req.method==='GET')return send(res,200,payrollCenter.view(url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7),s.user));
 if(path==='/api/payroll/self-center'&&req.method==='GET'){if(!s.user.employee)fail('Аккаунт не связан с сотрудником',403);return send(res,200,kpiVisibility.center(payrollCenter.own(s.user.employee,url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7)),'web'));}
 if(path==='/api/payroll/center/batch.xlsx'&&req.method==='GET'){const file=payrollCenter.download(url.searchParams.get('id'),s.user);return send(res,200,file.bytes,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',{'Content-Disposition':`attachment; filename="${file.filename}"`,'Cache-Control':'private, no-store'});}
 if(path==='/api/payroll/self-workflows'&&req.method==='GET'){if(!s.user.employee)fail('Аккаунт не связан с сотрудником',403);return send(res,200,salaryWorkflows.own(s.user.employee,url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7)));}
 if(path==='/api/payroll/workflows'&&req.method==='GET')return send(res,200,salaryWorkflows.view(url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7),s.user,url.searchParams.get('employee')||null));
 if(path==='/api/payroll/history'&&req.method==='GET')return send(res,200,compensationHistory.view(url.searchParams.get('employee'),s.user));

 if(path==='/api/finance'&&req.method==='GET'){const month=url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7);return send(res,200,{...finance.view(month),moysklad:financeMoysklad.view(month,s.user),turnoverKpi:turnoverKpi.view(month,s.user)});}
 if(path==='/api/finance/moysklad'&&req.method==='GET')return send(res,200,financeMoysklad.view(url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7),s.user));
 if(path==='/api/visitors'&&req.method==='GET')return send(res,200,visitors.report(url.searchParams.get('from')||undefined,url.searchParams.get('to')||undefined));
 if(path==='/api/visitors.csv'&&req.method==='GET')return send(res,200,visitors.csv(url.searchParams.get('from')||undefined,url.searchParams.get('to')||undefined),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename=visitor-ages.csv'});
 if(path==='/api/logout'&&req.method==='POST'){db.prepare('DELETE FROM sessions WHERE token=?').run(s.token);return send(res,200,{ok:true},undefined,{'Set-Cookie':cookie('',0)})}
 if(path==='/api/notices'&&req.method==='GET')return send(res,200,notices.state());
 if(path==='/api/hr-assistant/insights'&&req.method==='GET')return send(res,200,{...insights.view(url.searchParams.get('employee')||undefined,url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7)),recruitment:recruitment.dashboard()});
 if(path==='/api/hr-assistant/insights/legal'&&req.method==='GET')return send(res,200,legalNews.view());
 if(path==='/api/hr-assistant/operations'&&req.method==='GET')return send(res,200,operations.view(url.searchParams.get('day')||undefined));
 if(path==='/api/hr-assistant/operations/photo'&&req.method==='GET')return send(res,200,{photo:operations.photo(url.searchParams.get('id'))});
 if(path==='/api/hr-assistant/recruitment'&&req.method==='GET')return send(res,200,recruitment.state());
 if(path==='/api/hr-assistant/recruitment/application'&&req.method==='GET')return send(res,200,recruitment.detail(url.searchParams.get('id')||''));
 if(path==='/api/hr-assistant/recruitment/photo'&&req.method==='GET'){const photo=recruitment.image(url.searchParams.get('id')||'');return send(res,200,photo.bytes,photo.mime)}
 if(path==='/api/hr-assistant'&&req.method==='GET')return send(res,200,{...hrAssistant.report(url.searchParams.get('end')||undefined),development:development.view()});
 if(path==='/api/hr-setup'&&req.method==='GET')return send(res,200,hrSetup.view(s.user));
 if(path==='/api/hr-setup/template'&&req.method==='GET')return send(res,200,hrImportXlsx(),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',{'Content-Disposition':'attachment; filename="TAMEER_HR_Import.xlsx"'});
 if(path==='/api/hr-workflows/view'&&req.method==='GET')return send(res,200,workflows.view(s.user,url.searchParams.get('day')||localDate(Date.now(),tz).date));
 if(path==='/api/hr-workflows/people'&&req.method==='GET'){if(!accounts.can(s.user,'hr_recruit'))fail('Нет доступа к подбору',403);recruitment.identity.sync();return send(res,200,recruitment.identity.list({query:url.searchParams.get('query')||''}))}
 if(path==='/api/hr-workflows/person'&&req.method==='GET'){if(!accounts.can(s.user,'hr_recruit'))fail('Нет доступа к подбору',403);recruitment.identity.sync();return send(res,200,url.searchParams.get('candidate')?recruitment.identity.forCandidate(url.searchParams.get('candidate')):recruitment.identity.view(url.searchParams.get('id')||''))}
 if(path==='/api/hr-workflows/application'&&req.method==='GET'){if(!accounts.can(s.user,'hr_recruit'))fail('Нет доступа к подбору',403);return send(res,200,recruitment.detail(url.searchParams.get('id')||''))}
 if(path==='/api/hr-workflows/photo'&&req.method==='GET'){if(!accounts.can(s.user,'hr_recruit'))fail('Нет доступа к подбору',403);const photo=recruitment.image(url.searchParams.get('id')||'');return send(res,200,photo.bytes,photo.mime)}
 if(path==='/api/hr-workflows/attachment'&&req.method==='GET'){const file=workflows.attachment(url.searchParams.get('id')||'',s.user);return send(res,200,file.bytes,file.mime,{'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`})}
 if(path==='/api/hr-academy'&&req.method==='GET')return send(res,200,academy.view(s.user));
 if(path==='/api/hr-academy/self'&&req.method==='GET')return send(res,200,academy.self(s.user.employee,s.user));
 if(path==='/api/hr-month-close'&&req.method==='GET')return send(res,200,monthClose.view(url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7),s.user));
 if(path==='/api/hr'&&req.method==='GET')return send(res,200,hr.view(url.searchParams.has('year')?Number(url.searchParams.get('year')):undefined));
 if(path==='/api/hr.csv'&&req.method==='GET')return send(res,200,hr.csv(url.searchParams.has('year')?Number(url.searchParams.get('year')):undefined),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename=hr-employees.csv'});
 if(path==='/api/payroll'&&req.method==='GET')return send(res,200,payroll.view(url.searchParams.get('month')||localDate(Date.now(),tz).date.slice(0,7)));
 if(path==='/api/telegram/attendance/history'&&req.method==='GET')return send(res,200,telegramHistory.view(Object.fromEntries(url.searchParams),s.user));
 if(path==='/api/telegram/attendance/history/video'&&req.method==='GET'){let bytes;try{bytes=telegramHistory.video(url.searchParams.get('id'),s.user)}catch(e){const v=await storeExcellence.archive.video(url.searchParams.get('id'));if(!v)throw e;bytes=v.bytes;}return send(res,200,bytes,'video/mp4',{'Cache-Control':'private, no-store'});}
 if(path==='/api/telegram/attendance/history/upload'&&req.method==='POST'){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>512*1024)fail('Часть видео больше 512 КБ',413);chunks.push(chunk)}return send(res,200,telegramHistory.upload(url.searchParams.get('id'),Buffer.concat(chunks),{offset:Number(url.searchParams.get('offset')),total:Number(url.searchParams.get('total'))},s.user))}
 if(path==='/api/telegram'&&req.method==='GET')return send(res,200,{...telegram.status(),attendance:attendanceBot.status(),excellence:storeExcellence.view(s.user),tools:attendanceTools.view(s.user,{month:url.searchParams.get('toolsMonth')||undefined,employee:url.searchParams.get('toolsEmployee')||undefined}),automation:shiftAutomation.view(s.user),earlyExit:earlyExit.view(),dailyReports:dailyAttendanceReports.view(s.user,url.searchParams.get('reportDay')||undefined),excelReports:shiftExcelReports.view(s.user,url.searchParams.get('reportDay')||undefined)});
 if(path==='/api/telegram/attendance/excel'&&req.method==='GET'){const f=shiftExcelReports.download(url.searchParams.get('day')||localDate(Date.now(),tz).date,s.user);return send(res,200,f.bytes,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',{'Content-Disposition':`attachment; filename="${f.filename}"`,'Cache-Control':'private, no-store'})}
 if(path==='/api/attendance-video'&&req.method==='GET'){const id=url.searchParams.get('id')||'';let v;try{v=attendance.video(id)}catch(e){v=await storeExcellence.archive.video(id);if(!v)throw e;}return send(res,200,v.bytes,v.mime,{'Content-Disposition':'inline; filename="attendance.mp4"','Cache-Control':'private, no-store'})}
 if(path==='/api/state'&&req.method==='GET'){const day=url.searchParams.get('day')||localDate(Date.now(),tz).date;if(!validDate(day))fail('Некорректная дата');return send(res,200,accounts.filterState(s.user,state(day)))}
 if(path==='/api/reports/attendance.xlsx'&&req.method==='GET'){const f=periodAttendanceReports.download({from:url.searchParams.get('from'),to:url.searchParams.get('to'),...(url.searchParams.has('employee')?{employee:url.searchParams.get('employee')}:{})},s.user);return send(res,200,f.bytes,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',{'Content-Disposition':`attachment; filename="${f.filename}"`,'Cache-Control':'private, no-store'});}
 if(path==='/api/report.csv'&&req.method==='GET'){const day=url.searchParams.get('day');if(!validDate(day||''))fail('Выберите дату');return send(res,200,csv(report(day)),'text/csv; charset=utf-8',{'Content-Disposition':`attachment; filename="smena-${day}.csv"`})}
 const frame=path.match(/^\/api\/cameras\/(\d+)\/frame$/);if(frame&&req.method==='GET'){const c=db.prepare('SELECT * FROM cameras WHERE id=?').get(Number(frame[1]));if(!c?.host)fail('Камера не настроена',404);return send(res,200,await getFrame(c),'image/jpeg')}
 if(req.method!=='POST')fail('Не найдено',404);const b=await body(req,path==='/api/telegram/attendance/history/prepare'?22*1024*1024:['/api/telegram/attendance/history/','/api/hr-workflows/','/api/hr-academy/','/api/hr-setup/','/api/storeops/','/api/store-sales/','/api/network/'].some(prefix=>path.startsWith(prefix))?900000:32768);
 if(path==='/api/automation-center/settings')return send(res,200,automationCenter.configure(b,s.user));
 if(path==='/api/automation-center/deliveries/retry')return send(res,200,automationCenter.retry(b,s.user));
 if(path==='/api/telegram/attendance/history/prepare')return send(res,200,telegramHistory.start(b,s.user));
 if(path==='/api/telegram/attendance/history/map')return send(res,200,telegramHistory.mapAuthors(b,s.user));
 if(path==='/api/telegram/attendance/history/commit')return send(res,200,telegramHistory.commit(b,s.user));
 if(financialApproval.shouldStage(path,b))return send(res,200,financialApproval.propose(path,b,s.user));
 if(path.startsWith('/api/zones/'))return send(res,200,indoorZones.handle(path.slice('/api/zones/'.length),b,s.user));
 if(path.startsWith('/api/network/'))return send(res,200,network.handle(path.slice('/api/network/'.length),b,s.user));
 if(path.startsWith('/api/moysklad/'))return send(res,200,await moysklad.handle(path.slice('/api/moysklad/'.length),b,s.user));
 if(path.startsWith('/api/finance-approvals/')){if(path==='/api/finance-approvals/decide')await moysklad.preflight(b,s.user);return send(res,200,financialApproval.handle(path.slice('/api/finance-approvals/'.length),b,s.user));}
 if(path==='/api/hr-setup/preview')return send(res,200,hrSetup.preview(b,s.user));
 if(path==='/api/hr-setup/rules')return send(res,200,hrSetup.rules(b,s.user));
 if(path==='/api/hr-setup/commit')return send(res,200,hrSetup.commit(b,s.user));
 if(path==='/api/hr-workflows/person/merge'){if(!accounts.can(s.user,'hr_recruit',true)||b.confirmed!==true)fail('Нужно подтверждение HR',403);return send(res,200,recruitment.identity.merge(b,s.user))}
 if(path==='/api/hr-workflows/assistant')return send(res,200,hrDataAssistant(b,s.user));
 if(path.startsWith('/api/hr-workflows/'))return send(res,200,workflows.handle(path.slice('/api/hr-workflows'.length),b,s.user));
 if(path.startsWith('/api/hr-academy/'))return send(res,200,academy.handle(path,b,s.user));
 if(path.startsWith('/api/hr-month-close/'))return send(res,200,monthClose.handle(path,b,s.user));
 if(path==='/api/accounts/access')return send(res,200,accounts.update(s.user,b));
 if(path==='/api/accounts/password')return send(res,200,accounts.changePassword(s.user,b,true));
 if(path==='/api/account/appearance')return send(res,200,accounts.setAppearance(s.user,b));
 if(path==='/api/account/password')return send(res,200,accounts.changePassword(s.user,b));
 if(path.startsWith('/api/storeops/')){const action=path.slice('/api/storeops/'.length);if(action.startsWith('day-off-')){const result=transaction(()=>dayOffNotices.handle(action,b,s.user));if(['day-off-send','day-off-retry'].includes(action))dayOffNotices.scan({force:true}).catch(()=>console.error('Day off delivery failed'));return send(res,200,result)}const result=storeOps.handle(action,b,s.user);if(action==='schedule'&&(!b.day||b.day===localDate(Date.now(),tz).date))dayOffNotices.scan({force:true,employee:b.employee}).catch(()=>console.error('Day off delivery failed'));return send(res,200,result)}
 if(path.startsWith('/api/store-sales/'))return send(res,200,await storeSales.handle(path.slice('/api/store-sales/'.length),b,s.user));
 if(path==='/api/kpi-auto/policy')return send(res,200,kpiAutoMonthly.configure(b,s.user));
 if(path==='/api/kpi-auto/initialize')return send(res,200,kpiAutoMonthly.initialize(s.user));
 if(path.startsWith('/api/kpi-auto/'))return send(res,200,kpiAuto.handle(path.slice('/api/kpi-auto/'.length),b,s.user));
 if(path==='/api/finance/turnover-kpi')return send(res,200,turnoverKpi.preview(b,s.user));
 if(path==='/api/finance/turnover-kpi/preview')return send(res,200,turnoverKpi.preview(b,s.user));
 if(path==='/api/finance/turnover-kpi/commit')return send(res,200,turnoverKpi.commit(b,s.user));
 if(path==='/api/finance/turnover-kpi/approve')return send(res,200,executeFinancial(path,b,s.user));
 if(path==='/api/payroll/kpi-visibility')return send(res,200,kpiVisibility.save(b,s.user));
 if(path==='/api/payroll/center/settings')return send(res,200,payrollCenter.handle('settings','settings',b,s.user));
 if(path==='/api/payroll/self-center/complete'){if(!s.user.employee)fail('Аккаунт не связан с сотрудником',403);return send(res,200,payrollCenter.handle('control','complete',b,{...s.user,admin:false,permissions:{}}));}
 if(path.startsWith('/api/payroll/center/growth/'))return send(res,200,payrollCenter.handle('growth',path.slice('/api/payroll/center/growth/'.length),b,s.user));
 if(path.startsWith('/api/payroll/center/control/'))return send(res,200,executeFinancial(path,b,s.user));
 if(path==='/api/payroll/history/role')return send(res,200,compensationHistory.recordRole(b,s.user));
 if(path.startsWith('/api/payroll/workflows/'))return send(res,200,salaryWorkflows.handle(path.slice('/api/payroll/workflows/'.length),b,s.user));
 if(path==='/api/finance/moysklad/sync')return send(res,200,await financeMoysklad.sync(b,s.user));
 if(path.startsWith('/api/finance/')){if(path==='/api/finance/approve')turnoverKpi.assertIndependent(b.employee,b.month);return send(res,200,recordPayAction(()=>finance.handle(path,b),s.user));}
 if(path==='/api/visitors/settings')return send(res,200,visitors.configure(b));
 if(path.startsWith('/api/notices/'))return send(res,200,notices.handle(path,b));
 if(path==='/api/hr-assistant/insights/legal-refresh')return send(res,200,await legalNews.refresh());
 if(path==='/api/hr-assistant/insights/legal-note')return send(res,200,legalNews.note(b,s.user));
 if(['/api/hr-assistant/insights/employment','/api/hr-assistant/insights/vacancy','/api/hr-assistant/insights/candidate-link'].includes(path))return send(res,200,insights.handle(path,b,s.user));
 if(path.startsWith('/api/hr-assistant/insights/')){if(path==='/api/hr-assistant/insights/performance-post')turnoverKpi.assertIndependent(b.employee,b.month);return send(res,200,discipline.handle(path,b,s.user));}
 if(path.startsWith('/api/hr-assistant/operations/'))return send(res,200,operations.handle(path,b,s.user));
 if(path.startsWith('/api/hr-assistant/development/'))return send(res,200,development.handle(path,b,s.user));
 if(path.startsWith('/api/hr-assistant/recruitment/'))return send(res,200,await recruitment.handle(path,b));
 if(path.startsWith('/api/hr-assistant/')){const result=hrAssistant.handle(path,b,s.user);if(path.endsWith('/decision')){const row=db.prepare('SELECT employee,decision FROM '+(b.type==='request'?'hr_requests':'hr_advice')+' WHERE id=?').get(b.id);development.enqueue('decision:'+b.id,row.employee,'Решение: '+(b.status==='approved'?'одобрено':'отклонено')+'. '+row.decision)}if(path.endsWith('/training'))development.enqueue('training:'+b.employee+':'+b.role+':'+b.start,b.employee,'Назначен план обучения с '+b.start+'. Задачи: /tasks');return send(res,200,result);}
 if(path.startsWith('/api/hr/')){if(path==='/api/hr/leave/notify')return send(res,200,transaction(()=>leaveNotices.retry(b.id)));const result=hr.handle(path,b,{actor:s.user});if(path==='/api/hr/leave/decision'){const row=db.prepare('SELECT * FROM hr_leaves WHERE id=?').get(b.id);development.enqueue('leave:'+b.id+':'+b.status,row.employee,'Отпуск / отсутствие '+row.start+' — '+row.end+': '+b.status+'. '+row.decision)}return send(res,200,result);}
 if(path==='/api/payroll/kpi/approve'){turnoverKpi.assertIndependent(b.employee,b.month);storeSales.assertKpiCurrent(b.id);}
 if(path.startsWith('/api/payroll/'))return send(res,200,recordPayAction(()=>payroll.handle(path,b),s.user));
 if(path==='/api/telegram/attendance/excel/settings')return send(res,200,shiftExcelReports.configure(b,s.user));
 if(path==='/api/telegram/attendance/excel/retry'){const r=shiftExcelReports.retry(b,s.user);shiftExcelReports.scan().catch(()=>console.error('Shift Excel delivery failed'));return send(res,200,r)}
 if(path==='/api/telegram/attendance/daily-reports/settings')return send(res,200,dailyAttendanceReports.configure(b,s.user));
 if(path==='/api/telegram/attendance/daily-reports/send'){const r=dailyAttendanceReports.sendNow(b.day,s.user);dailyAttendanceReports.scan().catch(()=>console.error('Daily attendance delivery failed'));return send(res,200,r)}
 if(path==='/api/telegram/attendance/daily-reports/retry'){const r=dailyAttendanceReports.retry(b,s.user);dailyAttendanceReports.scan().catch(()=>console.error('Daily attendance delivery failed'));return send(res,200,r)}
 if(path.startsWith('/api/telegram/attendance/excellence/'))return send(res,200,await storeExcellence.handle(path.slice('/api/telegram/attendance/excellence/'.length),b,s.user));
 if(path==='/api/telegram/attendance/tools/settings')return send(res,200,attendanceTools.configure(b,s.user));
 if(path==='/api/telegram/attendance/tools/gps/decision')return send(res,200,attendanceTools.decideGps(b,s.user));
 if(path==='/api/telegram/attendance/tools/swaps/decision')return send(res,200,attendanceTools.decideSwap(b,s.user));
 if(path==='/api/telegram/attendance/late-permission/settings')return send(res,200,shiftAutomation.latePermissionConfigure(b,s.user));
 if(path==='/api/telegram/attendance/late-permission/decision')return send(res,200,shiftAutomation.latePermissionDecision(b,s.user));
 if(path==='/api/telegram/attendance/late-permission/retry')return send(res,200,shiftAutomation.latePermissionRetry(b,s.user));
 if(path==='/api/telegram/attendance/automation/settings')return send(res,200,shiftAutomation.settings(b,s.user));
 if(path==='/api/telegram/attendance/automation/decision')return send(res,200,shiftAutomation.decide(b,s.user));
 if(path==='/api/telegram/attendance/automation/retry')return send(res,200,shiftAutomation.retry(b,s.user));
 if(path==='/api/telegram/attendance/early-exit/settings')return send(res,200,earlyExit.settings(b,s.user));
 if(path==='/api/telegram/attendance/early-exit/decision')return send(res,200,earlyExit.decide(b.token,b.status,{...s.user,reason:b.reason}));
 if(path.startsWith('/api/telegram/attendance/'))return send(res,200,await attendanceBot.handle(path,b));
 if(path.startsWith('/api/telegram/'))return send(res,200,await telegram.handle(path,b));
 if(path==='/api/employees'){
 const name=text(b.name,'Имя',80),role=text(b.role,'Должность',60),now=Date.now();transaction(()=>{if(b.id){const old=db.prepare('SELECT id,role FROM employees WHERE id=?').get(b.id);if(!old)fail('Сотрудник не найден',404);if(old.role!==role||b.effectiveDate)compensationHistory.recordRole({employee:b.id,role,effectiveDate:b.effectiveDate||localDate(now,tz).date,reason:b.reason||'Изменение должности в карточке сотрудника'},s.user);db.prepare('UPDATE employees SET name=? WHERE id=?').run(name,b.id)}else{if(db.prepare('SELECT COUNT(*) AS n FROM employees WHERE active=1').get().n>=20)fail('Достигнут лимит: 20 активных сотрудников');const id=randomUUID();db.prepare('INSERT INTO employees(id,name,role,created) VALUES(?,?,?,?)').run(id,name,role,now);compensationHistory.recordRole({employee:id,role,effectiveDate:localDate(now,tz).date,reason:'Создание карточки сотрудника'},s.user)}});return send(res,200,{ok:true});
 }
 if(path==='/api/employees/archive'){if(!db.prepare('SELECT id FROM employees WHERE id=?').get(b.id))fail('Сотрудник не найден',404);const open=db.prepare("SELECT id FROM shifts WHERE employee=? AND NOT EXISTS(SELECT 1 FROM events WHERE shift=shifts.id AND kind='out')").all(b.id);if(open.length)fail('Сначала закройте смену сотрудника');db.prepare('UPDATE employees SET active=0 WHERE id=?').run(b.id);return send(res,200,{ok:true})}
 if(path==='/api/settings'){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.end)||b.start===b.end)fail('Укажите разное время начала и конца смены');if(!Number.isInteger(b.grace)||b.grace<0||b.grace>120||!Number.isInteger(b.breakLimit)||b.breakLimit<0||b.breakLimit>480)fail('Проверьте длительность перерывов и допуск опоздания');db.prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify({start:b.start,end:b.end,grace:b.grace,breakLimit:b.breakLimit}));return send(res,200,{ok:true})}
 if(path==='/api/events')return send(res,200,attendance.record({employee:b.employee,kind:b.kind,shift:b.shift,value:b.value,requestId:b.requestId}));
 if(path==='/api/cameras'){
 const id=Number(b.id);if(!Number.isInteger(id)||id<1||id>20)fail('Неверный номер камеры');const name=text(b.name,'Название камеры',60),host=String(b.host||'').trim();if(host&&!/^[a-zA-Z0-9][a-zA-Z0-9.\-]{0,252}$/.test(host))fail('Укажите IP или имя устройства без http://');if(!Number.isInteger(b.port)||b.port<1||b.port>65535||!Number.isInteger(b.channel)||b.channel<1||b.channel>256)fail('Проверьте порт и канал');const username=String(b.username||'');if(username.length>100||typeof b.password!=='string'||b.password.length>200)fail('Проверьте данные доступа');const old=db.prepare('SELECT password FROM cameras WHERE id=?').get(id);db.prepare('UPDATE cameras SET name=?,host=?,port=?,channel=?,username=?,password=? WHERE id=?').run(name,host,b.port,b.channel,username,b.password||old.password,id);cameraStatus.delete(id);frameCache.delete(id);return send(res,200,{ok:true});
 }
 if(path==='/api/reports/save'){if(!validDate(b.day||'')||b.day>localDate(Date.now(),tz).date)fail('Выберите текущую или прошедшую дату');snapshotReport(b.day);return send(res,200,{ok:true})}
 fail('Действие не найдено',404);
 }catch(e){if(!e.status)console.error('Request failed:',e.code||e.name);if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'Не удалось выполнить действие. Повторите попытку.'});else res.end()}});
server.requestTimeout=20000;server.headersTimeout=10000;
// Finalise yesterday after all planned shifts (including overnight) ended; recover missed days after downtime.
function dailyReports(){try{const now=Date.now(),today=localDate(now,tz).date;const first=db.prepare('SELECT MIN(created) AS n FROM employees').get().n;if(!first)return;let day=localDate(first,tz).date;for(let count=0;day<today&&count<3660;day=dayAdd(day,1),count++){const end=Math.max(plan(day,settings(),tz).end,db.prepare('SELECT MAX(planned_end) AS n FROM shifts WHERE day=?').get(day).n||0);const saved=db.prepare('SELECT generated FROM reports WHERE day=?').get(day);const modified=Math.max(db.prepare('SELECT MAX(events.at) AS n FROM events JOIN shifts ON shifts.id=events.shift WHERE shifts.day=?').get(day).n||0,db.prepare('SELECT MAX(a.received_at) AS n FROM attendance_evidence a JOIN events e ON e.id=a.event JOIN shifts s ON s.id=e.shift WHERE s.day=?').get(day).n||0);if(now>end+300000&&(!saved||saved.generated<=modified))snapshotReport(day);}db.prepare('DELETE FROM sessions WHERE expires<?').run(now);}catch(e){console.error('Daily report failed:',e.code||e.name)}}
const noticeTimer=setInterval(()=>notices.scan().catch(()=>console.error('Notification check failed')),60000);noticeTimer.unref();
const automationCenterTimer=setInterval(()=>automationCenter.scan().catch(()=>console.error('Automation Center scan failed')),60000);automationCenterTimer.unref();
server.on('close',()=>clearInterval(automationCenterTimer));
const timer=setInterval(dailyReports,60000);timer.unref();dailyReports();
function autoCloseShifts(){
 try{
  const {closed,failed}=attendance.closeDue();
  if(failed)console.error('Automatic shift closing failed for '+failed+' shift(s)');
  if(closed)shiftAutomation.refreshClosed().catch(()=>console.error('Automatic shift closure message sync failed'));
 }catch(e){console.error('Automatic shift closing failed:',e.code||e.name);}
}
const autoCloseTimer=setInterval(autoCloseShifts,15000);autoCloseTimer.unref();autoCloseShifts();
server.on('close',()=>clearInterval(autoCloseTimer));
function carryPayrollMonth(){try{compensationHistory.applyDue();payroll.rollover()}catch(e){console.error('Payroll month rollover failed:',e.code||e.name)}}
const payrollRolloverTimer=setInterval(carryPayrollMonth,60000);payrollRolloverTimer.unref();carryPayrollMonth();
server.on('close',()=>clearInterval(payrollRolloverTimer));
function carryKpiMonth(){try{kpiAutoMonthly.rollover()}catch(e){console.error('KPI month rollover failed:',e.code||e.name)}}
const kpiMonthTimer=setInterval(carryKpiMonth,60000);kpiMonthTimer.unref();carryKpiMonth();
server.on('close',()=>clearInterval(kpiMonthTimer));
let camIndex=0;const monitor=setInterval(()=>{const configured=db.prepare("SELECT * FROM cameras WHERE host<>'' ORDER BY id").all();if(configured.length){const c=configured[camIndex++%configured.length];getFrame(c).catch(()=>{})}},15000);monitor.unref();
server.listen(port,process.env.BIND_ADDRESS||'127.0.0.1',()=>console.log(`Security Delta Force: ${publicURL.origin} | port ${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(moyskladTimer);moysklad.stop();clearInterval(latePermissionTimer);clearInterval(storeExcellenceTimer);clearInterval(storeArchiveTimer);storeExcellence.stop();clearInterval(attendanceToolsTimer);attendanceTools.stop();clearInterval(shiftAutomationTimer);shiftAutomation.stop();clearInterval(shiftExcelTimer);shiftExcelReports.stop();clearInterval(dailyAttendanceTimer);dailyAttendanceReports.stop();clearInterval(dayOffTimer);dayOffNotices.stop();clearInterval(earlyExitGroupTimer);earlyExitGroup.stop();clearInterval(leaveNoticeTimer);leaveNotices.stop();clearInterval(storeOpsTimer);storeOps.stop();clearInterval(workflowTimer);clearInterval(legalTimer);clearInterval(developmentTimer);notices.stop();clearInterval(noticeTimer);telegram.stop();attendanceBot.stop();recruitment.stop();clearInterval(timer);clearInterval(monitor);server.close(()=>{db.close();process.exit(0)});setTimeout(()=>process.exit(0),5000).unref()});

