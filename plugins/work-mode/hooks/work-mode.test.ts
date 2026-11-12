import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_CONFIG_EN, DEFAULT_CONFIG_ZH, localeFrom, resolveConfig, resolvePath } from './config'
import { agentText, gate, gateText, nudgeText, observe, resetNudge, responseLength } from './nudge'
import {
  autonomousText,
  comboText,
  convergeText,
  dispatchText,
  parseTempo,
  pickedArgs,
  pickerLabels,
  poolLine,
  paceOf,
  reminderText,
  resetIn,
  switchReply,
  switchTexts,
  tempoLabel,
} from './tempo'

const written: Record<string, string> = {}
const statuses: Array<string | undefined> = []
const STATE = '/home/u/.claude/state/tempo/sid-1'
const CFG_PATH = '/home/u/.config/work-mode/config.json'

type World = { files?: Record<string, string>; env?: Record<string, string>; language?: string }

function world(on: On, w: World = {}) {
  statuses.length = 0
  for (const k of Object.keys(written)) delete written[k]
  const files = w.files ?? {}
  mock.store(on)
  mock.env(on, { HOME: '/home/u', ...(w.env ?? {}) })
  on('session.id', () => ({ value: 'sid-1' }) as never)
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('settings.read', () => (w.language === undefined ? { deny: 'no settings' } : ({ value: { language: w.language } } as never)))
  on('fs.read', (_$, e) => (e.path in files ? ({ value: files[e.path] } as never) : { deny: 'missing' }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'rm') delete written[String(e.argv[2])]
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('fs.write', (_$, e) => {
    written[e.path] = String(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('classic.PostToolUse', () => ({}))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
}

const denyOf = (v: unknown) => (v as { deny?: string } | undefined)?.deny
const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const run = (args: string) => ({
  command: 'work-mode',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

/** Runs /work-mode, then one tool call: what the switch told the model mid-turn. */
async function switched($: any, args: string): Promise<{ text?: string; context?: string[] }> {
  const r = await $.command.run(run(args))
  const t = await $.classic.PostToolUse({ tool_name: 'Edit', tool_input: {}, tool_response: '', tool_use_id: 't' } as never)
  return { text: r.text, context: t.additionalContext }
}

// Everything a zero-config user can see: no personal names, private tools or gendered pronouns.
// Words split so the repo's own leak scan (no private names or tool names anywhere) stays at zero hits.
const PERSONAL = new RegExp(['Dus' + 'tin', 'ext' + '-run', 'ai' + '-quota', '/check' + 'point', '\\b(he|him|his)\\b'].join('|'))
function expectNeutral(texts: Array<string | undefined>) {
  for (const t of texts) if (t !== undefined) expect(PERSONAL.test(t)).toBe(false)
}

const CUSTOM = {
  locale: 'en',
  userName: 'Alice',
  pronouns: 'she',
  autonomous: { extraRules: ['Always run the linter before committing.'] },
  dispatch: {
    pickerHint: 'custom-cli, fast',
    instructions: ['[tempo: dispatch] Use custom-cli for batches.', 'Keep judgement inline.'],
    commandPattern: '(^|\\s)custom-cli\\s',
    nudgeThresholdChars: 100,
    nudgeTemplate: '[dispatch-nudge] {chars} chars read; try custom-cli.',
    quotaFile: '~/quota.json',
    poolRouting: { bothBlocked: 'BOTH-BLOCKED', agyBlocked: 'AGY-BLOCKED', codexBlocked: 'CODEX-BLOCKED', bothOpen: 'BOTH-OPEN' },
  },
  converge: {
    sectionHeading: 'Open Questions',
    decisionLabels: ['external', 'money', 'choice'],
    tradeoffLabel: 'choice',
    autoCloseCommand: '/close-session',
  },
}

// ---- group A: zero config ---------------------------------------------------------------

test('A: no config file, English: neutral texts end to end', async ($, on) => {
  world(on, { env: { LANG: 'en_US.UTF-8' } })
  await start($)
  const before = await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 'sid-1' } as never)
  expect(before.additionalContext).toBe(undefined)
  const r = await switched($, 'auto out')
  expect(r.text).toContain('auto + out')
  expect(r.text).toContain('compatible PreToolUse gates deny')
  expect(r.text).toContain('subagents / external CLI')
  expect(r.context?.[0]).toBe('[tempo] The user switched work mode just now: auto + out is on from this point.')
  expect(r.context).toContain(autonomousText(DEFAULT_CONFIG_EN))
  expect(r.context).toContain(dispatchText(DEFAULT_CONFIG_EN))
  expect(JSON.parse(written[STATE] ?? '{}')).toEqual({ modes: ['autonomous', 'dispatch'] })
  expect(statuses.at(-1)).toBe('AUTO + OUT')
  const w = await switched($, 'wrap')
  expect(w.context).toContain(convergeText(DEFAULT_CONFIG_EN))
  const off = await switched($, 'off')
  expect(off.context?.[0]).toContain('The user turned work mode off')
  expect(STATE in written).toBe(false)
  expect(statuses.at(-1)).toBe(undefined)
  expectNeutral([r.text, w.text, off.text, ...(r.context ?? []), ...(w.context ?? []), ...(off.context ?? [])])
})

test('A: default texts in both locales carry nothing personal', () => {
  for (const cfg of [DEFAULT_CONFIG_EN, DEFAULT_CONFIG_ZH]) {
    expectNeutral([
      autonomousText(cfg),
      dispatchText(cfg),
      convergeText(cfg),
      nudgeText(25000, cfg),
      switchReply(['autonomous', 'dispatch'], undefined, cfg),
      switchReply(['converge'], undefined, cfg),
      ...switchTexts(['dispatch'], ['autonomous', 'converge'], false, undefined, cfg),
      ...switchTexts(['dispatch'], [], true, undefined, cfg),
      ...switchTexts([], ['dispatch', 'converge'], false, undefined, cfg),
      switchReply(['dispatch', 'converge'], undefined, cfg),
      ...pickerLabels(['autonomous'], cfg),
    ])
  }
  expect(autonomousText(DEFAULT_CONFIG_EN)).toContain('so they are interrupted once')
  expect(autonomousText(DEFAULT_CONFIG_EN)).toContain('do not wait for them')
  expect(autonomousText(DEFAULT_CONFIG_EN)).toContain('in plain language.')
  expect(convergeText(DEFAULT_CONFIG_EN)).toContain('[outbound] [payment] [delete] [permission] [tradeoff]')
  expect(convergeText(DEFAULT_CONFIG_EN)).toContain('"Decisions Needed" section')
  expect(convergeText(DEFAULT_CONFIG_EN)).toContain('Option A pros')
  expect(convergeText(DEFAULT_CONFIG_EN)).toContain('turns on their preference')
  expect(convergeText(DEFAULT_CONFIG_EN)).toContain('say in one line that the work is complete')
  expect(convergeText(DEFAULT_CONFIG_ZH)).toContain('[對外] [金流] [刪除] [權限] [取捨]')
  expect(convergeText(DEFAULT_CONFIG_ZH)).toContain('"待你決定" section')
  expect(convergeText(DEFAULT_CONFIG_ZH)).toContain('A 的好處')
  expect(convergeText(DEFAULT_CONFIG_ZH)).toContain('台灣用語')
  expect(nudgeText(25000, DEFAULT_CONFIG_ZH)).toContain('約 25000 字元')
  expect(nudgeText(25000, DEFAULT_CONFIG_EN)).toContain('about 25000 characters')
})

test('A: Claude Code language setting picks Traditional Chinese even with an English LANG', async ($, on) => {
  world(on, { env: { LANG: 'en_US.UTF-8' }, language: '台灣繁體中文' })
  await start($)
  const r = await switched($, 'wrap')
  expect(r.context).toContain(convergeText(DEFAULT_CONFIG_ZH))
  expectNeutral([r.text, ...(r.context ?? [])])
})

test('A: locale detection order: WORK_MODE_LOCALE, then settings, then LC_ALL/LANG', async ($, on) => {
  world(on, { env: { WORK_MODE_LOCALE: 'en', LANG: 'zh_TW.UTF-8' }, language: '中文' })
  await start($)
  expect((await switched($, 'wrap')).context).toContain(convergeText(DEFAULT_CONFIG_EN))
  expect(localeFrom('English')).toBe('en')
  expect(localeFrom('日本語')).toBe(undefined)
})

test('A: with no language setting, a zh LANG picks Traditional Chinese', async ($, on) => {
  world(on, { env: { LANG: 'zh_TW.UTF-8' } })
  await start($)
  expect((await switched($, 'wrap')).context).toContain(convergeText(DEFAULT_CONFIG_ZH))
})

test('A: no quota file configured: out sends no pool line', async ($, on) => {
  world(on, { files: { '/home/u/.claude/usage-cache/ai-quota.json': '[{"pool":"agy","gemini_5h_used":5}]' } })
  await start($)
  const r = await switched($, 'out')
  expect((r.context ?? []).some(t => t.startsWith('[tempo: pools]'))).toBe(false)
})

test('A: nudge fires once at the default threshold only with out on; delegation keeps it quiet', async ($, on) => {
  world(on)
  await start($)
  await $.classic.UserPromptSubmit({ prompt: 'go', session_id: 'sid-1' } as never)
  const post = (extra: object, n: number, input: object = {}, tool = 'Read') =>
    $.classic.PostToolUse({ tool_name: tool, tool_input: input, tool_response: 'x'.repeat(n), tool_use_id: 't', ...extra } as never)
  expect((await post({}, 50000)).additionalContext).toBe(undefined) // off: never nudges
  await $.command.run(run('out'))
  await $.classic.UserPromptSubmit({ prompt: 'go', session_id: 'sid-1' } as never)
  expect((await post({ agent_id: 'sub1' }, 50000)).additionalContext).toBe(undefined)
  const hit = await post({}, 25000)
  expect(hit.additionalContext?.[0]).toContain('[dispatch-nudge]')
  expectNeutral(hit.additionalContext ?? [])
  expect((await post({}, 25000)).additionalContext).toBe(undefined)
  await $.classic.UserPromptSubmit({ prompt: 'next', session_id: 'sid-1' } as never)
  expect((await post({}, 1, { command: 'codex exec --sandbox read-only review' }, 'Bash')).additionalContext).toBe(undefined)
  expect((await post({}, 90000)).additionalContext).toBe(undefined)
})

test('A: nudge counting and the default delegation pattern', () => {
  resetNudge()
  expect(observe('Read', {}, 'x'.repeat(15000), 20000, DEFAULT_CONFIG_EN)).toBe(undefined)
  expect(observe('Edit', {}, 'x'.repeat(50000), 20000, DEFAULT_CONFIG_EN)).toBe(undefined)
  const text = observe('Bash', { command: 'ls' }, { stdout: 'y'.repeat(6000) }, 20000, DEFAULT_CONFIG_EN)
  expect(text).toBe(nudgeText(responseLength({ stdout: 'y'.repeat(6000) }) + 15000, DEFAULT_CONFIG_EN))
  for (const cmd of ['gemini -p "x" ', 'claude -p --model sonnet "x"', 'cd a && codex exec foo']) {
    resetNudge()
    expect(observe('Bash', { command: cmd }, 'a', 20000, DEFAULT_CONFIG_EN)).toBe(undefined)
    expect(observe('Read', {}, 'x'.repeat(90000), 20000, DEFAULT_CONFIG_EN)).toBe(undefined)
  }
  resetNudge()
  expect(observe('Agent', {}, 'a', 20000, DEFAULT_CONFIG_EN)).toBe(undefined)
  expect(observe('Read', {}, 'x'.repeat(90000), 20000, DEFAULT_CONFIG_EN)).toBe(undefined)
  resetNudge()
  expect(observe('Bash', { command: 'echo geminid' }, 'a', 20000, DEFAULT_CONFIG_EN)).toBe(undefined)
  expect(observe('Read', {}, 'x'.repeat(25000), 20000, DEFAULT_CONFIG_EN)).toBeDefined()
})

// ---- group B: custom config ------------------------------------------------------------

test('B: every override reaches the texts, the reply and the pool line', async ($, on) => {
  const quota = JSON.stringify([
    { pool: 'agy', gemini_5h_used: 7, gemini_7d_used: 3, route: 'floor_7d', route_used: 94, route_reset_ts: 9e12, route_reset_in: '1h' },
    { pool: 'codex', '5h_used': 10, '7d_used': 20, route: 'open' },
  ])
  world(on, { files: { [CFG_PATH]: JSON.stringify(CUSTOM), '/home/u/quota.json': quota } })
  await start($)
  const r = await switched($, 'auto out')
  expect(r.context?.[0]).toBe('[tempo] Alice switched work mode just now: auto + out is on from this point.')
  expect(r.text).toContain('The delegation reminder (custom-cli, fast)')
  const ctx = r.context ?? []
  expect(ctx).toContain('[tempo: dispatch] Use custom-cli for batches.\nKeep judgement inline.')
  const auto = ctx.find(t => t.startsWith('[tempo: autonomous]')) ?? ''
  expect(auto).toContain('Alice has granted full autonomy')
  expect(auto).toContain('Always run the linter before committing.')
  expect(auto).toContain('so she is interrupted once')
  expect(auto).toContain('do not wait for her')
  const pools = ctx[ctx.indexOf('[tempo: dispatch] Use custom-cli for batches.\nKeep judgement inline.') + 1]
  expect(pools).toContain('[tempo: pools] agy 5h 7% 7d 3% (refused: 7d window 94%, resets in 1h)')
  expect(pools).toContain('AGY-BLOCKED')
  const wrap = await switched($, 'wrap')
  const conv = (wrap.context ?? []).find(t => t.startsWith('[tempo: converge]')) ?? ''
  expect(conv).toContain('"Open Questions" section')
  expect(conv).toContain('[external] [money] [choice]')
  expect(conv).toContain('[choice] is not a catch-all')
  expect(conv).toContain('turns on her preference')
  expect(conv).toContain('run /close-session yourself without asking')
})

test('B: custom nudge pattern, threshold and template', async ($, on) => {
  world(on, { files: { [CFG_PATH]: JSON.stringify(CUSTOM) } })
  await start($)
  await $.command.run(run('out'))
  await $.classic.UserPromptSubmit({ prompt: 'go', session_id: 'sid-1' } as never)
  const post = (n: number, input: object = {}, tool = 'Read') =>
    $.classic.PostToolUse({ tool_name: tool, tool_input: input, tool_response: 'x'.repeat(n), tool_use_id: 't' } as never)
  const hit = await post(150)
  expect(hit.additionalContext?.at(-1)).toBe('[dispatch-nudge] 150 chars read; try custom-cli.')
  await $.classic.UserPromptSubmit({ prompt: 'next', session_id: 'sid-1' } as never)
  expect((await post(1, { command: 'custom-cli run x' }, 'Bash')).additionalContext).toBe(undefined)
  expect((await post(500)).additionalContext).toBe(undefined)
})

test('B: subagentsDelegate false: a subagent is not delegation, its reads count, the nudge reaches the main thread', async ($, on) => {
  world(on, { files: { [CFG_PATH]: JSON.stringify({ dispatch: { subagentsDelegate: false } }) } })
  await start($)
  await $.command.run(run('out'))
  await $.classic.UserPromptSubmit({ prompt: 'go', session_id: 'sid-1' } as never)
  const post = (extra: object, n: number, input: object = {}, tool = 'Read') =>
    $.classic.PostToolUse({ tool_name: tool, tool_input: input, tool_response: 'x'.repeat(n), tool_use_id: 't', ...extra } as never)
  expect((await post({}, 1, {}, 'Agent')).additionalContext).toBe(undefined)
  // The subagent trips the count but never sees the nudge; the main thread gets it once.
  expect((await post({ agent_id: 'sub1' }, 25000)).additionalContext).toBe(undefined)
  expect((await post({}, 1, {}, 'Agent')).additionalContext?.at(-1)).toContain('[dispatch-nudge]')
  expect((await post({}, 90000)).additionalContext).toBe(undefined)
  // An external command, even run by a subagent, still counts as delegating.
  await $.classic.UserPromptSubmit({ prompt: 'next', session_id: 'sid-1' } as never)
  expect((await post({ agent_id: 'sub1' }, 1, { command: 'codex exec review' }, 'Bash')).additionalContext).toBe(undefined)
  expect((await post({}, 90000)).additionalContext).toBe(undefined)
  expect(resolveConfig({}).dispatch.subagentsDelegate).toBe(true)
  expect(resolveConfig({ dispatch: { subagentsDelegate: 'no' } }).dispatch.subagentsDelegate).toBe(true)
})

test('B: WORK_MODE_CONFIG with ~ points at another file; removing it resets to defaults', async ($, on) => {
  const files: Record<string, string> = { '/home/u/elsewhere.json': JSON.stringify({ userName: 'Bob', pronouns: 'he' }) }
  world(on, { files, env: { WORK_MODE_CONFIG: '~/elsewhere.json' } })
  await start($)
  expect((await switched($, 'auto')).context?.[0]).toContain('Bob switched')
  delete files['/home/u/elsewhere.json']
  await start($)
  expect((await switched($, 'wrap')).context?.[0]).toContain('The user switched')
})

test('B: malformed fields fall back one by one; a broken regex keeps the default', () => {
  const cfg = resolveConfig({ userName: 7, pronouns: 'xe', dispatch: { commandPattern: '(', nudgeThresholdChars: -1 }, converge: { decisionLabels: [] } })
  expect(cfg.userName).toBe('the user')
  expect(cfg.pronouns).toBe('they')
  expect(cfg.dispatch.commandPattern).toBe(DEFAULT_CONFIG_EN.dispatch.commandPattern)
  expect(cfg.dispatch.nudgeThresholdChars).toBe(20000)
  expect(cfg.converge.decisionLabels).toEqual(DEFAULT_CONFIG_EN.converge.decisionLabels)
  expect(resolveConfig('not an object', 'zh-TW').converge.sectionHeading).toBe('待你決定')
  expect(resolvePath('~/a/b', '/h')).toBe('/h/a/b')
  expect(resolvePath('/abs', '/h')).toBe('/abs')
})

// ---- parsing and picker ------------------------------------------------------------------

test('tempo arguments and labels', () => {
  expect(parseTempo('')).toEqual({ kind: 'status' })
  expect(parseTempo(' Dispatch ')).toEqual({ kind: 'set', modes: ['dispatch'] })
  expect(parseTempo('autonomous+dispatch')).toEqual({ kind: 'set', modes: ['autonomous', 'dispatch'] })
  expect(parseTempo('wrap auto')).toEqual({ kind: 'set', modes: ['autonomous', 'converge'] })
  expect(parseTempo('wrap out')).toEqual({ kind: 'set', modes: ['dispatch', 'converge'] })
  expect(parseTempo('auto out wrap')).toEqual({ kind: 'set', modes: ['autonomous', 'dispatch', 'converge'] })
  expect(parseTempo('off')).toEqual({ kind: 'set', modes: [] })
  expect(parseTempo('fast').kind).toBe('error')
  expect(tempoLabel([])).toBe(undefined)
  expect(tempoLabel(['autonomous', 'dispatch'])).toBe('AUTO + OUT')
})

test('picker: labels in both locales, commas in the hint never split an answer', () => {
  const cfg = resolveConfig(CUSTOM)
  const en = pickerLabels(['autonomous'], cfg)
  expect(en.length).toBe(4)
  expect(en[1]).toBe('out - delegate (custom-cli/ fast)')
  expect(pickerLabels([], cfg).length).toBe(3)
  expect(parseTempo(pickedArgs(en.join(', '), cfg))).toEqual({ kind: 'set', modes: ['autonomous', 'dispatch', 'converge'] })
  expect(parseTempo(pickedArgs(`${en[1]}, ${en[0]}`, cfg))).toEqual({ kind: 'set', modes: ['autonomous', 'dispatch'] })
  const zcfg = resolveConfig({ ...CUSTOM, locale: 'zh-TW' })
  const zh = pickerLabels(['dispatch'], zcfg)
  expect(zh[1]).toBe('out 外派（custom-cli／ fast）')
  expect(parseTempo(pickedArgs(`${zh[3]}`, zcfg))).toEqual({ kind: 'set', modes: [] })
  expect(parseTempo(pickedArgs(`${zh[0]}, ${zh[2]}`, zcfg))).toEqual({ kind: 'set', modes: ['autonomous', 'converge'] })
  expect(pickedArgs('auto out')).toBe('auto out')
  expect(parseTempo(pickedArgs('out + auto'))).toEqual({ kind: 'set', modes: ['autonomous', 'dispatch'] })
  expect(parseTempo(pickedArgs('auto nonsense')).kind).toBe('error')
  expect(parseTempo(pickedArgs('something else')).kind).toBe('error')
})

test('mode texts go out once, then again after a compaction or /clear turns them off', async ($, on) => {
  world(on)
  on('session.compact', (_$, e) => ({ messages: e.messages }) as never)
  on('classic.SessionStart', () => ({}))
  await start($)
  expect((await switched($, 'auto')).context).toContain(autonomousText(DEFAULT_CONFIG_EN))
  const prompt = async () => (await $.classic.UserPromptSubmit({ prompt: 'p', session_id: 'sid-1' } as never)).additionalContext
  expect(await prompt()).toBe(undefined)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(await prompt()).toEqual([autonomousText(DEFAULT_CONFIG_EN)])
  expect(await prompt()).toBe(undefined)
  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(statuses.at(-1)).toBe(undefined)
  expect(STATE in written).toBe(false)
  expect((await $.command.run(run(''))).text).toContain('Work mode: off')
})

test('pool line: routing sentences come from config, defaults name no private tool', () => {
  const now = 1_000_000
  const q = (agy: object, codex: object) =>
    JSON.stringify([{ pool: 'agy', gemini_5h_used: 7, gemini_7d_used: 3, ...agy }, { pool: 'codex', '5h_used': 97, '7d_used': 15, ...codex }])
  const floor = (route: string) => ({ route, route_used: 97, route_reset_ts: now + 99, route_reset_in: '0h45m' })
  expect(poolLine(q({ route: 'open' }, { route: 'open' }), now, DEFAULT_CONFIG_EN)).toContain('Both are open')
  expect(poolLine(q(floor('floor_5h'), floor('floor_7d')), now, DEFAULT_CONFIG_EN)).toContain('background subagent')
  expect(poolLine(q({ route: 'open' }, floor('floor_5h')), now, resolveConfig(CUSTOM))).toContain('CODEX-BLOCKED')
  expect(poolLine(q({ ...floor('floor_7d'), route_reset_ts: now - 1 }, { route: 'open' }), now, resolveConfig(CUSTOM))).toContain('BOTH-OPEN')
  expect(poolLine('not json')).toBe(undefined)
  expect(poolLine(JSON.stringify([{ pool: 'agy' }]))).toBe(undefined)
})

test('out + wrap: combo text is sent once, only when both are on', () => {
  const cfg = DEFAULT_CONFIG_EN
  const tag = '[tempo: dispatch + converge]'
  expect(switchTexts([], ['dispatch', 'converge'], false, undefined, cfg).some(x => x.startsWith(tag))).toBe(true)
  expect(switchTexts(['converge'], ['dispatch', 'converge'], true, undefined, cfg).some(x => x.startsWith(tag))).toBe(true)
  expect(switchTexts(['dispatch', 'converge'], ['autonomous', 'dispatch', 'converge'], true, undefined, cfg).some(x => x.startsWith(tag))).toBe(false)
  expect(switchTexts([], ['converge'], false, undefined, cfg).some(x => x.startsWith(tag))).toBe(false)
  expect(comboText({ ...cfg, converge: { ...cfg.converge, autoCloseCommand: '/checkpoint' } })).toContain('/checkpoint waits for it')
  expect(switchReply(['dispatch', 'converge'], undefined, cfg)).toContain('only finishes work already open')
})

// ---- group C: the read gate, the reminder, reset-aware pools ------------------------------

test('C: gate verdicts: threshold, corpus, inline declaration, delegation, readers only', () => {
  const cfg = { ...DEFAULT_CONFIG_EN, dispatch: { ...DEFAULT_CONFIG_EN.dispatch, corpusPattern: '\\.jsonl$|/transcripts/' } }
  resetNudge()
  expect(gate('Read', { file_path: '/a/code.ts' }, 100, cfg)).toBe(undefined)
  expect(gate('Read', { file_path: '/a/session.jsonl' }, 100, cfg)).toEqual({ deny: gateText(0, '/a/session.jsonl', cfg) })
  expect(denyOf(gate('Bash', { command: 'cat /a/transcripts/x.md | head' }, 100, cfg))).toContain('[dispatch-gate]')
  expect(gate('Bash', { command: 'ls /a/transcripts/' }, 100, cfg)).toBe(undefined) // ls is not a reader
  observe('Read', {}, 'x'.repeat(150), 100, cfg)
  expect(gate('Read', { file_path: '/a/code.ts' }, 100, cfg)).toEqual({ deny: gateText(150, undefined, cfg) })
  expect(denyOf(gate('Grep', { pattern: 'x', path: '/a' }, 100, cfg))).toContain('150 characters')
  expect(denyOf(gate('Bash', { command: 'sed -n 1,50p /a/code.ts' }, 100, cfg))).toBeDefined()
  expect(gate('Edit', { file_path: '/a/code.ts' }, 100, cfg)).toBe(undefined)
  expect(gate('Bash', { command: 'git status' }, 100, cfg)).toBe(undefined)
  expect(gate('Bash', { command: 'codex exec review' }, 100, cfg)).toBe(undefined) // delegating passes
  expect(gate('Bash', { command: ': # work-mode: inline editing this file next' }, 100, cfg)).toEqual({ declared: 'editing this file next' })
  expect(gate('Read', { file_path: '/a/session.jsonl' }, 100, cfg)).toBe(undefined) // declared: everything passes this turn
  resetNudge()
  observe('Read', {}, 'x'.repeat(150), 100, cfg)
  expect(denyOf(gate('Read', { file_path: '/a/code.ts' }, 100, cfg))).toBeDefined()
  observe('Bash', { command: 'gemini -p "x" ' }, 'a', 100, cfg)
  expect(gate('Read', { file_path: '/a/code.ts' }, 100, cfg)).toBe(undefined) // delegated earlier this turn
  resetNudge()
  observe('Read', {}, 'x'.repeat(150), 100, cfg)
  expect(gate('Read', { file_path: '/a/code.ts' }, 100, { ...cfg, dispatch: { ...cfg.dispatch, readGate: false } })).toBe(undefined)
  expect(gateText(5, undefined, DEFAULT_CONFIG_ZH)).toContain('work-mode: inline')
  const tpl = { ...cfg, dispatch: { ...cfg.dispatch, gateTemplate: 'STOP {chars} via {hint}' } }
  expect(gateText(7, undefined, tpl)).toBe('STOP 7 via subagents / external CLI')
  expectNeutral([gateText(5, undefined, DEFAULT_CONFIG_EN), gateText(5, '/x.jsonl', DEFAULT_CONFIG_EN)])
})

test('C: shell reader segments, quoted declarations and dispatch bypasses', () => {
  const cfg = { ...DEFAULT_CONFIG_EN, dispatch: { ...DEFAULT_CONFIG_EN.dispatch, corpusPattern: '\\.jsonl$' } }
  resetNudge()
  expect(denyOf(gate('Bash', { command: "echo 'gemini -p test'; cat transcript.jsonl" }, 100, cfg))).toBeDefined()
  expect(denyOf(gate('Bash', { command: 'gemini -p test; cat transcript.jsonl' }, 100, cfg))).toBeDefined()
  observe('Read', {}, 'x'.repeat(150), 100, cfg)
  for (const command of ['echo "run cat later"', 'git commit -m "fix grep handling"', "echo '# work-mode: inline example'"]) {
    expect(gate('Bash', { command }, 100, cfg)).toBe(undefined)
  }
  expect(denyOf(gate('Read', { file_path: '/a' }, 100, cfg))).toBeDefined()
  expect(gate('Bash', { command: 'echo <<EOF\ncat x\nEOF' }, 100, cfg)).toBe(undefined)
  expect(gate('Bash', { command: "echo <<'EOF'\ncat x\nEOF" }, 100, cfg)).toBe(undefined)
  for (const command of ['cat x', 'cd a && sed -n 1,9p f', 'jq . f | head', 'python -c x', 'python3 -c x', 'cut f', 'sort f', 'uniq f', 'wc f', 'tr a b', 'xargs cat', 'node -e x', 'perl -e x', 'ruby -e x'])
    expect(denyOf(gate('Bash', { command }, 100, cfg))).toBeDefined()
  expect(denyOf(gate('Bash', { command: ': # work-mode: inline' }, 100, cfg))).toContain('reason')
  expect(denyOf(gate('Bash', { command: ': # work-mode: inline ab' }, 100, cfg))).toBeDefined()
  expect(gate('Bash', { command: ': # work-mode: inline valid reason' }, 100, cfg)).toEqual({ declared: 'valid reason' })
})

test('C: the gate denies with out on, lifts on a declaration, stays off otherwise', async ($, on) => {
  world(on)
  await start($)
  await $.classic.UserPromptSubmit({ prompt: 'go', session_id: 'sid-1' } as never)
  const read = (extra: object = {}) => $.tool.call({ tool: 'Read', file_path: '/a/b.md', ...extra } as never)
  const post = (n: number, extra: object = {}) =>
    $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: 'x'.repeat(n), tool_use_id: 't', ...extra } as never)
  await post(50000)
  expect((await read()).text).toBe('ok') // off: no gate
  await $.command.run(run('out'))
  await $.classic.UserPromptSubmit({ prompt: 'go', session_id: 'sid-1' } as never)
  expect((await read()).text).toBe('ok')
  await post(25000)
  const denied = await read()
  expect(JSON.stringify(denied)).toContain('[dispatch-gate]')
  await $.tool.call({ tool: 'Bash', command: ': # work-mode: inline nearly done' } as never)
  expect((await read()).text).toBe('ok')
  expect(written['/home/u/.claude/state/tempo-inline/sid-1.jsonl']).toContain('"reason":"nearly done"')
  await $.classic.UserPromptSubmit({ prompt: 'next', session_id: 'sid-1' } as never)
  await post(25000)
  expect(JSON.stringify(await read())).toContain('[dispatch-gate]')
  await $.command.run(run('off'))
  expect((await read()).text).toBe('ok')
})

test('C: a one-line reminder every N prompts, counted from the last full text', async ($, on) => {
  world(on, { files: { [CFG_PATH]: JSON.stringify({ reminderEveryTurns: 3 }) } })
  await start($)
  await $.command.run(run('auto wrap'))
  const prompt = async () => (await $.classic.UserPromptSubmit({ prompt: 'go', session_id: 'sid-1' } as never)).additionalContext ?? []
  const first = await prompt() // the switch texts rode with the first tool result; this prompt counts 1
  expect(first.some(t => t.startsWith('[tempo] still on'))).toBe(false)
  expect((await prompt()).length).toBe(0)
  const third = await prompt()
  expect(third.length).toBe(1)
  expect(third[0]).toBe(reminderText(['autonomous', 'converge']))
  expect(third[0]).toContain('auto + wrap')
  expect(third[0]).toContain('Decisions Needed')
  expect((await prompt()).length).toBe(0)
  expectNeutral(third)
  expect(resolveConfig({ reminderEveryTurns: 0 }).reminderEveryTurns).toBe(0)
  expect(resolveConfig({ reminderEveryTurns: 'x' }).reminderEveryTurns).toBe(8)
})

test('C: stale and non-finite quota snapshots are excluded from routing', () => {
  const raw = '[{"pool":"agy","gemini_7d_used":10,"gemini_7d_reset_ts":9000},{"pool":"codex","7d_used":20,"7d_reset_ts":20000},{"pool":"claude-sub","7d_used":10,"7d_reset_ts":9000}]'
  const line = poolLine(raw, 10000, DEFAULT_CONFIG_EN) ?? ''
  expect(line).toContain('Spend codex first')
  expect(line).not.toContain('main model')
  const infinite = poolLine('[{"pool":"agy","gemini_5h_used":1e999,"gemini_7d_used":1e999,"gemini_7d_reset_ts":1e999},{"pool":"codex","7d_used":20,"7d_reset_ts":20000}]', 10000, DEFAULT_CONFIG_EN) ?? ''
  expect(infinite).toContain('agy 5h ? 7d ?')
  expect(infinite).not.toContain('Infinity')
})

test('C: pool line prefers the open pool furthest behind its weekly pace; the main model ranks too', () => {
  const now = 1_000_000
  const h = 3600
  const rows = (extra: object[] = []) =>
    JSON.stringify([
      { pool: 'agy', gemini_5h_used: 8, gemini_7d_used: 45, gemini_7d_reset_ts: now + 46 * h, route: 'open' },
      { pool: 'codex', '5h_used': 16, '7d_used': 9, '7d_reset_ts': now + 146 * h, route: 'open' },
      ...extra,
    ])
  const line = poolLine(rows(), now, DEFAULT_CONFIG_EN) ?? ''
  expect(line).toContain('[tempo: pools] agy 5h 8% 7d 45% (resets in 46h); codex 5h 16% 7d 9% (resets in 6d).')
  // agy: 45% used with 73% of its week gone (pace -28); codex: 9% with 13% gone (-4)
  expect(line).toContain('Spend agy first: 45% of its week used, -28 points against its pace (resets in 46h)')
  expect(line).not.toContain('main model')
  // the main model furthest behind (30% used, 88% gone: -58) ranks first, worded as a subagent
  const withMain = poolLine(rows([{ pool: 'claude-sub', '7d_used': 30, '7d_reset_ts': now + 20 * h }]), now, DEFAULT_CONFIG_EN) ?? ''
  expect(withMain).not.toContain('Spend agy first')
  expect(withMain).toContain("The main model's own week is furthest behind its pace (30% used, -58 points, resets in 20h)")
  // closer to its pace than agy (70% used, 88% gone: -18): agy stays first
  expect(poolLine(rows([{ pool: 'claude-sub', '7d_used': 70, '7d_reset_ts': now + 20 * h }]), now, DEFAULT_CONFIG_EN)).toContain('Spend agy first')
  expect(paceOf({ used: 50, reset: now + 7 * 24 * h * 2 }, now)).toBe(50)
  // a 5h window at the floor keeps the main model out of first place
  expect(poolLine(rows([{ pool: 'claude-sub', '5h_used': 95, '7d_used': 30, '7d_reset_ts': now + 20 * h }]), now, DEFAULT_CONFIG_EN)).toContain('Spend agy first')
  // a pool ai-quota would not rank (rankable false, error, reading over an hour old) is never first
  for (const bad of [{ rankable: false }, { error: 'probe failed' }, { read_ts: now - 2 * h }])
    expect(poolLine(rows([{ pool: 'claude-sub', '7d_used': 30, '7d_reset_ts': now + 20 * h, ...bad }]), now, DEFAULT_CONFIG_EN)).toContain('Spend agy first')
  expect(poolLine(rows([{ pool: 'claude-sub', '7d_used': 30, '7d_reset_ts': now + 20 * h, read_ts: now - 60 }]), now, DEFAULT_CONFIG_EN)).toContain("main model's own week")
  // a pool at the 90% floor is not preferred even when it is behind pace
  const spent = JSON.stringify([
    { pool: 'agy', gemini_5h_used: 8, gemini_7d_used: 90, gemini_7d_reset_ts: now + 10 * h, route: 'open' },
    { pool: 'codex', '5h_used': 16, '7d_used': 9, '7d_reset_ts': now + 146 * h, route: 'open' },
    { pool: 'grok', period_used: 19, period_reset_ts: now + 125 * h },
  ])
  expect(poolLine(spent, now, DEFAULT_CONFIG_EN)).toContain('Spend grok first')
  // a refused pool is never preferred; custom wording reaches the line
  const refused = JSON.stringify([
    { pool: 'agy', gemini_5h_used: 8, gemini_7d_used: 45, gemini_7d_reset_ts: now + 46 * h, route: 'floor_5h', route_used: 95, route_reset_ts: now + h, route_reset_in: '1h' },
    { pool: 'codex', '5h_used': 16, '7d_used': 9, '7d_reset_ts': now + 146 * h, route: 'open' },
    { pool: 'claude-sub', '7d_used': 10, '7d_reset_ts': now + 5 * h },
  ])
  const custom = { ...DEFAULT_CONFIG_EN, dispatch: { ...DEFAULT_CONFIG_EN.dispatch, poolRouting: { bothBlocked: 'BB', agyBlocked: 'AB', codexBlocked: 'CB', bothOpen: 'BO', prefer: 'PREFER {pool} {used} {reset}', claudeSoon: 'MAIN {reset} {used}' } } }
  const r = poolLine(refused, now, custom) ?? ''
  expect(r).toContain('(resets in 46h) (refused: 5h window 95%, resets in 1h); codex')
  expect(r).toContain('(resets in 6d). AB MAIN')
  expect(r).not.toContain('PREFER') // only one open pool: nothing to prefer between
  expect(r).toContain('MAIN 5h 10%')
  expect(resetIn(undefined, now)).toBe('?')
  expect(resetIn(now - 1, now)).toBe('now')
  expectNeutral([line, withMain])
})

test('C: a Claude subagent sent because Claude ranks first (why-claude: pace) counts as a dispatch', () => {
  const cfg = { ...DEFAULT_CONFIG_EN, dispatch: { ...DEFAULT_CONFIG_EN.dispatch, subagentsDelegate: false } }
  resetNudge()
  observe('Agent', { prompt: 'why-claude: pace\nRead the folder.' }, 'ok', 100, cfg)
  expect(observe('Read', {}, 'x'.repeat(500), 100, cfg)).toBe(undefined) // dispatched: no nudge
  resetNudge()
  observe('Agent', { prompt: 'why-claude: needs the Gmail MCP' }, 'ok', 100, cfg)
  expect(observe('Read', {}, 'x'.repeat(500), 100, cfg)).toBeDefined() // any other reason is not a dispatch
})

test('C: with subagentsDelegate false an Agent call is refused until its prompt says why Claude; WebFetch counts and is gated', () => {
  const cfg = { ...DEFAULT_CONFIG_EN, dispatch: { ...DEFAULT_CONFIG_EN.dispatch, subagentsDelegate: false } }
  resetNudge()
  expect(gate('Agent', { prompt: 'read all transcripts and list corrections' }, 100, cfg)).toEqual({ deny: agentText(cfg) })
  expect(gate('Agent', { prompt: 'why-claude: it edits five files in this repo\nDo the refactor.' }, 100, cfg)).toEqual({ declared: 'why-claude: it edits five files in this repo' })
  expect(gate('Agent', { prompt: '<task>\nwhy-claude: needs the Gmail MCP\n...' }, 100, cfg)?.toString()).toBeDefined()
  expect(gate('Agent', { prompt: 'x' }, 100, DEFAULT_CONFIG_EN)).toBe(undefined) // subagents delegate by default: no gate
  expect(agentText(DEFAULT_CONFIG_ZH)).toContain('why-claude')
  expectNeutral([agentText(DEFAULT_CONFIG_EN)])
  resetNudge()
  observe('WebFetch', { url: 'https://x' }, 'y'.repeat(150), 100, cfg)
  expect(denyOf(gate('WebFetch', { url: 'https://x/2' }, 100, cfg))).toContain('[dispatch-gate]')
  expect(gate('Read', { file_path: '/a' }, 100, cfg)).toBeDefined()
})

test('C: a dispatch command may carry a path or env prefix; a mention inside arguments is not a dispatch', () => {
  const cfg = { ...DEFAULT_CONFIG_EN, dispatch: { ...DEFAULT_CONFIG_EN.dispatch, commandPattern: '(^|[\\s;&|(/])(custom-cli|codex\\s+exec)\\s' } }
  for (const cmd of ['~/bin/custom-cli run x', 'QUIET=1 ~/bin/custom-cli run x', 'cd a && timeout 300 custom-cli run x', '/opt/codex exec review']) {
    resetNudge()
    observe('Bash', { command: cmd }, 'a', 100, cfg)
    expect(gate('Read', { file_path: '/a' }, 100, cfg)).toBe(undefined)
    observe('Read', {}, 'x'.repeat(150), 100, cfg)
    expect(gate('Read', { file_path: '/a' }, 100, cfg)).toBe(undefined) // dispatched: no gate
  }
  for (const cmd of ['grep -n custom-cli hooks/*.sh', 'git commit -m "custom-cli later"', 'echo custom-cli x']) {
    resetNudge()
    observe('Bash', { command: cmd }, 'a', 100, cfg)
    observe('Read', {}, 'x'.repeat(150), 100, cfg)
    expect(denyOf(gate('Read', { file_path: '/a' }, 100, cfg))).toBeDefined()
  }
})
