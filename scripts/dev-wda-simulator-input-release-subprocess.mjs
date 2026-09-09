/** Independent release lifecycle regression: no keepalive timer is installed. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const smoke = join(root, 'scripts', 'dev-wda-simulator-input-smoke.mjs')
const child = spawn(process.execPath, [smoke], {
  cwd: root,
  env: { ...process.env, DSH_WDA_RELEASE_CHILD: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.on('data', chunk => { stdout += chunk.toString() })
child.stderr.on('data', chunk => { stderr += chunk.toString() })
const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
const outcome = await new Promise(resolve => {
  let settled = false
  child.once('error', error => {
    if (settled) return
    settled = true
    resolve({ code: null, signal: null, error })
  })
  child.once('close', (code, signal) => {
    if (settled) return
    settled = true
    resolve({ code, signal, error: null })
  })
})
clearTimeout(timeout)
assert.equal(outcome.error, null, `release child error: ${String(outcome.error)}`)
assert.equal(outcome.signal, null, `release child was signalled: ${stderr}`)
assert.equal(outcome.code, 0, `release child failed: ${stdout}\n${stderr}`)
assert.match(stdout, /release-child-settled/)
console.log('PASS release settles in an independent child without a keepalive handle')
