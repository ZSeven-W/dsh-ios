/**
 * Installed-app enumeration for both backends — the verb the tools were
 * missing (WP57).
 *
 * The measured failure this module closes: asked to open a list app on the
 * phone and like a post", an agent GUESSED X's bundle id as
 * an id derived from the app's FORMER name (its real,
 * installed id was different), had NO tool that lists what is installed, and fell
 * back to the shell — 25 `bash` calls averaging 6.6 s (165 s of a 377 s
 * session) across `xcrun devicectl device info apps`, `xcrun simctl listapps`
 * and finally a grep through Xcode's DerivedData. Worse: devicectl was
 * FAILING at the time ("CoreDeviceService was unable to locate a device
 * matching the requested device identifier … error 1011"), the agent read the
 * empty output as "X is not installed", and went looking for the app in the
 * user's unrelated source trees until the user aborted the run.
 *
 * So this module holds two invariants:
 * - a FAILED listing THROWS — non-zero exit, unparseable output, or a
 *   devicectl JSON error. Only a SUCCESSFUL listing may report zero apps, so
 *   `count: 0` is always a fact about the device, never about the plumbing.
 * - names are matched DECODED: `simctl listapps` prints an old-style plist
 *   whose non-ASCII characters are escaped (measured on this Mac:
 *   `CFBundleDisplayName = "\U793a\U4f8b";` for 示例), so a CJK query can only
 *   match after the `\Uxxxx` sequences are turned back into characters.
 *
 * WP58 adds LOCALIZED display names on the SIMULATOR path: Apple's stock apps
 * carry an English base CFBundleDisplayName (Calendar, not 日历) while the home
 * screen and ios_sim_find_text both read the localized name a Chinese user
 * types. That string lives in `<AppPath>/<lang>.lproj/InfoPlist.strings`, so
 * the listing resolves the device language ONCE and reads that file per app
 * (binary plist / XML / OpenStep text — the readers shared in src/plist.ts),
 * reporting `name` as the localized form and `baseName` as the base one.
 * @module @zseven-w/dsh-ios/app-list
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listApps as devicectlListApps, type RealApp } from './devicectl.js'
import { parsePlist, readStrings } from './plist.js'
import { listAppsPlist } from './simctl.js'

/** One installed app, as the tools report it (both backends normalized). */
export interface InstalledApp {
  bundleId: string
  /** Display name — what the user (and the task) calls the app. */
  name: string
  /** Un-localized (base) display name, present only when it differs from name. */
  baseName?: string
  /** Marketing version when the backend reports one. */
  version?: string
  /** True for stock/system apps; false for user-installed ones. */
  system: boolean
}

/** A parsed simulator app plus its on-disk .app path, before name localization. */
export interface SimAppWithPath extends InstalledApp {
  /** On-disk .app bundle directory (`Path`, or a decoded `Bundle` URL). */
  appPath?: string
}

/** How many characters of a rejected listing are quoted back in the error. */
const UNPARSEABLE_SAMPLE_CHARS = 120

/** How many app files are read at once while resolving localized names. */
const LOCALIZE_CONCURRENCY = 8

/** How many candidate lines a no-match hint lists. */
const NO_MATCH_CANDIDATE_LIMIT = 15

/**
 * WP59: the physical-device-only addendum to a name no-match. On a phone the
 * bundle lives ON the device, so `<AppPath>/<lang>.lproj/InfoPlist.strings`
 * cannot be read and devicectl returns base names only (measured on the
 * attached iPhone: Calendar / Photos / Settings / Alipay — the home screen
 * says 支付宝 — / Amap — 高德地图 — while X stays X). A CJK label from the
 * screen therefore can never match, and the model must be told the alternative
 * instead of guessing.
 */
const PHYSICAL_BASE_NAME_HINT = 'devicectl reports each app\'s base (usually English) name, so a '
  + 'Chinese label from the screen will not match — use the English name or the bundle id, or open '
  + 'the app by tapping its icon (ios_sim_find_text + ios_sim_tap_text) instead'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Decode one old-style-plist scalar: strip the optional quotes and resolve the
 * escapes in ONE pass, so a literal backslash (`\\`) can never be re-read as the
 * start of a `\Uxxxx` sequence. CoreFoundation's OpenStep writer escapes every
 * non-ASCII character that way, which is why a Chinese display name arrives as
 * `"\U5c7f\U6728"` and would never match a CJK query raw.
 */
