import type { EngineInterface, On } from 'claude-code'

// Config comes through tempo.ts only, so one module instance holds it even when the files are linked in.
import { DEFAULT_PATTERN, dispatchOn, ensureConfig, getConfig, getHome, takePending } from './tempo'
import type { WorkModeConfig } from './tempo'

// Only with /work-mode out. Two parts, both per turn:
//  - the nudge (PostToolUse): when the main thread has pulled a lot of raw material into context
//    this turn (Read/Bash/Grep output) without delegating anything, say once that this batch
//    could go to a subagent or an external CLI.
//  - the read gate (PreToolUse): past the same threshold, further reads are refused with a
//    how-to, so delegating becomes the default and reading on is a declared choice: the model
//    either delegates, or runs a no-op Bash `: # work-mode: inline <reason>` and the reads pass
//    for the rest of the turn (the reason is logged for the next review). A path matching
//    dispatch.corpusPattern (transcripts, dumps) is refused on its first read, before any count.
// With dispatch.subagentsDelegate false, Claude subagents spend the same quota: their reads
// count too, spawning one is not delegating, and a nudge they trip waits for the main thread.
// The gate itself never fires inside a subagent: the main thread chose to spawn it. With
// subagentsDelegate false an Agent call is refused too, unless its prompt opens with
// `why-claude: <reason>`: the one line that says why the job needs Claude rather than a cheaper pool.

let chars = 0
let dispatched = false
let nudged = false
let declared: string | undefined
let due: string | undefined

export function resetNudge(): void {
  chars = 0
  dispatched = false
  nudged = false
  declared = undefined
  due = undefined
}

/** `why-claude: <reason>` at the top of an Agent prompt says why this job needs a Claude subagent. */
export const WHY_CLAUDE = /^\s*(?:<[^>]*>\s*)?why-claude:\s*([^\n]*)/i

/** The refusal of an Agent call under out when subagents spend the main quota (dispatch.subagentsDelegate false). */
export function agentText(cfg: WorkModeConfig = getConfig()): string {
  const hint = cfg.dispatch.pickerHint
  return cfg.locale === 'zh-TW'
    ? `[dispatch-gate] out 模式：Claude 子代理花的是同一份週額度。這件事如果是讀取、抽取、分類、摘要、核對這類能驗收的批次工作，改交外部 CLI（${hint}）。真的需要 Claude（要改檔、要 MCP 或憑證、要判斷力、接續主線已讀的脈絡），在 prompt 第一行寫 \`why-claude: <一句理由>\` 再派一次就放行，理由會記錄。`
    : `[dispatch-gate] out is on: a Claude subagent spends the same weekly quota as this thread. If this job is reading, extraction, classification, summarising or checking that a spot check can verify, send it to an external CLI (${hint}) instead. If it really needs Claude (edits, MCP or credentials, judgement, context already read here), put \`why-claude: <one-line reason>\` on the first line of the prompt and call again; it then passes and the reason is logged.`
}

export function responseLength(v: unknown): number {
  if (typeof v === 'string') return v.length
  return (JSON.stringify(v) ?? 'null').length
}

export function nudgeText(n: number, cfg: WorkModeConfig = getConfig()): string {
  if (cfg.dispatch.nudgeTemplate) return cfg.dispatch.nudgeTemplate.split('{chars}').join(String(n))
  if (cfg.locale === 'zh-TW')
    return `[dispatch-nudge] 這一回合主線已讀進約 ${n} 字元的原始內容、還沒外派。剩下的逐條分類、核對、抽取、摘要若能用檢查器或抽查驗收，改派背景子代理（Agent 工具）或外部 CLI（${cfg.dispatch.pickerHint}）處理，主線只驗收結果。已經快做完、或必須由主模型判斷的，照常繼續。`
  return `[dispatch-nudge] This turn the main thread has read about ${n} characters of raw material without delegating anything. If the remaining classification, checking, extraction or summarising can be verified by a checker or a spot check, hand it to a background subagent (the Agent tool) or an external CLI (${cfg.dispatch.pickerHint}) and only verify the result here. If it is nearly done or needs the main model's judgement, carry on.`
}

