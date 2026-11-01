import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitize } from './status.ts'
import { listSubagents, listSubagentTranscripts, readSubagent } from './subagents.ts'

// Same pattern as session-search.test.ts: redirect the home directory at a
// tmpdir before anything calls os.homedir(). No registry needed —
// findSessionFiles never touches it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-subagents-home-'))
process.env.USERPROFILE = home // os.homedir() on Windows
process.env.HOME = home // ...and everywhere else

const PROJECT_PATH = 'C:\\proj\\alpha'
const sessionDir = path.join(home, '.claude', 'projects', sanitize(PROJECT_PATH))
const subRoot = path.join(sessionDir, 's-1', 'subagents')
const wfDir = path.join(subRoot, 'workflows', 'wf_x')
fs.mkdirSync(wfDir, { recursive: true })

const sideLine = (role: string, text: string, ts: string) =>
  JSON.stringify({ isSidechain: true, message: { role, content: [{ type: 'text', text }] }, timestamp: ts })

fs.writeFileSync(
  path.join(sessionDir, 's-1.jsonl'),
  JSON.stringify({ message: { role: 'user', content: 'main' }, entrypoint: 'cli' }) + '\n',
)
// aaa: the normal case — transcript + meta, flat under subagents/.
fs.writeFileSync(
  path.join(subRoot, 'agent-aaa.jsonl'),
  [sideLine('user', 'do the slice', '2026-08-14T10:01:00.000Z'), sideLine('assistant', 'slice done', '2026-08-14T10:03:00.000Z')].join(
    '\n',
  ) + '\n',
)
fs.writeFileSync(
  path.join(subRoot, 'agent-aaa.meta.json'),
  JSON.stringify({ agentType: 'general-purpose', description: 'Finish the slice', toolUseId: 't1', spawnDepth: 1 }),
)
// bbb: nested workflow agent with a worktree, beside a journal.jsonl noise file.
fs.writeFileSync(path.join(wfDir, 'agent-bbb.jsonl'), sideLine('user', 'review dimension', '2026-08-14T10:02:00.000Z') + '\n')
fs.writeFileSync(
  path.join(wfDir, 'agent-bbb.meta.json'),
  JSON.stringify({ agentType: 'workflow-subagent', description: 'Review: bugs', toolUseId: 't2', spawnDepth: 2, worktreeBranch: 'worktree-agent-bbb' }),
)
fs.writeFileSync(path.join(wfDir, 'journal.jsonl'), JSON.stringify({ step: 1 }) + '\n')
// ccc: meta-only (killed / never ran).
fs.writeFileSync(
  path.join(subRoot, 'agent-ccc.meta.json'),
  JSON.stringify({ agentType: 'Explore', description: 'Killed early', toolUseId: 't3', spawnDepth: 1 }),
)
// ddd: transcript with no meta at all.
fs.writeFileSync(path.join(subRoot, 'agent-ddd.jsonl'), sideLine('assistant', 'orphan', '2026-08-14T10:05:00.000Z') + '\n')
// eee: transcript with a malformed meta.
fs.writeFileSync(path.join(subRoot, 'agent-eee.jsonl'), sideLine('user', 'x', '2026-08-14T10:06:00.000Z') + '\n')
fs.writeFileSync(path.join(subRoot, 'agent-eee.meta.json'), '{not json')
// fff: the workflow shape — a meta with no description field at all, so the
// row can only be told apart by the first line of the agent's own prompt.
const LONG_PROMPT = `Review the ${'diff '.repeat(40)}closely`
fs.writeFileSync(
  path.join(subRoot, 'agent-fff.jsonl'),
  sideLine('user', `${LONG_PROMPT}\nsecond line`, '2026-08-14T10:07:00.000Z') + '\n',
)
fs.writeFileSync(
  path.join(subRoot, 'agent-fff.meta.json'),
  JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }),
)

