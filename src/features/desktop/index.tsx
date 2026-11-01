// Session Desktop: a dock of every hub-owned Claude Code session and a stage
// of live terminals in one of six layouts, plus read-only views of sessions
// running in other terminals.
import { ErrorNotice } from '../shared/ErrorNotice'
import { Desk } from './Desk'
import { useDesktop } from './useDesktop'
import './desktop.css'

export function DesktopView() {
  const { state, retry } = useDesktop()
  if (state.status === 'loading') {
    return (
      <div className="desk desk-loading" aria-busy="true" aria-label="Loading the session desktop">
        <div className="skeleton desk-skel-bar" />
        <div className="desk-body">
          <div className="desk-dock">
            <div className="skeleton desk-skel-card" />
            <div className="skeleton desk-skel-card" />
          </div>
          <div className="skeleton desk-skel-stage" />
        </div>
      </div>
    )
  }
  if (state.status === 'error') {
    return <ErrorNotice message={`Couldn't load the session desktop: ${state.error}`} onRetry={retry} />
  }
  return <Desk snapshot={state.snapshot} onRetry={retry} />
}
