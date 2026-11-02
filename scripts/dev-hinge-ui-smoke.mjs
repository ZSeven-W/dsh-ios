import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url), runtime=createRequire(require.resolve('react-dom/server')), React=runtime('react')
const source=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8')
const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
function harness(extra = {}){
 let cursor=0,dirty=true,mounted=true,now=0,id=0,api,body,changes=0,active='LCD',angle=0,failMutation=false
 const slots=[],effects=[],timers=new Map(),requests=[]
 const hooks={...React,useState(initial){const i=cursor++;slots[i]??={value:initial};return[slots[i].value,v=>{slots[i].value=typeof v==='function'?v(slots[i].value):v;dirty=true}]},useRef(initial){return slots[cursor++]??={current:initial}},useEffect(fn,deps){const i=cursor++;if(!equal(slots[i]?.deps,deps)){const old=slots[i];slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn()})}}}
 new Function('window','setTimeout','clearTimeout',source)({__ModuleLoader__:{load({factory}){api=factory(id=>id==='react'?hooks:runtime(id))}}},(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id},id=>timers.delete(id))
 const options={device:'DUO-1',deviceName:'iPhone Duo',locale:'zh',onChanged(){changes++},fetcher:async(_url,init)=>{
  const args=JSON.parse(init.body);requests.push({args,signal:init.signal})
  if(args.action==='half')angle=90
  if(args.action==='unfold')angle=180
  if(args.action!=='status'&&failMutation)throw Error('display transition unconfirmed')
  return{ok:true,json:async()=>({ok:true,supported:true,angle,activeDisplay:active})}
 },...extra}
 async function flush(){for(let n=0;n<20;n++){await Promise.resolve();if(dirty&&mounted){dirty=false;cursor=0;body=api.SimHingeControls(options);while(effects.length)effects.shift()()}}}
 return{flush,requests,failNextMutation(){failMutation=true},get body(){return body},get changes(){return changes},get pending(){return timers.size},setActive(v){active=v},setReady(v){options.ready=v;dirty=true},async advance(ms){const end=now+ms;for(;;){const entry=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;const[id,t]=entry;timers.delete(id);now=t.at;t.fn();await flush()}now=end;await flush()},unmount(){mounted=false;for(const s of slots)s?.cleanup?.()}}
}
{
 const h=harness();await h.flush();h.body.props.onAction('half');await h.flush()
 assert.equal(h.body.props.posture.angle,90);assert.equal(h.changes,1)
 await h.advance(5000);assert.equal(h.pending,0)
 assert.deepEqual(h.requests.map(r=>r.args.action),['status','half'])
 h.body.props.onAction('unfold');await h.flush()
 assert.equal(h.body.props.posture.angle,180)
 assert.deepEqual(h.requests.map(r=>r.args.action),['status','half','unfold'])
 h.unmount();console.log('PASS verified presets do not queue native reads ahead of the next click')
}
{
 const h=harness({ready:false});await h.flush();assert.equal(h.requests.length,0)
 h.setReady(true);await h.flush();assert.equal(h.body.props.busy,false)
 h.setReady(false);await h.flush();assert.equal(h.body.props.busy,true)
 h.setReady(true);await h.flush()
 assert.deepEqual(h.requests.map(r=>r.args.action),['status','status'])
 assert.equal(h.body.props.posture.supported,true);assert.equal(h.body.props.busy,false)
 h.unmount();console.log('PASS recovered video obtains fresh posture and unlocks controls without a polling loop')
}

{
 const h=harness();await h.flush();h.failNextMutation();h.body.props.onAction('half');await h.flush()
 assert.equal(h.body.props.posture.angle,90);assert.match(h.body.props.error,/unconfirmed/)
 assert.equal(h.changes,0);assert.deepEqual(h.requests.map(r=>r.args.action),['status','half','status'])
 h.unmount();console.log('PASS failed mutation retains its error and refreshes actual angle instead of showing the old preset')
}

{
 const h=harness({measuredAngle:90,displaySize:{width:2007,height:2853}});await h.flush()
 h.body.props.onAction('half');await h.flush();await h.advance(5000)
 assert.equal(h.pending,0);assert.deepEqual(h.requests.map(r=>r.args.action),['status','half'])
 assert.equal(h.body.props.busy,false);h.unmount()
 console.log('PASS Live telemetry avoids redundant settle polls and leaves the next click unblocked')
}

{
 const h=harness({measuredAngle:90});await h.flush()
 h.body.props.onAction('half');h.body.props.onAction('unfold');await h.flush()
 assert.deepEqual(h.requests.map(r=>r.args.action),['status','half'],'same render double clicks must not queue another mutation')
 h.unmount();console.log('PASS rapid preset clicks coalesce before React commits disabled state')
}
{
 const h=harness({measuredAngle:90});await h.flush();h.failNextMutation();h.body.props.onAction('half');await h.flush()
 assert.equal(h.body.props.busy,false);assert.match(h.body.props.error,/unconfirmed/)
 assert.deepEqual(h.requests.map(r=>r.args.action),['status','half']);h.unmount()
 console.log('PASS failed live action unlocks controls and retains error without another sensor query')
}

{
 let count=0
 const h=harness({fetcher:async()=>{if(++count===1)throw Error('sensor startup failed');return{ok:true,json:async()=>({ok:true,supported:true,angle:0})}}})
 await h.flush();assert.equal(h.body.props.busy,false);assert.match(h.body.props.error,/startup/)
 await h.advance(1000);assert.equal(count,2);assert.equal(h.body.props.posture.angle,0);assert.equal(h.body.props.error,'')
 await h.advance(60000);assert.equal(count,2);h.unmount()
 console.log('PASS initial sensor failure recovers once without indefinite polling')
}
{
 let count=0,fail=true
 const h=harness({fetcher:async()=>{count++;if(fail)throw Error('offline');return{ok:true,json:async()=>({ok:true,supported:true,angle:90})}}})
 await h.flush();await h.advance(60000);assert.equal(count,2);assert.equal(h.body.props.busy,false)
 fail=false;h.body.props.onAction('status');await h.flush();assert.equal(h.body.props.posture.angle,90);assert.equal(h.body.props.error,'');h.unmount()
 console.log('PASS repeated startup failure stops retrying and explicit reconnect recovers controls')
}
{
 const signals=[]
 const h=harness({fetcher:(_url,init)=>{signals.push(init.signal);return new Promise(()=>{})}})
 await h.flush();assert.equal(h.body.props.busy,true)
 await h.advance(20000);assert.equal(h.body.props.busy,false);assert.match(h.body.props.error,/timed out/);assert.equal(signals[0].aborted,true)
 await h.advance(21000);assert.equal(h.body.props.busy,false);assert.equal(signals.length,2)
 await h.advance(60000);assert.equal(signals.length,2);h.unmount()
 console.log('PASS hung transport is aborted and cannot leave controls permanently busy')
}

{
 let actionSignal
 const h=harness({fetcher:async(_url,init)=>{
  if(JSON.parse(init.body).action==='status')return{ok:true,json:async()=>({ok:true,supported:true,angle:0})}
  actionSignal=init.signal;return new Promise(()=>{})
 }})
 await h.flush();h.body.props.onAction('half');await h.flush();assert.equal(actionSignal.aborted,false)
 h.unmount();await h.flush();assert.equal(actionSignal.aborted,true);assert.equal(h.pending,0)
 console.log('PASS unmount cancels the active mutation as well as the startup read')
}
