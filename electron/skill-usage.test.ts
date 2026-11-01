import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  aggregateExtensionUsage,
  aggregateUsage,
  extractMcpCalls,
  extractSkillInvocations,
  refreshUsageIndex,
} from './skill-usage.ts'

function line(skill: string | null, timestamp: string, name = 'Skill'): string {
  const content = skill === null ? [{ type: 'text', text: 'hi' }] : [{ type: 'tool_use', name, input: { skill } }]
  return JSON.stringify({ timestamp, message: { role: 'assistant', content } })
}

test('extractSkillInvocations pulls skill + timestamp from a Skill tool_use', () => {
  const got = extractSkillInvocations(line('parallel-build', '2026-07-01T10:00:00Z'))
  assert.deepEqual(got, [{ skill: 'parallel-build', timestamp: '2026-07-01T10:00:00Z' }])
})

test('extractSkillInvocations ignores non-Skill tool_use, text, and malformed lines', () => {
  assert.deepEqual(extractSkillInvocations(line('x', 't', 'Bash')), [])
  assert.deepEqual(extractSkillInvocations(line(null, 't')), [])
  assert.deepEqual(extractSkillInvocations('not json at all'), [])
  assert.deepEqual(extractSkillInvocations(JSON.stringify({ message: { content: 'plain string' } })), [])
  // tool_use named Skill but with no usable input.skill
  assert.deepEqual(
    extractSkillInvocations(JSON.stringify({ timestamp: 't', message: { content: [{ type: 'tool_use', name: 'Skill', input: {} }] } })),
    [],
  )
})

// A slash invocation writes no Skill tool_use, so counting only tool_use made
// the Commands view report a number that excluded the exact gesture its own
// `/name` labels describe.
function commandLine(body: string, timestamp = '2026-08-24T01:40:20.470Z'): string {
  return JSON.stringify({ timestamp, type: 'user', message: { role: 'user', content: body } })
}

test('extractSkillInvocations counts a slash-command wrapper turn', () => {
  const got = extractSkillInvocations(
    commandLine('<command-message>handoff</command-message>\n<command-name>/handoff</command-name>'),
  )
  assert.deepEqual(got, [{ skill: 'handoff', timestamp: '2026-08-24T01:40:20.470Z' }])
})

test('extractSkillInvocations counts a wrapper carrying command-args', () => {
  const got = extractSkillInvocations(
    commandLine(
      '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>5m</command-args>',
    ),
  )
  assert.deepEqual(got, [{ skill: 'loop', timestamp: '2026-08-24T01:40:20.470Z' }])
})

// The same tag is quoted verbatim inside agent prompts that replay an earlier
// conversation — 25 such copies for `handoff` against its 19 real invocations
// on this corpus. Counting them would inflate the number the slash support
// exists to correct, so only a whole-content wrapper is a use.
test('extractSkillInvocations ignores a command tag quoted inside a larger turn', () => {
  assert.deepEqual(
    extractSkillInvocations(
      commandLine('here is what happened:\n\n[user] <command-name>/handoff</command-name>\n\nand then more text'),
    ),
    [],
  )
})

test('aggregateUsage counts invocations and keeps the most recent timestamp', () => {
  const index = {
    v: 1,
    files: {
      a: { mtimeMs: 1, invocations: [{ skill: 'x', timestamp: '2026-01-01T00:00:00Z' }] },
      b: {
        mtimeMs: 2,
        invocations: [
          { skill: 'x', timestamp: '2026-03-01T00:00:00Z' },
          { skill: 'y', timestamp: '2026-02-01T00:00:00Z' },
        ],
      },
    },
  }
  const usage = aggregateUsage(index).sort((p, q) => p.skill.localeCompare(q.skill))
  // Default resolver: project falls back to the dir basename ('.' for these
  // bare fake paths); sessionId is the file key. Invocations are newest-first.
  assert.deepEqual(usage, [
    {
      skill: 'x',
      count: 2,
      lastUsed: '2026-03-01T00:00:00Z',
      invocations: [
        { ts: '2026-03-01T00:00:00Z', project: '.', projectId: null, sessionId: 'b' },
        { ts: '2026-01-01T00:00:00Z', project: '.', projectId: null, sessionId: 'a' },
      ],
    },
    {
      skill: 'y',
      count: 1,
      lastUsed: '2026-02-01T00:00:00Z',
      invocations: [{ ts: '2026-02-01T00:00:00Z', project: '.', projectId: null, sessionId: 'b' }],
    },
  ])
})

