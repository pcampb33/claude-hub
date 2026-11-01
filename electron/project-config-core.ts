// Project config + session boundaries: the pure half. project-config.ts does
// the I/O; everything here is a function of its inputs. Electron-free.
//
// Boundaries are honest about what Windows allows: there is no shell sandbox,
// so a guarded boundary fences Claude's FILE TOOLS only (permission deny
// rules); Bash/PowerShell can still reach anything, and the audit reports it.
import path from 'node:path'
import type {
  BoundaryAccess,
  BoundaryCrossing,
  BoundaryNeighbour,
  BoundaryTier,
  ConfigFinding,
  ConfigLayer,
  ConfigLayerScope,
  DesktopTargetRef,
  GuardStatus,
} from '../shared/ipc-types.ts'

// ---- Paths -----------------------------------------------------------------

const norm = (p: string) => path.win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase()

export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b)
}

// child is parent or sits inside it (case-insensitive, separator-agnostic).
export function isInside(child: string, parent: string): boolean {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p.endsWith('\\') ? p : p + '\\')
}

// C:\projects\x → //c/projects/x/** : Claude Code matches Windows paths in
// POSIX form, and `//` anchors a rule at the filesystem root.
export function rulePath(winPath: string): string {
  const n = path.win32.normalize(winPath).replace(/[\\/]+$/, '')
  const drive = /^([a-zA-Z]):\\?(.*)$/.exec(n)
  if (drive) return `//${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}/**`
  return `${n.replace(/\\/g, '/')}/**` // UNC \\server\share\x → //server/share/x/**
}

// ---- Boundaries --------------------------------------------------------------

// A folder a session could reach: a registered project or a sandbox experiment.
export interface Place {
  kind: DesktopTargetRef['kind']
  key: string
  name: string
  path: string
}

export interface ResolvedNeighbour {
  name: string
  path: string
  access: BoundaryAccess
}

export const targetKey = (t: DesktopTargetRef) => `${t.kind}:${t.key}`

export const COVERS: Record<BoundaryTier, string> = {
  guarded: "Claude's file tools are blocked outside this boundary; shell commands aren't fenced on Windows, so crossings by shell show in the audit.",
  audit: 'Nothing is blocked; crossings are reported.',
}

// The claude-hub repo itself administers every other project, so its own
// sessions have no boundary: no statement, no deny rules, no audit (the
// user's call, 2026-10-29). Every other folder keeps its boundary.
export function isAdminFolder(folder: string, appRoot: string | undefined): boolean {
  return !!appRoot && samePath(folder, appRoot)
}

export const ADMIN_COVERS = 'No boundary: claude-hub administers every project, so its own sessions are not limited or audited.'

// The claude-hub repo's own sessions maintain the vault; every other folder
// reads it.
export function defaultVaultAccess(folder: string, appRoot: string | undefined): BoundaryAccess {
  return isAdminFolder(folder, appRoot) ? 'write' : 'read'
}