function decodePlistScalar(raw: string): string {
  const trimmed = raw.trim()
  const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed
  return unquoted.replace(/\\(U[0-9a-fA-F]{4}|.)/g, (_match, escape: string) => {
    if (escape.length === 5 && (escape[0] === 'U' || escape[0] === 'u')) {
      return String.fromCharCode(Number.parseInt(escape.slice(1), 16))
    }
    if (escape === 'n') return '\n'
    if (escape === 't') return '\t'
    return escape
  })
}

/** The app record accumulated while walking one depth-2 dict. */
interface PlistAppEntry {
  key: string
  fields: Map<string, string>
}

/**
 * The host path of the app's .app bundle: `Path` when simctl printed one,
 * else the `Bundle` `file://` URL percent-decoded. `Path` is not always
 * present (third-party bundles often carry only `Bundle`/\`BundleContainer`),
 * and `Bundle` is URL-encoded (`iOS%2026.0`) where `Path` is not — so the
 * two cannot be treated as interchangeable.
 */
function appBundlePath(entry: PlistAppEntry): string | undefined {
  const path = entry.fields.get('Path')
  if (path !== undefined && path !== '') return path
  const bundle = entry.fields.get('Bundle')
  if (bundle !== undefined && bundle.startsWith('file://')) {
    const raw = bundle.slice('file://'.length)
    try { return decodeURIComponent(raw) } catch { return undefined }
  }
  return undefined
}

function installedAppFromPlist(entry: PlistAppEntry): SimAppWithPath {
  const bundleId = entry.fields.get('CFBundleIdentifier') ?? entry.key
  const name = entry.fields.get('CFBundleDisplayName')
    ?? entry.fields.get('CFBundleName')
    ?? bundleId.split('.').pop()
    ?? bundleId
  const version = entry.fields.get('CFBundleShortVersionString') ?? entry.fields.get('CFBundleVersion')
  // ApplicationType is System / User / Internal / "System (Placeholder)" …:
  // only User is user-installed, and that is the distinction when opening an app
  // cares about, so everything else counts as system.
  const applicationType = entry.fields.get('ApplicationType')
  const appPath = appBundlePath(entry)
  return {
    bundleId,
    name,
    ...(version === undefined || version === '' ? {} : { version }),
    system: applicationType === undefined ? false : applicationType.toLowerCase() !== 'user',
    ...(appPath === undefined ? {} : { appPath }),
  }
}

/**
 * Parse `xcrun simctl listapps <udid>` — one old-style plist keyed by bundle
 * id, each value a dict of scalars plus nested `GroupContainers { … }` /
 * `SBAppTags ( … )` blocks. The walk tracks brace/paren depth and only reads
 * scalars at depth 2, which is what keeps a group-container path from being
 * mistaken for an app field.
 *
 * Anything that is not a plist document — a simctl diagnostic on stdout, a
 * truncated pipe, an empty capture — THROWS instead of yielding an empty list:
 * the whole point of WP57 is that "no apps" and "the listing failed" must
 * never look alike to the model.
 */
function parseSimctlListAppsWithPath(stdout: string, device?: string): SimAppWithPath[] {
  const text = stdout.trim()
  const where = device === undefined ? '' : ` for ${device}`
  if (!text.startsWith('{') || !text.endsWith('}')) {
    throw new Error(
      `could not parse the simctl listapps output${where} — it is not a plist document (got `
      + `${JSON.stringify(text.slice(0, UNPARSEABLE_SAMPLE_CHARS))}); the listing FAILED, which is not the `
      + 'same as the device having no apps',
    )
  }
  const apps: SimAppWithPath[] = []
  let depth = 0
  let entry: PlistAppEntry | undefined
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line === '{') {
      depth += 1
      continue
    }
    if (line === '}' || line === '};' || line === ')' || line === ');') {
      // One app dict closes at depth 2: that is where its entry is complete.
      if (depth === 2 && entry !== undefined) {
        apps.push(installedAppFromPlist(entry))
        entry = undefined
      }
      depth -= 1
      continue
    }
    if (/=\s*[{(]$/.test(line)) {
      depth += 1
      if (depth === 2) {
        entry = { key: decodePlistScalar(line.slice(0, line.indexOf('='))), fields: new Map<string, string>() }
      }
      continue
    }
    if (depth !== 2 || entry === undefined) continue
    const field = /^([A-Za-z0-9_]+)\s*=\s*(.*);$/.exec(line)
    if (field !== null) entry.fields.set(field[1], decodePlistScalar(field[2]))
  }
  // A plist body with content that yielded no app dict is a shape this parser
  // does not understand — report that, never pretend the device is empty.
  if (apps.length === 0 && text.slice(1, -1).trim() !== '') {
    throw new Error(
      `could not parse the simctl listapps output${where} — the plist carried no app entries (the listing `
      + 'FAILED, which is not the same as the device having no apps)',
    )
  }
  return apps
}

