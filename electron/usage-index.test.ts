import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUsageIndexer } from './usage-index.ts'

// Responses land a few minutes before now; the queries cover the last 3 local
// days, so a run just after midnight still sees them.
const QUERY = { granularity: 'day' as const, periods: 3 }

let seq = 0
function response(o: { output: number; cwd: string; entrypoint?: string; id?: string; cacheRead?: number }): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
      cwd: o.cwd,
      entrypoint: o.entrypoint ?? 'cli',
      message: {
        id: o.id ?? `msg_${++seq}`,
        model: 'claude-opus',
        usage: { input_tokens: 0, output_tokens: o.output, cache_read_input_tokens: o.cacheRead ?? 0, cache_creation_input_tokens: 0 },
      },
    }) + '\n'
  )
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-index-'))
  const root = path.join(tmp, 'projects')
  const chug = path.join(tmp, 'work', 'chug')
  const sandbox = path.join(tmp, 'work', 'sandbox')
  const experiment = path.join(sandbox, 'Big Experiment')
  fs.mkdirSync(path.join(root, 'chug-dir'), { recursive: true })
  const indexPath = path.join(tmp, 'usage-index.json')
  const make = (titleOf?: (p: string) => Promise<string>) =>
    createUsageIndexer({
      root,
      indexPath,
      attribution: () => ({
        projects: [
          { id: 'chug', name: 'chug', path: chug },
          { id: 'sandbox', name: 'sandbox', path: sandbox },
        ],
        experiments: [experiment],
      }),
      titleOf: titleOf ?? (async () => 'A session'),
    })
  const file = (rel: string) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    return abs
  }
  return { tmp, root, chug, sandbox, experiment, indexPath, make, file }
}

test('usage index: appended lines are counted once; earlier lines are not recounted', async () => {
  const t = setup()
  const f = t.file('chug-dir/s1.jsonl')
  // More responses than the recent-id window, so a re-read from byte 0 can't
  // hide behind the duplicate-id check.
  fs.writeFileSync(f, Array.from({ length: 100 }, () => response({ output: 1, cwd: t.chug })).join(''))
  const ix = t.make()
  await ix.refresh(true)
  assert.equal((await ix.getUsage(QUERY)).totals['project:chug'].output, 100)
  fs.appendFileSync(f, response({ output: 5, cwd: t.chug }))
  await ix.refresh(true)
  const r = await ix.getUsage(QUERY)
  assert.equal(r.totals['project:chug'].output, 105)
  assert.equal(r.state, 'ready')
  assert.equal(r.coverage.filesIndexed, 1)
})

test('usage index: a response split across lines (same message.id) counts once, even across refreshes', async () => {
  const t = setup()
  const f = t.file('chug-dir/s1.jsonl')
  fs.writeFileSync(f, response({ id: 'm1', output: 16, cacheRead: 1000, cwd: t.chug }))
  const ix = t.make()
  await ix.refresh(true)
  fs.appendFileSync(f, response({ id: 'm1', output: 227, cacheRead: 1000, cwd: t.chug }))
  await ix.refresh(true)
  const v = (await ix.getUsage(QUERY)).totals['project:chug']
  assert.equal(v.output, 227)
  assert.equal(v.processed, 1227)
})

test('usage index: a half-written last line is read once it is complete', async () => {
  const t = setup()
  const f = t.file('chug-dir/s1.jsonl')
  const second = response({ output: 7, cwd: t.chug })
  fs.writeFileSync(f, response({ output: 1, cwd: t.chug }) + second.slice(0, 30))
  const ix = t.make()
  await ix.refresh(true)
  assert.equal((await ix.getUsage(QUERY)).totals['project:chug'].output, 1)
  fs.appendFileSync(f, second.slice(30))
  await ix.refresh(true)
  assert.equal((await ix.getUsage(QUERY)).totals['project:chug'].output, 8)
})

test('usage index: a file that shrank is re-indexed from scratch', async () => {
  const t = setup()
  const f = t.file('chug-dir/s1.jsonl')
  fs.writeFileSync(f, response({ output: 100, cwd: t.chug }) + response({ output: 100, cwd: t.chug }))
  const ix = t.make()
  await ix.refresh(true)
  fs.writeFileSync(f, response({ output: 3, cwd: t.chug }))
  await ix.refresh(true)
  assert.equal((await ix.getUsage(QUERY)).totals['project:chug'].output, 3)
})

