// Persisted incremental index of Skill-tool invocations across the whole
// ~/.claude/projects session corpus (~800MB / ~1000 files). A skill invocation
// can sit anywhere in any transcript, so there's no early-exit — a naive inline
// rescan on every Skills load would stall the UI. Instead we cache each file's
// extracted invocations keyed by its mtime and only re-parse files that changed
// since the last scan. Same machine-local, gitignored-at-APP_ROOT discipline as
// verify-ledger.jsonl (see floor-core.ts). Electron-free.
//
// The same pass records MCP tool calls for the Extensions page
// (getExtensionUsage), so the corpus is read once for both.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { parseLine } from './sessions.ts'
import { listProjects } from './registry.ts'
import { findSessionDirs } from './status.ts'
import type { SkillInvocationRecord, SkillUsage } from '../shared/ipc-types.ts'

// 2: slash-command invocations began counting. Every cached FileRecord was
// written by a scan that could not see them, so the bump is what forces the
// corpus to be re-read rather than serving the old undercount forever.
// 3: MCP tool calls (mcp__<server>__<tool>) are recorded too, for the
// Extensions page; same reason for the bump.
const INDEX_VERSION = 3

export interface SkillInvocation {
  skill: string
  timestamp: string
}
// `server` is the transcript's sanitized form (`claude_ai_Gmail`,
// `plugin_design_slack`); match it with normalizeServerName.
export interface McpCall {
  server: string
  tool: string
  timestamp: string
}
interface FileRecord {
  mtimeMs: number
  invocations: SkillInvocation[]
  // Every v3 scan writes it; optional so readers stay defensive about it.
  mcpCalls?: McpCall[]
}
export interface UsageIndex {
  v: number
  files: Record<string, FileRecord>
}

function defaultIndexPath(): string {
  return path.join(process.env.APP_ROOT!, 'skill-usage-index.json')
}

function defaultSessionRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

// Defensive load: a missing, malformed, or version-bumped index just starts
// fresh — same "never let one bad line/file poison the whole thing" stance as
// floor-core's parseLedgerLines.
export function loadIndex(idxPath: string): UsageIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(idxPath, 'utf-8')) as Partial<UsageIndex>
    if (parsed.v === INDEX_VERSION && parsed.files && typeof parsed.files === 'object') {
      return { v: INDEX_VERSION, files: parsed.files as Record<string, FileRecord> }
    }
  } catch {
    // fall through to a fresh index
  }
  return { v: INDEX_VERSION, files: {} }
}

// A slash invocation (`/handoff`) is a user turn whose entire content is the
// command wrapper Claude Code writes. It produces no Skill tool_use at all, so
// counting tool_use alone answered "how often did the MODEL reach for this",
// never "how often was it used" — and the Commands view, which lists these
// very skills AS `/name`, showed a number that excluded every invocation made
// the way its own labels describe. Measured on this corpus: `handoff` is 10 by
// tool_use and 19 more by slash.
//
// Wrapper-ONLY, deliberately. The identical tag is quoted verbatim inside
// agent prompts that replay an earlier conversation — 25 such copies for
// `handoff` against its 19 real invocations — so a substring match would
// inflate the very count this exists to correct. Requiring the whole content
// to be the wrapper keeps a quoted transcript from reading as a use.
const COMMAND_NAME = /<command-name>\/([a-z0-9][a-z0-9:-]*)<\/command-name>/
const COMMAND_WRAPPER_ONLY =
  /^(?:\s*<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>\s*)+$/

// Skill invocations in one JSONL line: a tool_use block named 'Skill' whose
// input.skill is the invoked skill name, or a slash-command wrapper turn (see
// above), tagged with the line's timestamp. (sessions.ts's extractText
// collapses tool_use to a placeholder and drops the input, so this is a
// separate parse pass over the same raw lines.)
export function extractSkillInvocations(line: string): SkillInvocation[] {
  return skillsFromParsed(parseLine(line))
}

type ParsedLine = ReturnType<typeof parseLine>

