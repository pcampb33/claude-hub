// Project config view and session boundaries: the I/O half
// (project-config-core.ts holds the rules). Electron-free.
//
// Boundaries live in <APP_ROOT>/boundaries.json, explicit choices only. Paths
// are always resolved here from the registry or the enumerated sandbox
// experiments; the renderer sends target refs, never paths. Nothing read from
// ~/.claude.json leaves this module except server names and redacted targets.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { countTokens } from 'gpt-tokenizer'
import { listProjects } from './registry.ts'
import { listExperimentPaths } from './sandbox.ts'
import { VAULT_PATH } from './vault-core.ts'
import { claudeHome, claudeProjectsDir, resolveTargetIn } from './desktop-outside.ts'
import { validateTarget } from './desktop-model.ts'
import { scanSessionDirs } from './status.ts'
import { isHeadlessTranscript } from './live-core.ts'
import { listSubagentTranscripts } from './subagents.ts'
import { claudeJsonFacts } from './extensions-core.ts'
import {
  ADMIN_COVERS,
  COVERS,
  boundaryStatement,
  classifyFact,
  configFindings,
  defaultVaultAccess,
  extractFacts,
  guardRules,
  isAdminFolder,
  isInside,
  localGuardState,
  mcpjsonApproval,
  mergeGuardRules,
  parseBoundaries,
  parseSettingsObject,
  readHooks,
  readModel,
  readPermissions,
  refusedToolUseIds,
  removeGuardRules,
  samePath,
  targetKey,
  validatePatch,
  type AuditContext,
  type BoundariesFile,
  type Place,
  type ResolvedNeighbour,
  type StoredBoundary,
  type ToolFact,
} from './project-config-core.ts'
import type {
  BoundaryAccess,
  BoundaryAudit,
  BoundaryCrossing,
  BoundaryNeighbour,
  BoundaryTier,
  BoundaryView,
  ConfigLayer,
  DesktopTargetRef,
  GuardStatus,
  LaunchTier,
  ProjectBoundary,
  ProjectConfigReport,
  RegistryEntry,
} from '../shared/ipc-types.ts'

// ---- Places --------------------------------------------------------------------

// Where sessions can run. experiments null = the sandbox couldn't be listed.
export interface Places {
  projects: RegistryEntry[]
  experiments: string[] | null
  experimentsError: string | null
}

function readPlaces(): Places {
  const projects = listProjects()
  try {
    return { projects, experiments: listExperimentPaths(), experimentsError: null }
  } catch (err) {
    return { projects, experiments: null, experimentsError: `Couldn't list the sandbox experiments: ${(err as Error).message}` }
  }
}

function resolveIn(target: DesktopTargetRef, places: Places): { path: string; name: string } {
  if (target.kind === 'experiment' && places.experiments === null) throw new Error(places.experimentsError!)
  return resolveTargetIn(target, places.projects, places.experiments ?? [])
}

function placeList(places: Places): Place[] {
  return [
    ...places.projects.map((p) => ({ kind: 'project' as const, key: p.id, name: p.name, path: p.path })),
    ...(places.experiments ?? []).map((e) => ({ kind: 'experiment' as const, key: path.win32.basename(e), name: path.win32.basename(e), path: e })),
  ]
}

// Never denied, never a crossing: Claude Code's own folder and scratch space.
const protectedDirs = () => [claudeHome(), os.tmpdir()]

// ---- boundaries.json -----------------------------------------------------------

const boundariesPath = () => path.join(process.env.APP_ROOT!, 'boundaries.json')

// Missing = nothing chosen yet. Anything else that fails throws, so no write
// ever replaces a file the hub couldn't read.
function loadBoundaries(): BoundariesFile {
  const file = boundariesPath()
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, targets: {} }
    throw new Error(`Can't read ${file}: ${(err as Error).message}`)
  }
  try {
    return parseBoundaries(text)
  } catch (err) {
    throw new Error(`${file} is unreadable (${(err as Error).message}); fix or remove it, the hub won't overwrite it`)
  }
}

