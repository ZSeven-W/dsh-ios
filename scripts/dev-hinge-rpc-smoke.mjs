import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { createServer, Agent, get } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { StreamRoutes, StreamAccessController } from '../lib/stream-routes.js'
import { createSimHingeRpc } from '../lib/client/sim-hinge-rpc.js'
import { encodeHingeWire, decodeHingeWire } from '../lib/hinge-wire.js'

const dir = mkdtempSync(join(tmpdir(), 'hinge-rpc-'))
const oldPath = process.env.PATH, oldBin = process.env.DSHPLUGIN_IOS_HINGE_BIN
const device = '00000000-0000-4000-8000-000000000001', state = join(dir, 'angle')
writeFileSync(state, '180')
writeFileSync(join(dir, 'xcrun'), `#!${process.execPath}\nconsole.log(JSON.stringify({devices:{runtime:[{udid:'${device}',name:'iPhone Duo',state:'Booted',isAvailable:true,deviceTypeIdentifier:'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo'}]}}))`, {mode:0o755})
writeFileSync(join(dir, 'hinge'), `#!${process.execPath}\nconst fs=require('node:fs');const a=Number(fs.readFileSync(${JSON.stringify(state)},'utf8'));console.log(JSON.stringify({angle:a,activeDisplay:a===0?'LCD':'LCD-1',displays:[{name:'LCD',primary:true,active:a===0,backlight:a===0?'activeOn':'off'},{name:'LCD-1',primary:false,active:a!==0,backlight:a!==0?'activeOn':'off'}]}))`, {mode:0o755})
process.env.PATH = dir + ':' + oldPath
process.env.DSHPLUGIN_IOS_HINGE_BIN = join(dir, 'hinge')
const native = new WebSocketServer({host:'127.0.0.1', port:0}); await once(native, 'listening')
let frames = 0, ignore = false, holds = 0, hingeHttpHits = 0
native.on('connection', ws => ws.on('message', data => {
  assert.equal(data[0], 14, 'plugin RPC must not reach native HID')
  frames++
  if (ignore) return
  writeFileSync(state, String(JSON.parse(data.subarray(1)).hinge))
  ws.send(Buffer.concat([Buffer.from([14]), Buffer.from('{"ok":true}')]))
}))
const host = {status:()=>({running:true,device}), acquire:()=>()=>{}, ensureRunning:async()=>({device,wsUrl:`ws://127.0.0.1:${native.address().port}`})}
const access = new StreamAccessController(async()=>Buffer.alloc(32, 19)), routes = new StreamRoutes(host, access)
const server = createServer((req,res)=>{
  if(req.url==='/hold'){holds++;res.writeHead(200);res.flushHeaders();return}
  hingeHttpHits++;void routes.handleHinge(req,res)
})
server.on('upgrade',(req,socket,head)=>void routes.handleWsUpgrade(req,socket,head))
server.listen(0,'127.0.0.1');await once(server,'listening')
const origin=`http://127.0.0.1:${server.address().port}`, agent=new Agent({maxSockets:6})
const holding=[];let client,rpc,queued
async function connect(){
 const {token}=await access.signStreamToken(device)
 client=new WebSocket(`${origin.replace('http:','ws:')}/_dsh/dsh-ios/ws?token=${token}`,{headers:{Origin:origin}})
 client.binaryType='arraybuffer';await once(client,'open');rpc=createSimHingeRpc(client,device)
 client.on('message',data=>rpc.receive(data));client.on('close',()=>rpc.close())
}
async function request(action, signal){return (await rpc.fetcher('/_dsh/dsh-ios/hinge',{method:'POST',body:JSON.stringify({device,action}),signal})).json()}
try {
 for(let i=0;i<6;i++) await new Promise(resolve=>{const req=get(origin+'/hold',{agent},res=>{res.on('data',()=>{});resolve()});req.on('error',()=>{});holding.push(req)})
 queued=get(origin+'/_dsh/dsh-ios/hinge',{agent});queued.on('error',()=>{})
 await connect()
 assert.equal(holds,6)
 for(const [action,angle] of [['status',180],['fold',0],['half',90],['unfold',180]]){
  const body=await request(action);assert.equal(body.ok,true);assert.equal(body.angle,angle)
 }
 assert.equal(hingeHttpHits,0,'HTTP request is still queued behind six streams')
 assert.equal(frames,3)
 console.log('PASS six occupied HTTP slots cannot block verified WS status/fold/90/unfold')
 await assert.rejects(rpc.fetcher('/_dsh/dsh-ios/hinge',{method:'POST',body:JSON.stringify({device:'another',action:'fold'})}),/another device/)
 const bad=await request('invalid');assert.equal(bad.ok,false);assert.equal(frames,3)
 console.log('PASS capability device scope and action validation preserved')
 ignore=true
 const cancel=new AbortController(), pending=request('half',cancel.signal)
 const rejection=assert.rejects(pending,/cancelled/);setTimeout(()=>cancel.abort(),30);await rejection
 await new Promise(r=>setTimeout(r,120));ignore=false
 assert.equal((await request('status')).ok,true)
 console.log('PASS cancelled request releases server operation; next status succeeds')
 ignore=true
 const stale=request('half');const rejected=assert.rejects(stale,/closed/)
 client.close();await rejected
 await connect();ignore=false
 assert.equal((await request('fold')).angle,0)
 console.log('PASS disconnected in-flight request rejects and replacement socket recovers')
 const sent=[];const fake={readyState:1,send:x=>sent.push(x)};const local=createSimHingeRpc(fake,device)
 const p=local.fetcher('/_dsh/dsh-ios/hinge',{method:'POST',body:JSON.stringify({device,action:'status'})})
 const id=decodeHingeWire(sent[0]).id
 local.receive(encodeHingeWire({id:id+1,result:{ok:true,angle:99}}))
 local.receive(encodeHingeWire({id,result:{ok:false,error:'unconfirmed'}}))
 assert.equal((await (await p).json()).ok,false);local.close()
 console.log('PASS unrelated or late IDs cannot settle another request; failure is preserved')
} finally {
 rpc?.close();client?.terminate();queued?.destroy();holding.forEach(r=>r.destroy());agent.destroy()
 routes.dispose();for(const ws of native.clients)ws.terminate();await new Promise(r=>native.close(r))
 server.closeAllConnections();await new Promise(r=>server.close(r))
 process.env.PATH=oldPath;if(oldBin===undefined)delete process.env.DSHPLUGIN_IOS_HINGE_BIN;else process.env.DSHPLUGIN_IOS_HINGE_BIN=oldBin
 rmSync(dir,{recursive:true,force:true})
}

