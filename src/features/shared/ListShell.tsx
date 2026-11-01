import type { ReactNode } from 'react'
import './list-shell.css'

// Shared list-shell primitives for master-column list views (Skills,
// Workflows, Commands…): a filter input with its count pill, the inset mono
// group heading (collapsible when given onToggle), and the bordered
// row-list container. Row buttons stay per-view — only the shell is shared.

export function ListFilter({
  value,
  onChange,
  placeholder,
  count,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  count: number
  ariaLabel: string
}) {
  return (
    <div className="list-filter">
      <input
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
      />
      <span className="list-filter-count">{count}</span>
    </div>
  )
}

export function ListGroupHead({
  label,
  count,
  collapsed = false,
  onToggle,
}: {
  label: string
  count: number
  collapsed?: boolean
  onToggle?: () => void
}) {
  if (!onToggle) {
    return (
      <div className="list-group-head">
        <span className="list-group-name">{label}</span>
        <span className="list-group-count">{count}</span>
      </div>
    )
  }
  return (
    <button type="button" className="list-group-head" onClick={onToggle} aria-expanded={!collapsed}>
      <span className={`list-group-caret${collapsed ? '' : ' open'}`}>▸</span>
      <span className="list-group-name">{label}</span>
      <span className="list-group-count">{count}</span>
    </button>
  )
}

// The bordered scroll container the rows live in. className lets a view keep
// its own height cap (e.g. `.skills-view .list-rows { max-height: … }` works
// too — the prop exists for row-level styling hooks, not layout overrides).
export function ListRows({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`list-rows${className ? ` ${className}` : ''}`}>{children}</div>
}