function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
}

const saveBoundaries = (b: BoundariesFile) => writeAtomic(boundariesPath(), JSON.stringify(b, null, 2) + '\n')

let chain: Promise<unknown> = Promise.resolve()
// boundaries.json and settings.local.json changes run one at a time.
function serial<T>(fn: () => T): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

function effective(target: DesktopTargetRef, folder: string, stored: StoredBoundary | undefined): ProjectBoundary {
  return {
    target,
    tier: stored?.tier ?? 'audit',
    neighbours: stored?.neighbours ?? [],
    vaultAccess: stored?.vaultAccess ?? defaultVaultAccess(folder, process.env.APP_ROOT),
    isDefault: stored?.tier === undefined && stored?.neighbours === undefined && stored?.vaultAccess === undefined,
    admin: isAdminFolder(folder, process.env.APP_ROOT),
  }
}

const NO_BOUNDARY = "claude-hub administers every project, so it has no boundary to change"

// Neighbours that still resolve; a project removed from the registry drops out.
function resolveNeighbours(neighbours: BoundaryNeighbour[], places: Places): ResolvedNeighbour[] {
  const out: ResolvedNeighbour[] = []
  for (const n of neighbours) {
    try {
      const where = resolveIn(n.target, places)
      out.push({ name: where.name, path: where.path, access: n.access })
    } catch {
      // no longer registered / listed
    }
  }
  return out
}

function rulesFor(folder: string, boundary: ProjectBoundary, places: Places): string[] {
  if (places.experiments === null) throw new Error(`${places.experimentsError}, so the guard rules can't be worked out`)
  return guardRules({
    folder,
    places: placeList(places),
    neighbours: resolveNeighbours(boundary.neighbours, places),
    vault: VAULT_PATH,
    vaultAccess: boundary.vaultAccess,
    protectedDirs: protectedDirs(),
  })
}

// ---- settings.local.json ---------------------------------------------------------

const localSettingsPath = (folder: string) => path.join(folder, '.claude', 'settings.local.json')

type LocalRead = { kind: 'missing' } | { kind: 'unreadable'; error: string } | { kind: 'ok'; settings: Record<string, unknown> }

function readLocalSettings(folder: string): LocalRead {
  const file = localSettingsPath(folder)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', error: `Couldn't read ${file}: ${(err as Error).message}` }
  }
  try {
    return { kind: 'ok', settings: parseSettingsObject(text) }
  } catch (err) {
    return { kind: 'unreadable', error: `${file} can't be used: ${(err as Error).message}` }
  }
}

function guardStatus(folder: string, boundary: ProjectBoundary, stored: StoredBoundary | undefined, places: Places): GuardStatus {
  const guarded = boundary.tier === 'guarded' && !boundary.admin
  const implied = guarded ? rulesFor(folder, boundary, places) : null
  return {
    desktopLaunch: guarded,
    localSettings: localGuardState(readLocalSettings(folder), stored?.localGuard, implied),
    covers: boundary.admin ? ADMIN_COVERS : COVERS[boundary.tier],
  }
}

interface Resolved {
  places: Places
  folder: string
  name: string
  file: BoundariesFile
  stored: StoredBoundary | undefined
  boundary: ProjectBoundary
}

function resolveAll(target: DesktopTargetRef): Resolved {
  const places = readPlaces()
  const { path: folder, name } = resolveIn(target, places)
  const file = loadBoundaries()
  const stored = file.targets[targetKey(target)]
  return { places, folder, name, file, stored, boundary: effective(target, folder, stored) }
}

function view(r: Resolved): BoundaryView {
  return { boundary: r.boundary, guard: guardStatus(r.folder, r.boundary, r.stored, r.places) }
}

