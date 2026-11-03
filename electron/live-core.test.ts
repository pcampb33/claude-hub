import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ACTIVE_WINDOW_MS,
  DEFAULT_CONTEXT_LIMIT,
  TAIL_BYTES,
  contextLimitFor,
  deriveLiveSessionStatus,
  firstTimestamp,
  isHeadlessTranscript,
  notificationsFor,
  readJsonlHead,
  readJsonlTail,
  readActivityTail,
  sessionProcessLookup,
  type LiveSessionStatus,
} from './live-core.ts'

// Every case injects fixed times — no wall-clock anywhere.
const NOW = Date.parse('2026-06-15T12:00:00.000Z')

// Inline fixture lines mirroring the real transcript shapes (spot-checked
// against a live ~/.claude/projects .jsonl while building this module).
const userLine = JSON.stringify({ type: 'user', timestamp: '2026-06-15T11:59:00.000Z', sessionId: 's1' })

const assistantLine = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-06-15T11:59:30.000Z',
  message: {
    model: 'claude-fable-5',
    usage: { input_tokens: 10_000, output_tokens: 300, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 10_000 },
    content: [
      { type: 'text', text: 'working on it' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ],
  },
})

const titleLine = JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the flux capacitor', sessionId: 's1' })

const turnDurationLine = JSON.stringify({
  type: 'system',
  subtype: 'turn_duration',
  durationMs: 113763,
  timestamp: '2026-06-15T11:59:40.000Z',
})

function stopHookLine(hookErrors: string[]): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookErrors,
    timestamp: '2026-06-15T11:59:39.000Z',
  })
}

test('active session: recent activity and no turn close after the last activity', () => {
  const status = deriveLiveSessionStatus([userLine, titleLine, assistantLine], NOW)
  assert.equal(status.state, 'active')
  assert.equal(status.lastToolName, 'Bash')
  assert.equal(status.model, 'claude-fable-5')
  assert.equal(status.aiTitle, 'Fix the flux capacitor')
  assert.equal(status.lastTimestamp, '2026-06-15T11:59:30.000Z')
  // raw tokens (10k + 20k + 10k) and the model's own limit are carried, not just the pct
  assert.equal(status.contextTokens, 40_000)
  assert.equal(status.contextLimit, 1_000_000) // fable-5 ships a 1M window
  assert.equal(status.contextPct, 4) // 40k / 1M
})

test('recentTurns: one entry per completed assistant turn — output + input cost + tool flag', () => {
  const textTurn = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-15T11:59:10.000Z',
    message: { model: 'claude-fable-5', usage: { input_tokens: 100, output_tokens: 42 }, content: [{ type: 'text', text: 'hi' }] },
  })
  // assistantLine has output_tokens 300, a tool_use (Bash), and input cost
  // 10k + 20k + 10k = 40k (input + cache_read + cache_creation); textTurn's input
  // cost is just its 100 input_tokens. The user line is not a turn.
  const status = deriveLiveSessionStatus([userLine, textTurn, assistantLine], NOW)
  assert.deepEqual(status.recentTurns, [
    { output: 42, input: 100, tool: false },
    { output: 300, input: 40_000, tool: true },
  ])
})

test('recentTurns: multiple lines of one response (shared message.id) collapse to one bar', () => {
  // Both lines share message.id AND identical usage (real Claude Code shape):
  // input cost 50k + 200k + 10k = 260k.
  const usage = { input_tokens: 50_000, output_tokens: 500, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 10_000 }
  const line1 = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-15T11:59:05.000Z',
    message: { id: 'msg_1', model: 'claude-fable-5', usage, content: [{ type: 'text', text: 'thinking' }] },
  })
  const line2 = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-15T11:59:06.000Z',
    message: { id: 'msg_1', model: 'claude-fable-5', usage, content: [{ type: 'tool_use', name: 'Read' }] },
  })
  const status = deriveLiveSessionStatus([userLine, line1, line2], NOW)
  // one bar for the response; tool=true because a later line of the same id used a
  // tool; input=260k (the response's cost), not 520k — the two lines don't double-count
  assert.deepEqual(status.recentTurns, [{ output: 500, input: 260_000, tool: true }])
})

test('sessionStart is carried straight through onto the status', () => {
  const status = deriveLiveSessionStatus([userLine, assistantLine], NOW, '2026-06-15T11:58:00.000Z')
  assert.equal(status.sessionStart, '2026-06-15T11:58:00.000Z')
})

