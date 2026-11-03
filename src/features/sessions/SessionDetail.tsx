import { useEffect, useRef, useState } from 'react'
import { ConfirmButton } from '../shared/ConfirmButton'
import { relativeTime } from '../shared/relative-time'
import { SessionTranscript } from './SessionTranscript'
import { SubagentsPanel, SubagentTranscript } from './SubagentsPanel'
import { formatDuration } from './subagent-model'
import { realModel } from './transcript-model'
import { useFindInTranscript } from './useFindInTranscript'
import type { SessionListEntry, SessionMessage, SubagentSummary } from '../../../shared/ipc-types'

export function SessionDetail({
  entry,
  onDelete,
}: {
  entry: SessionListEntry
  onDelete: (entry: SessionListEntry) => void
}) {
  const [messages, setMessages] = useState<SessionMessage[] | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [agents, setAgents] = useState<SubagentSummary[]>([])
  const [openAgent, setOpenAgent] = useState<SubagentSummary | null>(null)
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const find = useFindInTranscript(bodyRef, messages)

  useEffect(() => {
    let cancelled = false
    window.hubApi.readSession(entry.projectPath, entry.sessionId).then(
      (loaded) => {
        if (!cancelled) setMessages(loaded)
      },
      (err: unknown) => {
        // Not setMessages([]) — an empty array is the transcript pane's way of
        // saying "this session never spoke", and a read that failed knows
        // nothing about what the session said.
        if (!cancelled) setReadError(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      cancelled = true
    }
  }, [entry.projectPath, entry.sessionId, entry.lastTimestamp])

  // Subagents the session deployed — same keying as the transcript so a live
  // session picks up newly spawned agents on its next update.
  useEffect(() => {
    let cancelled = false
    window.hubApi.listSubagents(entry.projectPath, entry.sessionId).then(
      (loaded) => {
        if (!cancelled) setAgents(loaded)
      },
      () => {
        if (!cancelled) setAgents([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [entry.projectPath, entry.sessionId, entry.lastTimestamp])

  // Follow the tail as turns stream in, the way a terminal would — including
  // when the subagents strip appears async below the transcript. While a
  // subagent is open: jump to its top once, then never auto-scroll (a live
  // session's streaming must not yank the reader around).
  const prevAgentRef = useRef<string | null>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    // While find is open the reader is parked on a match; a streaming turn
    // must not yank them back to the tail (the same rule the open-subagent
    // case below already follows).
    if (find.open) return
    const agentId = openAgent?.id ?? null
    const agentChanged = agentId !== prevAgentRef.current
    prevAgentRef.current = agentId
    if (agentId) {
      if (agentChanged) el.scrollTo({ top: 0 })
      return
    }
    el.scrollTo({ top: el.scrollHeight })
  }, [messages, agents, openAgent, find.open])

  // A session that still has a live reader elsewhere must not be resumed —
  // a second reader on one session id silently kills the first. Deleting
  // shares the gate for a second reason: something is still appending to
  // that transcript, so trashing it mid-turn is a write into a file being
  // written.
  const inUse = entry.state === 'active' || entry.state === 'waiting'

  const copyId = () => {
    // The label only claims success when the write actually resolved.
    navigator.clipboard.writeText(entry.sessionId).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      () => setCopied(false),
    )
  }

  const resumeInTerminal = () => {
    window.hubApi.resumeSessionInTerminal(entry.projectId, entry.sessionId)
  }
  const model = realModel(entry.model)

  return (
    <article className="card session-detail">
      <header className="session-detail-head">
        <span className={`session-pulse session-pulse-${entry.state}`} />
        <div>
          <div className="session-detail-title">{entry.title}</div>
          <div className="session-detail-sub">
            {entry.projectName}
            {model && ` · ${model}`} · {entry.state} · {relativeTime(entry.date, Date.now())}
          </div>
          <div className="session-detail-id">
            {/* user-select:all, so one click selects the whole id — the copy
                below is the nicety, not the only way out. */}
            <code onClick={copyId} title="Copy session ID">
              {entry.sessionId}
            </code>
            <span className="session-id-note">{copied ? 'copied' : 'resume in the CLI with this id'}</span>
            <button
              type="button"
              className="btn-ghost session-resume"
              onClick={resumeInTerminal}
              disabled={inUse}
              title={
                inUse
                  ? 'This session already has a live reader — a second one would silently kill the first'
                  : `Opens a terminal in ${entry.projectPath} running: claude --resume ${entry.sessionId}`
              }
            >
              Resume in terminal ↗
            </button>
            <ConfirmButton
              label="Delete history"
              confirmLabel="Confirm — to recycle bin?"
              onConfirm={() => onDelete(entry)}
              disabled={inUse}
              title={
                inUse
                  ? 'This session is still being written to — delete it once it goes idle'
                  : `Sends this session's transcript and subagent logs to the recycle bin. It leaves Claude Code's own store, so "claude --resume ${entry.sessionId}" stops working too.`
              }
            />
          </div>
        </div>
      </header>

      {find.open && (
        <div className="session-find">
          <input
            ref={find.inputRef}
            autoFocus
            value={find.query}
            onChange={(e) => find.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') find.close()
              if (e.key === 'Enter') find.walk(e.shiftKey ? -1 : 1)
            }}
            placeholder="Find in transcript…"
            aria-label="Find in transcript"
          />
          <span className="session-find-count">
            {/* Before the transcript resolves there is nothing to have
                searched, so this says so rather than reporting "0". */}
            {messages === null
              ? 'loading…'
              : find.query.trim() === ''
                ? ''
                : find.count === 0
                  ? 'no matches in prose'
                  : `${find.index + 1} / ${find.count}`}
          </span>
          <button type="button" onClick={() => find.walk(-1)} disabled={find.count === 0} aria-label="Previous match">
            ‹
          </button>
          <button type="button" onClick={() => find.walk(1)} disabled={find.count === 0} aria-label="Next match">
            ›
          </button>
          <button type="button" onClick={find.close} aria-label="Close find">
            ✕
          </button>
        </div>
      )}

      <div className="session-detail-body" ref={bodyRef}>
        {openAgent ? (
          /* Swapped-in subagent view — read-only archaeology. */
          <>
            <button type="button" className="session-subagent-back" onClick={() => setOpenAgent(null)}>
              ← Session
            </button>
            <div className="session-subagent-openhead">
              <span className="session-subagent-type">{openAgent.agentType}</span>
              <span className="session-subagent-desc">{openAgent.description || '—'}</span>
              <span className="session-subagent-dur">{formatDuration(openAgent.startedAt, openAgent.endedAt)}</span>
            </div>
            <SubagentTranscript projectPath={entry.projectPath} sessionId={entry.sessionId} agentId={openAgent.id} />
          </>
        ) : (
          <>
            {readError !== null && (
              <div className="session-loading">Couldn't read this transcript — {readError}</div>
            )}
            {messages === null && readError === null && <div className="session-loading">Loading transcript…</div>}
            {messages?.length === 0 && <div className="session-loading">No conversation recorded yet.</div>}
            {messages && messages.length > 0 && (
              <SessionTranscript
                messages={messages}
                autoExpandTail={inUse}
                highlight={find.open ? find.query : undefined}
              />
            )}

            <SubagentsPanel agents={agents} onOpen={setOpenAgent} />
          </>
        )}
      </div>
    </article>
  )
}
