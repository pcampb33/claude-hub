import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitize } from './status.ts'
import { searchSessions } from './session-search.ts'
import type { SessionSearchCursor } from '../shared/ipc-types'

// Same two roots as session-list-core.test.ts: APP_ROOT (registry.json) and the
// home directory (~/.claude/projects), both redirected at tmpdirs. Writing
// registry.json up front keeps registry.ts from SEEDING one (seeding would
// `git init` a real sandbox directory outside the tmpdir).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ss-home-'))
process.env.USERPROFILE = home // os.homedir() on Windows
process.env.HOME = home // ...and everywhere else
process.env.APP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ss-root-'))

const PROJECT = { id: 'proj-alpha', name: 'alpha', path: 'C:\\proj\\alpha', addedAt: '2026-07-19T00:00:00.000Z' }
fs.writeFileSync(path.join(process.env.APP_ROOT, 'registry.json'), JSON.stringify([PROJECT]))

const sessionDir = path.join(home, '.claude', 'projects', sanitize(PROJECT.path))
fs.mkdirSync(sessionDir, { recursive: true })

const userLine = (entrypoint: string, content: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, entrypoint, timestamp: '2026-07-19T09:00:00.000Z' })

function writeSession(id: string, lines: string[]): void {
  fs.writeFileSync(path.join(sessionDir, `${id}.jsonl`), lines.join('\n') + '\n')
}

test('searchSessions skips headless hook transcripts', async () => {
  const real = '33333333-0000-0000-0000-000000000001'
  const headless = '33333333-0000-0000-0000-00000000000a'

  // Both contain the query term. The hook's transcripts are the ones that
  // dominated common-term results before the filter existed.
  writeSession(real, [userLine('cli', 'debug the linker sweep')])
  writeSession(headless, [userLine('sdk-cli', 'triage this transcript for the linker')])

  const result = await searchSessions('linker')
  const ids = result.matches.map((m) => m.sessionId)

  assert.ok(ids.includes(real), 'a real interactive session must be searchable')
  assert.ok(!ids.includes(headless), 'a headless hook transcript must not appear in results')

  // The "across N sessions" count reports sessions actually searched, so the
  // skipped hook transcript must not inflate it.
  assert.equal(result.scannedSessionCount, 1)
})

// Titles are readSessionTitle's job, so search must inherit its exclusions
// rather than titling a hit with the slash-command markup or the isMeta
// local-command caveat that precede the human's actual first message.
test('searchSessions titles a hit with the real prompt, not command-wrapper turns', async () => {
  const id = '44444444-0000-0000-0000-000000000001'
  writeSession(id, [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<local-command-caveat>Caveat: the messages below were generated…' },
      isMeta: true,
      entrypoint: 'cli',
    }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, entrypoint: 'cli' }),
    userLine('cli', 'rewrite the fixture loader'),
  ])

  const match = (await searchSessions('fixture')).matches.find((m) => m.sessionId === id)
  assert.ok(match, 'the session must be found')
  assert.equal(match.title, 'rewrite the fixture loader')
})

test('searchSessions prefers an ai-title line, matching the session list', async () => {
  const id = '44444444-0000-0000-0000-000000000002'
  writeSession(id, [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fixture loader rewrite' }),
    userLine('cli', 'rewrite the fixture loader'),
  ])

  const match = (await searchSessions('fixture')).matches.find((m) => m.sessionId === id)
  assert.ok(match, 'the session must be found')
  assert.equal(match.title, 'Fixture loader rewrite')
})

test('searchSessions ignores queries under the minimum length', async () => {
  const result = await searchSessions('li')
  assert.deepEqual(result.matches, [])
  assert.equal(result.scannedSessionCount, 0)
})

// ---- subagent transcripts ----

// Agents live at <sessionDir>/<sessionId>/subagents/**, and every line they
// write carries isSidechain — the two reasons they were invisible to search.
function writeAgent(sessionId: string, agentId: string, opts: { content: string; meta?: object; nested?: boolean }) {
  const dir = path.join(sessionDir, sessionId, 'subagents', opts.nested ? path.join('workflows', 'wf_x') : '')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `agent-${agentId}.jsonl`),
    JSON.stringify({
      type: 'user',
      message: { role: 'assistant', content: opts.content },
      isSidechain: true,
      timestamp: '2026-07-19T09:30:00.000Z',
    }) + '\n',
  )
  if (opts.meta) fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(opts.meta))
}

test('searchSessions finds a hit inside a subagent transcript and labels it', async () => {
  const id = '55555555-0000-0000-0000-000000000001'
  writeSession(id, [userLine('cli', 'kick off the sweep')])
  writeAgent(id, 'aaa', {
    content: 'the parser mishandles a trailing sentinel byte',
    meta: { agentType: 'Explore', description: 'map the parser' },
  })

  const matches = (await searchSessions('sentinel')).matches.filter((m) => m.sessionId === id)
  assert.equal(matches.length, 1)
  assert.deepEqual(matches[0].agent, { id: 'aaa', agentType: 'Explore', description: 'map the parser' })
  // The parent session still identifies where the agent ran.
  assert.equal(matches[0].title, 'kick off the sweep')
  assert.match(matches[0].snippet, /sentinel/)
})

test('searchSessions finds nested workflow agents and defaults a missing meta', async () => {
  const id = '55555555-0000-0000-0000-000000000002'
  writeSession(id, [userLine('cli', 'run the workflow')])
  writeAgent(id, 'bbb', { content: 'quokka census complete', nested: true })

  const matches = (await searchSessions('quokka')).matches.filter((m) => m.sessionId === id)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].agent?.agentType, 'unknown')
  assert.equal(matches[0].agent?.description, '')
})

