import type { GlobalAutomation, GlobalItemState } from '../../../shared/ipc-types'
import { ErrorNotice } from '../shared/ErrorNotice'
import { ViewHeader, RefreshAction } from '../shared/ViewHeader'
import { useReportLoading } from '../shared/appLoading'
import { relativeTime } from '../shared/relative-time'
import { useGlobalConfig } from './useGlobalConfig'
import { ThemePicker } from './ThemePicker'
import { Footprint } from './Footprint'
import './global.css'

// The layer above every project. Deliberately one page of rows rather than a
// master-detail: there are six automations, and the thing you came to find out
// ("is any of this broken?") has to be answerable without clicking anything.
//
// Every row states whether the thing is DOING ITS JOB. "Configured" is not a
// state here — Task Scheduler said `Running` for a server task on a day it
// was not reachable.

const BADGE: Record<GlobalItemState, { className: string; label: string }> = {
  ok: { className: 'badge badge-clean', label: 'working' },
  attention: { className: 'badge badge-missing', label: 'needs attention' },
  // Uncoloured, like the feed's unknown dot: a check that could not be made is
  // not a finding, and must not read as one.
  unknown: { className: 'badge badge-neutral', label: 'unknown' },
}

function AutomationRow({
  item,
  busy,
  onRun,
  onOpenLog,
}: {
  item: GlobalAutomation
  busy: boolean
  onRun: (taskName: string) => void
  onOpenLog: (logId: string) => void
}) {
  const nowMs = Date.now()
  return (
    <div className={`global-row global-row-${item.state}`}>
      <div className="global-row-main">
        <div className="global-row-head">
          <span className={BADGE[item.state].className}>{BADGE[item.state].label}</span>
          <span className="global-row-name">{item.label}</span>
          <span className="global-row-trigger">{item.trigger}</span>
        </div>
        <div className="global-row-detail">{item.detail}</div>
        {item.warnings.map((w) => (
          <div className="global-row-warning" key={w}>
            {w}
          </div>
        ))}
        {item.command && <code className="global-row-command">{item.command}</code>}
        <div className="global-row-meta">
          {item.lastRunIso ? `last run ${relativeTime(item.lastRunIso, nowMs)}` : 'no run recorded'}
        </div>
      </div>
      <div className="global-row-actions">
        {item.taskName && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => onRun(item.taskName!)}
            // Starting an already-running task is a silent no-op under
            // IgnoreNew, so the button says what the main process actually does.
            title={item.running ? 'Stop and start this task now' : 'Start this task now'}
          >
            {busy ? 'Working…' : item.running ? 'Restart' : 'Run now'}
          </button>
        )}
        {item.logId && (
          <button type="button" className="btn-ghost" onClick={() => onOpenLog(item.logId!)}>
            Log
          </button>
        )}
      </div>
    </div>
  )
}

export function GlobalView() {
  const { report, loading, error, refresh, runTask, busyTask, actionError, openFile } = useGlobalConfig()
  useReportLoading(loading)

  const scheduled = report?.automations.filter((a) => a.kind === 'scheduled') ?? []
  const hooks = report?.automations.filter((a) => a.kind === 'hook') ?? []
  const settings = report?.settings

  return (
    <section className="global-view">
      <ViewHeader
        title="Settings"
        subtitle="The app's theme, what claude-hub applies outside its own folder, then everything that runs on a schedule, runs in your sessions, or applies to every project. Each row is graded on whether it is doing its job — not on whether it is configured, which is a different question and the one that hides broken automation."
        actions={<RefreshAction loading={loading} onClick={() => refresh()} />}
      />
      {error && <ErrorNotice message={error} onRetry={() => refresh()} />}
      {actionError && <ErrorNotice message={actionError} />}

      <h3 className="global-section-title">Theme</h3>
      <ThemePicker />

      <h3 className="global-section-title">What claude-hub applies outside its folder</h3>
      {report && <Footprint footprint={report.footprint} hooks={hooks.length} scheduled={scheduled.length} />}

      <h3 className="global-section-title">Runs on a schedule</h3>
      {report?.schedulerError && (
        // Not "there are no scheduled jobs" — the query failed. The known jobs
        // still list below, graded on their logs alone.
        <ErrorNotice message={`Could not read Task Scheduler: ${report.schedulerError}`} onRetry={() => refresh()} />
      )}
      <div className="global-rows">
        {scheduled.map((item) => (
          <AutomationRow
            key={item.id}
            item={item}
            busy={busyTask === item.taskName}
            onRun={runTask}
            onOpenLog={openFile}
          />
        ))}
        {!loading && !report?.schedulerError && scheduled.length === 0 && (
          <div className="global-empty">No claude-hub scheduled jobs registered.</div>
        )}
      </div>

      <h3 className="global-section-title">Runs in sessions inside the scope</h3>
      <div className="global-rows">
        {hooks.map((item) => (
          <AutomationRow key={item.id} item={item} busy={false} onRun={runTask} onOpenLog={openFile} />
        ))}
        {!loading && hooks.length === 0 && (
          <div className="global-empty">No hooks registered in ~/.claude/settings.json.</div>
        )}
      </div>

      <h3 className="global-section-title">Applies to every project</h3>
      {settings?.error ? (
        <ErrorNotice message={`Could not read ${settings.path}: ${settings.error}`} onRetry={() => refresh()} />
      ) : (
        settings && (
          <div className="card global-settings">
            <dl>
              <dt>Model</dt>
              <dd>
                {settings.model ?? '—'}
                {settings.effortLevel && <span className="global-settings-note"> · effort {settings.effortLevel}</span>}
                {/* A per-model effortLevel overrides the top-level one for that
                    model, so the top-level value alone is not what runs. */}
                {settings.modelEffortLevels.map((m) => (
                  <span key={m.model} className="global-settings-note" title="Overrides the top-level effort for this model">
                    {' '}
                    · {m.model}: {m.effortLevel}
                  </span>
                ))}
              </dd>
              <dt>Permissions</dt>
              <dd>
                {settings.permissionsAllow ?? '—'} allow · {settings.permissionsDeny ?? '—'} deny
              </dd>
              <dt>Statusline</dt>
              <dd>{settings.statusLineCommand ? <code>{settings.statusLineCommand}</code> : 'none'}</dd>
              <dt>Global CLAUDE.md</dt>
              <dd>
                {settings.claudeMdBytes === null ? (
                  'not present'
                ) : (
                  <>
                    {(settings.claudeMdBytes / 1024).toFixed(1)} KB loaded into every session
                    <button type="button" className="btn-ghost global-inline-btn" onClick={() => openFile('claudemd')}>
                      Open
                    </button>
                  </>
                )}
              </dd>
              <dt>Global skills</dt>
              <dd>
                {settings.globalSkills.length === 0
                  ? 'none'
                  : `${settings.globalSkills.length} available everywhere — ${settings.globalSkills.join(', ')}`}
              </dd>
              <dt>settings.json</dt>
              <dd>
                <code>{settings.path}</code>
                <button type="button" className="btn-ghost global-inline-btn" onClick={() => openFile('settings')}>
                  Open
                </button>
              </dd>
            </dl>
          </div>
        )
      )}
    </section>
  )
}
