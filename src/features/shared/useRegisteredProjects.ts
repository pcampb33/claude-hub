import { useEffect, useState } from 'react'
// Explicit .ts: this module's hook test runs under plain `node`, which does
// not resolve extension-less relative imports the way Vite does.
import { sharedRead } from './sharedRead.ts'
import type { RegistryEntry } from '../../../shared/ipc-types'

// The registered project list, read once for everyone who needs it.
//
// Nine places each had their own `useEffect(() => { listProjects().then(set) })`
// — the palette, the search view, the sessions view, both workflow panels, the
// project picker, and the fleet fan-out. Since no view ever unmounts, walking
// the app re-ran six of them per lap (measured).
export function readRegisteredProjects(): Promise<RegistryEntry[]> {
  return sharedRead('registry:list', () => window.hubApi.listProjects())
}

export interface RegisteredProjects {
  projects: RegistryEntry[]
  loading: boolean
  error: string | null
}

// Three states, not two. Both callers pour this straight into a <select>, so a
// rejected read used to render as a dropdown with nothing in it — identical to
// having no projects registered, and in the Sessions view it also leaves Start
// permanently disabled with nothing on screen saying why. An empty list must
// mean "none", never "the read failed".
export function useRegisteredProjects(): RegisteredProjects {
  const [state, setState] = useState<RegisteredProjects>({ projects: [], loading: true, error: null })
  useEffect(() => {
    let live = true
    void readRegisteredProjects().then(
      (list) => {
        if (live) setState({ projects: list, loading: false, error: null })
      },
      (err: unknown) => {
        if (live) setState({ projects: [], loading: false, error: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      live = false
    }
  }, [])
  return state
}