export async function getBoundary(target: DesktopTargetRef): Promise<BoundaryView> {
  return view(resolveAll(validateTarget(target)))
}

export function setBoundary(
  target: DesktopTargetRef,
  patch: { tier?: BoundaryTier; neighbours?: BoundaryNeighbour[]; vaultAccess?: BoundaryAccess },
): Promise<BoundaryView> {
  return serial(() => {
    const ref = validateTarget(target)
    const r = resolveAll(ref)
    if (r.boundary.admin) throw new Error(NO_BOUNDARY)
    const valid = validatePatch(ref, patch, (t) => resolveIn(t, r.places).path)
    const stored: StoredBoundary = { ...r.stored, ...valid }
    saveBoundaries({ ...r.file, targets: { ...r.file.targets, [targetKey(ref)]: stored } })
    return view({ ...r, stored, boundary: effective(ref, r.folder, stored) })
  })
}

export function writeLocalGuard(target: DesktopTargetRef): Promise<GuardStatus> {
  return serial(() => {
    const ref = validateTarget(target)
    const r = resolveAll(ref)
    if (r.boundary.admin) throw new Error(NO_BOUNDARY)
    if (r.boundary.tier !== 'guarded') throw new Error('The local guard is only for guarded boundaries; this one is audit-only')
    const rules = rulesFor(r.folder, r.boundary, r.places)
    const local = readLocalSettings(r.folder)
    if (local.kind === 'unreadable') throw new Error(`${local.error}; the hub won't overwrite it`)
    const merged = mergeGuardRules(local.kind === 'ok' ? local.settings : {}, rules, r.stored?.localGuard?.rules ?? [])
    try {
      fs.mkdirSync(path.join(r.folder, '.claude')) // not recursive: never create the project folder itself
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    writeAtomic(localSettingsPath(r.folder), JSON.stringify(merged.settings, null, 2) + '\n')
    const stored: StoredBoundary = { ...r.stored, localGuard: { rules: merged.hubAdded } }
    saveBoundaries({ ...r.file, targets: { ...r.file.targets, [targetKey(ref)]: stored } })
    return guardStatus(r.folder, r.boundary, stored, r.places)
  })
}

export function removeLocalGuard(target: DesktopTargetRef): Promise<GuardStatus> {
  return serial(() => {
    const ref = validateTarget(target)
    const r = resolveAll(ref)
    const record = r.stored?.localGuard
    if (!record) return guardStatus(r.folder, r.boundary, r.stored, r.places)
    const local = readLocalSettings(r.folder)
    if (local.kind === 'unreadable') throw new Error(`${local.error}; the hub won't overwrite it`)
    if (local.kind === 'ok') writeAtomic(localSettingsPath(r.folder), JSON.stringify(removeGuardRules(local.settings, record.rules), null, 2) + '\n')
    const rest: StoredBoundary = { ...r.stored }
    delete rest.localGuard
    const targets = { ...r.file.targets }
    if (Object.keys(rest).length > 0) targets[targetKey(ref)] = rest
    else delete targets[targetKey(ref)]
    saveBoundaries({ ...r.file, targets })
    return guardStatus(r.folder, r.boundary, targets[targetKey(ref)], r.places)
  })
}

// ---- Desktop launches ------------------------------------------------------------

// What a Desktop launch of `target` adds: the boundary statement for every
// tier; for guarded, --add-dir per neighbour and the deny rules (the caller
// writes them to a file and passes --settings). Throws when the boundary
// can't be read: a launch never silently falls back to a weaker tier. The
// admin (the claude-hub repo) gets nothing.
export function planBoundaryLaunch(target: DesktopTargetRef, places: Places): { tier: LaunchTier; args: string[]; settings: string | null } {
  const { path: folder, name } = resolveIn(target, places)
  const stored = loadBoundaries().targets[targetKey(target)]
  const boundary = effective(target, folder, stored)
  if (boundary.admin) return { tier: 'admin', args: [], settings: null }
  const neighbours = resolveNeighbours(boundary.neighbours, places)
  const statement = boundaryStatement({ name, folder, tier: boundary.tier, neighbours, vault: VAULT_PATH, vaultAccess: boundary.vaultAccess })
  const args = ['--append-system-prompt', statement]
  if (boundary.tier !== 'guarded') return { tier: 'audit', args, settings: null }
  const rules = rulesFor(folder, boundary, places)
  for (const n of neighbours) args.push('--add-dir', n.path)
  return { tier: 'guarded', args, settings: JSON.stringify({ permissions: { deny: rules } }, null, 2) + '\n' }
}

// ---- Project config ----------------------------------------------------------------

type FileEntry = ConfigLayer['files'][number]

function readText(file: string, label: string): { entry: FileEntry; text: string | null } {
  try {
    return { entry: { label, path: file, exists: true, error: null }, text: fs.readFileSync(file, 'utf-8') }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entry: { label, path: file, exists: false, error: null }, text: null }
    return { entry: { label, path: file, exists: true, error: (err as Error).message }, text: null }
  }
}