{
 let reconnects=0
 const sent=[],socket={readyState:1,send:x=>sent.push(x)},rpc=createSimHingeRpc(socket,device,()=>{reconnects++})
 mock.timers.enable({apis:['setTimeout']})
 try {
  const p=rpc.fetcher('/_dsh/dsh-ios/hinge',{method:'POST',body:JSON.stringify({device,action:'status'})})
  const rejected=assert.rejects(p,/timed out/);mock.timers.tick(18000);await rejected
  assert.equal(decodeHingeWire(sent.at(-1)).cancel,true)
  assert.equal(reconnects,1)
  await assert.rejects(rpc.fetcher('/_dsh/dsh-ios/hinge',{method:'POST',body:JSON.stringify({device,action:'status'})}),/closed/)
  const fresh=createSimHingeRpc(socket,device)
  const p2=fresh.fetcher('/_dsh/dsh-ios/hinge',{method:'POST',body:JSON.stringify({device,action:'status'})})
  rpc.receive(encodeHingeWire({id:1,result:{ok:true,angle:90}}))
  fresh.receive(encodeHingeWire({id:1,result:{ok:true,angle:180}}))
  assert.equal((await (await p2).json()).angle,180)
  fresh.close()
  console.log('PASS missing reply times out, cancels server work, retires socket and reconnects once')
 } finally {rpc.close();mock.timers.reset()}
}
