import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildTranscriptText,
  stripCodeFence,
  evaluateReviewOutput,
  evaluateTriageOutput,
  buildExtractPrompt,
  extractResultFromJsonOutput,
  deriveProjectName,
  hasProjectScopedRegistration,
  listStoreTitles,
  shouldTriageSession,
  recordTriagedSession,
  pruneSessionState,
  curateStandDownReason,
  MIN_GROWTH_FOR_RETRIAGE,
} from './curate-core.ts'

// The 2026-10-14 loop: the hook curated transcripts of its own triage calls.
function writeTranscript(entrypoint: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curate-standdown-'))
  const file = path.join(dir, 'session.jsonl')
  const user = { type: 'user', entrypoint, isSidechain: false, message: { role: 'user', content: 'Does this Claude Code session transcript plausibly contain…' } }
  const reply = { type: 'assistant', entrypoint, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'yes' }] } }
  fs.writeFileSync(file, [user, reply, user, reply].map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}

test('curateStandDownReason stands down on a hub-spawned call', async () => {
  const reason = await curateStandDownReason({ CLAUDE_HUB_HEADLESS: '1' }, writeTranscript('cli'))
  assert.match(reason ?? '', /CLAUDE_HUB_HEADLESS/)
})

test('curateStandDownReason stands down on a headless (sdk-cli) transcript', async () => {
  const reason = await curateStandDownReason({}, writeTranscript('sdk-cli'))
  assert.match(reason ?? '', /sdk-cli/)
})

test('curateStandDownReason lets an interactive session through', async () => {
  assert.equal(await curateStandDownReason({}, writeTranscript('cli')), null)
})

test('stripCodeFence strips a ```json fence', () => {
  assert.equal(stripCodeFence('```json\n{"decision": "SKIP"}\n```'), '{"decision": "SKIP"}')
})

test('stripCodeFence strips a bare ``` fence', () => {
  assert.equal(stripCodeFence('```\n{"decision": "SKIP"}\n```'), '{"decision": "SKIP"}')
})

test('stripCodeFence trims unfenced text and leaves it otherwise intact', () => {
  assert.equal(stripCodeFence('  {"decision": "SKIP"}\n'), '{"decision": "SKIP"}')
})

test('stripCodeFence leaves text alone when a fence does not span the whole output', () => {
  const text = 'Here is my answer:\n```json\n{"decision": "SKIP"}\n```'
  assert.equal(stripCodeFence(text), text)
})

test('evaluateReviewOutput accepts one complete finding and defaults confidence to medium', () => {
  const outcome = evaluateReviewOutput('{"findings": [{"title": "T", "content": "C", "justification": "(a) because"}]}')
  assert.deepEqual(outcome, {
    kind: 'saves',
    saves: [{ title: 'T', content: 'C', justification: '(a) because', confidence: 'medium' }],
  })
})

test('evaluateReviewOutput reads a provided confidence', () => {
  const outcome = evaluateReviewOutput(
    '{"findings": [{"title": "T", "content": "C", "justification": "(a)", "confidence": "high"}]}',
  )
  assert.equal(outcome.kind === 'saves' && outcome.saves[0].confidence, 'high')
})

test('evaluateReviewOutput returns every distinct finding', () => {
  const outcome = evaluateReviewOutput('{"findings": [{"title": "A", "content": "1"}, {"title": "B", "content": "2"}]}')
  assert.equal(outcome.kind === 'saves' && outcome.saves.length, 2)
  assert.deepEqual(outcome.kind === 'saves' && outcome.saves.map((s) => s.title), ['A', 'B'])
})

test('evaluateReviewOutput accepts findings wrapped in a markdown fence (observed haiku behavior)', () => {
  const outcome = evaluateReviewOutput(
    '```json\n{"findings": [{"title": "T", "content": "C", "justification": "(b) seen"}]}\n```',
  )
  assert.equal(outcome.kind === 'saves' && outcome.saves.length, 1)
})

test('evaluateReviewOutput drops a finding missing title or content', () => {
  const outcome = evaluateReviewOutput('{"findings": [{"content": "C"}, {"title": "keep", "content": "yes"}]}')
  assert.deepEqual(outcome, {
    kind: 'saves',
    saves: [{ title: 'keep', content: 'yes', justification: '(no justification given)', confidence: 'medium' }],
  })
})

test('evaluateReviewOutput defaults a missing justification', () => {
  const outcome = evaluateReviewOutput('{"findings": [{"title": "T", "content": "C"}]}')
  assert.deepEqual(outcome, {
    kind: 'saves',
    saves: [{ title: 'T', content: 'C', justification: '(no justification given)', confidence: 'medium' }],
  })
})

