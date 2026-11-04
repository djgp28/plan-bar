import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, Timer } from 'claude-code'

import type { BarHelper, BarPlan, BarStep, BarSub, PlanStatus, TokenUsage } from '../types'

// plan-bar: one purple progress bar above the prompt. It shows the plan step in
// progress, steps done out of total, a time estimate (average time per finished
// step × steps left) and the tokens the plan used. Hovering the bar, or clicking it,
// shows every step with its time and tokens.
//
// The plan comes from the model's own calls: plan-bar's mcp__plan-bar__plan tool, and
// TodoWrite read from the conversation's rows.

const NAME = 'plan-bar'
// Change the tag when BarPlan's fields change: a reload then starts from an empty plan.
const planAtom = atom({ plugin: 'plan-bar', key: 'plan' } as const, null, { shape: 'plan-1' })
const openAtom = atom({ plugin: 'plan-bar', key: 'open' } as const, false)
const nowAtom = atom({ plugin: 'plan-bar', key: 'now' } as const, 0)
const offAtom = atom({ plugin: 'plan-bar', key: 'off' } as const, false)

const agentsAtom = atom({ plugin: 'plan-bar', key: 'agents' } as const, [] as BarHelper[], { shape: 'agents-1' })
// The newest ones are kept; older ones fall off.
const MAX_HELPERS = 20
// Rows in the details; the rest fold into one "+N more" line.
const HELPER_ROWS = 4

const OWN_TOOL = 'mcp__plan-bar__plan'
// helper-desk's plan tool of the same shape: its calls feed the bar too.
const HD_TOOL = 'mcp__helper-desk__plan'
const STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed']

const TICK_MS = 500
const SWITCH_MS = 3000
// How long a finished plan stays at 100% before the bar goes away.
const HOLD_MS = 20_000
const FALLBACK_COLS = 60
const TIME_W = 8
const TOK_W = 11

const P_LIGHT = '#c4b5fd'
const P_MID = '#8b5cf6'
const P_DEEP = '#6d28d9'
const SPIN = ['◐', '◓', '◑', '◒']

const PROMPT =
  'Track multi-step work with the mcp__plan-bar__plan tool: the user sees it as a progress bar with an estimated finish time. ' +
  'Before starting a task that takes two or more steps or tool calls, send the complete ordered list of steps, the first marked in_progress. ' +
  'Make the plan detailed enough to keep moving: each step should be a concrete piece of work that finishes within about 10 tool calls or 15 minutes. ' +
  'A step that will take longer gets substeps (substeps: [{ text, status }]), and when the work turns out bigger than planned, split the step or add steps and substeps. ' +
  'Send the complete list again every time a step or substep finishes or another begins, not only at the end, and mark the final step completed before your closing reply. ' +
  'A batch of subagents is one step, with one substep per subagent. Only a one-line answer that uses no tools needs no plan.'

// ---- Reminders to the model, read after a tool result; the user never sees them ----
// Main-chat tool calls with no plan before the first reminder to make one.
const NEW_AFTER = 2
// Tool calls, or time, without a plan update before each reminder to send one. They repeat.
const STALE_CALLS = 10
const STALE_MS = 10 * 60_000
// A step running this long with no substeps is told to get some.
const LONG_STEP_MS = 15 * 60_000
// The bar flags a plan this long without an update.
const STALE_SHOW_MS = 15 * 60_000
const P_WARN = '#f59e0b'

type SubIn = { text: string; status: PlanStatus }
type StepIn = { text: string; status: PlanStatus; substeps?: SubIn[] }
type Run = { text: string; color?: string; dim?: boolean }
type Estimate = {
  done: number
  left: number
  /** Average time per finished step, null until one is timed. */
  avg: number | null
  /** avg × steps left; null without an average. */
  eta: number | null
  /** The latest finish, null before any. */
  last: number | null
  /** Each step's own time, null where it is not known (or not done). */
  spent: (number | null)[]
  /** How far the plan is, 0 to 1, counting the substeps done inside unfinished steps. */
  progress: number
}

// Module variables start over on a reload; the plan itself lives in $.state.
let home = ''
let sessionId = ''
let off = false
let busy = false
let ticker: Timer | null = null
let switcher: Timer | null = null
let holdTimer: Timer | null = null
let stateDirMade = false
// The reminders: main-chat tool calls this prompt and since the last plan update, and the last reminder.
let turnCalls = 0
let turnPlanned = false
let turnNudged = false
let callsSince = 0
let nudgeMark = 0
let lastNudgeAt = 0
let nudges = 0
// The tool the model last kept its plan with; reminders name it.
let planTool = OWN_TOOL

/** At most `max` characters, an ellipsis standing for what was dropped. */
function cut(s: string, max: number) {
  if (max <= 0) return ''
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}
const oneLine = (s: string) => s.split(/\s+/).filter(Boolean).join(' ')
const STATUS_SET = new Set<string>(STATUSES)
const isStatus = (v: unknown): v is PlanStatus => typeof v === 'string' && STATUS_SET.has(v)
const doneCount = (steps: readonly { status: PlanStatus }[]) => steps.filter(s => s.status === 'completed').length
const allDone = (steps: readonly { status: PlanStatus }[]) => steps.length > 0 && steps.every(s => s.status === 'completed')
const asObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** One line in ~/.claude/mods-logs/plan-bar.log, keeping its last 20k characters. */
async function log($: EngineInterface, line: string) {
  const file = `${home}/.claude/mods-logs/${NAME}.log`
  try {
    await $.process.run(['mkdir', '-p', `${home}/.claude/mods-logs`])
    const before = (await $.fs.exists(file)) ? String(await $.fs.read(file)) : ''
    const stamp = new Date(await $.clock.now()).toISOString()
    await $.fs.write(file, (before + `${stamp} ${line}\n`).slice(-20_000))
  } catch {
    // A failed log line is dropped; the bar keeps working.
  }
}

