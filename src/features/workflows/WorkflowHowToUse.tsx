import type { WorkflowEntry } from '../../../shared/ipc-types'

// The usage-first block at the top of a workflow card: when you'd reach for
// it, how to invoke it (name + detected arg shape), a worked example the
// author baked into meta.example, and a one-click "explain in a session" for
// a tailored walkthrough. This is the "should I use this, and how" view —
// the composition/source X-ray lives below under "Under the hood".
export function WorkflowHowToUse({
  workflow,
  onExplain,
  onCopyInvocation,
}: {
  workflow: WorkflowEntry
  onExplain: (() => void) | null
  onCopyInvocation: () => void
}) {
  const { name, whenToUse, example } = workflow
  const args = workflow.composition.args
  const invocation = args.length ? `/${name} {${args.join(', ')}}` : `/${name}`

  return (
    <div className="wf-howto">
      {whenToUse && <div className="wf-howto-when">{whenToUse}</div>}

      <div className="wf-howto-run">
        <span className="wf-howto-label">Run</span>
        <code className="wf-howto-invocation">{invocation}</code>
        {/* Beside the invocation it names, not in the header — it copies the
            bare /name, so the label spells out what lands on the clipboard. */}
        <button type="button" className="btn-ghost" onClick={onCopyInvocation}>
          Copy /{name}
        </button>
      </div>

      {example && (
        <div className="wf-howto-example">
          <span className="wf-howto-label">Example</span>
          <p>{example}</p>
        </div>
      )}

      {onExplain && (
        <button type="button" className="wf-howto-explain" onClick={onExplain}>
          Explain in a session ↗
        </button>
      )}
    </div>
  )
}
