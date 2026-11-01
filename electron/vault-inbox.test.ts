import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInbox, resolveInboxEntry } from './vault-inbox.ts'
import { queueVaultCandidate } from './vault-write-core.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const INBOX = `
## Vercel dashboard override gotcha

_2026-07-01T10:00:00.000Z — claude-hub — session abc — (c) contradicted assumption_

Body text mentioning ## Windows hooks inline, not as a heading.

## Setup gotchas

More body detail under a heading inside this entry's content.

## Windows Stop hooks: Git Bash strips backslashes

_2026-07-01T11:00:00.000Z — session def — (a) hard-won lesson_

Body.
`

test('parseInbox extracts entries with and without a project label', () => {
  const entries = parseInbox(INBOX)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], {
    title: 'Vercel dashboard override gotcha',
    timestamp: '2026-07-01T10:00:00.000Z',
    project: 'claude-hub',
    sessionId: 'abc',
    justification: '(c) contradicted assumption',
    confidence: null,
  })
  assert.deepEqual(entries[1], {
    title: 'Windows Stop hooks: Git Bash strips backslashes',
    timestamp: '2026-07-01T11:00:00.000Z',
    project: null,
    sessionId: 'def',
    justification: '(a) hard-won lesson',
    confidence: null,
  })
})

test('parseInbox extracts a confidence segment when present', () => {
  const text = `
## Note with confidence

_2026-07-05T00:00:00.000Z — claude-hub — session xyz — high — (b) reusable pattern_

Body.
`
  const [entry] = parseInbox(text)
  assert.equal(entry.confidence, 'high')
  assert.equal(entry.justification, '(b) reusable pattern')
  assert.equal(entry.sessionId, 'xyz')
})

test('parseInbox ignores H2 headings inside a queued entry body', () => {
  assert.equal(parseInbox(INBOX).some((e) => e.title === 'Setup gotchas'), false)
})

test('parseInbox is empty on empty input', () => {
  assert.deepEqual(parseInbox(''), [])
})

test('resolveInboxEntry reject drops the entry from the queue', () => {
  const inboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-resolve-')), '_inbox.md')
  queueVaultCandidate({ title: 'Keep', content: 'k', justification: '(a) x', sessionId: 'k1' }, inboxPath)
  queueVaultCandidate({ title: 'Toss', content: 't', justification: '(b) y', sessionId: 't1' }, inboxPath)

  const res = resolveInboxEntry('t1', 'Toss', 'reject', inboxPath)
  assert.equal(res.ok, true)

  const remaining = parseInbox(fs.readFileSync(inboxPath, 'utf-8'))
  assert.deepEqual(remaining.map((e) => e.title), ['Keep'])
})

test('resolveInboxEntry reports not-found for a stale/mismatched key', () => {
  const inboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-resolve2-')), '_inbox.md')
  queueVaultCandidate({ title: 'Only', content: 'o', justification: '(a) x', sessionId: 's1' }, inboxPath)
  const res = resolveInboxEntry('WRONG', 'Only', 'reject', inboxPath)
  assert.equal(res.ok, false)
  // The queue is left intact when nothing matched.
  assert.equal(parseInbox(fs.readFileSync(inboxPath, 'utf-8')).length, 1)
})

test('parseInbox round-trips what queueVaultCandidate writes', () => {
  const inboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-parse-')), '_inbox.md')
  queueVaultCandidate(
    {
      title: 'Round trip',
      content: 'Body\n\n## Inner heading\n\nmore',
      justification: '(b) reusable pattern',
      sessionId: 's9',
      projectName: 'demo',
    },
    inboxPath,
  )
  const entries = parseInbox(fs.readFileSync(inboxPath, 'utf-8'))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, 'Round trip')
  assert.equal(entries[0].project, 'demo')
  assert.equal(entries[0].sessionId, 's9')
  assert.equal(entries[0].justification, '(b) reusable pattern')
})
