import { useEffect, useState } from 'react'
import type { BoundaryAccess, BoundaryNeighbour, BoundaryTier, BoundaryView, DesktopTarget, GuardStatus } from '../../../shared/ipc-types'
import { ErrorNotice } from '../shared/ErrorNotice'
import { toast } from '../shared/toast'
import {
  LOCAL_SETTINGS_TEXT,
  TIER_LABEL,
  addNeighbour,
  guardButtons,
  neighbourProblem,
  parseTargetParam,
  sameNeighbours,
  sameTarget,
  targetParam,
} from './config-model.ts'
import { errorText, type BoundaryEntry } from './useConfig'
import { ConfirmDialog } from './ConfirmDialog'

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className="cfg-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const ACCESS: { value: BoundaryAccess; label: string }[] = [
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Write' },
]

export function BoundaryCard({
  target,
  targets,
  entry,
  localPath,
  onSaved,
  onRetry,
}: {
  target: DesktopTarget
  targets: DesktopTarget[]
  entry: BoundaryEntry | null
  localPath: string
  onSaved: (view: BoundaryView) => void
  onRetry: () => void
}) {
  if (!entry) {
    return (
      <section className="cfg-card" aria-busy="true" aria-label="Reading boundary">
        <h5>Boundary</h5>
        <div className="skeleton cfg-skel" />
      </section>
    )
  }
  if (entry.status === 'error') {
    return (
      <section className="cfg-card" aria-label="Boundary">
        <h5>Boundary</h5>
        <ErrorNotice message={`Couldn’t read this project’s boundary: ${entry.error}`} onRetry={onRetry} />
      </section>
    )
  }
  if (entry.data.boundary.admin) {
    return (
      <section className="cfg-card" aria-label="Boundary">
        <h5>Boundary</h5>
        <p className="cfg-covers">{entry.data.guard.covers}</p>
        <p className="cfg-sub">Desktop launches of claude-hub carry no boundary statement and no deny rules. Every other project keeps its own boundary.</p>
      </section>
    )
  }
  return <BoundaryEditor target={target} targets={targets} view={entry.data} localPath={localPath} onSaved={onSaved} />
}

type GuardAction = 'write' | 'refresh' | 'remove'

