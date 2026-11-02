import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readHingePosture,runHingeAction} from '../lib/hinge.js'
const dir=mkdtempSync(join(tmpdir(),'duo-readback-')),old={PATH:process.env.PATH,XDG_CACHE_HOME:process.env.XDG_CACHE_HOME}
const log=join(dir,'calls'),flag=join(dir,'mode'),run=(name,body)=>writeFileSync(join(dir,name),`#!${process.execPath}\n${body}`,{mode:0o755})
run('xcode-select',`console.log('/fixture/Xcode/Developer')`)
run('codesign',`process.exit(0)`)
run('xcrun',`const fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');const mode=fs.existsSync(${JSON.stringify(flag)})?fs.readFileSync(${JSON.stringify(flag)},'utf8'):'';
if(a[0]==='-sdk'){fs.writeFileSync(a[a.indexOf('-o')+1],'fixture');process.exit(0)}
if(a[0]==='simctl'){let ready=false;const announce=()=>{ready=true;console.log('READY')};if(mode==='startup-slow')setTimeout(announce,5500);else announce();require('node:readline').createInterface({input:process.stdin}).on('line',()=>{if(!ready){console.log('ERROR');return}fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(['sensor-get'])+'\\n');const m=fs.existsSync(${JSON.stringify(flag)})?fs.readFileSync(${JSON.stringify(flag)},'utf8'):'';const value=m==='sensor-failed'?'ERROR':m==='bad-angle'?'not-a-number':(m==='angle180'||m==='first-off')?'180.0':'90.0';if(m==='slow')setTimeout(()=>console.log(value),500);else console.log(value)});return}
if(a.includes('orientation'))console.log(JSON.stringify({result:{deviceOrientation:'portrait'}}));
else {if(mode==='first-off')fs.writeFileSync(${JSON.stringify(flag)},'angle180');console.log(JSON.stringify({result:{displays:[{name:'LCD',active:mode==='ambiguous',primary:true,backlightState:'off',type:{integrated:{}}},{name:'LCD-1',active:true,primary:false,backlightState:mode==='first-off'?'off':'activeOn',currentOrientation:'rot90',nativeSize:[2007,2853],pointScale:3,type:{integrated:{}}}]}}));}`)
process.env.PATH=dir+':'+old.PATH;process.env.XDG_CACHE_HOME=dir
const device={udid:'fixture-duo',name:'Duo',state:'Booted'}
try{
 const a=await readHingePosture(device),b=await readHingePosture(device)
 writeFileSync(flag,'angle180');assert.equal((await readHingePosture(device)).angle,180);writeFileSync(flag,'')
 assert.equal(a.angle,90);assert.equal(b.activeDisplay,'LCD-1');assert.deepEqual(b.displays[1].size,[2007,2853]);assert.equal(b.displays[1].scale,3)
 const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)
 assert.equal(calls.filter(a=>a[0]==='-sdk').length,1,'prepare once; no per-read builds/inventory')
 assert.equal(calls.filter(a=>a[0]==='simctl'&&a[1]==='spawn').length,1,'repeated reads reuse the sensor process')
 assert.equal(calls.filter(a=>a.includes('displays')).length,3,'display never served from cache')
 assert.equal(calls.filter(a=>a[0]==='sensor-get').length,3,'every request asks for a fresh sensor sample')
 for(const mode of ['bad-angle','ambiguous','sensor-failed']){writeFileSync(flag,mode);await assert.rejects(readHingePosture(device))}
 writeFileSync(flag,'slow');const live=new AbortController();const pending=readHingePosture(device,live.signal);setTimeout(()=>live.abort(),30);await assert.rejects(pending);writeFileSync(flag,'');assert.equal((await readHingePosture(device)).angle,90)
 const c=new AbortController();c.abort();const before=readFileSync(log,'utf8');await assert.rejects(readHingePosture(device,c.signal));assert.equal(readFileSync(log,'utf8'),before)
 console.log('PASS native readback reuses helper preparation, reads fresh angle/display, rejects ambiguity, sensor errors and cancellation')

 writeFileSync(flag,'startup-slow');const started=Date.now();assert.equal((await readHingePosture({...device,udid:'slow-start-duo'})).angle,90);assert.ok(Date.now()-started>=5500);writeFileSync(flag,'');
 console.log('PASS slow guest startup has a separate READY budget and no sample is sent before READY')

 const from=readFileSync(log,'utf8').trim().split('\n').length
 writeFileSync(flag,'first-off')
 const verified=await runHingeAction({...device,name:'iPhone Duo'},{action:'unfold'},undefined,async()=>{})
 assert.equal(verified.angle,180);assert.equal(verified.displayConfirmed,true)
 const transitionCalls=readFileSync(log,'utf8').trim().split('\n').slice(from).map(JSON.parse)
 assert.equal(transitionCalls.filter(a=>a.includes('orientation')).length,1,'one global orientation query per action')
 assert.equal(transitionCalls.filter(a=>a.includes('displays')).length,2,'backlight-off sample must be followed by a fresh display read')
 assert.equal(transitionCalls.filter(a=>a[0]==='sensor-get').length,2,'every verification poll still reads a fresh angle')
 await runHingeAction({...device,name:'iPhone Duo'},{action:'status'})
 const allLater=readFileSync(log,'utf8').trim().split('\n').slice(from).map(JSON.parse)
 assert.equal(allLater.filter(a=>a.includes('orientation')).length,2,'next action must not reuse orientation metadata')
 console.log('PASS bounded transition polls keep fresh angle/display and share orientation only within one action')

}finally{for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v}rmSync(dir,{recursive:true,force:true})}
