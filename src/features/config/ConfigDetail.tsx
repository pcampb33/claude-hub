import type { BoundaryView, DesktopTarget } from '../../../shared/ipc-types'
import { TierChip } from '../shared/TierChip'
import { SCOPE_LABEL, chipTier, settingsLocalPath, sortFindings } from './config-model.ts'
import { useProjectConfig, type BoundaryEntry } from './useConfig'
import { BoundaryCard } from './BoundaryCard'
import { AuditSection } from './AuditSection'
import { LayersSection } from './LayersSection'

export function ConfigDetail({
  target,
  targets,
  boundary,
  onBoundary,
  onRetryBoundary,
}: {
  target: DesktopTarget
  targets: DesktopTarget[]
  boundary: BoundaryEntry | null
  onBoundary: (view: BoundaryView) => void
  onRetryBoundary: () => void
}) {
  const config = useProjectConfig(target)
  const report = config.state.status === 'data' ? config.state.data : null
  const findings = report ? sortFindings(report.findings) : []

  return (
    <>
      <div className="cfg-head">
        <div>
          <h3>{target.name}</h3>
          <div className="cfg-sub">{target.kind === 'project' ? 'Project' : 'Sandbox experiment'}</div>
        </div>
        {boundary?.status === 'data' && <TierChip tier={chipTier(boundary.data.boundary)} title={boundary.data.guard.covers} />}
      </div>

      {findings.length > 0 && (
        <section className="cfg-card" aria-label="Findings">
          <h5>Findings</h5>
          <ul className="cfg-findings">
            {findings.map((f, i) => (
              <li key={i} data-severity={f.severity}>
                <span className="cfg-finding-mark" aria-label={f.severity === 'warn' ? 'Warning' : 'Note'}>
                  {f.severity === 'warn' ? '!' : 'i'}
                </span>
                <span>{f.text}</span>
                <em>{SCOPE_LABEL[f.layer]}</em>
              </li>
            ))}
          </ul>
        </section>
      )}

      <BoundaryCard
        target={target}
        targets={targets}
        entry={boundary}
        localPath={settingsLocalPath(report, target.name)}
        onSaved={onBoundary}
        onRetry={onRetryBoundary}
      />

      {/* The admin has no boundary, so there is nothing to audit. */}
      {!(boundary?.status === 'data' && boundary.data.boundary.admin) && <AuditSection target={target} />}

      <LayersSection state={config.state} onRetry={config.retry} />
    </>
  )
}
