import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const source=readFileSync(fileURLToPath(new URL('../src/uz/tameer/hr/MainActivity.java',import.meta.url)),'utf8');
const script=JSON.parse(source.match(/private static final String BACK_SCRIPT = ("[^\n]+");/)[1]);
let cases=0;
function run({helper,dialog=null,documentThrows=false},expected,closedExpected=0){
  let closed=0;
  const context={window:{},document:{querySelector(selector){assert.equal(selector,'dialog[open]'); if(documentThrows)throw new Error('DOM unavailable'); return dialog ? {close(){closed++;}} : null;}}};
  if(helper!==undefined)context.window.tameerHRBack=helper;
  assert.equal(vm.runInNewContext(script,context,{timeout:1000}),expected);
  assert.equal(closed,closedExpected);
  cases++;
}
run({helper:()=>true,dialog:true},true);
run({helper:()=>false},false);
run({helper:()=>false,dialog:true},true,1);
run({dialog:true},true,1);
run({},false);
run({helper:()=>{throw new Error('UI unavailable');},dialog:true},true,1);
run({helper:()=>{throw new Error('UI unavailable');}},false);
run({helper:()=> 'true'},false);
run({helper:()=>true,documentThrows:true},true);
run({documentThrows:true},false);
console.log(`Android Back fixed-script: ${cases} cases passed`);