test('context limit follows the session model — a [1m] session reads ~1M, not 200k', () => {
  const longCtxLine = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-15T11:59:30.000Z',
    message: {
      model: 'claude-opus-4-8[1m]',
      usage: { input_tokens: 300_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
    },
  })
  const status = deriveLiveSessionStatus([userLine, longCtxLine], NOW)
  assert.equal(status.contextTokens, 340_000)
  assert.equal(status.contextLimit, 1_000_000)
  assert.equal(status.contextPct, 34) // 340k / 1M, not 100%+ against a 200k ceiling
})

test('firstTimestamp: scans past untimestamped preamble to the first real event', () => {
  const modeLine = JSON.stringify({ type: 'mode', mode: 'normal' })
  const snapshotLine = JSON.stringify({ type: 'file-history-snapshot', messageId: 'x' })
  assert.equal(firstTimestamp([modeLine, snapshotLine, userLine]), '2026-06-15T11:59:00.000Z')
  assert.equal(firstTimestamp([modeLine, snapshotLine]), undefined) // nothing timestamped yet
})

test('idle session: turn_duration after the last activity closes the turn', () => {
  const status = deriveLiveSessionStatus([userLine, assistantLine, stopHookLine([]), turnDurationLine], NOW)
  assert.equal(status.state, 'idle')
  assert.equal(status.latestHookErrorAt, undefined) // empty hookErrors is a clean stop
})

test('a new user message after a closed turn reopens the session as active', () => {
  const status = deriveLiveSessionStatus([assistantLine, turnDurationLine, userLine], NOW)
  assert.equal(status.state, 'active')
})

test('ended session: stale activity wins regardless of line content', () => {
  const staleNow = NOW + ACTIVE_WINDOW_MS + 1 // assistantLine is now just past the window
  const status = deriveLiveSessionStatus([userLine, assistantLine], staleNow)
  assert.equal(status.state, 'ended')
  assert.equal(status.lastActivityAt, '2026-06-15T11:59:30.000Z')
})

// The 2026-09-23 Rational case: a terminal left idle for two days, then closed.
// Claude Code appended timestamp-free bookkeeping on exit, the file's mtime
// became "this morning", the tail's open turn (an away recap, no turn close)
// graded `active`, and five minutes later the hub pinged "Session ended".
// Nothing without a timestamp may count as someone being here.
test('timestamp-free bookkeeping after a stale open turn does not revive the session', () => {
  const awayRecap = JSON.stringify({ type: 'system', subtype: 'away_summary', timestamp: '2026-06-15T12:02:00.000Z' })
  const bookkeeping = [
    JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'b1', lastSequenceNum: 4 }),
    JSON.stringify({ type: 'cost-state', totalCostUSD: 1.5 }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'x', leafUuid: 'u' }),
    JSON.stringify({ type: 'artifact-autoreact-ledger', entries: [] }),
  ]
  const twoDaysLater = NOW + 2 * 24 * 60 * 60 * 1000
  const status = deriveLiveSessionStatus([assistantLine, turnDurationLine, userLine, awayRecap, ...bookkeeping], twoDaysLater)
  assert.equal(status.state, 'ended')
  assert.equal(status.lastActivityAt, '2026-06-15T11:59:00.000Z', 'the user line, not the recap, is the last activity')
})

test('a tail with no timestamped activity at all is ended, never active', () => {
  const status = deriveLiveSessionStatus([JSON.stringify({ type: 'cost-state', totalCostUSD: 0 })], NOW)
  assert.equal(status.state, 'ended')
  assert.equal(status.lastActivityAt, undefined)
})

test('hook errors surface the failing stop_hook_summary timestamp', () => {
  const status = deriveLiveSessionStatus(
    [userLine, assistantLine, stopHookLine(['curate hook exploded']), turnDurationLine],
    NOW,
  )
  assert.equal(status.latestHookErrorAt, '2026-06-15T11:59:39.000Z')
})

test('partial trailing line is skipped without poisoning the rest', () => {
  const status = deriveLiveSessionStatus([userLine, assistantLine, '{"type":"system","subty'], NOW)
  assert.equal(status.state, 'active')
  assert.equal(status.lastToolName, 'Bash')
})