// ---------- Reading plans ----------

/** A plan tool's input ({ title?, steps: [{ text, status }] }), or why it is not one. */
function parsePlan(args: Record<string, unknown>): { title?: string; steps: StepIn[] } | string {
  if (!Array.isArray(args.steps)) return 'No plan saved: `steps` must be a list of { text, status } items.'
  const steps: StepIn[] = []
  for (const raw of args.steps as unknown[]) {
    const st = asObject(raw)
    const text = typeof st.text === 'string' ? oneLine(st.text) : ''
    if (!text) return 'No plan saved: one of the steps has no text.'
    if (!isStatus(st.status)) return `No plan saved: step "${cut(text, 40)}" has no valid status (use pending, in_progress or completed).`
    const step: StepIn = { text, status: st.status }
    if (Array.isArray(st.substeps)) {
      const subs: SubIn[] = []
      for (const rawSub of st.substeps as unknown[]) {
        const sb = asObject(rawSub)
        const subText = typeof sb.text === 'string' ? oneLine(sb.text) : ''
        if (!subText) return `No plan saved: a substep of "${cut(text, 40)}" has no text.`
        if (!isStatus(sb.status)) return `No plan saved: substep "${cut(subText, 40)}" has no valid status (use pending, in_progress or completed).`
        // A finished step finished all of its substeps.
        subs.push({ text: subText, status: st.status === 'completed' ? 'completed' : sb.status })
      }
      if (subs.length) step.substeps = subs
    }
    steps.push(step)
  }
  const title = typeof args.title === 'string' ? oneLine(args.title) : ''
  return title ? { title, steps } : { steps }
}

/** TodoWrite's input ({ todos: [{ content, status }] }) as plan steps. */
function parseTodos(args: Record<string, unknown>): StepIn[] {
  const todos = Array.isArray(args.todos) ? (args.todos as unknown[]) : []
  const steps: StepIn[] = []
  for (const raw of todos) {
    const t = asObject(raw)
    const text = typeof t.content === 'string' ? oneLine(t.content) : ''
    if (text) steps.push({ text, status: isStatus(t.status) ? t.status : 'pending' })
  }
  return steps
}

/** A list with work left in it after a finished plan (or with no plan before) starts a new plan. */
function isFresh(old: BarPlan | null, incoming: readonly StepIn[]) {
  return !old || !old.steps.length || (allDone(old.steps) && !allDone(incoming))
}

/** The new list laid over the old one: a step (and a substep) keeps its times while its text stays the same. */
function merge(old: BarPlan | null, title: string | undefined, incoming: readonly StepIn[], now: number): BarPlan {
  const nowDone = allDone(incoming)
  const wasDone = !!old && allDone(old.steps)
  const fresh = isFresh(old, incoming)
  // Old steps by text, oldest first, so two steps with the same text pair up in order.
  const byText = new Map<string, BarStep[]>()
  if (!fresh && old) for (const o of old.steps) byText.set(o.text, [...(byText.get(o.text) ?? []), o])
  const steps = incoming.map(st => {
    const was = byText.get(st.text)?.shift()
    const step: BarStep = { text: st.text, status: st.status }
    if (st.status !== 'pending') step.startedAt = was?.startedAt ?? now
    if (st.status === 'completed') step.doneAt = was?.status === 'completed' && was.doneAt !== undefined ? was.doneAt : now
    if (was?.tokens) step.tokens = was.tokens
    if (st.substeps?.length) {
      const subsByText = new Map<string, BarSub[]>()
      for (const o of was?.substeps ?? []) subsByText.set(o.text, [...(subsByText.get(o.text) ?? []), o])
      step.substeps = st.substeps.map(sb => {
        const prev = subsByText.get(sb.text)?.shift()
        const sub: BarSub = { text: sb.text, status: sb.status }
        if (sb.status === 'completed') sub.doneAt = prev?.status === 'completed' && prev.doneAt !== undefined ? prev.doneAt : now
        return sub
      })
    }
    return step
  })
  const keep = !fresh && old ? old : null
  return {
    title: title || keep?.title || 'Plan',
    steps,
    updatedAt: now,
    startedAt: keep ? keep.startedAt : now,
    // A finished plan sent again keeps whether it still shows.
    shown: keep && wasDone && nowDone ? keep.shown : steps.length > 0,
    ...(keep?.usage ? { usage: keep.usage } : {}),
    ...(keep?.otherTokens ? { otherTokens: keep.otherTokens } : {}),
  }
}

const NO_USAGE: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
const tokenSum = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite + u.output

/** A plan's usage as a file stored it; NO_USAGE where it is missing or broken. */
function usageOf(v: unknown): TokenUsage {
  const o = asObject(v)
  const n = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : 0)
  return { input: n('input'), cacheRead: n('cacheRead'), cacheWrite: n('cacheWrite'), output: n('output') }
}

/**
 * One model request's tokens, added to the step in progress (or to the plan's
 * between-steps count) and to the plan's total. Only an open, unfinished plan counts.
 */
async function addUsage($: EngineInterface, u: ModelUsage) {
  const add: TokenUsage = {
    input: u.input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    output: u.output_tokens || 0,
  }
  const n = tokenSum(add)
  const p = await read($, planAtom)
  if (!n || !p || !p.shown || allDone(p.steps)) return
  await update($, planAtom, cur => {
    if (!cur || !cur.shown || allDone(cur.steps)) return cur
    const i = cur.steps.findIndex(s => s.status === 'in_progress')
    const was = cur.usage ?? NO_USAGE
    return {
      ...cur,
      steps: i < 0 ? cur.steps : cur.steps.map((s, k) => (k === i ? { ...s, tokens: (s.tokens ?? 0) + n } : s)),
      usage: {
        input: was.input + add.input,
        cacheRead: was.cacheRead + add.cacheRead,
        cacheWrite: was.cacheWrite + add.cacheWrite,
        output: was.output + add.output,
      },
      ...(i < 0 || cur.otherTokens ? { otherTokens: (cur.otherTokens ?? 0) + (i < 0 ? n : 0) } : {}),
    }
  })
}

