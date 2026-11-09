import {createReadStream,statSync} from 'node:fs';import {join} from 'node:path';
import {trainingLessons} from './training-catalog.mjs';
const files=new Map(trainingLessons.flatMap(l=>[[l.video,'video/mp4'],[l.poster,'image/jpeg'],[l.subtitles,'text/vtt; charset=utf-8']]));
export function trainingRange(header,size){
 if(!header)return {start:0,end:size-1,partial:false};
 const m=/^bytes=(\d*)-(\d*)$/.exec(header);if(!m||!m[1]&&!m[2]||!size)return null;
 let start,end;if(!m[1]){const suffix=Number(m[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,size-suffix);end=size-1;}
 else {start=Number(m[1]);end=m[2]?Number(m[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return null;end=Math.min(end,size-1);}
 return {start,end,partial:true};
}
export function serveTrainingMedia(req,res,path,publicDir){
 if(!path.startsWith('/training-media/'))return false;
 const name=path.slice('/training-media/'.length),type=files.get(name);
 if(!type){res.writeHead(404);res.end();return true;}
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return true;}
 let stat;const file=join(publicDir,'training',name);try{stat=statSync(file);if(!stat.isFile())throw Error();}catch{res.writeHead(404);res.end();return true;}
 const range=trainingRange(req.headers.range,stat.size);if(!range){res.writeHead(416,{'Content-Range':'bytes */'+stat.size});res.end();return true;}
 res.writeHead(range.partial?206:200,{'Content-Type':type,'Content-Length':range.end-range.start+1,'Accept-Ranges':'bytes','Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff',...(range.partial?{'Content-Range':`bytes ${range.start}-${range.end}/${stat.size}`}:{})});
 if(req.method==='HEAD'){res.end();return true;}
 const stream=createReadStream(file,{start:range.start,end:range.end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return true;
}
