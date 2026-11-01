import { useCallback, useEffect, useRef, useState } from 'react'
import { CommandPalette } from './features/command-palette'
import { TitleBar } from './features/live/TitleBar'
import { useLiveTitle } from './features/live/useLiveTitle'
import { ToastHost } from './features/shared/ToastHost'
import { useHashRoute, RouteParamContext, NavigateContext } from './features/shared/useHashRoute'
import { useAppLoading } from './features/shared/appLoading'
import { useSandboxJobs } from './features/shared/useSandboxJobs'
import { useDesktopNeedsCount } from './features/desktop/useDesktop'
import { VIEWS, SECTIONS, isViewKey, sectionOf, type SectionKey, type ViewKey } from './nav'
import './App.css'

function relativeTime(then: number, now: number): string {
  const seconds = Math.round((now - then) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

function App() {
  const { route, navigate } = useHashRoute(isViewKey, 'dashboard')
  const activeView: ViewKey = isViewKey(route.view) ? route.view : 'dashboard'
  const ActiveComponent = VIEWS[activeView].component
  const anyLoading = useAppLoading()
  useLiveTitle()
  const sandboxJobs = useSandboxJobs()
  const needsYou = useDesktopNeedsCount()

  const activeSection = sectionOf(activeView)

  // The view each section was last on, so clicking Knowledge returns to the
  // tab you left rather than always its first one.
  const lastViewRef = useRef(new Map<SectionKey, ViewKey>())
  if (activeSection) lastViewRef.current.set(activeSection.key, activeView)
  const openSection = useCallback(
    (key: SectionKey) => {
      const section = SECTIONS.find((s) => s.key === key)
      if (section) navigate(lastViewRef.current.get(key) ?? section.views[0])
    },
    [navigate],
  )

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [ctrlHeld, setCtrlHeld] = useState(false)

  // Footer: project count + when it was fetched. Three states, not two — a
  // rejected read used to leave `projectCount` null forever, which renders
  // exactly like the first frame before the read lands, so a broken registry
  // showed as a footer that simply never appeared. The rail was the one place
  // left in the app where a failure was not named.
  const [projectCount, setProjectCount] = useState<number | null>(null)
  const [countFailed, setCountFailed] = useState(false)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    window.hubApi
      .listProjects()
      .then((projects) => {
        setProjectCount(projects.length)
        setRefreshedAt(Date.now())
      })
      .catch(() => setCountFailed(true))
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(true)
      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        if (e.key === 'k' || e.key === 'K') {
          e.preventDefault()
          setPaletteOpen((open) => !open)
          return
        }
        // Ctrl+1..8 walk the rail's sections.
        if (e.key.length === 1 && /[1-9]/.test(e.key)) {
          const index = Number(e.key) - 1
          if (index < SECTIONS.length) {
            e.preventDefault()
            openSection(SECTIONS[index].key)
          }
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(false)
    }
    const onBlur = () => setCtrlHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [openSection])

  // Sliding active-indicator bar: measure the active nav item and translate
  // a single absolutely-positioned bar to it.
  const navListRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<SectionKey, HTMLButtonElement>())
  const [barTop, setBarTop] = useState<number | null>(null)
  const activeSectionKey = activeSection?.key
  useEffect(() => {
    const item = activeSectionKey ? itemRefs.current.get(activeSectionKey) : undefined
    const list = navListRef.current
    if (!list) return
    // A routable view need not be in the rail — `search` is reachable by
    // Ctrl+K handoff and by hash, but has no icon. Leaving the bar where it
    // was would light a neighbouring item and claim you are somewhere you are
    // not, so an unlisted view retracts the indicator instead.
    if (!item) {
      setBarTop(null)
      return
    }
    const itemRect = item.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    setBarTop(itemRect.top - listRect.top)
  }, [activeSectionKey])

  const setItemRef = useCallback((key: SectionKey, el: HTMLButtonElement | null) => {
    if (el) itemRefs.current.set(key, el)
    else itemRefs.current.delete(key)
  }, [])

  const footerTitle = countFailed
    ? 'Could not read the project registry — this is not a count of zero'
    : projectCount !== null
      ? `${projectCount} projects${refreshedAt !== null ? ` · refreshed ${relativeTime(refreshedAt, now)}` : ''}`
      : undefined

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <div className="app-nav-header" title="claude-hub">
          <span className="app-nav-brand">
            c<span className={`app-nav-led${anyLoading ? ' breathing' : ''}`} />
          </span>
        </div>
        <div className="app-nav-list" ref={navListRef}>
          {barTop !== null && <div className="app-nav-active-bar" style={{ transform: `translateY(${barTop}px)` }} />}
          {SECTIONS.map((section, index) => {
            const Icon = section.icon
            const active = section.key === activeSectionKey
            const shortcut = String(index + 1)
            const badge = section.key === 'sessions' && needsYou ? needsYou : 0
            return (
              <button
                key={section.key}
                ref={(el) => setItemRef(section.key, el)}
                className={`app-nav-item${active ? ' active' : ''}${section.key === 'settings' ? ' app-nav-foot' : ''}`}
                onClick={() => openSection(section.key)}
                aria-label={badge ? `${section.label}, ${badge} need${badge === 1 ? 's' : ''} you` : section.label}
                aria-current={active ? 'page' : undefined}
              >
                <Icon className="app-nav-icon" />
                <span className="app-nav-label">{section.label}</span>
                <span className="app-nav-tip">
                  {section.label}
                  <kbd className="app-nav-tip-kbd">Ctrl {shortcut}</kbd>
                </span>
                {badge > 0 && !ctrlHeld && (
                  <span className="desk-rail-badge" aria-hidden="true">
                    {badge}
                  </span>
                )}
                {ctrlHeld && <kbd className="app-nav-kbd">{shortcut}</kbd>}
              </button>
            )
          })}
        </div>
        {sandboxJobs.length > 0 && (
          <button
            className="app-nav-jobs"
            onClick={() => navigate('sandbox')}
            title={sandboxJobs.map((j) => `${j.experimentName} — ${j.phase}`).join('\n')}
            aria-label={`${sandboxJobs.length} background job${sandboxJobs.length === 1 ? '' : 's'} running`}
          >
            <span className="app-nav-jobs-spinner" aria-hidden="true" />
            <span className="app-nav-jobs-count">{sandboxJobs.length}</span>
          </button>
        )}
        {(projectCount !== null || countFailed) && (
          <div className={`app-nav-footer${countFailed ? ' unread' : ''}`} title={footerTitle}>
            <span className="app-nav-footer-count">{countFailed ? '—' : projectCount}</span>
            <span className="app-nav-footer-label">{countFailed ? 'unread' : 'projects'}</span>
          </div>
        )}
      </nav>
      {/* The live surfaces are inside the navigate provider (they deep-link
          into the Sessions view) but outside the keyed view-transition div,
          so they are not torn down and remounted on every route change.
          The titlebar strip is a flex sibling ABOVE the scroller (never
          sticky inside it — that is what kept going stale as a drag rect). */}
      <NavigateContext.Provider value={navigate}>
        <div className="app-main">
          <TitleBar onOpenPalette={() => setPaletteOpen(true)} />
          <main className="app-content">
            {activeSection && activeSection.views.length > 1 && (
              <div className="section-tabs" role="tablist" aria-label={activeSection.label}>
                {activeSection.views.map((key) => (
                  <button
                    key={key}
                    role="tab"
                    aria-selected={key === activeView}
                    className="section-tab"
                    onClick={() => navigate(key)}
                  >
                    {VIEWS[key].label}
                  </button>
                ))}
              </div>
            )}
            <div className="view-transition" key={activeView}>
              <RouteParamContext.Provider value={route.param}>
                <ActiveComponent />
              </RouteParamContext.Provider>
            </div>
          </main>
        </div>
      </NavigateContext.Provider>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={navigate} />
      <ToastHost />
    </div>
  )
}

export default App
