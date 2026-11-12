import type { EngineInterface } from 'claude-code'

// Everything personal lives in an optional JSON file, ~/.config/work-mode/config.json
// (or $WORK_MODE_CONFIG). Without it the mod runs on neutral English or Traditional
// Chinese defaults, picked from the Claude Code `language` setting and the locale env.

export type Locale = 'en' | 'zh-TW'
export type Pronouns = 'they' | 'he' | 'she'

export interface PoolRouting {
  bothBlocked: string
  agyBlocked: string
  codexBlocked: string
  bothOpen: string
  /** Which open pool to spend first; `{pool}`, `{used}` and `{reset}` are filled in. */
  prefer: string
  /** Added when the main model's own weekly window resets before every external pool's and has room. */
  claudeSoon: string
}

export interface WorkModeConfig {
  locale: Locale
  /** How the mode texts name the person driving the session. */
  userName: string
  pronouns: Pronouns
  autonomous: {
    /** Extra lines appended to the autonomous text, after the hard stops. */
    extraRules: string[]
  }
  dispatch: {
    /** Short hint shown in the picker and the switch reply, e.g. "subagents / external CLI". */
    pickerHint: string
    /** Replaces the whole delegation text when set (one line per entry). */
    instructions?: string[]
    /** A Bash command matching this regex counts as delegating (the nudge then stays quiet). */
    commandPattern: string
    /**
     * true (default): a Claude subagent (Agent/Workflow call) counts as delegating.
     * false: subagents spend the same quota as the main thread, so spawning one does not count,
     * and what they read adds to the nudge count; only commandPattern counts as delegating.
     */
    subagentsDelegate: boolean
    nudgeThresholdChars: number
    /** Replaces the nudge text; `{chars}` is filled with the count. */
    nudgeTemplate?: string
    /**
     * true (default): under out, once the turn's raw reading passes nudgeThresholdChars with nothing
     * delegated, further Read / Grep / reader Bash calls are refused with a how-to, until the model
     * delegates or declares why it reads inline (a no-op Bash `: # work-mode: inline <reason>`).
     */
    readGate: boolean
    /** Paths matching this regex are batch material: under out their first read is refused outright. */
    corpusPattern?: string
    /** Replaces the gate's refusal text; `{chars}` and `{hint}` are filled in. */
    gateTemplate?: string
    /** Optional quota table (JSON array of {pool: "agy"|"codex", ...}); read only when set. */
    quotaFile?: string
    poolRouting?: PoolRouting
  }
  /** Every N user prompts while a mode is on, a one-line reminder of the modes rides with the prompt; 0 = off. */
  reminderEveryTurns: number
  converge: {
    sectionHeading: string
    decisionLabels: string[]
    tradeoffLabel: string
    /** A command the model runs on its own once nothing is open, e.g. "/checkpoint"; null for none. */
    autoCloseCommand: string | null
  }
}

export const DEFAULT_PATTERN = '(^|[\\s;&|(/])(codex\\s+exec|gemini|claude\\s+-p)\\s'

export const DEFAULT_CONFIG_EN: WorkModeConfig = {
  locale: 'en',
  userName: 'the user',
  pronouns: 'they',
  autonomous: {
    extraRules: [],
  },
  dispatch: {
    pickerHint: 'subagents / external CLI',
    commandPattern: DEFAULT_PATTERN,
    subagentsDelegate: true,
    nudgeThresholdChars: 20000,
    readGate: true,
  },
  reminderEveryTurns: 8,
  converge: {
    sectionHeading: 'Decisions Needed',
    decisionLabels: ['outbound', 'payment', 'delete', 'permission', 'tradeoff'],
    tradeoffLabel: 'tradeoff',
    autoCloseCommand: null,
  },
}

export const DEFAULT_CONFIG_ZH: WorkModeConfig = {
  ...DEFAULT_CONFIG_EN,
  locale: 'zh-TW',
  dispatch: {
    ...DEFAULT_CONFIG_EN.dispatch,
    pickerHint: '背景子代理／外部 CLI',
  },
  converge: {
    sectionHeading: '待你決定',
    decisionLabels: ['對外', '金流', '刪除', '權限', '取捨'],
    tradeoffLabel: '取捨',
    autoCloseCommand: null,
  },
}

export const DEFAULT_POOL_ROUTING: PoolRouting = {
  bothBlocked: 'Both pools are past the floor: keep batches inline or in a background subagent.',
  agyBlocked: 'agy is past the floor: send that batch work to codex or a background subagent instead.',
  codexBlocked: 'codex is past the floor: send code review and fixes to agy or a background subagent instead.',
  bothOpen: 'Both are open: route as above.',
  prefer: 'Spend {pool} first: its weekly window resets in {reset} with {used} used, so what is left expires soonest.',
  claudeSoon: "The main model's own week resets in {reset} at {used}: reading inline costs little right now, but verifiable batches still go out.",
}

let current: WorkModeConfig = DEFAULT_CONFIG_EN
let loaded = false
let home = ''

export function getConfig(): WorkModeConfig {
  return current
}

export function getHome(): string {
  return home
}

/** `~` and `~/x` become absolute; $.fs does not expand them. */
export function resolvePath(p: string, homeDir: string): string {
  if (p === '~') return homeDir
  if (p.startsWith('~/')) return `${homeDir}/${p.slice(2)}`
  return p
}

export function localeFrom(value: unknown): Locale | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (/zh|中文|繁體|台灣|臺灣|chinese/i.test(value)) return 'zh-TW'
  if (/^en|english/i.test(value)) return 'en'
  return undefined
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() !== '' ? v : d)
const strList = (v: unknown, d: string[]): string[] =>
  Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : d
const optList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string') ? (v as string[]) : undefined