test('usage index: subagents count toward the parent session; headless and experiment buckets', async () => {
  const t = setup()
  fs.writeFileSync(t.file('chug-dir/s1.jsonl'), response({ output: 10, cwd: t.chug }))
  fs.writeFileSync(t.file('chug-dir/s1/subagents/agent-a.jsonl'), response({ output: 4, cwd: path.join(t.tmp, 'some-worktree') }))
  fs.writeFileSync(t.file('chug-dir/s1/subagents/nested/agent-b.jsonl'), response({ output: 1, cwd: path.join(t.tmp, 'x') }))
  fs.writeFileSync(t.file('chug-dir/hook.jsonl'), response({ output: 2, cwd: t.chug, entrypoint: 'sdk-cli' }))
  fs.writeFileSync(t.file('exp-dir/e1.jsonl'), response({ output: 50, cwd: t.experiment }))
  fs.writeFileSync(t.file('sandbox-dir/x.jsonl'), response({ output: 6, cwd: t.sandbox }))
  const ix = t.make()
  await ix.refresh(true)
  const r = await ix.getUsage(QUERY)
  assert.equal(r.totals['project:chug'].output, 15)
  assert.equal(r.totals['project:chug'].sessions, 1)
  assert.equal(r.totals['headless'].output, 2)
  assert.equal(r.totals['experiment:Big Experiment'].output, 50)
  assert.equal(r.totals['project:sandbox'].output, 6)
  assert.equal(r.series[0].name, 'sandbox / Big Experiment')
  const day = r.buckets.reduce((n, b) => n + (b.values['project:chug']?.output ?? 0), 0)
  assert.equal(day, 15)
})

test('usage index: drill-down lists the sessions behind a key with titles', async () => {
  const t = setup()
  fs.writeFileSync(t.file('chug-dir/s1.jsonl'), response({ output: 10, cwd: t.chug }))
  fs.writeFileSync(t.file('chug-dir/s2.jsonl'), response({ output: 30, cwd: t.chug }))
  const ix = t.make(async (p) => `title of ${path.basename(p)} `.repeat(10))
  await ix.refresh(true)
  const start = new Date(Date.now() - 86_400_000).toISOString()
  const end = new Date(Date.now() + 60_000).toISOString()
  const r = await ix.getUsageSessions('project:chug', start, end)
  assert.equal(r.state, 'ready')
  assert.equal(r.total, 2)
  assert.deepEqual(
    r.sessions.map((s) => s.sessionId),
    ['s2', 's1'],
  )
  assert.ok(r.sessions[0].title.startsWith('title of s2.jsonl'))
  assert.ok(r.sessions[0].title.length <= 80)
  assert.equal(r.sessions[0].projectPath, t.chug)
})

test('usage index: a corrupt saved index is rebuilt, never served as zeros', async () => {
  const t = setup()
  fs.writeFileSync(t.file('chug-dir/s1.jsonl'), response({ output: 9, cwd: t.chug }))
  fs.writeFileSync(t.indexPath, '{"v":1,"files":{"trunc')
  const ix = t.make()
  await ix.refresh(true)
  assert.equal((await ix.getUsage(QUERY)).totals['project:chug'].output, 9)
  // And the rebuilt index persists for the next process.
  const again = t.make()
  const r = await again.getUsage(QUERY)
  assert.equal(r.totals['project:chug'].output, 9)
})

test('usage index: the saved index is reused incrementally by a new process', async () => {
  const t = setup()
  const f = t.file('chug-dir/s1.jsonl')
  fs.writeFileSync(f, response({ output: 10, cwd: t.chug }))
  await t.make().refresh(true)
  fs.appendFileSync(f, response({ output: 1, cwd: t.chug }))
  const next = t.make()
  await next.refresh(true)
  assert.equal((await next.getUsage(QUERY)).totals['project:chug'].output, 11)
})

test('usage index: a deleted transcript keeps its numbers (Claude Code prunes after 30 days)', async () => {
  const t = setup()
  const f = t.file('chug-dir/s1.jsonl')
  fs.writeFileSync(f, response({ output: 10, cwd: t.chug }))
  const ix = t.make()
  await ix.refresh(true)
  fs.rmSync(f)
  await ix.refresh(true)
  assert.equal((await ix.getUsage(QUERY)).totals['project:chug'].output, 10)
})

test('usage index: an unreadable projects root is an error, not an empty report', async () => {
  const t = setup()
  fs.rmSync(t.root, { recursive: true })
  const ix = t.make()
  await ix.refresh(true)
  const r = await ix.getUsage(QUERY)
  assert.equal(r.state, 'error')
  assert.match(r.error ?? '', /ENOENT/)
  assert.deepEqual(r.buckets, [])
})

test('usage index: while the first build runs, the report says indexing with progress', async () => {
  const t = setup()
  // Big enough that the build spans several event-loop turns.
  const lines = Array.from({ length: 40_000 }, () => response({ output: 1, cwd: t.chug })).join('')
  fs.writeFileSync(t.file('chug-dir/big.jsonl'), lines)
  const ix = t.make()
  const building = ix.refresh(true)
  const r = await ix.getUsage(QUERY)
  if (r.state === 'indexing') {
    assert.ok(r.progress && r.progress.total > 0)
    assert.deepEqual(r.buckets, [])
  } else {
    assert.equal(r.state, 'ready') // a fast machine finished inside the wait
  }
  await building
  assert.equal((await ix.getUsage(QUERY)).totals['project:chug'].output, 40_000)
})

test('usage index: rejects a malformed query', async () => {
  const t = setup()
  const ix = t.make()
  await assert.rejects(ix.getUsage({ granularity: 'year' as never, periods: 3 }))
  await assert.rejects(ix.getUsage({ granularity: 'day', periods: 0 }))
})
