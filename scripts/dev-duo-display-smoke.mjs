import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { duoDisplayFromPosture, duoRawPoint, requireDuoScreenshotSize, sameDuoDisplay, tapDuoDisplay } from '../lib/duo-display.js'
import { alignDuoTree, describeUi, duoDisplayForTree } from '../lib/uitree-backend.js'
import { buildTreeResult, resolveTapTarget } from '../lib/tool-uitree.js'
import { performSimInteract } from '../lib/tools.js'
const device = { name:'iPhone Duo', udid:'duo-test', state:'Booted' }
function display(name, rotation, size, scale=3) { return duoDisplayFromPosture({displays:[{name,rotation,size,scale,active:true,primary:name==='LCD',backlight:'activeOn'}]}) }
const inner=display('LCD-1','rot90',[2007,2853]),cover=display('LCD','rot0',[1398,2034])
assert.deepEqual(inner.points,{width:951,height:669})
assert.deepEqual(cover.points,{width:466,height:678})
assert.deepEqual(display('LCD-1','rot0',[2007,2853],2).points,{width:1003.5,height:1426.5})
assert.throws(()=>duoDisplayFromPosture({displays:[]}),/unambiguous/)
assert.throws(()=>display('LCD-1','unknown',[2007,2853]),/unavailable/)
assert.throws(()=>display('LCD-1','rot0',[0,2853]),/unavailable/)
assert.throws(()=>requireDuoScreenshotSize(inner,{width:1398,height:2034}),/disagree/)
assert.equal(sameDuoDisplay(inner,cover),false)
assert.equal(sameDuoDisplay(inner,display('LCD-1','rot270',[2007,2853])),false)
const button={type:'Button',label:'已选择',identifier:'choice',frame:{x:695.6666666667,y:345.6666647593,w:28,h:28},children:[]}
const raw=[{type:'Application',label:'设置',frame:{x:0,y:0,w:669,h:951},children:[{type:'Group',frame:{x:0,y:0,w:951,h:669},children:[button]}]}]
// Recorded Duo regression: correct right-side button was pruned by portrait app-root bounds.
assert.equal(buildTreeResult(raw,{width:669,height:951},device,{}).omittedOffscreen,1)
const aligned=alignDuoTree(raw,inner)
assert.equal(buildTreeResult(aligned,inner.points,device,{}).omittedOffscreen,0)
assert.equal(resolveTapTarget(aligned,{identifier:'choice'}).element.frame.x,button.frame.x)
assert.equal(raw[0].frame.w,669) // no mutation of native observations
assert.equal(duoDisplayForTree(aligned),inner)
assert.throws(()=>alignDuoTree(raw,cover),/does not match/)
assert.throws(()=>alignDuoTree([{...raw[0],children:[]}],inner),/does not match/)
assert.throws(()=>alignDuoTree([...raw,{...raw[0],children:[]}],inner),/does not match/)
assert.deepEqual(duoRawPoint(inner,{x:.2,y:.3}),{x:.3,y:.8})
assert.deepEqual(duoRawPoint(display('LCD-1','rot270',[2007,2853]),{x:.2,y:.3}),{x:.7,y:.2})
assert.deepEqual(duoRawPoint(display('LCD','rot180',[1398,2034]),{x:.2,y:.3}),{x:.8,y:.7})
const calls=[];const host={control:async a=>{calls.push(a);return{stdout:'',stderr:''}}}
await performSimInteract(host,device.udid,{action:'tap',x:.2,y:.3},[['tap','.2','.3']],{display:inner})
assert.deepEqual(calls.pop(),['tap','-d',device.udid,'0.3','0.8','--raw'])
await performSimInteract(host,device.udid,{action:'tap',x:.2,y:.3},[['tap','.2','.3']])
assert.deepEqual(calls.pop(),['tap','-d',device.udid,'.2','.3'])
// Simulate an actual display switch DURING AX read. Re-read, never attach old cover coordinates to the inner display.
const dir=mkdtempSync(join(tmpdir(),'dsh-duo-display-test-')),oldPath=process.env.PATH
try {
 const counter=join(dir,'calls');writeFileSync(counter,'0')
 const xcrun=join(dir,'xcrun')
 writeFileSync(xcrun,`#!${process.execPath}\nconst fs=require('node:fs');const p=${JSON.stringify(counter)};let n=+fs.readFileSync(p);fs.writeFileSync(p,String(n+1));let inner=n>0;console.log(JSON.stringify({result:{displays:[{name:inner?'LCD-1':'LCD',active:true,primary:!inner,backlightState:'activeOn',currentOrientation:inner?'rot90':'rot0',nativeSize:inner?[2007,2853]:[1398,2034],pointScale:3,type:{integrated:{}}}]}}));`)
 chmodSync(xcrun,0o755);process.env.PATH=dir+':'+oldPath
 const axe=join(dir,'axe');writeFileSync(axe,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(raw))})`);chmodSync(axe,0o755)
 const tree=await describeUi({available:true,command:axe,source:'path',installHint:''},device.udid,undefined,device)
 assert.equal(tree[0].frame.w,951);assert.equal(+readFileSync(counter),4)
 // A stale observation must be rejected before the HID socket is opened, releasing its lease.
 let released=false
 await assert.rejects(tapDuoDisplay({status:()=>({running:true,device:device.udid}),ensureRunning:async()=>({wsUrl:'ws://invalid'}),acquire:()=>()=>{released=true}},device,cover,{x:.2,y:.3}),/No tap was sent/)
 assert.equal(released,true)
 // The observed testmanagerd transport failure recovers once. Arbitrary errors are not swallowed.
 const once=join(dir,'once')
 writeFileSync(axe,`#!${process.execPath}\nconst fs=require('node:fs');const p=${JSON.stringify(once)};if(!fs.existsSync(p)){fs.writeFileSync(p,'1');console.log('Error: Timed out creating the simulator remote automation session');process.exit(1)}console.log(${JSON.stringify(JSON.stringify(raw))})`)
 const recovered=await describeUi({available:true,command:axe,source:'path',installHint:''},device.udid,undefined,device)
 assert.equal(recovered[0].frame.w,951)
 writeFileSync(axe,`#!${process.execPath}\nconsole.log('Error: unrelated accessibility failure');process.exit(1)`)
 await assert.rejects(describeUi({available:true,command:axe,source:'path',installHint:''},device.udid,undefined,device),/unrelated accessibility failure/)
 // Queue two reads; a fake backend detects even a brief overlap.
 const active=join(dir,'active')
 writeFileSync(axe,`#!${process.execPath}\nconst fs=require('node:fs'),p=${JSON.stringify(active)};if(fs.existsSync(p)){console.log('Error: overlapping automation session');process.exit(1)}fs.writeFileSync(p,'1');setTimeout(()=>{fs.unlinkSync(p);console.log(${JSON.stringify(JSON.stringify(raw))})},50)`)
 const pair=await Promise.all([describeUi({available:true,command:axe,source:'path',installHint:''},device.udid,undefined,device),describeUi({available:true,command:axe,source:'path',installHint:''},device.udid,undefined,device)])
 assert.equal(pair.length,2)
 console.log('PASS: stale taps refused, leases released, exact transport error recovered once, parallel reads serialized')
 console.log('PASS: display transition invalidated first AX result and re-read successfully')
} finally {process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true})}
console.log('PASS: Duo viewport, point scale, rotated HID, stale-tree rejection, ordinary-device fallback')