// The whole point of the persisted index: re-scan only files whose mtime
// changed. This exercises the real incremental loop against a temp corpus.
// mtimes are set explicitly with fixed whole-ms Dates so they round-trip
// exactly through the filesystem (avoids sub-ms statmtime drift).
test('refreshUsageIndex is mtime-incremental: stale content is served from cache until mtime bumps', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-root-'))
  const projDir = path.join(root, 'projA')
  fs.mkdirSync(projDir)
  const idxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-idx-')), 'index.json')
  const s1 = path.join(projDir, 's1.jsonl')
  const t0 = new Date('2020-01-01T00:00:00.000Z')
  const t1 = new Date('2020-01-02T00:00:00.000Z')

  // One-invocation expectation: the default resolver reports the session
  // dir's basename ('projA') and the transcript basename as sessionId.
  const one = (skill: string, ts: string, sessionId: string) => [
    { skill, count: 1, lastUsed: ts, invocations: [{ ts, project: 'projA', projectId: null, sessionId }] },
  ]

  // Round 1: one invocation of A, at mtime t0.
  fs.writeFileSync(s1, line('skill-A', '2026-07-01T10:00:00Z') + '\n')
  fs.utimesSync(s1, t0, t0)
  let usage = aggregateUsage(await refreshUsageIndex(root, idxPath))
  assert.deepEqual(usage, one('skill-A', '2026-07-01T10:00:00Z', 's1'))

  // Rewrite to invocation B but pin mtime back to t0 — mtime unchanged, so the
  // index must keep serving the cached A, not re-read B.
  fs.writeFileSync(s1, line('skill-B', '2026-07-02T10:00:00Z') + '\n')
  fs.utimesSync(s1, t0, t0)
  usage = aggregateUsage(await refreshUsageIndex(root, idxPath))
  assert.deepEqual(usage, one('skill-A', '2026-07-01T10:00:00Z', 's1'), 'unchanged mtime → cached result')
  // Nothing changed, so the index file isn't rewritten.
  fs.utimesSync(idxPath, t0, t0)
  await refreshUsageIndex(root, idxPath)
  assert.equal(fs.statSync(idxPath).mtimeMs, t0.getTime(), 'unchanged corpus → no index write')

  // Bump the mtime → now it re-scans and sees B.
  fs.utimesSync(s1, t1, t1)
  usage = aggregateUsage(await refreshUsageIndex(root, idxPath))
  assert.deepEqual(usage, one('skill-B', '2026-07-02T10:00:00Z', 's1'), 'bumped mtime → re-scanned')

  // Add a second file; both contribute.
  fs.writeFileSync(path.join(projDir, 's2.jsonl'), line('skill-A', '2026-07-03T10:00:00Z') + '\n')
  usage = aggregateUsage(await refreshUsageIndex(root, idxPath)).sort((p, q) => p.skill.localeCompare(q.skill))
  assert.deepEqual(usage, [
    ...one('skill-A', '2026-07-03T10:00:00Z', 's2'),
    ...one('skill-B', '2026-07-02T10:00:00Z', 's1'),
  ])

  // Remove the first file; its contribution drops out of the aggregate.
  fs.rmSync(s1)
  usage = aggregateUsage(await refreshUsageIndex(root, idxPath))
  assert.deepEqual(usage, one('skill-A', '2026-07-03T10:00:00Z', 's2'), 'deleted file forgotten')
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(idxPath, 'utf-8')).files), [path.join(projDir, 's2.jsonl')], 'a prune alone is persisted')
})

// An unreadable corpus root must not be read as "no skill was ever invoked".
// allSessionFiles() used to return [] here, after which the prune loop deleted
// every entry and writeFileSync persisted the emptied index over the real one —
// a read failure converted into a measured zero AND written to disk, with no
// log line (the only one is gated on stale.length > 0). It self-heals on the
// next successful run, which is exactly what made it easy to miss.
test('an unreadable corpus root keeps the index instead of wiping it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skill-usage-'))
  const idxPath = path.join(root, 'index.json')
  const projDir = path.join(root, 'proj')
  fs.mkdirSync(projDir)
  fs.writeFileSync(path.join(projDir, 's1.jsonl'), line('skill-A', '2026-07-01T10:00:00Z') + '\n')

  const built = aggregateUsage(await refreshUsageIndex(root, idxPath))
  assert.equal(built.length, 1, 'index builds normally first')
  assert.equal(built[0].skill, 'skill-A')
  assert.equal(built[0].count, 1)
  const onDisk = fs.readFileSync(idxPath, 'utf-8')

  // Point the scan at a root that does not exist — the read fails, the corpus
  // is not empty, and the two must not look alike.
  const gone = path.join(root, 'no-such-corpus')
  const after = aggregateUsage(await refreshUsageIndex(gone, idxPath))
  assert.deepEqual(after, built, 'unreadable root → previous usage still reported, not zeroed')
  assert.equal(fs.readFileSync(idxPath, 'utf-8'), onDisk, 'the persisted index is left byte-identical')
})

