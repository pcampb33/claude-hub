import type { SessionMessage } from '../../../shared/ipc-types'
import './transcript.css'

// Shared by SessionHistory's inline drill-down and session-search's
// clicked-result view — both need to render a transcript the same way.
export function TranscriptView({ messages, loading }: { messages: SessionMessage[] | null; loading: boolean }) {
  return (
    <div className="session-transcript">
      {loading && <div>Loading transcript…</div>}
      {messages?.map((message, i) => (
        <div key={i} className={`transcript-message transcript-${message.role}`}>
          <span className="transcript-role">{message.role}</span>
          <pre className="transcript-text">{message.text}</pre>
        </div>
      ))}
    </div>
  )
}
