import {deflateRawSync} from 'node:zlib';
import {localDate} from './model.mjs';

const workbookNs='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const documentRelationships='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationships='http://schemas.openxmlformats.org/package/2006/relationships';
const contentTypesNs='http://schemas.openxmlformats.org/package/2006/content-types';
const spreadsheetContentType='application/vnd.openxmlformats-officedocument.spreadsheetml';
const escapeXml=value=>String(value??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,'')
 .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const relationship=(id,type,target)=>`<Relationship Id="rId${id}" Type="${documentRelationships}/${type}" Target="${target}"/>`;
const relationshipDocument=contents=>`<Relationships xmlns="${packageRelationships}">${contents}</Relationships>`;
const contentType=(part,kind)=>`<Override PartName="/${part}" ContentType="${spreadsheetContentType}.${kind}+xml"/>`;
const column=n=>String.fromCharCode(65+n);
const cellStyles={title:1,meta:2,header:3,plain:4,time:5,date:6,text:7};
const styles=`<x:styleSheet xmlns:x="${workbookNs}">
 <x:numFmts count="2"><x:numFmt numFmtId="164" formatCode="hh:mm"/><x:numFmt numFmtId="165" formatCode="dd.mm.yyyy"/></x:numFmts>
 <x:fonts count="3">
  <x:font><x:sz val="11"/><x:name val="Calibri"/></x:font>
  <x:font><x:b/><x:sz val="16"/><x:color rgb="FF123557"/><x:name val="Calibri"/></x:font>
  <x:font><x:b/><x:sz val="11"/><x:color rgb="FFFFFFFF"/><x:name val="Calibri"/></x:font>
 </x:fonts>
 <x:fills count="3"><x:fill><x:patternFill patternType="none"/></x:fill><x:fill><x:patternFill patternType="gray125"/></x:fill>
  <x:fill><x:patternFill patternType="solid"><x:fgColor rgb="FF173C61"/><x:bgColor indexed="64"/></x:patternFill></x:fill></x:fills>
 <x:borders count="1"><x:border><x:left/><x:right/><x:top/><x:bottom/><x:diagonal/></x:border></x:borders>
 <x:cellStyleXfs count="1"><x:xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></x:cellStyleXfs>
 <x:cellXfs count="8">
  <x:xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <x:xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <x:xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><x:alignment vertical="center" wrapText="1"/></x:xf>
  <x:xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><x:alignment vertical="center" wrapText="1"/></x:xf>
  <x:xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><x:alignment vertical="center" wrapText="1"/></x:xf>
  <x:xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <x:xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <x:xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
 </x:cellXfs>
 <x:cellStyles count="1"><x:cellStyle name="Normal" xfId="0" builtinId="0"/></x:cellStyles>
</x:styleSheet>`;

const crcTable=Array.from({length:256},(_,n)=>{
 for(let i=0;i<8;i++)n=n&1?0xEDB88320^(n>>>1):n>>>1;
 return n>>>0;
});
function crc32(bytes){
 let crc=0xFFFFFFFF;
 for(const value of bytes)crc=crcTable[(crc^value)&255]^(crc>>>8);
 return (crc^0xFFFFFFFF)>>>0;
}
function pack(entries){
 const local=[],central=[];
 let offset=0,centralSize=0;
 for(const [name,xml] of entries){
  const filename=Buffer.from(name),data=Buffer.from(xml),body=deflateRawSync(data),check=crc32(data);
  const header=Buffer.alloc(30),directory=Buffer.alloc(46);
  header.writeUInt32LE(0x04034B50);
  header.writeUInt16LE(20,4);
  header.writeUInt16LE(0x800,6);
  header.writeUInt16LE(8,8);
  header.writeUInt16LE(33,12);
  header.writeUInt32LE(check,14);
  header.writeUInt32LE(body.length,18);
  header.writeUInt32LE(data.length,22);
  header.writeUInt16LE(filename.length,26);
  directory.writeUInt32LE(0x02014B50);
  directory.writeUInt16LE(20,4);
  directory.writeUInt16LE(20,6);
  directory.writeUInt16LE(0x800,8);
  directory.writeUInt16LE(8,10);
  directory.writeUInt16LE(33,14);
  directory.writeUInt32LE(check,16);
  directory.writeUInt32LE(body.length,20);
  directory.writeUInt32LE(data.length,24);
  directory.writeUInt16LE(filename.length,28);
  directory.writeUInt32LE(offset,42);
  local.push(header,filename,body);
  central.push(directory,filename);
  offset+=header.length+filename.length+body.length;
  centralSize+=directory.length+filename.length;
 }
 const end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054B50);
 end.writeUInt16LE(entries.length,8);
 end.writeUInt16LE(entries.length,10);
 end.writeUInt32LE(centralSize,12);
 end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,...central,end]);
}