test('evaluateTriageOutput returns true only for explicit hasCandidate:true', () => {
  assert.equal(evaluateTriageOutput('{"hasCandidate": true}'), true)
  assert.equal(evaluateTriageOutput('```json\n{"hasCandidate": true}\n```'), true)
  assert.equal(evaluateTriageOutput('{"hasCandidate": false}'), false)
  assert.equal(evaluateTriageOutput('not json'), false) // unparseable → don't spend the extract call
})

test('buildExtractPrompt injects the rubric, lists existing titles for dedup, and defaults to saving nothing', () => {
  const rubric = 'SAVE only a real gotcha. REJECT anything lookable-up.'
  const prompt = buildExtractPrompt(['Alpha', 'Beta'], rubric)
  assert.ok(prompt.includes('- Alpha'))
  assert.ok(prompt.includes('- Beta'))
  assert.ok(prompt.includes(rubric))
  assert.ok(/default to saving nothing/i.test(prompt))
  assert.ok(buildExtractPrompt([], rubric).includes('(none yet)'))
})

test('extractResultFromJsonOutput unwraps the json envelope and reads cost', () => {
  const raw = JSON.stringify({ result: '{"decision":"SKIP"}', total_cost_usd: 0.0123 })
  assert.deepEqual(extractResultFromJsonOutput(raw), { text: '{"decision":"SKIP"}', costUsd: 0.0123 })
})

test('extractResultFromJsonOutput falls back to raw text when not an envelope', () => {
  assert.deepEqual(extractResultFromJsonOutput('{"decision":"SKIP"}'), { text: '{"decision":"SKIP"}', costUsd: null })
})

test('evaluateReviewOutput treats an empty findings array as nothing to save', () => {
  assert.deepEqual(evaluateReviewOutput('{"findings": []}'), { kind: 'saves', saves: [] })
})

test('evaluateReviewOutput treats valid JSON without a findings array as nothing to save', () => {
  assert.deepEqual(evaluateReviewOutput('{"decision": "SKIP"}'), { kind: 'saves', saves: [] })
})

test('evaluateReviewOutput treats non-JSON output as unparseable', () => {
  assert.deepEqual(evaluateReviewOutput('Sorry, I cannot review this.'), { kind: 'unparseable' })
})

test('evaluateReviewOutput treats empty output as unparseable', () => {
  assert.deepEqual(evaluateReviewOutput(''), { kind: 'unparseable' })
})

test('buildTranscriptText formats [role] text joined by blank lines', () => {
  const text = buildTranscriptText([
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello' },
  ])
  assert.equal(text, '[user] hi\n\n[assistant] hello')
})

test('buildTranscriptText keeps the tail when over the cap', () => {
  const text = buildTranscriptText(
    [
      { role: 'user', text: 'old old old' },
      { role: 'assistant', text: 'the resolution' },
    ],
    20,
  )
  assert.equal(text.length, 20)
  assert.ok(text.endsWith('the resolution'))
})

test('deriveProjectName matches a registered project case-insensitively', () => {
  const projects = [{ name: 'claude-hub', path: 'C:\\projects\\claude-hub' }]
  const name = deriveProjectName(
    'C:/Users/x/.claude/projects/c--PROJECTS-claude-hub/abc.jsonl',
    projects,
  )
  assert.equal(name, 'claude-hub')
})

test('deriveProjectName falls back to the sanitized dirname when unregistered', () => {
  const name = deriveProjectName('C:/Users/x/.claude/projects/C--projects-mystery/abc.jsonl', [])
  assert.equal(name, 'C--projects-mystery')
})

// JSON.parse('null') succeeds but reading .findings off it throws — a model
// refusal reduced to 'null' must degrade to 'unparseable', not crash the hook.
test('evaluateReviewOutput treats a bare null / non-object as unparseable', () => {
  assert.equal(evaluateReviewOutput('null').kind, 'unparseable')
  assert.equal(evaluateReviewOutput('42').kind, 'unparseable')
  assert.equal(evaluateReviewOutput('"refused"').kind, 'unparseable')
})

// A sandbox experiment or worktree runs BELOW a registered project, so it has
// no exact dirname match. It used to fall back to the raw encoded dirname,
// which became the note's durable project: frontmatter and split one project
// across several keys in the vault (measured: 3 such notes).
test('deriveProjectName attributes a path below a registered project to that project', () => {
  const projects = [{ name: 'sandbox', path: 'C:\\projects\\claude-hub-sandbox' }]
  assert.equal(
    deriveProjectName(
      'C:/Users/x/.claude/projects/C--projects-claude-hub-sandbox-Improve-handoff-skill/a.jsonl',
      projects,
    ),
    'sandbox',
  )
})

