import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  hasQueuedTitle,
  listVaultNoteNames,
  matchExistingTitle,
  queueVaultCandidate,
  removeInboxEntry,
  resolveVaultNotePath,
  writeVaultNote,
} from './vault-write-core.ts'
import { parseInbox } from './vault-inbox.ts'

// Mirrors queueVaultCandidate's real entry format: title heading, blank
// line, then the _metadata_ line naming the session. The '## Setup gotchas'
// line is an H2 inside the first entry's body (no metadata line follows).
const INBOX = `
## Vercel dashboard override gotcha

_2026-07-01 — project — session abc — (c) contradicted assumption_

Body text mentioning ## Windows hooks inline, not as a heading.

## Setup gotchas

More body detail under a heading inside this entry's content.

## Windows Stop hooks: Git Bash strips backslashes

_2026-07-01 — session def — (a) hard-won lesson_

Body.
`

test('hasQueuedTitle finds an exact heading match', () => {
  assert.equal(hasQueuedTitle(INBOX, 'Vercel dashboard override gotcha'), true)
  assert.equal(hasQueuedTitle(INBOX, 'Windows Stop hooks: Git Bash strips backslashes'), true)
})

test('hasQueuedTitle matches case-insensitively with surrounding whitespace', () => {
  assert.equal(hasQueuedTitle(INBOX, '  vercel DASHBOARD override gotcha '), true)
})

test('hasQueuedTitle does not match body text or partial headings', () => {
  assert.equal(hasQueuedTitle(INBOX, 'Windows hooks inline'), false)
  assert.equal(hasQueuedTitle(INBOX, 'Windows Stop hooks'), false)
})

test('hasQueuedTitle ignores H2 headings inside a queued entry body', () => {
  assert.equal(hasQueuedTitle(INBOX, 'Setup gotchas'), false)
})

test('hasQueuedTitle is false on an empty inbox', () => {
  assert.equal(hasQueuedTitle('', 'anything'), false)
})

test('queueVaultCandidate flags a repeat title as skippedDuplicate', () => {
  const inboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-')), '_inbox.md')
  const candidate = {
    title: 'Setup gotchas',
    content: 'Body with an inner heading:\n\n## Setup gotchas\n\nmore text',
    justification: '(a) hard-won lesson',
    sessionId: 's1',
  }
  const first = queueVaultCandidate(candidate, inboxPath)
  assert.equal(first.ok, true)
  assert.equal(first.skippedDuplicate, undefined)

  const second = queueVaultCandidate(candidate, inboxPath)
  assert.equal(second.skippedDuplicate, true)

  const text = fs.readFileSync(inboxPath, 'utf-8')
  assert.equal(text.match(/^## Setup gotchas$/gm)?.length, 2) // entry title + its body heading, no third
})

test('queueVaultCandidate writes a confidence segment that parseInbox reads back', () => {
  const inboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-conf-')), '_inbox.md')
  queueVaultCandidate(
    { title: 'Conf note', content: 'Body', justification: '(b) reusable', sessionId: 's2', confidence: 'medium' },
    inboxPath,
  )
  const [entry] = parseInbox(fs.readFileSync(inboxPath, 'utf-8'))
  assert.equal(entry.confidence, 'medium')
  assert.equal(entry.justification, '(b) reusable')
})

test('removeInboxEntry drops the matched entry and returns its content body', () => {
  const inboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-rm-')), '_inbox.md')
  queueVaultCandidate({ title: 'Keep me', content: 'keep body', justification: '(a) x', sessionId: 'k1' }, inboxPath)
  queueVaultCandidate({ title: 'Drop me', content: 'drop body\n\n## inner\n\nmore', justification: '(b) y', sessionId: 'd1' }, inboxPath)

  const before = fs.readFileSync(inboxPath, 'utf-8')
  const { text, content } = removeInboxEntry(before, 'Drop me', 'd1')

  assert.equal(content, 'drop body\n\n## inner\n\nmore')
  const remaining = parseInbox(text)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].title, 'Keep me')
})

test('removeInboxEntry returns null content and unchanged text when no entry matches', () => {
  const inbox = '\n## A\n\n_2026 — session s1 — (a) x_\n\nbody\n'
  const { text, content } = removeInboxEntry(inbox, 'A', 'WRONG-SESSION')
  assert.equal(content, null)
  assert.equal(text, inbox)
})

// A note name from a [[wikilink]] in index.md is used verbatim as a filename;
// containment must keep every write directly in the vault root.
test('resolveVaultNotePath keeps a plain note in the vault root', () => {
  const p = resolveVaultNotePath('Some Note')
  assert.ok(p && p.endsWith('Some Note.md'))
  // Same parent as any other plain note — the vault root, no subdirectory.
  assert.equal(path.dirname(p!), path.dirname(resolveVaultNotePath('Other')!))
  assert.equal(path.basename(path.dirname(p!)), 'claude-hub-vault')
})

test('resolveVaultNotePath rejects a parent-traversal note name (escapes the vault)', () => {
  assert.equal(resolveVaultNotePath('../evil'), null)
  assert.equal(resolveVaultNotePath('../../evil'), null)
})

test('resolveVaultNotePath rejects a folder-qualified name (would clobber MOCs/ etc.)', () => {
  assert.equal(resolveVaultNotePath('MOCs/Map of Content'), null)
  assert.equal(resolveVaultNotePath('sub/note'), null)
})

