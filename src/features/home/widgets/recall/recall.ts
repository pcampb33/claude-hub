import type { RecallOffer, RecallScorecard, VaultNote } from '../../../../../shared/ipc-types'

// Per-note view of the recall scorecard. The scorecard is per session (an
// offer = one session's up-to-3 titles); the widget's question is per note:
// which notes keep getting offered and never opened.
export interface NoteStat {
  title: string
  offered: number // offers that included it, delivered or not
  delivered: number // of those, offers that reached a later prompt
  read: number // sessions that opened it after it was offered
  // Delivered offers where the transcript shows the offer and every tool call
  // parsed, yet the note was not opened. Only these count as "not read": a
  // missing transcript or unparseable lines leave the answer unknown.
  unread: number
  projects: string[] // distinct, most recent first
  dates: string[] // ISO attempt times, newest first
}

// Claude Code prunes old transcripts, so on real data most older deliveries
// land here as unknown rather than unread.
const confirmedUnread = (o: RecallOffer, title: string) =>
  o.delivered && o.transcriptFound && o.markerSeen && o.unparsedLines === 0 && !o.readTitles.includes(title)

// offers arrive newest first (RecallScorecard.offers), so first-seen order is
// recency order for projects and dates.
export function noteStats(offers: RecallOffer[]): NoteStat[] {
  const byTitle = new Map<string, NoteStat>()
  for (const o of offers) {
    for (const title of new Set(o.titles)) {
      let s = byTitle.get(title)
      if (!s) byTitle.set(title, (s = { title, offered: 0, delivered: 0, read: 0, unread: 0, projects: [], dates: [] }))
      s.offered++
      if (o.delivered) s.delivered++
      if (o.readTitles.includes(title)) s.read++
      if (confirmedUnread(o, title)) s.unread++
      if (o.project && !s.projects.includes(o.project)) s.projects.push(o.project)
      s.dates.push(o.at)
    }
  }
  return [...byTitle.values()]
}

// Reached a session and no read of it was found anywhere — most-offered
// first, since an offer that never pays off still costs a slot. "No read
// found" is not "never read": `unknown` says how many of its deliveries could
// not be checked (transcript pruned or unparseable), and the UI shows that.
export function neverRead(stats: NoteStat[]): NoteStat[] {
  return stats
    .filter((s) => s.read === 0 && s.delivered > 0)
    .sort((a, b) => b.offered - a.offered || b.unread - a.unread || a.title.localeCompare(b.title))
}

// Delivered offers whose read status can't be known.
export const unknownReads = (s: NoteStat) => s.delivered - s.read - s.unread

// A never-read row's figure: "0 read" only when every delivery was checked.
export function neverReadFigure(s: NoteStat): string {
  const unknown = unknownReads(s)
  return unknown > 0 ? `${s.offered}× · ${s.unread} unread, ${unknown} unknown` : `${s.offered}× · 0 read`
}

export function mostRead(stats: NoteStat[]): NoteStat[] {
  return stats
    .filter((s) => s.read > 0)
    .sort((a, b) => b.read - a.read || a.offered - b.offered || a.title.localeCompare(b.title))
}

// Offered titles are vault filenames (RecallOffer.titles), which is what a
// note id is; fall back to the parsed title for a renamed file.
export function findNoteId(notes: VaultNote[], title: string): string | null {
  return (notes.find((n) => n.id === title) ?? notes.find((n) => n.title === title))?.id ?? null
}

// The note's own text for a peek: no frontmatter, no linker-written related
// block, hard-wrapped prose paragraphs rejoined (vault notes wrap at ~100
// columns, which reads as ragged lines in a narrow panel), cut at a paragraph
// boundary near `max` characters.
export function notePreview(content: string, max = 900): { text: string; truncated: boolean } {
  let body = content.replace(/\r\n/g, '\n')
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---', 4)
    if (end !== -1) body = body.slice(body.indexOf('\n', end + 1) + 1)
  }
  const related = body.search(/^(## Related\b|<!-- computed-links:begin)/m)
  if (related !== -1) body = body.slice(0, related)
  body = body
    .trim()
    .split(/\n{2,}/)
    .map((para) => (/^\s*([-*#>|]|\d+\.|```)/m.test(para) ? para : para.replace(/\n/g, ' ')))
    .join('\n\n')
  if (body.length <= max) return { text: body, truncated: false }
  const cut = body.lastIndexOf('\n\n', max)
  return { text: body.slice(0, cut > max / 3 ? cut : max).trimEnd(), truncated: true }
}

export type StageKey = 'attempts' | 'offers' | 'delivered' | 'read'

export function funnelStages(s: RecallScorecard): { key: StageKey; label: string; value: number }[] {
  return [
    { key: 'attempts', label: 'Prompts checked', value: s.attempts },
    { key: 'offers', label: 'Note offered', value: s.offers.length },
    { key: 'delivered', label: 'Reached session', value: s.delivered },
    { key: 'read', label: 'Read (sessions)', value: s.readSessions },
  ]
}

// "38%", or "—" when the base is zero (no rate, rather than a fake 0%).
export function rate(n: number, of: number): string {
  return of > 0 ? `${Math.round((n / of) * 100)}%` : '—'
}

export function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