test('contextLimitFor: current models are 1M, Haiku is the 200K exception, else falls back', () => {
  assert.equal(contextLimitFor('claude-fable-5'), 1_000_000)
  assert.equal(contextLimitFor('claude-opus-4-8'), 1_000_000)
  assert.equal(contextLimitFor('claude-sonnet-5'), 1_000_000)
  assert.equal(contextLimitFor('claude-haiku-4-5-20251001'), 200_000)
  assert.equal(contextLimitFor('some-future-model'), DEFAULT_CONTEXT_LIMIT)
  assert.equal(contextLimitFor(undefined), DEFAULT_CONTEXT_LIMIT)
})

test('readJsonlTail: small file returns every line whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-core-'))
  const file = path.join(dir, 'small.jsonl')
  fs.writeFileSync(file, [userLine, assistantLine].join('\n') + '\n')
  const lines = readJsonlTail(file)
  assert.deepEqual(lines, [userLine, assistantLine])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('readJsonlHead: small file returns every line, first timestamp resolves the session start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-core-'))
  const file = path.join(dir, 'small.jsonl')
  const modeLine = JSON.stringify({ type: 'mode', mode: 'normal' })
  const snapshotLine = JSON.stringify({ type: 'file-history-snapshot', messageId: 'x' })
  fs.writeFileSync(file, [modeLine, snapshotLine, userLine, assistantLine].join('\n') + '\n')
  const head = readJsonlHead(file)
  assert.deepEqual(head, [modeLine, snapshotLine, userLine, assistantLine])
  assert.equal(firstTimestamp(head), '2026-06-15T11:59:00.000Z')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('readJsonlHead: reads only the head of a large file and drops the trailing partial line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-core-'))
  const file = path.join(dir, 'large.jsonl')
  // First real line is timestamped; a large tail of filler follows it.
  const filler = JSON.stringify({ type: 'user', pad: 'x'.repeat(1000) })
  const all = [userLine, ...Array.from({ length: 200 }, () => filler)] // ~200KB, past the 64KB head
  fs.writeFileSync(file, all.join('\n') + '\n')
  const head = readJsonlHead(file)
  assert.ok(head.length < all.length) // didn't read the whole file
  for (const line of head) assert.doesNotThrow(() => JSON.parse(line)) // trailing partial dropped
  assert.equal(firstTimestamp(head), '2026-06-15T11:59:00.000Z')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('readJsonlTail: reads only the tail of a large file and drops the first partial line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-core-'))
  const file = path.join(dir, 'large.jsonl')
  const filler = JSON.stringify({ type: 'user', pad: 'x'.repeat(1000) })
  // Sized off the constant so bumping TAIL_BYTES can't quietly make the
  // fixture fit inside the tail and void the "didn't read it all" assertion.
  const count = Math.ceil(TAIL_BYTES / (filler.length + 1)) + 50
  const all = Array.from({ length: count }, () => filler)
  all.push(assistantLine)
  fs.writeFileSync(file, all.join('\n') + '\n')
  const lines = readJsonlTail(file)
  assert.ok(lines.length < all.length)
  // Every returned line parses — the mid-line read start was dropped.
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
  assert.equal(lines[lines.length - 1], assistantLine)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('readActivityTail: reaches past request blobs to the prompt, so a running turn reads as active', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-core-'))
  const file = path.join(dir, 'blobs.jsonl')
  // Measured shape (Claude Code 2.1.302): the prompt, then ~400KB of
  // api-request-blob lines, and no reply yet.
  const prompt = JSON.stringify({ type: 'user', timestamp: new Date(NOW - 10_000).toISOString(), message: { role: 'user', content: 'go' } })
  const blob = JSON.stringify({ type: 'api-request-blob', content: [{ type: 'text', text: 'x'.repeat(100_000) }] })
  fs.writeFileSync(file, [prompt, blob, blob, blob, blob].join('\n') + '\n')
  // The fixed tail sees only blobs: the old reading called this session ended.
  assert.equal(deriveLiveSessionStatus(readJsonlTail(file), NOW).state, 'ended')
  assert.equal(deriveLiveSessionStatus(readActivityTail(file), NOW).state, 'active')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---- newest-file selection ----
// Needs the registry + a real session dir, so it redirects both roots the same
// way session-search.test.ts does. Kept last in the file: everything above is
// pure and must not inherit this environment.
test('live status ignores the hub own headless hook transcripts when picking the newest session', async () => {
  const { sanitize } = await import('./status.ts')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'live-home-'))
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.env.APP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'live-root-'))

  const project = { id: 'p1', name: 'alpha', path: 'C:\\proj\\alpha', addedAt: '2026-06-15T00:00:00.000Z' }
  fs.writeFileSync(path.join(process.env.APP_ROOT, 'registry.json'), JSON.stringify([project]))
  const dir = path.join(home, '.claude', 'projects', sanitize(project.path))
  fs.mkdirSync(dir, { recursive: true })

  // The real session: an assistant turn carrying model + usage.
  const realFile = path.join(dir, 'real-session.jsonl')
  fs.writeFileSync(realFile, [JSON.stringify({ ...JSON.parse(userLine), entrypoint: 'cli' }), assistantLine].join('\n') + '\n')

  // The hook's own run, written later — one huge prompt line, no assistant turns.
  const hookFile = path.join(dir, 'hook-run.jsonl')
  fs.writeFileSync(
    hookFile,
    JSON.stringify({
      type: 'user',
      entrypoint: 'sdk-cli',
      timestamp: '2026-06-15T11:59:50.000Z',
      message: { role: 'user', content: 'triage this transcript '.repeat(6000) },
    }) + '\n',
  )
  const older = new Date(Date.now() - 60_000)
  fs.utimesSync(realFile, older, older)

  const { computeStatuses } = await import('./live-core.ts')
  const status = computeStatuses().get('p1')
  assert.equal(status?.sessionId, 'real-session', 'the hook transcript must not stand in for the session')
  assert.equal(status?.status.model, 'claude-fable-5', 'model survives — this is what went blank in the hero')
  assert.equal(status?.status.contextTokens, 40_000)

  fs.rmSync(home, { recursive: true, force: true })
})

