import type { ReactNode } from 'react'

// Small presentational pieces shared by every widget and peek, so the nine
// widgets read as one family. Styles live in home.css. Charts: single hue
// (var(--accent), with --text-faint for "muted") and direct labels — the
// theme palettes fail a multi-series categorical check.

// A peek section: small caps heading, then content.
export function Sec({ title, children, bare }: { title?: string; children: ReactNode; bare?: boolean }) {
  return (
    <section className={`sec${bare ? ' sec-bare' : ''}`}>
      {title && <h5>{title}</h5>}
      {children}
    </section>
  )
}

// Definition list: label → value rows.
export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

// A list of rows: text left, mono figure right. Pass `onOpen`-style props
// (from usePeekTarget) through `target` to make a row a peek link.
export function RowList({ children, tall }: { children: ReactNode; tall?: boolean }) {
  return <div className={`rowlist${tall ? ' rowlist-tall' : ''}`}>{children}</div>
}

export function Row({
  label,
  figure,
  target,
}: {
  label: ReactNode
  figure?: ReactNode
  target?: Record<string, unknown>
}) {
  return (
    <div className={`row${target ? ' row-go' : ''}`} {...target}>
      <span className="row-label">{label}</span>
      {figure != null && <em className="row-figure">{figure}</em>}
    </div>
  )
}

// A big number with a caption under it.
export function Big({ value, caption, tone }: { value: ReactNode; caption?: ReactNode; tone?: Tone }) {
  return (
    <div className="big-block">
      <div className={`big${tone ? ` tone-${tone}` : ''}`}>{value}</div>
      {caption && <div className="sub">{caption}</div>}
    </div>
  )
}

// A horizontal 0..1 bar.
export function Track({ value, muted, label }: { value: number; muted?: boolean; label: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className={`track${muted ? ' track-muted' : ''}`} role="img" aria-label={label}>
      <i style={{ width: `${pct}%` }} />
    </div>
  )
}

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'unknown' | 'accent'

// A status dot + word. `unknown` is uncoloured on purpose: a check that
// could not run is not a finding.
export function StatePill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`state-pill tone-${tone}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  )
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="actions">{children}</div>
}

// Buttons: primary (accent fill), ghost (outline), danger (red text).
export function Btn({
  children,
  onClick,
  kind = 'ghost',
  disabled,
  title,
}: {
  children: ReactNode
  onClick: () => void
  kind?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  title?: string
}) {
  return (
    <button type="button" className={`hbtn hbtn-${kind}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  )
}

// An honest empty state: something checked and found nothing.
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children && <span>{children}</span>}
    </div>
  )
}

// A source that could not be read. Never use Empty for this.
export function Unreachable({ what, error, onRetry }: { what: string; error: string; onRetry?: () => void }) {
  return (
    <div className="unreachable" role="status">
      <span>
        Couldn’t read {what}: {error}
      </span>
      {onRetry && (
        <button type="button" className="hbtn hbtn-ghost" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

// Placeholder rows while a source loads.
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="wd-loading" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="code">{children}</code>
}
