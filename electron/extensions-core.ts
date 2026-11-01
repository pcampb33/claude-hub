// Pure parsing and assembly for the Extensions page. extensions.ts does the
// I/O (CLI calls, ~/.claude.json, caches); everything here is a function of
// its inputs so the parsers can be tested against captured CLI output.
// Electron-free.
import type { ExtensionComponentCost, ExtensionItem, ExtensionStatus } from '../shared/ipc-types.ts'
import { normalizeServerName, type ExtensionUsage, type UsageTally } from './skill-usage.ts'

// ---- `claude mcp list` --------------------------------------------------

export interface McpHealthEntry {
  // As the CLI prints it: `playwright`, `claude.ai Gmail`, `plugin:design:slack`.
  name: string
  target: string | null
  status: ExtensionStatus
  statusText: string
}

export function statusFromText(text: string): ExtensionStatus {
  const t = text.trim().toLowerCase()
  if (t === 'connected') return 'connected'
  if (t.startsWith('needs auth')) return 'needs-auth'
  if (t === 'not configured') return 'not-configured'
  if (t.startsWith('pending approval')) return 'pending-approval'
  if (t.startsWith('failed')) return 'failed'
  return 'unknown'
}

// `<name>: <target> - <glyph> <state>`. The target can hold spaces, colons
// and ` - ` itself, and the glyph for "Not configured" is a bare `-`, so
// `(HTTP) - - Not configured` has two ` - `. The greedy left side plus a
// glyph that must be a single non-letter token picks the right one: splitting
// at the second ` - ` would make the glyph `Not`, which fails, so the regex
// backtracks to the first.
const LINE = /^(.*) - ([^\s\p{L}\p{N}]{1,2}) (.+)$/u
// A state with no glyph at all (a format change): keep the words, status unknown.
const LINE_NO_GLYPH = /^(.*) - (.+)$/u
const TRANSPORT = /\s*\((?:HTTP|SSE|stdio)\)$/i

export function parseMcpList(text: string): { entries: McpHealthEntry[]; unparsed: string[] } {
  const entries: McpHealthEntry[] = []
  const unparsed: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.startsWith('Checking MCP server health') || line.startsWith('No MCP servers')) continue
    const m = LINE.exec(line)
    const left = m ? m[1] : LINE_NO_GLYPH.exec(line)?.[1]
    const stateText = m ? m[3].trim() : LINE_NO_GLYPH.exec(line)?.[2].trim()
    const colon = left?.indexOf(': ') ?? -1
    if (left === undefined || stateText === undefined || colon <= 0) {
      unparsed.push(line)
      continue
    }
    const target = left.slice(colon + 2).trim().replace(TRANSPORT, '').trim()
    entries.push({
      name: left.slice(0, colon),
      target: target ? redactTarget(target) : null,
      status: m ? statusFromText(stateText) : 'unknown',
      statusText: stateText,
    })
  }
  return { entries, unparsed }
}

export type ServerOrigin =
  | { kind: 'connector'; display: string }
  | { kind: 'plugin'; plugin: string; server: string }
  | { kind: 'plain' }

export function classifyServer(name: string): ServerOrigin {
  if (name.startsWith('claude.ai ')) return { kind: 'connector', display: name.slice('claude.ai '.length) }
  const m = /^plugin:([^:]+):(.+)$/.exec(name)
  if (m) return { kind: 'plugin', plugin: m[1], server: m[2] }
  return { kind: 'plain' }
}

// ---- `claude plugin list --json` ----------------------------------------

export interface PluginInfo {
  id: string
  name: string
  // The CLI's own string, `unknown` included — it keys the details cache.
  version: string
  scope: string
  enabled: boolean
  projectPaths: string[]
}

interface RawPlugin {
  id?: unknown
  version?: unknown
  scope?: unknown
  enabled?: unknown
  projectPath?: unknown
}

