/** Native rotation contract: display axes differ from physical device axes. */
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runHingeAction,hingeTargetAngle} from '../lib/hinge.js'
const dir=mkdtempSync(join(tmpdir(),'duo-rotate-')), state=join(dir,'state'), fake=join(dir,'hinge.mjs')
const prior=process.env.DSHPLUGIN_IOS_HINGE_BIN
process.env.DSHPLUGIN_IOS_HINGE_BIN=fake
writeFileSync(fake,`#!${process.execPath}\nimport{readFileSync,writeFileSync}from'node:fs';const p=${JSON.stringify(state)},s=JSON.parse(readFileSync(p));s.reads++;if(s.pending&&s.reads>=3){s.rotation=s.pending;delete s.pending}writeFileSync(p,JSON.stringify(s));console.log(JSON.stringify({angle:180,activeDisplay:s.cover?'LCD':'LCD-1',displays:[{name:s.cover?'LCD':'LCD-1',primary:s.cover,active:true,backlight:'activeOn',rotation:s.rotation,size:s.cover?[1398,2034]:[2007,2853],scale:3}]}));`,{mode:0o755})
const device={udid:'rotation-fixture',name:'iPhone Duo',state:'Booted'}
try{
 for(const [cover,action,physical,rotation] of [[false,'portrait','landscape_right','rot0'],[false,'landscape','portrait','rot90'],[true,'portrait','portrait','rot0'],[true,'landscape','landscape_left','rot90']]){
  writeFileSync(state,JSON.stringify({cover,rotation:rotation==='rot0'?'rot90':'rot0',reads:0}))
  const commands=[]
  const result=await runHingeAction(device,{action},undefined,undefined,async value=>{
   commands.push(value);const s=JSON.parse(readFileSync(state));s.pending=rotation;writeFileSync(state,JSON.stringify(s))
  })
  assert.deepEqual(commands,[physical]);assert.equal(result.displayOrientation,action)
  assert.equal(result.orientationConfirmed,true);assert.equal(result.angle,180)
  assert.ok(JSON.parse(readFileSync(state)).reads>=3,'must read fresh state after dispatch, not trust command success')
 }
 const c=new AbortController();writeFileSync(state,JSON.stringify({cover:false,rotation:'rot90',reads:0}))
 const timer=setTimeout(()=>c.abort(),350)
 try{await assert.rejects(runHingeAction(device,{action:'portrait'},c.signal,undefined,async()=>{}));}finally{clearTimeout(timer)}
 assert.equal(JSON.parse(readFileSync(state)).rotation,'rot90','locked UI must not be reported as rotated')
 await assert.rejects(runHingeAction({...device,name:'iPhone 17'},{action:'portrait'},undefined,undefined,async()=>{}),/requires an iPhone Duo/)
 assert.throws(()=>hingeTargetAngle({action:'portrait',angle:90}),/only accepted/)
 assert.equal(hingeTargetAngle({action:'portrait'}),undefined)
 console.log('PASS: inner/cover axis offsets, portrait/landscape, delayed display confirmation, cancellation and ordinary-device rejection')
}finally{if(prior===undefined)delete process.env.DSHPLUGIN_IOS_HINGE_BIN;else process.env.DSHPLUGIN_IOS_HINGE_BIN=prior;rmSync(dir,{recursive:true,force:true})}