/** Drop the internal `appPath` so the public `InstalledApp` shape stays clean. */
function toPublicApp(app: SimAppWithPath): InstalledApp {
  return {
    bundleId: app.bundleId,
    name: app.name,
    ...(app.baseName === undefined ? {} : { baseName: app.baseName }),
    ...(app.version === undefined ? {} : { version: app.version }),
    system: app.system,
  }
}

/**
 * Public parse: `InstalledApp` without the internal app path. Localized-name
 * resolution (which needs the path) goes through `listSimulatorApps` instead.
 */
export function parseSimctlListApps(stdout: string, device?: string): InstalledApp[] {
  return parseSimctlListAppsWithPath(stdout, device).map(toPublicApp)
}

/** Map one devicectl app record onto the shared shape. */
export function installedAppFromRealApp(app: RealApp): InstalledApp {
  // Two independent system markers, because devicectl reports either one
  // depending on the Xcode version: the boolean `defaultApp` and the string
  // `appType` ("User" / "System"). Neither alone is enough.
  const system = app.defaultApp === true || (app.appType ?? '').toLowerCase() === 'system'
  // The real-device path keeps devicectl's `name` AS-IS: whether devicectl
  // already returns the localized display name is UNVERIFIED (the phone is
  // disconnected), so no .lproj reading is attempted for physical devices.
  return {
    bundleId: app.bundleId,
    name: app.name === '' ? app.bundleId : app.name,
    ...(app.version === undefined || app.version === '' ? {} : { version: app.version }),
    system,
  }
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.max(1, Math.min(limit, items.length)); w += 1) workers.push(run())
  await Promise.all(workers)
  return results
}

/** The script→region mapping behind Apple's underscore .lproj names. */
const SCRIPT_REGION: Record<string, string> = { Hans: 'CN', Hant: 'TW' }

/** The legacy `lang_REGION` .lproj name for a resolved language tag. */
function underscoreLproj(language: string, script: string | undefined, region: string | undefined): string {
  if (script !== undefined) {
    const mapped = SCRIPT_REGION[script]
    if (mapped !== undefined) return `${language}_${mapped}`
  }
  if (region !== undefined) return `${language}_${region}`
  return language
}

/**
 * The .lproj directory names to try, in order, for one `AppleLanguages` entry
 * (e.g. `zh-Hans-US`): the full tag, its base (`zh-Hans`), the underscore
 * form Apple actually names on disk (`zh_CN` — simplified Chinese lives in
 * `zh_CN.lproj`, not `zh-Hans.lproj`), then `Base`, then `en`.
 */
export function lprojCandidates(language: string): string[] {
  const tag = language.trim()
  if (tag === '') return ['Base', 'en']
  const parts = tag.split('-')
  const base = parts[0] ?? ''
  if (base === '') return ['Base', 'en']
  const script = parts.slice(1).find(part => /^[A-Z][a-z]{3}$/.test(part))
  const region = parts.slice(1).find(part => /^[A-Za-z]{2}$/.test(part) || /^[0-9]{3}$/.test(part))
  const candidates = [tag]
  const withScript = script === undefined ? base : `${base}-${script}`
  if (withScript !== tag) candidates.push(withScript)
  const underscore = underscoreLproj(base, script, region)
  if (!candidates.includes(underscore)) candidates.push(underscore)
  for (const fixed of ['Base', 'en']) {
    if (!candidates.includes(fixed)) candidates.push(fixed)
  }
  return candidates
}

/** The host path of a simulator's language preference plist. */
function simulatorPrefsPath(udid: string): string {
  return join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid, 'data', 'Library', 'Preferences', '.GlobalPreferences.plist')
}

