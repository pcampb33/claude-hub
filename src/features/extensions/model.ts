// Pure view logic for the Extensions page: buckets, labels, tones, sorting
// and the KPI sentences. Kept out of the components so it can be tested
// under plain node.
import type { ExtensionItem, ExtensionsSnapshot, ExtensionStatus } from '../../../shared/ipc-types'

export type Bucket = 'work' | 'idle' | 'broken' | 'off'
export type TypeFilter = 'all' | 'mcp' | 'plugin' | 'connector'
export type Tone = 'ok' | 'warn' | 'danger' | 'faint'

export const GROUPS: { key: Bucket; label: string; tone: Tone }[] = [
  { key: 'work', label: 'Doing the work', tone: 'ok' },
  { key: 'idle', label: 'Loaded, never used', tone: 'warn' },
  { key: 'broken', label: 'Can’t connect', tone: 'danger' },
  { key: 'off', label: 'Off, unchecked or gone', tone: 'faint' },
]

export const TYPES: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'mcp', label: 'MCP servers' },
  { key: 'plugin', label: 'Plugins' },
  { key: 'connector', label: 'Connectors' },
]

// 'unknown' and 'pending-approval' sit with the broken ones: neither is
// connected, and both want someone to look.
// Home's Needs you counts from the same set, so the two never disagree.
const BROKEN: ExtensionStatus[] = ['needs-auth', 'failed', 'unknown', 'pending-approval']
export const isBroken = (item: ExtensionItem) => BROKEN.includes(item.status)

// calls covers the 30-day window; lastUsedIso is all-time.
export const neverUsed = (item: ExtensionItem) =>
  item.usage !== null && item.usage.calls === 0 && item.usage.lastUsedIso === null

export function bucketOf(item: ExtensionItem): Bucket {
  if (item.usage && item.usage.calls > 0) return 'work'
  if (item.status === 'connected' || item.status === 'enabled') return 'idle'
  if (isBroken(item)) return 'broken'
  return 'off'
}

const STATUS: Record<ExtensionStatus, { label: string; tone: Tone; glyph: string }> = {
  connected: { label: 'Connected', tone: 'ok', glyph: '●' },
  enabled: { label: 'Enabled', tone: 'ok', glyph: '●' },
  'needs-auth': { label: 'Needs sign-in', tone: 'warn', glyph: '!' },
  'pending-approval': { label: 'Pending approval', tone: 'warn', glyph: '⏸' },
  failed: { label: 'Fails to connect', tone: 'danger', glyph: '✕' },
  unknown: { label: 'Unrecognised status', tone: 'warn', glyph: '?' },
  'not-configured': { label: 'Not configured', tone: 'faint', glyph: '–' },
  disabled: { label: 'Disabled', tone: 'faint', glyph: '○' },
  'not-listed': { label: 'Not listed', tone: 'faint', glyph: '○' },
  unchecked: { label: 'Unchecked', tone: 'faint', glyph: '?' },
}

// The CLI's own words win when it gave any.
export function statusLabel(item: ExtensionItem): string {
  if (item.statusText) return item.statusText
  if (item.status === 'not-listed' && item.kind === 'connector') return 'Not offered now'
  return STATUS[item.status].label
}

export const statusTone = (item: ExtensionItem): Tone => STATUS[item.status].tone
export const statusGlyph = (item: ExtensionItem): string => STATUS[item.status].glyph

export const kindLabel = (item: ExtensionItem): string =>
  item.kind === 'mcp' ? 'MCP server' : item.kind === 'plugin' ? 'Plugin' : 'claude.ai connector'

export function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
}

// Where the item comes from, in a few words.
export function originLabel(item: ExtensionItem): string {
  if (item.kind === 'connector') return 'claude.ai connector'
  if (item.kind === 'plugin') {
    if (item.scope === 'synced') return 'synced from claude.ai'
    if (item.scope === 'project' && item.projectPath) {
      return `project · ${item.projectPath.split('; ').map(baseName).join(' + ')}`
    }
    const market = item.pluginId?.split('@')[1]
    return market ? `installed from ${market}` : item.scope
  }
  if (item.scope === 'plugin') return `plugin · ${item.pluginId?.split('@')[0] ?? 'unknown'}`
  if (item.scope === 'user') return 'Your server'
  if (item.scope === 'local' && item.projectPath) return `local · ${baseName(item.projectPath)}`
  return 'Project server'
}

