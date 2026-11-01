import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  shouldAttemptRecall,
  isEphemeralSessionCwd,
  decideRecallAction,
  pruneAndCountToday,
  buildMatchPrompt,
  evaluateMatchOutput,
  formatInjection,
  RECALL_MARKER,
  MAX_PROMPT_CHARS,
  composeTaskContext,
  FIRST_PROMPT_CHARS,
  LATEST_PROMPT_CHARS,
  TASK_EXCERPT_CHARS,
} from './recall-core.ts'

test('decideRecallAction spends only once a session has proven it will keep talking', () => {
  const base = {
    hasResult: false,
    hasAttempted: false,
    hasSeen: false,
    promptIsSubstantive: true,
    ephemeralCwd: false,
  }
  // First substantive prompt: record it, spend nothing.
  assert.equal(decideRecallAction(base), 'mark-seen')
  // Second: the session is still talking, so an injection has somewhere to land.
  assert.equal(decideRecallAction({ ...base, hasSeen: true }), 'attempt')
  // Third onwards, once paid: nothing more, hit or miss.
  assert.equal(decideRecallAction({ ...base, hasSeen: true, hasAttempted: true }), 'skip')
  // A waiting result is delivered on ANY prompt, including a trivial one, and
  // is never gated behind the seen/attempt phases — delivery is free.
  assert.equal(decideRecallAction({ ...base, hasResult: true, promptIsSubstantive: false }), 'deliver')
  assert.equal(decideRecallAction({ ...base, hasResult: true, ephemeralCwd: true, hasAttempted: true }), 'deliver')
  // Trivial prompts never advance the phase — a later real prompt still can.
  assert.equal(decideRecallAction({ ...base, promptIsSubstantive: false }), 'skip')
  // A worktree arm never even reaches 'mark-seen'.
  assert.equal(decideRecallAction({ ...base, ephemeralCwd: true }), 'skip')
})

test('isEphemeralSessionCwd skips temp worktree arms but never real project dirs', () => {
  const tmp = 'C:\\Users\\J_doe\\AppData\\Local\\Temp'
  // A parallel-build worktree arm: measured 18 attempts, 0 ever delivered.
  assert.equal(isEphemeralSessionCwd(`${tmp}\\claude\\proj\\scratchpad\\ws-arm-a`, tmp), true)
  assert.equal(isEphemeralSessionCwd(tmp, tmp), true)
  // The rule this replaces was "anything sandbox-ish", which also matched the
  // sandbox EXPERIMENT dirs — ordinary interactive sessions that produced 4 of
  // the 11 injections ever delivered. Those must survive.
  assert.equal(isEphemeralSessionCwd('C:\\projects\\claude-hub-sandbox\\Grade chug harness', tmp), false)
  assert.equal(isEphemeralSessionCwd('C:\\projects\\claude-hub', tmp), false)
  // Prefix-of-a-sibling must not count as "inside".
  assert.equal(isEphemeralSessionCwd('C:\\Users\\J_doe\\AppData\\Local\\TempExtra\\x', tmp), false)
  // Slash form and trailing separators are the same path.
  assert.equal(isEphemeralSessionCwd('c:/users/j_doe/appdata/local/temp/x', `${tmp}\\`), true)
  assert.equal(isEphemeralSessionCwd('', tmp), false)
})

test('shouldAttemptRecall accepts a normal task prompt', () => {
  assert.equal(shouldAttemptRecall('The tab cursor strip judders when scrolling on my 164Hz monitor, fix it'), true)
})

test('shouldAttemptRecall rejects short continuations', () => {
  assert.equal(shouldAttemptRecall('continue'), false)
  assert.equal(shouldAttemptRecall('sure go ahead'), false)
})

test('shouldAttemptRecall rejects slash commands', () => {
  assert.equal(shouldAttemptRecall('/compact keep the JUCE judder work going for a while longer'), false)
})

