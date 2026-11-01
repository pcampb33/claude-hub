import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitize } from './status.ts'
import { listAllSessions, SESSION_LIST_LIMIT } from './session-list-core.ts'

// listAllSessions reaches two roots: APP_ROOT (registry.json) and the home
// directory (~/.claude/projects). Both are redirected at tmpdirs here.
// `node --test` runs each file in its own process, so mutating the home env
// var cannot leak into another suite. Writing registry.json up front also
// keeps registry.ts from SEEDING one — seeding would `git init` a real
// sandbox directory outside the tmpdir.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-slc-home-'))
process.env.USERPROFILE = home // os.homedir() on Windows
process.env.HOME = home // ...and everywhere else
process.env.APP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-slc-root-'))

const PROJECT = { id: 'proj-alpha', name: 'alpha', path: 'C:\\proj\\alpha', addedAt: '2026-07-19T00:00:00.000Z' }
fs.writeFileSync(path.join(process.env.APP_ROOT, 'registry.json'), JSON.stringify([PROJECT]))

const sessionDir = path.join(home, '.claude', 'projects', sanitize(PROJECT.path))
fs.mkdirSync(sessionDir, { recursive: true })

// Line timestamps decide active/idle vs ended (ACTIVE_WINDOW_MS is 5 minutes),
// so each fixture line is stamped `ageMs` before now.
const at = (ageMs: number) => new Date(Date.now() - ageMs).toISOString()
const userLine = (entrypoint: string, ageMs = 1000) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'do a thing' }, entrypoint, timestamp: at(ageMs) })
const assistantLine = (ageMs = 1000) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'working on it' }],
      usage: { input_tokens: 50_000 },
    },
    timestamp: at(ageMs),
  })
const turnClose = (ageMs = 1000) => JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: at(ageMs) })
const HOUR = 60 * 60 * 1000

// `ageMs` back-dates the file's mtime — which only orders the list; it no
// longer decides liveness (exit bookkeeping rewrites it days after the turn).
function writeSession(id: string, lines: string[], ageMs: number): void {
  const file = path.join(sessionDir, `${id}.jsonl`)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(file, when, when)
}

test('listAllSessions reports per-session state, title and model across projects', async () => {
  writeSession('11111111-0000-0000-0000-000000000001', [userLine('cli'), assistantLine()], 1000)
  writeSession(
    '11111111-0000-0000-0000-000000000002',
    [JSON.stringify({ type: 'ai-title', aiTitle: 'Titled by Claude' }), userLine('cli'), assistantLine(), turnClose()],
    2000,
  )
  writeSession('11111111-0000-0000-0000-000000000003', [userLine('cli', HOUR), assistantLine(HOUR)], HOUR)

  const entries = await listAllSessions()
  const byId = new Map(entries.map((e) => [e.sessionId, e]))

  // Newest-first, and every entry carries its project's registry identity.
  assert.deepEqual(
    entries.map((e) => e.sessionId.slice(-1)),
    ['1', '2', '3'],
  )
  assert.equal(entries[0].projectId, 'proj-alpha')
  assert.equal(entries[0].projectName, 'alpha')

  // A turn that never closed is 'active'; one closed by turn_duration is
  // 'idle'; stale activity is 'ended' regardless of how it ended.
  assert.equal(byId.get('11111111-0000-0000-0000-000000000001')!.state, 'active')
  assert.equal(byId.get('11111111-0000-0000-0000-000000000002')!.state, 'idle')
  assert.equal(byId.get('11111111-0000-0000-0000-000000000003')!.state, 'ended')

  // An ai-title line wins over the first user message.
  assert.equal(byId.get('11111111-0000-0000-0000-000000000002')!.title, 'Titled by Claude')
  assert.equal(byId.get('11111111-0000-0000-0000-000000000001')!.title, 'do a thing')
  assert.equal(byId.get('11111111-0000-0000-0000-000000000001')!.model, 'claude-opus-4-8')
})

test('listAllSessions hides headless hook runs', async () => {
  const headless = '22222222-0000-0000-0000-00000000000a'
  writeSession(headless, [userLine('sdk-cli'), assistantLine()], 1000)

  const ids = (await listAllSessions()).map((e) => e.sessionId)
  assert.ok(!ids.includes(headless), 'headless hook transcript must stay out of the list')
})

test('listAllSessions caps the list at SESSION_LIST_LIMIT', async () => {
  for (let i = 0; i < SESSION_LIST_LIMIT + 5; i++) {
    writeSession(`33333333-0000-0000-0000-${String(i).padStart(12, '0')}`, [userLine('cli'), assistantLine()], 1000)
  }
  const entries = await listAllSessions()
  assert.equal(entries.length, SESSION_LIST_LIMIT)
})

// A flood of newer headless hook transcripts must not starve the list: it used
// to stop testing after 200 files and return whatever real sessions it had.
test('listAllSessions fills its window past any number of newer headless runs', async () => {
  const real = '55555555-0000-0000-0000-000000000001'
  // mtime order: 250 headless (200ms) → this one (500ms) → the earlier tests'
  // real sessions (1000ms+), so only a walk past 250 files reaches it first.
  writeSession(real, [userLine('cli'), assistantLine()], 500)
  for (let i = 0; i < 250; i++) {
    writeSession(`55555555-1111-0000-0000-${String(i).padStart(12, '0')}`, [userLine('sdk-cli'), assistantLine()], 200)
  }
  const ids = (await listAllSessions()).map((e) => e.sessionId)
  assert.ok(ids.includes(real), 'a real session behind 250 headless runs must still be listed')
})

// Closing an idle terminal appends timestamp-free bookkeeping, which makes the
// file the newest on disk. The list may sort it first, but it must neither
// call it live nor date it today.
test('listAllSessions dates and grades a session by its last turn, not by exit bookkeeping', async () => {
  const id = '44444444-0000-0000-0000-000000000001'
  const bookkeeping = [
    JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'b1' }),
    JSON.stringify({ type: 'cost-state', totalCostUSD: 2 }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'x' }),
  ]
  // An open turn (no turn_duration) from an hour ago, then today's exit write.
  writeSession(id, [userLine('cli', HOUR), assistantLine(HOUR), userLine('cli', HOUR), ...bookkeeping], 0)
  const entry = (await listAllSessions()).find((e) => e.sessionId === id)!
  assert.equal(entry.state, 'ended')
  assert.ok(Date.now() - Date.parse(entry.date) > HOUR - 5000, `date must be the hour-old turn, got ${entry.date}`)
})
