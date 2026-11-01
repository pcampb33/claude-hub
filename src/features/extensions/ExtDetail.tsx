import type { ExtensionItem, ExtensionsSnapshot } from '../../../shared/ipc-types'
import { ConfirmButton } from '../shared/ConfirmButton'
import { copyText } from '../shared/copy-text'
import { relativeTimeOrNever } from '../shared/relative-time'
import { toast } from '../shared/toast'
import { Card, StatusPill, TopBars, Unreachable } from './bits'
import { baseName, cliCommand, compactTokens, explain, kindLabel, originLabel, statusLabel } from './model'

interface Props {
  item: ExtensionItem | null
  snap: ExtensionsSnapshot
  toggling: string | null
  launchProjectId: string | null
  launchBlocker: string
  onJump: (id: string) => void
  onSetEnabled: (pluginId: string, enabled: boolean) => void
}

const fmtTokens = (n: number | null) => (n === null ? '—' : `~${compactTokens(n)}`)

function UsageBlock({ item, snap }: { item: ExtensionItem; snap: ExtensionsSnapshot }) {
  const unit = item.kind === 'plugin' ? 'skill uses' : 'tool calls'
  if (!item.usage) {
    return (
      <Card title="Usage">
        <p className="ext-sub">
          {snap.usage.running ? 'Scanning transcripts… usage shows when the first scan finishes.' : `Usage scan unavailable: ${snap.usage.error ?? 'unknown error'}`}
        </p>
      </Card>
    )
  }
  const { calls, lastUsedIso, topTools } = item.usage
  return (
    <>
      <div className="ext-hero">
        <div>
          <div className="ext-big">{calls.toLocaleString()}</div>
          <div className="ext-sub">{unit}, 30 days</div>
        </div>
        <div>
          <div className="ext-big">{lastUsedIso ? relativeTimeOrNever(lastUsedIso) : 'never'}</div>
          <div className="ext-sub">last used</div>
        </div>
        {item.kind === 'plugin' && (
          <div>
            <div className={`ext-big${item.status === 'enabled' && calls === 0 && item.alwaysOnTokens ? ' is-warn' : ''}`}>
              {fmtTokens(item.alwaysOnTokens)}
            </div>
            <div className="ext-sub">tokens in every session{item.status === 'disabled' ? ' when enabled' : ''}</div>
          </div>
        )}
      </div>
      {topTools.length > 0 && (
        <Card title={item.kind === 'plugin' ? 'Skills used' : 'Top tools'}>
          <TopBars rows={topTools.slice(0, 8)} label={`${item.name}: ${unit} by name`} />
        </Card>
      )}
    </>
  )
}

function PluginCost({ item }: { item: ExtensionItem }) {
  if (item.detailsError) return <Unreachable what="the plugin's token cost" error={item.detailsError} />
  if (item.components.length === 0) {
    return (
      <Card title="Cost per component">
        <p className="ext-sub">
          {item.alwaysOnTokens === null ? 'claude plugin details didn’t report a cost for this plugin.' : 'No per-component costs reported.'}
        </p>
      </Card>
    )
  }
  return (
    <Card title="Cost per component (tokens)">
      <div className="ext-cost">
        <span className="h">component</span>
        <span className="h">always</span>
        <span className="h">when used</span>
        {item.components.map((c) => (
          <span className="ext-cost-row" key={c.name}>
            <span>
              {c.name}
              {c.kind !== 'skill' && <small> {c.kind}</small>}
            </span>
            <span>{fmtTokens(c.alwaysOnTokens)}</span>
            <span>{fmtTokens(c.onInvokeTokens)}</span>
          </span>
        ))}
      </div>
    </Card>
  )
}

function BundledServers({ item, all, onJump }: { item: ExtensionItem; all: ExtensionItem[]; onJump: (id: string) => void }) {
  const servers = all.filter((i) => i.kind === 'mcp' && i.pluginId === item.pluginId)
  return (
    <Card title="MCP servers it brings">
      {servers.length === 0 ? (
        <p className="ext-sub">
          {item.status === 'enabled' ? 'None.' : 'None listed; a disabled plugin’s servers aren’t started or checked.'}
        </p>
      ) : (
        <>
          <div className="ext-links">
            {servers.map((s) => (
              <button type="button" key={s.id} className="ext-link-row" onClick={() => onJump(s.id)}>
                <span>{s.name}</span>
                <em>
                  {statusLabel(s)}
                  {s.usage && s.usage.calls > 0 ? ` · ${s.usage.calls.toLocaleString()} calls` : ''}
                </em>
              </button>
            ))}
          </div>
          <p className="ext-sub">Their tool schemas aren’t counted in the cost above; the CLI resolves them at runtime.</p>
        </>
      )}
    </Card>
  )
}