function cell(index,row,value,style){
 const ref=column(index)+row;
 if(value==null)return `<x:c r="${ref}" s="${style}"/>`;
 if(typeof value==='number')return `<x:c r="${ref}" s="${style}" t="n"><x:v>${value}</x:v></x:c>`;
 return `<x:c r="${ref}" s="${style}" t="inlineStr"><x:is><x:t xml:space="preserve">${escapeXml(value)}</x:t></x:is></x:c>`;
}
function sheetPackage({name,headers,rows=[],meta=[],widths,formats={},table=false},number){
 const headerRow=meta.length+1,lastRow=headerRow+Math.max(rows.length,table?1:0),lastColumn=column(headers.length-1);
 const range=`A${headerRow}:${lastColumn}${lastRow}`;
 const columns=widths.map((width,index)=>`<x:col min="${index+1}" max="${index+1}" width="${width}" customWidth="1"${formats[index]==='text'?' style="7"':''}/>`).join('');
 const lead=meta.map((value,index)=>{
  const row=index+1,title=index===1;
  return `<x:row r="${row}" ht="${title?28:22}" customHeight="1">${value?cell(0,row,value,title?cellStyles.title:cellStyles.meta):''}</x:row>`;
 }).join('');
 const head=`<x:row r="${headerRow}" ht="32" customHeight="1">${headers.map((value,i)=>cell(i,headerRow,value,cellStyles.header)).join('')}</x:row>`;
 const detail=(rows.length?rows:table?[[]]:[]).map((values,index)=>{
  const row=headerRow+index+1;
  const longest=values.reduce((max,value,i)=>typeof value==='string'?Math.max(max,Math.ceil(value.length/(widths[i]||18))):max,1);
  const height=Math.max(21,Math.min(180,longest*16));
  return `<x:row r="${row}" ht="${height}" customHeight="1">${headers.map((_,i)=>cell(i,row,values[i],cellStyles[formats[i]||'plain'])).join('')}</x:row>`;
 }).join('');
 const merges=meta.flatMap((value,i)=>value?[`<x:mergeCell ref="A${i+1}:${lastColumn}${i+1}"/>`]:[]);
 const pane=`<x:sheetViews><x:sheetView workbookViewId="0" showGridLines="0"><x:pane ySplit="${headerRow}" topLeftCell="A${headerRow+1}" activePane="bottomLeft" state="frozen"/></x:sheetView></x:sheetViews>`;
 const print='<x:pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><x:pageSetup orientation="landscape" paperSize="8" fitToWidth="1" fitToHeight="0"/>';
 const tableLink=table?'<x:tableParts count="1"><x:tablePart r:id="rId1"/></x:tableParts>':'';
 const worksheet=`<x:worksheet xmlns:x="${workbookNs}" xmlns:r="${documentRelationships}"><x:sheetPr><x:pageSetUpPr fitToPage="1"/></x:sheetPr><x:dimension ref="A1:${lastColumn}${lastRow}"/>${pane}<x:sheetFormatPr defaultRowHeight="17"/><x:cols>${columns}</x:cols><x:sheetData>${lead}${head}${detail}</x:sheetData>${merges.length?`<x:mergeCells count="${merges.length}">${merges.join('')}</x:mergeCells>`:''}${table?print:''}${tableLink}</x:worksheet>`;
 const path=`xl/worksheets/sheet${number}.xml`;
 const entries=[[path,worksheet]],types=[contentType(path,'worksheet')];
 if(table){
  const tablePath=`xl/tables/table${number}.xml`;
  const tableColumns=headers.map((value,i)=>`<x:tableColumn id="${i+1}" name="${escapeXml(value)}"/>`).join('');
  entries.push([`xl/worksheets/_rels/sheet${number}.xml.rels`,relationshipDocument(relationship(1,'table',`../tables/table${number}.xml`))]);
  entries.push([tablePath,`<x:table xmlns:x="${workbookNs}" id="${number}" name="Report${number}" displayName="Report${number}" ref="${range}" totalsRowShown="0"><x:autoFilter ref="${range}"/><x:tableColumns count="${headers.length}">${tableColumns}</x:tableColumns><x:tableStyleInfo name="TableStyleMedium2" showRowStripes="1"/></x:table>`]);
  types.push(contentType(tablePath,'table'));
 }
 return {name,entries,types};
}

