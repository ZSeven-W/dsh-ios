import assert from 'node:assert/strict'
import{mkdtempSync,writeFileSync,readFileSync,rmSync,cpSync,mkdirSync}from'node:fs'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{pathToFileURL}from'node:url'
const dir=mkdtempSync(join(tmpdir(),'axe-budget-')),calls=join(dir,'calls'),old={PATH:process.env.PATH,DSH_IOS_AXE_DIR:process.env.DSH_IOS_AXE_DIR}
mkdirSync(join(dir,'isolated'));writeFileSync(join(dir,'isolated/package.json'),'{"type":"module"}');cpSync(new URL('../lib',import.meta.url),join(dir,'isolated/lib'),{recursive:true});const{ensureAxeBinary}=await import(pathToFileURL(join(dir,'isolated/lib/uitree-backend.js')));
writeFileSync(join(dir,'curl'),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)},'call\\n');setTimeout(()=>process.exit(1),8500)`,{mode:0o755})
process.env.PATH=dir;process.env.DSH_IOS_AXE_DIR=join(dir,'cache')
try{
 const start=Date.now();const first=await ensureAxeBinary();assert.equal(first.available,false);assert(Date.now()-start<11000,'a missing helper must not hold the tool for the300s network timeout')
 const retry=Date.now();const second=await ensureAxeBinary();assert.equal(second.available,false);assert(Date.now()-retry<1000,'an already running download must not make every tool wait8s again')
 await new Promise(r=>setTimeout(r,1200));const failed=await ensureAxeBinary();assert.equal(failed.available,false);assert.match(failed.reason,/cooling down/)
 assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,1,'failed automatic installation must not restart on every Agent tool call')
 console.log('PASS missing AXe has bounded initial wait, background download sharing, actionable OCR hint and failure cooldown')
}finally{for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v}rmSync(dir,{recursive:true,force:true})}