export function validPattern(p: unknown): string | undefined {
  if (typeof p !== 'string' || p === '') return undefined
  try {
    new RegExp(p)
    return p
  } catch {
    return undefined
  }
}

/** Merges a parsed config file over the locale's defaults; anything malformed falls back field by field. */
export function resolveConfig(raw: unknown, fallbackLocale: Locale = 'en'): WorkModeConfig {
  const r = isObj(raw) ? raw : {}
  const locale = r.locale === 'en' || r.locale === 'zh-TW' ? r.locale : fallbackLocale
  const base = locale === 'zh-TW' ? DEFAULT_CONFIG_ZH : DEFAULT_CONFIG_EN
  const a = isObj(r.autonomous) ? r.autonomous : {}
  const d = isObj(r.dispatch) ? r.dispatch : {}
  const c = isObj(r.converge) ? r.converge : {}
  const pr = isObj(d.poolRouting) ? d.poolRouting : undefined
  const threshold = typeof d.nudgeThresholdChars === 'number' && d.nudgeThresholdChars > 0 ? d.nudgeThresholdChars : base.dispatch.nudgeThresholdChars
  const dispatch: WorkModeConfig['dispatch'] = {
    pickerHint: str(d.pickerHint, base.dispatch.pickerHint),
    commandPattern: validPattern(d.commandPattern) ?? base.dispatch.commandPattern,
    subagentsDelegate: typeof d.subagentsDelegate === 'boolean' ? d.subagentsDelegate : base.dispatch.subagentsDelegate,
    nudgeThresholdChars: threshold,
    readGate: typeof d.readGate === 'boolean' ? d.readGate : base.dispatch.readGate,
  }
  const corpus = validPattern(d.corpusPattern)
  if (corpus) dispatch.corpusPattern = corpus
  if (typeof d.gateTemplate === 'string' && d.gateTemplate.trim() !== '') dispatch.gateTemplate = d.gateTemplate
  const instructions = optList(d.instructions)
  if (instructions) dispatch.instructions = instructions
  if (typeof d.nudgeTemplate === 'string' && d.nudgeTemplate.trim() !== '') dispatch.nudgeTemplate = d.nudgeTemplate
  if (typeof d.quotaFile === 'string' && d.quotaFile.trim() !== '') dispatch.quotaFile = d.quotaFile
  if (pr) {
    dispatch.poolRouting = {
      bothBlocked: str(pr.bothBlocked, DEFAULT_POOL_ROUTING.bothBlocked),
      agyBlocked: str(pr.agyBlocked, DEFAULT_POOL_ROUTING.agyBlocked),
      codexBlocked: str(pr.codexBlocked, DEFAULT_POOL_ROUTING.codexBlocked),
      bothOpen: str(pr.bothOpen, DEFAULT_POOL_ROUTING.bothOpen),
      prefer: str(pr.prefer, DEFAULT_POOL_ROUTING.prefer),
      claudeSoon: str(pr.claudeSoon, DEFAULT_POOL_ROUTING.claudeSoon),
    }
  }
  const every = r.reminderEveryTurns
  const reminderEveryTurns = typeof every === 'number' && every >= 0 && Number.isFinite(every) ? Math.floor(every) : base.reminderEveryTurns
  const labels = strList(c.decisionLabels, base.converge.decisionLabels).filter(l => l.trim() !== '')
  const decisionLabels = labels.length > 0 ? labels : base.converge.decisionLabels
  const tradeoff = str(c.tradeoffLabel, base.converge.tradeoffLabel)
  return {
    locale,
    userName: str(r.userName, base.userName),
    pronouns: r.pronouns === 'he' || r.pronouns === 'she' || r.pronouns === 'they' ? r.pronouns : base.pronouns,
    autonomous: { extraRules: strList(a.extraRules, base.autonomous.extraRules) },
    dispatch,
    reminderEveryTurns,
    converge: {
      sectionHeading: str(c.sectionHeading, base.converge.sectionHeading),
      decisionLabels,
      tradeoffLabel: decisionLabels.includes(tradeoff) ? tradeoff : (decisionLabels.at(-1) ?? tradeoff),
      autoCloseCommand: typeof c.autoCloseCommand === 'string' && c.autoCloseCommand.trim() !== '' ? c.autoCloseCommand : null,
    },
  }
}

async function detectLocale($: EngineInterface): Promise<Locale> {
  const explicit = localeFrom(await $.env.get('WORK_MODE_LOCALE'))
  if (explicit) return explicit
  try {
    const fromSettings = localeFrom(await $.settings.read({ key: 'language' }))
    if (fromSettings) return fromSettings
  } catch {
    // No settings access: fall through to the environment.
  }
  const env = (await $.env.get('LC_ALL')) ?? (await $.env.get('LANG')) ?? ''
  return /^zh/i.test(env) ? 'zh-TW' : 'en'
}

/** Reads the config file again; a missing or broken file resets to the defaults. */
export async function loadConfig($: EngineInterface): Promise<WorkModeConfig> {
  home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const cfgEnv = await $.env.get('WORK_MODE_CONFIG')
  const path = resolvePath(cfgEnv && cfgEnv.trim() !== '' ? cfgEnv : '~/.config/work-mode/config.json', home)
  let raw: unknown = undefined
  try {
    raw = JSON.parse(await $.fs.read(path))
  } catch {
    raw = undefined
  }
  const fileLocale = isObj(raw) && (raw.locale === 'en' || raw.locale === 'zh-TW') ? raw.locale : undefined
  current = resolveConfig(raw, fileLocale ?? (await detectLocale($)))
  loaded = true
  return current
}

export async function ensureConfig($: EngineInterface): Promise<WorkModeConfig> {
  return loaded ? current : loadConfig($)
}
