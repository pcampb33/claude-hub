import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

// Hash routing contract (shared across the app revamp agents):
//   "#/<viewKey>"            → view
//   "#/<viewKey>/<param>"    → view + one param (e.g. "#/projects/<registryId>")
// Back/forward work via the hashchange listener. localStorage keeps the
// last view as the fallback default when the window opens with no hash.

export interface HashRoute {
  view: string
  param: string | null
}

const LAST_VIEW_KEY = 'claude-hub:last-view'

function parseHash(hash: string): HashRoute | null {
  const match = /^#\/([^/]+)(?:\/(.+))?$/.exec(hash)
  if (!match) return null
  return { view: match[1], param: match[2] ? decodeURIComponent(match[2]) : null }
}

// Point the URL at the view actually on screen. replaceState rather than
// assigning location.hash: assigning pushes a history entry, so Back would
// land on the bad hash and bounce straight back off it.
function syncHash(route: HashRoute): void {
  const hash = route.param ? `#/${route.view}/${encodeURIComponent(route.param)}` : `#/${route.view}`
  if (window.location.hash !== hash) window.history.replaceState(null, '', hash)
}

export function useHashRoute(isValidView: (view: string) => boolean, fallbackView: string) {
  const [route, setRoute] = useState<HashRoute>(() => {
    const parsed = parseHash(window.location.hash)
    if (parsed && isValidView(parsed.view)) return parsed
    // Renderer localStorage persists across launches with zero main-process
    // or IPC involvement — no reason to route this through registry.json or
    // a new IPC channel for something this small and UI-only.
    const stored = localStorage.getItem(LAST_VIEW_KEY)
    return { view: stored !== null && isValidView(stored) ? stored : fallbackView, param: null }
  })

  // Read by the hashchange handler, which would otherwise close over a stale
  // route from the render that installed it.
  const routeRef = useRef(route)
  routeRef.current = route

  // A hash naming no view — a stale bookmark, a route renamed since — used to
  // be ignored in place: the app kept rendering whatever it had while the URL
  // went on claiming somewhere else. The state initializer above already fell
  // back to something real; this stops the address bar contradicting it.
  useEffect(() => {
    // Mount only: every later valid navigation sets the hash itself.
    syncHash(routeRef.current)
  }, [])

  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHash(window.location.hash)
      if (parsed && isValidView(parsed.view)) {
        setRoute(parsed)
        localStorage.setItem(LAST_VIEW_KEY, parsed.view)
      } else {
        // Same correction for a bad hash arrived at later (typed, or a link).
        syncHash(routeRef.current)
      }
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
    // isValidView is derived from the static VIEWS table — stable in practice.
  }, [isValidView])

  const navigate = useCallback((view: string, param?: string) => {
    window.location.hash = param ? `#/${view}/${encodeURIComponent(param)}` : `#/${view}`
    localStorage.setItem(LAST_VIEW_KEY, view)
    // The hashchange listener updates state. Setting an identical hash fires
    // no event, which is fine — the state already matches.
  }, [])

  return { route, navigate }
}

// The active view reads its route param (e.g. a note id) from this context;
// App provides it so views don't each re-parse the hash.
export const RouteParamContext = createContext<string | null>(null)

// Navigation for nested components (dashboard widgets etc.) so they call the
// same encoding-aware navigate() as the shell instead of poking
// location.hash directly. App provides the real function; the default no-op
// keeps components renderable outside the provider (e.g. in isolation).
export type NavigateFn = (view: string, param?: string) => void

export const NavigateContext = createContext<NavigateFn>(() => {})

export function useNavigate(): NavigateFn {
  return useContext(NavigateContext)
}
