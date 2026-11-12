import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { TempoMode } from '../types'
import { DEFAULT_POOL_ROUTING, ensureConfig, getConfig, getHome, loadConfig, resolvePath } from './config'
import type { WorkModeConfig } from './config'

export { DEFAULT_PATTERN, ensureConfig, getConfig, getHome, loadConfig, resolveConfig } from './config'
export type { WorkModeConfig } from './config'

// /work-mode: per-session working modes. State lives in $.state, so it never leaks to other sessions.
// Typed as short words: auto, out, wrap (long internal names still accepted).
// Any words, any order (`/work-mode wrap auto`); the result replaces the current modes.
// out and wrap combine: delegation then covers only work already open, and delegated jobs
// count as open until their results are verified (see comboText).
// PreToolUse gates are shell hooks and cannot read $.state, so the modes are also written
// to ~/.claude/state/tempo/<session_id> (read by work-mode-gates' hooks/lib/tempo-auto.sh).
const modes = atom({ plugin: 'work-mode', key: 'tempo' } as const, [] as TempoMode[])
// Mode texts stay in context once sent, so each goes out once, and again on the next prompt only
// after a compaction or a (re)start may have dropped it.
const sent = atom({ plugin: 'work-mode', key: 'autoSent' } as const, false)
// The pool line last handed over; out repeats it only when the quota table changed it.
const poolsSent = atom({ plugin: 'work-mode', key: 'poolsSent' } as const, '')
// What a /work-mode switch tells the model. A command's `context` does not reach the model
// (2.1.314), so it waits here for the next tool result (mid-turn) or the next prompt.
const pending = atom({ plugin: 'work-mode', key: 'pending' } as const, [] as string[])
// User prompts seen since the mode texts last went out: every reminderEveryTurns of them, a
// one-line reminder rides with the prompt, so a long session does not drift off the modes.
const prompts = atom({ plugin: 'work-mode', key: 'prompts' } as const, 0)

// $.ui.status is one line per plugin. A host mod that joins several parts into one line swaps
// this sink for its own: it takes the work-mode label and returns the whole line to show
// (e.g. `setTempoStatusSink(t => putStatus('tempo', t))`). The engine does not let $ itself
// be handed to a function held in a variable, so the sink only ever sees text.
export type TempoStatusSink = (label: string | undefined) => string | undefined
let statusSink: TempoStatusSink = label => label
export function setTempoStatusSink(fn: TempoStatusSink): void {
  statusSink = fn
}

/** Hands over what the last switch left for the model, once (also mid-turn, from PostToolUse in nudge.ts). */
export async function takePending($: EngineInterface): Promise<string[]> {
  const out = await read($, pending)
  if (out.length > 0) await update($, pending, () => [])
  return out
}

// ---- naming the person -----------------------------------------------------------------

type Words = { who: string; Who: string; subj: string; obj: string; poss: string; is: string }
export function words(cfg: WorkModeConfig): Words {
  const p = cfg.pronouns
  const subj = p === 'he' ? 'he' : p === 'she' ? 'she' : 'they'
  const obj = p === 'he' ? 'him' : p === 'she' ? 'her' : 'them'
  const poss = p === 'he' ? 'his' : p === 'she' ? 'her' : 'their'
  const who = cfg.userName
  return { who, Who: who.charAt(0).toUpperCase() + who.slice(1), subj, obj, poss, is: p === 'they' ? 'are' : 'is' }
}

const plain = (cfg: WorkModeConfig) => (cfg.locale === 'zh-TW' ? 'plain Traditional Chinese' : 'plain language')

// ---- mode texts --------------------------------------------------------------------------

export function dispatchText(cfg: WorkModeConfig = getConfig()): string {
  if (cfg.dispatch.instructions) return cfg.dispatch.instructions.join('\n')
  return [
    '[tempo: dispatch] Delegation mode is ON for this session; the user asked for it with /work-mode out.',
    'Batch work that can be verified by a checker or a spot check (fact checks, extraction, summaries, line-by-line classification) goes to a background subagent (the Agent tool, on a cheaper model such as sonnet or haiku) or to an external CLI that is installed here (for example `codex exec` or `gemini`).',
    'Testable code fixes and adversarial review can go to a second model the same way; the main thread only verifies the results.',
    'Judgement only the main model can make, or work that is nearly done, stays inline.',
  ].join('\n')
}

