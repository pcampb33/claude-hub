import { useMemo, type ReactNode } from 'react'
import { parseMarkdownLite, type MarkdownBlock } from './markdown-lite'
import { markText } from './mark-text'
import './markdown-lite.css'

// Component half of the in-house markdown-lite renderer — the grammar, the
// fallback contract, and parseMarkdownLite live in markdown-lite.ts.

// Inline rendering: **bold** first (a bold span may contain `code`, e.g.
// "**Evaluated `/loop` as a strategy.**"), then `code` spans within each
// side, then *italic* in what is left over — never inside a code span, where
// a "*" is literal. Unmatched markers stay literal.
//
// `highlight` is find-in-transcript's query: every text leaf goes through
// markText, so a find can mark its hits WITHOUT the caller having to drop
// back to unformatted text to get <mark> nodes.
function renderInline(text: string, highlight?: string): ReactNode[] {
  const out: ReactNode[] = []
  let k = 0
  const leaf = (seg: string): ReactNode => (highlight ? markText(seg, highlight) : seg)
  // Both markers must hug their content (no space just inside) and sit
  // against a non-word, non-"*" boundary outside, so "**/*.ts", "2 * 3" and
  // "a*b" stay literal. Measured over 120 real transcripts: 808 spans
  // matched, none of them a false positive.
  const pushEm = (seg: string, into: ReactNode[]) => {
    const re = /(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(seg))) {
      if (m.index > last) into.push(leaf(seg.slice(last, m.index)))
      into.push(<em key={k++}>{leaf(m[1])}</em>)
      last = m.index + m[0].length
    }
    if (last < seg.length) into.push(leaf(seg.slice(last)))
  }
  const pushCode = (seg: string, into: ReactNode[]) => {
    const re = /`([^`\n]+)`/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(seg))) {
      if (m.index > last) pushEm(seg.slice(last, m.index), into)
      into.push(<code key={k++}>{leaf(m[1])}</code>)
      last = m.index + m[0].length
    }
    if (last < seg.length) pushEm(seg.slice(last), into)
  }
  const re = /\*\*(.+?)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) pushCode(text.slice(last, m.index), out)
    const inner: ReactNode[] = []
    pushCode(m[1], inner)
    out.push(<strong key={k++}>{inner}</strong>)
    last = m.index + m[0].length
  }
  if (last < text.length) pushCode(text.slice(last), out)
  return out
}

function renderBlock(block: MarkdownBlock, key: number, highlight?: string): ReactNode {
  switch (block.kind) {
    case 'heading': {
      // h3/h4/h5 for #/##/### — real headings for structure, but never an
      // h1/h2 that would outrank the view's own chrome.
      const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1]
      return (
        <Tag key={key} className={`md-lite-h${block.level}`}>
          {renderInline(block.text, highlight)}
        </Tag>
      )
    }
    case 'para':
      return <p key={key}>{renderInline(block.text, highlight)}</p>
    case 'code':
      return (
        <pre key={key} className="md-lite-code">
          {highlight ? markText(block.text, highlight) : block.text}
        </pre>
      )
    case 'quote':
      return (
        <blockquote key={key} className="md-lite-quote">
          {renderInline(block.text, highlight)}
        </blockquote>
      )
    case 'rule':
      return <hr key={key} className="md-lite-rule" />
    case 'table':
      return (
        // The wrapper scrolls, not the page — a wide table must never make
        // its container scroll sideways.
        <div key={key} className="md-lite-tablewrap">
          <table className="md-lite-table">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                    {renderInline(cell, highlight)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ textAlign: block.align[c] ?? undefined }}>
                      {renderInline(cell, highlight)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag key={key}>
          {block.items.map((segs, idx) => (
            <li key={idx}>
              {segs.map((seg, j) =>
                seg.kind === 'text' ? (
                  j === 0 ? (
                    <span key={j}>{renderInline(seg.text, highlight)}</span>
                  ) : (
                    <p key={j} className="md-lite-aside">
                      {renderInline(seg.text, highlight)}
                    </p>
                  )
                ) : seg.ordered ? (
                  <ol key={j}>
                    {seg.items.map((s, si) => (
                      <li key={si}>{renderInline(s, highlight)}</li>
                    ))}
                  </ol>
                ) : (
                  <ul key={j}>
                    {seg.items.map((s, si) => (
                      <li key={si}>{renderInline(s, highlight)}</li>
                    ))}
                  </ul>
                ),
              )}
            </li>
          ))}
        </Tag>
      )
    }
  }
}

// Renders markdown-lite when the whole input fits the grammar; otherwise the
// entire input as a raw <pre> (never a half-formatted mix) — or `fallback`,
// for a caller whose own verbatim rendering already reads better than a
// monospace block (the session transcript's prose bubbles).
export function MarkdownLite({
  source,
  className,
  fallback,
  highlight,
}: {
  source: string
  className?: string
  fallback?: ReactNode
  highlight?: string
}) {
  const blocks = useMemo(() => parseMarkdownLite(source), [source])
  if (blocks === null) {
    if (fallback !== undefined) return <>{fallback}</>
    return <pre className={`md-lite-raw${className ? ` ${className}` : ''}`}>{source}</pre>
  }
  return (
    <div className={`md-lite${className ? ` ${className}` : ''}`}>
      {blocks.map((block, i) => renderBlock(block, i, highlight))}
    </div>
  )
}