/**
 * Resolve the simulator's language ONCE per listing from `AppleLanguages`
 * (first entry). Never throws: an absent/unreadable/malformed plist is "no
 * language", and the caller falls back to `Base`/`en` — a listing must never
 * fail because the language could not be determined.
 */
export async function simulatorLanguage(udid: string, prefsPath: string = simulatorPrefsPath(udid)): Promise<string | undefined> {
  let bytes: Buffer
  try {
    bytes = await readFile(prefsPath)
  } catch {
    return undefined
  }
  try {
    const value = parsePlist(bytes)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const languages = (value as Record<string, unknown>).AppleLanguages
    if (Array.isArray(languages) && typeof languages[0] === 'string' && languages[0] !== '') return languages[0]
    return undefined
  } catch {
    return undefined
  }
}

/** Read one .strings file; any failure is an empty map ("no localized name"). */
async function readStringsFileFromDisk(path: string): Promise<Record<string, string>> {
  try {
    return readStrings(await readFile(path))
  } catch {
    return {}
  }
}

/**
 * Resolve localized display names for parsed simulator apps. For each app with
 * an on-disk path, try `<path>/<candidate>.lproj/InfoPlist.strings` in
 * language order and take the first `CFBundleDisplayName` (then
 * `CFBundleName`) it finds; a missing/unreadable file is "no localized name",
 * never an error. Reads run concurrently with a small bound, so a ~25-app
 * listing stays well under the 1.5 s budget.
 */
export async function localizeSimApps(
  apps: readonly SimAppWithPath[],
  language: string | undefined,
  readStringsAt: (path: string) => Promise<Record<string, string>> = readStringsFileFromDisk,
): Promise<InstalledApp[]> {
  const candidates = language === undefined ? [] : lprojCandidates(language)
  const localized = await mapWithLimit(apps, LOCALIZE_CONCURRENCY, async app => {
    if (app.appPath === undefined || candidates.length === 0) return undefined
    for (const candidate of candidates) {
      const dict = await readStringsAt(join(app.appPath, `${candidate}.lproj`, 'InfoPlist.strings'))
      const display = dict.CFBundleDisplayName
      if (display !== undefined && display !== '') return display
      const bundleName = dict.CFBundleName
      if (bundleName !== undefined && bundleName !== '') return bundleName
    }
    return undefined
  })
  return apps.map((app, index) => {
    const name = localized[index]
    if (name === undefined || name === app.name) return toPublicApp(app)
    return { ...toPublicApp(app), name, baseName: app.name }
  })
}

/**
 * Installed apps on a booted SIMULATOR. A non-zero simctl exit (most often an
 * un-booted device) is a failed listing and throws — the caller must never see
 * it as "nothing installed".
 */
export async function listSimulatorApps(udid: string, signal?: AbortSignal): Promise<InstalledApp[]> {
  let stdout: string
  try {
    stdout = await listAppsPlist(udid, signal)
  } catch (error) {
    throw new Error(
      `could not list the apps installed on ${udid}: ${errorMessage(error)} — the simulator must be BOOTED `
      + '(ios_sim_boot) for simctl to enumerate its apps; a failed listing is not an empty one',
    )
  }
  const parsed = parseSimctlListAppsWithPath(stdout, udid)
  // Language is resolved ONCE for the whole listing, never per app.
  const language = await simulatorLanguage(udid)
  return localizeSimApps(parsed, language)
}

/**
 * Installed apps on a PHYSICAL device (devicectl, stock apps included).
 * `devicectl.listApps` enforces exit code 0 AND `info.outcome === "success"`
 * AND a present `result.apps` array, and its classifier turns CoreDevice error
 * 1011 into the "not reachable by CoreDevice" wording — the exact failure that
 * was misread as "the app is not installed".
 */
export async function listPhysicalDeviceApps(udid: string, signal?: AbortSignal): Promise<InstalledApp[]> {
  const apps = await devicectlListApps(udid, signal)
  return apps.map(installedAppFromRealApp)
}

/**
 * WP60: the no-match `hint` a SUCCESSFUL listing attaches when a query matched
 * nothing. A bare `count: 0` was once read as "the app is not installed" (the
 * exact misread that started a 377 s detour), so the listing must say which
 * empty shape it is. On a phone devicectl reports base names only, so a CJK
 * screen label can never match; on a simulator localized names resolve, so an
 * empty match genuinely means "not installed". Both carry the listed total so
 * the caller can see the listing itself succeeded.
 */
