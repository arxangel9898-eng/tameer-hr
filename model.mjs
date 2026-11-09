export const EVENT_NAMES={in:'Приход',out:'Уход',break_start:'Начало перерыва',break_end:'Возврат',uniform:'Проверка формы',note:'Комментарий'};
export const AUTO_CLOSE_TIME='18:15';
export const AUTO_CLOSE_MARK='auto-close:'+AUTO_CLOSE_TIME;
export function localDate(ms=Date.now(),tz='Asia/Tashkent'){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms)).map(x=>[x.type,x.value]));
 return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`,parts:p};
}
export function dayAdd(day,n){return new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10)}
export function validDate(day){return /^\d{4}-\d{2}-\d{2}$/.test(day)&&!isNaN(Date.parse(day))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day}
export function zonedTime(day,time,tz){
 const target=Date.parse(`${day}T${time}:00Z`);let result=target;
 for(let i=0;i<3;i++){const {parts:p}=localDate(result,tz);const local=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);result+=target-local;}
 return result;
}
export function plan(day,settings,tz){return {start:zonedTime(day,settings.start,tz),end:zonedTime(settings.end<=settings.start?dayAdd(day,1):day,settings.end,tz)}}
export function shiftDay(now,settings,tz){const l=localDate(now,tz);return settings.end<=settings.start&&l.time<settings.end?dayAdd(l.date,-1):l.date}
export function summarize(shift,events,now=Date.now()){
 const ordered=[...events].sort((a,b)=>a.at-b.at||a.id-b.id), start=ordered.find(e=>e.kind==='in'), out=ordered.find(e=>e.kind==='out');
 if(!start)return {status:'Нет отметки',worked:0,breaks:0,late:0,early:0,extraBreak:0,in:null,out:null,uniform:'unknown',note:'Нет отметки прихода'};
 const stop=out?.at??Math.max(start.at,Math.min(now,shift.planned_end));
 let breakAt=null,breakMs=0;for(const e of ordered){if(e.kind==='break_start')breakAt=e.at;if(e.kind==='break_end'&&breakAt!==null){breakMs+=Math.max(0,Math.min(e.at,stop)-Math.min(breakAt,stop));breakAt=null}}
 if(breakAt!==null)breakMs+=Math.max(0,stop-breakAt);
 const last=ordered.filter(e=>['in','out','break_start','break_end'].includes(e.kind)).at(-1);
 const delta=Math.max(0,Math.ceil((start.at-shift.planned_start)/60000));
 const status=out?'Завершена':now>shift.planned_end?'Не закрыта':last?.kind==='break_start'?'Перерыв':'На смене';
 const autoClosed=out?.value===AUTO_CLOSE_MARK;
 return {status,worked:Math.max(0,Math.floor((stop-start.at-breakMs)/60000)),breaks:Math.floor(breakMs/60000),late:delta>shift.grace?delta:0,early:out?Math.max(0,Math.ceil((shift.planned_end-out.at)/60000)):0,extraBreak:Math.max(0,Math.floor(breakMs/60000)-shift.break_limit),in:start.at,out:out?.at??null,uniform:ordered.filter(e=>e.kind==='uniform').at(-1)?.value??'unknown',...(autoClosed?{autoClosed}:{}),note:!out?'Предварительно: уход не отмечен. Расчёт ограничен концом смены.':autoClosed?'Смена закрыта автоматически. Уход по видео не подтверждён.':''};
}
export function allowedActions(events){const k=events.filter(e=>['in','out','break_start','break_end'].includes(e.kind)).at(-1)?.kind;return !k?['in']:k==='out'?[]:k==='break_start'?['break_end','out']:['break_start','out']}
