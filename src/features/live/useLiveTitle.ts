import { useEffect } from 'react'
import { useLiveStatus } from './useLiveStatus'

// The window title, kept in step with what is actually running. It lands in
// the taskbar and alt-tab, which the frameless window otherwise leaves as a
// bare "claude-hub" whatever is happening.
const BASE_TITLE = 'claude-hub'

export function useLiveTitle(): void {
  const snapshot = useLiveStatus()

  useEffect(() => {
    const active = snapshot?.projects.filter((p) => p.state === 'active').length ?? 0
    // A null snapshot means "not loaded yet", not "nothing running" — leave the
    // plain title rather than announcing a zero the app has not established.
    document.title = active > 0 ? `● ${active} running — ${BASE_TITLE}` : BASE_TITLE
  }, [snapshot])
}