export function ExtDetail({ item, snap, toggling, launchProjectId, launchBlocker, onJump, onSetEnabled }: Props) {
  if (!item) {
    return (
      <div className="ext-empty">
        <b>Pick an extension</b>
        <span>Its usage, cost and what you can do about it show here.</span>
      </div>
    )
  }
  const owner = item.kind === 'mcp' && item.pluginId ? snap.items.find((i) => i.id === `plugin:${item.pluginId}`) : undefined
  const command = cliCommand(item)
  const busy = toggling !== null && toggling === item.pluginId
  const manage = item.kind === 'plugin' ? 'plugin' : 'mcp'

  const launch = () => {
    if (!launchProjectId) return
    window.hubApi.launchCommandSession(manage, launchProjectId).then(
      () => toast.success(`Opened a Claude Code session with /${manage} ready — press Enter there`),
      (err: unknown) => toast.error(`Couldn’t open a session: ${err instanceof Error ? err.message : String(err)}`),
    )
  }

  return (
    <>
      <div className="ext-head">
        <div>
          <h3>{item.name}</h3>
          <div className="ext-sub">
            {item.kind === 'connector' ? kindLabel(item) : `${kindLabel(item)} · ${originLabel(item)}`}
          </div>
        </div>
        <StatusPill item={item} />
      </div>

      <Card>
        <p>{explain(item, snap)}</p>
        {item.target?.includes('@latest') && (
          <p className="ext-sub is-warn">“@latest” downloads whatever version is newest each time a session starts.</p>
        )}
      </Card>

      <UsageBlock item={item} snap={snap} />

      {item.kind === 'plugin' && (
        <>
          <PluginCost item={item} />
          <BundledServers item={item} all={snap.items} onJump={onJump} />
        </>
      )}

      {(item.kind === 'mcp' || (item.kind === 'connector' && item.target)) && (
        <Card title={item.kind === 'connector' ? 'Endpoint' : 'Runs'}>
          {item.target ? <code className="ext-code">{item.target}</code> : <p className="ext-sub">No command or URL reported.</p>}
          <p className="ext-sub">
            {item.scope === 'local' && item.projectPath ? `local to ${baseName(item.projectPath)} · ${item.projectPath}` : item.scope}
            {item.kind === 'mcp' && ' · tool-schema cost not measured'}
          </p>
          {owner && (
            <p className="ext-sub">
              Brought by the{' '}
              <button type="button" className="ext-inline-link" onClick={() => onJump(owner.id)}>
                {owner.name} plugin
              </button>
              .
            </p>
          )}
        </Card>
      )}

      <div className="ext-actions">
        {item.kind === 'plugin' && item.pluginId && item.status === 'disabled' && (
          <button type="button" className="ext-primary" disabled={busy} onClick={() => onSetEnabled(item.pluginId!, true)}>
            {busy ? 'Enabling…' : 'Enable plugin'}
          </button>
        )}
        {item.kind === 'plugin' && item.pluginId && item.status === 'enabled' && (
          <ConfirmButton
            label={busy ? 'Disabling…' : 'Disable plugin'}
            confirmLabel="Disable — sure?"
            disabled={busy}
            onConfirm={() => onSetEnabled(item.pluginId!, false)}
          />
        )}
        {owner && (
          <button type="button" onClick={() => onJump(owner.id)}>
            Open the {owner.name} plugin
          </button>
        )}
        <button
          type="button"
          disabled={!launchProjectId}
          title={launchProjectId ? `Opens a Claude Code session prefilled with /${manage}` : launchBlocker}
          onClick={launch}
        >
          Manage in Claude Code
        </button>
        {command && (
          <button
            type="button"
            className="btn-ghost"
            title={command}
            onClick={() => void copyText(command, { success: `Copied: ${command}`, failure: 'Couldn’t copy to the clipboard' })}
          >
            Copy CLI command
          </button>
        )}
      </div>
      {item.kind === 'plugin' && item.scope === 'synced' && (
        <p className="ext-sub ext-caveat">
          Synced from claude.ai: whether a disable made here sticks, or the plugin re-syncs on the next start, is unverified.
        </p>
      )}
      {command && <p className="ext-sub ext-caveat">Copy gives you <code>{command}</code> to run yourself; the hub never runs it.</p>}
    </>
  )
}