function skillsFromParsed(parsed: ParsedLine): SkillInvocation[] {
  const content = parsed?.message?.content
  if (!parsed) return []
  const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : ''
  if (typeof content === 'string') {
    const body = content.trim()
    if (!COMMAND_WRAPPER_ONLY.test(body)) return []
    const named = COMMAND_NAME.exec(body)
    return named ? [{ skill: named[1], timestamp }] : []
  }
  if (!Array.isArray(content)) return []
  const out: SkillInvocation[] = []
  for (const item of content as unknown as Array<{ type?: string; name?: string; input?: { skill?: unknown } }>) {
    if (item?.type === 'tool_use' && item.name === 'Skill') {
      const skill = item.input?.skill
      if (typeof skill === 'string' && skill.length > 0) out.push({ skill, timestamp })
    }
  }
  return out
}

// MCP tool calls in one JSONL line: tool_use blocks named
// `mcp__<server>__<tool>`. The server part runs to the first `__` after the
// prefix — sanitized server names keep single underscores
// (`claude_ai_Claude_Docs`), so the first double underscore is the separator.
export function extractMcpCalls(line: string): McpCall[] {
  return mcpFromParsed(parseLine(line))
}

function mcpFromParsed(parsed: ParsedLine): McpCall[] {
  const content = parsed?.message?.content
  if (!parsed || !Array.isArray(content)) return []
  const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : ''
  const out: McpCall[] = []
  for (const item of content as unknown as Array<{ type?: string; name?: string }>) {
    if (item?.type !== 'tool_use' || typeof item.name !== 'string' || !item.name.startsWith('mcp__')) continue
    const rest = item.name.slice(5)
    const sep = rest.indexOf('__')
    if (sep <= 0 || sep + 2 >= rest.length) continue
    out.push({ server: rest.slice(0, sep), tool: rest.slice(sep + 2), timestamp })
  }
  return out
}

// One JSON parse per line feeds both extractors — the cold scan reads the
// whole corpus, so parsing every line twice would double its dominant cost.
async function scanFile(filePath: string): Promise<Omit<FileRecord, 'mtimeMs'>> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const invocations: SkillInvocation[] = []
  const mcpCalls: McpCall[] = []
  for await (const line of rl) {
    const parsed = parseLine(line)
    const found = skillsFromParsed(parsed)
    if (found.length) invocations.push(...found)
    const calls = mcpFromParsed(parsed)
    if (calls.length) mcpCalls.push(...calls)
  }
  rl.close()
  stream.destroy()
  return { invocations, mcpCalls }
}

// A session's subagent transcripts: <dir>/<sessionId>/subagents/**/*.jsonl.
// No subagents folder is the common case; any other read error throws, like
// an unreadable project dir, so the prune never takes it for "no files".
function subagentFiles(sessionDir: string): string[] {
  const root = path.join(sessionDir, 'subagents')
  let names: string[]
  try {
    names = fs.readdirSync(root, { recursive: true }) as string[]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(root, n))
}

// A subagent transcript stands for its parent session's transcript
// (<dir>/<sessionId>.jsonl), which names the session and the project dir.
function sessionTranscriptOf(filePath: string): string {
  const m = /^(.*?)[\\/]subagents[\\/]/.exec(filePath)
  return m ? `${m[1]}.jsonl` : filePath
}