test('searchSessions returns the session and its agents as separate rows', async () => {
  const id = '55555555-0000-0000-0000-000000000003'
  writeSession(id, [userLine('cli', 'investigate the wombat regression')])
  writeAgent(id, 'ccc', { content: 'wombat reproduced under load', meta: { agentType: 'general-purpose' } })

  const matches = (await searchSessions('wombat')).matches.filter((m) => m.sessionId === id)
  assert.equal(matches.length, 2)
  assert.equal(matches.filter((m) => !m.agent).length, 1, 'the session itself')
  assert.equal(matches.filter((m) => m.agent).length, 1, 'and the agent')
})

test('searchSessions caps how many agents one session contributes', async () => {
  const id = '55555555-0000-0000-0000-000000000004'
  writeSession(id, [userLine('cli', 'a large fan-out')])
  for (let i = 0; i < 9; i++) {
    writeAgent(id, `fan${i}`, { content: 'narwhal sighted', meta: { agentType: 'general-purpose' } })
  }

  const matches = (await searchSessions('narwhal')).matches.filter((m) => m.sessionId === id)
  // Without the cap a single fan-out fills the global result cap by itself.
  assert.equal(matches.length, 3)
  assert.ok(
    matches.every((m) => m.agent),
    'all three come from agents — the session text itself does not match',
  )
})

// ---- recency budget ----

// The scan is I/O bound over ~1.3GB of transcript here, so it walks newest-first
// and stops at a byte ceiling. These fixtures get explicit future mtimes so they
// sort ahead of every other session this file writes, whose mtimes are "now".
function writeAgedSession(id: string, content: string, mtimeMs: number): void {
  const file = path.join(sessionDir, `${id}.jsonl`)
  fs.writeFileSync(file, userLine('cli', content) + '\n')
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
}

const BUDGET_IDS = Array.from({ length: 8 }, (_, i) => `66666666-0000-0000-0000-00000000000${i}`)

// Written per-test, not at module scope: the tests above assert exact scanned
// counts over whatever exists at that moment, and eight extra sessions present
// from the first line of the file would break them.
function seedBudgetFixtures(): void {
  // Descending age: index 0 is newest, index 7 oldest.
  BUDGET_IDS.forEach((id, i) => writeAgedSession(id, `axolotl run ${i}`, Date.now() + (8 - i) * 3_600_000))
}

test('searchSessions spends a small budget on the newest sessions and says what it skipped', async () => {
  seedBudgetFixtures()
  // One byte of budget: the first batch (CONCURRENT_FILE_SCANS = 6) still runs
  // in full — the check is between batches — and the walk stops after it.
  const result = await searchSessions('axolotl', undefined, { budgetBytes: 1 })
  const found = result.matches.map((m) => m.sessionId)

  assert.deepEqual(found.sort(), BUDGET_IDS.slice(0, 6).sort(), 'the six newest, not whichever the registry listed first')
  assert.ok(result.unscannedSessionCount > 0, 'the sessions the budget never reached are counted')
  assert.equal(
    result.oldestScanned,
    new Date(fs.statSync(path.join(sessionDir, `${BUDGET_IDS[5]}.jsonl`)).mtimeMs).toISOString(),
    'oldestScanned is the mtime of the last transcript actually opened',
  )
})

// "Search everything" is this same budgeted call in a loop, so the cursor has
// to hand back exactly the sessions the previous chunk did not open — no gap
// (a missed session is the silent false-negative the whole design avoids) and
// no repeat (a duplicated row in the results).
test('searchSessions resumes from its cursor with no gap and no repeat', async () => {
  seedBudgetFixtures()
  const first = await searchSessions('axolotl', undefined, { budgetBytes: 1 })
  assert.ok(first.nextCursor, 'a walk that stopped early must say where to resume')

  const second = await searchSessions('axolotl', undefined, { budgetBytes: 1, startAfter: first.nextCursor })
  const found = [...first.matches, ...second.matches].map((m) => m.sessionId)

  assert.deepEqual(found.sort(), [...BUDGET_IDS].sort(), 'the two chunks together cover every session, once each')
  assert.ok(
    second.unscannedSessionCount < first.unscannedSessionCount,
    'each chunk leaves strictly less of the corpus unscanned',
  )
})

// The reason the cursor is (mtime, id) and not a bare mtime: transcripts
// written in the same millisecond are ordinary. With only an mtime to resume
// from, a chunk boundary landing inside a tie either re-serves the same files
// forever or steps over them.
test('searchSessions walks a corpus whose sessions share one mtime', async () => {
  const sameMs = Date.now() + 100 * 3_600_000
  BUDGET_IDS.forEach((id) => writeAgedSession(id, `wildebeest ${id}`, sameMs))

  const seen: string[] = []
  let cursor: SessionSearchCursor | null = null
  for (let chunk = 0; chunk < BUDGET_IDS.length + 2; chunk++) {
    const result = await searchSessions('wildebeest', undefined, {
      budgetBytes: 1,
      startAfter: cursor ?? undefined,
    })
    seen.push(...result.matches.map((m) => m.sessionId))
    cursor = result.nextCursor
    if (!cursor) break
  }

  assert.equal(cursor, null, 'the walk terminates rather than re-serving the tied files')
  assert.deepEqual(seen.sort(), [...BUDGET_IDS].sort(), 'each tied session is returned exactly once')
})

test('searchSessions still ignores sidechain lines in a session own transcript', async () => {
  const id = '55555555-0000-0000-0000-000000000005'
  writeSession(id, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'pangolin' }, isSidechain: true, entrypoint: 'cli' }),
    userLine('cli', 'unrelated opener'),
  ])

  const matches = (await searchSessions('pangolin')).matches.filter((m) => m.sessionId === id)
  assert.deepEqual(matches, [], 'opting sidechain in is per-file, not global')
})
