/** Reproduce the missing-session production fallback without a simulator. */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { runStreamHingeAction } from '../lib/hinge.js'

const dir=mkdtempSync(join(tmpdir(),'dsh-hinge-session-'))
const bin=join(dir,'hinge.mjs'), state=join(dir,'state'), calls=join(dir,'calls')
writeFileSync(state,'180')
writeFileSync(bin,`#!/usr/bin/env node
import {appendFileSync, readFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(calls)},process.argv.slice(2).join(' ')+'\\n');
if(process.argv[4]!=='posture'){console.error('legacy 2s setter must not run');process.exit(1)}
console.log(JSON.stringify({angle:Number(readFileSync(${JSON.stringify(state)},'utf8')),activeDisplay:'LCD-1',displays:[{name:'LCD-1',primary:false,active:true,backlight:'activeOn'}]}));
`,{mode:0o755})
const previous=process.env.DSHPLUGIN_IOS_HINGE_BIN
process.env.DSHPLUGIN_IOS_HINGE_BIN=bin
const server=new WebSocketServer({host:'127.0.0.1',port:0})
await once(server,'listening')
let frames=0, starts=0, leases=0, releases=0
server.on('connection',socket=>socket.on('message',data=>{
 assert.equal(data[0],14); const {hinge}=JSON.parse(data.subarray(1)); frames++
 writeFileSync(state,String(hinge));socket.send(Buffer.concat([Buffer.from([14]),Buffer.from('{"ok":true}')]))
}))
const device={udid:'DUO-DEVICE-0001',name:'iPhone Duo',state:'Booted'}
let status={running:false}
const host={status:()=>status,ensureRunning:async()=>{starts++;return {device:device.udid,wsUrl:`ws://127.0.0.1:${server.address().port}`}},acquire:()=>{leases++;return()=>{releases++}}}
try {
 assert.equal((await runStreamHingeAction(host,device,{action:'status'})).angle,180)
 assert.equal(starts,0)
 assert.equal((await runStreamHingeAction(host,device,{action:'half'})).angle,90)
 assert.equal(starts,1);assert.equal(frames,1);assert.equal(leases,releases)
 console.log('PASS no-session half-open starts native session and verifies 90; status remains read-only')
 status={running:true,device:device.udid}
 assert.equal((await runStreamHingeAction(host,device,{action:'unfold'})).angle,180)
 assert.equal(starts,2);assert.equal(frames,2)
 console.log('PASS running host without streamInfo still resolves the native control channel')
 status={running:true,device:'ANOTHER-DEVICE'}
 await assert.rejects(runStreamHingeAction(host,device,{action:'half'}),/device picker/)
 assert.equal(starts,2);assert.equal(frames,2)
 console.log('PASS stale panel cannot take over another simulator')
 status={running:false}
 await assert.rejects(runStreamHingeAction({...host,ensureRunning:async()=>{throw Error('native launch failed')}},device,{action:'half'}),/native launch failed/)
 assert.ok(readFileSync(calls,'utf8').split('\n').filter(Boolean).every(x=>x.includes('posture')))
 console.log('PASS native startup failure is never hidden by the legacy setter')
 const controller=new AbortController();controller.abort()
 await assert.rejects(runStreamHingeAction(host,device,{action:'half'},controller.signal))
 assert.equal(starts,2);assert.equal(leases,releases)
 console.log('PASS cancellation prevents startup and all native leases are released')
} finally {
 if(previous===undefined)delete process.env.DSHPLUGIN_IOS_HINGE_BIN;else process.env.DSHPLUGIN_IOS_HINGE_BIN=previous
 for(const socket of server.clients)socket.terminate()
 await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true})
}