// Every session .jsonl across every project dir under the corpus root, and
// every subagent transcript under those sessions (46% of MCP calls).
//
// Returns null — not [] — when the root itself cannot be read. The difference
// is destructive: refreshUsageIndex prunes every index entry not present in
// this list and then writes the result to disk, so an empty array from an
// unreadable root wipes the persisted index and every skill reports "Not used
// yet". That is a read failure rendered as a measured zero, persisted, and
// silently (the one log line is gated on stale.length > 0). It self-heals on
// the next successful run, but until then the catalog answers "never invoked"
// about something nobody managed to look at.
function allSessionFiles(base: string): string[] | null {
  if (!fs.existsSync(base)) return null
  const files: string[] = []
  let entries: string[]
  try {
    entries = fs.readdirSync(base)
  } catch {
    return null
  }
  for (const entry of entries) {
    const dir = path.join(base, entry)
    let stat: fs.Stats
    try {
      stat = fs.statSync(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name
      if (entry.isDirectory()) {
        files.push(...subagentFiles(path.join(dir, name)))
        continue
      }
      // The caller stats each file once (and skips any that vanished).
      if (name.endsWith('.jsonl') && entry.isFile()) files.push(path.join(dir, name))
    }
  }
  return files
}

// Bounded-concurrency map — the cold scan touches ~1000 files: unbounded
// Promise.all would exhaust file descriptors, fully sequential would stall.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

// Incrementally refresh the on-disk index: forget deleted files, re-scan only
// files whose mtime changed, keep everything else. This is what makes usage
// cheap after the first (full) scan. Params injectable for tests; production
// uses the real corpus root + APP_ROOT index path.
export async function refreshUsageIndex(
  sessionRoot: string = defaultSessionRoot(),
  idxPath: string = defaultIndexPath(),
): Promise<UsageIndex> {
  return (await refreshChecked(sessionRoot, idxPath)).index
}

// `rootReadable: false` means the index is whatever an earlier scan left —
// fine for the Skills catalog, which has always served it, but the
// Extensions page must report an unreadable scan, not those numbers as usage.
async function refreshChecked(sessionRoot: string, idxPath: string): Promise<{ index: UsageIndex; rootReadable: boolean }> {
  const index = loadIndex(idxPath)
  // Unreadable corpus root: keep what we already know and touch nothing. The
  // prune below is only safe when the file list is a real observation.
  const sessionFiles = allSessionFiles(sessionRoot)
  if (sessionFiles === null) {
    console.log(`[skill-usage] corpus root unreadable (${sessionRoot}) — keeping the existing index untouched`)
    return { index, rootReadable: false }
  }
  const stats: Array<{ filePath: string; mtimeMs: number }> = []
  for (const filePath of sessionFiles) {
    try {
      stats.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs })
    } catch {
      // vanished — skip
    }
  }
  const present = new Set(stats.map((s) => s.filePath))
  let pruned = 0
  for (const filePath of Object.keys(index.files)) {
    if (!present.has(filePath)) {
      delete index.files[filePath]
      pruned++
    }
  }
  const stale = stats.filter((s) => index.files[s.filePath]?.mtimeMs !== s.mtimeMs)
  const scanned = await mapPool(stale, 12, async (s) => ({
    filePath: s.filePath,
    mtimeMs: s.mtimeMs,
    ...(await scanFile(s.filePath)),
  }))
  for (const r of scanned) {
    index.files[r.filePath] = { mtimeMs: r.mtimeMs, invocations: r.invocations, mcpCalls: r.mcpCalls }
  }
  // Unchanged corpus: the file on disk already says this.
  if (pruned > 0 || stale.length > 0) fs.writeFileSync(idxPath, JSON.stringify(index))
  if (stale.length > 0) console.log(`[skill-usage] scanned ${stale.length} of ${stats.length} session files`)
  return { index, rootReadable: true }
}

// How an invocation's session file path maps to a display project. Injectable
// so aggregateUsage stays pure in tests; production passes the registry-backed
// resolver below.
type ProjectResolver = (filePath: string) => { project: string; projectId: string | null }

// The session corpus keys transcripts by an encoded project dir; the encoding
// is lossy, so instead of decoding we ask each registered project which dirs
// are its (findSessionDirs — same roll-up the status scan uses) and match the
// invocation's dir against that. Unmatched dirs fall back to the raw dir
// basename, which is at least recognizable.
function buildProjectResolver(): ProjectResolver {
  const byDir = new Map<string, { project: string; projectId: string | null }>()
  for (const project of listProjects()) {
    try {
      for (const dir of findSessionDirs(project.path)) {
        byDir.set(dir.toLowerCase(), { project: project.name, projectId: project.id })
      }
    } catch {
      // unreadable project — its sessions just fall back to the dir basename
    }
  }
  return (filePath: string) => {
    const dir = path.dirname(filePath)
    return byDir.get(dir.toLowerCase()) ?? { project: path.basename(dir), projectId: null }
  }
}

const basenameResolver: ProjectResolver = (filePath) => ({
  project: path.basename(path.dirname(filePath)),
  projectId: null,
})