const planFile = () => `${home}/.claude/mods-state/plan-bar-${sessionId}.json`

async function savePlan($: EngineInterface, p: BarPlan | null) {
  if (!p || !home || !sessionId) return
  try {
    if (!stateDirMade) {
      await $.process.run(['mkdir', '-p', `${home}/.claude/mods-state`])
      stateDirMade = true
    }
    const body = {
      title: p.title,
      steps: p.steps,
      startedAt: p.startedAt,
      ...(p.usage ? { usage: p.usage } : {}),
      ...(p.otherTokens ? { otherTokens: p.otherTokens } : {}),
      ...(p.updatedAt ? { planUpdatedAt: p.updatedAt } : {}),
      updatedAt: await $.clock.now(),
    }
    await $.fs.write(planFile(), `${JSON.stringify(body, null, 2)}\n`)
  } catch (err) {
    await log($, `save plan: ${String(err)}`)
  }
}

async function readJson($: EngineInterface, path: string): Promise<Record<string, unknown> | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    return asObject(JSON.parse(String(await $.fs.read(path))))
  } catch {
    return null
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const time = (v: unknown) => {
  if (typeof v === 'number') return num(v)
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

/** plan-bar's plan file for this chat. */
function fromFile(json: Record<string, unknown>, startedAt: number | null): BarPlan | null {
  const steps: BarStep[] = []
  for (const raw of Array.isArray(json.steps) ? (json.steps as unknown[]) : []) {
    const st = asObject(raw)
    if (typeof st.text !== 'string' || !isStatus(st.status)) continue
    const step: BarStep = { text: st.text, status: st.status }
    const s = time(st.startedAt)
    const d = time(st.doneAt)
    if (s !== undefined && st.status !== 'pending') step.startedAt = s
    if (d !== undefined && st.status === 'completed') step.doneAt = d
    const tk = num(st.tokens)
    if (tk) step.tokens = tk
    const subs: BarSub[] = []
    for (const rawSub of Array.isArray(st.substeps) ? (st.substeps as unknown[]) : []) {
      const sb = asObject(rawSub)
      if (typeof sb.text !== 'string' || !isStatus(sb.status)) continue
      const sub: BarSub = { text: sb.text, status: sb.status }
      const sd = time(sb.doneAt)
      if (sd !== undefined && sb.status === 'completed') sub.doneAt = sd
      subs.push(sub)
    }
    if (subs.length) step.substeps = subs
    steps.push(step)
  }
  if (!steps.length) return null
  const title = typeof json.title === 'string' && json.title ? json.title : 'Plan'
  const usage = usageOf(json.usage)
  const other = num(json.otherTokens)
  const updatedAt = time(json.planUpdatedAt) ?? time(json.updatedAt)
  // A plan that had finished before stays out of sight.
  return {
    title,
    steps,
    startedAt,
    ...(updatedAt ? { updatedAt } : {}),
    shown: !allDone(steps),
    ...(tokenSum(usage) ? { usage } : {}),
    ...(other ? { otherTokens: other } : {}),
  }
}

/** A reload keeps the session's copy; a new process picks up this chat's plan file. */
async function loadPlan($: EngineInterface) {
  if ((await read($, planAtom)) || !home || !sessionId) return
  const own = await readJson($, planFile())
  const p = own ? fromFile(own, num(own.startedAt) ?? null) : null
  if (p) await update($, planAtom, () => p)
}

// ---------- Times ----------

/** A step's share of done: 1 once completed, else the part of its substeps done (never all of it). */
function share(s: BarStep) {
  if (s.status === 'completed') return 1
  const subs = s.substeps
  if (!subs?.length) return 0
  return Math.min(0.95, doneCount(subs) / subs.length)
}
const progressOf = (steps: readonly BarStep[]) => (steps.length ? steps.reduce((a, s) => a + share(s), 0) / steps.length : 0)

/** Each substep's own time: from the substep done before it, or from the step's start. */
function subSpent(step: BarStep): (number | null)[] {
  const subs = step.substeps ?? []
  const out: (number | null)[] = subs.map(() => null)
  const order = subs
    .map((sb, j) => ({ j, at: sb.status === 'completed' ? sb.doneAt : undefined }))
    .filter((x): x is { j: number; at: number } => typeof x.at === 'number')
    .sort((a, b) => a.at - b.at)
  let prev = step.startedAt ?? null
  for (const { j, at } of order) {
    out[j] = prev === null ? null : Math.max(0, at - prev)
    prev = at
  }
  return out
}

function estimate(p: BarPlan): Estimate {
  const n = p.steps.length
  const done = doneCount(p.steps)
  const left = n - done
  const order = p.steps
    .map((s, i) => ({ i, at: s.status === 'completed' ? s.doneAt : undefined }))
    .filter((x): x is { i: number; at: number } => typeof x.at === 'number')
    .sort((a, b) => a.at - b.at)
  const spent: (number | null)[] = p.steps.map(() => null)
  // Each finished step's time runs from the finish before it, or from the plan's start.
  let prev = p.startedAt
  for (const { i, at } of order) {
    spent[i] = prev === null ? null : Math.max(0, at - prev)
    prev = at
  }
  const last = order.length ? order[order.length - 1]!.at : null
  // Steps already done when the plan arrived took no time here: they are left out.
  const anchor = p.startedAt ?? (order.length ? order[0]!.at : null)
  const timed = anchor === null ? 0 : order.filter(x => x.at > anchor).length
  const avg = anchor !== null && last !== null && timed > 0 ? (last - anchor) / timed : null
  let eta = avg === null ? null : avg * left
  // Inside a step with substeps: its substeps left at their own pace, then the steps after it.
  const cur = p.steps.find(s => s.status === 'in_progress')
  const subs = cur?.substeps
  const curStart = cur?.startedAt
  if (cur && subs?.length && curStart !== undefined) {
    const timedSubs = subs.filter(sb => sb.status === 'completed' && sb.doneAt !== undefined && sb.doneAt > curStart)
    if (timedSubs.length) {
      const lastSub = Math.max(...timedSubs.map(sb => sb.doneAt!))
      const subAvg = (lastSub - curStart) / timedSubs.length
      const subsLeft = subs.length - doneCount(subs)
      eta = subAvg * subsLeft + Math.max(0, left - 1) * (avg ?? subAvg * subs.length)
    }
  }
  return { done, left, avg, eta, last, spent, progress: progressOf(p.steps) }
}

function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return m < 10 && s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** 950, 9.5k, 350k, 2.41M. */
function tok(n: number) {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
}

function etaText(est: Estimate) {
  if (est.left === 0) return 'done'
  if (est.eta === null) return 'estimating…'
  const s = Math.round(est.eta / 1000)
  if (s < 60) return `~${Math.max(5, Math.round(s / 5) * 5)}s left`
  const m = Math.round(s / 60)
  return m < 60 ? `~${m}m left` : `~${Math.floor(m / 60)}h ${m % 60}m left`
}

/** A colour between two #rrggbb colours; `t` from 0 to 1. */
function blend(from: string, to: string, t: number) {
  const a = parseInt(from.slice(1), 16)
  const b = parseInt(to.slice(1), 16)
  const channel = (shift: number) => {
    const x = (a >> shift) & 0xff
    const y = (b >> shift) & 0xff
    return Math.round(x + (y - x) * t)
  }
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, '0')}`
}

/** The bar in runs of one colour: a purple gradient for done steps, a shimmer over the step in progress, a dim track for the rest. */
function barRuns(width: number, n: number, done: number, progress: number, live: boolean, frame: number | null): Run[] {
  const runs: Run[] = []
  const push = (ch: string, color?: string, dim?: boolean) => {
    const lastRun = runs[runs.length - 1]
    if (lastRun && lastRun.color === color && lastRun.dim === dim && lastRun.text[0] === ch) lastRun.text += ch
    else runs.push({ text: ch, ...(color ? { color } : {}), ...(dim ? { dim } : {}) })
  }
  const fill = Math.min(width, Math.round(width * progress))
  const liveC = live ? Math.min(width - fill, Math.max(1, Math.round((width * Math.min(n, done + 1)) / n) - fill)) : 0
  for (let i = 0; i < fill; i++) push('█', blend(P_LIGHT, P_DEEP, Math.round((fill > 1 ? i / (fill - 1) : 1) * 5) / 5))
  const glow = frame === null || !liveC ? -1 : frame % liveC
  for (let i = 0; i < liveC; i++) push(i === glow ? '█' : '▓', i === glow ? P_LIGHT : P_MID)
  for (let i = fill + liveC; i < width; i++) push('░', undefined, true)
  return runs
}

// ---------- Keeping it current ----------

function syncTicker($: EngineInterface, p: BarPlan | null) {
  const need = !off && busy && !!p && p.shown && !allDone(p.steps)
  if (need) {
    ticker ??= $.clock.every(TICK_MS, () => {
      void $.clock
        .now()
        .then(t => update($, nowAtom, () => t))
        .catch(() => undefined)
    })
  } else {
    ticker?.cancel()
    ticker = null
  }
}

function scheduleHide($: EngineInterface) {
  holdTimer?.cancel()
  holdTimer = $.clock.after(HOLD_MS, () => {
    holdTimer = null
    void update($, planAtom, p => (p && allDone(p.steps) ? { ...p, shown: false } : p)).catch(err => log($, `hide: ${String(err)}`))
  })
}

/** What a plan update should announce: the steps that just finished, or the whole plan. */
function notice(old: BarPlan | null, incoming: readonly StepIn[]): string | null {
  if (!incoming.length) return null
  if (allDone(incoming)) {
    if (old && old.steps.length && allDone(old.steps)) return null
    return incoming.length === 1 ? 'All steps done.' : `All ${incoming.length} steps done.`
  }
  // Steps already done when a plan first arrives are not news.
  if (isFresh(old, incoming)) return null
  const before = new Map<string, number>()
  for (const o of old!.steps) if (o.status === 'completed') before.set(o.text, (before.get(o.text) ?? 0) + 1)
  const done: string[] = []
  for (const st of incoming) {
    if (st.status !== 'completed') continue
    const n = before.get(st.text) ?? 0
    if (n > 0) before.set(st.text, n - 1)
    else done.push(st.text)
  }
  return done.length ? `Done: ${done.join(', ')}` : null
}

function toast($: EngineInterface, text: string) {
  try {
    $.ui.toast(cut(text, 140))
  } catch {
    // A toast is only a hint.
  }
}

// ---------- Reminders ----------

const pct = (p: BarPlan) => `${Math.round(progressOf(p.steps) * 100)}%`
const supportsSubsteps = (tool: string) => tool === OWN_TOOL

/** How the model should make a long step move, in the words of the tool it uses. */
function splitHint(tool: string) {
  if (supportsSubsteps(tool)) return 'give it substeps (substeps: [{ text, status }]) or split it into smaller steps, so the bar moves while it runs'
  if (tool === 'TodoWrite') return 'split it into smaller to-do items, so the bar moves while it runs'
  return 'split it into smaller steps, so the bar moves while it runs'
}

function staleNote(p: BarPlan, now: number) {
  const cur = p.steps.find(s => s.status === 'in_progress')
  const since = p.updatedAt === undefined ? null : now - p.updatedAt
  const quiet = since === null ? `${callsSince} tool calls` : `${dur(since)} and ${callsSince} tool calls`
  let text =
    `plan-bar: the plan has not been updated for ${quiet}, so the user's progress bar is stuck at ${pct(p)}` +
    `${cur ? ` on "${cut(cur.text, 80)}"` : ''}. Call ${planTool} now with the full list: mark every finished step${supportsSubsteps(planTool) ? ' and substep' : ''} completed and the current one in_progress.`
  const ranFor = cur?.startedAt === undefined ? 0 : now - cur.startedAt
  if (cur && ranFor >= LONG_STEP_MS && !cur.substeps?.length) text += ` This step has run ${dur(ranFor)}: ${splitHint(planTool)}.`
  if (nudges >= 2) text += ' This reminder repeats until the plan is updated.'
  return text
}

