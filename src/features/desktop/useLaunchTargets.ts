import { useCallback, useEffect, useState } from 'react'
import type { DesktopLaunchTargets, SessionMessage } from '../../../shared/ipc-types'
import { errorText as message } from './desktop-model.ts'

export type LaunchTargetsState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'data'; data: DesktopLaunchTargets }

// The launcher's projects, experiments and recent conversations, fetched each
// time it opens.
export function useLaunchTargets(): { state: LaunchTargetsState; retry: () => void } {
  const [state, setState] = useState<LaunchTargetsState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    window.hubApi.listDesktopTargets().then(
      (data) => live && setState({ status: 'data', data }),
      (err: unknown) => live && setState({ status: 'error', error: message(err) }),
    )
    return () => {
      live = false
    }
  }, [attempt])
  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])
  return { state, retry }
}

export type TranscriptState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  // refreshError: the latest re-read failed; messages are from the last good one.
  | { status: 'data'; messages: SessionMessage[]; refreshError: string | null }

export const TRANSCRIPT_REFRESH_MS = 3000

// A conversation running in another terminal, re-read every few seconds while
// `active` and the window is visible. The next read waits for the previous
// one, so a slow transcript slows the refresh instead of piling reads up.
export function useOutsideTranscript(cwd: string | null, sessionId: string, active: boolean): TranscriptState {
  const [state, setState] = useState<TranscriptState>({ status: 'loading' })
  useEffect(() => {
    setState({ status: 'loading' })
  }, [cwd, sessionId])
  useEffect(() => {
    if (!cwd || !active) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      if (document.hidden) {
        timer = setTimeout(tick, TRANSCRIPT_REFRESH_MS)
        return
      }
      window.hubApi.readSession(cwd, sessionId).then(
        (messages) => {
          if (!live) return
          setState({ status: 'data', messages, refreshError: null })
          timer = setTimeout(tick, TRANSCRIPT_REFRESH_MS)
        },
        (err: unknown) => {
          if (!live) return
          setState((s) => (s.status === 'data' ? { ...s, refreshError: message(err) } : { status: 'error', error: message(err) }))
          timer = setTimeout(tick, TRANSCRIPT_REFRESH_MS)
        },
      )
    }
    tick()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [cwd, sessionId, active])
  return state
}
