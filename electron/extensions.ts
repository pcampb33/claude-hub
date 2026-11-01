// MCP servers, plugins and claude.ai connectors (the Extensions page).
//
// getExtensions has to answer fast, and the one source that can't is the
// health check: `claude mcp list` connects to every server and takes ~7s. So
// the check runs in the background (single-flight) and is cached; a read
// returns the last finished check with its age and says when a newer one is
// running. The rest is quick: `claude plugin list --json` (~0.9s),
// ~/.claude.json, plugin details (~1.1s each, cached per id+version on disk
// because they only change with the plugin), and the shared transcript index.
//
// Two caches, two different failure rules (CLAUDE.md, "a failure rendered as
// an absence"): a failed check is never cached as a result — it marks every
// server 'unchecked' until a check succeeds; a failed `plugin details` is
// never cached at all.
//
// Electron-free.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ExtensionsSnapshot } from '../shared/ipc-types.ts'
import { runClaudeCli } from './claude-cli.ts'
import {
  buildItems,
  claudeJsonFacts,
  parseMcpList,
  parsePluginDetails,
  parsePluginList,
  type McpHealthEntry,
  type PluginDetails,
  type PluginInfo,
} from './extensions-core.ts'
import { getExtensionUsage, type ExtensionUsage } from './skill-usage.ts'

// A background re-check starts `claude mcp list`, which spawns every stdio
// server (npx fetches included). Home is the landing view and reads this on
// every visit, so automatic re-checks are hourly; Recheck runs one now, and
// the page always shows how old the answer is.
const HEALTH_TTL_MS = 60 * 60_000
// `plugin list` is a full CLI start (~0.9s); Home and the Extensions page
// share one answer for this long.
const PLUGINS_TTL_MS = 2 * 60_000
// Measured at ~7s for 23 servers. A check past this is hung, not slow.
const HEALTH_TIMEOUT_MS = 60_000
const CLI_TIMEOUT_MS = 20_000
const USAGE_TTL_MS = 2 * 60_000
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60_000
// How long a read waits for a usage scan before answering without it. A warm
// index refresh is a stat per transcript; only the cold scan after an index
// version bump runs longer, and that one reports itself as running.
const USAGE_WAIT_MS = 1_200

// The checks run outside every project, so project-local servers never
// appear in them (extensions-core says so on those items).
const CLI_CWD = os.homedir()

interface CacheFile {
  v: 2
  details: Record<string, PluginDetails>
  health: { checkedAtIso: string; entries: McpHealthEntry[] } | null
}

function cachePath(): string {
  return path.join(process.env.APP_ROOT!, 'extensions-cache.json')
}

let cacheLoaded = false
const detailsCache = new Map<string, PluginDetails>()
let lastOk: { atMs: number; entries: McpHealthEntry[] } | null = null
let lastFailure: { atMs: number; message: string } | null = null
let lastAttemptMs = 0
// Set by a plugin toggle: the servers it brings came or went, so the cached
// check is stale however young it is.
let healthInvalidated = false
// A check that finished before the last plugin toggle describes the machine
// as it was, so its answers aren't current.
let lastToggleMs = 0
let healthRun: Promise<void> | null = null

function loadCache(): void {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf-8')) as Partial<CacheFile>
    // v2: targets are redacted (redactTarget); a v1 file may hold raw ones.
    if (parsed.v !== 2) return
    for (const [k, d] of Object.entries(parsed.details ?? {})) detailsCache.set(k, d)
    const atMs = parsed.health ? Date.parse(parsed.health.checkedAtIso) : NaN
    if (parsed.health && Array.isArray(parsed.health.entries) && !Number.isNaN(atMs)) {
      lastOk = { atMs, entries: parsed.health.entries }
    }
  } catch {
    // Missing or malformed: start empty. Nothing in it is a negative result.
  }
}

