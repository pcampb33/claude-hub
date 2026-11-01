import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RecallOffer, VaultNote } from '../../../../../shared/ipc-types'
import { findNoteId, mostRead, neverRead, neverReadFigure, notePreview, noteStats, unknownReads } from './recall.ts'

function offer(o: Partial<RecallOffer>): RecallOffer {
  return {
    sessionId: 's',
    project: 'claude-hub',
    at: '2026-10-16T10:00:00Z',
    titles: [],
    delivered: true,
    transcriptFound: true,
    markerSeen: true,
    readTitles: [],
    unparsedLines: 0,
    ...o,
  }
}

// Newest first, as the scorecard delivers them.
const OFFERS: RecallOffer[] = [
  offer({ at: '2026-10-16T10:00:00Z', project: 'claude-hub', titles: ['Playbook', 'API key'], readTitles: ['API key'] }),
  offer({ at: '2026-10-14T10:00:00Z', project: 'sandbox', titles: ['Playbook', 'API key'] }),
  // Never reached a session: offered, but says nothing about reading.
  offer({ at: '2026-10-13T10:00:00Z', project: 'sandbox', titles: ['Playbook'], delivered: false }),
  // Transcript had unparseable lines: unknown, not "unread".
  offer({ at: '2026-10-12T10:00:00Z', project: 'chug', titles: ['Unknowable'], unparsedLines: 2 }),
  offer({ at: '2026-10-11T10:00:00Z', project: 'claude-hub', titles: ['Cron'], readTitles: ['Cron'] }),
]

test('per-note counts: offered, delivered, read, confirmed-unread', () => {
  const stats = new Map(noteStats(OFFERS).map((s) => [s.title, s]))
  const playbook = stats.get('Playbook')!
  assert.deepEqual(
    { offered: playbook.offered, delivered: playbook.delivered, read: playbook.read, unread: playbook.unread },
    { offered: 3, delivered: 2, read: 0, unread: 2 },
  )
  assert.deepEqual(playbook.projects, ['claude-hub', 'sandbox'])
  assert.deepEqual(playbook.dates, ['2026-10-16T10:00:00Z', '2026-10-14T10:00:00Z', '2026-10-13T10:00:00Z'])
  const key = stats.get('API key')!
  assert.equal(key.read, 1)
  assert.equal(key.unread, 1)
  assert.equal(stats.get('Unknowable')!.unread, 0)
})

test('no-read list: delivered, zero reads, most offered first; unknowns are counted, not hidden', () => {
  const never = neverRead(noteStats(OFFERS))
  assert.deepEqual(
    never.map((s) => s.title),
    ['Playbook', 'Unknowable'],
  )
  assert.equal(unknownReads(never[0]), 0)
  assert.equal(unknownReads(never[1]), 1) // its one delivery had unparseable lines
  // The row figure says "0 read" only when every delivery was checked.
  assert.match(neverReadFigure(never[0]), /· 0 read$/)
  assert.equal(neverReadFigure(never[1]), '1× · 0 unread, 1 unknown')
})

test('most-read ranks by reads', () => {
  const titles = mostRead(noteStats(OFFERS)).map((s) => s.title)
  assert.deepEqual(titles, ['Cron', 'API key']) // tie on reads → fewer offers first (better hit rate)
})

test('a title appearing twice in one offer counts once', () => {
  const [s] = noteStats([offer({ titles: ['A', 'A'] })])
  assert.equal(s.offered, 1)
})

test('title → note id: filename first, parsed title as fallback', () => {
  const note = (id: string, title: string) => ({ id, title }) as VaultNote
  const notes = [note('Doc pointers rot', 'Doc file-line pointers rot silently'), note('Playbook', 'Playbook')]
  assert.equal(findNoteId(notes, 'Playbook'), 'Playbook')
  assert.equal(findNoteId(notes, 'Doc file-line pointers rot silently'), 'Doc pointers rot')
  assert.equal(findNoteId(notes, 'Gone'), null)
})

test('preview drops frontmatter and the Related block, cuts at a paragraph', () => {
  const content = '---\nproject: x\n---\n# Title\n\nFirst para.\n\nSecond para.\n\n## Related\n- [[a]]\n'
  assert.deepEqual(notePreview(content), { text: '# Title\n\nFirst para.\n\nSecond para.', truncated: false })
  const wrapped = 'Line one\nline two.\n\n- a\n- b\n\n<!-- computed-links:begin -->\n## Related\n'
  assert.deepEqual(notePreview(wrapped), { text: 'Line one line two.\n\n- a\n- b', truncated: false })
  const long = `${'a'.repeat(500)}\n\n${'b'.repeat(500)}`
  assert.deepEqual(notePreview(long, 900), { text: 'a'.repeat(500), truncated: true })
})