// One entry per id. A plugin installed at project scope in two projects is
// listed twice; it is still one plugin, enabled if any copy is.
export function parsePluginList(json: string): PluginInfo[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) throw new Error('claude plugin list --json did not return an array')
  const byId = new Map<string, PluginInfo>()
  for (const raw of parsed as RawPlugin[]) {
    if (typeof raw?.id !== 'string') continue
    const scope = typeof raw.scope === 'string' ? raw.scope : 'unknown'
    const cur = byId.get(raw.id)
    const projectPath = typeof raw.projectPath === 'string' ? raw.projectPath : null
    if (cur) {
      cur.enabled ||= raw.enabled === true
      if (projectPath) cur.projectPaths.push(projectPath)
      if (scope !== 'project') cur.scope = scope
      continue
    }
    byId.set(raw.id, {
      id: raw.id,
      name: raw.id.split('@')[0],
      version: typeof raw.version === 'string' ? raw.version : 'unknown',
      scope,
      enabled: raw.enabled === true,
      projectPaths: projectPath ? [projectPath] : [],
    })
  }
  return [...byId.values()]
}

// ---- `claude plugin details <id>` ---------------------------------------

export interface PluginDetails {
  alwaysOnTokens: number | null
  components: ExtensionComponentCost[]
  // Bundled MCP server names from the component inventory.
  mcpServers: string[]
}

// `~873`, `~1,576`, `~1.2k` → tokens. Anything else is "not reported".
export function parseTokens(s: string): number | null {
  const m = /^~?([\d,]*\.?\d+)(k?)$/.exec(s.trim())
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(m[2] ? n * 1000 : n) : null
}

const INVENTORY = /^\s+(Skills|Agents|Commands|Hooks|MCP servers|LSP servers)\s+\((\d+)\)\s*(.*)$/
const TOKEN = String.raw`~?[\d,]*\.?\d+k?|—|-`
const COMPONENT_ROW = new RegExp(String.raw`^\s+(\S.*?)\s+(${TOKEN})\s+(${TOKEN})\s*$`)

export function parsePluginDetails(text: string): PluginDetails {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  const always = /Always-on:\s+(~?[\d,.]+k?)\s*tok/.exec(text)
  const inventory = new Map<string, string[]>()
  for (const line of lines) {
    const m = INVENTORY.exec(line)
    if (!m) continue
    // The list is followed by an optional two-space-separated aside:
    // `slack, linear  (tool schemas resolved at runtime; not counted)`.
    const list = m[3].split(/\s{2,}\(/)[0].trim()
    inventory.set(m[1], list ? list.split(', ').map((s) => s.trim()) : [])
  }
  const kindOf = (name: string): ExtensionComponentCost['kind'] =>
    inventory.get('Skills')?.includes(name)
      ? 'skill'
      : inventory.get('Agents')?.includes(name)
        ? 'agent'
        : inventory.get('Commands')?.includes(name)
          ? 'command'
          : 'other'
  const components: ExtensionComponentCost[] = []
  const start = lines.findIndex((l) => l.startsWith('Per-component'))
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (!line.trim()) break
      if (/always-on/.test(line) && /on-invoke/.test(line)) continue
      const m = COMPONENT_ROW.exec(line)
      if (!m) continue
      components.push({ name: m[1], kind: kindOf(m[1]), alwaysOnTokens: parseTokens(m[2]), onInvokeTokens: parseTokens(m[3]) })
    }
  }
  return {
    alwaysOnTokens: always ? parseTokens(always[1]) : null,
    components,
    mcpServers: inventory.get('MCP servers') ?? [],
  }
}

// ---- ~/.claude.json (names and targets only; env is never read out) -----

export interface ServerConfig {
  name: string
  target: string | null
  projectPath: string | null
}

export interface ClaudeJsonFacts {
  userServers: ServerConfig[]
  localServers: ServerConfig[]
  everConnected: string[]
}

const SECRETISH = /key|token|secret|passw|auth|bearer|credential/i

// A target reaches the renderer and extensions-cache.json, and hosted MCP
// servers often carry credentials in it: `--api-key X`, `TOKEN=…`, a URL
// `?api_key=` or `user:pass@`. Mask those values; keep the shape readable.
export function redactTarget(target: string): string {
  const words = target.split(' ')
  return words
    .map((w, i) => {
      if (w.includes('://')) return w.replace(/\/\/[^/@\s]*@/, '//…@').replace(/\?.*$/, (q) => (q.length > 1 ? '?…' : q))
      const eq = w.indexOf('=')
      if (eq > 0 && SECRETISH.test(w.slice(0, eq))) return `${w.slice(0, eq)}=…`
      const prev = words[i - 1]
      if (prev?.startsWith('-') && !prev.includes('=') && SECRETISH.test(prev) && !w.startsWith('-')) return '…'
      return w
    })
    .join(' ')
}

