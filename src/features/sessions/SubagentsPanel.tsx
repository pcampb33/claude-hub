import { useEffect, useState } from 'react'
import { SessionTranscript } from './SessionTranscript'
import { formatDuration } from './subagent-model'
import type { SessionMessage, SubagentSummary } from '../../../shared/ipc-types'

// The subagents a session deployed, as one collapsed-by-default disclosure
// strip (the ToolRun idiom). Purely presentational — SessionDetail owns the
// fetch so its tail-scroll effect can react to the strip appearing.
export function SubagentsPanel({
  agents,
  onOpen,
}: {
  agents: SubagentSummary[]
  onOpen: (agent: SubagentSummary) => void
}) {
  const [open, setOpen] = useState(false)
  if (agents.length === 0) return null
  return (
    <div className="session-subagents">
      <button type="button" className="session-toolrun-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="session-toolrun-caret">{open ? '▾' : '▸'}</span>
        <span className="session-toolrun-count">
          {agents.length} subagent{agents.length === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div className="session-subagents-body">
          {agents.map((agent) => {
            const duration = formatDuration(agent.startedAt, agent.endedAt)
            const inner = (
              <>
                <span className="session-subagent-type">{agent.agentType}</span>
                <span className="session-subagent-desc">{agent.description || '—'}</span>
                {agent.worktreeBranch && <span className="session-subagent-branch">{agent.worktreeBranch}</span>}
                <span className="session-subagent-dur">{agent.hasTranscript ? (duration ?? '') : 'never ran'}</span>
              </>
            )
            // Meta-only agents (killed / never ran) have nothing to open.
            return agent.hasTranscript ? (
              <button type="button" key={agent.id} className="session-subagent-row" onClick={() => onOpen(agent)}>
                {inner}
              </button>
            ) : (
              <div key={agent.id} className="session-subagent-row session-subagent-dead">
                {inner}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// The swapped-in view: one subagent's transcript, fetched on open.
export function SubagentTranscript({
  projectPath,
  sessionId,
  agentId,
}: {
  projectPath: string
  sessionId: string
  agentId: string
}) {
  const [messages, setMessages] = useState<SessionMessage[] | null>(null)

  useEffect(() => {
    let cancelled = false
    window.hubApi.readSubagent(projectPath, sessionId, agentId).then(
      (loaded) => {
        if (!cancelled) setMessages(loaded)
      },
      () => {
        if (!cancelled) setMessages([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [projectPath, sessionId, agentId])

  if (messages === null) return <div className="session-loading">Loading transcript…</div>
  if (messages.length === 0) return <div className="session-loading">No transcript recorded.</div>
  return <SessionTranscript messages={messages} />
}
