import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'plan-bar',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 90,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

const MIN = 60_000

/** The engine beneath the plugin: no files on disk, the tools the test names, a placeholder band. */
function engine(on: On, tools: string[], registered: string[] = [], files: Record<string, string> = {}) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('tool.list', () => ({ value: tools.map(name => ({ name, description: '', mcp: true })) }))
  on('tool.register', (_, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__plan-bar__${e.name}` } }
  })
  const file = (path: string) => Object.keys(files).find(name => path.endsWith(name))
  on('fs.exists', (_, e) => ({ value: !!file(e.path) }))
  on('fs.read', (_, e) => ({ value: files[file(e.path) ?? ''] ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return mock.clock(on, { now: 1_000_000 })
}

type Step = { text: string; status: 'pending' | 'in_progress' | 'completed' }
const S = (...marks: string[]): Step[] =>
  marks.map((m, i) => ({ text: `Step ${i + 1}`, status: m === 'c' ? 'completed' : m === 'i' ? 'in_progress' : 'pending' }))

let seq = 0
/** The model calling a plan tool, as its response row reaches the conversation. */
function planRow(name: string, input: Record<string, unknown>) {
  seq += 1
  return {
    door: 'response' as const,
    origin: { kind: 'model' as const, model: 'claude-opus-5-5' },
    uuid: `row-${seq}`,
    message: {
      type: 'assistant' as const,
      role: 'assistant' as const,
      content: [{ type: 'tool_use', id: `tu-${seq}`, name, input }],
    },
  }
}

test("helper-desk's plan calls drive the bar: step, count and time left", async ($, on) => {
  const registered: string[] = []
  const clock = engine(on, ['mcp__helper-desk__plan'], registered)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // helper-desk serves plans here, so plan-bar adds no tool of its own.
  expect(registered).toEqual([])

  await $.session.append(planRow('mcp__helper-desk__plan', { title: 'Ship it', steps: S('i', 'p', 'p', 'p') }))
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Step 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^0\/4$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /estimating/ })).toBeDefined()
    await ui.unmount()
  }

  // Step 1 takes a minute: 1 min a step × 3 left.
  await clock.advance(MIN)
  await $.session.append(planRow('mcp__helper-desk__plan', { title: 'Ship it', steps: S('c', 'i', 'p', 'p') }))
  await clock.settle()
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^1\/4$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /~3m left/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Step 2/ })).toBeDefined()
  await ui.unmount()

  // Step 2 takes two: 1.5 min a step × 2 left.
  await clock.advance(2 * MIN)
  await $.session.append(planRow('mcp__helper-desk__plan', { title: 'Ship it', steps: S('c', 'c', 'i', 'p') }))
  await clock.settle()
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^2\/4$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /~3m left/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /avg 1m 30s per step × 2 left ≈ 3m/ })).toBeDefined()
  await ui.unmount()
})

test('a click pins the details open and a second click closes them', async ($, on) => {
  engine(on, ['mcp__helper-desk__plan'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(planRow('mcp__helper-desk__plan', { title: 'Ship it', steps: S('c', 'i', 'p') }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /click the bar to pin/ })).toBeDefined()
    await ui.press({ key: 'plan-bar-toggle' })
    expect(await ui.find({ type: 'Text', text: /click the bar to close/ })).toBeDefined()
    await ui.press({ key: 'plan-bar-toggle' })
    expect(await ui.find({ type: 'Text', text: /click the bar to pin/ })).toBeDefined()
    await ui.unmount()
  }
})

test('TodoWrite feeds the bar too', async ($, on) => {
  engine(on, ['mcp__helper-desk__plan'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(
    planRow('TodoWrite', {
      todos: [
        { content: 'Read the code', status: 'completed', activeForm: 'Reading' },
        { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing' },
      ],
    }),
  )
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Fix the bug/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1\/2$/ })).toBeDefined()
  await ui.unmount()
})

test('without helper-desk, plan-bar serves its own plan tool', async ($, on) => {
  const registered: string[] = []
  engine(on, [], registered)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['plan'])

  const r = await $.tool.call({ tool: 'mcp__plan-bar__plan', title: 'Own', steps: S('i', 'p') } as never)
  expect((r as { result?: unknown }).result).toBe('Saved. Progress: 0/2 steps complete.')
  const bad = await $.tool.call({ tool: 'mcp__plan-bar__plan', steps: [{ text: 'x' }] } as never)
  expect(String((bad as { result?: unknown }).result)).toMatch(/no valid status/)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^0\/2$/ })).toBeDefined()
  await ui.unmount()
})

test('a finished plan holds at 100% for 20 s, then the bar goes', async ($, on) => {
  const clock = engine(on, ['mcp__helper-desk__plan'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(planRow('mcp__helper-desk__plan', { title: 'Ship it', steps: S('i', 'p') }))
  await clock.advance(MIN)
  await $.session.append(planRow('mcp__helper-desk__plan', { title: 'Ship it', steps: S('c', 'c') }))
  await clock.settle()
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^2\/2$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /All steps done/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(21_000)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^2\/2$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent plan call is not the chat plan', async ($, on) => {
  engine(on, ['mcp__helper-desk__plan'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append({ ...planRow('mcp__helper-desk__plan', { steps: S('i', 'p') }), agentId: 'agent-1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^0\/2$/ })).toBeUndefined()
  await ui.unmount()
})

test('loaded mid-chat, it picks up the plan helper-desk already holds', async ($, on) => {
  // helper-desk's own file for this chat: four steps done at once, one in progress.
  const hd = {
    title: 'Launch checklist',
    steps: [
      ...['A', 'B', 'C', 'D'].map(t => ({ text: `Check ${t}`, status: 'completed', doneAt: '2026-11-03T02:11:43.758Z' })),
      { text: 'Draft the notes', status: 'in_progress' },
      { text: 'Review the notes', status: 'pending' },
      { text: 'Publish', status: 'pending' },
    ],
    updatedAt: '2026-11-03T02:24:21.719Z',
  }
  engine(on, ['mcp__helper-desk__plan'], [], { 'mods-state/plan-sid-1.json': JSON.stringify(hd) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^4\/7$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Draft the notes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /estimating/ })).toBeDefined()
  await ui.unmount()
})

test('tokens: each request goes to the step in progress, subagents included, with a total', async ($, on) => {
  const clock = engine(on, ['mcp__helper-desk__plan'])
  // The model requests beneath: each answers with the next usage in line.
  const usages = [
    { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400, output_tokens: 500 },
    { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1000 },
    { input_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
  ]
  on('turn.step', async function* (_, e) {
    const u = usages.shift()!
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { ...u, model: 'claude-opus-5-5' } }
  })
  const request = async (agentId?: string) => {
    const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of s) {
      // nothing streams beneath
    }
    await clock.settle()
  }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(planRow('mcp__helper-desk__plan', { title: 'Ship it', steps: S('i', 'p') }))
  await request()
  await request('agent-1')
  await $.session.append(planRow('mcp__helper-desk__plan', { title: 'Ship it', steps: S('c', 'i') }))
  await request()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /15k tok/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^12k tok$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^3\.0k tok$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Tokens: 15k total · 9\.0k cache reads · 4\.5k new input · 1\.5k output/ })).toBeDefined()
    await ui.unmount()
  }
})

test('tokens stop counting once the plan is finished', async ($, on) => {
  const clock = engine(on, ['mcp__helper-desk__plan'])
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, model: 'm' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(planRow('mcp__helper-desk__plan', { title: 'Ship it', steps: S('c', 'c') }))
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of s) {
    // nothing streams beneath
  }
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /tok/ })).toBeUndefined()
  await ui.unmount()
})