// The deny rules a guarded launch carries. Every other project and experiment
// is denied, except: the target's own folder and anything inside it; any
// ANCESTOR of it (an experiment lives inside the sandbox project, and denying
// that root would deny the session's own cwd, since deny wins); declared
// neighbours (read → no edits; write → nothing), and for the same reason a
// folder that CONTAINS a neighbour or the vault is denied no more than they
// allow; a place INSIDE a neighbour or the vault is denied no more than the
// nearest of them allows; and any folder whose denial would cover ~/.claude
// or the OS temp dir. A read-only vault denies edits. A rule already covered
// by one on a parent folder is dropped.
export function guardRules(input: {
  folder: string
  places: Place[]
  neighbours: ResolvedNeighbour[]
  vault: string
  vaultAccess: BoundaryAccess
  protectedDirs: string[] // ~/.claude, the OS temp dir: never denied
}): string[] {
  type Tool = 'Read' | 'Edit' | 'NotebookEdit'
  const entries: { tool: Tool; path: string }[] = []
  const deny = (p: string, tools: Tool[]) => tools.forEach((tool) => entries.push({ tool, path: p }))
  const coversProtected = (p: string) => input.protectedDirs.some((d) => isInside(d, p))
  const allowed = [...input.neighbours, { path: input.vault, access: input.vaultAccess }]
  // The most a place must allow: the widest access of anything allowed inside it.
  const mustAllow = (p: string): BoundaryAccess | null =>
    allowed.filter((a) => isInside(a.path, p)).reduce<BoundaryAccess | null>((best, a) => (a.access === 'write' || best === 'write' ? 'write' : 'read'), null)
  // What a place inherits from the nearest neighbour or vault it sits in.
  const inherited = (p: string): BoundaryAccess | null =>
    allowed.filter((a) => isInside(p, a.path)).sort((a, b) => norm(b.path).length - norm(a.path).length)[0]?.access ?? null
  for (const place of input.places) {
    if (isInside(input.folder, place.path) || isInside(place.path, input.folder)) continue // own folder, inside it, or an ancestor
    if (samePath(place.path, input.vault) || coversProtected(place.path)) continue
    const own = inherited(place.path)
    const access = own === 'write' ? 'write' : (mustAllow(place.path) ?? own)
    if (access === 'write') continue
    deny(place.path, access === 'read' ? ['Edit', 'NotebookEdit'] : ['Read', 'Edit', 'NotebookEdit'])
  }
  if (input.vaultAccess === 'read' && !isInside(input.folder, input.vault) && !coversProtected(input.vault)) deny(input.vault, ['Edit', 'NotebookEdit'])
  const covered = (e: { tool: Tool; path: string }) => entries.some((o) => o.tool === e.tool && !samePath(o.path, e.path) && isInside(e.path, o.path))
  return [...new Set(entries.filter((e) => !covered(e)).map((e) => `${e.tool}(${rulePath(e.path)})`))].sort()
}