// A JSON object file. The parse error never carries file text (V8 quotes a
// snippet, and ~/.claude.json holds tokens).
function readJsonObject(file: string, label: string, settings: boolean): { entry: FileEntry; value: Record<string, unknown> | null } {
  const { entry, text } = readText(file, label)
  if (text === null) return { entry, value: null }
  try {
    if (settings) return { entry, value: parseSettingsObject(text) }
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error("it isn't a JSON object")
    return { entry, value: value as Record<string, unknown> }
  } catch (err) {
    const message = err instanceof SyntaxError ? "it isn't valid JSON" : (err as Error).message
    return { entry: { ...entry, error: message }, value: null }
  }
}

function mdTokens(files: { file: string; label: string; onlyIfPresent?: boolean }[]): { entries: FileEntry[]; tokens: number | null } {
  const entries: FileEntry[] = []
  let tokens: number | null = null
  for (const f of files) {
    const { entry, text } = readText(f.file, f.label)
    if (f.onlyIfPresent && !entry.exists) continue
    entries.push(entry)
    if (text !== null) tokens = (tokens ?? 0) + countTokens(text)
  }
  return { entries, tokens }
}

type ListKind = 'skills' | 'agents' | 'commands' | 'workflows'

// Names in a .claude/<kind> folder: skills are folders with a SKILL.md,
// agents and commands are .md files (commands nest as dir:name), workflows .js.
function listNames(dir: string, label: string, kind: ListKind): { entry: FileEntry; names: string[] } {
  const names: string[] = []
  const walk = (at: string, prefix: string) => {
    for (const d of fs.readdirSync(at, { withFileTypes: true })) {
      if (kind === 'skills') {
        if (d.isDirectory() && fs.existsSync(path.join(at, d.name, 'SKILL.md'))) names.push(d.name)
      } else if (kind === 'commands' && d.isDirectory()) {
        walk(path.join(at, d.name), `${prefix}${d.name}:`)
      } else if (d.isFile() && d.name.endsWith(kind === 'workflows' ? '.js' : '.md')) {
        names.push(prefix + d.name.replace(/\.(md|js)$/, ''))
      }
    }
  }
  try {
    walk(dir, '')
    return { entry: { label, path: dir, exists: true, error: null }, names: names.sort() }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entry: { label, path: dir, exists: false, error: null }, names: [] }
    return { entry: { label, path: dir, exists: true, error: (err as Error).message }, names: [] }
  }
}

function extensionLists(base: string, labelBase: string) {
  const lists = (['skills', 'agents', 'commands', 'workflows'] as const).map((kind) => listNames(path.join(base, kind), `${labelBase}${kind}`, kind))
  return { entries: lists.map((l) => l.entry), skills: lists[0].names, agents: lists[1].names, commands: lists[2].names, workflows: lists[3].names }
}