test('shouldAttemptRecall rejects harness command records', () => {
  assert.equal(
    shouldAttemptRecall('<command-name>/clear</command-name> some expanded command output padding here'),
    false,
  )
})

test('shouldAttemptRecall rejects oversized prompts (headless automation)', () => {
  assert.equal(shouldAttemptRecall('x'.repeat(MAX_PROMPT_CHARS + 1)), false)
})

test('shouldAttemptRecall rejects turns the harness wrote, not the user', () => {
  // Real shapes, from the 9 of 100 paid calls that were spent on one.
  assert.equal(
    shouldAttemptRecall('<task-notification> <task-id>a40ea987</task-id> <status>completed</status> <summary>Agent finished</summary>'),
    false,
  )
  assert.equal(shouldAttemptRecall('<local-command-stdout>Auto-compact window set to auto</local-command-stdout>'), false)
  assert.equal(shouldAttemptRecall('[Request interrupted by user for tool use] and some padding to clear the floor'), false)
})

test('composeTaskContext keeps the task statement and the turn that steers it', () => {
  const composed = composeTaskContext('launch a parallel build to audit the UI', 'actually maybe 2 rounds, with a grader?')
  assert.ok(composed.includes('launch a parallel build to audit the UI'))
  assert.ok(composed.includes('actually maybe 2 rounds, with a grader?'))
})

test('composeTaskContext gives each half its own budget', () => {
  // A long opener must not crowd out the follow-up — the follow-up is what
  // killed a false positive in the replay.
  const composed = composeTaskContext('a'.repeat(5000), 'b'.repeat(5000))
  assert.ok(composed.includes('a'.repeat(FIRST_PROMPT_CHARS)))
  assert.ok(!composed.includes('a'.repeat(FIRST_PROMPT_CHARS + 1)))
  assert.ok(composed.includes('b'.repeat(LATEST_PROMPT_CHARS)))
  assert.ok(!composed.includes('b'.repeat(LATEST_PROMPT_CHARS + 1)))
  assert.equal(composed.length, TASK_EXCERPT_CHARS)
})

test('composeTaskContext falls back to whichever half it has', () => {
  // A .seen written before this shipped holds '', and the delivered result of
  // a pruned session can arrive with no first prompt at all: match on the
  // prompt in hand rather than on an empty task.
  assert.equal(composeTaskContext('', 'fix the judder'), 'fix the judder')
  assert.equal(composeTaskContext('fix the judder', ''), 'fix the judder')
  assert.equal(composeTaskContext('fix the judder', 'fix the judder'), 'fix the judder')
})

test('buildMatchPrompt embeds task, project, and every title', () => {
  const prompt = buildMatchPrompt('fix the judder', 'chug', ['Note A', 'Note B'])
  assert.ok(prompt.includes('fix the judder'))
  assert.ok(prompt.includes('project: chug'))
  assert.ok(prompt.includes('- Note A'))
  assert.ok(prompt.includes('- Note B'))
})

test('buildMatchPrompt truncates a long task excerpt', () => {
  const prompt = buildMatchPrompt('y'.repeat(3000), 'p', ['T'])
  assert.ok(!prompt.includes('y'.repeat(TASK_EXCERPT_CHARS + 1)))
})

test('evaluateMatchOutput keeps only high-confidence, known titles', () => {
  const raw = JSON.stringify({
    matches: [
      { title: 'Real Note', confidence: 'high', reason: 'covers this bug' },
      { title: 'Real Note Two', confidence: 'medium', reason: 'related' },
      { title: 'Hallucinated Note', confidence: 'high', reason: 'made up' },
    ],
  })
  const out = evaluateMatchOutput(raw, ['Real Note', 'Real Note Two'])
  assert.deepEqual(out, [{ title: 'Real Note', reason: 'covers this bug' }])
})

test('evaluateMatchOutput canonicalizes case and dedupes', () => {
  const raw = JSON.stringify({
    matches: [
      { title: 'real note', confidence: 'high', reason: 'a' },
      { title: 'REAL NOTE', confidence: 'high', reason: 'b' },
    ],
  })
  const out = evaluateMatchOutput(raw, ['Real Note'])
  assert.deepEqual(out, [{ title: 'Real Note', reason: 'a' }])
})

