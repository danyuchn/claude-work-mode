import type { On } from 'claude-code'

// Config comes through tempo.ts only, so one module instance holds it even when the files are linked in.
import { DEFAULT_PATTERN, dispatchOn, ensureConfig, getConfig, takePending } from './tempo'
import type { WorkModeConfig } from './tempo'

// When the main thread has pulled a lot of raw material into context this turn
// (Read/Bash/Grep output) without delegating anything, say once that this batch could
// go to a subagent or an external CLI. Only with /work-mode out.
// With dispatch.subagentsDelegate false, Claude subagents spend the same quota: their reads
// count too, spawning one is not delegating, and a nudge they trip waits for the main thread.

let chars = 0
let dispatched = false
let nudged = false
let due: string | undefined

export function resetNudge(): void {
  chars = 0
  dispatched = false
  nudged = false
  due = undefined
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
  if ((viaClaude && (tool === 'Agent' || tool === 'Workflow')) || dispatchPattern(cfg).test(cmd)) dispatched = true
  if (tool === 'Read' || tool === 'Bash' || tool === 'Grep') chars += responseLength(response)
  if (!dispatched && !nudged && chars >= threshold) {
    nudged = true
    return nudgeText(chars, cfg)
  }
  return undefined
}

export function registerNudge(on: On): void {
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
