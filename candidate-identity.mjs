import {randomUUID} from 'node:crypto';

// A phone match is a suggestion, never proof that two applicants are the same
// person. Keep every original candidate and application ID intact.
export function normalizedCandidatePhone(value){
 let digits=String(value??'').trim().replace(/[\s()+.\-]/g,'');
 if(digits.startsWith('00'))digits=digits.slice(2);
 if(!/^\d{7,15}$/.test(digits))return '';
 // This shop operates in Uzbekistan; local mobile numbers have nine digits.
 if(digits.length===9)digits='998'+digits;
 return '+'+digits;
}
const normalizedName=value=>String(value??'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('ru');

export function initCandidateIdentity(db,{fail,clock=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS hr_candidate_people(id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL,normalized_phone TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS hr_candidate_people_links(candidate TEXT PRIMARY KEY REFERENCES hr_candidates(id),person TEXT NOT NULL REFERENCES hr_candidate_people(id));
 CREATE TABLE IF NOT EXISTS hr_candidate_person_history(id TEXT PRIMARY KEY,person TEXT NOT NULL REFERENCES hr_candidate_people(id),at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,details TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS hr_candidate_people_phone ON hr_candidate_people(normalized_phone);
 CREATE INDEX IF NOT EXISTS hr_candidate_people_links_person ON hr_candidate_people_links(person);`);
 const hasApplications=()=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hr_recruit_applications'").get();
 function associate(candidate,{trustedChat=''}={}){
  const prior=db.prepare('SELECT person FROM hr_candidate_people_links WHERE candidate=?').get(candidate);if(prior)return prior.person;
  const c=db.prepare('SELECT * FROM hr_candidates WHERE id=?').get(candidate);if(!c)fail('Кандидат не найден',404);
  const phone=normalizedCandidatePhone(c.contact);let person;
  // Repeated applications from one verified private Telegram account can share
  // a card only when both their name and contact match. Other matches need HR.
  if(phone&&/^[1-9]\d{0,15}$/.test(trustedChat)&&hasApplications()){
   const matches=db.prepare('SELECT p.id,c.name,c.contact FROM hr_recruit_applications a JOIN hr_candidates c ON c.id=a.candidate JOIN hr_candidate_people_links l ON l.candidate=c.id JOIN hr_candidate_people p ON p.id=l.person WHERE a.chat=? ORDER BY a.submitted DESC').all(trustedChat);
   person=matches.find(m=>normalizedCandidatePhone(m.contact)===phone&&normalizedName(m.name)===normalizedName(c.name))?.id;
  }
  if(!person){person=randomUUID();const now=clock();db.prepare('INSERT INTO hr_candidate_people VALUES(?,?,?,?,?,?)').run(person,c.name||'',c.contact||'',phone,c.created||now,now)}
  db.prepare('INSERT INTO hr_candidate_people_links VALUES(?,?)').run(candidate,person);return person;
 }
 function sync(){
  const rows=db.prepare('SELECT c.id FROM hr_candidates c LEFT JOIN hr_candidate_people_links l ON l.candidate=c.id WHERE l.candidate IS NULL ORDER BY c.created,c.id').all();
  for(const c of rows){const app=hasApplications()?db.prepare('SELECT chat FROM hr_recruit_applications WHERE candidate=?').get(c.id):null;associate(c.id,{trustedChat:app?.chat||''})}
  // Contacts can be edited by HR. Preserve the person's display values, but
  // duplicate suggestions below compare current candidate contacts directly.
  return rows.length;
 }
 function candidates(person){return db.prepare('SELECT c.* FROM hr_candidates c JOIN hr_candidate_people_links l ON l.candidate=c.id WHERE l.person=? ORDER BY c.created DESC,c.id').all(person)}
 function applications(person){if(!hasApplications())return [];const columns=db.prepare('PRAGMA table_info(hr_recruit_applications)').all().map(c=>c.name),source=columns.includes('source')?'a.source':"CASE WHEN a.session LIKE 'web:%' THEN 'web' ELSE 'telegram' END",channel=columns.includes('channel')?'a.channel':"CASE WHEN a.session LIKE 'web:%' AND a.chat NOT LIKE 'web:%' THEN 'telegram-mini-app' WHEN a.session LIKE 'web:%' THEN 'browser' ELSE 'telegram-chat' END";
  return db.prepare(`SELECT a.id,a.candidate,a.submitted,a.language,a.vacancy,a.vacancy_title,a.vacancy_department,${source} source,${channel} channel,c.name,c.role,c.stage,c.interview FROM hr_recruit_applications a JOIN hr_candidate_people_links l ON l.candidate=a.candidate JOIN hr_candidates c ON c.id=a.candidate WHERE l.person=? ORDER BY a.submitted DESC,a.id`).all(person)}
 function duplicates(){
  const groups=new Map();for(const c of db.prepare('SELECT c.id,c.name,c.role,c.contact,c.stage,l.person FROM hr_candidates c JOIN hr_candidate_people_links l ON l.candidate=c.id').all()){const phone=normalizedCandidatePhone(c.contact);if(!phone)continue;if(!groups.has(phone))groups.set(phone,[]);groups.get(phone).push({...c,normalizedPhone:phone})}
  return [...groups].filter(([,rows])=>new Set(rows.map(r=>r.person)).size>1).map(([phone,rows])=>({phone,people:[...new Set(rows.map(r=>r.person))],candidates:rows,requiresReview:true}));
 }
 function view(id){sync();const p=db.prepare('SELECT * FROM hr_candidate_people WHERE id=?').get(id);if(!p)fail('Карточка кандидата не найдена',404);const rows=candidates(id),phones=new Set(rows.map(c=>normalizedCandidatePhone(c.contact)).filter(Boolean));return {...p,candidates:rows,applications:applications(id),history:db.prepare('SELECT * FROM hr_candidate_person_history WHERE person=? ORDER BY at DESC,id').all(id).map(h=>({...h,details:JSON.parse(h.details)})),duplicateSuggestions:duplicates().filter(g=>phones.has(g.phone)&&g.people.includes(id))}}
 function forCandidate(id){sync();const link=db.prepare('SELECT person FROM hr_candidate_people_links WHERE candidate=?').get(id);if(!link)fail('Кандидат не найден',404);return view(link.person)}
 function list({query=''}={}){sync();if(typeof query!=='string'||query.length>200)fail('Некорректный поиск');const term=normalizedName(query),people=db.prepare('SELECT * FROM hr_candidate_people ORDER BY updated DESC,id').all().map(p=>{const rows=candidates(p.id),apps=applications(p.id);return {...p,candidates:rows,applications:apps,applicationCount:apps.length,lastApplication:apps[0]?.submitted||null}}).filter(p=>!term||normalizedName([p.name,p.phone,...p.candidates.flatMap(c=>[c.name,c.contact,c.role])].join(' ')).includes(term));return {people:people.slice(0,300),total:people.length,duplicates:duplicates()}}
 function merge({person,other,reason},actor={}){
  sync();if(person===other)fail('Выберите две разные карточки');if(typeof reason!=='string'||!reason.trim()||reason.trim().length>1000)fail('Укажите причину объединения');const first=view(person),second=view(other),now=clock();
  if(new Set([...first.candidates,...second.candidates].map(c=>c.employee).filter(Boolean)).size>1)fail('Карточки связаны с разными сотрудниками. Проверьте личность и записи о приёме перед объединением.',409);
  db.exec('SAVEPOINT candidate_identity_merge');try{db.prepare('UPDATE hr_candidate_people_links SET person=? WHERE person=?').run(person,other);db.prepare('UPDATE hr_candidate_person_history SET person=? WHERE person=?').run(person,other);db.prepare('INSERT INTO hr_candidate_person_history VALUES(?,?,?,?,?,?)').run(randomUUID(),person,now,String(actor.id||'admin'),'merge',JSON.stringify({previousPerson:other,previousName:second.name,candidates:second.candidates.map(c=>c.id),reason:reason.trim()}));db.prepare('UPDATE hr_candidate_people SET updated=? WHERE id=?').run(now,person);db.prepare('DELETE FROM hr_candidate_people WHERE id=?').run(other);db.exec('RELEASE SAVEPOINT candidate_identity_merge')}catch(e){db.exec('ROLLBACK TO SAVEPOINT candidate_identity_merge');db.exec('RELEASE SAVEPOINT candidate_identity_merge');throw e}
  return {ok:true,person,mergedCandidates:first.candidates.length+second.candidates.length};
 }
 sync();return {associate,sync,list,view,forCandidate,merge,duplicates(){sync();return duplicates()}};
}
