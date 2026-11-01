import { useEffect, useRef, useState } from 'react'
import type { ProjectFloorStatus, VerifyJob } from '../../../shared/ipc-types'
import { relativeTime } from '../shared/relative-time'
import { floorState } from './useFloorStatus'
import './floor.css'

const STRIP_STAGGER_TOTAL_MS = 400
const STRIP_CELL_FADE_MS = 150

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
}

// Elapsed time of a live run — minutes-scale, so "3m 12s" over a bare "192s".
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// The badge leads deliberately: streakDays 0 is ambiguous by construction
// ("latest run red" or "first-ever run green today"), so red-vs-green rides the
// badge, never the number alone. A green run nobody has repeated since the
// staleness window badges "unverified" — the streak beside it is a record of
// past days, not a claim about today.
function statusBadge(project: ProjectFloorStatus, nowMs: number) {
  if (!project.verifyCommand) return <span className="badge badge-neutral">not configured</span>
  if (!project.latest) return <span className="badge badge-neutral">never run</span>
  const state = floorState(project, nowMs)
  if (state === 'red') return <span className="badge badge-missing">red</span>
  return state === 'green' ? (
    <span className="badge badge-clean">green</span>
  ) : (
    <span className="badge badge-neutral">unverified</span>
  )
}

// One project's verify-floor detail: status badge, streak, last-run meta, the
// 14-day strip, the "Run verify" CTA, an inline verifyCommand editor, and —
// while a run is live — its output tail with elapsed time and Cancel.
// Presentational — the parent owns the runVerify/cancelVerifyJob/
// setVerifyCommand IPC calls and passes `running`/`job`/`onCancel`/
// `onSetCommand`. Its home is the Projects-tab detail pane (extracted from
// the old dashboard VerifyFloor so both could share it).
export function ProjectFloorCard({
  project,
  historyDays,
  onRun,
  running,
  job,
  onCancel,
  onSetCommand,
}: {
  project: ProjectFloorStatus
  historyDays: number
  onRun: () => void
  running: boolean
  job?: VerifyJob | null
  onCancel?: () => void
  onSetCommand: (command: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.verifyCommand ?? '')
  const [saving, setSaving] = useState(false)

  // 1s re-render tick only while a run is live — output can go quiet for long
  // stretches (typecheck, vitest startup) and a frozen elapsed reads as hung.
  const live = job != null
  const outputTail = job?.outputTail ?? ''
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [live])

  // Keep the output pane pinned to the newest lines as chunks stream in.
  const outputRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [outputTail])

  const nowMs = Date.now()
  const state = floorState(project, nowMs)
  const fresh = state === 'green'
  const stale = state === 'unverified' && project.latest !== null
  const stepMs =
    project.days.length > 1 ? (STRIP_STAGGER_TOTAL_MS - STRIP_CELL_FADE_MS) / (project.days.length - 1) : 0

  const save = async () => {
    setSaving(true)
    try {
      await onSetCommand(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`card floor-card${fresh ? ' floor-card-fresh' : ''}${stale ? ' floor-card-stale' : ''}`}>
      <div className="floor-card-header">
        {statusBadge(project, nowMs)}
        <span className="floor-card-name">{project.name}</span>
        {project.streakDays !== null && (
          <span className="floor-streak">
            held {project.streakDays} {project.streakDays === 1 ? 'day' : 'days'}
          </span>
        )}
        <button
          type="button"
          className="btn-ghost floor-run-btn"
          onClick={onRun}
          disabled={running || !project.verifyCommand}
          title={
            project.verifyCommand
              ? 'Run this project’s verifyCommand and record the result'
              : 'Set a verify command below to enable'
          }
        >
          {running ? 'Running…' : 'Run verify'}
        </button>
      </div>

      {job && (
        <div className="floor-verify-live">
          <div className="floor-verify-live-meta">
            running {formatElapsed(nowMs - new Date(job.startedAt).getTime())} ·{' '}
            <code className="floor-command">{job.command}</code>
            <button type="button" className="btn-ghost floor-cancel-btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
          <pre ref={outputRef} className="floor-verify-output">
            {outputTail || 'waiting for output…'}
          </pre>
        </div>
      )}

      {editing ? (
        <div className="floor-command-editor">
          <input
            type="text"
            value={draft}
            placeholder="npm run lint && npm run typecheck && npm test"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') setEditing(false)
            }}
            aria-label="Verify command"
            autoFocus
          />
          <button type="button" className="btn-ghost" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </button>
        </div>
      ) : project.latest ? (
        <div className="floor-card-meta">
          last run {relativeTime(project.latest.timestamp, nowMs)} · {formatDuration(project.latest.durationMs)} ·{' '}
          <code className="floor-command">{project.latest.command}</code>
          {stale && (
            <span className="floor-stale">
              {' '}
              — unverified since {new Date(project.latest.timestamp).toLocaleDateString()}
            </span>
          )}
          <button type="button" className="btn-ghost floor-edit-btn" onClick={() => setEditing(true)}>
            Edit command
          </button>
        </div>
      ) : project.verifyCommand ? (
        <div className="floor-card-meta">
          configured: <code className="floor-command">{project.verifyCommand}</code> — no runs recorded yet
          <button type="button" className="btn-ghost floor-edit-btn" onClick={() => setEditing(true)}>
            Edit command
          </button>
        </div>
      ) : (
        <div className="floor-card-meta">
          no verify command configured
          <button type="button" className="btn-ghost floor-edit-btn" onClick={() => setEditing(true)}>
            Set command…
          </button>
        </div>
      )}

      <div className="floor-strip" aria-label={`last ${historyDays} days`}>
        {project.days.map((d, i) => (
          <span
            key={d.date}
            className={`floor-strip-cell floor-strip-${d.status}`}
            style={{ animationDelay: `${Math.round(i * stepMs)}ms` }}
            title={`${d.date}: ${d.status}`}
          />
        ))}
      </div>
    </div>
  )
}