/** The reminder this main-chat tool call should carry, if any. */
async function nudgeFor($: EngineInterface): Promise<string | null> {
  turnCalls++
  callsSince++
  const p = await read($, planAtom)
  const live = !!p && p.shown && p.steps.length > 0 && !allDone(p.steps)
  const now = await $.clock.now()
  const mark = () => {
    turnNudged = true
    lastNudgeAt = now
    nudgeMark = callsSince
  }
  if (!turnPlanned && !turnNudged) {
    if (live) {
      // A new request while a plan is open: continue it or replace it.
      mark()
      const cur = p.steps.find(s => s.status === 'in_progress')
      return (
        `plan-bar: a plan is still open ("${cut(p.title, 60)}", ${doneCount(p.steps)}/${p.steps.length} steps, ${pct(p)}${cur ? `, on "${cut(cur.text, 60)}"` : ''}). ` +
        `If this request carries it on, send the updated list with ${planTool}; if it is a new task, send its own plan.`
      )
    }
    if (turnCalls >= NEW_AFTER) {
      mark()
      return `plan-bar: this task has no plan yet. If it takes more than a couple of tool calls, call ${OWN_TOOL} now with every step in order (the first in_progress), detailed enough that a step finishes every few minutes.`
    }
    return null
  }
  if (!live) return null
  // Repeats: every STALE_CALLS tool calls or STALE_MS since the last update or reminder, whichever comes first.
  const ref = Math.max(p.updatedAt ?? 0, lastNudgeAt)
  if (callsSince - nudgeMark >= STALE_CALLS || (ref > 0 && now - ref >= STALE_MS)) {
    mark()
    nudges++
    return staleNote(p, now)
  }
  return null
}

