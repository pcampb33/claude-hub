import { useRef } from 'react'
import { ViewHeader } from '../shared/ViewHeader'
import { useRegisteredProjects } from '../shared/useRegisteredProjects'
import { useExtensions } from './useExtensions'
import { useSelection } from './useSelection'
import { HealthStatus, Kpis, TypeTabs } from './Summary'
import { ExtList } from './ExtList'
import { ExtDetail } from './ExtDetail'
import { Unreachable } from './bits'
import './extensions.css'

export function ExtensionsView() {
  const { state, rechecking, toggling, reload, recheck, setPluginEnabled } = useExtensions()
  const snap = state.data
  const sel = useSelection(snap?.items)
  const projects = useRegisteredProjects()
  const detailRef = useRef<HTMLDivElement>(null)
  // "Manage in Claude Code" opens a session somewhere; the hub's own project
  // is the natural place, else whichever project is registered first.
  const launchProject = projects.projects.find((p) => p.name === 'claude-hub') ?? projects.projects[0] ?? null

  const onPick = (id: string) => {
    sel.select(id)
    // One column under 980px: the detail sits below the list, so bring it up.
    if (window.innerWidth < 980) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <section className="ext-view">
      <ViewHeader
        title="Extensions"
        subtitle={
          <>
            MCP servers, plugins and claude.ai connectors, from <code>claude mcp list</code>,{' '}
            <code>claude plugin list</code>, <code>claude plugin details</code>, <code>~/.claude.json</code> and a
            scan of your session transcripts.
          </>
        }
        actions={
          <>
            {snap && <HealthStatus health={snap.health} rechecking={rechecking} />}
            <button type="button" onClick={() => void recheck()} disabled={rechecking}>
              {rechecking ? 'Checking…' : 'Recheck'}
            </button>
          </>
        }
      />

      {state.status === 'error' && (
        <Unreachable what="extensions" error={state.error} onRetry={() => void reload()} />
      )}
      {state.status === 'loading' && (
        <div className="ext-loading" aria-busy="true" aria-label="Loading extensions">
          <i />
          <i />
          <i />
        </div>
      )}

      {snap && (
        <>
          <Kpis snap={snap} active={sel.bucket} onToggle={sel.toggleBucket} />
          <div className="ext-bar">
            <TypeTabs items={snap.items} active={sel.type} onChange={sel.setType} />
            <span className="ext-note">
              {snap.usage.state === 'ok'
                ? 'Usage = tool calls (skill uses for plugins) in the last 30 days of transcripts'
                : snap.usage.running
                  ? 'Scanning transcripts for usage…'
                  : `Usage scan unavailable: ${snap.usage.error}`}
            </span>
          </div>
          <div className="ext-two">
            <ExtList
              items={sel.visible}
              selectedId={sel.selected?.id ?? null}
              onPick={onPick}
              usageKnown={snap.usage.state === 'ok'}
            />
            <div className="ext-detail" ref={detailRef} aria-live="polite">
              <ExtDetail
                item={sel.selected}
                snap={snap}
                toggling={toggling}
                launchProjectId={launchProject?.id ?? null}
                launchBlocker={projects.loading ? 'Loading projects…' : projects.error ?? 'No registered project to open a session in'}
                onJump={sel.jumpTo}
                onSetEnabled={setPluginEnabled}
              />
            </div>
          </div>
        </>
      )}
    </section>
  )
}
