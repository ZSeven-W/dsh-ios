import assert from 'node:assert/strict'
import{mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,cpSync,existsSync}from'node:fs'
import{tmpdir}from'node:os'
import{join,dirname,relative}from'node:path'
import{pathToFileURL}from'node:url'
const dir=mkdtempSync(join(tmpdir(),'axe-bundled-')),log=join(dir,'network'),env={PATH:process.env.PATH,DSH_IOS_AXE_DIR:process.env.DSH_IOS_AXE_DIR,DSHPLUGIN_IOS_AXE_BIN:process.env.DSHPLUGIN_IOS_AXE_BIN,DSHPLUGIN_IOS_AXE_OFFLINE:process.env.DSHPLUGIN_IOS_AXE_OFFLINE}
mkdirSync(join(dir,'fixture/assets/axe'),{recursive:true});writeFileSync(join(dir,'fixture/package.json'),'{"type":"module"}');cpSync(new URL('../lib',import.meta.url),join(dir,'fixture/lib'),{recursive:true});const archive=join(dir,'fixture/assets/axe/AXe-macOS-v1.8.0-universal.tar.gz');cpSync(new URL('../assets/axe/AXe-macOS-v1.8.0-universal.tar.gz',import.meta.url),archive)
writeFileSync(join(dir,'curl'),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},'network');process.exit(1)`,{mode:0o755});process.env.PATH=dir+':'+env.PATH;process.env.DSH_IOS_AXE_DIR=join(dir,'cache');delete process.env.DSHPLUGIN_IOS_AXE_BIN;delete process.env.DSHPLUGIN_IOS_AXE_OFFLINE
const{ensureAxeBinary}=await import(pathToFileURL(join(dir,'fixture/lib/uitree-backend.js')))
try{
 let binary=await ensureAxeBinary();for(let i=0;!binary.available&&i<20;i++){await new Promise(r=>setTimeout(r,500));binary=await ensureAxeBinary()}
 assert(binary.available,binary.reason);assert.equal(binary.source,'cache');assert(existsSync(join(dirname(binary.command),'Frameworks/FBSimulatorControl.framework')));assert(!existsSync(log),'bundled installation must not use network')
 process.env.DSH_IOS_AXE_DIR=join(dir,'corrupt-cache');const bytes=readFileSync(archive);bytes[10]^=1;writeFileSync(archive,bytes);const invalid=await ensureAxeBinary();assert.equal(invalid.available,false);assert.match(invalid.reason,/integrity check failed/);assert(!existsSync(join(dir,'corrupt-cache',relative(join(dir,'cache'),binary.command))),'corrupt archive must not be extracted');assert(!existsSync(log),'integrity failure must not silently fall through to a network download')
 process.env.DSHPLUGIN_IOS_AXE_BIN=join(dir,'missing-user-override');const override=await ensureAxeBinary();assert.equal(override.available,false);assert.match(override.reason,/missing-user-override/)
 console.log('PASS fresh cache installs pinned AXe + frameworks without network, corrupt bundle rejected before extraction, explicit override respected')
}finally{for(const[k,v]of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v}rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
