/* Shared payroll centre: classic dashboard and the authenticated employee Mini App. */
(()=>{
 const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const amount=(v,c='UZS')=>Number.isSafeInteger(v)?(v/100).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' '+escape(c):'—';
 const decimal=v=>Number.isSafeInteger(v)?(v/100).toFixed(2):'';
 const number=v=>typeof v==='number'&&Number.isFinite(v)?String(v):'—';
 const block=(title,body)=>'<section class="panel payroll-center-section"><h2>'+escape(title)+'</h2>'+body+'</section>';
 const notice=t=>'<p class="help">'+escape(t)+'</p>';
 const btn=(title,action,attrs='',disabled=false)=>'<button type="button" class="btn secondary" data-pc-action="'+escape(action)+'" '+attrs+(disabled?' disabled':'')+'>'+escape(title)+'</button>';
 const table=(headers,rows)=>'<div class="table-wrap" style="max-width:100%;overflow-x:auto"><table class="data-table"><thead><tr>'+headers.map(x=>'<th>'+escape(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(x=>'<td>'+x+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
 const empty=t=>'<p class="help">'+escape(t)+'</p>';
 const label=(title,html)=>'<label>'+escape(title)+html+'</label>';
 const input=(name,value='',type='text',extra='')=>'<input name="'+escape(name)+'" type="'+type+'" value="'+escape(value)+'" '+extra+'>';
 const reason=title=>label(title||'Основание', '<textarea name="reason" required minlength="3" maxlength="1000"></textarea>');
 const select=(name,rows,value,extra='')=>'<select name="'+name+'" '+extra+'>'+rows.map(([id,title])=>'<option value="'+escape(id)+'"'+(String(id)===String(value)?' selected':'')+'>'+escape(title)+'</option>').join('')+'</select>';
 const features={grades:'Уровни и рост зарплаты',coach:'Личный помощник KPI',calendar:'Календарь денег',payouts:'Ведомости и сверка выплат',supplements:'Замещение и дополнительные работы',checks:'Проверка ошибок'};
 let centre=null,centreError='',loadTicket=0;
 const stateLabel=(s,language='ru')=>(language==='uz'?{draft:'Loyiha',agreed:'Kelishilgan',completed:'Bajarilgan · hisoblash kutilmoqda',posted:'Hisoblangan',cancelled:'Bekor qilingan',active:'Amalda',scheduled:'Rejalangan',historical:'Tarix',paid:'To‘langan',partial:'Qisman',pending:'Kutilmoqda',open:'Kutilmoqda',proposal:'Loyiha · hisoblanmagan',ready:'Tayyor',stale:'Hisob o‘zgargan','needs-review':'Tekshirish kerak'}:{draft:'Проект',agreed:'Согласовано',completed:'Выполнено · ожидает начисления',posted:'Начислено',cancelled:'Отменено',active:'Действует',scheduled:'Запланировано',historical:'История',paid:'Выплачено',partial:'Частично',pending:'Ожидает',open:'Ожидает',proposal:'Проект · не начислено',ready:'Готово',stale:'Расчёт изменился','needs-review':'Нужна проверка'})[s]||s||'—';
 async function loadCentre(month){const ticket=++loadTicket;centreError='';try{const result=await api('payroll/center?month='+encodeURIComponent(month));if(ticket===loadTicket)centre=result;}catch(error){if(ticket===loadTicket){centre=null;centreError=error.message;}}}
 function form(title,body,path,extra={},map=null){const submit=path.endsWith('/payment-record')?'Подтвердить факт выплаты':path.endsWith('/supplement-post')?'Подтвердить начисление':path.endsWith('/payout-preview')?'Подготовить ведомость':'Сохранить';open(title,'<form class="form payroll-center-form">'+body+'<button class="btn">'+submit+'</button><p role="status"></p></form>');const f=modal.querySelector('form'),requestId=crypto.randomUUID();f.onsubmit=async event=>{event.preventDefault();const button=f.querySelector('button'),status=f.querySelector('[role=status]');button.disabled=true;try{const values=Object.fromEntries(new FormData(f)),payload=map?map(values,f):values;const r=await api(path,{...extra,...payload,requestId});modal.close();await load();toast(r?.pendingApproval?'Подготовлено. Ожидает второго финансового подтверждения.':'Сохранено');}catch(error){status.textContent=error.message;button.disabled=false;}};return f;}
 function staffOptions(){const known=centre?.growth?.employees;return (known?.length?known:payData?.rows||[]).map(r=>{const e=r.employee;return [e.id,e.name];});}
 function adminSettings(){
  const c=centre.settings,accounts=centre.accounts||[];
  form('Настройки KPI и выплат',notice('Включайте нужные разделы и назначайте ответственных. Назначение не выдаёт новые права аккаунта.')+
   (accounts.length?'':notice('Создайте/подтвердите аккаунт с правом изменения зарплаты в «Аккаунты и доступы»; администратор может управлять функциями без назначения.'))+
   Object.entries(features).map(([key,title])=>'<fieldset><legend>'+escape(title)+'</legend><label class="check"><input type="checkbox" name="feature-'+key+'"'+(c.features?.[key]?' checked':'')+'> Включено</label>'+label('Ответственные', '<select name="responsible-'+key+'" multiple size="'+Math.min(4,Math.max(2,accounts.length))+'">'+accounts.map(a=>'<option value="'+escape(a.id)+'"'+(c.responsibles?.[key]?.includes(a.id)?' selected':'')+'>'+escape(a.name||a.username||a.id)+'</option>').join('')+'</select>')+'</fieldset>').join('')+
   label('Плановый аванс, % от базы',input('advancePercent',c.advancePercent,'number','min="0" max="100" step="1" required'))+
   '<h3>Проверенный денежный остаток · UZS</h3>'+label('Доступные деньги',input('forecastCash',decimal(c.forecastCash),'number','min="0" step="0.01"'))+
   label('Неприкосновенный резерв',input('forecastReserve',decimal(c.forecastReserve??0),'number','min="0" step="0.01" required'))+
   '<label class="check"><input name="verifyCash" type="checkbox"> Денежный остаток проверен сейчас</label>'+notice('Дата последней проверки: '+(c.forecastAsOf?new Date(c.forecastAsOf).toLocaleString('ru-RU'):'не проверен')+'. Плановые суммы не являются банковскими платежами.')+
   label('Предупреждать об изменении заработка более, %',input('anomalyPercent',c.anomalyPercent,'number','min="1" max="1000" required'))+
   label('Искать похожие премии за, дней',input('duplicateWindowDays',c.duplicateWindowDays,'number','min="1" max="90" required'))+
   '<label class="check"><input type="checkbox" name="documentRequired"'+(c.documentRequired?' checked':'')+'> Требовать ссылку или номер платёжного документа</label>'+reason('Основание изменения настроек'),
   'payroll/center/settings',{version:c.version},(v,f)=>({features:Object.fromEntries(Object.keys(features).map(k=>[k,f.elements['feature-'+k].checked])),responsibles:Object.fromEntries(Object.keys(features).map(k=>[k,[...f.elements['responsible-'+k].selectedOptions].map(o=>o.value)])),advancePercent:Number(v.advancePercent),forecastCash:v.forecastCash===''?null:v.forecastCash,forecastReserve:v.forecastReserve,verifyCash:f.elements.verifyCash.checked,anomalyPercent:Number(v.anomalyPercent),duplicateWindowDays:Number(v.duplicateWindowDays),documentRequired:f.elements.documentRequired.checked,reason:v.reason}));
 }
 function gradeForm(id){
  const g=centre.growth?.grades?.find(g=>g.id===id),currencies=['UZS','RUB','USD','EUR','KZT'].map(x=>[x,x]);
  form(g?'Изменить уровень':'Создать уровень',label('Название',input('name',g?.name||'','text','required maxlength="100"'))+
   label('Порядок уровня',input('level',g?.level||1,'number','required min="1" max="100" step="1"'))+label('Валюта',select('currency',currencies,g?.currency||'UZS'))+
   [['baseMin','Минимальная база'],['baseMid','Средняя база'],['baseMax','Максимальная база'],['maxKpi','Максимальная премия KPI']].map(([k,n])=>label(n,input(k,decimal(g?.[k]),'number','min="0" step="0.01"'))).join('')+
   label('Требования и условия повышения','<textarea name="requirements" maxlength="2000">'+escape(g?.requirements||'')+'</textarea>')+
   '<label class="check"><input type="checkbox" name="active"'+(g?.active===false?'':' checked')+'> Уровень доступен</label>'+notice('Диапазон — ориентир согласования. Сохранение уровня не меняет оклады и начисления. Пустая сумма означает «не задано».'),
   'payroll/center/growth/grade-save',{...(g?{id:g.id}:{}),version:g?.version||0},(v,f)=>({...v,level:Number(v.level),active:f.elements.active.checked}));
 }
 function assignGrade(employee){
  const row=centre.growth?.employees?.find(r=>r.employee.id===employee);if(!row)return;
  form('Назначить уровень · '+row.employee.name,label('Уровень',select('gradeId',(centre.growth.grades||[]).filter(g=>g.active).map(g=>[g.id,g.name]),row.grade?.gradeId,'required'))+
   label('Дата действия',input('effectiveDate',centre.growth.asOf||data.today,'date','required'))+reason()+notice('Назначение сохраняет историю. Денежная база и премия согласуются отдельно.'),
   'payroll/center/growth/grade-assign',{employee,version:row.assignmentVersion},v=>({...v,gradeVersion:centre.growth.grades.find(g=>g.id===v.gradeId)?.version}));
 }
 function coachHtml(c,language='ru'){
  if(!c)return '';const uz=language==='uz',copy=(r,u)=>uz?u:r,all=[...(c.manualMetrics||[]),...(c.role?.metrics||[])],currency=c.currency||'UZS';
  const advice=m=>uz?({frozen:'Ko‘rsatkich allaqachon hisoblangan. O‘zgartirish alohida kelishilgan tuzatish orqali amalga oshiriladi.','verify-fact':'Reja va haqiqiy natijani tasdiqlang. Ma’lumotsiz mukofot o‘sishi hisoblanmaydi.','target-reached':'Rejaga erishildi. Sifat va natija tasdiqlarini saqlang.','improve-result':'Rejaga erishish uchun mas’ul bilan ishlarni kelishing va yangi natijani tasdiqlang.'}[m.action]||m.whatToDo||''):m.whatToDo||'';
  return '<div class="pay-record"><h3>'+copy('Заработано и планы','Hisoblangan mablag‘ va rejalar')+'</h3>'+notice(uz?'Tasdiqlangan mablag‘ alohida ko‘rsatilgan. Shaxsiy va jamoaviy KPI loyihalari avtomatik qo‘shilmaydi. Prognoz hisoblangan yoki va’da qilingan to‘lov emas.':c.notice||'Проекты показаны отдельно от начислений.')+
   table([copy('Подтверждено','Tasdiqlangan'),copy('Сумма','Summa')],[[copy('Начислено','Hisoblangan'),amount(c.confirmed?.accrued,currency)],[copy('Осталось получить','Olish uchun qoldiq'),amount(c.confirmed?.remaining,currency)],[copy('Работы ожидают подтверждения','Ishlar tasdiqni kutmoqda'),amount(c.pendingWorkMinor,currency)]])+
   (c.role?notice(copy('Должностной KPI: ','Lavozim KPI: ')+number(c.role.score)+'% · '+copy('проект ','loyiha ')+amount(c.role.projectMinor,currency)):'')+
   (c.team?notice(copy('Командный KPI · ','Jamoaviy KPI · ')+c.team.month+': '+amount(c.team.proposal,currency)+' · '+stateLabel(c.team.status,language)):'')+
   (all.length?table([copy('Показатель','Ko‘rsatkich'),copy('Факт / план','Amal / reja'),copy('Что улучшить','Nimani yaxshilash kerak'),copy('Возможная прибавка','Ehtimoliy qo‘shimcha')],all.map(m=>[escape(m.label),m.missing?copy('Нет подтверждённого факта','Tasdiqlangan ma’lumot yo‘q'):escape(number(m.actual)+' / '+number(m.target)+' '+(m.unit||'')+' · '+number(m.score)+'%'),escape(advice(m))+(m.shortfall>0?'<span class="sub">'+copy('До плана: ','Rejagacha: ')+escape(number(m.shortfall))+'</span>':'')+'<span class="sub">'+escape(m.source||'')+'</span>',m.posted?copy('Уже начислено','Hisoblangan'):Number.isSafeInteger(m.potentialBonusIncrementMinor)?amount(m.potentialBonusIncrementMinor,currency):copy('Ожидает данных','Ma’lumot kutilmoqda')])):empty(copy('Показатели KPI ещё не заданы.','KPI ko‘rsatkichlari hali belgilanmagan.')))+
   notice(copy('Возможная прибавка — сценарий достижения плана, не начисление и не обещанная выплата.','Ehtimoliy qo‘shimcha — rejaga erishish ssenariysi, bu hisoblangan yoki va’da qilingan to‘lov emas.'))+'</div>';
 }
 function growthPanel(){
  const g=centre.growth;if(!g)return '';let html='';
  if(centre.settings?.features?.grades!==false&&g.enabled?.grades)html+=block('Уровни и рост зарплаты',notice('Уровень показывает требования и диапазон оплаты. История сохраняется; оклад сам не меняется.')+
   (g.canManage?btn('Создать уровень','grade-new'):'')+
   table(['Уровень','База: минимум / середина / максимум','Максимум KPI','Требования','Действия'],(g.grades||[]).map(r=>[escape(r.name)+'<span class="sub">№ '+number(r.level)+(r.active?'':' · архив')+'</span>',[r.baseMin,r.baseMid,r.baseMax].map(n=>amount(n,r.currency)).join(' / '),amount(r.maxKpi,r.currency),escape(r.requirements||'—'),g.canManage?btn('Изменить','grade-edit','data-id="'+escape(r.id)+'"'):'']))+
   table(['Сотрудник','Уровень','Дата действия','Действия'],(g.employees||[]).map(r=>[escape(r.employee.name),escape(r.grade?.gradeName||'Не назначен'),escape(r.grade?.effectiveDate||'—'),g.canManage?btn('Назначить уровень','grade-assign','data-employee="'+escape(r.employee.id)+'"'):''])));
  if(centre.settings?.features?.coach!==false&&g.enabled?.coach)html+=block('Помощник по KPI',notice('Подсказки используют подтверждённые показатели. Отсутствующие данные не превращаются в нулевую оценку.')+(g.employees||[]).map(r=>'<details><summary>'+escape(r.employee.name)+'</summary>'+coachHtml(r.coach)+'</details>').join(''));
  return html;
 }
 function calendarHtml(c,own=false,language='ru'){
  if(!c)return '';const uz=language==='uz',copy=(r,u)=>uz?u:r;
  return notice(copy('План выплат по расчётным месяцам. Аванс уменьшает будущий остаток зарплаты; даты не создают перевод денег.','Hisob oylari bo‘yicha to‘lov rejasi. Avans kelajakdagi ish haqi qoldig‘ini kamaytiradi; sana pul o‘tkazmasini yaratmaydi.'))+
   (c.events?.length?table([copy('Дата','Sana'),...(own?[]:[copy('Сотрудник','Xodim')]),copy('За месяц / вид','Oy / tur'),copy('Плановая сумма','Reja summasi')],c.events.map(r=>[escape(r.date)+(r.overdue?'<span class="sub">'+copy('Просроченный план','Muddati o‘tgan reja')+'</span>':''),...(own?[]:[escape(r.name)]),escape(r.month)+' · '+copy(r.kind==='advance'?'Аванс':'Зарплата',r.kind==='advance'?'Avans':'Ish haqi'),amount(r.amount,r.currency)])):empty(copy('Плановых выплат за период нет.','Davr uchun rejalangan to‘lovlar yo‘q.')))+
   (!own&&c.cash?'<div class="notice"><strong>'+copy('Проверенный остаток денег: ','Tekshirilgan pul qoldig‘i: ')+(c.cash.verified?amount(c.cash.available,c.cash.currency):copy('Не проверен','Tekshirilmagan'))+'</strong><p>'+copy('Обязательства: ','Majburiyatlar: ')+amount(c.cash.required,c.cash.currency)+' · '+copy('Нехватка: ','Yetishmovchilik: ')+(c.cash.verified?amount(c.cash.gap,c.cash.currency):'—')+'</p></div>':'');
 }
 function batchesPanel(){
  const c=centre.control;if(centre.settings?.features?.payouts===false||!c?.capabilities?.payouts)return '';
  return block('Ведомости и сверка выплат',notice('Ведомость — план и сверка. Запись выплаты фиксирует уже выданные деньги; банковский перевод не выполняется.')+
   (c.capabilities.write?.payouts?btn('Подготовить ведомость','batch-new'):'')+
   ((c.batches||[]).map(b=>'<details><summary>'+escape(b.date+' · '+(b.kind==='advance'?'Авансы':'Зарплата')+' · '+b.month)+'</summary><p><a class="btn secondary" href="/api/payroll/center/batch.xlsx?id='+encodeURIComponent(b.id)+'">Скачать Excel</a></p>'+
    table(['Сотрудник','План / остаток','Учтено','Сверка','Действия'],b.rows.map(r=>[escape(r.name),amount(r.proposed,r.currency)+'<span class="sub">Остаток '+amount(r.remaining,r.currency)+'</span>',amount(r.paid,r.currency),escape(stateLabel(r.status))+(r.linkedEntries||[]).map(e=>'<span class="sub">'+escape(e.date+' · '+(e.documentRef||'Документ не указан'))+' · '+amount(e.amount,r.currency)+'</span>').join(''),(r.canRecord?btn('Записать выплату','payment-record','data-id="'+escape(b.id)+'" data-employee="'+escape(r.employee)+'"'):'')+(r.canLink?btn('Связать с операцией','payment-link','data-id="'+escape(b.id)+'" data-employee="'+escape(r.employee)+'"'):'')]))+'</details>').join('')||empty('Ведомостей пока нет.')));
 }
 function supplementRows(rows,own=false,language='ru'){
  const uz=language==='uz',copy=(r,u)=>uz?u:r;
  return (rows||[]).map(r=>'<article class="pay-record"><h3>'+escape((own?'':r.name+' · ')+copy(r.type==='replacement'?'Замещение':'Дополнительная работа',r.type==='replacement'?'O‘rinbosarlik':'Qo‘shimcha ish'))+'</h3><p>'+escape(r.from+' — '+r.to)+' · '+escape(stateLabel(r.status,language))+'</p><p>'+escape(r.reason||'')+'</p><p>'+copy('Согласованный максимум: ','Kelishilgan maksimum: ')+amount(r.maximum,r.currency)+' · '+copy('Подтверждённый объём: ','Tasdiqlangan hajm: ')+escape(decimal(r.actualQuantity)||'—')+' · '+copy('К начислению: ','Hisoblash uchun: ')+amount(r.amount,r.currency)+'</p>'+notice(r.evidence||'')+
   (own?(r.canComplete?'<details><summary>'+copy('Подтвердить выполненную работу','Bajarilgan ishni tasdiqlash')+'</summary><form class="form" data-pc-own-complete="'+escape(r.id)+'">'+label(copy('Фактический объём','Haqiqiy hajm'),input('actualQuantity',decimal(r.plannedQuantity),'number','min="0.01" step="0.01" required'))+label(copy('Подтверждение / ссылка на результат','Tasdiq / natijaga havola'),'<textarea name="evidence" required maxlength="2000"></textarea>')+reason(copy('Комментарий','Izoh'))+'<button class="btn">'+copy('Отправить на проверку','Tekshirish uchun yuborish')+'</button><p role="status"></p></form></details>':''):
    '<div class="row">'+(r.canApprove?btn('Согласовать условия','supplement-approve','data-id="'+escape(r.id)+'"'):'')+(r.canComplete?btn('Подтвердить объём','supplement-complete','data-id="'+escape(r.id)+'"'):'')+(r.canPost?btn('Проверить и начислить','supplement-post','data-id="'+escape(r.id)+'"'):'')+(r.canCancel?btn('Отменить','supplement-cancel','data-id="'+escape(r.id)+'"'):'')+'</div>')+'</article>').join('')||empty(copy('Дополнительных работ пока нет.','Hozircha qo‘shimcha ishlar yo‘q.'));
 }
 function checksHtml(rows,own=false,language='ru'){
  const uz=language==='uz',copy=(r,u)=>uz?u:r;
  const message=r=>uz?({'missing-account':'Oy uchun ish haqi hisob-kitobi yaratilmagan','invalid-base':'Oylik asosiy haqni tekshiring','accrual-change':'Hisoblangan summa oldingi oydan sezilarli farq qiladi','advance-over-earned':'Berilgan avans ushlanmalardan keyingi hisoblangan summadan oshgan','similar-bonus':'O‘xshash qo‘lda kiritilgan mukofotlar: alohida asoslarini tekshiring','missing-payment-document':'To‘lov uchun tasdiqlovchi hujjat ko‘rsatilmagan'}[r.code]||r.message):r.message;
  const details=r=>{const d=r.details;if(typeof d==='string')return notice(d);if(!d)return '';const labels={base:['База','Asosiy qism'],amount:['Сумма','Summa'],previous:['Ранее начислено','Oldin hisoblangan'],current:['Сейчас начислено','Hozir hisoblangan'],advance:['Выданный аванс','Berilgan avans'],earned:['Начислено после удержаний','Ushlanmalardan keyin hisoblangan']},pieces=[];
   for(const [key,names] of Object.entries(labels))if(Number.isSafeInteger(d[key]))pieces.push(copy(...names)+': '+amount(d[key],r.currency||'UZS'));
   if(d.previousMonth)pieces.push(copy('Предыдущий месяц: ','Oldingi oy: ')+d.previousMonth);
   if(typeof d.changePercent==='number')pieces.push(copy('Изменение: ','O‘zgarish: ')+d.changePercent+'%');
   if(typeof d.threshold==='number')pieces.push(copy('Порог предупреждения: ','Ogohlantirish chegarasi: ')+d.threshold+'%');
   if(d.date)pieces.push(copy('Дата: ','Sana: ')+d.date);
   if(Array.isArray(d.dates))pieces.push(copy('Даты: ','Sanalar: ')+d.dates.join(', '));
   if(d.reason)pieces.push(copy('Основание: ','Asos: ')+d.reason);
   return pieces.map(notice).join('');};
  return notice(copy('Сигналы помогают проверить расчёт. Предупреждение само не удерживает деньги и не является решением о нарушении.','Belgilar hisobni tekshirishga yordam beradi. Ogohlantirish o‘z-o‘zidan pul ushlamaydi va qoidabuzarlik haqidagi qaror emas.'))+
   ((rows||[]).map(r=>'<article class="pay-record"><h3>'+escape((own?'':r.name+' · ')+message(r))+'</h3>'+details(r)+'<p>'+copy(r.reviewed?'Проверено':'Ожидает проверки',r.reviewed?'Tekshirilgan':'Tekshirish kutilmoqda')+'</p>'+notice(r.comment||'')+(!own&&r.canReview?btn('Оставить результат проверки','check-review','data-id="'+escape(r.id)+'"'):'')+'</article>').join('')||empty(copy('Сигналов для проверки нет.','Tekshirish uchun belgi yo‘q.')));
 }
 function panelCentre(){
  if(!centre)return centreError?block('KPI и выплаты','<p class="notice">'+escape(centreError)+'</p>'):'';
  const c=centre.control||{},f=centre.settings?.features||{};
  return '<div id="payroll-center" class="payroll-center"><section class="panel"><div class="row"><h2>KPI и выплаты</h2>'+(centre.canConfigure?btn('Настроить 6 функций','settings'):'')+'</div><div class="metrics">'+Object.entries(features).map(([k,t])=>'<article><span>'+escape(t)+'</span><strong>'+escape(f[k]?'Включено':'Отключено')+'</strong></article>').join('')+'</div></section>'+growthPanel()+
   (f.calendar!==false&&c.capabilities?.calendar?block('Календарь денег · 25-е и 10-е',calendarHtml(c.calendar)):'')+batchesPanel()+
   (f.supplements!==false&&c.capabilities?.supplements?block('Замещение и дополнительные работы',(c.capabilities.write?.supplements?btn('Добавить работу / замещение','supplement-new'):'')+supplementRows(c.supplements)):'')+
   (f.checks!==false&&c.capabilities?.checks?block('Проверка ошибок перед зарплатой',checksHtml(c.checks)):'')+'</div>';
 }
 function batchForm(){
  form('Подготовить ведомость',label('Вид',select('kind',[['advance','Авансы'],['payout','Зарплата']],'payout'))+label('Плановая дата',input('date',data.today,'date','required'))+
   '<fieldset><legend>Сотрудники</legend>'+staffOptions().map(([id,name])=>'<label class="check"><input type="checkbox" name="employee" value="'+escape(id)+'" checked> '+escape(name)+'</label>').join('')+'</fieldset>'+notice('Суммы будут рассчитаны по выбранному расчётному месяцу. Подготовка не создаёт выплаты.'),
   'payroll/center/control/payout-preview',{month:centre.month},(v,f)=>({kind:v.kind,date:v.date,employees:[...f.querySelectorAll('[name=employee]:checked')].map(x=>x.value)}));
 }
 function paymentForm(batchId,employee,link=false){
  const b=centre.control.batches.find(b=>b.id===batchId),r=b?.rows.find(r=>r.employee===employee);if(!r)return;
  if(link&&!(r.linkCandidates||[]).length)return;
  form((link?'Связать уже записанную выплату · ':'Записать фактическую выплату · ')+r.name,
   notice('Расчётный месяц '+b.month+'. План '+amount(r.proposed,r.currency)+', учтено '+amount(r.paid,r.currency)+'.')+
   (link?label('Уже записанная выплата',select('entryId',r.linkCandidates.map(e=>[e.id,e.date+' · '+amount(e.amount,r.currency)+' · '+e.reason]),'','required'))+
    label('Номер или ссылка на платёжный документ',input('documentRef','','text','maxlength="200"')):
    label('Фактически выданная сумма, '+r.currency,input('amount',decimal(Math.max(0,Math.min(r.proposed-r.paid,r.remaining))),'number','min="0.01" step="0.01" required'))+
    label('Дата фактической выплаты',input('date',data.today,'date','required max="'+data.today+'"'))+
    label('Номер или ссылка на платёжный документ',input('documentRef','','text','maxlength="200"'+(centre.settings.documentRequired?' required':''))))+
   reason()+notice(link?'Повторная выплата не создаётся. Операция должна принадлежать этому сотруднику и расчётному месяцу.':'Деньги должны быть уже выданы. Изменение может потребовать второго финансового подтверждения.'),
   'payroll/center/control/'+(link?'payment-link':'payment-record'),{batchId,employee,version:b.version});
 }
 function supplementForm(){
  form('Замещение или дополнительная работа',label('Сотрудник',select('employee',staffOptions(),'','required'))+
   label('Вид',select('type',[['extra','Дополнительная работа'],['replacement','Замещение']],'extra'))+
   label('Кого заменяет',select('replacedEmployee',[['','Не применяется'],...staffOptions()],''))+
   label('Начало',input('from',centre.month+'-01','date','required'))+label('Окончание',input('to',centre.month+'-01','date','required'))+
   label('Способ расчёта',select('mode',[['fixed','Фиксированная сумма'],['hour','За час'],['unit','За единицу']],'fixed'))+
   label('Согласованная сумма / ставка',input('rate','','number','min="0.01" step="0.01" required'))+
   label('Плановый объём (для фиксированной суммы — 1)',input('plannedQuantity','1','number','min="0.01" step="0.01" required'))+reason('Описание работы и основание')+
   notice('Сначала согласуются условия, затем фактический объём. Начисление в зарплату подтверждается отдельно.'),
   'payroll/center/control/supplement-create',{month:centre.month},v=>({...v,...(v.replacedEmployee?{}:{replacedEmployee:null})}));
 }
 function supplementAction(id,action){
  const r=centre.control.supplements.find(r=>r.id===id);if(!r)return;
  const titles={approve:'Согласовать условия',complete:'Подтвердить выполненный объём',post:'Проверить и начислить',cancel:'Отменить дополнительную работу'};
  form(titles[action]+' · '+r.name,notice(r.reason)+notice('Согласованный максимум '+amount(r.maximum,r.currency)+'. К начислению '+amount(r.amount,r.currency)+'.')+
   (action==='complete'?label('Фактический объём',input('actualQuantity',decimal(r.plannedQuantity),'number','min="0.01" step="0.01" required'))+label('Подтверждение выполнения','<textarea name="evidence" required maxlength="2000">'+escape(r.evidence||'')+'</textarea>'):'')+reason()+
   (action==='post'?notice('Начисление не является выплатой денег. Повторное начисление блокируется; при включённом согласовании нужен второй ответственный.'):''),
   'payroll/center/control/'+({approve:'approve-plan',complete:'complete',post:'supplement-post',cancel:'supplement-cancel'}[action]),{id,version:r.version,...(action==='post'?{expectedAmount:r.amount,fingerprint:r.fingerprint}:{})});
 }
 function checkForm(id){const c=centre.control.checks.find(c=>c.id===id);if(!c)return;form('Результат проверки',notice(c.name+' · '+c.message)+label('Комментарий','<textarea name="comment" required minlength="3" maxlength="2000">'+escape(c.comment||'')+'</textarea>')+notice('Комментарий сохраняет результат проверки. Денежные записи не меняются.'),'payroll/center/control/check-review',{id,fingerprint:c.fingerprint,month:centre.month});}
 function bindCentre(scope=document){scope.querySelectorAll('[data-pc-action]').forEach(b=>b.onclick=()=>{const a=b.dataset.pcAction,id=b.dataset.id;if(a==='settings')return adminSettings();if(a==='grade-new'||a==='grade-edit')return gradeForm(id);if(a==='grade-assign')return assignGrade(b.dataset.employee);if(a==='batch-new')return batchForm();if(a==='payment-record'||a==='payment-link')return paymentForm(id,b.dataset.employee,a==='payment-link');if(a==='supplement-new')return supplementForm();if(a.startsWith('supplement-'))return supplementAction(id,a.slice('supplement-'.length));if(a==='check-review')return checkForm(id);});}
 function ownHtml(value,language='ru'){
  if(!value)return '';const uz=language==='uz',copy=(r,u)=>uz?u:r,g=value.growth||{},c=value.control||{},f=value.features||value.settings?.features||{},enabled=k=>f[k]!==false&&(g.enabled?.[k]!==false),wrap=(title,html)=>'<section class="card panel payroll-center-own"><h2>'+copy(...title)+'</h2>'+html+'</section>';
  let html='';
  if(enabled('grades')&&g.grade){const r=g.grade;html+=wrap(['Мой уровень и рост зарплаты','Darajam va ish haqining o‘sishi'],'<h3>'+escape(r.gradeName)+'</h3>'+notice(r.requirements||'')+notice(copy('Действует с ','Amal qiladi: ')+r.effectiveDate)+table([copy('Диапазон базы','Asosiy qism oralig‘i'),copy('Максимум KPI','KPI maksimumi')],[[amount(r.baseMin,r.currency)+' — '+amount(r.baseMax,r.currency),amount(r.maxKpi,r.currency)]])+
   notice(copy('Уровень не меняет начисления автоматически.','Daraja hisoblangan mablag‘ni avtomatik o‘zgartirmaydi.'))+
   ((g.gradeHistory||[]).length?'<details><summary>'+copy('История уровней','Darajalar tarixi')+'</summary>'+g.gradeHistory.map(h=>notice(h.effectiveDate+' · '+h.gradeName+' · '+stateLabel(h.status,language))).join('')+'</details>':''));}
  else if(enabled('grades'))html+=wrap(['Мой уровень и рост зарплаты','Darajam va ish haqining o‘sishi'],empty(copy('Уровень пока не назначен. Требования и диапазон оплаты появятся после согласования.','Daraja hali belgilanmagan. Talablar va ish haqi oralig‘i kelishilgandan so‘ng paydo bo‘ladi.')));
  if(value.kpiVisible!==false&&enabled('coach')&&g.coach)html+=wrap(['Помощник по KPI','KPI yordamchisi'],coachHtml(g.coach,language));
  if(f.calendar!==false&&c.calendar)html+=wrap(['Мой календарь выплат','To‘lovlar taqvimim'],calendarHtml(c.calendar,true,language));
  if(f.payouts!==false)html+=wrap(['Мои ведомости выплат','To‘lov qaydnomalarim'],(c.batches||[]).map(b=>'<article class="pay-record"><h3>'+escape(b.month+' · '+b.date)+'</h3>'+(b.rows||[]).map(r=>notice(copy('План: ','Reja: ')+amount(r.proposed,r.currency)+' · '+copy('Учтено: ','Hisobga olingan: ')+amount(r.paid,r.currency))).join('')+'</article>').join('')||empty(copy('Ведомостей за этот месяц пока нет.','Bu oy uchun qaydnoma hali yo‘q.')));
  if(f.supplements!==false)html+=wrap(['Замещение и дополнительные работы','O‘rinbosarlik va qo‘shimcha ishlar'],supplementRows(c.supplements,true,language));
  if(f.checks!==false)html+=wrap(['Проверка моего расчёта','Hisobimni tekshirish'],checksHtml(c.checks,true,language));
  return html;
 }
 function bindOwn(scope,value,language,send,reload){
  if(!value)return;scope.querySelectorAll('[data-pc-own-complete]').forEach(f=>f.onsubmit=async event=>{event.preventDefault();const r=value.control?.supplements?.find(r=>r.id===f.dataset.pcOwnComplete);if(!r||!r.canComplete)return;const button=f.querySelector('button'),status=f.querySelector('[role=status]');button.disabled=true;try{const v=Object.fromEntries(new FormData(f));await send({id:r.id,version:r.version,actualQuantity:v.actualQuantity,evidence:v.evidence,reason:v.reason});await reload();}catch(error){status.textContent=error.message;button.disabled=false;}});
 }
 globalThis.PayrollCenterUI={load:loadCentre,panel:panelCentre,bind:bindCentre,ownHtml,bindOwn,coachHtml,calendarHtml};
})();
