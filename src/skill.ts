/**
 * The plugin's bundled playbook, contributed through `ctx.skills.register()`.
 *
 * Why a skill and not a longer tool description: tool descriptions answer
 * "what does this argument mean", one tool at a time. What agents actually
 * re-derive every session is the WORKFLOW between the tools — which observer
 * to reach for, how to confirm an action landed, what a Chinese label's OCR
 * confidence looks like. A session log measured 25 observation calls for 6
 * actions, plus raw `curl` against WebDriverAgent and an ad-hoc PIL script
 * counting red pixels to check whether a like had registered: all knowledge
 * this file now hands over up front.
 *
 * Everything asserted here was measured on this plugin's own tools (the
 * numbers are from an iPhone 17 Pro and an iPhone 17 Pro simulator), so the
 * playbook ages with the code rather than with someone's memory.
 *
 * Registration is DEFENSIVE: a profile without the skill service still loads
 * the plugin, it just does not advertise the playbook.
 *
 * @module @zseven-w/dsh-ios/skill
 */

import type { Context } from '@deepseek-ai/cordis'

/** Kebab-case skill id, addressable as `/ios-ui-automation`. */
export const IOS_SKILL_NAME = 'ios-ui-automation'

export const IOS_SKILL_DESCRIPTION =
  'Drive an iOS Simulator or a USB-connected iPhone: read the screen, tap, scroll, type, and confirm '
  + 'that an action landed. Read this before the first ios_sim_* call of a UI task.'

export const IOS_SKILL_WHEN_TO_USE =
  'Any task that operates an iOS app through the ios_sim_* tools — opening apps, tapping controls, '
  + 'filling fields, scrolling a feed, or verifying what is on screen, on a simulator or a real device.'

/**
 * The playbook body. Model-facing, so it is English like the tool
 * descriptions, and it states costs in milliseconds because the whole point
 * is helping the model choose the cheap path first.
 */
