import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseRecallLog,
  readsInLine,
  scanTranscriptLines,
  findTranscript,
  computeRecallScorecard,
} from './recall-scorecard.ts'
import { listSubagentTranscripts } from './subagents.ts'

const VAULT = 'C:\\vault'
const TITLE = 'JUCE judder fix- split logic Timer from VBlankAttachment for display-synced scrolling'

// Real log lines from scripts/vault-recall.log, covering every format the
// hook has ever written (legacy single-phase + current two-phase).
const SAMPLE_LOG = [
  `2026-08-09T17:32:05.138Z [pid 92548] exit: unexpected error: SyntaxError: Bad escaped character in JSON at position 51 (line 1 column 52)`,
  // Legacy single-phase: start + injected correlate by pid, injected has no session id.
  `2026-08-09T17:32:24.185Z [pid 29004] start session=e2e-1 project=chug promptChars=184`,
  `2026-08-09T17:32:37.426Z [pid 29004] done: injected 1 ["${TITLE}"] (cost=$0.0487)`,
  // Two-phase re-run of the SAME session id (state pruned between runs).
  `2026-08-09T17:39:30.478Z [pid 37068] start session=e2e-1 project=chug promptChars=184 (worker spawned)`,
  `2026-08-09T17:39:44.426Z [pid 54244] worker done: matched 1 ["${TITLE}"] (session=e2e-1 cost=$0.0130)`,
  `2026-08-09T17:39:45.134Z [pid 58216] done: delivered (session=e2e-1)`,
  // Two-phase no-match.
  `2026-08-09T18:22:12.055Z [pid 16036] start session=nomatch-1 project=chug promptChars=107 (worker spawned)`,
  `2026-08-09T18:22:29.455Z [pid 90072] worker done: no-match (session=nomatch-1 cost=$0.0641)`,
  // Matched but never delivered (one-prompt session).
  `2026-08-09T19:00:00.000Z [pid 11111] start session=undeliv-1 project=hub promptChars=90 (worker spawned)`,
  `2026-08-09T19:00:10.000Z [pid 22222] worker done: matched 1 ["${TITLE}"] (session=undeliv-1 cost=$0.0200)`,
  // Deliberate silence — must not count as an error.
  `2026-08-09T19:30:00.000Z [pid 33333] exit: daily attempt cap reached, skipping session=capped-1`,
].join('\n')

test('parseRecallLog merges duplicate sessions, sums costs, counts errors', () => {
  const { records, errors, spendUsd } = parseRecallLog(SAMPLE_LOG)
  assert.equal(records.length, 3) // e2e-1, nomatch-1, undeliv-1 — capped-1 never started
  assert.equal(errors, 1) // the unexpected-error line only, not the cap skip

  const e2e = records.find((r) => r.sessionId === 'e2e-1')!
  assert.equal(e2e.outcome, 'delivered')
  assert.equal(e2e.project, 'chug')
  assert.deepEqual(e2e.titles, [TITLE]) // deduped across the two runs
  assert.ok(Math.abs(e2e.costUsd - 0.0617) < 1e-9)
  assert.equal(e2e.at, '2026-08-09T17:32:24.185Z') // first attempt wins

  assert.equal(records.find((r) => r.sessionId === 'nomatch-1')!.outcome, 'no-match')
  assert.equal(records.find((r) => r.sessionId === 'undeliv-1')!.outcome, 'matched')
  assert.ok(Math.abs(spendUsd - (0.0487 + 0.013 + 0.0641 + 0.02)) < 1e-9)
})

test('parseRecallLog handles cost=n/a and empty input', () => {
  const { records, spendUsd } = parseRecallLog(
    `2026-08-09T20:00:00.000Z [pid 1] worker done: no-match (session=s1 cost=n/a)`,
  )
  assert.equal(records[0].outcome, 'no-match')
  assert.equal(spendUsd, 0)
  assert.deepEqual(parseRecallLog('').records, [])
})

const offered = new Map([[TITLE.toLowerCase(), TITLE]])

function readLine(filePath: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: filePath } }] },
  })
}

