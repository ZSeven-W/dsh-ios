/**
 * Pure signing-team choice smoke test.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-signing-smoke.mjs
 *
 * No `security`, `plutil`, Xcode, simulator, or USB-device calls are made.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { chooseSigningTeam } = await import(join(root, 'lib', 'devicectl.js'))

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const company = { teamId: 'COMPANY1234', teamName: 'Example Company', teamType: 'Company', isFree: false, account: 'dev@example.com' }
const personal = { teamId: 'PERSONAL123', teamName: 'Example (Personal Team)', teamType: 'Personal Team', isFree: true, account: 'dev@example.com' }
const identity = teamId => ({ hash: 'A'.repeat(40), name: `Apple Development: Test User (${teamId})`, teamId })

const option = chooseSigningTeam({ explicit: ' OPTION1234 ', env: 'ENV1234567', xcodeTeams: [company], identities: [identity(company.teamId)], fallback: 'DEFAULT1234' })
step(
  'option wins over env and Xcode account teams',
  option.teamId === 'OPTION1234' && option.source === 'option',
  JSON.stringify(option),
)

const env = chooseSigningTeam({ env: ' ENV1234567 ', xcodeTeams: [company], identities: [identity(company.teamId)], fallback: 'DEFAULT1234' })
step(
  'env wins over Xcode account teams',
  env.teamId === 'ENV1234567' && env.source === 'env',
  JSON.stringify(env),
)

const matchingIdentity = chooseSigningTeam({ xcodeTeams: [company, personal], identities: [identity(company.teamId)] })
step(
  'Xcode team with matching identity beats free team',
  matchingIdentity.teamId === company.teamId
    && matchingIdentity.source === 'xcode-account'
    && matchingIdentity.detail.includes(company.teamName)
    && matchingIdentity.detail.includes('matching Apple Development identity'),
  JSON.stringify(matchingIdentity),
)

const freeTeam = chooseSigningTeam({ xcodeTeams: [company, personal], identities: [identity('OTHER12345')] })
step(
  'free team beats first company team when no identity matches',
  freeTeam.teamId === personal.teamId
    && freeTeam.source === 'xcode-account'
    && freeTeam.detail.includes(personal.teamName)
    && freeTeam.detail.includes('free/personal'),
  JSON.stringify(freeTeam),
)

const identityFallback = chooseSigningTeam({ identities: [identity('IDENTITY123')] })
step(
  'first keychain identity supplies the fallback when no Xcode teams exist',
  identityFallback.teamId === 'IDENTITY123' && identityFallback.source === 'identity',
  JSON.stringify(identityFallback),
)

const defaultFallback = chooseSigningTeam({ fallback: ' DEFAULT1234 ' })
step(
  'legacy default is used when no team evidence exists',
  defaultFallback.teamId === 'DEFAULT1234' && defaultFallback.source === 'default',
  JSON.stringify(defaultFallback),
)

const none = chooseSigningTeam({ fallback: '   ' })
step(
  'none is returned when no team or fallback exists',
  none.teamId === undefined && none.source === 'none',
  JSON.stringify(none),
)

const realWorldXcodeTeams = [
  { teamId: 'G822T5AGR9', teamName: 'Company', teamType: 'Company', isFree: false, account: 'maintainer@example.com' },
  { teamId: '5CHT5RB9C3', teamName: 'Yang Fini (Personal Team)', teamType: 'Personal Team', isFree: true, account: 'maintainer@example.com' },
]
const realWorldIdentities = [identity('SY43SLGH74'), identity('76Q534U32J')]
const realWorld = chooseSigningTeam({ xcodeTeams: realWorldXcodeTeams, identities: realWorldIdentities })
step(
  'regression: Xcode accounts choose the personal team instead of SY43SLGH74',
  realWorld.teamId === '5CHT5RB9C3'
    && realWorld.source === 'xcode-account'
    && realWorld.teamId !== 'SY43SLGH74'
    && realWorld.detail.includes('Yang Fini (Personal Team)'),
  JSON.stringify(realWorld),
)

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (failed.length > 0) process.exitCode = 1
