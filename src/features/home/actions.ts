import { useCallback } from 'react'
import { usePeek } from './peek-context'
import { useNavigate } from '../shared/useHashRoute'
import { toast } from '../shared/toast'

// Peek actions shared by the Needs, Live and Projects panels.

// Leave Home for a view: close the peek first so coming back to Home does
// not land on a stale panel.
export function useGo() {
  const navigate = useNavigate()
  const { close } = usePeek()
  return useCallback(
    (view: string, param?: string) => {
      close()
      navigate(view, param)
    },
    [close, navigate],
  )
}

// Fire a launch IPC (editor, terminal, resume) and say so if it failed —
// a launch that silently does nothing reads as a slow one.
export function runAction(fn: () => Promise<unknown>, what: string): void {
  fn().then(
    () => {},
    (err: unknown) => toast.error(`Couldn’t ${what}: ${err instanceof Error ? err.message : String(err)}`),
  )
}
