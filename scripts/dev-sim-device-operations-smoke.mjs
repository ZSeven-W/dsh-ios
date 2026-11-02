import assert from 'node:assert/strict'
import{withSimDeviceRead as read,withSimDeviceMutation as mutate}from'../lib/sim-device-operations.js'
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const started=deferred(),release=deferred(),events=[]
const first=read('duo',undefined,async signal=>{events.push('read-start');started.resolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>{events.push('read-abort');reject(signal.reason)},{once:true}))});const rejected=assert.rejects(first,/posture is changing/);await started.promise
const mutation=mutate('duo',undefined,async()=>{events.push('fold-start');await release.promise;events.push('fold-end')})
const second=read('duo',undefined,async()=>{events.push('fresh-read');return 42})
await rejected;await Promise.resolve();assert(!events.includes('fresh-read'));release.resolve();await mutation;assert.equal(await second,42);assert.deepEqual(events,['read-start','read-abort','fold-start','fold-end','fresh-read'])
await assert.rejects(read('duo',undefined,async()=>{throw Error('bad tree')}),/bad tree/);assert.equal(await mutate('duo',undefined,async()=>7),7)
const hold=deferred(),entered=deferred();const other=read('a',undefined,async()=>{entered.resolve();await hold.promise});await entered.promise;assert.equal(await mutate('b',undefined,async()=>8),8);const c=new AbortController();c.abort();assert.throws(()=>mutate('a',c.signal,async()=>{}));hold.resolve();await other
console.log('PASS fold cancels stale native reads, waits for cleanup, then permits fresh reads; failures/caller abort recover and other devices remain independent')
