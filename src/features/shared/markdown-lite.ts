// Parser half of the in-house markdown-lite renderer (the component lives in
// MarkdownLite.tsx; split so the component file only exports components). The
// grammar is ONLY: #–### headings, **bold**, *italic*, `inline code`, fenced
// code blocks, -/* unordered + 1. ordered lists (one nesting level of either
// under either), GFM pipe tables, blockquotes, and thematic breaks. Anything
// outside that grammar — block HTML, #### headings, deeper nesting, indented
// code, malformed fences — is "surprising": parseMarkdownLite returns null
// and the caller renders the ENTIRE input as a raw <pre> (or its own
// fallback) instead of guessing. Inline oddities (unmatched ** or `) just
// render literally — they can't misrepresent structure the way a half-parsed
// block can.
//
// Tables/quotes/rules/nested-ordered were added for the session transcript,
// where the corpus is Claude's own prose rather than a curated LEARNINGS.md:
// measured over 120 real transcripts, 87 of 2331 assistant turns fell back,
// and tables alone accounted for 73 of them.

export type MarkdownAlign = 'left' | 'center' | 'right' | null

export type MarkdownListSegment =
  | { kind: 'text'; text: string } // item text (first) or a follow-on paragraph inside the item
  | { kind: 'sub'; ordered: boolean; items: string[] } // one nested list

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; header: string[]; align: MarkdownAlign[]; rows: string[][] }
  | { kind: 'list'; ordered: boolean; items: MarkdownListSegment[][] }

const TOP_UL = /^[-*]\s+(.*)$/
const TOP_OL = /^\d{1,3}\.\s+(.*)$/

// Structural line starts that end a paragraph (the outer loop reprocesses
// them, so fallback triggers among them still fall back).
function endsParagraph(line: string): boolean {
  const t = line.trim()
  if (t === '') return true
  if (/^(#|```|\||<|>)/.test(t)) return true
  if (/^(-{3,}|\*{3,}|={3,})$/.test(t)) return true
  if (line !== line.trimStart()) return true // indented → list continuation or surprising
  return TOP_UL.test(line) || TOP_OL.test(line)
}

// A GFM delimiter row: the line under a table header, e.g. "|---|:--:|---:|".
const TABLE_DELIM = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/

// Cells split on unescaped pipes, with the optional outer pipes removed.
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim())
}

