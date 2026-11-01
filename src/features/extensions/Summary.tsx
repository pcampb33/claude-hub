import { useEffect, useState } from 'react'
import type { ExtensionItem, ExtensionsSnapshot } from '../../../shared/ipc-types'
import { relativeTime } from '../shared/relative-time'
import { kpis, TYPES, type Bucket, type TypeFilter } from './model'

// "checked 4m ago" / "checking…" / "check failed", beside Recheck. Ticks once
// a minute so the age doesn't freeze while the page sits open.
export function HealthStatus({ health, rechecking }: { health: ExtensionsSnapshot['health']; rechecking: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const ago = health.checkedAtIso ? `checked ${relativeTime(health.checkedAtIso, now)}` : null
  let text: string
  if (rechecking || health.state === 'running') text = ago ? `checking… (last ${ago})` : 'checking servers…'
  else if (health.state === 'error') text = `check failed${ago ? ` · last good ${ago}` : ''}`
  else text = ago ?? 'never checked'
  return (
    <span className={`ext-checked${health.state === 'error' && !rechecking ? ' is-error' : ''}`} title={health.error ?? undefined}>
      {text}
    </span>
  )
}

export function Kpis({
  snap,
  active,
  onToggle,
}: {
  snap: ExtensionsSnapshot
  active: Bucket | null
  onToggle: (b: Bucket) => void
}) {
  const tiles = kpis(snap)
  const work = tiles[0].value
  return (
    <>
      <p className="ext-headline">
        {work === null ? (
          <>
            {snap.items.length} extensions; {snap.usage.running ? 'usage is still being scanned' : 'usage unavailable'}
          </>
        ) : (
          <>
            <em>{work} do the work</em>, {snap.items.length - work} don’t
          </>
        )}
      </p>
      <div className="ext-kpis">
        {tiles.map((k) => (
          <button
            type="button"
            key={k.key}
            className="ext-kpi"
            data-tone={k.tone}
            aria-pressed={active === k.key}
            onClick={() => onToggle(k.key)}
          >
            <span className="ext-kpi-n">{k.value ?? '?'}</span>
            <b>{k.label}</b>
            <span className="ext-kpi-sub">{k.sub}</span>
          </button>
        ))}
      </div>
    </>
  )
}

export function TypeTabs({
  items,
  active,
  onChange,
}: {
  items: ExtensionItem[]
  active: TypeFilter
  onChange: (t: TypeFilter) => void
}) {
  return (
    <div className="ext-tabs" role="group" aria-label="Filter by type">
      {TYPES.map((t) => (
        <button type="button" key={t.key} className="ext-tab" aria-pressed={active === t.key} onClick={() => onChange(t.key)}>
          {t.label} <span>{t.key === 'all' ? items.length : items.filter((i) => i.kind === t.key).length}</span>
        </button>
      ))}
    </div>
  )
}
