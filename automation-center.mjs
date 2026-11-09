import {randomUUID} from 'node:crypto';
import {localDate, dayAdd} from './model.mjs';

const featureKeys = ['kpi', 'monthClose', 'queue', 'coverage', 'bots'];
const events = [
  {id:'kpiReview', feature:'kpi', label:'Проверка данных KPI', bot:'payroll', channels:['private'], time:'10:00', description:'Сводка по неподтверждённым показателям ответственным.'},
  {id:'monthReview', feature:'monthClose', label:'Готовность прошлого месяца', bot:'payroll', channels:['private'], time:'10:00', description:'Сводка по закрытому календарному месяцу и ссылка на сверку.'},
  {id:'queueReview', feature:'queue', label:'Задачи и решения', bot:'attendance', channels:['private'], time:'10:00', description:'Сводка по назначенным открытым задачам. Решения остаются в исходных карточках.'},
  {id:'coverageReview', feature:'coverage', label:'Покрытие смен', bot:'attendance', channels:['private','group'], time:'10:00', description:'Сводка на неделю. В группу отправляется только количество смен, которым нужна замена.'},
  {id:'payrollPublished', feature:'monthClose', label:'Уведомление о проведённой выплате', bot:'payroll', channels:['private'], time:'18:30', description:'Получатель — сотрудник, чья выплата проведена в базе после включения рассылки.'},
  {id:'salesSync', feature:'kpi', label:'Обновление оборота из МойСклад', bot:'integration', channels:['service'], time:'07:00', description:'Ежедневно обновляет отчёты по обороту за текущий и предыдущий месяцы.'},
  {id:'integrationHealth', feature:'bots', label:'Ошибки ботов и МойСклад', bot:'attendance', channels:['private'], time:'10:00', description:'Сводка о проблемах подключения, синхронизации и доставки.'},
];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const defaults = () => ({
  features:Object.fromEntries(featureKeys.map(key => [key,{enabled:true,responsibleIds:[]}])),
  events:Object.fromEntries(events.map(e => [e.id,{enabled:false,channel:e.channels[0],time:e.time,responsibleIds:[],activatedAt:0}])),
});
const statusOf = ({connected,username,lastSeen,lastError}) => ({connected,username,lastSeen,lastError});
const money = n => new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n/100);
const maxLookback = 30*86400000;

