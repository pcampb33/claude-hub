import { useState, type ReactNode } from 'react'
import type { ConfigLayer, ConfigLayerScope, ProjectConfigReport } from '../../../shared/ipc-types'
import { ErrorNotice } from '../shared/ErrorNotice'
import { SCOPE_LABEL, SCOPE_NOTE, compactTokens, layerIsEmpty, overriddenBy, serverOverriddenBy } from './config-model.ts'
import type { Fetched } from './useConfig'

const CHIP_CAP = 8

// Permission rules as chips; long lists fold behind "+N more".
function Rules({ kind, rules }: { kind: 'allow' | 'ask' | 'deny'; rules: string[] }) {
  const [all, setAll] = useState(false)
  if (rules.length === 0) return null
  const shown = all ? rules : rules.slice(0, CHIP_CAP)
  return (
    <div className="cfg-rules" data-kind={kind}>
      <span className="cfg-rules-head">
        {kind} <em>{rules.length}</em>
      </span>
      <span className="cfg-chips">
        {shown.map((r, i) => (
          <code key={i} className="cfg-rule">
            {r}
          </code>
        ))}
        {rules.length > CHIP_CAP && (
          <button type="button" className="cfg-more" onClick={() => setAll((v) => !v)}>
            {all ? 'fewer' : `+${rules.length - CHIP_CAP} more`}
          </button>
        )}
      </span>
    </div>
  )
}

function Names({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="cfg-faint">none</span>
  return (
    <details className="cfg-names">
      <summary>{names.length}</summary>
      <span className="cfg-chips">
        {names.map((n) => (
          <code key={n} className="cfg-rule">
            {n}
          </code>
        ))}
      </span>
    </details>
  )
}

// A value a later layer replaces: struck, with who wins.
function Overridable({ value, by }: { value: string; by: ConfigLayerScope | null }) {
  if (!by) return <code className="cfg-val">{value}</code>
  return (
    <span className="cfg-overridden" title={`${SCOPE_LABEL[by]} sets this too, and the later layer wins`}>
      <s>
        <code className="cfg-val">{value}</code>
      </s>{' '}
      <em>overridden by {SCOPE_LABEL[by]}</em>
    </span>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

function Layer({ layer, layers }: { layer: ConfigLayer; layers: ConfigLayer[] }) {
  const p = layer.permissions
  const empty = layerIsEmpty(layer)
  const extras: [string, string[]][] = [
    ['Skills', layer.skills],
    ['Agents', layer.agents],
    ['Commands', layer.commands],
    ['Workflows', layer.workflows],
  ]
  return (
    <section className="cfg-layer" aria-label={`${SCOPE_LABEL[layer.scope]} layer`}>
      <header>
        <b>{SCOPE_LABEL[layer.scope]}</b>
        <small>{SCOPE_NOTE[layer.scope]}</small>
      </header>

      {layer.files.length > 0 && (
        <ul className="cfg-files">
          {layer.files.map((f) => (
            <li key={f.path} title={f.path} data-state={f.error ? 'error' : f.exists ? 'found' : 'missing'}>
              <code>{f.label}</code>
              <span>{f.error ? `couldn’t read: ${f.error}` : f.exists ? 'found' : 'missing'}</span>
            </li>
          ))}
        </ul>
      )}

      {empty ? (
        <p className="cfg-faint">Nothing set at this level.</p>
      ) : (
        <dl className="cfg-kv">
          {layer.claudeMdTokens !== null && <Row label="CLAUDE.md">~{compactTokens(layer.claudeMdTokens)} tokens</Row>}
          {layer.model !== null && (
            <Row label="Model">
              <Overridable value={layer.model} by={overriddenBy(layers, layer.scope, 'model')} />
            </Row>
          )}
          {p && (
            <Row label="Permissions">
              <div className="cfg-perms">
                {p.defaultMode !== null && (
                  <span>
                    mode <Overridable value={p.defaultMode} by={overriddenBy(layers, layer.scope, 'defaultMode')} />
                  </span>
                )}
                <Rules kind="deny" rules={p.deny} />
                <Rules kind="ask" rules={p.ask} />
                <Rules kind="allow" rules={p.allow} />
                {p.defaultMode === null && p.allow.length + p.ask.length + p.deny.length === 0 && (
                  <span className="cfg-faint">block present, no rules</span>
                )}
              </div>
            </Row>
          )}
          {layer.hooks.length > 0 && (
            <Row label="Hooks">
              <ul className="cfg-list-plain">
                {layer.hooks.map((h, i) => (
                  <li key={i}>
                    <b>{h.event}</b> <code className="cfg-val cfg-trunc" title={h.command}>{h.command}</code>
                  </li>
                ))}
              </ul>
            </Row>
          )}
          {layer.mcpServers.length > 0 && (
            <Row label="MCP servers">
              <ul className="cfg-list-plain">
                {layer.mcpServers.map((s) => {
                  const by = serverOverriddenBy(layers, layer.scope, s.name)
                  return (
                    <li key={s.name} className={by ? 'is-overridden' : undefined}>
                      <b>{s.name}</b>{' '}
                      <span className="cfg-state" data-on={s.enabled === null ? 'unknown' : String(s.enabled)}>
                        {s.enabled === null ? 'not stated' : s.enabled ? 'enabled' : 'disabled'}
                      </span>{' '}
                      <code className="cfg-val cfg-trunc" title={s.target}>
                        {s.target}
                      </code>
                      {by && <em className="cfg-overridden"> overridden by {SCOPE_LABEL[by]}</em>}
                    </li>
                  )
                })}
              </ul>
            </Row>
          )}
          {extras
            .filter(([, names]) => names.length > 0)
            .map(([label, names]) => (
              <Row key={label} label={label}>
                <Names names={names} />
              </Row>
            ))}
        </dl>
      )}
    </section>
  )
}

export function LayersSection({ state, onRetry }: { state: Fetched<ProjectConfigReport>; onRetry: () => void }) {
  return (
    <section className="cfg-card" aria-label="Configuration layers">
      <h5>Configuration</h5>
      <p className="cfg-sub">Three layers, later wins: Local over Project over Global. Permission rules and hooks add up across layers.</p>
      {state.status === 'loading' && (
        <div aria-busy="true" aria-label="Reading configuration" className="cfg-layers">
          <div className="skeleton cfg-skel-layer" />
          <div className="skeleton cfg-skel-layer" />
        </div>
      )}
      {state.status === 'error' && <ErrorNotice message={`Couldn’t read this project’s configuration: ${state.error}`} onRetry={onRetry} />}
      {state.status === 'data' && (
        <>
          {state.data.error && <p className="cfg-note is-warn">Part of the configuration couldn’t be read: {state.data.error}</p>}
          <div className="cfg-layers">
            {state.data.layers.map((l) => (
              <Layer key={l.scope} layer={l} layers={state.data.layers} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}