test('deriveProjectName prefers the longest matching registered project', () => {
  const projects = [
    { name: 'hub', path: 'C:\\projects\\claude-hub' },
    { name: 'sandbox', path: 'C:\\projects\\claude-hub\\sandbox' },
  ]
  assert.equal(
    deriveProjectName('C:/Users/x/.claude/projects/C--projects-claude-hub-sandbox-exp/a.jsonl', projects),
    'sandbox',
  )
})

test('deriveProjectName does not let a project swallow a sibling with a longer name', () => {
  const projects = [{ name: 'sandbox', path: 'C:\\projects\\sandbox' }]
  // "C--projects-sandbox2" must NOT match the "C--projects-sandbox" project.
  assert.equal(
    deriveProjectName('C:/Users/x/.claude/projects/C--projects-sandbox2/a.jsonl', projects),
    'C--projects-sandbox2',
  )
})

test('deriveProjectName still returns the raw dirname with its original casing', () => {
  assert.equal(
    deriveProjectName('C:/Users/x/.claude/projects/C--projects-Mystery/a.jsonl', []),
    'C--projects-Mystery',
  )
})

// ---- the double-run guard ----
//
// Claude Code merges global and project hooks instead of letting the project
// win, so a project with its own scoped registration gets both firing on one
// SessionEnd. This is the check that makes the global run stand down. Both of
// its failure directions are silent and expensive: a false positive stops
// curating everywhere, a false negative pays twice on every session and
// queues the same finding into two stores.

function writeSettings(dir: string, file: string, settings: unknown): string {
  const claude = path.join(dir, '.claude')
  fs.mkdirSync(claude, { recursive: true })
  fs.writeFileSync(path.join(claude, file), JSON.stringify(settings, null, 2))
  return dir
}

function scopedHook(command: string) {
  return { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command }] }] } }
}

test('a project registering its own scoped curate hook is detected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-curate-scoped-'))
  writeSettings(dir, 'settings.json', scopedHook(
    'node C:/projects/claude-hub/scripts/curate-session.mjs --rubric .claude/_rubric.md --inbox .claude/_inbox.md',
  ))

  assert.equal(hasProjectScopedRegistration(dir), true)
})

test('settings.local.json counts too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-curate-local-'))
  writeSettings(dir, 'settings.local.json', scopedHook(
    'node C:/projects/claude-hub/scripts/curate-session.mjs --inbox notes/_inbox.md',
  ))

  assert.equal(hasProjectScopedRegistration(dir), true)
})

// The global registration itself has no --inbox. If this matched it, the hook
// would read its own global registration as a scoped one and stand down in
// every project at once.
test('a curate registration without --inbox is not a scoped one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-curate-global-'))
  writeSettings(dir, 'settings.json', scopedHook('node C:/projects/claude-hub/scripts/curate-session.mjs'))

  assert.equal(hasProjectScopedRegistration(dir), false)
})

// Some other hook that happens to pass --inbox is not this script.
test('another hook that takes an --inbox flag is not mistaken for it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-curate-other-'))
  writeSettings(dir, 'settings.json', scopedHook('node ./scripts/my-own-hook.mjs --inbox notes/_inbox.md'))

  assert.equal(hasProjectScopedRegistration(dir), false)
})

// Fails open in every direction — a project with no settings, unparseable
// settings, or a differently-shaped hooks block must leave curation running
// rather than silently disabling it.
test('an absent, unparseable or unfamiliar settings file leaves curation running', () => {
  const absent = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-curate-absent-'))
  assert.equal(hasProjectScopedRegistration(absent), false)

  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-curate-broken-'))
  fs.mkdirSync(path.join(broken, '.claude'))
  fs.writeFileSync(path.join(broken, '.claude', 'settings.json'), '{ not json')
  assert.equal(hasProjectScopedRegistration(broken), false)

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-curate-empty-'))
  writeSettings(empty, 'settings.json', {})
  assert.equal(hasProjectScopedRegistration(empty), false)
})

// ---- a project store's own dedup list ----

test('listStoreTitles reads findings and skips the store machinery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-curate-store-'))
  for (const name of ['A real finding.md', '_inbox.md', '_rubric.md', 'README.md', 'notes.txt']) {
    fs.writeFileSync(path.join(dir, name), 'x')
  }

  assert.deepEqual(listStoreTitles(dir), ['A real finding'])
})