export const callsOf = (item: ExtensionItem): number => item.usage?.calls ?? 0

export function compareItems(a: ExtensionItem, b: ExtensionItem): number {
  return callsOf(b) - callsOf(a) || (b.alwaysOnTokens ?? 0) - (a.alwaysOnTokens ?? 0) || a.name.localeCompare(b.name)
}

export function visibleItems(items: ExtensionItem[], type: TypeFilter, bucket: Bucket | null): ExtensionItem[] {
  return items.filter((i) => (type === 'all' || i.kind === type) && (!bucket || bucketOf(i) === bucket)).sort(compareItems)
}

// `~1.6k` style, matching how `claude plugin details` prints costs.
export function compactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n)
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// Whether the last health check is a current answer. Without one, "0 can't
// connect" would be a claim about servers nobody checked.
export function healthIsCurrent(health: ExtensionsSnapshot['health']): boolean {
  if (health.state === 'ok') return true
  return health.state === 'running' && health.checkedAtIso !== null && health.error === null
}

export interface Kpi {
  key: Bucket
  label: string
  tone: Tone
  // null = can't be counted honestly right now; `sub` says why.
  value: number | null
  sub: string
}

export function kpis(snap: ExtensionsSnapshot): Kpi[] {
  const items = snap.items
  const usageOk = snap.usage.state === 'ok'
  const healthOk = healthIsCurrent(snap.health)
  const by = (b: Bucket) => items.filter((i) => bucketOf(i) === b)
  const count = (list: ExtensionItem[], s: ExtensionStatus) => list.filter((i) => i.status === s).length
  const usageWhy = snap.usage.running ? 'scanning transcripts…' : 'usage scan unavailable'
  const healthWhy =
    snap.health.state === 'error' ? 'the health check failed' : snap.health.state === 'running' ? 'checking servers…' : 'not checked yet'

  const work = by('work')
  const totalCalls = work.reduce((a, i) => a + callsOf(i), 0)
  const top = [...work].sort(compareItems).slice(0, 2)
  const topShare = totalCalls ? Math.round((top.reduce((a, i) => a + callsOf(i), 0) / totalCalls) * 100) : 0
  const workSub = !usageOk
    ? usageWhy
    : totalCalls === 0
      ? 'no tool calls in 30 days'
      : `${totalCalls.toLocaleString()} tool calls in 30 days${work.length > 2 ? `; ${top.map((i) => i.name).join(' and ')} make ${topShare}%` : ''}`

  const idle = by('idle')
  const idlePlugins = idle.filter((i) => i.kind === 'plugin')
  const idleTokens = idlePlugins.reduce((a, i) => a + (i.alwaysOnTokens ?? 0), 0)
  const idleServers = idle.length - idlePlugins.length
  const idleParts = [
    idlePlugins.length ? `${plural(idlePlugins.length, 'plugin')} add ~${compactTokens(idleTokens)} tokens to every session` : '',
    idleServers ? `${plural(idleServers, 'connected server')} with no calls` : '',
  ].filter(Boolean)

  const broken = by('broken')
  const brokenParts = [
    count(broken, 'failed') ? `${count(broken, 'failed')} fail to connect` : '',
    count(broken, 'needs-auth') ? `${count(broken, 'needs-auth')} wait for a sign-in` : '',
    count(broken, 'pending-approval') ? `${count(broken, 'pending-approval')} await approval` : '',
    count(broken, 'unknown') ? `${count(broken, 'unknown')} unrecognised` : '',
  ].filter(Boolean)

  const off = by('off')
  const offParts = [
    count(off, 'disabled') ? `${count(off, 'disabled')} disabled` : '',
    count(off, 'not-configured') ? `${count(off, 'not-configured')} unconfigured` : '',
    count(off, 'not-listed') ? `${count(off, 'not-listed')} not listed` : '',
    count(off, 'unchecked') ? `${count(off, 'unchecked')} unchecked` : '',
  ].filter(Boolean)

  return [
    { key: 'work', label: 'Doing the work', tone: 'ok', value: usageOk ? work.length : null, sub: workSub },
    {
      key: 'idle',
      label: usageOk ? 'Loaded, never used' : 'Loaded, usage unknown',
      tone: 'warn',
      value: idle.length,
      sub: !usageOk ? usageWhy : idleParts.join('; ') || 'nothing loaded sits idle',
    },
    {
      key: 'broken',
      label: 'Can’t connect',
      tone: 'danger',
      value: healthOk ? broken.length : null,
      sub: !healthOk ? healthWhy : brokenParts.join(', ') || 'every checked server connects',
    },
    { key: 'off', label: 'Off, unchecked or gone', tone: 'faint', value: off.length, sub: offParts.join(', ') || 'none' },
  ]
}

