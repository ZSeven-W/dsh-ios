import assert from 'node:assert/strict'
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync}from'node:fs'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{pathToFileURL}from'node:url'
const dir=mkdtempSync(join(tmpdir(),'dsh-ax-reader-'));const log=join(dir,'calls'),mode=join(dir,'mode');mkdirSync(join(dir,'lib'));mkdirSync(join(dir,'assets/ax-reader'),{recursive:true});mkdirSync(join(dir,'axe/Frameworks/FBSimulatorControl.framework'),{recursive:true});copyFileSync(new URL('../lib/ax-reader.js',import.meta.url),join(dir,'lib/ax-reader.mjs'))
writeFileSync(join(dir,'assets/ax-reader/dsh-ax-reader'),`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},'spawn '+process.pid+'\\n');let n=0;require('node:readline').createInterface({input:process.stdin}).on('line',()=>{n++;fs.appendFileSync(${JSON.stringify(log)},'read '+n+'\\n');const mode=fs.existsSync(${JSON.stringify(mode)})?fs.readFileSync(${JSON.stringify(mode)},'utf8'):'';if(mode==='bad'){console.log('{}');return}const output=()=>console.log(JSON.stringify([{type:'Application',AXLabel:mode||'old',frame:{x:0,y:0,width:951,height:669},children:[],n}]));if(mode==='slow')setTimeout(output,500);else output()})`,{mode:0o755})
const{readWithAxeSession:read,closeAxeReaders:close}=await import(pathToFileURL(join(dir,'lib/ax-reader.mjs')));const command=join(dir,'axe/axe')
try{
 const a=JSON.parse(await read(command,'duo'));writeFileSync(mode,'changed');const b=JSON.parse(await read(command,'duo'));assert.equal(a[0].AXLabel,'old');assert.equal(b[0].AXLabel,'changed');assert.equal(b[0].n,2)
 const values=await Promise.all([read(command,'duo'),read(command,'duo')]);assert.deepEqual(values.map(s=>JSON.parse(s)[0].n),[3,4]);assert.equal(readFileSync(log,'utf8').split('\n').filter(s=>s.startsWith('spawn')).length,1)
 writeFileSync(mode,'slow');const c=new AbortController();const pending=read(command,'duo',c.signal);setTimeout(()=>c.abort(),20);await assert.rejects(pending);writeFileSync(mode,'recovered');assert.equal(JSON.parse(await read(command,'duo'))[0].AXLabel,'recovered');writeFileSync(mode,'bad');await assert.rejects(read(command,'duo'),/Invalid/)
 const before=readFileSync(log,'utf8');const abort=new AbortController();abort.abort();assert.throws(()=>read(command,'other',abort.signal));assert.equal(readFileSync(log,'utf8'),before)
 assert.equal(read('/does/not/exist/axe','duo'),undefined,'unsupported/custom layout preserves CLI path');close();console.log('PASS fresh snapshots, one process, serialized reads, cancellation/new process recovery, malformed response rejection, pre-abort and missing-framework fallback')
}finally{close();rmSync(dir,{recursive:true,force:true})}