export function initAutomationCenter(db, {transaction, fail, tz, publicURL, attendance, telegram, payroll, reports, advances, build, clock=Date.now}) {
  db.exec(`CREATE TABLE IF NOT EXISTS automation_center_settings(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS automation_center_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,at INTEGER NOT NULL,detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS automation_center_delivery(id TEXT PRIMARY KEY,event TEXT NOT NULL,slot TEXT NOT NULL,recipient TEXT NOT NULL,channel TEXT NOT NULL,reference TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',updated INTEGER NOT NULL,UNIQUE(event,slot,recipient,channel));
    CREATE INDEX IF NOT EXISTS automation_center_delivery_status ON automation_center_delivery(status,updated);`);
  db.prepare('INSERT OR IGNORE INTO automation_center_settings VALUES (1,0,?)').run(JSON.stringify(defaults()));
  db.prepare("UPDATE automation_center_delivery SET status='uncertain',detail='Сервер остановился до подтверждения результата',updated=? WHERE status='sending'").run(clock());

  const read = () => {
    const row = db.prepare('SELECT version,json FROM automation_center_settings WHERE id=1').get();
    const base = defaults(), saved = JSON.parse(row.json);
    return {version:row.version,features:{...base.features,...saved.features},events:{...base.events,...saved.events}};
  };
  const publicSettings = settings => ({
    ...settings,
    events:Object.fromEntries(Object.entries(settings.events).map(([key,{activatedAt,...value}]) => [key,value])),
  });
  const current = () => localDate(clock(),tz).date;
  const lastMonth = () => dayAdd(current().slice(0,7)+'-01',-1).slice(0,7);
  const admin = actor => {if(!actor?.admin)fail('Центр автоматизации доступен администратору',403);};
  const requireMonth = month => {
    if(typeof month!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))fail('Выберите корректный месяц');
    return month;
  };
  const active = db.prepare('SELECT id,name,role FROM employees WHERE id=? AND active=1');
  const employeeAdmin = db.prepare("SELECT 1 FROM web_accounts WHERE employee=? AND status='active' AND admin=1");
  const journal = db.prepare('INSERT INTO automation_center_audit(actor,action,at,detail) VALUES(?,?,?,?)');
  const delivery = db.prepare('SELECT * FROM automation_center_delivery WHERE id=?');
  const slotDelivery = db.prepare('SELECT id FROM automation_center_delivery WHERE event=? AND slot=? AND recipient=? AND channel=?');
  const addDelivery = db.prepare("INSERT OR IGNORE INTO automation_center_delivery(id,event,slot,recipient,channel,reference,status,updated) VALUES(?,?,?,?,?,?,'pending',?)");
  const finish = db.prepare("UPDATE automation_center_delivery SET status=?,detail=?,updated=? WHERE id=? AND status='sending'");
  const latest = db.prepare(`SELECT d.id,d.event,d.status,d.detail,d.updated AS updatedAt,
    coalesce(e.name,CASE d.channel WHEN 'group' THEN 'Рабочая группа' WHEN 'service' THEN 'МойСклад' ELSE 'Сотрудник' END) AS recipient
    FROM automation_center_delivery d LEFT JOIN employees e ON e.id=d.recipient ORDER BY d.updated DESC,d.id LIMIT 60`);

  function configure(body,actor){
    admin(actor);
    if(!plain(body)||!plain(body.features)||!plain(body.events))fail('Проверьте настройки автоматизации');
    const checkIds = values => {
      if(!Array.isArray(values)||values.length>100||values.some(id => typeof id!=='string'||!active.get(id)))fail('Выберите действующих сотрудников');
      return [...new Set(values)];
    };
    return transaction(() => {
      const old = read();
      if(body.version!==old.version)fail('Настройки изменились. Обновите раздел',409);
      const features = {};
      const nextEvents = {};
      for(const key of featureKeys){
        const item = body.features[key];
        if(!plain(item)||typeof item.enabled!=='boolean')fail('Проверьте переключатели разделов');
        features[key] = {enabled:item.enabled,responsibleIds:checkIds(item.responsibleIds)};
      }
      for(const event of events){
        const item = body.events[event.id], prior = old.events[event.id];
        if(!plain(item)||typeof item.enabled!=='boolean'||!event.channels.includes(item.channel)||typeof item.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time))fail('Проверьте канал и время отправки');
        const responsibleIds = checkIds(item.responsibleIds);
        const nowEnabled = item.enabled&&features.bots.enabled&&features[event.feature].enabled;
        const wasEnabled = prior.enabled&&old.features.bots.enabled&&old.features[event.feature].enabled;
        nextEvents[event.id] = {enabled:item.enabled,channel:item.channel,time:item.time,responsibleIds,activatedAt:nowEnabled&&!wasEnabled?clock():prior.activatedAt};
      }
      const settings = {features,events:nextEvents};
      db.prepare('UPDATE automation_center_settings SET version=version+1,json=? WHERE id=1').run(JSON.stringify(settings));
      journal.run(actor.id,'settings',clock(),JSON.stringify(settings));
      return {ok:true,settings:publicSettings({...settings,version:old.version+1})};
    });
  }

  function health(month){
    const r = reports.view(month,{admin:true}), a = advances();
    return {attendance:statusOf(attendance.status()),payroll:statusOf(telegram.status()),integration:{
      connected:r.connected,lastSync:r.report?.asOf??null,
      lastError:r.lastError||'',stale:!!r.report?.stale,advanceSync:a.lastSync,advanceError:a.lastError,
    },deliveries:latest.all()};
  }

  function view(month,actor){
    admin(actor);
    requireMonth(month);
    const settings = read();
    return {month,settings:publicSettings(settings),eventOptions:events,employees:db.prepare('SELECT id,name,role FROM employees WHERE active=1 ORDER BY name').all(),
      ...build(month,settings),bots:settings.features.bots.enabled?health(month):null};
  }

  const enabled = (settings,event) => settings.features.bots.enabled&&settings.features[event.feature].enabled&&settings.events[event.id].enabled;
  function recipients(event,settings){
    const config = settings.events[event.id];
    if(config.channel!=='private')return [''];
    const ids = config.responsibleIds.length?config.responsibleIds:settings.features[event.feature].responsibleIds;
    return ids.filter(id => active.get(id));
  }
  const jobLink = (month,href,page,task) => {
    const url = new URL('/',publicURL);
    url.searchParams.set('month',month);
    if(page)url.searchParams.set('automationPage',page);
    if(task)url.searchParams.set('automationTask',task);
    url.hash = href;
    return url.href;
  };
  function payout(id){
    return db.prepare(`SELECT p.* FROM pay_entries p JOIN pay_entry_approvers a ON a.entry=p.id
      JOIN employees e ON e.id=p.employee AND e.active=1
      WHERE p.id=? AND p.kind='payout' AND p.voided_at IS NULL`).get(id);
  }
  function canDispatch(row,settings,event){
    const config = settings.events[event.id];
    if(!enabled(settings,event)||row.channel!==config.channel)return false;
    if(row.event==='payrollPublished'){
      const entry = payout(row.reference);
      return entry?.employee===row.recipient&&entry.created>=config.activatedAt&&entry.created>=clock()-maxLookback;
    }
    return row.slot===current()&&recipients(event,settings).includes(row.recipient);
  }
  function retry(body,actor){
    admin(actor);
    return transaction(() => {
      const row = typeof body?.id==='string'?delivery.get(body.id):null;
      const event = events.find(e => e.id===row?.event);
      if(!row||row.status!=='failed'||!event||!canDispatch(row,read(),event))fail('Повтор недоступен. Проверьте дату, настройки и статус доставки',409);
      db.prepare("UPDATE automation_center_delivery SET status='pending',detail='',updated=? WHERE id=?").run(clock(),row.id);
      journal.run(actor.id,'retry',clock(),row.id);
      return {ok:true};
    });
  }

  function enqueue(settings,day,minute){
    for(const event of events){
      const config = settings.events[event.id];
      if(!enabled(settings,event)||minute<config.time)continue;
      if(event.id==='payrollPublished'){
        const entries = db.prepare(`SELECT p.id,p.employee FROM pay_entries p JOIN pay_entry_approvers a ON a.entry=p.id
          JOIN employees e ON e.id=p.employee AND e.active=1
          WHERE p.kind='payout' AND p.voided_at IS NULL AND p.created>=? AND p.date<=?
          AND NOT EXISTS (SELECT 1 FROM automation_center_delivery d WHERE d.event='payrollPublished' AND d.slot=p.id AND d.recipient=p.employee AND d.channel='private')
          ORDER BY p.created,p.id LIMIT 100`).all(Math.max(clock()-maxLookback,config.activatedAt),day);
        for(const entry of entries)addDelivery.run(randomUUID(),event.id,entry.id,entry.employee,'private',entry.id,clock());
        continue;
      }
      for(const recipient of recipients(event,settings)){
        if(!slotDelivery.get(event.id,day,recipient,config.channel))addDelivery.run(randomUUID(),event.id,day,recipient,config.channel,'',clock());
      }
    }
  }

  async function send(row,event,settings,load){
    const day = current(), month = day.slice(0,7), previous = lastMonth();
    if(event.id==='salesSync'){
      for(const period of [previous,month]){
        const r = reports.view(period,{admin:true});
        if(!r.canSync)return {delivered:false,reason:'Настройте организацию и подключение МойСклад'};
        const result = await reports.sync({month:period},{id:'system:automation-center',admin:true});
        if(!result.ok)return {delivered:false,reason:'Не удалось обновить отчёт МойСклад'};
        if(!canDispatch(row,read(),event))return {skip:true};
      }
      return {delivered:true,reason:'Отчёты по обороту обновлены'};
    }
    if(event.id==='payrollPublished'){
      const entry = payout(row.reference);
      if(!entry)return {skip:true};
      const statement = payroll.statement(row.recipient,entry.month);
      const unit = statement.account.currency;
      const {bonus,kpi,advance,remaining} = statement.totals;
      return telegram.notifyCenter(row.recipient,`TAMEER · Выплата за ${entry.month}\nПроведено ${entry.date}: ${money(entry.amount)} ${unit}\nПремии: ${money(bonus+kpi)} ${unit}\nАвансы: ${money(advance)} ${unit}\nОсталось к выплате: ${money(remaining)} ${unit}`,new URL('/employee',publicURL).href,'Мой кабинет');
    }

    let count, message, href = 'hrcenter', period = month, task;
    if(event.id==='kpiReview'){
      count = load(month).kpi?.summary.attention||0;
      message = `KPI · Сотрудников с показателями для проверки: ${count}`;
      href = 'finance';
    } else if(event.id==='monthReview'){
      period = previous;
      const summary = load(previous).readiness?.summary;
      count = (summary?.attention||0)+(summary?.pending||0);
      message = `Закрытие ${previous} · Расчётов для проверки: ${count}`;
      href = 'hrcenter';
    } else if(event.id==='queueReview'){
      const all = [...new Map([...load(previous).queue,...load(month).queue].map(r => [r.id,r])).values()];
      const items = settings.events.queueReview.responsibleIds.length?all:all.filter(r => r.responsibleIds.includes(row.recipient));
      count = items.length;
      message = `TAMEER · Ko‘rib chiqilishi kerak bo‘lgan ochiq vazifalar: ${count}`;
      if(count===1){
        href = (items[0].href||href).replace(/^\/?#/,'');
        period = items[0].date?.slice(0,7)||month;
        task = items[0].id;
      }
    } else if(event.id==='coverageReview'){
      const end = dayAdd(day,6);
      const next = end.slice(0,7);
      const items = next===month?load(month).coverage:[...load(month).coverage,...load(next).coverage];
      count = items.filter(r => r.date>=day&&r.date<=end&&['unassigned','conflict'].includes(r.status)).length;
      message = `TAMEER · Keyingi 7 kunda o‘rinbosar bo‘yicha tekshiruv kerak bo‘lgan smenalar: ${count}`;
      href = row.channel==='group'?'':'hr';
    } else {
      const h = health(month);
      count = [h.attendance,h.payroll,h.integration].filter(x => !x.connected||x.lastError||x.stale||x.advanceError).length;
      count += h.deliveries.filter(x => x.event!=='integrationHealth'&&['failed','uncertain'].includes(x.status)&&x.updatedAt>=clock()-86400000).length;
      message = `TAMEER · Oxirgi 24 soatda ulanish va xabar yuborish muammolari: ${count}`;
    }
    if(!count)return {skip:true};
    const center = row.channel==='private'&&employeeAdmin.get(row.recipient);
    const link = !href?null:center?jobLink(period,'automation',event.feature,task):jobLink(period,href);
    const bot = event.bot==='attendance'?attendance:telegram;
    return bot.notifyCenter(row.recipient,message,link,event.bot==='attendance'?'TAMEER’ni ochish':'Открыть TAMEER',{group:row.channel==='group'});
  }

  let running = false;
  async function scan(){
    if(running)return;
    running = true;
    try {
      const settings = read();
      if(!settings.features.bots.enabled)return;
      const day = current();
      const minute = new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(clock());
      enqueue(settings,day,minute);
      const cache = new Map();
      const load = month => {
        if(!cache.has(month))cache.set(month,build(month,settings));
        return cache.get(month);
      };
      const pending = db.prepare("SELECT * FROM automation_center_delivery WHERE status='pending' ORDER BY CASE channel WHEN 'service' THEN 0 ELSE 1 END,updated,id LIMIT 30").all();
      for(const row of pending){
        const event = events.find(e => e.id===row.event);
        if(!event)continue;
        const fresh = read();
        if(!canDispatch(row,fresh,event)){
          db.prepare("UPDATE automation_center_delivery SET status='skipped',detail='Событие или получатель уже недоступны',updated=? WHERE id=? AND status='pending'").run(clock(),row.id);
          continue;
        }
        if(minute<fresh.events[event.id].time)continue;
        if(!db.prepare("UPDATE automation_center_delivery SET status='sending',updated=? WHERE id=? AND status='pending'").run(clock(),row.id).changes)continue;
        try{
          const result = await send(row,event,fresh,load);
          finish.run(result.delivered?'sent':result.skip?'skipped':result.uncertain?'uncertain':'failed',result.reason||'',clock(),row.id);
        }catch(error){
          finish.run(error?.uncertain?'uncertain':'failed',error?.uncertain?'Сервис не подтвердил доставку':'Не удалось выполнить действие. Проверьте интеграцию и настройки.',clock(),row.id);
        }
      }
    } finally {running=false;}
  }

  return {view,configure,retry,scan};
}