test('readsInLine matches Reads of offered vault notes, both slash forms', () => {
  assert.deepEqual(readsInLine(readLine(`${VAULT}\\${TITLE}.md`), offered, VAULT), [TITLE])
  assert.deepEqual(readsInLine(readLine(`C:/vault/${TITLE}.md`), offered, VAULT), [TITLE])
})

test('readsInLine ignores non-vault, non-offered, subfolder, and non-Read lines', () => {
  assert.deepEqual(readsInLine(readLine('C:\\elsewhere\\note.md'), offered, VAULT), [])
  assert.deepEqual(readsInLine(readLine(`${VAULT}\\Some other note.md`), offered, VAULT), [])
  assert.deepEqual(readsInLine(readLine(`${VAULT}\\MOCs\\${TITLE}.md`), offered, VAULT), [])
  const grepLine = JSON.stringify({
    message: { content: [{ type: 'tool_use', name: 'Grep', input: { file_path: `${VAULT}\\${TITLE}.md` } }] },
  })
  assert.deepEqual(readsInLine(grepLine, offered, VAULT), [])
  assert.deepEqual(readsInLine('not json at all', offered, VAULT), [])
})

function shellLine(command: string, name = 'Bash'): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name, input: { command } }] },
  })
}

test('readsInLine counts a shell read of an offered note, in every path form', () => {
  // The three real misses this was written for: `cat` of the offered note in
  // sessions the scorecard reported as "delivered → not read".
  assert.deepEqual(readsInLine(shellLine(`cat "C:/vault/${TITLE}.md" 2>/dev/null | head -60`), offered, VAULT), [TITLE])
  assert.deepEqual(readsInLine(shellLine(`cat "/c/vault/${TITLE}.md"`), offered, VAULT), [TITLE])
  assert.deepEqual(readsInLine(shellLine(`cd /c/vault && head -40 "${TITLE}.md"`), offered, VAULT), [TITLE])
  assert.deepEqual(
    readsInLine(shellLine(`Get-Content "C:\\vault\\${TITLE}.md"`, 'PowerShell'), offered, VAULT),
    [TITLE],
  )
})

test('readsInLine does not count shell commands that never name the note', () => {
  // The negative control: browsing the vault is not reading the offer. Without
  // this, "read" would inflate to every session that so much as ls'd the dir.
  assert.deepEqual(readsInLine(shellLine('ls "C:/vault/" | head -20'), offered, VAULT), [])
  assert.deepEqual(readsInLine(shellLine('grep -ril "bedding" /c/vault | head -30'), offered, VAULT), [])
  assert.deepEqual(readsInLine(shellLine('cat "C:/vault/Some other note.md"'), offered, VAULT), [])
  // The title in prose, without the filename, is discussion — not a read.
  assert.deepEqual(readsInLine(shellLine(`echo "${TITLE} is relevant here"`), offered, VAULT), [])
})

test('a truncated tool_use line is unknown, not a miss', () => {
  // Transcripts are appended live, so the last line of an in-flight session is
  // routinely a partial write. Counting that as "did not read" is what would
  // corrupt the unhook verdict.
  const full = readLine(`${VAULT}\\${TITLE}.md`)
  const truncated = full.slice(0, full.length - 20) // cut mid-record, after "tool_use"
  assert.equal(readsInLine(truncated, offered, VAULT), null)

  const scan = scanTranscriptLines([truncated, readLine('C:\\elsewhere\\note.md')], [TITLE], VAULT)
  assert.deepEqual(scan.readTitles, [])
  assert.equal(scan.unparsedLines, 1)
})

test('scanTranscriptLines reports marker and deduped reads', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `[vault-recall] The personal knowledge vault…` } }),
    readLine(`${VAULT}\\${TITLE}.md`),
    readLine(`${VAULT}\\${TITLE}.md`),
  ]
  const result = scanTranscriptLines(lines, [TITLE], VAULT)
  assert.equal(result.markerSeen, true)
  assert.deepEqual(result.readTitles, [TITLE])
})

