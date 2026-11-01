import { useState } from 'react'
import { ProjectPicker } from '../shared/ProjectPicker'
import { usePromote } from '../shared/usePromote'
import { toast } from '../shared/toast'
import { copyText } from '../shared/copy-text'
import { WorkflowStructureRail } from './WorkflowComposition'
import { WorkflowHowToUse } from './WorkflowHowToUse'
import { WorkflowLaunchPanel } from './WorkflowLaunchPanel'
import { GLOSSARY } from './glossary'
import type { PromoteResult, WorkflowEntry } from '../../../shared/ipc-types'

function copy(text: string, label: string) {
  return copyText(text, { success: `Copied ${label}.`, failure: `Couldn't copy ${label}.` })
}

// The wide detail pane for the selected workflow. Keyed on workflow.id by the
// parent so the launch panel / source / disclosure state resets on selection
// change. Two columns: usage (description, when-to-use, RUN, EXAMPLE, CTA) at
// a readable measure on the left, the always-visible "Structure" phase rail
// on the right ("View source" stays collapsed beneath it).
export function WorkflowDetail({
  workflow,
  onPromote,
  onLaunchSession,
  onReadSource,
  onExplainSession,
  onEditSession,
  onOpenInEditor,
}: {
  workflow: WorkflowEntry
  onPromote: (sourcePath: string, targetProjectId: string) => Promise<PromoteResult>
  onLaunchSession: (sourcePath: string, targetProjectId: string, args: string) => Promise<void>
  onReadSource: (sourcePath: string) => Promise<string>
  onExplainSession: (sourcePath: string, targetProjectId: string) => Promise<void>
  onEditSession: (scriptPath: string, targetProjectId: string, instruction: string) => Promise<void>
  onOpenInEditor: (scriptPath: string) => Promise<void>
}) {
  const { promote } = usePromote(workflow.path, onPromote)
  const [launching, setLaunching] = useState(false)
  const [source, setSource] = useState<string | null>(null)
  const [sourceOpen, setSourceOpen] = useState(false)

  const handleLaunch = async (targetProjectId: string, args: string) => {
    try {
      await onLaunchSession(workflow.path, targetProjectId, args)
      toast.success('Opening session — press Enter there to run.')
    } catch (err) {
      // Without this, a rejected launch showed the success toast anyway and
      // left the launch panel jammed open (setLaunching(false) never ran).
      toast.error(err instanceof Error ? err.message : 'Could not open the session.')
    } finally {
      setLaunching(false)
    }
  }

  // Explain opens in the workflow's own project; only offered when it has one
  // (global workflows have no owning project to anchor the session at).
  const handleExplain =
    workflow.projectId
      ? async () => {
          try {
            await onExplainSession(workflow.path, workflow.projectId as string)
            toast.success('Opening session — press Enter there to get the walkthrough.')
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not open the session.')
          }
        }
      : null

  const handleEdit =
    workflow.projectId
      ? async () => {
          try {
            await onEditSession(workflow.path, workflow.projectId as string, 'help me modify it.')
            toast.success('Opening a session to edit it — press Enter there.')
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not open the session.')
          }
        }
      : null

  const handleOpenEditor = async () => {
    try {
      await onOpenInEditor(workflow.path)
      toast.success('Opening in VS Code.')
    } catch {
      toast.error('Could not open the editor.')
    }
  }

  const copyInvocation = () => copy(`/${workflow.name}`, `/${workflow.name}`)

  const toggleSource = async () => {
    if (!sourceOpen && source === null) {
      try {
        setSource(await onReadSource(workflow.path))
      } catch {
        toast.error('Could not read the script.')
        return
      }
    }
    setSourceOpen((v) => !v)
  }

  return (
    <article className="card workflow-detail">
      <div className="workflow-detail-eyebrow">
        <span className="workflow-detail-path">{workflow.path}</span>
        <button className="btn-ghost" onClick={() => copy(workflow.path, 'script path')}>
          Copy path
        </button>
      </div>

      <header className="workflow-detail-header">
        <div className="workflow-detail-headline">
          <div className="workflow-detail-title-row">
            <strong className="workflow-detail-name">{workflow.name}</strong>
            <span
              className="badge badge-neutral"
              title={workflow.source === 'global' ? GLOSSARY['source-global'] : GLOSSARY['source-project']}
            >
              {workflow.source}
            </span>
          </div>
          <div className="workflow-detail-byline">{workflow.projectName}</div>
        </div>
        <div className="workflow-detail-actions">
          {handleEdit && (
            <button className="btn-ghost" onClick={handleEdit}>
              Edit in session ↗
            </button>
          )}
          <button className="btn-ghost" onClick={handleOpenEditor}>
            Open in editor
          </button>
          {/* Otherwise this rides the RUN line below — but an unparseable
              script has no RUN line, and /name is still valid to type. */}
          {workflow.parseError && (
            <button className="btn-ghost" onClick={copyInvocation}>
              Copy /{workflow.name}
            </button>
          )}
          <ProjectPicker onSelect={promote} />
        </div>
      </header>

      {workflow.parseError && <div className="workflow-parse-error">{workflow.parseError} — showing filename only.</div>}

      <div className="workflow-detail-body">
        <div className="workflow-usage-col">
          {workflow.description && <p className="workflow-detail-desc">{workflow.description}</p>}

          {!workflow.parseError && (
            <WorkflowHowToUse
              workflow={workflow}
              onExplain={handleExplain}
              onCopyInvocation={copyInvocation}
            />
          )}

          <div className="workflow-detail-run">
            {launching ? (
              <WorkflowLaunchPanel workflow={workflow} onLaunch={handleLaunch} onCancel={() => setLaunching(false)} />
            ) : (
              <button className="workflow-run" onClick={() => setLaunching(true)}>
                Run in session…
              </button>
            )}
          </div>
        </div>

        <aside className="wf-structure">
          {/* An unparseable script has no composition worth drawing, but its
              source is still the most useful thing to look at. */}
          {!workflow.parseError && <WorkflowStructureRail composition={workflow.composition} />}
          <button type="button" className="wf-source-toggle" onClick={toggleSource} aria-expanded={sourceOpen}>
            {sourceOpen ? '▾ Hide source' : '▸ View source'}
          </button>
        </aside>
      </div>

      {sourceOpen && source !== null && <pre className="wf-source-code">{source}</pre>}
    </article>
  )
}