export const IOS_SKILL_CONTENT = `# Driving iOS with dsh-ios

The loop is **observe once → act with an assertion → observe again only if the assertion could not settle it**. A measured session spent 25 observation calls on 6 actions; most of that is avoidable with the tools below.

## Reading the screen

| Tool | Cost (sim / phone) | Use it for |
| --- | --- | --- |
| \`ios_sim_find_text\` | ~0.9 s / ~1.2 s | "what text is on screen, and where" — the default observer |
| \`ios_sim_ui_tree\` | ~1.3 s / ~2.6 s | hierarchy, identifiers, enabled/visible state |
| \`ios_sim_screenshot\` | ~0.3 s | showing the USER a picture |

- Start with \`ios_sim_find_text\`. Reach for \`ios_sim_ui_tree\` when you need an element's identity (identifier / label / type) rather than its text.
- The screenshot path is for humans. Do NOT feed it to an image-reading tool: on a text-only model that call always fails, and pixel-diffing is never how you check whether a tap worked (see *Confirming*).
- On a real device the tree is depth-capped by default (an uncapped snapshot of a busy app measured **32.6 s / 751 KB**; capped it is ~2 s). Pass \`max_depth\` to go deeper only when you truly need it.

## Acting

- Prefer \`ios_sim_tap_text\` (OCR text) or \`ios_sim_tap_element\` (identifier/label). Raw coordinates through \`ios_sim_interact action=tap\` are the last resort — they break on the next layout change.
- Scrolling is \`ios_sim_interact action=scroll\` with \`direction\`. Never hand-build a gesture against WebDriverAgent with \`curl\`; the tool already clamps the path away from the home-indicator strip, which the system otherwise swallows.
- \`ios_sim_launch_app\` opens an installed app — no shell needed. **Never guess a third-party bundle id.** Pass \`name\` (a case-insensitive display-name substring, CJK included) or run \`ios_sim_list_apps\` first. A bundle id that looks plausible — the one from an app's former name, or the pattern a sibling app uses — is routinely NOT the installed one, and a wrong guess is indistinguishable from "not installed" until you list. One measured session burned 25 \`bash\` calls (6.6 s each, 165 s) on a guessed id before being aborted.
- Names differ by target: on a **simulator** \`ios_sim_list_apps\` / \`ios_sim_launch_app\` resolve the on-screen (localized) name — 日历, not Calendar — so list/launch by what the user sees. On a **phone** devicectl reports each app's base (usually English) name only, so a Chinese label from the screen will not match — use the English name or the bundle id, or tap the icon (\`ios_sim_find_text\` + \`ios_sim_tap_text\`).
- Stable bundle ids, **Apple apps only**: Calendar \`com.apple.mobilecal\`, Safari \`com.apple.mobilesafari\`, Settings \`com.apple.Preferences\`, Photos \`com.apple.mobileslideshow\`, Messages \`com.apple.MobileSMS\`, Maps \`com.apple.Maps\`, Notes \`com.apple.mobilenotes\`.
- Typing is US-keyboard only on a simulator: \`ios_sim_interact action=type\` rejects non-ASCII (Chinese, emoji). Put the text on the clipboard and paste it instead.

## Boundaries

- Everything the task needs is **on the device**. If an app seems to be missing, list the installed apps (\`ios_sim_list_apps\`) — never go looking for it in the user's source tree, in Xcode's DerivedData, or in unrelated repositories. That direction is always wrong: the app is a bundle on the phone, not a project on the Mac.
- An empty or failed listing is **not** proof an app is absent. Read the tool's error: it distinguishes "the device is not reachable by CoreDevice right now — reconnect it over USB" (nothing was enumerated) from "no installed app matches …" (the device answered). A raw \`xcrun devicectl device info apps\` prints nothing in the first case, which is exactly how one session mistook an unreachable phone for a missing app and then searched the filesystem for 377 s until the user stopped it.

## Confirming an action landed

- Pass \`expect_text\` (or \`expect_gone\`) to the tap tools: the tap and its verification become one round trip, and the result carries \`expected.matched\`.
- For list/feed actions the ONLY reliable confirmation is the counter change: \`ios_sim_tap_row\` with \`expect_count={key,delta}\` (±1) re-reads the row label and reports \`countCheck.verified\`. If it is not verified, say so — never treat an unverified tap as done, and never re-tap blindly to "see if it worked".
- Waiting for something slow (a load, an animation, a network round trip) is \`ios_sim_wait_for\` — one call that polls internally, instead of a find_text loop.
- Never compare screenshots or count pixels to decide whether something happened. Read the text back.

## OCR facts that matter

- Chinese/Japanese labels commonly read at **confidence 0.3–0.6**. The default \`min_confidence\` is 0.3 — do NOT raise it to 0.8 "to be safe": that filters out exactly the CJK buttons you are aiming at. \`ios_sim_tap_text\` will tell you when a match existed below your threshold.
- OCR rectangles come back in POINTS, matching the coordinate space the tap tools take.

## Real devices

- **Every tap on a real device has real consequences** — posts, likes, purchases, messages, shares. NEVER tap an unidentified control to find out what it does; that is exactly what turned one session into a 20-minute account-mutating probe (share sheets opened, bookmarks, extra likes).
- If a control cannot be identified (no labeled element after a DEEP tree, no distinguishing text), STOP and report what you see, asking the user how to proceed. Do not guess coordinates from neighbouring text on a real account.
- Icon-only controls (a heart, a bookmark) carry no OCR text by definition: the accessibility tree is the only reliable way to find them — a bare tree means "look deeper", never "start guessing".
- A shallow or empty tree is NEVER evidence that an app lacks accessibility support. Attribute an unlabeled read to ONE of three causes — (a) depth too shallow: re-read deeper (\`max_depth\` / \`ios_sim_ui_rows\`); (b) the output was filtered (a filter missed, the output cap pruned levels, or every labeled element was off-screen); (c) a DEEP, unfiltered read with no labels — only then may "little or no accessibility information" be reported, and only then is OCR the fallback. Never jump from a shallow read to "OCR the screen".
- Every WebDriverAgent action costs ~0.5 s and WDA serves requests SERIALLY: one expensive call (an uncapped tree) delays everything queued behind it.
- The phone must be UNLOCKED for WebDriverAgent to start, and a locked screen blocks everything afterwards. Suggest setting Auto-Lock to Never during a long session.
- When a real-device tool fails, read the coded reason from the panel's status rather than guessing: \`device-locked\` (unlock it), \`device-unplugged\` (a data-capable USB cable — a Wi-Fi-only pairing cannot carry the port forward), \`tunnel-failed\`, \`cert-untrusted\`, \`profile-expired\`.
- \`ios_real_start_wda\` is the only call allowed to build and launch WebDriverAgent; a cold build takes minutes. Do not retry it in a loop — poll the status instead.

## Lists and feeds (row-level abstraction)

- Feed/list apps aggregate each item into ONE accessibility Cell whose label holds the summary AND all its counters ("57 回复。18 喜欢。592 次查看"), with NO per-control child buttons to match. Those cells only surface at a DEEP snapshot: measured \`max_depth\` 60 ≈ 476 KB / 13–22 s per read on a phone (WDA is serial — budget it).
- \`ios_sim_ui_rows\` reads the visible rows: 0-based index, frame, the aggregated label, and counters parsed GENERICALLY from the label (number + classifier token, 中文/English — no app vocabulary). Pass a counter key EXACTLY as listed; the keys round-trip.
- Reach a control inside a row with \`ios_sim_tap_row\` at a RELATIVE position (x/y as fractions of that row's frame — a right-side action button is often near x=0.9). Never hand-compute absolute screen coordinates from a remembered tree: the tool re-locates the row in a FRESH read, and an out-of-range row index FAILS instead of clamping.
- Confirm a row action with \`expect_count={key,delta}\` (+1 or -1): the tool re-reads the row label and reports \`countCheck.verified\`. This is the ONLY reliable confirmation a list app offers. If a count key is not among the row's parsed counters the tap is REFUSED before it happens — an unidentifiable control is never probed, and a probe tap on a real account is exactly the failure mode this rule closes.
- A tap with no \`expect_count\` is an explicitly positioned row-relative tap, still identified by its row — but nothing is verified, so prefer \`expect_count\` whenever the row label carries counters.

## Choosing the device

\`ios_sim_devices\` lists simulators and, under \`realDevices\`, USB-connected phones. Every ios_sim_* tool takes either kind of udid; the tools route simulator udids through simctl/serve-sim and physical udids through WebDriverAgent automatically.
`