// A header row plus its delimiter row, then body rows until the pipes stop.
// A "|" line WITHOUT a delimiter row under it is not a table — null here, so
// the caller falls back rather than inventing a one-column table.
function parseTable(lines: string[], start: number): { block: MarkdownBlock; next: number } | null {
  const delim = lines[start + 1]
  if (delim === undefined || !TABLE_DELIM.test(delim.trim())) return null
  const header = splitRow(lines[start])
  const specs = splitRow(delim)
  if (specs.length !== header.length) return null
  const align: MarkdownAlign[] = specs.map((spec) => {
    const left = spec.startsWith(':')
    const right = spec.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
  const rows: string[][] = []
  let i = start + 2
  while (i < lines.length) {
    const line = lines[i]
    if (line.trimStart() !== line || !line.trim().startsWith('|')) break
    const cells = splitRow(line)
    // GFM pads a short row and drops the overflow of a long one, so a ragged
    // table still renders instead of dropping the whole turn to plain text.
    while (cells.length < header.length) cells.push('')
    rows.push(cells.slice(0, header.length))
    i++
  }
  return { block: { kind: 'table', header, align, rows }, next: i }
}

export function parseMarkdownLite(source: string): MarkdownBlock[] | null {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') {
      i++
      continue
    }
    if (line.startsWith('\t')) return null // tab indentation — ambiguous, fall back

    // Fenced code block — only recognized at column 0; a plain ``` or
    // ```lang opener, closed by a bare ``` line. Anything else is malformed.
    if (trimmed.startsWith('```')) {
      if (line !== trimmed || !/^```[A-Za-z0-9_-]*$/.test(trimmed)) return null
      const buf: string[] = []
      i++
      let closed = false
      while (i < lines.length) {
        if (lines[i].trim() === '```') {
          closed = true
          i++
          break
        }
        buf.push(lines[i])
        i++
      }
      if (!closed) return null
      blocks.push({ kind: 'code', text: buf.join('\n') })
      continue
    }

    // Surprising block constructs → hard fallback.
    if (/^#{4,}/.test(trimmed)) return null
    if (trimmed.startsWith('<')) return null
    if (/^ {4,}/.test(line)) return null // indented code block — unsupported
    if (line !== trimmed) return null // stray indented line outside a list

    // Everything below is at column 0, guaranteed by the check above.

    if (/^(-{3,}|\*{3,}|={3,})$/.test(trimmed)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }

    // Blockquote: consecutive "> " lines, inline content only. A quote
    // carrying its own block structure (a nested quote, a fence, a table, a
    // list) is still surprising — a half-formatted quote is exactly the
    // misrepresentation the fallback exists to prevent.
    if (trimmed.startsWith('>')) {
      const quoted: string[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        if (!t.startsWith('>')) break
        const inner = t.replace(/^>\s?/, '')
        if (/^(>|```|\||#|[-*]\s|\d{1,3}\.\s)/.test(inner)) return null
        quoted.push(inner)
        i++
      }
      blocks.push({ kind: 'quote', text: quoted.join(' ').trim() })
      continue
    }

    if (trimmed.startsWith('|')) {
      const table = parseTable(lines, i)
      if (!table) return null
      blocks.push(table.block)
      i = table.next
      continue
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length as 1 | 2 | 3, text: h[2].trim() })
      i++
      continue
    }

    if (TOP_UL.test(line) || TOP_OL.test(line)) {
      const ordered = TOP_OL.test(line)
      const items: MarkdownListSegment[][] = []
      let cur: MarkdownListSegment[] | null = null
      // Where a wrapped continuation line appends: the current item's leading
      // text, a follow-on paragraph, or the last nested item.
      let appendTo: ((extra: string) => void) | null = null
      let blankPending = false
      // Indent of the first nested marker — a later, deeper marker is a
      // third level (2-space styles slip past the absolute guards below).
      let subIndent: number | null = null
      while (i < lines.length) {
        const l = lines[i]
        const t = l.trim()
        if (t === '') {
          blankPending = true
          i++
          continue
        }
        if (l.startsWith('\t')) return null
        const indent = l.length - l.trimStart().length
        if (indent === 0) {
          const m = ordered ? TOP_OL.exec(l) : TOP_UL.exec(l)
          if (!m) break // other list kind or non-list line — outer loop reprocesses
          const seg = { kind: 'text' as const, text: m[1].trim() }
          cur = [seg]
          items.push(cur)
          appendTo = (extra) => {
            seg.text += ` ${extra}`
          }
          blankPending = false
          i++
          continue
        }
        // Indented content belongs to the current item — but a structural
        // block (fence, table, HTML, blockquote, heading, rule) indented
        // under an item must not be absorbed as continuation text: that
        // would render a half-formatted mix. Hard fallback instead.
        if (!cur) return null
        if (/^(```|\||<|>|#)/.test(t)) return null
        if (/^(-{3,}|\*{3,}|={3,})$/.test(t)) return null
        if (indent > 8) return null // deeper than one nesting level — fall back
        const subOl = /^\d{1,3}\.\s+(.*)$/.exec(t)
        const subM = /^[-*]\s+(.*)$/.exec(t) ?? subOl
        if (subM) {
          if (indent > 5) return null // marker indented past one level
          if (subIndent === null) subIndent = indent
          else if (indent > subIndent) return null // deeper than the first marker — third level
          const subOrdered = subOl !== null
          let seg = cur[cur.length - 1]
          // A switch of marker kind at the same level starts a second nested
          // list rather than mixing <li>s of both into one.
          if (seg.kind !== 'sub' || seg.ordered !== subOrdered) {
            seg = { kind: 'sub', ordered: subOrdered, items: [] }
            cur.push(seg)
          }
          const sub = seg
          sub.items.push(subM[1].trim())
          appendTo = (extra) => {
            sub.items[sub.items.length - 1] += ` ${extra}`
          }
          blankPending = false
          i++
          continue
        }
        if (blankPending) {
          // Blank line then indented text — a follow-on paragraph in the item.
          const seg = { kind: 'text' as const, text: t }
          cur.push(seg)
          appendTo = (extra) => {
            seg.text += ` ${extra}`
          }
          blankPending = false
          i++
          continue
        }
        // Wrapped line of whatever we appended to last.
        if (!appendTo) return null
        appendTo(t)
        i++
        continue
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    // Paragraph: consecutive plain-text lines joined with a space.
    const buf: string[] = [trimmed]
    i++
    while (i < lines.length && !endsParagraph(lines[i])) {
      buf.push(lines[i].trim())
      i++
    }
    blocks.push({ kind: 'para', text: buf.join(' ') })
  }
  return blocks
}
