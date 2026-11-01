import type { ReactNode } from 'react'
import './widget-card.css'

// Titled surface container for dashboard and rail widgets. Optional header
// row (title + action). `padding` (default true) toggles body inset so lists
// can sit flush to the border.

export function WidgetCard({
  title,
  action,
  children,
  className,
  padding = true,
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
  padding?: boolean
}) {
  const hasHeader = title != null || action != null
  return (
    <section className={className ? `widget-card ${className}` : 'widget-card'}>
      {hasHeader && (
        <header className="widget-card-header">
          {title != null && <h3 className="widget-card-title">{title}</h3>}
          {action != null && <div className="widget-card-action">{action}</div>}
        </header>
      )}
      <div className={padding ? 'widget-card-body' : 'widget-card-body widget-card-body-flush'}>{children}</div>
    </section>
  )
}