test('listSubagents: nested agents found, journal ignored, launch order, meta-only last', async () => {
  const agents = await listSubagents(PROJECT_PATH, 's-1')
  assert.deepEqual(
    agents.map((a) => a.id),
    ['aaa', 'bbb', 'ddd', 'eee', 'fff', 'ccc'],
  )

  const aaa = agents[0]
  assert.equal(aaa.agentType, 'general-purpose')
  assert.equal(aaa.description, 'Finish the slice')
  assert.equal(aaa.spawnDepth, 1)
  assert.equal(aaa.startedAt, '2026-08-14T10:01:00.000Z')
  assert.ok(aaa.endedAt, 'transcript mtime becomes endedAt')
  assert.equal(aaa.hasTranscript, true)

  const ccc = agents[5]
  assert.equal(ccc.agentType, 'Explore')
  assert.equal(ccc.hasTranscript, false)
  assert.equal(ccc.startedAt, null)
  assert.equal(ccc.endedAt, null)
})

test('listSubagents: missing and malformed metas fall back to defaults', async () => {
  const agents = await listSubagents(PROJECT_PATH, 's-1')
  for (const id of ['ddd', 'eee']) {
    const agent = agents.find((a) => a.id === id)!
    assert.equal(agent.agentType, 'unknown')
    assert.equal(agent.spawnDepth, 1)
    assert.equal(agent.hasTranscript, true)
    assert.ok(agent.startedAt)
  }
})

test('listSubagents: a description-less meta falls back to the first line of the prompt', async () => {
  const agents = await listSubagents(PROJECT_PATH, 's-1')
  const fff = agents.find((a) => a.id === 'fff')!
  assert.equal(fff.agentType, 'workflow-subagent')
  assert.ok(fff.description.startsWith('Review the diff'), 'takes the prompt as its description')
  assert.ok(!fff.description.includes('second line'), 'first line only')
  assert.ok(fff.description.length <= 120, `truncated, got ${fff.description.length}`)
  assert.ok(fff.description.endsWith('…'), 'truncation is marked')

  // A meta that HAS a description keeps it; a head with no user turn has no
  // prompt to borrow, so it stays empty rather than inventing one.
  assert.equal(agents.find((a) => a.id === 'aaa')?.description, 'Finish the slice')
  assert.equal(agents.find((a) => a.id === 'ddd')?.description, '')
})

test('listSubagents: worktreeBranch surfaced only where the meta has one', async () => {
  const agents = await listSubagents(PROJECT_PATH, 's-1')
  assert.equal(agents.find((a) => a.id === 'bbb')?.worktreeBranch, 'worktree-agent-bbb')
  assert.equal(agents.find((a) => a.id === 'aaa')?.worktreeBranch, undefined)
})

test('hostile or unknown session ids yield empty results, never a path probe', async () => {
  for (const sessionId of ['..', 'a/b', 's-1/../s-1', 'no-such-session']) {
    assert.deepEqual(await listSubagents(PROJECT_PATH, sessionId), [])
    assert.deepEqual(await readSubagent(PROJECT_PATH, sessionId, 'aaa'), [])
  }
})

test('readSubagent returns the sidechain turns of the matched agent', async () => {
  const messages = await readSubagent(PROJECT_PATH, 's-1', 'aaa')
  assert.deepEqual(
    messages.map((m) => ({ role: m.role, text: m.text })),
    [
      { role: 'user', text: 'do the slice' },
      { role: 'assistant', text: 'slice done' },
    ],
  )
  assert.equal(messages[0].timestamp, '2026-08-14T10:01:00.000Z')
})

test('readSubagent: hostile/unknown agent ids and meta-only agents yield []', async () => {
  for (const agentId of ['..', '../agent-aaa', 'zzz', 'ccc']) {
    assert.deepEqual(await readSubagent(PROJECT_PATH, 's-1', agentId), [])
  }
})

test('listSubagentTranscripts finds nested agent transcripts and skips journals', () => {
  const found = listSubagentTranscripts(path.join(sessionDir, 's-1.jsonl'))
  assert.deepEqual(
    found.map((p) => path.basename(p)).sort(),
    ['agent-aaa.jsonl', 'agent-bbb.jsonl', 'agent-ddd.jsonl', 'agent-eee.jsonl', 'agent-fff.jsonl'],
  )
})