// The target is the URL or the command line, redacted. `env` and `headers`
// carry secrets and are never touched.
function targetOf(cfg: unknown): string | null {
  if (!cfg || typeof cfg !== 'object') return null
  const c = cfg as { url?: unknown; command?: unknown; args?: unknown }
  if (typeof c.url === 'string') return redactTarget(c.url)
  if (typeof c.command !== 'string') return null
  const args = Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : []
  return redactTarget([c.command, ...args].join(' '))
}

function serversIn(block: unknown, projectPath: string | null): ServerConfig[] {
  if (!block || typeof block !== 'object') return []
  return Object.entries(block as Record<string, unknown>).map(([name, cfg]) => ({ name, target: targetOf(cfg), projectPath }))
}

export function claudeJsonFacts(json: unknown): ClaudeJsonFacts {
  const j = (json && typeof json === 'object' ? json : {}) as {
    mcpServers?: unknown
    projects?: Record<string, { mcpServers?: unknown }>
    claudeAiMcpEverConnected?: unknown
  }
  const localServers: ServerConfig[] = []
  for (const [projectPath, p] of Object.entries(j.projects ?? {})) localServers.push(...serversIn(p?.mcpServers, projectPath))
  return {
    userServers: serversIn(j.mcpServers, null),
    localServers,
    everConnected: Array.isArray(j.claudeAiMcpEverConnected)
      ? j.claudeAiMcpEverConnected.filter((n): n is string => typeof n === 'string')
      : [],
  }
}

// ---- assembly -----------------------------------------------------------

export interface BuildInput {
  plugins: PluginInfo[]
  // By plugin id. An Error means `plugin details` failed for it.
  details: Map<string, PluginDetails | Error>
  config: ClaudeJsonFacts
  // entries: the last SUCCESSFUL health check, or null if none ever finished.
  // current: false when a later check failed — then every server and
  // connector is 'unchecked', because the last answer is no longer the answer.
  health: { entries: McpHealthEntry[] | null; current: boolean }
  usage: ExtensionUsage | null
}

const NO_USE: UsageTally = { calls: 0, lastUsedIso: null, topTools: [] }

