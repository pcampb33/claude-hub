import { useContext, useMemo, useRef, useState } from 'react'
import { ViewHeader, RefreshAction } from '../shared/ViewHeader'
import { ErrorNotice } from '../shared/ErrorNotice'
import { RouteParamContext, useNavigate } from '../shared/useHashRoute'
import { useReportLoading } from '../shared/appLoading'
import { groupTargets, parseTargetParam, sameTarget, targetParam } from './config-model.ts'
import { useBoundaries, useConfigTargets } from './useConfig'
import { TargetList } from './TargetList'
import { ConfigDetail } from './ConfigDetail'
import './config.css'

// Projects › Config: per project (or sandbox experiment), the Claude Code
// configuration its sessions inherit and the boundary it declares.
export function ConfigView() {
  const targets = useConfigTargets()
  useReportLoading(targets.state.status === 'loading')
  const list = useMemo(() => (targets.state.status === 'data' ? targets.state.data.targets : null), [targets.state])
  const boundaries = useBoundaries(list)
  const param = useContext(RouteParamContext)
  const navigate = useNavigate()
  const [filter, setFilter] = useState('')
  const detailRef = useRef<HTMLDivElement>(null)

  const asked = parseTargetParam(param)
  const first = useMemo(() => {
    if (!list) return null
    const g = groupTargets(list, '')
    return g.projects[0] ?? g.experiments[0] ?? null
  }, [list])
  const selected = list ? (asked ? (list.find((t) => sameTarget(t, asked)) ?? null) : first) : null

  const onPick = (key: string) => {
    navigate('config', key)
    if (window.innerWidth < 980) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <section className="cfg-view">
      <ViewHeader
        title="Config"
        subtitle={
          <>
            What each project’s Claude Code sessions inherit (global, project and local settings) and the boundary it
            declares: which other projects its sessions may read or write. Guarded blocks Claude’s file tools only;
            native Windows has no shell sandbox, so Bash and PowerShell are never fenced.
          </>
        }
        actions={
          <RefreshAction
            loading={targets.state.status === 'loading'}
            onClick={() => {
              targets.retry()
              list?.forEach(boundaries.retry)
            }}
          />
        }
      />

      {targets.state.status === 'error' && (
        <ErrorNotice message={`Couldn’t list projects and experiments: ${targets.state.error}`} onRetry={targets.retry} />
      )}
      {targets.state.status === 'data' && targets.state.data.error && (
        <p className="cfg-note is-warn">Part of the list couldn’t be read: {targets.state.data.error}</p>
      )}

      {targets.state.status === 'loading' && (
        <div className="cfg-two" aria-busy="true" aria-label="Loading projects">
          <div className="cfg-list">
            <div className="skeleton cfg-skel" />
            <div className="skeleton cfg-skel" />
            <div className="skeleton cfg-skel" />
          </div>
          <div className="skeleton cfg-skel-detail" />
        </div>
      )}

      {list && (
        <div className="cfg-two">
          <TargetList
            targets={list}
            filter={filter}
            onFilter={setFilter}
            selectedKey={selected ? targetParam(selected) : null}
            boundaries={boundaries.entries}
            onPick={onPick}
          />
          <div className="cfg-detail" ref={detailRef} aria-live="polite">
            {selected ? (
              <ConfigDetail
                key={targetParam(selected)}
                target={selected}
                targets={list}
                boundary={boundaries.entries[targetParam(selected)] ?? null}
                onBoundary={boundaries.put}
                onRetryBoundary={() => boundaries.retry(selected)}
              />
            ) : (
              <div className="cfg-empty">
                <b>{asked ? 'Not found' : 'Nothing to configure'}</b>
                <span>
                  {asked
                    ? `No project or sandbox experiment matches “${asked.key}”. It may have been removed or renamed.`
                    : 'No projects or sandbox experiments yet. Add a project in Projects first.'}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
