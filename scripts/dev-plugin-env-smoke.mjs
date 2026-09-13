/**
 * Development smoke test for the DSH_ -> DSHPLUGIN_ migration (src/plugin-env.ts).
 *
 * PURELY STATIC — no device, no simulator, no network.
 *
 * The rules here are not cosmetic. DSH refuses to load any .env file that sets
 * a DSH_-prefixed variable and aborts the host BEFORE plugins load, so the
 * legacy names survive only to keep working shell exports alive — and a
 * fallback that fired on an EMPTY new value would silently resurrect a stale
 * override the user had just tried to clear.
 *
 *   node scripts/dev-plugin-env-smoke.mjs
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const {
  LEGACY_ENV_PREFIX,
  PLUGIN_ENV_PREFIX,
  legacyEnvName,
  pluginEnv,
  pluginEnvName,
  resetPluginEnvWarnings,
} = await import(join(root, 'lib', 'plugin-env.js'))

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Collect warnings instead of writing them to stderr. */
function capture() {
  const lines = []
  return { lines, warn: message => lines.push(message) }
}

const S = 'IOS_TEAM_ID'

// The whole point: DSH's blacklist matches every name STARTING WITH "DSH_".
step(
  'the new prefix does not collide with the reserved one',
  PLUGIN_ENV_PREFIX.startsWith(LEGACY_ENV_PREFIX) === false
    && pluginEnvName(S) === 'DSHPLUGIN_IOS_TEAM_ID'
    && legacyEnvName(S) === 'DSH_IOS_TEAM_ID',
)

{
  resetPluginEnvWarnings()
  const sink = capture()
  const both = pluginEnv(S, { env: { DSHPLUGIN_IOS_TEAM_ID: 'new', DSH_IOS_TEAM_ID: 'old' }, warn: sink.warn })
  resetPluginEnvWarnings()
  const legacyOnly = pluginEnv(S, { env: { DSH_IOS_TEAM_ID: 'old' }, warn: sink.warn })
  const neither = pluginEnv(S, { env: {}, warn: sink.warn })
  step(
    'the new name wins, the legacy name is the fallback, absence is undefined',
    both === 'new' && legacyOnly === 'old' && neither === undefined,
  )
}

{
  resetPluginEnvWarnings()
  const sink = capture()
  // "I deliberately want no override here" must not resurrect the legacy value.
  const cleared = pluginEnv(S, { env: { DSHPLUGIN_IOS_TEAM_ID: '', DSH_IOS_TEAM_ID: 'STALE1234' }, warn: sink.warn })
  step('resolution is by presence, so an empty new value does NOT fall back', cleared === '', JSON.stringify(cleared))
}

{
  resetPluginEnvWarnings()
  const sink = capture()
  const env = { DSH_IOS_TEAM_ID: 'ABCD123456' }
  pluginEnv(S, { env, warn: sink.warn })
  pluginEnv(S, { env, warn: sink.warn })
  pluginEnv(S, { env, warn: sink.warn })
  step('a legacy variable warns exactly once per process', sink.lines.length === 1, `${sink.lines.length} warning(s)`)
  step(
    'the warning names both sides and says REPLACE',
    sink.lines[0].includes('DSH_IOS_TEAM_ID')
      && sink.lines[0].includes('DSHPLUGIN_IOS_TEAM_ID')
      // Adding the new name BESIDE the old one in a .env still aborts the
      // host, so "also set the new one" would be wrong advice.
      && sink.lines[0].includes('REPLACE'),
    sink.lines[0].slice(0, 100),
  )
  step(
    'the warning never prints the value (a team id is not for logs)',
    sink.lines[0].includes('ABCD123456') === false,
  )
  step('the plugin attributes its own warning', sink.lines[0].startsWith('dsh-ios: '))
}

{
  resetPluginEnvWarnings()
  const sink = capture()
  pluginEnv(S, { env: { DSHPLUGIN_IOS_TEAM_ID: 'new', DSH_IOS_TEAM_ID: 'old' }, warn: sink.warn })
  step(
    'a legacy variable still warns when the new name overrides it',
    sink.lines.length === 1 && sink.lines[0].includes('takes precedence'),
  )
}

{
  resetPluginEnvWarnings()
  const sink = capture()
  pluginEnv(S, { env: { DSHPLUGIN_IOS_TEAM_ID: 'new' }, warn: sink.warn })
  step('a new-only variable is silent', sink.lines.length === 0)
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