test('listStoreTitles returns nothing for a store that is not there yet', () => {
  assert.deepEqual(listStoreTitles(path.join(os.tmpdir(), 'hub-curate-no-such-store')), [])
})

// ---- per-session idempotency ----
//
// SessionEnd fires again on every end of a resumed session, so without state the
// hook re-read and re-paid for transcripts it had already curated — $165 of $250
// lifetime spend. Both failure directions matter: skipping a session that grew
// loses a finding, and — the one the "no flag may mean both 'not yet' and
// 'never'" rule is about — a state file that cannot be read must not answer
// "already done" and silently switch the hook off everywhere.

const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-curate-state-'))
const SESSION = '4668f65e-aaa4-4081-b26d-8a2e71df0179'

test('a session never triaged before is triaged', () => {
  assert.equal(shouldTriageSession(stateDir(), SESSION, 40), true)
})

test('a session ending again unchanged is skipped', () => {
  const dir = stateDir()
  recordTriagedSession(dir, SESSION, 40)

  assert.equal(shouldTriageSession(dir, SESSION, 40), false)
})

test('a session that grew a little is still skipped', () => {
  const dir = stateDir()
  recordTriagedSession(dir, SESSION, 40)

  assert.equal(shouldTriageSession(dir, SESSION, 40 + MIN_GROWTH_FOR_RETRIAGE - 1), false)
})

test('a session that grew materially is triaged again', () => {
  const dir = stateDir()
  recordTriagedSession(dir, SESSION, 40)

  assert.equal(shouldTriageSession(dir, SESSION, 40 + MIN_GROWTH_FOR_RETRIAGE), true)
})

// Growth accrues against the last PAID run, not the last sighting — otherwise a
// session ending every few turns would drift past the threshold forever, three
// unread messages at a time.
test('growth is measured from the last triage, not the last sighting', () => {
  const dir = stateDir()
  recordTriagedSession(dir, SESSION, 100)

  assert.equal(shouldTriageSession(dir, SESSION, 103), false)
  assert.equal(shouldTriageSession(dir, SESSION, 106), false)
  assert.equal(shouldTriageSession(dir, SESSION, 100 + MIN_GROWTH_FOR_RETRIAGE), true)
})

test('an unreadable or garbled state entry falls back to triaging', () => {
  const dir = stateDir()
  for (const content of ['', '   ', 'not a number', '{"messages":40}', '-5']) {
    fs.writeFileSync(path.join(dir, SESSION), content)
    assert.equal(shouldTriageSession(dir, SESSION, 40), true, `content ${JSON.stringify(content)} must not skip`)
  }
})

test('a state directory that is not there falls back to triaging', () => {
  assert.equal(shouldTriageSession(path.join(os.tmpdir(), 'hub-curate-no-such-state'), SESSION, 40), true)
})

// A transcript shorter than the recorded count is not this transcript — a reused
// id, a rotated file. Trust the transcript rather than a state entry that
// describes something else.
test('a transcript shorter than the recorded count is triaged', () => {
  const dir = stateDir()
  recordTriagedSession(dir, SESSION, 400)

  assert.equal(shouldTriageSession(dir, SESSION, 40), true)
})

// A session id is a uuid. Anything else never becomes a path, and never gets to
// answer "already triaged" for whatever file that path would have landed on.
test('a session id that is not path-safe is triaged and writes nothing', () => {
  const dir = stateDir()
  recordTriagedSession(dir, '../escape', 40)

  assert.equal(shouldTriageSession(dir, '../escape', 40), true)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('recordTriagedSession creates the state directory on first use', () => {
  const dir = path.join(stateDir(), 'nested')
  recordTriagedSession(dir, SESSION, 40)

  assert.equal(shouldTriageSession(dir, SESSION, 40), false)
})

// Bounded, not unbounded: the state directory holds roughly a month of sessions
// because every paid run sweeps what has aged out.
test('pruneSessionState drops aged-out entries and keeps current ones', () => {
  const dir = stateDir()
  recordTriagedSession(dir, SESSION, 40)
  const old = path.join(dir, 'aaaaaaaa-0000-0000-0000-000000000000')
  fs.writeFileSync(old, '12')
  const longAgo = Date.now() / 1000 - 31 * 24 * 60 * 60
  fs.utimesSync(old, longAgo, longAgo)

  pruneSessionState(dir, Date.now())

  assert.deepEqual(fs.readdirSync(dir), [SESSION])
})