function saveCache(): void {
  const file: CacheFile = {
    v: 2,
    details: Object.fromEntries(detailsCache),
    health: lastOk ? { checkedAtIso: new Date(lastOk.atMs).toISOString(), entries: lastOk.entries } : null,
  }
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(file))
  } catch (err) {
    console.log(`[extensions] couldn't write ${cachePath()}: ${String(err)}`)
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function startHealthCheck(): Promise<void> {
  if (!healthRun) {
    lastAttemptMs = Date.now()
    healthInvalidated = false
    healthRun = runClaudeCli(['mcp', 'list'], { timeoutMs: HEALTH_TIMEOUT_MS, cwd: CLI_CWD })
      .then((out) => {
        const { entries, unparsed } = parseMcpList(out)
        // Output with lines but no server we could read is a format change,
        // not "no servers" — the CLI says "No MCP servers configured" for that.
        if (entries.length === 0 && unparsed.length > 0) {
          throw new Error(`Couldn't parse claude mcp list output: ${unparsed[0].slice(0, 160)}`)
        }
        lastOk = { atMs: Date.now(), entries }
        lastFailure = null
        saveCache()
      })
      .catch((err: unknown) => {
        lastFailure = { atMs: Date.now(), message: message(err) }
      })
      .finally(() => {
        healthRun = null
      })
  }
  return healthRun
}

function healthIsStale(): boolean {
  return healthInvalidated || Date.now() - Math.max(lastAttemptMs, lastOk?.atMs ?? 0) > HEALTH_TTL_MS
}

function healthSnapshot(): ExtensionsSnapshot['health'] {
  return {
    state: healthRun ? 'running' : lastFailure ? 'error' : lastOk ? 'ok' : 'never',
    checkedAtIso: lastOk ? new Date(lastOk.atMs).toISOString() : null,
    error: lastFailure?.message ?? null,
  }
}

let usageData: { atMs: number; sinceIso: string; data: ExtensionUsage } | null = null
let usageFailure: string | null = null
let usageRun: Promise<void> | null = null

function startUsageScan(): Promise<void> {
  if (!usageRun) {
    const sinceIso = new Date(Date.now() - USAGE_WINDOW_MS).toISOString()
    usageRun = getExtensionUsage(sinceIso)
      .then((data) => {
        usageData = { atMs: Date.now(), sinceIso, data }
        usageFailure = null
      })
      .catch((err: unknown) => {
        usageFailure = message(err)
      })
      .finally(() => {
        usageRun = null
      })
  }
  return usageRun
}

async function usageNow(): Promise<{ data: ExtensionUsage | null; snapshot: ExtensionsSnapshot['usage'] }> {
  if (!usageRun && (!usageData || Date.now() - usageData.atMs > USAGE_TTL_MS)) void startUsageScan()
  if (!usageData && !usageFailure && usageRun) {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([usageRun, new Promise((r) => (timer = setTimeout(r, USAGE_WAIT_MS)))])
    clearTimeout(timer)
  }
  // The latest attempt failing outranks an older success: those numbers
  // describe a corpus we can no longer read.
  if (usageFailure) return { data: null, snapshot: { state: 'error', error: usageFailure, sinceIso: null } }
  if (usageData) return { data: usageData.data, snapshot: { state: 'ok', error: null, sinceIso: usageData.sinceIso } }
  return {
    data: null,
    snapshot: { state: 'error', error: 'The first transcript scan is still running', sinceIso: null, running: true },
  }
}

const DETAILS_RETRY_MS = 10 * 60_000
const detailsFailures = new Map<string, { atMs: number; error: Error }>()

async function detailsFor(plugins: PluginInfo[]): Promise<Map<string, PluginDetails | Error>> {
  const out = new Map<string, PluginDetails | Error>()
  let added = false
  await Promise.all(
    plugins.map(async (p) => {
      const key = `${p.id}#${p.version}`
      const cached = detailsCache.get(key)
      if (cached) return void out.set(p.id, cached)
      // A recent failure is replayed as the failure it was (never as "no
      // cost"), so an orphaned plugin doesn't add a ~1s CLI call to every read.
      const failed = detailsFailures.get(key)
      if (failed && Date.now() - failed.atMs < DETAILS_RETRY_MS) return void out.set(p.id, failed.error)
      try {
        const d = parsePluginDetails(await runClaudeCli(['plugin', 'details', p.id], { timeoutMs: CLI_TIMEOUT_MS, cwd: CLI_CWD }))
        out.set(p.id, d)
        // Output we couldn't read anything from is not worth remembering.
        if (d.alwaysOnTokens !== null || d.components.length > 0) {
          detailsCache.set(key, d)
          added = true
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        detailsFailures.set(key, { atMs: Date.now(), error })
        out.set(p.id, error)
      }
    }),
  )
  if (added) saveCache()
  return out
}

let pluginsCache: { atMs: number; request: Promise<PluginInfo[]> } | null = null

// Single-flight and briefly cached. `fresh` is for validating an id before
// it reaches a spawn: that check must see what the CLI says now.
function listPlugins(fresh = false): Promise<PluginInfo[]> {
  if (!fresh && pluginsCache && Date.now() - pluginsCache.atMs < PLUGINS_TTL_MS) return pluginsCache.request
  const request = runClaudeCli(['plugin', 'list', '--json'], { timeoutMs: CLI_TIMEOUT_MS, cwd: CLI_CWD }).then(parsePluginList)
  const entry = { atMs: Date.now(), request }
  pluginsCache = entry
  // A failure is not an answer to hand the next caller.
  request.catch(() => {
    if (pluginsCache === entry) pluginsCache = null
  })
  return request
}

export async function getExtensions(): Promise<ExtensionsSnapshot> {
  loadCache()
  if (!healthRun && healthIsStale()) void startHealthCheck()
  const claudeJsonPath = path.join(os.homedir(), '.claude.json')
  const [plugins, claudeJson] = await Promise.all([
    listPlugins(),
    fs.promises.readFile(claudeJsonPath, 'utf-8').then(
      (text) => JSON.parse(text) as unknown,
      (err: unknown) => {
        throw new Error(`Couldn't read ${claudeJsonPath}: ${message(err)}`)
      },
    ),
  ])
  const [details, usage] = await Promise.all([detailsFor(plugins), usageNow()])
  return {
    items: buildItems({
      plugins,
      details,
      config: claudeJsonFacts(claudeJson),
      health: { entries: lastOk?.entries ?? null, current: lastFailure === null && (lastOk?.atMs ?? 0) >= lastToggleMs },
      usage: usage.data,
    }),
    health: healthSnapshot(),
    usage: usage.snapshot,
    generatedAtIso: new Date().toISOString(),
  }
}

export async function recheckExtensions(): Promise<ExtensionsSnapshot> {
  loadCache()
  detailsFailures.clear()
  pluginsCache = null
  await Promise.all([startHealthCheck(), startUsageScan()])
  return getExtensions()
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<ExtensionsSnapshot> {
  if (typeof pluginId !== 'string' || typeof enabled !== 'boolean') throw new Error('Invalid plugin toggle request')
  // The id reaches a shell:true spawn, so it must name a plugin the CLI
  // itself just listed — never a renderer string taken on trust.
  const plugin = (await listPlugins(true)).find((p) => p.id === pluginId)
  if (!plugin) throw new Error(`No installed plugin "${pluginId}"`)
  if (plugin.scope === 'project' && plugin.projectPaths.length > 1) {
    throw new Error(`${plugin.name} is installed in ${plugin.projectPaths.length} projects; change it inside the project with /plugin`)
  }
  // --scope is auto-detected from the working directory, so a project-scope
  // plugin is toggled from inside its project.
  const cwd = plugin.scope === 'project' && plugin.projectPaths[0] ? plugin.projectPaths[0] : CLI_CWD
  await runClaudeCli(['plugin', enabled ? 'enable' : 'disable', plugin.id], { timeoutMs: CLI_TIMEOUT_MS, cwd })
  // The servers that plugin brings just came or went: the cached check no
  // longer describes this machine.
  healthInvalidated = true
  lastToggleMs = Date.now()
  pluginsCache = null
  return getExtensions()
}