// CLAUDE.md files in the folders above `folder`, which Claude Code also loads.
function ancestorClaudeMds(folder: string): { file: string; label: string; onlyIfPresent: true }[] {
  const out: { file: string; label: string; onlyIfPresent: true }[] = []
  for (let dir = path.dirname(folder); ; dir = path.dirname(dir)) {
    out.push({ file: path.join(dir, 'CLAUDE.md'), label: `CLAUDE.md in ${dir}`, onlyIfPresent: true })
    if (path.dirname(dir) === dir) break
  }
  return out
}

export async function getProjectConfig(target: DesktopTargetRef): Promise<ProjectConfigReport> {
  const ref = validateTarget(target)
  let places: Places
  let folder: string
  try {
    places = readPlaces()
    folder = resolveIn(ref, places).path
  } catch (err) {
    return { target: ref, layers: [], findings: [], error: (err as Error).message }
  }
  const home = claudeHome()

  // Global: ~/.claude and the user-scope MCP servers in ~/.claude.json.
  const gSettings = readJsonObject(path.join(home, 'settings.json'), '~/.claude/settings.json', true)
  const gMd = mdTokens([{ file: path.join(home, 'CLAUDE.md'), label: '~/.claude/CLAUDE.md' }])
  const claudeJsonPath = path.join(path.dirname(home), '.claude.json')
  const claudeJson = readJsonObject(claudeJsonPath, '~/.claude.json', false)
  const facts = claudeJson.value ? claudeJsonFacts(claudeJson.value) : null
  const gLists = extensionLists(home, '~/.claude/')
  const global: ConfigLayer = {
    scope: 'global',
    files: [gSettings.entry, ...gMd.entries, claudeJson.entry, ...gLists.entries],
    claudeMdTokens: gMd.tokens,
    model: readModel(gSettings.value),
    permissions: readPermissions(gSettings.value),
    hooks: readHooks(gSettings.value),
    mcpServers: (facts?.userServers ?? []).map((s) => ({ name: s.name, target: s.target ?? '', enabled: null })),
    skills: gLists.skills,
    agents: gLists.agents,
    commands: gLists.commands,
    workflows: gLists.workflows,
  }

  // Project: checked-in config at the folder.
  const pSettings = readJsonObject(path.join(folder, '.claude', 'settings.json'), '.claude/settings.json', true)
  const lSettings = readJsonObject(localSettingsPath(folder), '.claude/settings.local.json', true)
  const pMd = mdTokens([
    { file: path.join(folder, 'CLAUDE.md'), label: 'CLAUDE.md' },
    { file: path.join(folder, '.claude', 'CLAUDE.md'), label: '.claude/CLAUDE.md' },
    ...ancestorClaudeMds(folder),
  ])
  const mcp = readJsonObject(path.join(folder, '.mcp.json'), '.mcp.json', false)
  const mcpBlock = mcp.value?.mcpServers
  if (mcp.value && mcpBlock !== undefined && (typeof mcpBlock !== 'object' || mcpBlock === null || Array.isArray(mcpBlock))) {
    mcp.entry = { ...mcp.entry, error: 'its mcpServers entry is not an object' }
    mcp.value = null
  }
  const mcpServers = mcp.value && mcpBlock !== undefined ? claudeJsonFacts({ mcpServers: mcpBlock }).userServers : []
  const pLists = extensionLists(path.join(folder, '.claude'), '.claude/')
  const project: ConfigLayer = {
    scope: 'project',
    files: [...pMd.entries, pSettings.entry, mcp.entry, ...pLists.entries],
    claudeMdTokens: pMd.tokens,
    model: readModel(pSettings.value),
    permissions: readPermissions(pSettings.value),
    hooks: readHooks(pSettings.value),
    mcpServers: mcpServers.map((s) => ({ name: s.name, target: s.target ?? '', enabled: mcpjsonApproval(s.name, [lSettings.value, pSettings.value]) })),
    skills: pLists.skills,
    agents: pLists.agents,
    commands: pLists.commands,
    workflows: pLists.workflows,
  }

  // Local: this machine's untracked overrides, and local-scope MCP servers.
  const lMd = mdTokens([{ file: path.join(folder, 'CLAUDE.local.md'), label: 'CLAUDE.local.md' }])
  const local: ConfigLayer = {
    scope: 'local',
    files: [lSettings.entry, ...lMd.entries, { ...claudeJson.entry, label: "~/.claude.json (this folder's entry)" }],
    claudeMdTokens: lMd.tokens,
    model: readModel(lSettings.value),
    permissions: readPermissions(lSettings.value),
    hooks: readHooks(lSettings.value),
    mcpServers: (facts?.localServers ?? []).filter((s) => s.projectPath !== null && samePath(s.projectPath, folder)).map((s) => ({ name: s.name, target: s.target ?? '', enabled: null })),
    skills: [],
    agents: [],
    commands: [],
    workflows: [],
  }

  const layers = [global, project, local]
  let guard: GuardStatus['localSettings'] = 'absent'
  let guardError: string | null = null
  try {
    guard = view(resolveAll(ref)).guard.localSettings
  } catch (err) {
    guardError = (err as Error).message
  }
  const findings = configFindings({
    global: { settings: gSettings.value },
    project: { settings: pSettings.value },
    local: { settings: lSettings.value },
    mcpJson: mcp.entry.error ? 'unreadable' : mcp.value ? mcpServers.map((s) => s.name) : null,
    layers,
    guard,
  })
  if (guardError) findings.push({ severity: 'warn', layer: 'local', text: `Couldn't check the hub's guard rules: ${guardError}` })
  return { target: ref, layers, findings, error: null }
}