test('isHeadlessTranscript: only a found marker is remembered; "no marker yet" is re-read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-core-'))
  const file = path.join(dir, 'h.jsonl')
  const marked = (entrypoint: string) => JSON.stringify({ type: 'user', entrypoint, timestamp: '2026-06-15T11:59:50.000Z' })

  // Just created: metadata only, no entrypoint written yet.
  fs.writeFileSync(file, JSON.stringify({ type: 'mode', mode: 'default' }) + '\n')
  assert.equal(isHeadlessTranscript(file), false)
  fs.appendFileSync(file, marked('sdk-cli') + '\n')
  assert.equal(isHeadlessTranscript(file), true, 'the earlier inconclusive read must not stick as "real"')

  // The same path rewritten smaller is a different file, so it is read again.
  fs.writeFileSync(file, marked('cli') + '\n')
  assert.equal(isHeadlessTranscript(file), false)

  fs.rmSync(dir, { recursive: true, force: true })
})

// ---- which sweeps are worth interrupting you for ----
//
// These two rules lived in live.ts, which imports electron for Tray and
// Notification and so cannot be loaded outside it — they were the last
// unchecked decision in the live path. They differ on purpose: a turn ending
// is worth a ping only when the window is not already in front of you, while a
// hook failure always pings, because it is otherwise entirely silent.

const ACTIVE: LiveSessionStatus = { state: 'active', aiTitle: 'Fix the flux capacitor' }
const IDLE: LiveSessionStatus = { state: 'idle', aiTitle: 'Fix the flux capacitor' }

function statuses(status: LiveSessionStatus) {
  return new Map([['p1', { entry: { id: 'p1', name: 'claude-hub' }, status }]])
}

test('the first sweep never notifies, however much has happened', () => {
  assert.deepEqual(notificationsFor(null, statuses(IDLE), false), [], 'startup state is seeded silently')
})

test('a turn ending pings only when the window is not in front of you', () => {
  const prev = new Map([['p1', ACTIVE]])

  assert.deepEqual(notificationsFor(prev, statuses(IDLE), false), [
    { title: 'Session ended — claude-hub', body: 'Fix the flux capacitor' },
  ])
  assert.deepEqual(notificationsFor(prev, statuses(IDLE), true), [], 'you are already looking at it')
})

test('a session that was already idle is not an ending', () => {
  assert.deepEqual(notificationsFor(new Map([['p1', IDLE]]), statuses(IDLE), false), [])
})