/** The refusal the read gate hands the model; `corpus` names the path that is batch material by itself. */
export function gateText(n: number, corpus: string | undefined, cfg: WorkModeConfig = getConfig()): string {
  const hint = cfg.dispatch.pickerHint
  if (cfg.dispatch.gateTemplate) return cfg.dispatch.gateTemplate.split('{chars}').join(String(n)).split('{hint}').join(hint)
  const how =
    cfg.locale === 'zh-TW'
      ? `要繼續在主線讀，先跑一個空指令宣告理由：\`: # work-mode: inline <一句理由>\`，這一回合之後的讀取就放行（理由會記錄下來）。`
      : `To keep reading inline, first run a no-op Bash declaring why: \`: # work-mode: inline <one-line reason>\`; reads then pass for the rest of this turn (the reason is logged).`
  if (corpus)
    return cfg.locale === 'zh-TW'
      ? `[dispatch-gate] out 模式：\`${corpus}\` 是整批原始材料（對話紀錄、逐字稿、傾印檔），主線不直接讀。把要查的問題寫成一句話，交給背景子代理或外部 CLI（${hint}）去讀，主線只驗收結果。${how}`
      : `[dispatch-gate] out is on: \`${corpus}\` is batch material (transcripts, dumps, logs); the main thread does not read it. Put the question in one line and hand the reading to a background subagent or an external CLI (${hint}); verify the result here. ${how}`
  return cfg.locale === 'zh-TW'
    ? `[dispatch-gate] out 模式：這一回合主線已讀進約 ${n} 字元、還沒外派，再讀下去就是整批讀取。把剩下的讀取、抽取、分類、核對交給背景子代理或外部 CLI（${hint}），主線只驗收結果。${how}`
    : `[dispatch-gate] out is on: this turn the main thread has read about ${n} characters without delegating; reading on is batch work. Hand the remaining reading, extraction, classification or checking to a background subagent or an external CLI (${hint}) and verify the result here. ${how}`
}

let patternSource = ''
let pattern = new RegExp(DEFAULT_PATTERN)
function dispatchPattern(cfg: WorkModeConfig): RegExp {
  if (cfg.dispatch.commandPattern !== patternSource) {
    patternSource = cfg.dispatch.commandPattern
    try {
      pattern = new RegExp(patternSource)
    } catch {
      pattern = new RegExp(DEFAULT_PATTERN)
    }
  }
  return pattern
}

let corpusSource: string | undefined
let corpus: RegExp | undefined
function corpusPattern(cfg: WorkModeConfig): RegExp | undefined {
  if (cfg.dispatch.corpusPattern !== corpusSource) {
    corpusSource = cfg.dispatch.corpusPattern
    try {
      corpus = corpusSource ? new RegExp(corpusSource) : undefined
    } catch {
      corpus = undefined
    }
  }
  return corpus
}

/** `: # work-mode: inline <reason>` anywhere in a Bash command declares inline reading for the turn. */
export const INLINE = /#\s*work-mode:\s*inline\b[ \t]*([^\n]*)/
/** A Bash command whose first word in any segment prints file contents counts as a read. */
const READER = /^(?:cat|head|tail|sed|less|more|bat|jq|awk|grep|rg|ag|strings|xxd|hexdump|cut|sort|uniq|wc|tr|xargs\s+cat|python3?\s+-c|node\s+-e|perl\s+-e|ruby\s+-e)(?:\s|$)/

/** Mask quoted text and heredoc bodies, and retain real shell comments separately. */
function shellParts(command: string): { visible: string; comments: string[] } {
  let visible = ''
  const comments: string[] = []
  let heredoc: string | undefined
  let quote = ''
  for (const line of command.split('\n')) {
    if (heredoc !== undefined) {
      if (line.trim() === heredoc) heredoc = undefined
      visible += '\n'
      continue
    }
    let masked = ''
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '\\' && quote !== "'") { masked += '  '; i++; continue }
      if (quote) { if (ch === quote) quote = ''; masked += ' '; continue }
      if (ch === "'" || ch === '"') { quote = ch; masked += ' '; continue }
      if (ch === '#' && (i === 0 || /[\s;|&()]/.test(line[i - 1] ?? ''))) {
        comments.push(line.slice(i)); break
      }
      masked += ch
    }
    const marker = line.match(/<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/)
    if (marker && /<<-?/.test(masked)) heredoc = marker[1]
    visible += masked + '\n'
  }
  return { visible, comments }
}

function segments(visible: string): string[] {
  return visible.split(/[;&|()\n]+/).map(s => s.trim()).filter(Boolean)
}

function isDispatch(visible: string, cfg: WorkModeConfig): boolean {
  return segments(visible).some(s => {
    const match = dispatchPattern(cfg).exec(s)
    return match !== null && match.index === 0
  })
}

/** Feeds one finished tool call in (`subagent`: it ran inside a subagent); returns the nudge text the one time it is due. */
export function observe(
  tool: string,
  input: unknown,
  response: unknown,
  threshold: number = getConfig().dispatch.nudgeThresholdChars,
  cfg: WorkModeConfig = getConfig(),
  subagent = false,
): string | undefined {
  const viaClaude = cfg.dispatch.subagentsDelegate
  if (subagent && viaClaude) return undefined
  const cmd = String((input as { command?: unknown } | null)?.command ?? '')
  if ((viaClaude && (tool === 'Agent' || tool === 'Workflow')) || (tool === 'Bash' && isDispatch(shellParts(cmd).visible, cfg))) dispatched = true
  if (tool === 'Read' || tool === 'Bash' || tool === 'Grep' || tool === 'WebFetch') chars += responseLength(response)
  if (!dispatched && !nudged && chars >= threshold) {
    nudged = true
    return nudgeText(chars, cfg)
  }
  return undefined
}

