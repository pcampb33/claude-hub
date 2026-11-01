import type { DesktopSessionState } from '../../../shared/ipc-types'
import { STATE_LABEL } from './desktop-model'

// State in words plus a mark: pulsing dot (needs you), spinner (working),
// solid dot (your turn), hollow dot (everything else). Never colour alone.
export function StatePill({ state, title }: { state: DesktopSessionState; title?: string }) {
  return (
    <span className="desk-state" data-state={state} title={title}>
      {STATE_LABEL[state]}
    </span>
  )
}