// The asymmetric one. A hook that fails leaves nothing on screen anywhere, so
// this fires even while you are looking straight at the window.
test('a new hook failure always pings, focused or not', () => {
  const prev = new Map([['p1', ACTIVE]])
  const failed: LiveSessionStatus = { ...ACTIVE, latestHookErrorAt: '2026-06-15T11:59:39.000Z' }

  const focused = notificationsFor(prev, statuses(failed), true)
  assert.deepEqual(focused, [{ title: 'Hook failed in claude-hub', body: 'Fix the flux capacitor' }])
})

// The timestamp is the identity of the failure, not a boolean — without that,
// every 5s sweep would re-announce the same failed hook until it scrolled out
// of the tail.
test('the same hook failure is announced once, a later one again', () => {
  const failedAt = { ...ACTIVE, latestHookErrorAt: '2026-06-15T11:59:39.000Z' }
  const again = { ...ACTIVE, latestHookErrorAt: '2026-06-15T12:04:00.000Z' }

  assert.deepEqual(notificationsFor(new Map([['p1', failedAt]]), statuses(failedAt), true), [])
  assert.equal(notificationsFor(new Map([['p1', failedAt]]), statuses(again), true).length, 1)
})

// ---- 'waiting': an open turn blocked on you --------------------------------
//
// Measured 2026-11-02 over 109 real sessions: every open turn that went quiet
// past 5 minutes sat on an unanswered tool call, and each read 'ended' while
// still holding its reader. That re-enabled Resume on a live session.

const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const prompt = (ms: number) => JSON.stringify({ type: 'user', timestamp: ago(ms), message: { role: 'user', content: 'go' } })
const toolCall = (ms: number, name: string, input: Record<string, unknown> = {}, id = 'tu1') =>
  JSON.stringify({ type: 'assistant', timestamp: ago(ms), message: { content: [{ type: 'tool_use', id, name, input }] } })