// ---- Audit -----------------------------------------------------------------------------

const MAX_CROSSINGS = 200

interface FileFacts {
  headless: boolean
  cwd: string | null
  facts: ToolFact[]
}

// Per transcript, keyed by size + mtime: the classification is redone each
// time (the boundary can change), the reading isn't.
const factCache = new Map<string, { size: number; mtimeMs: number; value: FileFacts }>()

async function readFacts(file: string, stat: fs.Stats): Promise<FileFacts> {
  const hit = factCache.get(file)
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.value
  let value: FileFacts
  if (isHeadlessTranscript(file)) {
    value = { headless: true, cwd: null, facts: [] }
  } else {
    let cwd: string | null = null
    const facts: ToolFact[] = []
    const refused = new Set<string>()
    const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity })
    for await (const line of lines) {
      const wantCwd = cwd === null && line.includes('"cwd"')
      const wantResult = line.includes('"is_error":true')
      if (!wantCwd && !wantResult && !line.includes('"tool_use"')) continue
      let parsed: { cwd?: unknown }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue // the last line may be mid-write
      }
      if (wantCwd && typeof parsed.cwd === 'string' && parsed.cwd) cwd = parsed.cwd
      facts.push(...extractFacts(parsed))
      if (wantResult) for (const id of refusedToolUseIds(parsed)) refused.add(id)
    }
    value = { headless: false, cwd, facts: facts.map((f) => (f.id && refused.has(f.id) ? { ...f, blocked: true } : f)) }
  }
  factCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value })
  return value
}