function BoundaryEditor({
  target,
  targets,
  view,
  localPath,
  onSaved,
}: {
  target: DesktopTarget
  targets: DesktopTarget[]
  view: BoundaryView
  localPath: string
  onSaved: (view: BoundaryView) => void
}) {
  const saved = view.boundary
  const [tier, setTier] = useState<BoundaryTier>(saved.tier)
  const [neighbours, setNeighbours] = useState<BoundaryNeighbour[]>(saved.neighbours)
  const [vault, setVault] = useState<BoundaryAccess>(saved.vaultAccess)
  // A new saved boundary (after Save, or another target) resets the draft. A
  // guard-only change keeps the same boundary object, so it doesn't.
  useEffect(() => {
    setTier(saved.tier)
    setNeighbours(saved.neighbours)
    setVault(saved.vaultAccess)
  }, [saved])

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<GuardAction | null>(null)
  const [guardBusy, setGuardBusy] = useState(false)
  const [guardError, setGuardError] = useState<string | null>(null)
  const [pick, setPick] = useState('')
  const [pickAccess, setPickAccess] = useState<BoundaryAccess>('read')

  const dirty = tier !== saved.tier || vault !== saved.vaultAccess || !sameNeighbours(neighbours, saved.neighbours)
  const nameOf = (n: BoundaryNeighbour) => targets.find((t) => sameTarget(t, n.target))?.name ?? `${n.target.key} (not found)`
  const candidates = targets.filter((t) => !neighbourProblem(target, neighbours, t))
  const pickRef = parseTargetParam(pick)

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      onSaved(await window.hubApi.setBoundary(target, { tier, neighbours, vaultAccess: vault }))
      toast.success(`Saved the boundary for ${target.name}. New Desktop sessions use it.`)
    } catch (err) {
      setSaveError(`Couldn’t save: ${errorText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const runGuard = async (action: GuardAction) => {
    setConfirm(null)
    setGuardBusy(true)
    setGuardError(null)
    try {
      const guard: GuardStatus = action === 'remove' ? await window.hubApi.removeLocalGuard(target) : await window.hubApi.writeLocalGuard(target)
      onSaved({ ...view, guard })
    } catch (err) {
      setGuardError(`Couldn’t ${action === 'remove' ? 'remove the hub rules' : 'write the guard'}: ${errorText(err)}`)
    } finally {
      setGuardBusy(false)
    }
  }

  const buttons = guardButtons(saved.tier, view.guard, dirty, guardBusy)

  return (
    <section className="cfg-card cfg-boundary" aria-label="Boundary">
      <div className="cfg-card-head">
        <h5>Boundary</h5>
        {saved.isDefault && !dirty && <span className="cfg-faint">Default: nothing saved for this project yet</span>}
      </div>

      <div className="cfg-field">
        <span className="cfg-label">Tier</span>
        <div>
          <Segmented
            label="Boundary tier"
            value={tier}
            options={[
              { value: 'audit', label: TIER_LABEL.audit },
              { value: 'guarded', label: TIER_LABEL.guarded },
            ]}
            onChange={setTier}
          />
          <p className="cfg-covers">{view.guard.covers}</p>
          {tier !== saved.tier && (
            <p className="cfg-sub is-warn">
              That describes the saved tier ({TIER_LABEL[saved.tier]}). Save to switch to {TIER_LABEL[tier]}.
            </p>
          )}
          <p className="cfg-sub">
            Desktop launches of this project {view.guard.desktopLaunch ? 'carry the deny rules.' : 'carry no deny rules.'}
          </p>
        </div>
      </div>

      <div className="cfg-field">
        <span className="cfg-label">Can also use</span>
        <div className="cfg-neighbours">
          {neighbours.length === 0 && <p className="cfg-sub">No other projects. Sessions here are expected to stay in this folder.</p>}
          {neighbours.map((n) => (
            <div className="cfg-neighbour" key={targetParam(n.target)}>
              <span className="cfg-neighbour-name">
                {nameOf(n)}
                {n.target.kind === 'experiment' && <small> experiment</small>}
              </span>
              <Segmented
                label={`Access to ${nameOf(n)}`}
                value={n.access}
                options={ACCESS}
                onChange={(access) => setNeighbours(neighbours.map((m) => (m === n ? { ...m, access } : m)))}
              />
              <button
                type="button"
                className="cfg-x"
                aria-label={`Remove ${nameOf(n)}`}
                title="Remove"
                onClick={() => setNeighbours(neighbours.filter((m) => m !== n))}
              >
                ×
              </button>
            </div>
          ))}
          <div className="cfg-add">
            <select aria-label="Project or experiment to add" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Add a project or experiment…</option>
              {(['project', 'experiment'] as const).map((kind) => {
                const opts = candidates.filter((t) => t.kind === kind).sort((a, b) => a.name.localeCompare(b.name))
                if (opts.length === 0) return null
                return (
                  <optgroup key={kind} label={kind === 'project' ? 'Projects' : 'Sandbox experiments'}>
                    {opts.map((t) => (
                      <option key={targetParam(t)} value={targetParam(t)}>
                        {t.name}
                      </option>
                    ))}
                  </optgroup>
                )
              })}
            </select>
            <select aria-label="Access for the added project" value={pickAccess} onChange={(e) => setPickAccess(e.target.value as BoundaryAccess)}>
              <option value="read">Read</option>
              <option value="write">Write</option>
            </select>
            <button
              type="button"
              disabled={!pickRef}
              onClick={() => {
                if (!pickRef) return
                setNeighbours(addNeighbour(target, neighbours, pickRef, pickAccess))
                setPick('')
              }}
            >
              Add
            </button>
          </div>
        </div>
      </div>

      <div className="cfg-field">
        <span className="cfg-label">Vault</span>
        <Segmented
          label="Vault access"
          value={vault}
          options={[
            { value: 'read', label: 'Read-only' },
            { value: 'write', label: 'Read & write' },
          ]}
          onChange={setVault}
        />
      </div>

      <div className="cfg-actions">
        <button type="button" className="cfg-primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save boundary'}
        </button>
        {dirty && !saving && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setTier(saved.tier)
              setNeighbours(saved.neighbours)
              setVault(saved.vaultAccess)
            }}
          >
            Discard changes
          </button>
        )}
        {saveError && (
          <span className="cfg-error" role="alert">
            {saveError}
          </span>
        )}
      </div>

      <div className="cfg-guard">
        <h6>Sessions started outside the desktop</h6>
        <p className="cfg-sub" data-state={view.guard.localSettings}>
          {LOCAL_SETTINGS_TEXT[view.guard.localSettings]}
        </p>
        <div className="cfg-actions">
          {buttons.write && (
            <button
              type="button"
              disabled={!buttons.write.enabled}
              title={buttons.write.reason ?? `Adds the hub's deny rules to ${localPath}`}
              onClick={() => setConfirm(view.guard.localSettings === 'stale' ? 'refresh' : 'write')}
            >
              {buttons.write.label}
            </button>
          )}
          {buttons.remove && (
            <button
              type="button"
              className="btn-ghost"
              disabled={!buttons.remove.enabled}
              title={buttons.remove.reason ?? `Removes the hub's deny rules from ${localPath}`}
              onClick={() => setConfirm('remove')}
            >
              {buttons.remove.label}
            </button>
          )}
          {buttons.write && !buttons.write.enabled && buttons.write.reason && <span className="cfg-faint">{buttons.write.reason}</span>}
          {guardBusy && <span className="cfg-faint">Working…</span>}
          {guardError && (
            <span className="cfg-error" role="alert">
              {guardError}
            </span>
          )}
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm === 'remove' ? 'Remove the hub’s rules?' : confirm === 'refresh' ? 'Refresh the guard?' : 'Write the guard?'}
          confirmLabel={confirm === 'remove' ? 'Remove rules' : confirm === 'refresh' ? 'Refresh rules' : 'Write rules'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void runGuard(confirm)}
        >
          <p>
            {confirm === 'remove'
              ? 'Removes the hub’s deny rules from:'
              : confirm === 'refresh'
                ? 'Replaces the hub’s deny rules, to match the saved boundary, in:'
                : 'Adds the hub’s deny rules to:'}
          </p>
          <code className="cfg-path">{localPath}</code>
          <p>
            {confirm === 'remove'
              ? 'Only the rules the hub wrote are removed. The rest of the file is kept as it is.'
              : 'Only the hub’s own deny rules are added or replaced. Every other setting in the file is kept as it is.'}
          </p>
          {confirm !== 'remove' && <p className="cfg-sub">What the rules cover: {view.guard.covers}</p>}
        </ConfirmDialog>
      )}
    </section>
  )
}