/**
 * Register the playbook when the host provides the skill service.
 *
 * `ctx.inject(['skills'], …)` rather than a `ctx.skills?.` guard: cordis
 * refuses the mere PROPERTY ACCESS on an undeclared service ("cannot get
 * property \"skills\" without inject") and the throw takes the whole plugin
 * down with it — the optional-service pattern is the scoped inject, exactly
 * like the webServer routes. A profile without the skill service simply never
 * runs the callback.
 */
export function registerIosSkill(ctx: Context): () => void {
  // `ctx.inject` returns the scoped FIBER, not a disposer; its own `dispose`
  // is what tears the scope down, so the plugin's teardown list stays uniform.
  const fiber = ctx.inject(['skills'], skillCtx => {
    const skills = (skillCtx as Context & {
      skills: {
        register: (skill: {
          name: string
          description: string
          whenToUse?: string
          content: string
          source: string
        }) => () => void
      }
    }).skills
    skillCtx.effect(() => skills.register({
      name: IOS_SKILL_NAME,
      description: IOS_SKILL_DESCRIPTION,
      whenToUse: IOS_SKILL_WHEN_TO_USE,
      content: IOS_SKILL_CONTENT,
      source: 'bundled',
    }), 'dsh-ios:skill')
  })
  return () => { void fiber.dispose() }
}