/** A plan came in, from any tool: the reminders count from zero. */
function planned(tool: string) {
  planTool = tool
  turnPlanned = true
  callsSince = 0
  nudgeMark = 0
  lastNudgeAt = 0
  nudges = 0
}

/** The tool's answer: progress, and a hint when the step in progress is long and has no substeps. */
function answer(p: BarPlan | null, now: number) {
  if (!p) return 'Saved.'
  const n = p.steps.length
  const done = doneCount(p.steps)
  const cur = p.steps.find(s => s.status === 'in_progress')
  const subs = cur?.substeps
  let text = `Saved. Progress: ${done}/${n} steps complete`
  text += subs?.length ? `, ${pct(p)} overall (current step: ${doneCount(subs)}/${subs.length} substeps).` : '.'
  const ranFor = cur?.startedAt === undefined ? 0 : now - cur.startedAt
  if (cur && !subs?.length && ranFor >= LONG_STEP_MS) text += ` "${cut(cur.text, 60)}" has been in progress for ${dur(ranFor)}: ${splitHint(OWN_TOOL)}.`
  return text
}

async function applyPlan($: EngineInterface, title: string | undefined, incoming: readonly StepIn[]) {
  const now = await $.clock.now()
  let said: string | null = null
  const p = await update($, planAtom, old => {
    said = notice(old, incoming)
    return merge(old, title, incoming, now)
  })
  if (said) toast($, said)
  if (p && allDone(p.steps) && p.shown) scheduleHide($)
  else {
    holdTimer?.cancel()
    holdTimer = null
  }
  await update($, nowAtom, () => now)
  syncTicker($, p)
  await savePlan($, p)
  return answer(p, now)
}

async function readSwitches($: EngineInterface) {
  return (await readJson($, `${home}/.claude/mods/switches.json`)) ?? {}
}

