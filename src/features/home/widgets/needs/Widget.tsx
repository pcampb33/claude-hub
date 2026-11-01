import { useWidgetMeta } from '../../frame-context'
import { usePeekTarget } from '../../peek-context'
import { Empty, Loading } from '../../parts'
import type { WidgetProps } from '../../types'
import { SOURCE_LABEL } from './needs-core'
import { useNeeds } from './useNeeds'
import './needs.css'

// Everything waiting on a decision, ranked. Each row opens the peek where
// the decision is made; a source that could not be read gets its own row
// rather than silently contributing nothing.
export function NeedsWidget({ size }: WidgetProps) {
  const { items, pending, unchecked } = useNeeds()
  const peekTarget = usePeekTarget()
  const max = size === 'M' ? 5 : 7
  const shown = items.slice(0, max)
  const more = items.length - shown.length

  useWidgetMeta(items.length > 0 ? `${items.length} waiting` : pending.length > 0 ? 'checking…' : null)

  if (items.length === 0 && unchecked.length === 0) {
    if (pending.length > 0) return <Loading rows={3} />
    return (
      <Empty title="Nothing needs you">
        Inbox clear, automations working, floors green, every CLAUDE.md at 80 or above, recall on track.
      </Empty>
    )
  }

  return (
    <div className="needs-list">
      {shown.map((it) => (
        <div key={it.key} className="need" {...peekTarget(it.peek.widget, it.peek.ctx, `${it.title}: ${it.cta}`)}>
          <span className={`need-badge tone-${it.tone}`}>{it.badge}</span>
          <span className="need-text">
            <b>{it.title}</b>
            <span>{it.sub}</span>
          </span>
          <span className={`need-cta${it.key === 'inbox' ? ' need-cta-primary' : ''}`}>{it.cta}</span>
        </div>
      ))}
      {unchecked.map((u) => (
        <div
          key={u.source}
          className="need need-unchecked"
          {...peekTarget('needs', null, `Couldn’t check ${SOURCE_LABEL[u.source]}: details`)}
        >
          <span className="need-badge tone-unknown">?</span>
          <span className="need-text">
            <b>Couldn’t check {SOURCE_LABEL[u.source]}</b>
            <span>{u.error}</span>
          </span>
          <span className="need-cta">Retry</span>
        </div>
      ))}
      {more > 0 && (
        <div className="need need-more" {...peekTarget('needs', null, `${more} more things need you`)}>
          <span className="need-text">
            <span>+{more} more</span>
          </span>
          <span className="need-cta">All</span>
        </div>
      )}
      {pending.length > 0 && (
        <div className="sub">Still checking {pending.map((k) => SOURCE_LABEL[k]).join(', ')}…</div>
      )}
    </div>
  )
}
