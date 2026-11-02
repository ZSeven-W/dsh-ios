/** Contract checks with a fake transport; never claims a real Duo fold. */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { runHingeAction, isFoldableSimulator, hingeTargetAngle, parseHingePosture, takeHingeScreenshot } from '../lib/hinge.js'
import { createSimHingeTool } from '../lib/tool-hinge.js'
import { StreamRoutes, StreamAccessController } from '../lib/stream-routes.js'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-ios-hinge-test-'))
const fake = join(tmp, 'hinge.mjs')
const previous = process.env.DSHPLUGIN_IOS_HINGE_BIN
process.env.DSHPLUGIN_IOS_HINGE_BIN = fake
process.env.HINGE_TEST_DIR = tmp
writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.HINGE_TEST_DIR, args = process.argv.slice(2);
appendFileSync(join(dir,'calls'),JSON.stringify(args)+'\\n');
const [flag,device,command,...rest]=args;
if(flag!=='--device') process.exit(2);
if(process.env.HINGE_TEST_MODE==='failure'){console.error('mock private protocol changed');process.exit(7)}
let state=existsSync(join(dir,'state'))?JSON.parse(readFileSync(join(dir,'state'),'utf8')):{angle:180,reads:0};
if(command==='set'){state.angle=Number(rest[0]);state.reads=0;state.changedAt=Date.now();writeFileSync(join(dir,'state'),JSON.stringify(state));}
if(command==='posture'){
 state.reads++;writeFileSync(join(dir,'state'),JSON.stringify(state));
 const stale=process.env.HINGE_TEST_MODE==='stale';
 const cover=state.angle===0 && !(process.env.HINGE_TEST_MODE==='delayed'&&state.reads<3) && !(process.env.HINGE_TEST_MODE==='slow-display'&&Date.now()-state.changedAt<4500);
 console.log(JSON.stringify({angle:stale?180:state.angle,activeDisplay:cover?'LCD':'LCD-1',displays:[
 {name:'LCD',primary:true,active:cover,backlight:cover?'inactiveOn':'off'},
 {name:'LCD-1',primary:false,active:!cover,backlight:!cover?'activeOn':'off'}]}));
}
if(command==='screenshot')writeFileSync(rest[0],'mock display capture');
`, { mode: 0o755 })
const duo = { udid: 'DUO-DEVICE-0001', name: 'Renamed QA device', state: 'Booted', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo' }
const phone = { ...duo, name: 'iPhone 16 Pro', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro' }
let passed = 0
async function test(name, fn) { await fn();passed++;console.log('PASS '+name) }
try {
 await test('identify renamed Duo by hardware type; normal iPhone unsupported', async()=>{
  assert.equal(isFoldableSimulator(duo),true);assert.equal(isFoldableSimulator(phone),false)
  assert.equal((await runHingeAction(phone,{action:'status'})).supported,false)
  await assert.rejects(runHingeAction(phone,{action:'fold'}),/requires an iPhone Duo/)
  await assert.rejects(runHingeAction({...duo,state:'Shutdown'},{action:'unfold'}),/boot/)
 })
 await test('reject invalid angles and ambiguous preset arguments before sending',async()=>{
  for(const angle of [-1,181,NaN,Infinity,'90',undefined])assert.throws(()=>hingeTargetAngle({action:'set',angle}))
  assert.throws(()=>hingeTargetAngle({action:'fold',angle:90}))
  assert.throws(()=>hingeTargetAngle({action:'shell'}))
 })
 await test('fold and unfold require angle and correct active display',async()=>{
  const folded=await runHingeAction(duo,{action:'fold'});assert.equal(folded.angle,0);assert.equal(folded.activeDisplay,'LCD');assert.equal(folded.displayConfirmed,true)
  const open=await runHingeAction(duo,{action:'unfold'});assert.equal(open.angle,180);assert.equal(open.activeDisplay,'LCD-1');assert.equal(open.angleConfirmed,true)
 })
 await test('wait for delayed screen switching rather than assume angle equals display',async()=>{
  process.env.HINGE_TEST_MODE='delayed'
  const result=await runHingeAction(duo,{action:'fold'});assert.equal(result.activeDisplay,'LCD')
  assert.ok(JSON.parse(readFileSync(join(tmp,'state'),'utf8')).reads>=3)
  delete process.env.HINGE_TEST_MODE
 })
 await test('slow guest display transition beyond 4 seconds is still independently verified',async()=>{
  process.env.HINGE_TEST_MODE='slow-display'
  const started=Date.now(),result=await runHingeAction(duo,{action:'fold'})
  assert.ok(Date.now()-started>4000);assert.equal(result.activeDisplay,'LCD');assert.equal(result.displayConfirmed,true)
  delete process.env.HINGE_TEST_MODE
 })
 await test('intermediate posture reports active display without claiming endpoint transition',async()=>{
  const result=await runHingeAction(duo,{action:'set',angle:120});assert.equal(result.angle,120);assert.equal(result.displayConfirmed,undefined)
 })
 await test('streamed hinge uses acknowledged native setter and still verifies readback',async()=>{
  const callsBefore=readFileSync(join(tmp,'calls'),'utf8').trim().split('\n').length
  const result=await runHingeAction(duo,{action:'set',angle:90},undefined,async angle=>{
   writeFileSync(join(tmp,'state'),JSON.stringify({angle,reads:0}))
  })
  assert.equal(result.angle,90);assert.equal(result.angleConfirmed,true)
  const newCalls=readFileSync(join(tmp,'calls'),'utf8').trim().split('\n').slice(callsBefore).map(x=>JSON.parse(x))
  assert.ok(newCalls.length>0);assert.ok(newCalls.every(x=>x[2]==='posture'))
 })
 await test('native fold rejection is not hidden by a legacy retry',async()=>{
  await assert.rejects(runHingeAction(duo,{action:'fold'},undefined,async()=>{throw new Error('native dispatch rejected')}),/native dispatch rejected/)
 })
 await test('ignored fold is a failure despite subprocess exit zero',async()=>{
  process.env.HINGE_TEST_MODE='stale'
  await assert.rejects(runHingeAction(duo,{action:'fold'}),/unconfirmed/)
  delete process.env.HINGE_TEST_MODE
 })
 await test('private protocol failure and cancellation cannot return success',async()=>{
  process.env.HINGE_TEST_MODE='failure';await assert.rejects(runHingeAction(duo,{action:'unfold'}),/protocol changed/);delete process.env.HINGE_TEST_MODE
  const controller=new AbortController();controller.abort();await assert.rejects(runHingeAction(duo,{action:'status'},controller.signal))
 })
 await test('malformed or ambiguous display readback is rejected',async()=>{
  for(const value of ['null','{}','{"angle":null,"activeDisplay":"LCD","displays":[]}',JSON.stringify({angle:0,activeDisplay:'LCD',displays:[{name:'LCD',primary:true,active:true,backlight:'activeOn'},{name:'LCD-1',primary:false,active:true,backlight:'activeOn'}]})])assert.throws(()=>parseHingePosture(value))
 })
 await test('simultaneous mutations serialize through their own readback',async()=>{
  const [a,b]=await Promise.all([runHingeAction(duo,{action:'fold'}),runHingeAction(duo,{action:'unfold'})]);assert.equal(a.angle,0);assert.equal(b.angle,180)
 })
 await test('screenshots use target-specific active-display transport',async()=>{
  const path=join(tmp,'screen.png');await takeHingeScreenshot(duo.udid,path);assert.equal(readFileSync(path,'utf8'),'mock display capture')
  const calls=readFileSync(join(tmp,'calls'),'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.deepEqual(calls.at(-1),['--device',duo.udid,'screenshot',path])
 })
 await test('agent tool definition exposes the hinge actions',async()=>{
  const tool=createSimHingeTool({status:()=>({})});assert.equal(tool.name,'ios_sim_hinge')
 })
 await test('client shows measured posture, three presets, busy and error states in both locales',async()=>{
  const require=createRequire(import.meta.url)
  const domRequire=createRequire(require.resolve('react-dom/server'))
  const React=domRequire('react');const {renderToStaticMarkup}=domRequire('react-dom/server')
  let client
  new Function('window',readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'))({__ModuleLoader__:{load({factory}){client=factory(domRequire)}}})
  for(const locale of ['zh','en']){
   const props={locale,posture:{supported:true,angle:180,activeDisplay:'LCD-1'},angle:120,busy:false,error:'',onAngle(){},onAction(){}}
   const html=renderToStaticMarkup(React.createElement(client.HingeControlBody,props))
   assert.ok(html.includes('LCD-1'));assert.ok(html.includes('180'));assert.ok(html.includes('min="0"'));assert.ok(html.includes('max="180"'))
   const delayed=renderToStaticMarkup(React.createElement(client.HingeControlBody,{...props,
    posture:{supported:true,angle:90,activeDisplay:'LCD',displays:[{name:'LCD',size:[1398,2034]},{name:'LCD-1',size:[2007,2853]}]},
    displaySize:{width:2007,height:2853}}))
   assert.ok(delayed.includes('title="LCD-1"'),'preview label follows measured stream size after a delayed display switch')
   assert.ok(delayed.includes(locale==='zh'?'内屏':'Inner'))
   const busy=renderToStaticMarkup(React.createElement(client.HingeControlBody,{...props,busy:true,error:'unconfirmed'}))
   assert.ok(busy.includes('aria-busy="true"'));assert.ok(busy.includes('disabled=""'));assert.ok(busy.includes('role="alert"'));assert.ok(busy.includes('unconfirmed'))
  }
 })
 await test('HTTP hinge route preserves method, content and origin fences',async()=>{
  const routes=new StreamRoutes({status:()=>({running:false})},new StreamAccessController(async()=>Buffer.alloc(32,1)))
  const server=createServer((req,res)=>{void routes.handleHinge(req,res)})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const origin='http://127.0.0.1:'+server.address().port
  try{
   let r=await fetch(origin,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,403)
   r=await fetch(origin,{headers:{origin}});assert.equal(r.status,405)
   r=await fetch(origin,{method:'POST',headers:{origin},body:'{}'});assert.equal(r.status,415)
   r=await fetch(origin,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({device:duo.udid,action:'set',angle:181})});assert.equal(r.status,400)
  }finally{server.close();server.closeAllConnections();await once(server,'close')}
 })
 console.log(JSON.stringify({contractChecks:passed,runtimeDuo:'not exercised by this contract suite; see runtime verification'}))
} finally {
 if(previous===undefined)delete process.env.DSHPLUGIN_IOS_HINGE_BIN;else process.env.DSHPLUGIN_IOS_HINGE_BIN=previous
 delete process.env.HINGE_TEST_DIR;delete process.env.HINGE_TEST_MODE;rmSync(tmp,{recursive:true,force:true})
}
