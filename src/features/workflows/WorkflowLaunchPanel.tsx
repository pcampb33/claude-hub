import { useEffect, useState } from 'react'
import type { ProjectStatus, WorkflowEntry } from '../../../shared/ipc-types'
import { useRegisteredProjects } from '../shared/useRegisteredProjects'
import { ProjectListUnavailableOption } from '../shared/ProjectListUnavailable'

// Assemble the detected arg fields into the object form the workflow expects,
// e.g. {task: "add search", range: "HEAD~2..HEAD"} — only non-empty fields,
// JSON.stringify'd so quotes/backslashes in values are escaped. Empty when
// nothing is filled, so the workflow falls back to its own defaults.
function buildObjectArgs(fields: Record<string, string>, keys: string[]): string {
  const parts = keys
    .filter((k) => fields[k]?.trim())
    .map((k) => `${k}: ${JSON.stringify(fields[k].trim())}`)
  return parts.length ? `{${parts.join(', ')}}` : ''
}

// Pre-launch setup for "Run in session": pick the working directory (the
// project the deep link opens in), fill the workflow's args — as labeled
// fields when the parser detected an arg contract, else a free-text box — and
// see the target's git state before you run. Launch opens a real interactive
// session with the invocation pre-filled; you press Enter there to start it.
export function WorkflowLaunchPanel({
  workflow,
  onLaunch,
  onCancel,
}: {
  workflow: WorkflowEntry
  onLaunch: (targetProjectId: string, args: string) => void
  onCancel: () => void
}) {
  const { projects, error: projectsError } = useRegisteredProjects()
  const [selectedId, setSelectedId] = useState(workflow.projectId ?? '')
  const argKeys = workflow.composition.args
  const [fields, setFields] = useState<Record<string, string>>({})
  const [freeArgs, setFreeArgs] = useState('')
  const [status, setStatus] = useState<ProjectStatus | null>(null)

  useEffect(() => {
    const project = projects.find((p) => p.id === selectedId)
    if (!project) {
      setStatus(null)
      return
    }
    let live = true
    setStatus(null)
    window.hubApi.getProjectStatus(project.path).then((s) => {
      if (live) setStatus(s)
    })
    return () => {
      live = false
    }
  }, [selectedId, projects])

  const args = argKeys.length ? buildObjectArgs(fields, argKeys) : freeArgs.trim()
  const preview = args ? `Run /${workflow.name} ${args}` : `Run /${workflow.name}`

  return (
    <div className="wf-launch">
      <div className="wf-launch-title">Run in a new session</div>

      <label className="wf-launch-field">
        <span>Project (working directory)</span>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
          <option value="">Choose a project…</option>
          {projectsError ? (
            <ProjectListUnavailableOption />
          ) : (
            projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))
          )}
        </select>
      </label>

      {argKeys.length > 0 ? (
        argKeys.map((key) => (
          <label key={key} className="wf-launch-field">
            <span>{key}</span>
            <input
              type="text"
              value={fields[key] ?? ''}
              onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))}
              placeholder={key === 'range' ? 'e.g. HEAD~2..HEAD' : `value for ${key}`}
            />
          </label>
        ))
      ) : (
        <label className="wf-launch-field">
          <span>Args (optional)</span>
          <input
            type="text"
            value={freeArgs}
            onChange={(e) => setFreeArgs(e.target.value)}
            placeholder="passed to the workflow"
          />
        </label>
      )}

      {selectedId && (
        <div className="wf-launch-context">
          {status?.git ? (
            <>
              branch <strong>{status.git.branch}</strong> ·{' '}
              {status.git.dirty ? 'uncommitted changes' : 'clean'}
            </>
          ) : status && !status.pathExists ? (
            <span className="wf-launch-warn">project path is missing</span>
          ) : status ? (
            'not a git repository'
          ) : (
            'checking project…'
          )}
        </div>
      )}

      <div className="wf-launch-preview">
        <span className="wf-launch-preview-label">Will pre-fill</span>
        <code>{preview}</code>
      </div>

      <div className="wf-launch-actions">
        <button className="wf-launch-go" disabled={!selectedId} onClick={() => onLaunch(selectedId, args)}>
          Launch session
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
