import { useEffect, useState } from 'react'
import { toast } from '../shared/toast'
import type { CreateWorkflowResult, WorkflowTemplate } from '../../../shared/ipc-types'
import { useRegisteredProjects } from '../shared/useRegisteredProjects'
import { ProjectListUnavailableOption } from '../shared/ProjectListUnavailable'

// "New workflow" flow: pick a template shape → name + project → finish by
// refining in a session or opening in the editor. The hub scaffolds the real
// template code (conflict-refusing), then hands the fresh file to the chosen
// finish lane.
export function WorkflowNewPanel({
  onClose,
  onCreated,
  listTemplates,
  createFromTemplate,
  openInEditor,
  editSession,
}: {
  onClose: () => void
  onCreated: (createdPath: string) => void
  listTemplates: () => Promise<WorkflowTemplate[]>
  createFromTemplate: (templateKey: string, name: string, targetProjectId: string) => Promise<CreateWorkflowResult>
  openInEditor: (scriptPath: string) => Promise<void>
  editSession: (scriptPath: string, targetProjectId: string, instruction: string) => Promise<void>
}) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [templateKey, setTemplateKey] = useState('')
  const { projects, error: projectsError } = useRegisteredProjects()
  const [projectId, setProjectId] = useState('')
  const [name, setName] = useState('')
  const [intent, setIntent] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listTemplates().then((t) => {
      setTemplates(t)
      setTemplateKey((k) => k || t[0]?.key || '')
    })
  }, [listTemplates])

  const canCreate = Boolean(templateKey && name.trim() && projectId) && !busy

  const create = async (finish: 'session' | 'editor') => {
    setBusy(true)
    try {
      // Two different facts, deliberately not collapsed. A resolved `!ok` is a
      // refusal the main process actually made (a name conflict), so "not
      // created" is true. A rejection is the call itself failing — possibly
      // after the file was already written, so nobody knows whether it
      // exists. Saying "could not create
      // it" there is a confident claim about something nobody found out, which
      // is the narrower form of the very bug this panel was just fixed for.
      const res = await createFromTemplate(templateKey, name, projectId).catch(() => 'unreachable' as const)
      if (res === 'unreachable') {
        toast.error("Couldn't confirm the workflow was created — check the catalog before retrying.")
        return
      }
      if (!res.ok || !res.path) {
        toast.error(res.message ?? 'Could not create the workflow.')
        return
      }
      onCreated(res.path)
      // The file is on disk from here on, so the finish lane gets its own
      // catch: it is a second, independently fallible action. Reporting a failed
      // hand-off as a failed create told the user nothing was written and
      // sent them into a retry that then failed for real, on a name conflict.
      try {
        if (finish === 'session') {
          const instruction = intent.trim() ? `adapt it to: ${intent.trim()}.` : 'help me finish it.'
          await editSession(res.path, projectId, instruction)
          toast.success('Created — opening a session to refine it (press Enter there).')
        } else {
          await openInEditor(res.path)
          toast.success(`Created ${res.name}.js — opening in VS Code.`)
        }
      } catch {
        toast.error(`Created ${res.name}.js — but couldn't open it. It's in the catalog.`)
      }
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wf-new">
      <div className="wf-new-title">New workflow</div>

      <div className="wf-new-step">1 · Start from a shape</div>
      <div className="wf-new-templates">
        {templates.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`wf-new-template${templateKey === t.key ? ' active' : ''}`}
            onClick={() => setTemplateKey(t.key)}
          >
            <strong>{t.label}</strong>
            <span className="wf-new-template-desc">{t.description}</span>
            {t.shape.length > 0 && (
              <span className="wf-new-template-shape">
                {t.shape.map((s) => (
                  <span key={s} className="wf-shape-chip">
                    {s}
                  </span>
                ))}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="wf-new-step">2 · Name &amp; project</div>
      <div className="wf-new-row">
        <input
          type="text"
          className="wf-new-name"
          placeholder="workflow-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Workflow name"
        />
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Target project">
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
      </div>

      <div className="wf-new-step">3 · Describe &amp; finish</div>
      {/* The intent only ever seeds the session lane, so it goes with it. */}
      <label className="wf-new-field">
        <span>What should it do? (optional — seeds the session)</span>
        <input
          type="text"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          placeholder="e.g. review a PR for accessibility regressions"
        />
      </label>

      <div className="wf-new-actions">
        <button className="workflow-run wf-new-primary" disabled={!canCreate} onClick={() => create('session')}>
          Create &amp; refine in a session ↗
        </button>
        <button disabled={!canCreate} onClick={() => create('editor')}>
          Create &amp; open in editor
        </button>
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