export type GateVerdict = { deny: string } | { declared: string } | undefined

/**
 * The read gate, before a tool call on the main thread with out on. Returns a refusal, the inline
 * reason just declared (to log), or nothing. `threshold` is the same count the nudge uses.
 */
export function gate(
  tool: string,
  input: unknown,
  threshold: number = getConfig().dispatch.nudgeThresholdChars,
  cfg: WorkModeConfig = getConfig(),
): GateVerdict {
  if (!cfg.dispatch.readGate) return undefined
  const inp = (input ?? {}) as Record<string, unknown>
  const cmd = tool === 'Bash' ? String(inp.command ?? '') : ''
  const shell = shellParts(cmd)
  if (tool === 'Bash') {
    const m = shell.comments.map(comment => INLINE.exec(comment)).find(Boolean)
    if (m) {
      const reason = (m[1] ?? '').trim()
      if (reason.length < 3) return { deny: gateText(chars, undefined, cfg) }
      declared = reason
      return { declared }
    }
  }
  if (tool === 'Agent' && !cfg.dispatch.subagentsDelegate) {
    const m = WHY_CLAUDE.exec(String(inp.prompt ?? ''))
    if (m) return { declared: `why-claude: ${(m[1] ?? '').trim() || '(no reason given)'}` }
    return { deny: agentText(cfg) }
  }
  if (declared !== undefined || dispatched) return undefined
  const reads = tool === 'Read' || tool === 'Grep' || tool === 'WebFetch' || (tool === 'Bash' && segments(shell.visible).some(s => READER.test(s)))
  const c = corpusPattern(cfg)
  const target = tool === 'Bash' ? cmd : String(inp.file_path ?? inp.path ?? inp.url ?? '')
  if (declared === undefined && reads && c && target && (c.test(target) || (tool === 'Bash' && target.split(/\s+/).some(word => c.test(word))))) {
    return { deny: gateText(chars, target.slice(0, 80), cfg) }
  }
  if (tool === 'Bash' && isDispatch(shell.visible, cfg)) return undefined
  if (!reads) return undefined
  if (chars >= threshold) return { deny: gateText(chars, undefined, cfg) }
  return undefined
}

async function logInline($: EngineInterface, reason: string, tool: string): Promise<void> {
  try {
    const home = getHome() || ((await $.env.get('HOME')) ?? '')
    if (!home) return
    const sid = await $.session.id()
    const path = `${home}/.claude/state/tempo-inline/${sid}.jsonl`
    let prev = ''
    try {
      prev = await $.fs.read(path)
    } catch {
      prev = ''
    }
    await $.fs.write(path, prev + JSON.stringify({ ts: new Date().toISOString(), chars, tool, reason }) + '\n')
  } catch {
    // The log is for the next review only; never block work over it.
  }
}

export function registerNudge(on: On): void {
  // The read gate: only the main thread (tool.call carries agentId; classic.PreToolUse does not), only with out on.
  // Matched on the reader tools, so a host mod with its own unmatched tool.call hook can still load this module.
  on('tool.call', { tool: /^(?:Read|Grep|Bash|WebFetch|Agent)$/ }, async ($, e, next) => {
    if (e.agentId || !(await dispatchOn($))) return next(e)
    const cfg = await ensureConfig($)
    const raw = Number(await $.env.get('DISPATCH_NUDGE_CHARS'))
    const v = gate(e.tool, e, raw > 0 ? raw : cfg.dispatch.nudgeThresholdChars, cfg)
    if (v === undefined) return next(e)
    if ('declared' in v) {
      await logInline($, v.declared, e.tool)
      return next(e)
    }
    return { deny: v.deny }
  })

  // One PostToolUse hook for the module: it also carries a /work-mode switch made mid-turn.
  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    const sub = Boolean(e.agent_id)
    // Only the main thread decides routing, so notices are never handed to a subagent.
    const extra = sub ? [] : await takePending($)
    if (await dispatchOn($)) {
      const cfg = await ensureConfig($)
      const raw = Number(await $.env.get('DISPATCH_NUDGE_CHARS'))
      const text = observe(e.tool_name, e.tool_input, e.tool_response, raw > 0 ? raw : cfg.dispatch.nudgeThresholdChars, cfg, sub)
      if (text !== undefined) due = text
    }
    if (sub) return r
    if (due !== undefined) {
      extra.push(due)
      due = undefined
    }
    return extra.length === 0 ? r : { ...r, additionalContext: [...(r.additionalContext ?? []), ...extra] }
  })
}