export function convergeText(cfg: WorkModeConfig = getConfig()): string {
  const w = words(cfg)
  const c = cfg.converge
  const labels = c.decisionLabels.map(l => `[${l}]`).join(' ')
  const example = cfg.locale === 'zh-TW' ? '"A 的好處…；B 的好處…"' : '"Option A pros: ...; Option B pros: ..."'
  const reply =
    cfg.locale === 'zh-TW'
      ? 'written in plain Traditional Chinese (台灣用語, no jargon)'
      : 'written in plain language, no jargon'
  const close = c.autoCloseCommand
    ? `When nothing is open (all work done and verified, no background task, subagent or pane still running, no pending decision), run ${c.autoCloseCommand} yourself without asking. If anything is still running or awaiting the user, do not run it.`
    : 'When nothing is open (all work done and verified, no background task or subagent still running, no pending decision), say in one line that the work is complete and stop.'
  return [
    '[tempo: converge] Converge mode is ON for this session.',
    'Do not open new branches of work; finish what is already open.',
    `Decision items go in a "${c.sectionHeading}" section at the end of the reply.`,
    `Show a decision item only when it is new or its status changed, with your recommendation, ${reply}. Do not repost items already shown: end the reply with one line giving how many decisions are still open, and relist them in full only when asked or in the final report.`,
    `Start each decision item with one label: ${labels}. An item that fits none is yours to do now, not to ask (decision-label-guard blocks unlabeled items).`,
    `[${c.tradeoffLabel}] is not a catch-all: use it only when two paths are both reasonable and the choice turns on ${w.poss} preference, and state what each option gains (${example}). If you cannot name a preference-based reason for each side, do your recommendation now instead of asking.`,
    close,
  ].join('\n')
}

export function autonomousText(cfg: WorkModeConfig = getConfig()): string {
  const w = words(cfg)
  return [
    `[tempo: autonomous] ${w.Who} has granted full autonomy for this session (/work-mode auto).`,
    `Do not stop to ask about internal, reversible decisions: local files, git commits on local branches, worktrees, tests, and merges or deploys ${w.subj} already authorized. Decide, record the choice in your reply, and continue.`,
    `A process or quality gate that denies a call in this mode says how to proceed: follow that text and retry, do not wait for ${w.obj}.`,
    'Hard stops are never done on your own: outgoing messages (mail, chat, social posts), installing packages or cloning, anything touching credentials or secrets, deleting data that cannot be recovered, payments, permission changes, and production changes to config, rules or permissions or that delete production data. Put each one on a pending list and keep working on everything else.',
    ...cfg.autonomous.extraRules,
    `Even when ${w.subj} already approved one of them (e.g. "send it when done"), or any other call will raise a confirmation prompt (hook ask, built-in rm check), run it last: finish every other step first (uploads, file writes, doc updates, commits), then run all prompting calls back to back, so ${w.subj} ${w.is} interrupted once, not mid-work.`,
    `Report the pending list once, at the end of the work, each item with your recommendation, in ${plain(cfg)}.`,
  ].join('\n')
}

/** Sent when out and wrap are both on: delegate to finish, never to open new work. */
export function comboText(cfg: WorkModeConfig = getConfig()): string {
  const close = cfg.converge.autoCloseCommand ?? 'the closing line'
  return [
    '[tempo: dispatch + converge] out and wrap are both on: delegation serves finishing.',
    'Delegate only pieces of work that is already open (remaining checks, extraction, fixes, review of what is on the table); never delegate a new branch of work.',
    `A delegated job counts as open until its result is back and verified on the main thread; ${close} waits for it.`,
  ].join('\n')
}

const both = (l: readonly TempoMode[]) => l.includes('dispatch') && l.includes('converge')

export function modeText(m: TempoMode, cfg: WorkModeConfig = getConfig()): string {
  return m === 'dispatch' ? dispatchText(cfg) : m === 'converge' ? convergeText(cfg) : autonomousText(cfg)
}

/** The weekly (or period) window of a quota row: percent used and seconds to its reset. */
function weekOf(r: Record<string, unknown> | undefined): { used: number; reset?: number } | undefined {
  if (!r) return undefined
  const keys = [
    ['7d_used', '7d_reset_ts'],
    ['gemini_7d_used', 'gemini_7d_reset_ts'],
    ['period_used', 'period_reset_ts'],
  ] as const
  for (const [u, t] of keys) {
    const used = r[u]
    if (typeof used !== 'number') continue
    const reset = r[t]
    return { used, reset: typeof reset === 'number' && reset > 0 ? reset : undefined }
  }
  return undefined
}