export function buildItems(input: BuildInput): ExtensionItem[] {
  const { plugins, details, config, health, usage } = input
  const entries = health.entries ?? []
  const checked = health.entries !== null && health.current
  const byName = new Map(entries.map((e) => [e.name, e]))
  const items: ExtensionItem[] = []

  const serverUsage = (fullName: string) => (usage ? (usage.mcp.get(normalizeServerName(fullName)) ?? NO_USE) : null)
  // A server known to the hub but absent from a successful check is
  // 'not-listed'; with no usable check everything is 'unchecked'.
  const statusOf = (fullName: string): Pick<ExtensionItem, 'status' | 'statusText'> => {
    if (!checked) return { status: 'unchecked', statusText: null }
    const e = byName.get(fullName)
    return e ? { status: e.status, statusText: e.statusText } : { status: 'not-listed', statusText: null }
  }
  const base = { pluginId: null, projectPath: null, alwaysOnTokens: null, components: [] }

  // User servers from ~/.claude.json.
  const userNames = new Set(config.userServers.map((s) => s.name))
  for (const s of config.userServers) {
    items.push({
      ...base,
      id: `mcp:${s.name}`,
      kind: 'mcp',
      name: s.name,
      scope: 'user',
      ...statusOf(s.name),
      target: s.target ?? byName.get(s.name)?.target ?? null,
      usage: serverUsage(s.name),
    })
  }

  // Local (per-project) servers. The health check runs outside every project,
  // so it never covers these; they stay 'unchecked' and the UI says why.
  for (const s of config.localServers) {
    items.push({
      ...base,
      id: `mcp:local:${s.projectPath}:${s.name}`,
      kind: 'mcp',
      name: s.name,
      scope: 'local',
      status: 'unchecked',
      statusText: null,
      target: s.target,
      projectPath: s.projectPath,
      usage: serverUsage(s.name),
    })
  }

  const pluginByName = new Map(plugins.map((p) => [p.name, p]))
  const listedPluginServers = new Set<string>()
  const everConnected = new Set(config.everConnected)
  for (const e of entries) {
    const origin = classifyServer(e.name)
    const status = checked ? { status: e.status, statusText: e.statusText } : { status: 'unchecked' as const, statusText: null }
    if (origin.kind === 'connector') {
      everConnected.delete(e.name)
      items.push({ ...base, id: `connector:${e.name}`, kind: 'connector', name: origin.display, scope: 'claude.ai', ...status, target: e.target, usage: serverUsage(e.name) })
    } else if (origin.kind === 'plugin') {
      listedPluginServers.add(origin.server)
      items.push({
        ...base,
        id: `mcp:${e.name}`,
        kind: 'mcp',
        name: origin.server,
        scope: 'plugin',
        ...status,
        target: e.target,
        pluginId: pluginByName.get(origin.plugin)?.id ?? null,
        usage: serverUsage(e.name),
      })
    } else if (!userNames.has(e.name)) {
      // Listed by the CLI but not in ~/.claude.json's user block: a
      // project-scope (.mcp.json) server in the directory the check ran in.
      items.push({ ...base, id: `mcp:${e.name}`, kind: 'mcp', name: e.name, scope: 'project', ...status, target: e.target, usage: serverUsage(e.name) })
    }
  }

  // Servers an enabled plugin's inventory declares that no check has listed
  // under any plugin. The CLI lists a server shared by several plugins once
  // (engineering's slack appears as design's), so dedupe by server name, first
  // plugin in list order winning — the order the CLI itself uses.
  for (const p of plugins) {
    const d = details.get(p.id)
    if (!p.enabled || !d || d instanceof Error) continue
    for (const server of d.mcpServers) {
      if (listedPluginServers.has(server)) continue
      listedPluginServers.add(server)
      const fullName = `plugin:${p.name}:${server}`
      items.push({
        ...base,
        id: `mcp:${fullName}`,
        kind: 'mcp',
        name: server,
        scope: 'plugin',
        ...statusOf(fullName),
        target: null,
        pluginId: p.id,
        usage: serverUsage(fullName),
      })
    }
  }

  // Connectors that were connected once but are not in the last check.
  for (const name of everConnected) {
    const origin = classifyServer(name)
    items.push({
      ...base,
      id: `connector:${name}`,
      kind: 'connector',
      name: origin.kind === 'connector' ? origin.display : name,
      scope: 'claude.ai',
      ...statusOf(name),
      target: null,
      usage: serverUsage(name),
    })
  }

  for (const p of plugins) {
    const d = details.get(p.id)
    const ok = d && !(d instanceof Error) ? d : null
    items.push({
      id: `plugin:${p.id}`,
      kind: 'plugin',
      name: p.name,
      scope: p.scope,
      status: p.enabled ? 'enabled' : 'disabled',
      statusText: null,
      target: null,
      pluginId: p.id,
      // Several project installs are joined with '; ' (the UI splits them).
      projectPath: p.projectPaths.length ? p.projectPaths.join('; ') : null,
      usage: usage ? pluginSkillUsage(usage, p.name) : null,
      alwaysOnTokens: ok?.alwaysOnTokens ?? null,
      components: ok?.components ?? [],
      ...(d instanceof Error ? { detailsError: d.message } : {}),
    })
  }
  return items
}

// A plugin's skills are invoked namespaced (`design:ux-copy`), so its usage
// is the sum of those; topTools names the skills.
function pluginSkillUsage(usage: ExtensionUsage, pluginName: string): UsageTally {
  const prefix = `${pluginName}:`
  let calls = 0
  let last = ''
  const topTools: { tool: string; count: number }[] = []
  for (const [skill, t] of usage.skills) {
    if (!skill.startsWith(prefix)) continue
    calls += t.calls
    if (t.lastUsedIso && t.lastUsedIso > last) last = t.lastUsedIso
    if (t.calls > 0) topTools.push({ tool: skill.slice(prefix.length), count: t.calls })
  }
  return { calls, lastUsedIso: last || null, topTools: topTools.sort((a, b) => b.count - a.count) }
}