const toolResult = (ms: number, id = 'tu1') =>
  JSON.stringify({ type: 'user', timestamp: ago(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const closeAt = (ms: number) => JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: ago(ms) })
const running = (status: 'busy' | 'idle' | 'waiting', waitingFor: string | null = null) => ({ kind: 'running' as const, status, waitingFor })

test("Claude Code's record saying 'waiting' makes an open turn waiting, however long it has been quiet", () => {
  const s = deriveLiveSessionStatus([prompt(61 * MIN), toolCall(60 * MIN, 'Bash', { command: 'ls' })], NOW, undefined, running('waiting', 'approve Bash: ls'))
  assert.deepEqual([s.state, s.waitingFor], ['waiting', 'approve Bash: ls'])
})

test("a 'waiting' record over a closed turn is not a waiting turn (a dialog opened at the prompt)", () => {
  const s = deriveLiveSessionStatus([prompt(2 * MIN), closeAt(MIN)], NOW, undefined, running('waiting', 'dialog open'))
  assert.equal(s.state, 'idle')
  assert.equal(s.waitingFor, undefined)
})

test("a 'busy' record keeps a 40-minute build active past the 5-minute window", () => {
  const lines = [prompt(41 * MIN), toolCall(40 * MIN, 'Bash', { command: 'npm run build', timeout: 3_000_000 })]
  assert.equal(deriveLiveSessionStatus(lines, NOW, undefined, running('busy')).state, 'active')
})

test('no live process: an unanswered question is not waiting on anyone', () => {
  const lines = [prompt(11 * MIN), toolCall(10 * MIN, 'AskUserQuestion')]
  assert.equal(deriveLiveSessionStatus(lines, NOW, undefined, { kind: 'none' }).state, 'ended')
})

test('records unreadable: an unanswered AskUserQuestion is waiting at once, and says the claim is inferred', () => {
  const s = deriveLiveSessionStatus([prompt(2 * MIN), toolCall(MIN, 'AskUserQuestion')], NOW, undefined, { kind: 'unreadable' })
  assert.equal(s.state, 'waiting')
  assert.match(s.waitingFor ?? '', /from the transcript/)
})

test("records unreadable: a shell command is active inside its own timeout, then waiting (a permission prompt)", () => {
  const lines = (quiet: number) => [prompt(quiet + MIN), toolCall(quiet, 'Bash', { command: 'make', timeout: 600_000 })]
  // 10-minute timeout + the 5-minute window = still plausibly running at 14 minutes.
  assert.equal(deriveLiveSessionStatus(lines(14 * MIN), NOW).state, 'active')
  assert.equal(deriveLiveSessionStatus(lines(16 * MIN), NOW).state, 'waiting')
  // No timeout given: the shell default (2 minutes) applies.
  const bare = [prompt(9 * MIN), toolCall(8 * MIN, 'PowerShell', { command: 'ls' })]
  assert.equal(deriveLiveSessionStatus(bare, NOW).state, 'waiting')
})

test('records unreadable: an answered tool call is not pending, and the fallback gives up after 24 hours', () => {
  const answered = [prompt(12 * MIN), toolCall(11 * MIN, 'AskUserQuestion'), toolResult(10 * MIN)]
  assert.equal(deriveLiveSessionStatus(answered, NOW).state, 'ended')
  const stale = [prompt(25 * 60 * MIN), toolCall(25 * 60 * MIN, 'AskUserQuestion')]
  assert.equal(deriveLiveSessionStatus(stale, NOW).state, 'ended')
  // A closed turn clears whatever it left unanswered.
  const closed = [prompt(12 * MIN), toolCall(11 * MIN, 'AskUserQuestion', {}, 'tu9'), closeAt(10 * MIN)]
  assert.equal(deriveLiveSessionStatus(closed, NOW).state, 'ended')
})

test('sessionProcessLookup: a live record is running, a missing one none, a partial read proves nothing', () => {
  const proc = { pid: 1, sessionId: 's1', cwd: 'C:/x', name: '', procStart: null, interactive: true, status: 'waiting' as const, waitingFor: 'input needed', updatedAtIso: null }
  const ok = sessionProcessLookup({ ok: true, processes: [proc], error: null })
  assert.deepEqual(ok('s1'), { kind: 'running', status: 'waiting', waitingFor: 'input needed' })
  assert.deepEqual(ok('s2'), { kind: 'none' })
  assert.deepEqual(sessionProcessLookup({ ok: true, processes: [proc], error: '1 record unreadable' })('s2'), { kind: 'unreadable' })
  assert.deepEqual(sessionProcessLookup({ ok: false, error: 'no dir' })('s1'), { kind: 'unreadable' })
})

const WAITING: LiveSessionStatus = { state: 'waiting', aiTitle: 'Fix the flux capacitor', waitingFor: 'approve Bash: rm -rf build' }
const withSession = (status: LiveSessionStatus, sessionId = 'sess-1') =>
  new Map([['p1', { entry: { id: 'p1', name: 'claude-hub' }, status, sessionId }]])

test('a turn coming to wait on you pings "needs you", not "Session ended"', () => {
  assert.deepEqual(notificationsFor(new Map([['p1', ACTIVE]]), withSession(WAITING), false), [
    { title: 'claude-hub needs you', body: 'approve Bash: rm -rf build' },
  ])
  assert.deepEqual(notificationsFor(new Map([['p1', ACTIVE]]), withSession(WAITING), true), [], 'you are already looking at it')
  assert.deepEqual(notificationsFor(new Map([['p1', WAITING]]), withSession(WAITING), false), [], 'announced once')
})

test('a Desktop-run session is left to the Desktop, which sends its own "needs you"', () => {
  assert.deepEqual(notificationsFor(new Map([['p1', ACTIVE]]), withSession(WAITING), false, new Set(['sess-1'])), [])
})

test('a waiting turn that then ends is a turn ending', () => {
  assert.equal(notificationsFor(new Map([['p1', WAITING]]), withSession(IDLE), false)[0]?.title, 'Session ended — claude-hub')
})

test('a compaction summary, the /clear caveat and a local command are not activity', () => {
  const idleAfter = (line: Record<string, unknown>) =>
    deriveLiveSessionStatus([prompt(3 * MIN), closeAt(2 * MIN), JSON.stringify({ type: 'user', timestamp: ago(MIN), ...line })], NOW)
  assert.equal(idleAfter({ isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } }).state, 'idle')
  assert.equal(idleAfter({ isMeta: true, message: { role: 'user', content: '<local-command-caveat>…' } }).state, 'idle')
  assert.equal(idleAfter({ message: { role: 'user', content: '<command-name>/model</command-name>' } }).state, 'idle')
  assert.equal(idleAfter({ message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } }).state, 'idle')
  // A real prompt after the close still opens a turn.
  assert.equal(idleAfter({ message: { role: 'user', content: 'now do the next thing' } }).state, 'active')
})
