// Minimal DOM + hubApi harness for renderer-hook tests.
//
// Why this exists (option AT): every renderer bug this loop has found — the
// dashboard's loading flag never clearing, the config-health ring spinning
// forever, the palette answering "No matches." for a corpus it never read —
// lived in a hook's fetch path, and `node --test` could not see any of them.
// They were found by reading and verified by driving the real app.
//
// Deliberately NOT a global setup file: jsdom costs ~200ms to construct, and
// the other 434 tests are pure-core and do not want it. A hook test opts in by
// awaiting installDom() before importing React.
import { JSDOM } from 'jsdom'

let installed = false

// React must not be imported until the DOM globals exist, so hook tests
// dynamic-import both this and their subject.
export function installDom(): void {
  if (installed) return
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.window.document
  g.navigator ??= dom.window.navigator
  g.HTMLElement = dom.window.HTMLElement
  g.Element = dom.window.Element
  g.Node = dom.window.Node
  g.Event = dom.window.Event
  g.CustomEvent = dom.window.CustomEvent
  g.getComputedStyle = dom.window.getComputedStyle
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number
  g.cancelAnimationFrame = (id: number) => clearTimeout(id)
  // React 18 checks this to pick its act() environment.
  g.IS_REACT_ACT_ENVIRONMENT = true
  installed = true
}

// Install just the channels a test cares about; anything else throws loudly
// rather than resolving undefined, so a hook that quietly calls an extra
// channel shows up as a failure instead of a silent empty state.
export function stubHubApi(overrides: Record<string, (...args: unknown[]) => unknown>): void {
  const api = new Proxy(overrides, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return () => {
        throw new Error(`hubApi.${prop}() called but not stubbed in this test`)
      }
    },
  })
  ;(globalThis as unknown as { window: { hubApi: unknown } }).window.hubApi = api
}
