// Defensive parser for the vault's RUBRIC.md so the landing surface can be a
// READ view instead of a raw textarea. It only recognizes the document's
// known shape — a "keep" bullet list of **titled** criteria, a "Reject if"
// bullet list, a "Tie-breaker:" paragraph, and an "Every note states"
// paragraph. Section headings may drift in wording; matching is by keyword.
// If the keep or reject structure isn't there, parseRubric returns null and
// the view degrades to the raw textarea — it never invents content.

export interface RubricKeepCriterion {
  title: string
  desc: string
  test: string | null // a trailing "(... test.)" parenthetical, pulled out as a footnote
}

export interface ParsedRubric {
  keepIntro: string
  keep: RubricKeepCriterion[]
  rejectIntro: string
  reject: string[]
  tiebreak: string | null
  anatomyLead: string | null
  anatomy: string[]
}

// Collects a `- ` bullet list starting at lines[start]; wrapped continuation
// lines (indented, non-bullet) join their item. Returns the joined items.
function collectBullets(lines: string[], start: number): { items: string[]; next: number } {
  const items: string[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()
    if (t === '') {
      // Blank line: the list continues only if another bullet follows next.
      if (i + 1 < lines.length && /^-\s+/.test(lines[i + 1])) {
        i++
        continue
      }
      break
    }
    const m = /^-\s+(.*)$/.exec(line)
    if (m) {
      items.push(m[1].trim())
      i++
      continue
    }
    if (/^\s+\S/.test(line) && items.length > 0) {
      items[items.length - 1] += ` ${t}`
      i++
      continue
    }
    break
  }
  return { items, next: i }
}

// Joins a paragraph starting mid-line: the remainder of lines[start] after
// the prefix plus following non-blank, non-bullet lines. `next` is the first
// line NOT part of the paragraph, so callers can claim the consumed range.
function collectParagraph(lines: string[], start: number, firstText: string): { text: string; next: number } {
  const parts = firstText.trim() === '' ? [] : [firstText.trim()]
  let i = start + 1
  while (i < lines.length) {
    const t = lines[i].trim()
    if (t === '' || t.startsWith('-') || t.startsWith('#')) break
    parts.push(t)
    i++
  }
  return { text: parts.join(' '), next: i }
}

function parseKeepItem(raw: string): RubricKeepCriterion | null {
  const m = /^\*\*(.+?)\*\*\s*[—–-]+\s*(.*)$/.exec(raw)
  if (!m) return null
  let desc = m[2].trim()
  let test: string | null = null
  const paren = /\s*\(([^()]*\btest\b[^()]*)\)\s*$/i.exec(desc)
  if (paren) {
    test = paren[1].trim().replace(/\.$/, '').replace(/^The /, 'the ')
    desc = desc.slice(0, paren.index).trim()
  }
  return { title: m[1].trim(), desc, test }
}

export function parseRubric(md: string): ParsedRubric | null {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  // Every non-blank line must be claimed by a recognized construct. An
  // unrecognized paragraph or extra section would otherwise be silently
  // dropped from the read view — the one thing this surface must never do.
  const claimed = new Array<boolean>(lines.length).fill(false)

  // The document's leading `# ` title — the view chrome already titles it.
  const firstIdx = lines.findIndex((l) => l.trim() !== '')
  if (firstIdx !== -1 && /^# /.test(lines[firstIdx])) claimed[firstIdx] = true

  let keepIntro: string | null = null
  let keep: RubricKeepCriterion[] = []
  let rejectIntro: string | null = null
  let reject: string[] = []
  let tiebreak: string | null = null
  let anatomyLead: string | null = null
  let anatomy: string[] = []

  const claim = (from: number, to: number) => {
    for (let j = from; j < to; j++) claimed[j] = true
  }

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '' || t.startsWith('#') || t.startsWith('-')) continue

    if (keepIntro === null && /\bonly if\b/i.test(t)) {
      keepIntro = t.replace(/:\s*$/, '')
      const { items, next } = collectBullets(lines, i + 1)
      const parsed = items.map(parseKeepItem)
      if (parsed.some((p) => p === null)) return null // keep bullets must be **titled**
      keep = parsed as RubricKeepCriterion[]
      claim(i, next)
      continue
    }
    if (rejectIntro === null && /^reject if\b/i.test(t)) {
      rejectIntro = t.replace(/:\s*$/, '')
      const { items, next } = collectBullets(lines, i + 1)
      reject = items
      claim(i, next)
      continue
    }
    const tb = /^tie-?breaker\s*:\s*(.*)$/i.exec(t)
    if (tiebreak === null && tb) {
      const para = collectParagraph(lines, i, tb[1])
      tiebreak = para.text
      claim(i, para.next)
      continue
    }
    const an = /^(every note states (?:three|\d+) things)\s*:\s*(.*)$/i.exec(t)
    if (anatomyLead === null && an) {
      anatomyLead = `${an[1]}:`
      const para = collectParagraph(lines, i, an[2])
      const body = para.text.replace(/\.\s*$/, '')
      // "the finding (one sentence), why ..., and how ..." → one pill each,
      // trailing parentheticals folded in as "— ..." clauses.
      anatomy = body
        .split(/,\s+(?:and\s+)?/)
        .map((p) => p.trim().replace(/\s*\(([^()]+)\)$/, ' — $1'))
        .filter((p) => p !== '')
      claim(i, para.next)
      continue
    }
  }

  // The read view is only honest when both core sections parsed.
  if (keepIntro === null || rejectIntro === null || keep.length < 2 || reject.length < 2) return null
  // ...and when nothing was left over: unclaimed content → the raw textarea.
  for (let i = 0; i < lines.length; i++) {
    if (!claimed[i] && lines[i].trim() !== '') return null
  }
  return { keepIntro, keep, rejectIntro, reject, tiebreak, anatomyLead, anatomy }
}
