import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [tool, ...args] = process.argv.slice(2)
if (tool !== 'tsc' && tool !== 'tsdown') {
  throw new Error(`run-tool: unsupported tool ${JSON.stringify(tool)}`)
}

// A standalone checkout (pnpm install in this repo) always wins: when the
// tool is installed locally in node_modules/.bin, it is used and no machine-
// specific environment is consulted. The fallbacks below only exist so the
// DSH dev workspace (node_modules symlinked to ~/.dsh/profiles, toolchain
// living in ~/.dsh/source) keeps working without its own install.
const localBin = join(root, 'node_modules', '.bin', tool)
const fallbackBins = []
const typeRoots = [join(root, 'node_modules', '@types')]

const explicitSource = process.env.DSH_SOURCE_ROOT?.trim()
if (explicitSource) fallbackBins.push(join(explicitSource, 'node_modules', '.bin', tool))
if (explicitSource) typeRoots.push(join(explicitSource, 'node_modules', '@types'))

// A linked DSH peer package gives us the active source checkout without a
// machine-specific path. Walk upward until its workspace-level .bin appears.
const peer = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools')
if (existsSync(peer)) {
  let current = realpathSync(peer)
  for (;;) {
    fallbackBins.push(join(current, 'node_modules', '.bin', tool))
    typeRoots.push(join(current, 'node_modules', '@types'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

// Installed DSH source bundles are the last supported build environment.
const sourceStore = join(homedir(), '.dsh', 'source')
if (existsSync(sourceStore)) {
  const sources = readdirSync(sourceStore)
    .map(name => join(sourceStore, name))
    .filter(path => statSync(path).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  for (const source of sources) {
    fallbackBins.push(join(source, 'node_modules', '.bin', tool))
    typeRoots.push(join(source, 'node_modules', '@types'))
  }
}

const useLocal = existsSync(localBin)
const binary = useLocal ? localBin : fallbackBins.find(candidate => existsSync(candidate))
if (binary === undefined) {
  throw new Error(`run-tool: ${tool} is unavailable; install dev dependencies or set DSH_SOURCE_ROOT`)
}
if (process.env.DSH_RUN_TOOL_VERBOSE === '1') {
  console.error(`run-tool: ${tool} -> ${binary} (${useLocal ? 'local node_modules/.bin' : 'fallback'})`)
}
const discoveredTypeRoots = [...new Set(typeRoots.filter(path => existsSync(path)))]
const forwardedArgs = [...args]
if (tool === 'tsc' && discoveredTypeRoots.length > 0) {
  forwardedArgs.push('--typeRoots', discoveredTypeRoots.join(','))
}
const env = {
  ...process.env,
}
const result = spawnSync(binary, forwardedArgs, { cwd: root, env, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
