import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildLaunchTargets, findTargetTranscript, type LaunchTarget } from './desktop-targets.ts'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-18T12:00:00.000Z')
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const ALPHA = 'C:\\projects\\alpha'
const SANDBOX = 'C:\\projects\\claude-hub-sandbox'
const EXP = 'C:\\projects\\claude-hub-sandbox\\tiny-exp'
const TWIN = 'C:\\projects\\a-b' // encodes like C:\projects\a_b

const targets: LaunchTarget[] = [
  { ref: { kind: 'project', key: 'alpha' }, name: 'Alpha', path: ALPHA },
  { ref: { kind: 'project', key: 'sb' }, name: 'sandbox', path: SANDBOX },
  { ref: { kind: 'project', key: 'ab' }, name: 'A-B', path: TWIN },
  { ref: { kind: 'project', key: 'never' }, name: 'Never used', path: 'C:\\projects\\never' },
  { ref: { kind: 'experiment', key: 'tiny-exp' }, name: 'tiny-exp', path: EXP },
]

// One transcript: a user line (with its cwd and entrypoint), an assistant
// reply, and optionally an ai-title; mtime and timestamps at `atMs`.
function transcript(dir: string, id: string, o: { cwd: string; atMs: number; prompt?: string; aiTitle?: string; headless?: boolean }) {
  fs.mkdirSync(dir, { recursive: true })
  const ts = new Date(o.atMs).toISOString()
  const lines = [
    { type: 'user', cwd: o.cwd, entrypoint: o.headless ? 'sdk-cli' : 'cli', timestamp: ts, message: { role: 'user', content: o.prompt ?? 'hello' } },
    { type: 'assistant', cwd: o.cwd, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ...(o.aiTitle ? [{ type: 'ai-title', aiTitle: o.aiTitle }] : []),
  ]
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  fs.utimesSync(file, new Date(o.atMs), new Date(o.atMs))
  return file
}

test('launch targets: own dirs only, headless skipped, recent assigned by recorded cwd, live elsewhere marked', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-targets-'))
  try {
    transcript(path.join(base, 'C--projects-alpha'), uuid(1), { cwd: ALPHA, atMs: NOW - 2 * HOUR, aiTitle: 'Alpha title', prompt: 'ignored' })
    transcript(path.join(base, 'C--projects-alpha'), uuid(2), { cwd: ALPHA, atMs: NOW - 1 * HOUR, headless: true })
    // The same folder opened from Git Bash: a lower-case drive dir.
    transcript(path.join(base, 'c--projects-alpha'), uuid(3), { cwd: ALPHA.toLowerCase(), atMs: NOW - 3 * HOUR, prompt: 'fix the build' })
    transcript(path.join(base, 'C--projects-alpha'), 'not-a-session', { cwd: ALPHA, atMs: NOW })
    transcript(path.join(base, 'C--projects-claude-hub-sandbox'), uuid(4), { cwd: SANDBOX, atMs: NOW - 5 * HOUR })
    transcript(path.join(base, 'C--projects-claude-hub-sandbox-tiny-exp'), uuid(5), { cwd: EXP, atMs: NOW - HOUR / 2 })
    // In the twin's dir but recorded in C:\projects\a_b: not resumable as A-B.
    transcript(path.join(base, 'C--projects-a-b'), uuid(6), { cwd: 'C:\\projects\\a_b', atMs: NOW - 10 * HOUR })
    // An unregistered folder never shows.
    transcript(path.join(base, 'C--projects-gamma'), uuid(7), { cwd: 'C:\\projects\\gamma', atMs: NOW })

    const result = await buildLaunchTargets({ targets, base, liveElsewhere: new Set([uuid(3)]), errors: [], nowMs: NOW })
    assert.equal(result.error, null)
    assert.deepEqual(
      result.targets.map((t) => [t.kind, t.key, t.name, t.lastActivityIso]),
      [
        ['experiment', 'tiny-exp', 'tiny-exp', new Date(NOW - HOUR / 2).toISOString()],
        // The newer headless run doesn't count.
        ['project', 'alpha', 'Alpha', new Date(NOW - 2 * HOUR).toISOString()],
        // The experiment's session is not the sandbox project's.
        ['project', 'sb', 'sandbox', new Date(NOW - 5 * HOUR).toISOString()],
        ['project', 'ab', 'A-B', new Date(NOW - 10 * HOUR).toISOString()],
        ['project', 'never', 'Never used', null],
      ],
    )
    assert.deepEqual(
      result.recent.map((r) => [r.sessionId, r.title, r.target.key, r.targetName, r.lastActivityIso, r.liveElsewhere]),
      [
        [uuid(5), 'hello', 'tiny-exp', 'tiny-exp', new Date(NOW - HOUR / 2).toISOString(), false],
        [uuid(1), 'Alpha title', 'alpha', 'Alpha', new Date(NOW - 2 * HOUR).toISOString(), false],
        [uuid(3), 'fix the build', 'alpha', 'Alpha', new Date(NOW - 3 * HOUR).toISOString(), true],
        [uuid(4), 'hello', 'sb', 'sandbox', new Date(NOW - 5 * HOUR).toISOString(), false],
      ],
    )

    // What the caller couldn't read is passed through with the partial result.
    const partial = await buildLaunchTargets({ targets, base, liveElsewhere: new Set(), errors: ['registry gone'], nowMs: NOW })
    assert.equal(partial.error, 'registry gone')
    assert.equal(partial.recent.length, 4)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('launch targets: no projects folder is no history; an unreadable one is an error, never an empty list', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-targets-none-'))
  try {
    const none = await buildLaunchTargets({ targets, base: path.join(base, 'missing'), liveElsewhere: new Set(), errors: [], nowMs: NOW })
    assert.equal(none.error, null)
    assert.deepEqual(none.recent, [])
    assert.ok(none.targets.every((t) => t.lastActivityIso === null))
    const file = path.join(base, 'a-file')
    fs.writeFileSync(file, '')
    const broken = await buildLaunchTargets({ targets, base: file, liveElsewhere: new Set(), errors: [], nowMs: NOW })
    assert.match(broken.error ?? '', /Couldn't read/)
    assert.equal(broken.targets.length, targets.length)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test("findTargetTranscript: the conversation must be in the target's own dir and have run in that folder", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-targets-resume-'))
  try {
    const file = transcript(path.join(base, 'C--projects-alpha'), uuid(1), { cwd: ALPHA, atMs: NOW })
    transcript(path.join(base, 'C--projects-a-b'), uuid(6), { cwd: 'C:\\projects\\a_b', atMs: NOW })
    transcript(path.join(base, 'C--projects-claude-hub-sandbox-tiny-exp'), uuid(5), { cwd: EXP, atMs: NOW })
    assert.equal(findTargetTranscript(base, ALPHA, uuid(1)), file)
    assert.equal(findTargetTranscript(base, 'c:\\Projects\\Alpha', uuid(1)), file)
    assert.throws(() => findTargetTranscript(base, TWIN, uuid(6)), /ran in C:\\projects\\a_b, not C:\\projects\\a-b/)
    assert.throws(() => findTargetTranscript(base, ALPHA, uuid(2)), /No conversation/)
    // An experiment's conversation isn't the sandbox project's to resume.
    assert.throws(() => findTargetTranscript(base, SANDBOX, uuid(5)), /No conversation/)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('recent: a conversation nobody typed into is left out, and no title reads as the placeholder', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-targets-'))
  try {
    const dir = path.join(base, 'C--projects-alpha')
    fs.mkdirSync(dir, { recursive: true })
    // A fresh /clear: only bookkeeping and the local command, no prompt or reply.
    const empty = path.join(dir, `${uuid(20)}.jsonl`)
    fs.writeFileSync(empty, [{ type: 'mode', mode: 'normal' }, { type: 'user', cwd: ALPHA, entrypoint: 'cli', isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' } }].map((l) => JSON.stringify(l)).join('\n') + '\n')
    fs.utimesSync(empty, new Date(NOW), new Date(NOW))
    // A real exchange whose only prompt is a placeholder-free command wrapper still has a reply.
    transcript(dir, uuid(21), { cwd: ALPHA, atMs: NOW - HOUR, prompt: 'hello there' })
    const result = await buildLaunchTargets({ targets, base, liveElsewhere: new Set(), errors: [], nowMs: NOW })
    assert.deepEqual(result.recent.map((r) => r.sessionId), [uuid(21)])
    assert.ok(result.recent.every((r) => r.title !== '(no message found)'))
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