// Build the XLSX parts directly from report data, with no stored workbooks or metadata.
export function writeWorkbook(sheets){
 const parts=sheets.map((sheet,i)=>sheetPackage(sheet,i+1));
 const links=parts.map((part,i)=>relationship(i+1,'worksheet',`worksheets/sheet${i+1}.xml`));
 links.push(relationship(parts.length+1,'styles','styles.xml'));
 const types=[
  `<Override PartName="/xl/workbook.xml" ContentType="${spreadsheetContentType}.sheet.main+xml"/>`,
  contentType('xl/styles.xml','styles'),...parts.flatMap(part=>part.types),
 ];
 return pack([
  ['[Content_Types].xml',`<Types xmlns="${contentTypesNs}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types.join('')}</Types>`],
  ['_rels/.rels',relationshipDocument(relationship(1,'officeDocument','xl/workbook.xml'))],
  ['xl/workbook.xml',`<x:workbook xmlns:x="${workbookNs}" xmlns:r="${documentRelationships}"><x:bookViews><x:workbookView/></x:bookViews><x:sheets>${parts.map(({name},i)=>`<x:sheet name="${escapeXml(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</x:sheets></x:workbook>`],
  ['xl/_rels/workbook.xml.rels',relationshipDocument(links.join(''))],
  ['xl/styles.xml',styles],
  ...parts.flatMap(part=>part.entries),
 ]);
}

function clockSerial(at,timezone){
 if(at==null)return null;
 const local=localDate(at,timezone);
 return Date.parse(local.date+'T'+local.time+':00Z')/86400000+25569;
}
const dailyHeaders=['№','Сотрудник','Должность','План: начало','План: конец','Приход','Уход','Работа, мин','Перерыв, мин','Опоздал, мин','Ранний уход, мин','Статус','Разрешение / корректировка'];
export function attendanceXlsx(report,{timezone='Asia/Tashkent',trigger='По запросу администратора'}={}){
 const local=at=>clockSerial(at,timezone);
 const stamp=localDate(report.generated,timezone);
 const fmt=at=>{const date=localDate(at,timezone);return date.date+' '+date.time;};
 const rows=report.rows.map((row,index)=>{
  const note=[];
  const p=row.permission;
  if(p){
   const status=({pending:'Разрешение ожидает подтверждения',approved:'Уход по разрешению подтверждён',rejected:'Разрешение не подтверждено'})[p.status]||p.status;
   note.push(`${status}. Кто разрешил: ${p.responsible}${p.confirmedBy?'. Решение: '+p.confirmedBy:''}. Фактически раньше: ${row.rawEarly} мин.`);
  }
  if(row.latePermission)note.push(`Уважительная причина опоздания: ${row.latePermission.reason}. Подтвердил: ${row.latePermission.confirmedBy}.`);
  if(row.overtimePermission)note.push(`Дополнительная работа до ${fmt(row.overtimePermission.until)}. Подтвердил: ${row.overtimePermission.confirmedBy}. Согласовано фактически: ${row.overtimePermission.minutes} мин.`);
  if(row.corrected)note.push(`Корректировка HR. Исходный приход: ${row.originalIn==null?'—':fmt(row.originalIn)}; уход: ${row.originalOut==null?'—':fmt(row.originalOut)}.`);
  if(row.in!=null&&row.out==null)note.push('Минуты предварительные.');
  if(row.conflict)note.push('Конфликт графика.');
  return [index+1,row.name,row.role,local(row.plannedStart),local(row.plannedEnd),local(row.in),local(row.out),row.worked,row.breaks,row.late,row.early,row.status,note.join(' ')];
 });
 const summary=report.summary;
 const meta=[null,'TAMEER · Отчёт посещаемости',`Дата смены: ${report.day.split('-').reverse().join('.')} · ${timezone}`,
  `Сформирован: ${stamp.date} ${stamp.time} · ${trigger}`,
  `Всего: ${summary.employees} · Пришли: ${summary.arrived} · Закрыли смену: ${summary.closed} · Без прихода: ${summary.missing} · Выходной / отсутствие: ${summary.off}`,
  'Открытые смены и отсутствие отметок требуют проверки. Минуты открытых смен предварительные.'];
 return writeWorkbook([{name:'Посещаемость',headers:dailyHeaders,rows,meta,table:true,
  widths:[6,24,22,14,14,12,12,12,12,12,14,18,50],formats:{3:'time',4:'time',5:'time',6:'time'}}]);
}

const periodTotalHeaders=['Сотрудник','Должность','Дней в отчёте','Рабочих дней','С приходом','Закрытых смен','Без отметки прихода','Выходной / отсутствие','Открытых смен','Работа, мин','Перерыв, мин','Опоздание, мин','Ранний уход, мин','Ранний приход, мин','Поздний уход, мин','Примечание'];
const periodDayHeaders=['Дата смены','Сотрудник','Должность','План: начало','План: конец','Учётный приход','Учётный уход','Исходный приход','Исходный уход','Работа, мин','Перерыв, мин','Опоздание, мин','Ранний уход, мин','Ранний приход, мин','Поздний уход, мин','Статус','Корректировка / разрешение'];
function periodNote(row){
 const note=[];
 if(row.corrected)note.push('Корректировка HR: учётное время отличается от исходного.');
 if(row.latePermission)note.push('Опоздание разрешено. Подтвердил(а): '+row.latePermission.confirmedBy+'.');
 if(row.permission)note.push('Ранний уход: '+({approved:'разрешён',pending:'ожидает подтверждения',rejected:'отказано'})[row.permission.status]+'. Ответственный: '+row.permission.responsible+'.');
 if(row.overtimePermission)note.push('Согласовано дополнительной работы: '+row.overtimePermission.minutes+' мин. Подтвердил(а): '+row.overtimePermission.confirmedBy+'.');
 if(row.conflict)note.push('Конфликт графика.');
 if(row.in!=null&&row.out==null)note.push('Открытая смена: минуты предварительные.');
 return note.join(' ');
}
export function periodAttendanceXlsx(report){
 const timezone=report.timezone||'Asia/Tashkent';
 const serial=at=>clockSerial(at,timezone);
 const dateSerial=day=>Date.parse(day+'T00:00:00Z')/86400000+25569;
 const totals=report.totals.map(row=>[row.name,row.role,row.days,row.scheduled,row.arrived,row.closed,row.missing,row.off,row.open,row.worked,row.breaks,row.late,row.early,row.earlyArrival,row.lateDeparture,
  row.days===0?'Нет записей за выбранный период.':row.open?'Есть открытые смены: минуты предварительные.':'']);
 const days=report.rows.map(row=>[dateSerial(row.day),row.name,row.role,serial(row.plannedStart),serial(row.plannedEnd),serial(row.in),serial(row.out),serial(row.corrected?row.originalIn:row.in),serial(row.corrected?row.originalOut:row.out),row.worked,row.breaks,row.late,row.early,row.earlyArrival,row.lateDeparture,row.status,periodNote(row)]);
 const stamp=localDate(report.generated,timezone);
 const meta=[null,'TAMEER · Посещаемость за период',
  `Период: ${report.from} — ${report.to}${report.through!==report.to?' · Данные по '+report.through:''} · ${timezone}`,
  'Сотрудники: '+report.name,`Сформирован: ${stamp.date} ${stamp.time}`,
  'Без отметки — требуется проверка. Минуты открытых смен предварительные.'];
 return writeWorkbook([
  {name:'Итоги',headers:periodTotalHeaders,rows:totals,meta,table:true,widths:[24,22,12,12,12,12,14,15,12,12,12,13,13,13,13,42]},
  {name:'По дням',headers:periodDayHeaders,rows:days,meta,table:true,widths:[15,24,22,13,13,14,14,14,14,12,12,13,13,13,13,20,50],
   formats:{0:'date',3:'time',4:'time',5:'time',6:'time',7:'time',8:'time'}},
 ]);
}