test('evaluateMatchOutput caps at 3 matches', () => {
  const titles = ['A', 'B', 'C', 'D']
  const raw = JSON.stringify({
    matches: titles.map((t) => ({ title: t, confidence: 'high', reason: 'r' })),
  })
  assert.equal(evaluateMatchOutput(raw, titles).length, 3)
})

test('evaluateMatchOutput handles fenced JSON and garbage', () => {
  const fenced = '```json\n{"matches": [{"title": "A", "confidence": "high", "reason": "r"}]}\n```'
  assert.deepEqual(evaluateMatchOutput(fenced, ['A']), [{ title: 'A', reason: 'r' }])
  assert.deepEqual(evaluateMatchOutput('not json at all', ['A']), [])
  assert.deepEqual(evaluateMatchOutput('null', ['A']), [])
  assert.deepEqual(evaluateMatchOutput('{"matches": "nope"}', ['A']), [])
})

test('evaluateMatchOutput defaults a missing reason', () => {
  const raw = JSON.stringify({ matches: [{ title: 'A', confidence: 'high' }] })
  assert.deepEqual(evaluateMatchOutput(raw, ['A']), [{ title: 'A', reason: 'prior finding on this topic' }])
})

test('formatInjection carries the marker and note paths', () => {
  const block = formatInjection([{ title: 'JUCE judder fix', reason: 'same symptom' }], 'D:\\vault')
  assert.ok(block.startsWith(RECALL_MARKER))
  assert.ok(block.includes('"JUCE judder fix" — same symptom (read: D:\\vault\\JUCE judder fix.md)'))
})

// ---- the daily spend cap's counter ----
//
// A recall attempt costs a haiku call. This count is the only thing between a
// chatty day and two hundred of them, and it was script-local and untested.
// Every case injects a fixed `now` — no wall clock.

const NOW = Date.parse('2026-08-18T15:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function stateDir(entries: Array<{ name: string; mtime: number }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-recall-state-'))
  for (const { name, mtime } of entries) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, '')
    fs.utimesSync(file, new Date(mtime), new Date(mtime))
  }
  return dir
}

// The one that actually bites. The same directory holds the detached worker's
// .job and .result files, so counting anything with a dot would score one
// attempt as three — the cap would stop recall at eight prompts a day instead
// of twenty-five, and silently, since a capped hook just says nothing.
test('only bare attempt markers count toward the day', () => {
  const dir = stateDir([
    { name: 'session-a', mtime: NOW - 60_000 },
    { name: 'session-a.job', mtime: NOW - 60_000 },
    { name: 'session-a.result', mtime: NOW - 30_000 },
    { name: 'session-b', mtime: NOW - 20_000 },
  ])

  assert.equal(pruneAndCountToday(dir, NOW), 2)
})

test('markers from an earlier day are kept but not counted', () => {
  const dir = stateDir([
    { name: 'today', mtime: NOW - 60_000 },
    { name: 'yesterday', mtime: NOW - DAY },
  ])

  assert.equal(pruneAndCountToday(dir, NOW), 1)
  assert.ok(fs.existsSync(path.join(dir, 'yesterday')), 'still inside the retention window')
})

test('anything past the retention window is deleted on the way through', () => {
  const dir = stateDir([
    { name: 'ancient', mtime: NOW - 4 * DAY },
    { name: 'ancient.result', mtime: NOW - 4 * DAY },
    { name: 'today', mtime: NOW - 60_000 },
  ])

  assert.equal(pruneAndCountToday(dir, NOW), 1)
  assert.deepEqual(fs.readdirSync(dir), ['today'], 'the state dir does not grow without bound')
})

test('an empty state dir is nothing spent, not an error', () => {
  assert.equal(pruneAndCountToday(stateDir([]), NOW), 0)
})