// Roll per-file invocations up into per-skill totals + most-recent timestamp,
// keeping every invocation as a {ts, project, sessionId} record (newest-first)
// for the evidence panel's sparkline / per-project split / recent list.
export function aggregateUsage(index: UsageIndex, resolveProject: ProjectResolver = basenameResolver): SkillUsage[] {
  const bySkill = new Map<string, { count: number; lastUsed: string; invocations: SkillInvocationRecord[] }>()
  for (const [filePath, record] of Object.entries(index.files)) {
    if (!Array.isArray(record?.invocations)) continue
    const transcript = sessionTranscriptOf(filePath)
    const { project, projectId } = resolveProject(transcript)
    const sessionId = path.basename(transcript).replace(/\.jsonl$/, '')
    for (const { skill, timestamp } of record.invocations) {
      const invocation: SkillInvocationRecord = { ts: timestamp, project, projectId, sessionId }
      const cur = bySkill.get(skill)
      if (cur) {
        cur.count++
        cur.invocations.push(invocation)
        if (timestamp > cur.lastUsed) cur.lastUsed = timestamp
      } else {
        bySkill.set(skill, { count: 1, lastUsed: timestamp, invocations: [invocation] })
      }
    }
  }
  return [...bySkill.entries()].map(([skill, { count, lastUsed, invocations }]) => ({
    skill,
    count,
    lastUsed,
    invocations: invocations.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)),
  }))
}

// Coalesce concurrent callers onto one scan — the view mounts and two
// getSkillUsage calls can race before either writes the index, otherwise each
// runs the full cold scan (also guards two open windows loading at once).
let inFlight: Promise<{ index: UsageIndex; rootReadable: boolean }> | null = null

function sharedRefresh(): Promise<{ index: UsageIndex; rootReadable: boolean }> {
  if (!inFlight) {
    inFlight = refreshChecked(defaultSessionRoot(), defaultIndexPath()).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

export async function getSkillUsage(): Promise<SkillUsage[]> {
  return aggregateUsage((await sharedRefresh()).index, buildProjectResolver())
}

// Transcript server names are sanitized: every character other than a letter,
// digit, `_` or `-` became `_` (`claude.ai Vercel` → `claude_ai_Vercel`,
// `plugin:design:slack` → `plugin_design_slack`). Normalize the config/CLI
// side the same way to match.
export function normalizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

export interface UsageTally {
  // In the window.
  calls: number
  // All time, so an item idle for the window can still say when it last ran.
  lastUsedIso: string | null
  // In the window, most-called first.
  topTools: { tool: string; count: number }[]
}

export interface ExtensionUsage {
  // Keyed by sanitized server name.
  mcp: Map<string, UsageTally>
  // Keyed by skill name as invoked (`design:ux-copy`); topTools is empty.
  skills: Map<string, UsageTally>
}

interface Tally {
  calls: number
  last: string
  tools: Map<string, number>
}

function tallyInto(map: Map<string, Tally>, key: string, tool: string | null, ts: string, inWindow: boolean): void {
  let cur = map.get(key)
  if (!cur) map.set(key, (cur = { calls: 0, last: '', tools: new Map() }))
  if (ts > cur.last) cur.last = ts
  if (!inWindow) return
  cur.calls++
  if (tool !== null) cur.tools.set(tool, (cur.tools.get(tool) ?? 0) + 1)
}

function finishTallies(map: Map<string, Tally>): Map<string, UsageTally> {
  const out = new Map<string, UsageTally>()
  for (const [key, { calls, last, tools }] of map) {
    const topTools = [...tools.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count)
    out.set(key, { calls, lastUsedIso: last || null, topTools })
  }
  return out
}

// Per-server MCP calls and per-skill invocations since `sinceIso`. ISO-8601
// UTC strings compare lexically, which is how the corpus writes timestamps.
export function aggregateExtensionUsage(index: UsageIndex, sinceIso: string): ExtensionUsage {
  const mcp = new Map<string, Tally>()
  const skills = new Map<string, Tally>()
  for (const record of Object.values(index.files)) {
    for (const c of Array.isArray(record?.mcpCalls) ? record.mcpCalls : []) {
      tallyInto(mcp, c.server, c.tool, c.timestamp, c.timestamp >= sinceIso)
    }
    for (const i of Array.isArray(record?.invocations) ? record.invocations : []) {
      tallyInto(skills, i.skill, null, i.timestamp, i.timestamp >= sinceIso)
    }
  }
  return { mcp: finishTallies(mcp), skills: finishTallies(skills) }
}

// Shares getSkillUsage's scan. Throws when the corpus root could not be read:
// the index it would otherwise return is an earlier scan's, and the caller
// must say "usage unavailable", never show those numbers as current.
export async function getExtensionUsage(sinceIso: string): Promise<ExtensionUsage> {
  const { index, rootReadable } = await sharedRefresh()
  if (!rootReadable) throw new Error(`Couldn't read the session transcripts in ${defaultSessionRoot()}`)
  return aggregateExtensionUsage(index, sinceIso)
}