// One plain sentence on what the status means for this item. Derived only
// from what the snapshot knows; nothing here guesses at a cause the CLI
// didn't report.
export function explain(item: ExtensionItem, snap: ExtensionsSnapshot): string {
  const owner = item.pluginId?.split('@')[0]
  switch (item.status) {
    case 'needs-auth':
      return owner && item.kind === 'mcp' && neverUsed(item)
        ? `Waits for a sign-in before Claude can use it. It has never been called, so disabling the ${owner} plugin that brings it may be the better fix.`
        : 'Waits for a sign-in before Claude can use it.'
    case 'failed':
      return 'Claude Code couldn’t connect to it on the last check, so its tools are missing from every session.'
    case 'pending-approval':
      return 'A project server waiting for your approval. Claude Code won’t connect to it until you approve it.'
    case 'unknown':
      return `Claude Code reported a status this page doesn’t recognise: “${item.statusText ?? ''}”.`
    case 'not-configured':
      return item.scope === 'plugin'
        ? `The ${owner ?? 'owning'} plugin ships this server without a URL, so it never starts.`
        : 'Claude Code reports it as not configured, so it never starts.'
    case 'not-listed':
      return item.kind === 'connector'
        ? 'Was connected once. Claude Code isn’t offered it now, so it may be off or removed on claude.ai.'
        : `The ${owner ?? 'owning'} plugin declares it, but the last check didn’t list it, so no session starts it.`
    case 'unchecked':
      if (item.scope === 'local') return 'Project-local servers are only health-checked inside their own project, so this one hasn’t been checked.'
      if (snap.health.state === 'error') return `Not checked: the last health check failed (${snap.health.error ?? 'no reason given'}).`
      if (snap.health.state === 'running') return 'The health check is running; its status shows when it finishes.'
      return 'No health check has run yet.'
    case 'disabled':
      return 'Installed but disabled, so it adds nothing to sessions.'
    case 'enabled':
      if (!item.usage) return 'Enabled and loaded into every session. Its skill use is unknown because the usage scan didn’t run.'
      return item.usage.calls > 0
        ? 'Enabled, and its skills were used in the last 30 days.'
        : 'Enabled and loaded into every session, but none of its skills ran in the last 30 days.'
    case 'connected':
      if (!item.usage) return 'Connected. Its usage is unknown because the usage scan didn’t run.'
      if (item.usage.calls > 0) return 'Connected, and called in the last 30 days.'
      return item.kind === 'connector'
        ? 'Connected and offered to every session, but no tool calls in 30 days.'
        : 'Connected and started with every session, but no tool calls in 30 days.'
  }
}

// A command for the user to run themselves. Names with spaces are quoted;
// connectors are managed on claude.ai, so they get none.
export function cliCommand(item: ExtensionItem): string | null {
  const q = (s: string) => (/^[\w@.:-]+$/.test(s) ? s : `"${s}"`)
  if (item.kind === 'plugin') return item.status === 'enabled' ? `claude plugin disable ${q(item.pluginId ?? item.name)}` : `claude plugin uninstall ${q(item.pluginId ?? item.name)}`
  if (item.kind === 'connector') return null
  if (item.scope === 'plugin') return item.pluginId ? `claude plugin disable ${q(item.pluginId)}` : null
  if (item.scope === 'user') return `claude mcp remove ${q(item.name)} -s user`
  if (item.scope === 'local') return `claude mcp remove ${q(item.name)} -s local`
  return `claude mcp remove ${q(item.name)} -s project`
}