// "plan-bar": false in ~/.claude/mods/switches.json (the /mods pane's file) turns it off in every chat.
async function readSwitch($: EngineInterface) {
  const value = (await readSwitches($))[NAME] === false
  if (value === off) return
  off = value
  await update($, offAtom, () => off)
  syncTicker($, await read($, planAtom))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      home = $.plugin.root.split('/.claude/')[0] ?? ''
      sessionId = await $.session.id().catch(() => '')
      await readSwitch($)
      await loadPlan($)
      await $.tool.register({
        name: 'plan',
        description:
          'Record the ordered steps of the current job and the status of each (pending, in_progress or completed). ' +
          'The user sees them as a progress bar with a time estimate above the prompt. Always send the full list, not only what changed. ' +
          'A long step can carry substeps; the bar moves as each one is completed. Update it each time a step or substep finishes.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Optional short label for the job.' },
            steps: {
              type: 'array',
              description: 'All steps, first to last.',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'What the step does, briefly.' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                  substeps: {
                    type: 'array',
                    description: 'Optional: the smaller pieces of a step that takes more than ~15 minutes or ~10 tool calls.',
                    items: {
                      type: 'object',
                      properties: {
                        text: { type: 'string', description: 'What the substep does, briefly.' },
                        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                      },
                      required: ['text', 'status'],
                    },
                  },
                },
                required: ['text', 'status'],
              },
            },
          },
          required: ['steps'],
        },
        // Listed up front rather than behind ToolSearch, so the model actually reaches for it.
        isDeferred: false,
      })
      switcher?.cancel()
      switcher = $.clock.every(SWITCH_MS, () => {
        void readSwitch($).catch(err => log($, `switch: ${String(err)}`))
      })
      const p = await read($, planAtom)
      if (p && p.shown && allDone(p.steps)) scheduleHide($)
      syncTicker($, p)
    } catch (err) {
      await log($, `start: ${String(err)}`)
    }
    return r
  })

  // TodoWrite and helper-desk's plan calls, read off the model's response rows.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (!off && !e.agentId) {
      for (const block of e.message.content) {
        if (block.type !== 'tool_use') continue
        if (block.name === 'TodoWrite') {
          planned('TodoWrite')
          void applyPlan($, undefined, parseTodos(asObject(block.input))).catch(err => log($, `todos: ${String(err)}`))
        } else if (block.name === HD_TOOL) {
          const parsed = parsePlan(asObject(block.input))
          if (typeof parsed === 'string') continue
          planned(HD_TOOL)
          void applyPlan($, parsed.title, parsed.steps).catch(err => log($, `helper-desk plan: ${String(err)}`))
        }
      }
    }
    return next(e)
  })

  // plan-bar's own plan tool.
  // Unfiltered: a typed matcher on an MCP name makes tsc recurse through the connector types.
  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string
    if (tool !== OWN_TOOL) {
      // Plan tools of others are read from the response rows; every other main-chat call may carry a reminder.
      if (off || e.agentId || tool === 'TodoWrite' || tool === HD_TOOL) return next(e)
      const r = await next(e)
      let note: string | null = null
      try {
        note = await nudgeFor($)
      } catch (err) {
        await log($, `nudge: ${String(err)}`)
      }
      if (!note || !r || typeof r !== 'object' || typeof (r as { deny?: unknown }).deny === 'string') return r
      const had = (r as { context?: readonly string[] }).context ?? []
      return { ...r, context: [...had, note] } as never
    }
    if (off) return { result: 'plan-bar is switched off, so nothing was saved. Continue without a plan.' } as never
    if (e.agentId) return { result: 'Plans belong to the main conversation; a subagent can continue without one.' } as never
    const parsed = parsePlan(e as unknown as Record<string, unknown>)
    if (typeof parsed === 'string') return { result: parsed } as never
    planned(OWN_TOOL)
    try {
      return { result: await applyPlan($, parsed.title, parsed.steps) } as never
    } catch (err) {
      await log($, `own plan: ${String(err)}`)
      return { result: 'Could not save the plan (internal error). Continue with the task.' } as never
    }
  })

  // A new request: the per-request reminders count from zero (the stale ones keep counting).
  on('prompt.submit', async ($, e, next) => {
    turnCalls = 0
    turnPlanned = false
    turnNudged = false
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (off || e.traits.includes('teammate') || e.traits.includes('bare')) return r
    return { sections: [...r.sections, { id: 'plan-bar:plan', text: PROMPT, scope: 'session' as const }] }
  })

  // The clock ticks only while the main chat is working on a plan.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      busy = true
      void read($, planAtom)
        .then(p => syncTicker($, p))
        .catch(() => undefined)
    }
    return next(e)
  })

  // A subagent the main chat starts gets a row in the details.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = (r as { agentId?: string }).agentId
    if (!off && id) {
      void $.clock
        .now()
        .then(now =>
          update($, agentsAtom, list => [
            ...list.filter(ag => ag.id !== id).slice(-(MAX_HELPERS - 1)),
            { id, description: oneLine(e.description || '') || 'Subagent', startedAt: now, status: 'working' as const, tokens: 0 },
          ]),
        )
        .catch(err => log($, `spawn: ${String(err)}`))
    }
    return r
  })

  // Each model request, the main chat's and every subagent's: its tokens go to the step in progress.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (!off && r.usage) {
      void addUsage($, r.usage).catch(err => log($, `tokens: ${String(err)}`))
      const id = e.agentId
      if (id) {
        const u = r.usage
        const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
        void update($, agentsAtom, list => (list.some(ag => ag.id === id) ? list.map(ag => (ag.id === id ? { ...ag, tokens: ag.tokens + n } : ag)) : list)).catch(
          () => undefined,
        )
      }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const id = e.agentId
    if (id) {
      const status = e.reason === 'error' || e.reason === 'refusal' || e.isAborted ? ('failed' as const) : ('done' as const)
      void $.clock
        .now()
        .then(now =>
          update($, agentsAtom, list =>
            list.some(ag => ag.id === id && ag.status === 'working') ? list.map(ag => (ag.id === id && ag.status === 'working' ? { ...ag, status, endedAt: now } : ag)) : list,
          ),
        )
        .catch(() => undefined)
    }
    if (!e.agentId) {
      busy = false
      syncTicker($, null)
      void $.clock
        .now()
        .then(t => update($, nowAtom, () => t))
        .catch(() => undefined)
      // Token counts change on every request; the file catches up once a turn ends.
      void read($, planAtom)
        .then(p => savePlan($, p))
        .catch(() => undefined)
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const p = await read($, planAtom)
    const isOff = await read($, offAtom)
    if (isOff || !p || !p.shown || !p.steps.length) return next(e)
    // Bands from the mods beneath stay above the bar; the engine's own placeholder (type 'engine') is dropped.
    let rest: unknown = null
    try {
      const below = (await next(e)) as unknown
      if (below && typeof below === 'object' && (below as { type?: unknown }).type !== 'engine') rest = below
    } catch {
      rest = null
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const isOpen = await read($, openAtom)
    const now = Math.max(await read($, nowAtom), await $.clock.now())
    const cols = e.props.bodyColumns > 0 ? Math.floor(e.props.bodyColumns) : FALLBACK_COLS

    const n = p.steps.length
    const est = estimate(p)
    const finished = est.left === 0
    const working = e.props.isWorking && !finished
    const frame = working ? Math.floor(now / TICK_MS) : null
    const spin = frame === null ? (finished ? '✓' : '◆') : SPIN[frame % SPIN.length]!
    const curIdx = p.steps.findIndex(s => s.status === 'in_progress')
    const cur = curIdx >= 0 ? p.steps[curIdx] : undefined
    const nextUp = p.steps.find(s => s.status === 'pending')
    const subs = cur?.substeps ?? []
    const curSub = subs.find(sb => sb.status === 'in_progress') ?? subs.find(sb => sb.status === 'pending')

    // ---- The bar: glyph, step name, bar, done/total · time left · tokens, caret ----
    const usage = p.usage ?? NO_USAGE
    const total = tokenSum(usage)
    const count = `${est.done}/${n}`
    const subCount = subs.length ? ` ·${doneCount(subs)}/${subs.length}` : ''
    // A plan that has gone quiet while the chat works: the bar says so.
    const quietFor = !finished && p.updatedAt !== undefined ? now - p.updatedAt : 0
    const quiet = working && quietFor >= STALE_SHOW_MS ? ` · ⚠ no update ${dur(quietFor)}` : ''
    // Subagents of this plan: a quiet count on the bar while any work, a short list in the details.
    const helpers = (await read($, agentsAtom)).filter(ag => p.startedAt === null || ag.startedAt >= p.startedAt)
    const busyHelpers = helpers.filter(ag => ag.status === 'working').length
    const agentsText = busyHelpers ? ` · ${busyHelpers} agent${busyHelpers === 1 ? '' : 's'}` : ''
    const tail = ` · ${etaText(est)}${total ? ` · ${tok(total)} tok` : ''}${agentsText} ${isOpen ? '▾' : '▴'}`
    const fixed = 2 + 1 + 1 + count.length + subCount.length + quiet.length + tail.length
    const nameW = Math.max(8, Math.min(40, Math.floor((cols - fixed) * 0.45)))
    // The step and, inside it, the substep at hand.
    const label = cur
      ? curSub
        ? `${cut(cur.text, Math.max(6, Math.min(Math.floor(nameW * 0.5), nameW - 3 - curSub.text.length)))} › ${curSub.text}`
        : cur.text
      : finished
        ? 'All steps done'
        : nextUp
          ? `Next: ${nextUp.text}`
          : p.title
    const barW = Math.max(6, cols - fixed - nameW)
    const runs = barRuns(barW, n, est.done, est.progress, !!cur, frame)

    const row = (
      <Button key="plan-bar-toggle" plain onPress={() => update($, openAtom, v => !v)}>
        <Text bold color={P_DEEP}>{`${spin} `}</Text>
        <Text bold>{cut(label, nameW).padEnd(nameW)}</Text>
        <Text> </Text>
        {runs.map(r => (
          <Text color={r.color} dimColor={r.dim}>
            {r.text}
          </Text>
        ))}
        <Text> </Text>
        <Text bold color={P_MID}>
          {count}
        </Text>
        {subCount ? <Text color={P_MID}>{subCount}</Text> : null}
        {quiet ? <Text color={P_WARN}>{quiet}</Text> : null}
        <Text dimColor>{tail}</Text>
      </Button>
    )

    // ---- The details: every step with its time, shown on hover or after a click ----
    const inner = Math.max(10, cols - 4)
    const textW = Math.max(4, inner - 2 - TOK_W - TIME_W)
    const helperLines = helpers.length ? 1 + Math.min(HELPER_ROWS, helpers.length) + (helpers.length > HELPER_ROWS ? 1 : 0) : 0
    const room = Math.max(3, Math.min(14, (e.props.maxRows || 16) - 7 - helperLines))
    type Line = { i: number; j: number | null }
    const lines: Line[] = []
    for (let i = 0; i < n; i++) {
      lines.push({ i, j: null })
      const st = p.steps[i]!
      if (st.status === 'in_progress') for (let j = 0; j < (st.substeps?.length ?? 0); j++) lines.push({ i, j })
    }
    const focusStep = curIdx >= 0 ? curIdx : Math.max(0, p.steps.findIndex(s => s.status === 'pending'))
    const subFocus = curSub && cur?.substeps ? cur.substeps.indexOf(curSub) : -1
    const focus = Math.max(
      0,
      lines.findIndex(l => l.i === focusStep && (subFocus < 0 ? l.j === null : l.j === subFocus)),
    )
    const L = lines.length
    const from = L <= room ? 0 : Math.max(0, Math.min(L - room, focus - Math.floor(room / 2)))
    const shown = lines.slice(from, from + room)
    const subTimes = cur ? subSpent(cur) : []
    const since = (s: BarStep) => Math.max(s.startedAt ?? 0, est.last ?? p.startedAt ?? 0)
    const elapsed = p.startedAt === null ? null : (finished && est.last !== null ? est.last : now) - p.startedAt
    const head = `${est.done} of ${n} done · ${Math.round(est.progress * 100)}%${elapsed === null ? '' : ` · ${dur(elapsed)} ${finished ? 'in all' : 'so far'}`}`
    const foot = finished
      ? 'Every step is done.'
      : est.eta === null
        ? 'The estimate starts once a step or substep is done.'
        : est.avg === null
          ? `≈ ${dur(est.eta)} left, from the substeps' pace`
          : `avg ${dur(est.avg)} per step × ${est.left} left ≈ ${dur(est.eta)}`
    const other = p.otherTokens ?? 0
    const tokLine = total
      ? `Tokens: ${tok(total)} total · ${tok(usage.cacheRead)} cache reads · ${tok(usage.input + usage.cacheWrite)} new input · ${tok(usage.output)} output` +
        (other ? ` · ${tok(other)} between steps` : '')
      : 'Tokens: counted from the next model request.'

    // Working ones first, then the most recent; finished ones stay dim.
    const listed = [...helpers].sort((a, b) => (a.status === 'working' ? 0 : 1) - (b.status === 'working' ? 0 : 1) || b.startedAt - a.startedAt)
    const helperRows = listed.length ? (
      <Box flexDirection="column" width={inner}>
        <Text dimColor wrap="truncate-end">
          {cut(`Subagents · ${busyHelpers} working · ${listed.length - busyHelpers} finished`, inner)}
        </Text>
        {listed.slice(0, HELPER_ROWS).map(ag => {
          const live = ag.status === 'working'
          const mark = live ? spin : ag.status === 'done' ? '✓' : '✗'
          return (
            <Box flexDirection="row" width={inner}>
              <Text color={live ? P_MID : undefined} dimColor={!live}>{`  ${mark} `}</Text>
              <Box width={Math.max(4, textW - 2)}>
                <Text dimColor={!live} wrap="truncate-end">
                  {cut(ag.description, Math.max(4, textW - 2))}
                </Text>
              </Box>
              <Box width={TOK_W} justifyContent="flex-end">
                <Text dimColor>{ag.tokens ? `${tok(ag.tokens)} tok` : ''}</Text>
              </Box>
              <Box width={TIME_W} justifyContent="flex-end">
                <Text dimColor>{dur(Math.max(0, (ag.endedAt ?? now) - ag.startedAt))}</Text>
              </Box>
            </Box>
          )
        })}
        {listed.length > HELPER_ROWS ? <Text dimColor>{`    +${listed.length - HELPER_ROWS} more`}</Text> : null}
      </Box>
    ) : null

    const details = (
      <Box
        flexDirection="column"
        width={cols}
        borderStyle="round"
        borderColor={P_MID}
        paddingX={1}
        display={isOpen ? 'flex' : 'none'}
        hover={isOpen ? undefined : { display: 'flex' }}
      >
        <Text wrap="truncate-end">
          <Text bold color={P_DEEP}>
            {cut(p.title, Math.max(4, inner - head.length - 3))}
          </Text>
          <Text dimColor>{` · ${head}`}</Text>
        </Text>
        {from > 0 ? <Text dimColor>{`  ↑ ${from} earlier`}</Text> : null}
        {shown.map(({ i, j }) => {
          const s = p.steps[i]!
          if (j !== null) {
            const sb = s.substeps![j]!
            const live = i === curIdx && sb === curSub && sb.status === 'in_progress'
            const sMark = sb.status === 'completed' ? '✓' : live ? spin : '·'
            const st = sb.status === 'completed' && i === curIdx ? subTimes[j] : null
            return (
              <Box flexDirection="row" width={inner}>
                <Text color={sb.status === 'completed' ? P_MID : live ? P_DEEP : undefined} dimColor={sb.status === 'pending'}>
                  {`    ${sMark} `}
                </Text>
                <Box width={Math.max(4, textW + TOK_W - 4)}>
                  <Text bold={live} dimColor={sb.status !== 'in_progress'} wrap="truncate-end">
                    {cut(sb.text, Math.max(4, textW + TOK_W - 4))}
                  </Text>
                </Box>
                <Box width={TIME_W} justifyContent="flex-end">
                  <Text dimColor>{st === null || st === undefined ? '' : dur(st)}</Text>
                </Box>
              </Box>
            )
          }
          const isCur = i === curIdx
          const mark = s.status === 'completed' ? '✓' : isCur ? spin : '○'
          const spent = est.spent[i]
          const t =
            s.status === 'completed'
              ? spent === null || spent === undefined
                ? ''
                : dur(spent)
              : isCur && since(s) > 0
                ? dur(now - since(s))
                : ''
          return (
            <Box flexDirection="row" width={inner}>
              <Text bold={isCur} color={s.status === 'pending' ? undefined : isCur ? P_DEEP : P_MID} dimColor={s.status === 'pending'}>
                {`${mark} `}
              </Text>
              <Box width={textW}>
                <Text bold={isCur} dimColor={s.status === 'pending'} wrap="truncate-end">
                  {cut(s.substeps?.length ? `${s.text} (${doneCount(s.substeps)}/${s.substeps.length})` : s.text, textW)}
                </Text>
              </Box>
              <Box width={TOK_W} justifyContent="flex-end">
                <Text dimColor={!isCur} color={isCur ? P_MID : undefined}>
                  {s.tokens ? `${tok(s.tokens)} tok` : ''}
                </Text>
              </Box>
              <Box width={TIME_W} justifyContent="flex-end">
                <Text dimColor={!isCur} color={isCur ? P_MID : undefined}>
                  {t}
                </Text>
              </Box>
            </Box>
          )
        })}
        {from + room < L ? <Text dimColor>{`  ↓ ${L - from - room} more`}</Text> : null}
        {helperRows}
        <Text color={P_MID} wrap="truncate-end">
          {cut(tokLine, inner)}
        </Text>
        <Text dimColor wrap="truncate-end">
          {cut(`${foot} · click the bar to ${isOpen ? 'close' : 'pin'}`, inner)}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {rest as never}
        <Box key="plan-bar" flexDirection="column" width={cols}>
          {details}
          {row}
        </Box>
      </Box>
    )
  })
}