test('computeRecallScorecard end-to-end over a fake projects root', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-scorecard-'))
  try {
    const projectsRoot = path.join(tmp, 'projects')
    const projDir = path.join(projectsRoot, 'C--some-project')
    fs.mkdirSync(projDir, { recursive: true })
    // e2e-1's transcript exists and reads the offered note; undeliv-1 has none.
    fs.writeFileSync(
      path.join(projDir, 'e2e-1.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: '[vault-recall] prior findings…' } }),
        readLine(`${VAULT}\\${TITLE}.md`),
      ].join('\n'),
    )
    const logPath = path.join(tmp, 'vault-recall.log')
    fs.writeFileSync(logPath, SAMPLE_LOG)

    const sc = await computeRecallScorecard({ logPath, projectsRoot, vaultDir: VAULT })
    assert.equal(sc.attempts, 3)
    assert.equal(sc.noMatch, 1)
    assert.equal(sc.offers.length, 2)
    assert.equal(sc.delivered, 1)
    assert.equal(sc.readSessions, 1)
    assert.equal(sc.errors, 1)
    assert.equal(sc.since, '2026-08-09T17:32:24.185Z')

    const delivered = sc.offers.find((o) => o.sessionId === 'e2e-1')!
    assert.equal(delivered.transcriptFound, true)
    assert.equal(delivered.markerSeen, true)
    assert.deepEqual(delivered.readTitles, [TITLE])
    const undelivered = sc.offers.find((o) => o.sessionId === 'undeliv-1')!
    assert.equal(undelivered.delivered, false)
    assert.equal(undelivered.transcriptFound, false)
    // Newest offer first.
    assert.equal(sc.offers[0].sessionId, 'undeliv-1')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('computeRecallScorecard is all-zero when the log does not exist', async () => {
  const sc = await computeRecallScorecard({
    logPath: path.join(os.tmpdir(), 'recall-scorecard-nonexistent.log'),
    projectsRoot: path.join(os.tmpdir(), 'recall-scorecard-nonexistent-projects'),
    vaultDir: VAULT,
  })
  assert.equal(sc.attempts, 0)
  assert.equal(sc.since, null)
})

test('a Read by a subagent counts as a hit (main transcript has no sidechain turns)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-subagent-'))
  try {
    const projectsRoot = path.join(tmp, 'projects')
    const projDir = path.join(projectsRoot, 'C--some-project')
    const subDir = path.join(projDir, 'sub-1', 'subagents', 'workflows', 'wf_x')
    fs.mkdirSync(subDir, { recursive: true })
    // Main transcript: marker delivered, but no Read of the note.
    fs.writeFileSync(
      path.join(projDir, 'sub-1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '[vault-recall] prior findings…' } }),
    )
    // The Read happens in a nested subagent transcript; journal.jsonl is ignored.
    fs.writeFileSync(path.join(subDir, 'agent-abc123.jsonl'), readLine(`${VAULT}\\${TITLE}.md`))
    fs.writeFileSync(path.join(subDir, 'journal.jsonl'), readLine(`${VAULT}\\${TITLE}.md`))
    const logPath = path.join(tmp, 'vault-recall.log')
    fs.writeFileSync(
      logPath,
      [
        `2026-08-10T10:00:00.000Z [pid 1] start session=sub-1 project=hub promptChars=90 (worker spawned)`,
        `2026-08-10T10:00:10.000Z [pid 2] worker done: matched 1 ["${TITLE}"] (session=sub-1 cost=$0.0100)`,
        `2026-08-10T10:00:20.000Z [pid 3] done: delivered (session=sub-1)`,
      ].join('\n'),
    )

    assert.equal(listSubagentTranscripts(path.join(projDir, 'sub-1.jsonl')).length, 1)
    const sc = await computeRecallScorecard({ logPath, projectsRoot, vaultDir: VAULT })
    assert.equal(sc.readSessions, 1)
    assert.deepEqual(sc.offers[0].readTitles, [TITLE])
    assert.equal(sc.offers[0].markerSeen, true)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('findTranscript refuses path-hostile session ids', () => {
  assert.equal(findTranscript('..', os.tmpdir()), null)
  assert.equal(findTranscript('a/b', os.tmpdir()), null)
})