function toolLine(names: string[], timestamp: string): string {
  return JSON.stringify({ timestamp, message: { role: 'assistant', content: names.map((name) => ({ type: 'tool_use', name, input: {} })) } })
}

test('extractMcpCalls splits mcp__<server>__<tool> at the first double underscore', () => {
  assert.deepEqual(extractMcpCalls(toolLine(['mcp__claude_ai_Claude_Docs__read', 'Bash', 'mcp__playwright__browser_click'], 't1')), [
    { server: 'claude_ai_Claude_Docs', tool: 'read', timestamp: 't1' },
    { server: 'playwright', tool: 'browser_click', timestamp: 't1' },
  ])
  assert.deepEqual(extractMcpCalls(toolLine(['mcp__plugin_design_slack__send__now'], 't')), [
    { server: 'plugin_design_slack', tool: 'send__now', timestamp: 't' },
  ])
  assert.deepEqual(extractMcpCalls(toolLine(['mcp__broken', 'mcp____x'], 't')), [])
  assert.deepEqual(extractMcpCalls('not json'), [])
})

test('refreshUsageIndex records MCP calls; aggregateExtensionUsage windows calls but not lastUsed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-usage-'))
  const projDir = path.join(root, 'proj')
  fs.mkdirSync(projDir)
  fs.writeFileSync(
    path.join(projDir, 's1.jsonl'),
    [
      toolLine(['mcp__playwright__browser_click'], '2026-09-01T00:00:00Z'),
      toolLine(['mcp__playwright__browser_click', 'mcp__playwright__browser_navigate'], '2026-10-10T00:00:00Z'),
      toolLine(['mcp__playwright__browser_click'], '2026-10-11T00:00:00Z'),
      line('design:ux-copy', '2026-10-12T00:00:00Z'),
    ].join('\n') + '\n',
  )
  const index = await refreshUsageIndex(root, path.join(root, 'index.json'))
  const usage = aggregateExtensionUsage(index, '2026-10-01T00:00:00Z')
  assert.deepEqual(usage.mcp.get('playwright'), {
    calls: 3,
    lastUsedIso: '2026-10-11T00:00:00Z',
    topTools: [
      { tool: 'browser_click', count: 2 },
      { tool: 'browser_navigate', count: 1 },
    ],
  })
  assert.equal(usage.skills.get('design:ux-copy')?.calls, 1)
  const old = aggregateExtensionUsage(index, '2026-10-20T00:00:00Z')
  assert.deepEqual(old.mcp.get('playwright'), { calls: 0, lastUsedIso: '2026-10-11T00:00:00Z', topTools: [] })
})

// Subagent transcripts (<dir>/<session>/subagents/**/*.jsonl) held 46% of the
// MCP calls in 30 days measured 2026-10-20; a scan of <dir>/*.jsonl alone
// reported a server used only through subagents as never called.
test('refreshUsageIndex reads subagent transcripts, credited to the parent session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-subagents-'))
  const projDir = path.join(root, 'proj')
  fs.mkdirSync(path.join(projDir, 's1', 'subagents', 'workflows', 'w1'), { recursive: true })
  fs.mkdirSync(path.join(projDir, 's2', 'tool-results'), { recursive: true }) // a session folder with no subagents
  fs.writeFileSync(path.join(projDir, 's1.jsonl'), toolLine(['mcp__playwright__browser_click'], '2026-10-10T00:00:00Z') + '\n')
  fs.writeFileSync(
    path.join(projDir, 's1', 'subagents', 'agent-a1.jsonl'),
    [toolLine(['mcp__playwright__browser_navigate'], '2026-10-11T00:00:00Z'), line('design:ux-copy', '2026-10-11T01:00:00Z')].join('\n') + '\n',
  )
  fs.writeFileSync(
    path.join(projDir, 's1', 'subagents', 'workflows', 'w1', 'agent-a2.jsonl'),
    toolLine(['mcp__desktop-control__screenshot'], '2026-10-12T00:00:00Z') + '\n',
  )
  const index = await refreshUsageIndex(root, path.join(root, 'index.json'))
  const usage = aggregateExtensionUsage(index, '2026-10-01T00:00:00Z')
  assert.equal(usage.mcp.get('playwright')?.calls, 2)
  assert.equal(usage.mcp.get('playwright')?.lastUsedIso, '2026-10-11T00:00:00Z')
  assert.equal(usage.mcp.get('desktop-control')?.calls, 1)
  assert.equal(usage.skills.get('design:ux-copy')?.calls, 1)
  assert.deepEqual(aggregateUsage(index)[0].invocations, [{ ts: '2026-10-11T01:00:00Z', project: 'proj', projectId: null, sessionId: 's1' }])
})