export async function auditBoundary(target: DesktopTargetRef, days: number): Promise<BoundaryAudit> {
  const ref = validateTarget(target)
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Days must be a whole number from 1 to 365')
  const sinceMs = Date.now() - days * 86_400_000
  const sinceIso = new Date(sinceMs).toISOString()
  const empty = (error: string): BoundaryAudit => ({ target: ref, sinceIso, sessionsScanned: 0, sessionsUnreadable: 0, crossings: [], total: 0, blocked: 0, error })
  let r: Resolved
  try {
    r = resolveAll(ref)
  } catch (err) {
    return empty((err as Error).message)
  }
  // Said as a reason, never as zero crossings: there is no boundary to cross.
  if (r.boundary.admin) return empty('claude-hub administers every project, so its sessions are not audited')
  const places = placeList(r.places)
  const ctx: AuditContext = {
    folder: r.folder,
    places,
    neighbours: resolveNeighbours(r.boundary.neighbours, r.places),
    vault: VAULT_PATH,
    vaultAccess: r.boundary.vaultAccess,
    zones: protectedDirs(),
    home: os.homedir(),
  }
  // Whose session a cwd is: an experiment's only in its exact folder; a
  // project's at its root or any subfolder that isn't another place.
  const ownerOf = (cwd: string) =>
    places.filter((p) => isInside(cwd, p.path)).sort((a, b) => b.path.length - a.path.length)[0]
  const member = (cwd: string) => {
    if (ref.kind === 'experiment') return samePath(cwd, r.folder)
    const o = ownerOf(cwd)
    return o?.kind === 'project' && o.key === ref.key
  }

  let scan: ReturnType<typeof scanSessionDirs>
  try {
    scan = scanSessionDirs(r.folder, claudeProjectsDir())
  } catch (err) {
    return empty(`Couldn't read Claude Code's transcripts (${claudeProjectsDir()}): ${(err as Error).message}`)
  }

  let sessionsScanned = 0
  let sessionsUnreadable = 0
  const crossings: BoundaryCrossing[] = []
  let blocked = 0
  const recentJsonl = (dir: string): { file: string; stat: fs.Stats }[] | null => {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return null
    }
    const out: { file: string; stat: fs.Stats }[] = []
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(dir, name)
      try {
        const stat = fs.statSync(file)
        if (stat.isFile() && stat.mtimeMs >= sinceMs) out.push({ file, stat })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') sessionsUnreadable += 1
      }
    }
    return out
  }
  const classify = (sessionId: string, facts: ToolFact[]) => {
    for (const fact of facts) {
      const at = Date.parse(fact.at)
      if (!Number.isFinite(at) || at < sinceMs) continue
      const c = classifyFact(fact, ctx)
      if (c && fact.blocked) blocked += 1 // attempted, but it never ran
      else if (c) crossings.push({ sessionId, ...c })
    }
  }

  for (const dir of scan.dirs) {
    const files = recentJsonl(dir)
    if (files === null) {
      sessionsUnreadable += 1 // a whole folder of sessions nobody could list
      continue
    }
    for (const { file, stat } of files) {
      let main: FileFacts
      try {
        main = await readFacts(file, stat)
      } catch {
        sessionsUnreadable += 1
        continue
      }
      if (main.headless || !main.cwd || !member(main.cwd)) continue
      sessionsScanned += 1
      const sessionId = path.basename(file, '.jsonl')
      classify(sessionId, main.facts.map((f) => (f.cwd ? f : { ...f, cwd: main.cwd })))
      for (const sub of listSubagentTranscripts(file)) {
        try {
          const subFacts = await readFacts(sub, fs.statSync(sub))
          classify(sessionId, subFacts.facts.map((f) => (f.cwd ? f : { ...f, cwd: main.cwd })))
        } catch {
          sessionsUnreadable += 1
        }
      }
    }
  }
  // Folders whose transcripts' cwd couldn't be read may hold this target's
  // sessions: counted, never dropped.
  for (const dir of scan.unknown) sessionsUnreadable += recentJsonl(dir)?.length ?? 1

  crossings.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const experimentsNote = r.places.experiments === null ? `${r.places.experimentsError}, so crossings into experiments show under their parent folder` : null
  return { target: ref, sinceIso, sessionsScanned, sessionsUnreadable, crossings: crossings.slice(0, MAX_CROSSINGS), total: crossings.length, blocked, error: experimentsNote }
}