/** `46h`, `3d`, `now`: coarse on purpose, so the line changes at most once an hour. */
export function resetIn(reset: number | undefined, now: number): string {
  if (reset === undefined) return '?'
  const h = Math.floor((reset - now) / 3600)
  if (h <= 0) return 'now'
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const PREFER_BELOW = 85 // a pool past this much of its week is not worth preferring
const CLAUDE_ROOM = 50 // the main model's week counts as roomy below this
const MAIN_POOL = 'claude-sub'

/**
 * One routing line from an optional quota table, so out does not keep sending work to a refused pool
 * and spends first the pool whose weekly window expires soonest.
 * The table is a JSON array of rows `{pool: "agy"|"codex"|..., ...usage percents, route: "open"|"floor_5h"|"floor_7d", route_reset_ts}`;
 * a row named `claude-sub` is the main model's own quota and is never preferred, only noted.
 */
export function poolLine(raw: string, now = Date.now() / 1000, cfg: WorkModeConfig = getConfig()): string | undefined {
  let rows: Array<Record<string, unknown>>
  try {
    rows = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(rows)) return undefined
  const routing = cfg.dispatch.poolRouting ?? DEFAULT_POOL_ROUTING
  const row = (pool: string) => rows.find(r => r?.pool === pool)
  const num = (r: Record<string, unknown> | undefined, key: string) => {
    const v = r?.[key]
    return typeof v === 'number' ? v : undefined
  }
  const a = row('agy')
  const c = row('codex')
  const show = (v: number | undefined) => (v === undefined ? '?' : `${Math.round(v)}%`)
  const win = (r: Record<string, unknown> | undefined, five: string, week: string) =>
    `5h ${show(num(r, five))} 7d ${show(num(r, week))}` + (weekOf(r)?.reset !== undefined ? ` (resets in ${resetIn(weekOf(r)?.reset, now)})` : '')
  if ([num(a, 'gemini_5h_used'), num(a, 'gemini_7d_used'), num(c, '5h_used'), num(c, '7d_used')].every(v => v === undefined)) return undefined
  const blocked = (r: Record<string, unknown> | undefined) => {
    const route = r?.route
    if (typeof route !== 'string' || !route.startsWith('floor_')) return undefined
    const reset = num(r, 'route_reset_ts')
    if (reset !== undefined && reset < now) return undefined
    return `${route.slice(6)} window ${show(num(r, 'route_used'))}, resets in ${r?.route_reset_in ?? '?'}`
  }
  const agyOut = blocked(a)
  const codexOut = blocked(c)
  const head = `[tempo: pools] agy ${win(a, 'gemini_5h_used', 'gemini_7d_used')}${agyOut ? ` (refused: ${agyOut})` : ''}; codex ${win(c, '5h_used', '7d_used')}${codexOut ? ` (refused: ${codexOut})` : ''}.`
  const tail = agyOut && codexOut ? routing.bothBlocked : agyOut ? routing.agyBlocked : codexOut ? routing.codexBlocked : routing.bothOpen
  const fill = (t: string, pool: string, used: number, reset: number | undefined) =>
    t.split('{pool}').join(pool).split('{used}').join(show(used)).split('{reset}').join(resetIn(reset, now))
  // Which open external pool to spend first: the one whose week resets soonest and still has room.
  const open = rows
    .filter(r => typeof r?.pool === 'string' && r.pool !== MAIN_POOL && !blocked(r))
    .map(r => ({ pool: String(r.pool), w: weekOf(r) }))
    .filter((x): x is { pool: string; w: { used: number; reset: number } } => x.w !== undefined && x.w.reset !== undefined && x.w.used < PREFER_BELOW)
    .sort((x, y) => x.w.reset - y.w.reset || x.w.used - y.w.used)
  const parts = [head, tail]
  const first = open[0]
  if (first && open.length > 1) parts.push(fill(routing.prefer, first.pool, first.w.used, first.w.reset))
  const main = weekOf(row(MAIN_POOL))
  if (main && main.reset !== undefined && main.used < CLAUDE_ROOM && (first === undefined || main.reset < first.w.reset))
    parts.push(fill(routing.claudeSoon, MAIN_POOL, main.used, main.reset))
  return parts.join(' ')
}

async function readPools($: EngineInterface): Promise<string | undefined> {
  const cfg = getConfig()
  if (!cfg.dispatch.quotaFile) return undefined
  try {
    const home = getHome() || ((await $.env.get('HOME')) ?? '')
    return poolLine(await $.fs.read(resolvePath(cfg.dispatch.quotaFile, home)), Date.now() / 1000, cfg)
  } catch {
    // No table yet: the dispatch text alone.
    return undefined
  }
}

const ORDER: TempoMode[] = ['autonomous', 'dispatch', 'converge']
export const SHORT: Record<TempoMode, string> = { autonomous: 'auto', dispatch: 'out', converge: 'wrap' }

/** What the model reads the moment /work-mode switches: the new modes, and which ones stopped. */
export function switchTexts(
  prev: readonly TempoMode[],
  next: readonly TempoMode[],
  prevSent: boolean,
  pools?: string,
  cfg: WorkModeConfig = getConfig(),
): string[] {
  const w = words(cfg)
  const out: string[] = []
  const stopped = prev.filter(m => !next.includes(m))
  if (next.length === 0) {
    out.push(
      prev.length === 0
        ? '[tempo: off] Work mode is off (/work-mode off).'
        : `[tempo: off] ${w.Who} turned work mode off just now (/work-mode off): ${stopped.map(m => `[tempo: ${m}]`).join(' and ')} no longer applies. Back to normal behaviour from this point, including asking before steps the normal rules say to ask about.`,
    )
    return out
  }
  out.push(`[tempo] ${w.Who} switched work mode just now: ${next.map(m => SHORT[m]).join(' + ')} is on from this point.`)
  if (stopped.length > 0) out.push(`[tempo: off] ${stopped.map(m => `[tempo: ${m}]`).join(' and ')} no longer applies.`)
  for (const m of next) {
    if (prevSent && prev.includes(m)) continue
    out.push(modeText(m, cfg))
    if (m === 'dispatch' && pools !== undefined) out.push(pools)
  }
  if (both(next) && !(prevSent && both(prev))) out.push(comboText(cfg))
  return out
}

export type TempoParse =
  | { kind: 'status' }
  | { kind: 'set'; modes: TempoMode[]; note?: string }
  | { kind: 'error'; message: string }

/** Short words typed after /work-mode, mapped to the internal mode names the gate state file uses. */
const WORDS: Record<string, TempoMode> = {
  auto: 'autonomous', autonomous: 'autonomous',
  out: 'dispatch', dispatch: 'dispatch',
  wrap: 'converge', converge: 'converge',
}

/** `/work-mode auto out`, `/work-mode wrap auto`, `/work-mode off`, or nothing for status. */
export function parseTempo(arg: string): TempoParse {
  const list = arg.toLowerCase().split(/[\s,+]+/).filter(Boolean)
  if (list.length === 0) return { kind: 'status' }
  const picked = new Set<TempoMode>()
  for (const w of list) {
    // off next to other words adds nothing: the words already replace the whole state.
    if (w === 'off') continue
    const mode = WORDS[w]
    if (!mode) return { kind: 'error', message: `Unknown mode "${w}".` }
    picked.add(mode)
  }
  return { kind: 'set', modes: ORDER.filter(m => picked.has(m)) }
}

// The picker shown by a bare /work-mode is a multi-select: tick any mix, it replaces the
// current modes. AskUserQuestion takes at most 4 labels; "off" shows only when something is on.
// Labels never hold a half-width comma: the answer comes back comma-joined.
export function pickerLabels(current: readonly TempoMode[], cfg: WorkModeConfig = getConfig()): string[] {
  const zh = cfg.locale === 'zh-TW'
  const hint = cfg.dispatch.pickerHint.replace(/,/g, zh ? '／' : '/')
  const labels = zh
    ? ['auto 自主（中途不問）', `out 外派（${hint}）`, 'wrap 收斂（不開新方向）', 'off 關閉']
    : ['auto - autonomous (no mid-task questions)', `out - delegate (${hint})`, 'wrap - converge (no new branches)', 'off - turn off']
  return current.length > 0 ? labels : labels.slice(0, 3)
}

/** A multi-select answer (comma-joined labels, or typed Other text) -> /work-mode words. */
export function pickedArgs(answer: string, cfg: WorkModeConfig = getConfig()): string {
  // Only an actual picker label (either language) is cut to its leading word; typed text stays whole
  // so parseTempo still rejects what it does not know ("auto nonsense" is an error, not "auto").
  const labels = new Set([
    ...pickerLabels(['autonomous'], { ...cfg, locale: 'en' }),
    ...pickerLabels(['autonomous'], { ...cfg, locale: 'zh-TW' }),
  ])
  return answer
    .split(',')
    .map(a => a.trim())
    .filter(Boolean)
    .map(a => (labels.has(a) ? (a.split(/\s+/)[0] ?? a) : a))
    .join(' ')
}

export function tempoLabel(m: readonly TempoMode[]): string | undefined {
  const parts = [
    m.includes('autonomous') ? 'AUTO' : '',
    m.includes('dispatch') ? 'OUT' : '',
    m.includes('converge') ? 'WRAP' : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' + ') : undefined
}

/** True when /work-mode out is on; the dispatch nudge only speaks in that mode. */
export async function dispatchOn($: EngineInterface): Promise<boolean> {
  return (await read($, modes)).includes('dispatch')
}

async function refresh($: EngineInterface): Promise<void> {
  $.ui.status(statusSink(tempoLabel(await read($, modes))))
}

// Gate hooks read this file by session id. No modes means no file: it is removed, never left stale.
async function writeState($: EngineInterface, sessionId: string, list: readonly TempoMode[]): Promise<void> {
  if (!sessionId) return
  try {
    const home = getHome() || (await $.env.get('HOME'))
    if (!home) return
    const path = `${home}/.claude/state/tempo/${sessionId}`
    if (list.length === 0) {
      const r = await $.process.run(['rm', '-f', path], { timeoutMs: 5000 })
      // If the file cannot be removed, an empty list is the same answer to the gates.
      if (r.exitCode !== 0) await $.fs.write(path, JSON.stringify({ modes: [] }) + '\n')
    } else {
      await $.fs.write(path, JSON.stringify({ modes: list }) + '\n')
    }
  } catch {
    // Without the file the gates keep asking, which is the safe direction.
  }
}

export async function tempoStart($: EngineInterface): Promise<void> {
  await loadConfig($)
  await $.command.register({
    name: 'work-mode',
    description: 'Work mode: auto (no questions) | out (delegate) | wrap (converge) | off',
    argumentHint: '[auto] [out] [wrap] | off',
    immediate: true,
  })
  await update($, sent, () => false)
  await refresh($)
  await writeState($, await $.session.id(), await read($, modes))
}

/** /clear starts a fresh conversation: modes go off, and the status line is redrawn (session.start does not fire). */
export async function tempoClear($: EngineInterface): Promise<void> {
  await loadConfig($)
  await update($, modes, () => [])
  await update($, sent, () => false)
  await writeState($, await $.session.id(), [])
  await refresh($)
}

/** The summary or a resume may have dropped the mode texts: send them again with the next prompt. */
export async function tempoResend($: EngineInterface): Promise<void> {
  await loadConfig($)
  await update($, sent, () => false)
}

/** Context handed to the model with this prompt: the mode texts only when they are not in context yet. */
export async function tempoContext($: EngineInterface, sessionId: string): Promise<string[]> {
  const cfg = await ensureConfig($)
  const list = await read($, modes)
  await writeState($, sessionId, list)
  const queued = await takePending($)
  if (list.length === 0) return queued
  const wasSent = await read($, sent)
  const texts = await modeTexts($, list)
  if (!wasSent) {
    await update($, prompts, () => 0)
    return [...queued, ...texts]
  }
  const n = (await read($, prompts)) + 1
  await update($, prompts, () => n)
  const every = cfg.reminderEveryTurns
  if (every > 0 && n % every === 0) texts.push(reminderText(list, cfg))
  return [...queued, ...texts]
}

/** One line, every reminderEveryTurns prompts, so the modes outlast a long conversation. */
export function reminderText(list: readonly TempoMode[], cfg: WorkModeConfig = getConfig()): string {
  const parts: string[] = []
  if (list.includes('autonomous')) parts.push('auto = decide internal reversible steps yourself, hard stops go on the pending list')
  if (list.includes('dispatch')) parts.push(`out = batch reading and verifiable work go out (${cfg.dispatch.pickerHint}) before you read it; the main thread verifies`)
  if (list.includes('converge')) parts.push(`wrap = no new branches, decisions under "${cfg.converge.sectionHeading}" with a label and a recommendation, close when nothing is open`)
  return `[tempo] still on: ${list.map(m => SHORT[m]).join(' + ')}. ${parts.join('; ')}.`
}

async function modeTexts($: EngineInterface, list: readonly TempoMode[]): Promise<string[]> {
  const cfg = getConfig()
  const pools = list.includes('dispatch') ? await readPools($) : undefined
  if (!(await read($, sent))) {
    await update($, sent, () => true)
    if (pools !== undefined) await update($, poolsSent, () => pools)
    const out: string[] = []
    for (const m of list) {
      out.push(modeText(m, cfg))
      if (m === 'dispatch' && pools !== undefined) out.push(pools)
    }
    if (both(list)) out.push(comboText(cfg))
    return out
  }
  if (pools === undefined || pools === (await read($, poolsSent))) return []
  await update($, poolsSent, () => pools)
  return [pools]
}

/** The reply /work-mode prints after a switch. */
export function switchReply(m: readonly TempoMode[], note: string | undefined, cfg: WorkModeConfig = getConfig()): string {
  const tail = note ? ` (${note})` : ''
  if (m.length === 0) return 'Work mode off: back to normal.' + tail
  if (m.length === 1 && m[0] === 'converge')
    return 'Work mode wrap: no new branches, replies show new decisions plus an open count. /work-mode off to stop.' + tail
  return (
    `Work mode ${m.map(x => SHORT[x]).join(' + ')}: ` +
    (m.includes('autonomous')
      ? 'no mid-task questions on internal reversible steps; compatible PreToolUse gates deny with a how-to instead of asking; hard stops go to a pending list. '
      : '') +
    (m.includes('dispatch')
      ? `The delegation reminder (${cfg.dispatch.pickerHint}) reaches the model once, with its next tool result or prompt. `
      : '') +
    (m.includes('converge') ? 'No new branches; replies end with decisions plus recommendations. ' : '') +
    (both(m) ? 'Delegation only finishes work already open. ' : '') +
    '/work-mode off to stop.' +
    tail
  )
}

export function registerTempo(on: On): void {
  on('command.run', { command: 'work-mode' }, async ($, e) => {
    const cfg = await ensureConfig($)
    let parsed = parseTempo(e.args)
    if (parsed.kind === 'status') {
      try {
        const current = await read($, modes)
        const label = tempoLabel(current) ?? 'off'
        const question =
          cfg.locale === 'zh-TW'
            ? `Work mode 目前：${label}。勾選要開的模式（可複選，會取代目前的設定）：`
            : `Work mode is now: ${label}. Tick the modes to turn on (any mix; it replaces the current set):`
        const answer = await $.ui.ask(question, {
          options: pickerLabels(current, cfg),
          header: 'Work mode',
          multiSelect: true,
        })
        parsed = parseTempo(pickedArgs(answer, cfg))
      } catch (err) {
        // Dismissed, or nobody to ask: fall through to the plain status line.
        $.ui.log(`tempo picker unavailable: ${String(err).slice(0, 300)}`, { to: 'debug' })
      }
    }
    const usage = 'Use /work-mode with any of auto, out, wrap (any order), or off.'
    if (parsed.kind === 'error') return { text: `${parsed.message} ${usage}` }
    if (parsed.kind === 'status') {
      const label = tempoLabel(await read($, modes)) ?? 'off'
      return { text: `Work mode: ${label}. ${usage}` }
    }
    const prev = await read($, modes)
    const prevSent = await read($, sent)
    const pools = parsed.modes.includes('dispatch') ? await readPools($) : undefined
    await update($, pending, () => switchTexts(prev, parsed.modes, prevSent, pools, cfg))
    await update($, modes, () => parsed.modes)
    await update($, sent, () => true)
    await update($, prompts, () => 0)
    if (pools !== undefined) await update($, poolsSent, () => pools)
    await writeState($, await $.session.id(), parsed.modes)
    await refresh($)
    return { text: switchReply(parsed.modes, parsed.note, cfg) }
  })
}
