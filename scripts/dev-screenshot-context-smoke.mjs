import assert from'node:assert/strict'
import{mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync}from'node:fs'
import{tmpdir}from'node:os';import{join}from'node:path'
import{takeScreenshot}from'../lib/simctl.js';import{duoDisplayFromPosture}from'../lib/duo-display.js'
const dir=mkdtempSync(join(tmpdir(),'duo-shot-context-')),old=process.env.PATH,log=join(dir,'calls'),mode=join(dir,'mode'),u='duo-test'
const device={udid:u,name:'iPhone Duo',runtime:'fixture',state:'Booted'},display=duoDisplayFromPosture({displays:[{name:'LCD-1',primary:false,active:true,backlight:'activeOn',rotation:'rot90',size:[2007,2853],scale:3}]})
writeFileSync(join(dir,'xcrun'),`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='devicectl'){let changed=fs.existsSync(${JSON.stringify(mode)});console.log(JSON.stringify({result:{displays:[{name:changed?'LCD':'LCD-1',primary:changed,active:true,backlightState:'activeOn',currentOrientation:changed?'rot0':'rot90',nativeSize:changed?[1398,2034]:[2007,2853],pointScale:3,type:{integrated:{}}}]}}))}else if(a[1]==='list')console.log(JSON.stringify({devices:{fixture:[{udid:'duo-test',name:'iPhone Duo',state:'Booted',isAvailable:true}]}}));else if(a[1]==='io')fs.writeFileSync(a.at(-1),'fixture PNG');else process.exit(1)`,{mode:0o755});process.env.PATH=dir
const calls=()=>readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)
try{
 await takeScreenshot(u,join(dir,'1.png'),undefined,{device,display});assert.equal(calls().filter(a=>a[0]==='devicectl').length,1);assert(!calls().some(a=>a[1]==='list'))
 await takeScreenshot(u,join(dir,'2.png'),undefined,{device});assert.equal(calls().filter(a=>a[0]==='devicectl').length,3);assert(!calls().some(a=>a[1]==='list'))
 await takeScreenshot(u,join(dir,'3.png'));assert.equal(calls().filter(a=>a[1]==='list').length,1);assert.equal(calls().filter(a=>a[0]==='devicectl').length,5)
 writeFileSync(mode,'changed');await assert.rejects(takeScreenshot(u,join(dir,'4.png'),undefined,{device,display}),/changed/)
 await assert.rejects(takeScreenshot(u,join(dir,'wrong.png'),undefined,{device:{...device,udid:'other'},display}),/does not match/);assert(!existsSync(join(dir,'wrong.png')))
 console.log('PASS screenshot context avoids duplicate discovery, preserves fresh before/after checks, rejects changed displays and wrong target')
}finally{process.env.PATH=old;rmSync(dir,{recursive:true,force:true})}