const STATEMENT_MAX = 1000
const clean = (s: string) => s.replace(/["\r\n]/g, ' ')

// The plain-words boundary every Desktop launch appends to the system prompt.
export function boundaryStatement(input: {
  name: string
  folder: string
  tier: BoundaryTier
  neighbours: ResolvedNeighbour[]
  vault: string
  vaultAccess: BoundaryAccess
}): string {
  const build = (withPaths: boolean) => {
    const parts = [`Session boundary (set in claude-hub): this session belongs to ${input.name} at ${input.folder}.`]
    if (input.neighbours.length === 0) parts.push('It has no neighbour projects.')
    else {
      const list = input.neighbours.map((n) => `${n.name}${withPaths ? ` at ${n.path}` : ''} (${n.access === 'write' ? 'read and write' : 'read only'})`)
      parts.push(`Neighbours you may use: ${list.join('; ')}.`)
    }
    parts.push(input.vaultAccess === 'write' ? `You may read and write the knowledge vault at ${input.vault}.` : `You may read the knowledge vault at ${input.vault} but not change it.`)
    parts.push('Your ~/.claude folder and temp scratchpads are fine.')
    parts.push(
      input.tier === 'guarded'
        ? "Claude's file tools are blocked from other projects; don't use shell commands to reach them either."
        : 'Stay within these folders; crossings are logged.',
    )
    return clean(parts.join(' '))
  }
  const full = build(true)
  if (full.length <= STATEMENT_MAX) return full
  const short = build(false)
  return short.length <= STATEMENT_MAX ? short : short.slice(0, STATEMENT_MAX - 3) + '...'
}

// ---- boundaries.json -----------------------------------------------------------

// Only explicit choices are stored; a missing field means the code default.
// localGuard: the exact rules the hub added to the folder's
// .claude/settings.local.json, so removal deletes only those.
export interface StoredBoundary {
  tier?: BoundaryTier
  neighbours?: BoundaryNeighbour[]
  vaultAccess?: BoundaryAccess
  localGuard?: { rules: string[] }
}

export interface BoundariesFile {
  version: 1
  targets: Record<string, StoredBoundary>
}

const isTier = (v: unknown): v is BoundaryTier => v === 'audit' || v === 'guarded'
const isAccess = (v: unknown): v is BoundaryAccess => v === 'read' || v === 'write'
const isRef = (v: unknown): v is DesktopTargetRef => {
  const t = v as DesktopTargetRef | null
  return typeof t === 'object' && t !== null && (t.kind === 'project' || t.kind === 'experiment') && typeof t.key === 'string' && t.key.length > 0
}

// Throws on anything that isn't a well-formed file, so the caller refuses to
// overwrite it.
export function parseBoundaries(text: string): BoundariesFile {
  let raw: { version?: unknown; targets?: unknown }
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error("it isn't valid JSON")
  }
  if (!raw || raw.version !== 1 || typeof raw.targets !== 'object' || raw.targets === null || Array.isArray(raw.targets)) throw new Error('not a version-1 boundaries file')
  for (const [key, b] of Object.entries(raw.targets as Record<string, StoredBoundary>)) {
    const bad = (why: string) => new Error(`the entry for ${key} ${why}`)
    if (typeof b !== 'object' || b === null) throw bad('is not an object')
    if (b.tier !== undefined && !isTier(b.tier)) throw bad('has an unknown tier')
    if (b.vaultAccess !== undefined && !isAccess(b.vaultAccess)) throw bad('has an unknown vault access')
    if (b.neighbours !== undefined && (!Array.isArray(b.neighbours) || !b.neighbours.every((n) => isRef(n?.target) && isAccess(n?.access)))) throw bad('has malformed neighbours')
    if (b.localGuard !== undefined && (!Array.isArray(b.localGuard?.rules) || !b.localGuard.rules.every((r) => typeof r === 'string'))) throw bad('has a malformed local guard record')
  }
  return raw as BoundariesFile
}

// A setBoundary patch, checked. `resolves` throws for a target that isn't a
// registered project or listed experiment.
export function validatePatch(
  target: DesktopTargetRef,
  patch: unknown,
  resolves: (t: DesktopTargetRef) => string,
): { tier?: BoundaryTier; neighbours?: BoundaryNeighbour[]; vaultAccess?: BoundaryAccess } {
  const p = patch as { tier?: unknown; neighbours?: unknown; vaultAccess?: unknown } | null
  if (typeof p !== 'object' || p === null) throw new Error('A boundary change must be an object')
  const out: { tier?: BoundaryTier; neighbours?: BoundaryNeighbour[]; vaultAccess?: BoundaryAccess } = {}
  if (p.tier !== undefined) {
    if (!isTier(p.tier)) throw new Error("Tier must be 'audit' or 'guarded'")
    out.tier = p.tier
  }
  if (p.vaultAccess !== undefined) {
    if (!isAccess(p.vaultAccess)) throw new Error("Vault access must be 'read' or 'write'")
    out.vaultAccess = p.vaultAccess
  }
  if (p.neighbours !== undefined) {
    if (!Array.isArray(p.neighbours)) throw new Error('Neighbours must be a list')
    const ownPath = resolves(target)
    const byKey = new Map<string, BoundaryNeighbour>()
    for (const n of p.neighbours as { target?: unknown; access?: unknown }[]) {
      if (!isRef(n?.target)) throw new Error('A neighbour must be a project or an experiment')
      if (!isAccess(n.access)) throw new Error("A neighbour's access must be 'read' or 'write'")
      const ref = { kind: n.target.kind, key: n.target.key }
      const where = resolves(ref)
      if (targetKey(ref) === targetKey(target) || samePath(where, ownPath)) throw new Error("A project can't be its own neighbour")
      byKey.set(targetKey(ref), { target: ref, access: n.access }) // a later entry for the same target wins
    }
    out.neighbours = [...byKey.values()]
  }
  return out
}

// ---- settings.local.json guard -------------------------------------------------

// A settings file's object, or throws saying why it can't be used. A file that
// isn't a JSON object is never overwritten.
export function parseSettingsObject(text: string): Record<string, unknown> {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error("it isn't valid JSON")
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error("it isn't a JSON object")
  const perms = (raw as { permissions?: unknown }).permissions
  if (perms !== undefined && (typeof perms !== 'object' || perms === null || Array.isArray(perms))) throw new Error('its permissions entry is not an object')
  const deny = (perms as { deny?: unknown } | undefined)?.deny
  if (deny !== undefined && (!Array.isArray(deny) || !deny.every((r) => typeof r === 'string'))) throw new Error('its permissions.deny is not a list of rules')
  return raw as Record<string, unknown>
}

const denyOf = (settings: Record<string, unknown>): string[] => ((settings.permissions as { deny?: string[] } | undefined)?.deny ?? [])

// Replace the hub's previous rules with the current ones, keeping every other
// key and every rule the user wrote. hubAdded = the rules this write added
// (one the user already had is theirs, not the hub's).
export function mergeGuardRules(settings: Record<string, unknown>, rules: string[], previousHub: string[]): { settings: Record<string, unknown>; hubAdded: string[] } {
  const previous = new Set(previousHub)
  const base = denyOf(settings).filter((r) => !previous.has(r))
  const have = new Set(base)
  const hubAdded = rules.filter((r) => !have.has(r))
  const permissions = { ...((settings.permissions as Record<string, unknown> | undefined) ?? {}), deny: [...base, ...hubAdded] }
  return { settings: { ...settings, permissions }, hubAdded }
}

export function removeGuardRules(settings: Record<string, unknown>, hubRules: string[]): Record<string, unknown> {
  if (!settings.permissions) return settings
  const drop = new Set(hubRules)
  return { ...settings, permissions: { ...(settings.permissions as Record<string, unknown>), deny: denyOf(settings).filter((r) => !drop.has(r)) } }
}

// The shape guardRules writes: a file tool denied on an absolute folder.
const HUB_SHAPED = /^(?:Read|Edit|NotebookEdit)\(\/\/.+\/\*\*\)$/

// absent: no hub rules there (or the file is gone); unrecorded: the hub has
// no record of writing rules, yet the file has rules shaped like its own (a
// reset boundaries.json), so it can't tell whose they are; current: every
// rule the boundary implies is there and the hub's are all still implied;
// stale: anything else (including hub rules left behind under the audit tier).
export function localGuardState(
  file: { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'ok'; settings: Record<string, unknown> },
  record: { rules: string[] } | undefined,
  implied: string[] | null, // null = the audit tier: no rules implied
): GuardStatus['localSettings'] {
  if (file.kind === 'unreadable') return 'unreadable'
  if (file.kind === 'missing') return 'absent'
  if (!record) return denyOf(file.settings).some((r) => HUB_SHAPED.test(r)) ? 'unrecorded' : 'absent'
  const deny = new Set(denyOf(file.settings))
  if (!implied) return record.rules.some((r) => deny.has(r)) ? 'stale' : 'absent'
  const want = new Set(implied)
  return implied.every((r) => deny.has(r)) && record.rules.every((r) => want.has(r)) ? 'current' : 'stale'
}

// ---- Config layers ---------------------------------------------------------------

// A hook's command as shown: the script it runs, never its arguments or
// paths (which can carry tokens). `node "C:/x/scripts/curate-session.mjs" --a`
// → `node curate-session.mjs …`.
export function redactHookCommand(command: string): string {
  const words = command.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const bare = (w: string) => w.replace(/^["']|["']$/g, '')
  const base = (w: string) => path.win32.basename(bare(w)).replace(/\.exe$/i, '')
  const script = words.findIndex((w, i) => i > 0 && /\.(?:mjs|cjs|js|ts|py|ps1|sh|cmd|bat)$/i.test(bare(w)))
  const first = words[0]
  if (first === undefined) return ''
  if (script > 0) return `${base(first)} ${base(words[script]!)}${words.length > script + 1 ? ' …' : ''}`
  return `${base(first)}${words.length > 1 ? ' …' : ''}`
}

export function readHooks(settings: Record<string, unknown> | null): { event: string; command: string }[] {
  const hooks = settings?.hooks
  if (!hooks || typeof hooks !== 'object') return []
  const out: { event: string; command: string }[] = []
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const entries = (group as { hooks?: unknown })?.hooks
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        const command = (entry as { command?: unknown })?.command
        if (typeof command === 'string' && command.trim()) out.push({ event, command: redactHookCommand(command) })
      }
    }
  }
  return out
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function readPermissions(settings: Record<string, unknown> | null): ConfigLayer['permissions'] {
  const p = settings?.permissions as Record<string, unknown> | undefined
  if (!p || typeof p !== 'object') return null
  return { defaultMode: typeof p.defaultMode === 'string' ? p.defaultMode : null, allow: strings(p.allow), ask: strings(p.ask), deny: strings(p.deny) }
}

export const readModel = (settings: Record<string, unknown> | null): string | null => (typeof settings?.model === 'string' ? settings.model : null)

// Whether a .mcp.json server is approved, from settings in precedence order
// (local first). null = no setting says.
export function mcpjsonApproval(name: string, settingsInOrder: (Record<string, unknown> | null)[]): boolean | null {
  for (const s of settingsInOrder) {
    if (!s) continue
    if (strings(s.disabledMcpjsonServers).includes(name)) return false
    if (strings(s.enabledMcpjsonServers).includes(name)) return true
    if (s.enableAllProjectMcpServers === true) return true
  }
  return null
}

export interface FindingsInput {
  global: { settings: Record<string, unknown> | null }
  project: { settings: Record<string, unknown> | null }
  local: { settings: Record<string, unknown> | null }
  // null = no .mcp.json; 'unreadable' = it exists but couldn't be used.
  mcpJson: string[] | null | 'unreadable'
  layers: ConfigLayer[]
  guard: GuardStatus['localSettings']
}

const LABEL: Record<'project' | 'local', string> = { project: '.claude/settings.json', local: 'settings.local.json' }

export function configFindings(input: FindingsInput): ConfigFinding[] {
  const findings: ConfigFinding[] = []
  const reported = new Set<string>() // ~/.claude.json feeds two layers; warn once
  for (const layer of input.layers) {
    for (const f of layer.files) {
      if (!f.error || !/\.json$/i.test(f.path) || reported.has(f.path)) continue
      reported.add(f.path)
      findings.push({ severity: 'warn', layer: layer.scope, text: `${f.label} couldn't be used (${f.error}), so its settings aren't shown` })
    }
  }
  for (const scope of ['project', 'local'] as const) {
    const s = input[scope].settings
    if (!s || input.mcpJson === 'unreadable') continue
    for (const name of strings(s.enabledMcpjsonServers)) {
      if (input.mcpJson === null) findings.push({ severity: 'warn', layer: scope, text: `${LABEL[scope]} enables MCP server '${name}', but there's no .mcp.json` })
      else if (!input.mcpJson.includes(name)) findings.push({ severity: 'warn', layer: scope, text: `${LABEL[scope]} enables MCP server '${name}', but .mcp.json doesn't define it` })
    }
  }
  const perm = (s: Record<string, unknown> | null) => readPermissions(s)
  const totalDeny = input.layers.reduce((n, l) => n + (l.permissions?.deny.length ?? 0), 0)
  if (perm(input.global.settings)?.defaultMode === 'auto' && totalDeny === 0) {
    // An unreadable layer may hold deny rules, so "nothing" can't be claimed.
    findings.push(
      reported.size === 0
        ? { severity: 'info', layer: 'global', text: "The global default mode is 'auto' and no layer has a deny rule, so nothing is blocked outright" }
        : { severity: 'warn', layer: 'global', text: "The global default mode is 'auto' and no readable layer has a deny rule; the unreadable one may have some, so what's blocked is unknown" },
    )
  }
  const overrides = (what: string, local: string | null, below: { value: string | null; from: ConfigLayerScope }[]) => {
    const under = below.find((b) => b.value !== null)
    if (local !== null && under && under.value !== local) findings.push({ severity: 'info', layer: 'local', text: `settings.local.json sets ${what} '${local}', overriding '${under.value}' from the ${under.from} settings` })
  }
  overrides('model', readModel(input.local.settings), [
    { value: readModel(input.project.settings), from: 'project' },
    { value: readModel(input.global.settings), from: 'global' },
  ])
  overrides('defaultMode', perm(input.local.settings)?.defaultMode ?? null, [
    { value: perm(input.project.settings)?.defaultMode ?? null, from: 'project' },
    { value: perm(input.global.settings)?.defaultMode ?? null, from: 'global' },
  ])
  if (input.guard === 'stale') findings.push({ severity: 'warn', layer: 'local', text: "The hub's guard rules in settings.local.json no longer match this boundary; refresh or remove them" })
  return findings
}

// ---- Audit -------------------------------------------------------------------------

// One file-tool or shell call, as read from a transcript (cached per file).
export interface ToolFact {
  at: string
  tool: string
  cwd: string | null
  path?: string
  command?: string
  id?: string // the tool_use id, to pair the call with its result
  blocked?: boolean // Claude Code refused to run it (see refusedToolUseIds)
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

// The calls in one transcript line that the audit classifies.
export function extractFacts(line: unknown): ToolFact[] {
  const o = line as { type?: string; timestamp?: unknown; cwd?: unknown; message?: { content?: unknown } } | null
  if (o?.type !== 'assistant' || !Array.isArray(o.message?.content) || typeof o.timestamp !== 'string') return []
  const cwd = typeof o.cwd === 'string' ? o.cwd : null
  const out: ToolFact[] = []
  for (const block of o.message.content as { type?: string; id?: unknown; name?: unknown; input?: Record<string, unknown> }[]) {
    if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
    const input = block.input ?? {}
    const id = typeof block.id === 'string' ? { id: block.id } : {}
    if (FILE_TOOLS.has(block.name)) {
      let p = input.file_path ?? input.notebook_path ?? (block.name === 'Glob' || block.name === 'Grep' ? input.path : undefined)
      // An absolute Glob pattern names its folder itself.
      if (p === undefined && block.name === 'Glob' && typeof input.pattern === 'string' && /^(?:[a-zA-Z]:|\/[a-zA-Z]\/|~)/.test(input.pattern)) {
        p = input.pattern.split(/[*?[{]/)[0].replace(/[\\/][^\\/]*$/, '') || undefined
      }
      if (typeof p === 'string' && p) out.push({ at: o.timestamp, tool: block.name, cwd, path: p, ...id })
    } else if (SHELL_TOOLS.has(block.name) && typeof input.command === 'string') {
      out.push({ at: o.timestamp, tool: block.name, cwd, command: input.command.slice(0, 8000), ...id })
    }
  }
  return out
}

// The error texts Claude Code writes when it refuses to run a call: a deny
// rule, the auto-mode classifier, a built-in safety check, the user rejecting
// it at the prompt, or worktree isolation. Any other error came from a call
// that ran.
const REFUSED =
  /^(?:Permission to .* has been denied\.|<tool_use_error>File is in a directory that is denied by your permission settings|Permission for this (?:action|command) was denied by |The user doesn't want to proceed with this tool use\.|This agent is isolated in the worktree )/

// The tool_use ids in one transcript line whose result says the call never ran.
export function refusedToolUseIds(line: unknown): string[] {
  const o = line as { type?: string; message?: { content?: unknown } } | null
  if (o?.type !== 'user' || !Array.isArray(o.message?.content)) return []
  const out: string[] = []
  for (const block of o.message.content as { type?: string; tool_use_id?: unknown; is_error?: unknown; content?: unknown }[]) {
    if (block?.type !== 'tool_result' || block.is_error !== true || typeof block.tool_use_id !== 'string') continue
    const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? (block.content as { text?: unknown }[]).map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ') : ''
    if (REFUSED.test(text)) out.push(block.tool_use_id)
  }
  return out
}

export interface AuditContext {
  folder: string
  places: Place[] // every project and experiment, the target included
  neighbours: ResolvedNeighbour[]
  vault: string
  vaultAccess: BoundaryAccess
  zones: string[] // always allowed: ~/.claude, the OS temp dir
  home: string
}

type Owner = { name: string; path: string; role: 'self' | 'neighbour' | 'vault' | 'other'; access?: BoundaryAccess }

const ownerCache = new WeakMap<AuditContext, Owner[]>()

// Every folder a path can belong to, most specific first.
function owners(ctx: AuditContext): Owner[] {
  const cached = ownerCache.get(ctx)
  if (cached) return cached
  const list: Owner[] = ctx.places.map((p) => {
    if (samePath(p.path, ctx.folder)) return { name: p.name, path: p.path, role: 'self' }
    const n = ctx.neighbours.find((x) => samePath(x.path, p.path))
    return n ? { name: p.name, path: p.path, role: 'neighbour', access: n.access } : { name: p.name, path: p.path, role: 'other' }
  })
  if (!list.some((o) => o.role === 'self')) list.push({ name: 'self', path: ctx.folder, role: 'self' })
  list.push({ name: 'vault', path: ctx.vault, role: 'vault' })
  list.sort((a, b) => b.path.length - a.path.length)
  // A place inside the session's own folder, a neighbour or the vault belongs
  // to the nearest of them (the guard rules allow it the same way).
  const resolved = list.map((o) => {
    if (o.role !== 'other') return o
    const parent = list.find((a) => a.role !== 'other' && !samePath(a.path, o.path) && isInside(o.path, a.path))
    return parent ? { ...o, role: parent.role, access: parent.access } : o
  })
  ownerCache.set(ctx, resolved)
  return resolved
}

// A transcript path as an absolute Windows path: Git Bash's /c/..., ~/..., or
// relative to the call's cwd.
export function resolveToolPath(p: string, cwd: string | null, home: string): string | null {
  let s = p.trim()
  const bash = /^\/([a-zA-Z])(\/.*)?$/.exec(s)
  if (bash) s = `${bash[1]}:${bash[2] ?? '/'}`
  else if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.win32.join(home, s.slice(1))
  if (path.win32.isAbsolute(s) && /^[a-zA-Z]:/.test(s)) return path.win32.normalize(s)
  if (!cwd) return null
  return path.win32.resolve(cwd, s)
}

const crossing = (fact: ToolFact, access: BoundaryCrossing['access'], into: string, detail: string): Omit<BoundaryCrossing, 'sessionId'> => ({
  at: fact.at,
  tool: fact.tool,
  access,
  detail: detail.length > 300 ? detail.slice(0, 297) + '...' : detail,
  into,
})

// Commands that change files. A heuristic: it only decides whether a shell
// command naming a read-only place counts as a crossing.
const WRITEISH =
  /(^|[\s;&|(])(rm|rmdir|del|erase|mv|move|cp|copy|xcopy|robocopy|mkdir|md|touch|tee|truncate|ln|chmod|patch|set-content|add-content|out-file|remove-item|move-item|copy-item|new-item|rename-item|clear-content)(\s|$)|\bsed\s+-i|\bgit(?:\s+-C\s+(?:"[^"]*"|\S+))?\s+(commit|add|push|checkout|switch|reset|rm|mv|stash|merge|rebase|apply|clean|restore|cherry-pick|pull)\b|\bnpm\s+(i|install|ci|uninstall|update)\b|>/i
const HARMLESS_REDIRECT = /\d?>\s*&\s*\d|\d?>\s*(\/dev\/null|\$null|nul)\b/gi

export function isWriteish(command: string): boolean {
  return WRITEISH.test(command.replace(HARMLESS_REDIRECT, ' '))
}

// Shell text with paths in one spelling: lower case, backslashes, Git Bash
// drive prefixes (/c/...) as c:\...
function normalizeCommand(command: string): string {
  return command.toLowerCase().replace(/\//g, '\\').replace(/(^|[\s"'=(:;,])\\([a-z])\\/g, '$1$2:\\')
}

// Where the command names `root` as a whole folder (not a longer sibling:
// trading-bot inside trading-bot-v2).
function namesFolder(text: string, root: string): boolean {
  const r = norm(root)
  for (let i = text.indexOf(r); i >= 0; i = text.indexOf(r, i + 1)) {
    const next = text[i + r.length]
    if (next === undefined || !/[a-z0-9_.-]/.test(next)) return true
  }
  return false
}

// One call → a crossing of the boundary, or null when it stays inside.
export function classifyFact(fact: ToolFact, ctx: AuditContext): Omit<BoundaryCrossing, 'sessionId'> | null {
  const list = owners(ctx)
  if (fact.path !== undefined) {
    const p = resolveToolPath(fact.path, fact.cwd, ctx.home)
    if (!p) return null // relative with no cwd: can't place it
    const write = WRITE_TOOLS.has(fact.tool)
    const access = write ? 'write' : 'read'
    const owner = list.find((o) => isInside(p, o.path))
    if (owner?.role === 'self') return null
    if (owner?.role === 'neighbour') return owner.access === 'write' || !write ? null : crossing(fact, access, owner.name, p)
    if (owner?.role === 'vault') return ctx.vaultAccess === 'write' || !write ? null : crossing(fact, access, 'vault', p)
    if (ctx.zones.some((z) => isInside(p, z) && (!owner || isInside(z, owner.path)))) return null
    return crossing(fact, access, owner?.name ?? 'elsewhere', p)
  }
  if (fact.command === undefined) return null
  const text = normalizeCommand(fact.command)
  let writeish: boolean | null = null
  for (const o of list) {
    if (o.role === 'self' || isInside(ctx.folder, o.path)) continue // own folder or an ancestor of it
    if (!namesFolder(text, o.path)) continue
    if (o.role === 'neighbour' && o.access === 'write') continue
    if (o.role === 'vault' && ctx.vaultAccess === 'write') continue
    if (o.role === 'neighbour' || o.role === 'vault') {
      writeish ??= isWriteish(fact.command)
      if (!writeish) continue
    }
    return crossing(fact, 'shell', o.role === 'vault' ? 'vault' : o.name, fact.command.replace(/\s+/g, ' ').trim())
  }
  return null
}