// A model-authored title with a newline used to split the '## title' line so
// the entry matched nothing on read — invisible and unremovable. Sanitized now.
test('queueVaultCandidate collapses a newline in the title so the entry stays findable/removable', () => {
  const inboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-nl-')), '_inbox.md')
  queueVaultCandidate(
    { title: 'A broken\ntitle over lines', content: 'body', justification: 'multi\nline\njust', sessionId: 's9' },
    inboxPath,
  )
  const text = fs.readFileSync(inboxPath, 'utf-8')
  // Exactly one entry heading, no stray '## ' from the split title.
  assert.equal(text.match(/^## /gm)?.length, 1)
  const entries = parseInbox(text)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, 'A broken title over lines')
  // And it can be removed (was previously unremovable).
  const { content } = removeInboxEntry(text, 'A broken title over lines', 's9')
  assert.equal(content, 'body')
})

// A re-queue of the same newline-title must dedup, not append a second copy.
test('queueVaultCandidate dedups a re-queued newline-title against its sanitized form', () => {
  const inboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-nl2-')), '_inbox.md')
  const c = { title: 'Same\ntitle', content: 'b', justification: '(a) x', sessionId: 's10' }
  assert.equal(queueVaultCandidate(c, inboxPath).skippedDuplicate, undefined)
  assert.equal(queueVaultCandidate(c, inboxPath).skippedDuplicate, true)
})

// --- dedup source of truth -------------------------------------------------
// Both cases below were measured in the real vault on 2026-08-17: 13 of 202
// notes on disk had no index.md line, and 1 index line named a deleted note.
// Dedup used to read only index.md, so it got both of them wrong.

test('matchExistingTitle finds a note that exists on disk but not in the index', () => {
  const onDisk = ['JUCE TooltipWindow asks only the component under the mouse', 'Windows Git Bash Hook Paths']
  assert.equal(
    matchExistingTitle('JUCE TooltipWindow asks only the component under the mouse', onDisk),
    'JUCE TooltipWindow asks only the component under the mouse',
  )
})

test('matchExistingTitle matches case-insensitively and ignores surrounding whitespace', () => {
  assert.equal(matchExistingTitle('  windows GIT bash hook paths ', ['Windows Git Bash Hook Paths']), 'Windows Git Bash Hook Paths')
})

test('matchExistingTitle does not match a title whose note is gone (stale index ghost)', () => {
  // The ghost line stays in index.md; with the directory as the source of
  // truth it can no longer resolve to an append against a missing file.
  assert.equal(matchExistingTitle('skyrim navmesh pathing', ['Windows Git Bash Hook Paths']), null)
})

test('matchExistingTitle returns null on an empty vault and does not partial-match', () => {
  assert.equal(matchExistingTitle('Anything', []), null)
  assert.equal(matchExistingTitle('Windows Git Bash', ['Windows Git Bash Hook Paths']), null)
})

// --- title ↔ filename parity ------------------------------------------------
// The stems handed to matchExistingTitle come off disk already sanitised; a
// title never is. Comparing them raw meant a title containing one of
// `\ / : * ? " < > |` could never match its own file, so writeVaultNote took
// its "this note is new" branch and truncated the note it should have appended
// to. Measured 2026-08-22: 64 of 205 notes in the live vault carry such a
// title, and the nightly unattended auto-promote writes through this path.

test('matchExistingTitle matches a colon title against its sanitised filename stem', () => {
  assert.equal(
    matchExistingTitle('SDK sessions bypass canUseTool: pin permissionMode', [
      'SDK sessions bypass canUseTool- pin permissionMode',
    ]),
    'SDK sessions bypass canUseTool- pin permissionMode',
  )
})

test('writeVaultNote appends to an existing note whose title contains a colon', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vault-'))
  const title = 'Windows Stop hooks: Git Bash strips backslashes'

  const first = writeVaultNote(title, 'first body', 'claude-hub', vault)
  const second = writeVaultNote(title, 'second body', 'claude-hub', vault)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.notePath, first.notePath) // the colon sanitises to '-' both times

  const text = fs.readFileSync(first.notePath!, 'utf-8')
  assert.match(text, /first body/) // the truncating write destroyed this
  assert.match(text, /second body/)
  // One note on disk under the sanitised name, and one index line naming it.
  assert.deepEqual(listVaultNoteNames(vault), ['Windows Stop hooks- Git Bash strips backslashes'])
  assert.equal(fs.readFileSync(path.join(vault, 'index.md'), 'utf-8').match(/\[\[/g)?.length, 1)
})

// Sanitising strips `\` and `/`, so a traversal-shaped title can no longer even
// reach resolveVaultNotePath's guard as a traversal. It must still land inside
// the vault rather than escape it — the containment property is unchanged.
test('writeVaultNote keeps a traversal-shaped title inside the vault root', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vault-esc-'))
  const result = writeVaultNote('../../evil', 'body', undefined, vault)
  assert.equal(result.ok, true)
  assert.equal(path.dirname(result.notePath!), path.resolve(vault))
  assert.equal(fs.existsSync(path.join(path.dirname(vault), 'evil.md')), false)
})

// The commit outcome rides `message` because VaultWriteResult is the IPC
// contract's type and has no field for it — a `failed` must be reported, not
// swallowed. The temp vault is deliberately not a git repo, which also pins
// that no git process ran: a bare "it passed" here would otherwise be
// indistinguishable from the commit branch never being reached.
test('writeVaultNote reports the vault commit outcome on message', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vault-git-'))
  const result = writeVaultNote('Plain note', 'body', undefined, vault)
  assert.equal(result.ok, true)
  assert.equal(result.message, 'not-a-repo')
})