export function noMatchListingHint(kind: 'real' | 'simulator', listedTotal: number): string {
  const total = `${listedTotal} app${listedTotal === 1 ? '' : 's'}`
  return kind === 'real'
    ? `${PHYSICAL_BASE_NAME_HINT}; the listing succeeded and reported ${total} in total`
    : `localized names resolve on a simulator, so this listing was complete and no installed app matches the query; the listing reported ${total} in total`
}

/** Up to `limit` "name (bundleId)" lines, user apps first, for a no-match hint. */
export function noMatchCandidateLines(apps: readonly InstalledApp[], limit = NO_MATCH_CANDIDATE_LIMIT): string[] {
  return [...apps]
    .sort((a, b) => (a.system === b.system
      ? a.name.localeCompare(b.name)
      : a.system ? 1 : -1))
    .slice(0, limit)
    .map(app => `${app.name} (${app.bundleId})`)
}

/** Filter + order one listing: user apps first, then by display name. */
export function filterInstalledApps(
  apps: readonly InstalledApp[],
  options: { query?: string; includeSystem?: boolean } = {},
): InstalledApp[] {
  const query = (options.query ?? '').trim().toLowerCase()
  const includeSystem = options.includeSystem === true
  // The query hits the display name, its base name AND the bundle id, because
  // a task names an app either way ("open <app name>", "launch <bundle id>",
  // or the localized 日历 whose base is Calendar).
  const matched = apps.filter(app => (includeSystem || !app.system)
    && (query === ''
      || app.name.toLowerCase().includes(query)
      || (app.baseName !== undefined && app.baseName.toLowerCase().includes(query))
      || app.bundleId.toLowerCase().includes(query)))
  return matched.sort((a, b) => (a.system === b.system
    ? a.name.localeCompare(b.name)
    : a.system ? 1 : -1))
}

/**
 * Resolve a display NAME to exactly one installed app: substring over display
 * names (localized AND base) first, bundle ids as the fallback, and an exact
 * name match as the tie-break (the same "exact first, then contains" rule
 * ios_sim_tap_element uses). Ambiguity and no-match both throw — with the
 * candidates, or with the verb to run — because guessing a bundle id is what
 * started the 377 s detour.
 *
 * `options.physical` adds the base-name addendum to the no-match error: a
 * phone can only ever report base names, so a CJK label must not be left to
 * guess (the SIMULATOR error omits it because localized names resolve there).
 */
export function resolveAppByName(
  tool: string,
  apps: readonly InstalledApp[],
  name: string,
  deviceName: string,
  options: { physical?: boolean } = {},
): InstalledApp {
  const wanted = name.trim()
  const needle = wanted.toLowerCase()
  if (needle === '') throw new Error(`${tool}: name must be a non-empty app name, e.g. "X" or "Safari"`)
  const matchesName = (app: InstalledApp): boolean => app.name.toLowerCase().includes(needle)
    || (app.baseName !== undefined && app.baseName.toLowerCase().includes(needle))
  const byName = apps.filter(matchesName)
  const pool = byName.length > 0 ? byName : apps.filter(app => app.bundleId.toLowerCase().includes(needle))
  if (pool.length === 0) {
    const candidates = noMatchCandidateLines(apps)
    throw new Error(
      `${tool}: no installed app matches "${wanted}" on ${deviceName} — run ios_sim_list_apps to see what `
      + 'is installed (do not guess a bundle id, and do not look for the app outside the device)'
      + (options.physical !== true ? '' : ` ${PHYSICAL_BASE_NAME_HINT}`)
      + (candidates.length === 0 ? '' : `\n${candidates.join('\n')}`),
    )
  }
  if (pool.length === 1) return pool[0]
  const exact = pool.filter(app => app.name.toLowerCase() === needle
    || (app.baseName !== undefined && app.baseName.toLowerCase() === needle))
  if (exact.length === 1) return exact[0]
  const ambiguous = (exact.length > 1 ? exact : pool).map(app => `${app.name} — ${app.bundleId}`)
  throw new Error(
    `${tool}: ${ambiguous.length} installed apps match "${wanted}" on ${deviceName} — pass bundleId (or a `
    + `longer name) to pick one:\n${ambiguous.join('\n')}`,
  )
}
