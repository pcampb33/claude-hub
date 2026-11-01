// Incremental index of token usage across every transcript under
// ~/.claude/projects, persisted to <APP_ROOT>/usage-index.json. Each refresh
// stats every file and reads only the bytes appended since the last one; a
// file that shrank is re-indexed from scratch, and a file that disappeared
// keeps its numbers (see refreshOnce). The first build reads the
// whole corpus (~2GB here), so it runs as async 4MB reads with a yield to the
// event loop between chunks, and getUsage answers 'indexing' with progress
// instead of waiting for it. Electron-free (pure logic in usage-index-core.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listProjects } from './registry.ts'
import { listExperimentPaths } from './sandbox.ts'
import { readSessionTitle } from './sessions.ts'
import {
  USAGE_INDEX_VERSION,
  buildAggregates,
  buildClaims,
  consumeChunk,
  groupSessions,
  indexSpan,
  newFileState,
  sessionsFor,
  type AttributionInput,
  type FileState,
  type UsageIndexData,
} from './usage-index-core.ts'
import type { UsageQuery, UsageReport, UsageSessionsReport } from '../shared/ipc-types.ts'

const CHUNK_BYTES = 4 * 1024 * 1024
const MIN_REFRESH_GAP_MS = 10_000
const SESSION_ROW_CAP = 100
const TITLE_MAX = 80

interface Listed {
  rel: string
  abs: string
  dir: string
  sessionId: string
  subagent: boolean
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

// Every transcript: <root>/<dir>/<sessionId>.jsonl, and subagent transcripts
// at <root>/<dir>/<sessionId>/subagents/**/*.jsonl, which belong to that
// session. Throws when the root itself can't be read — that is "unknown",
// never "no transcripts". A folder that can't be listed is returned in
// `unreadableDirs` and counted as unreadable: its new usage is unknown.
async function listTranscripts(root: string): Promise<{ files: Listed[]; unreadableDirs: Set<string> }> {
  const files: Listed[] = []
  const unreadableDirs = new Set<string>()
  const dirs = await fs.promises.readdir(root, { withFileTypes: true })
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(path.join(root, d.name), { withFileTypes: true })
    } catch {
      unreadableDirs.add(d.name)
      continue
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        files.push({ rel: path.join(d.name, e.name), abs: path.join(root, d.name, e.name), dir: d.name, sessionId: e.name.slice(0, -6), subagent: false })
      } else if (e.isDirectory()) {
        const subRoot = path.join(root, d.name, e.name, 'subagents')
        let subs: string[]
        try {
          subs = (await fs.promises.readdir(subRoot, { recursive: true })) as string[]
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadableDirs.add(path.join(d.name, e.name))
          continue
        }
        for (const s of subs) {
          if (!s.endsWith('.jsonl')) continue
          const rel = path.join(d.name, e.name, 'subagents', s)
          files.push({ rel, abs: path.join(root, rel), dir: d.name, sessionId: e.name, subagent: true })
        }
      }
    }
  }
  return { files, unreadableDirs }
}

// Reads [state.offset, size) in chunks, folding complete lines into state.
async function readAppended(abs: string, state: FileState, size: number, onBytes: (n: number) => void): Promise<void> {
  const handle = await fs.promises.open(abs, 'r')
  try {
    let pos = state.offset
    let carry = Buffer.alloc(0)
    while (pos < size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - pos))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, pos)
      if (bytesRead === 0) break // truncated under us; the next refresh sees the shrink
      pos += bytesRead
      onBytes(bytesRead)
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      const consumed = consumeChunk(state, buf)
      carry = buf.subarray(consumed)
      await yieldToLoop()
    }
  } finally {
    await handle.close()
  }
}

export interface UsageIndexerOptions {
  root: string
  indexPath: string
  attribution: () => AttributionInput
  titleOf?: (absPath: string) => Promise<string>
}

export function createUsageIndexer(opts: UsageIndexerOptions) {
  let committed: UsageIndexData | null = null
  let loaded = false
  let running: Promise<void> | null = null
  let lastError: string | null = null
  let lastRefreshAt = 0
  let unreadable = 0
  let progress = { done: 0, total: 0 }
  const titles = new Map<string, string>()

  // A missing, unparseable or other-version index is rebuilt; until that
  // build finishes the report says 'indexing' — never zeros.
  function load(): void {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(opts.indexPath, 'utf8')) as Partial<UsageIndexData>
      if (parsed.v === USAGE_INDEX_VERSION && typeof parsed.createdMs === 'number' && parsed.files && typeof parsed.files === 'object') {
        committed = { v: USAGE_INDEX_VERSION, createdMs: parsed.createdMs, files: parsed.files }
      }
    } catch {
      committed = null
    }
  }

  async function refreshOnce(): Promise<void> {
    const { files, unreadableDirs } = await listTranscripts(opts.root)
    const base = committed?.files ?? {}
    // Everything already indexed is kept, including transcripts that have since
    // disappeared: Claude Code deletes transcripts after 30 days by default
    // (cleanupPeriodDays), and usage that happened is still usage. Without this
    // the week and month views could never reach further back than that.
    const next: Record<string, FileState> = { ...base }
    let failed = unreadableDirs.size
    const work: { f: Listed; state: FileState; size: number; mtimeMs: number }[] = []
    for (const f of files) {
      const prev = base[f.rel]
      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(f.abs)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed++ // ENOENT: deleted since the listing
        continue
      }
      if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) continue
      // Copy-on-write: `committed` stays a consistent snapshot to serve from
      // while this refresh runs. A shrunk file is re-read from byte 0.
      const state = prev && stat.size >= prev.offset ? structuredClone(prev) : newFileState(f.dir, f.sessionId, f.subagent)
      work.push({ f, state, size: stat.size, mtimeMs: stat.mtimeMs })
    }
    progress = { done: 0, total: work.reduce((n, w) => n + (w.size - w.state.offset), 0) }
    for (const w of work) {
      try {
        await readAppended(w.f.abs, w.state, w.size, (n) => (progress.done += n))
        w.state.size = w.size
        w.state.mtimeMs = w.mtimeMs
        next[w.f.rel] = w.state
      } catch {
        failed++ // its previous state, if any, stays in `next`
      }
    }
    committed = { v: USAGE_INDEX_VERSION, createdMs: committed?.createdMs ?? Date.now(), files: next }
    unreadable = failed
    if (work.length > 0) {
      // The in-memory index is already current; a failed save only costs a
      // rebuild on the next launch, so it is logged rather than reported as
      // the numbers being stale.
      const tmp = `${opts.indexPath}.tmp`
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(committed))
        await fs.promises.rename(tmp, opts.indexPath)
      } catch (err) {
        console.error('[usage-index] could not save the index:', messageOf(err))
      }
    }
  }

  // Single-flight; at most one refresh per MIN_REFRESH_GAP_MS unless forced.
  function refresh(force = false): Promise<void> {
    load()
    if (running) return running
    if (!force && committed && Date.now() - lastRefreshAt < MIN_REFRESH_GAP_MS) return Promise.resolve()
    lastRefreshAt = Date.now()
    running = refreshOnce()
      .then(() => {
        lastError = null
      })
      .catch((err) => {
        lastError = messageOf(err)
      })
      .finally(() => {
        running = null
      })
    return running
  }

  // Waits up to `ms` for a running refresh, so a quick one (the usual
  // incremental case) is reflected in this answer.
  async function settle(ms: number): Promise<void> {
    const r = refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([r, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))])
    clearTimeout(timer)
  }

  function notReady(): Pick<UsageReport, 'state' | 'error' | 'progress'> {
    if (running) return { state: 'indexing', error: null, progress: { ...progress } }
    return { state: 'error', error: lastError ?? 'The usage index has not been built.' }
  }

  async function getUsage(query: UsageQuery): Promise<UsageReport> {
    const { granularity, periods } = query ?? ({} as UsageQuery)
    if (!['hour', 'day', 'week', 'month'].includes(granularity)) throw new Error(`Unknown granularity: ${String(granularity)}`)
    if (!Number.isInteger(periods) || periods < 1 || periods > 1000) throw new Error(`periods must be 1-1000, got ${String(periods)}`)
    await settle(committed ? 1500 : 300)
    const index = committed
    if (!index) {
      return {
        ...notReady(),
        coverage: { filesIndexed: 0, filesUnreadable: unreadable, firstIso: null, lastIso: null, indexedSinceIso: null },
        series: [],
        buckets: [],
        totals: {},
      }
    }
    const aggregates = buildAggregates(groupSessions(index), buildClaims(opts.attribution()), granularity, periods, Date.now())
    return {
      state: 'ready',
      error: lastError,
      coverage: { filesIndexed: Object.keys(index.files).length, filesUnreadable: unreadable, ...indexSpan(index), indexedSinceIso: new Date(index.createdMs).toISOString() },
      ...aggregates,
    }
  }

  async function titleFor(rel: string | null): Promise<string> {
    if (rel === null) return '(only subagent transcripts remain)'
    const abs = path.join(opts.root, rel)
    const cached = titles.get(abs)
    if (cached !== undefined) return cached
    try {
      const raw = (await (opts.titleOf ?? readSessionTitle)(abs)).replace(/\s+/g, ' ').trim()
      const title = raw.length > TITLE_MAX ? raw.slice(0, TITLE_MAX - 1) + '…' : raw
      titles.set(abs, title) // only a successful read is cached
      return title
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? '(transcript since deleted)' : '(title unreadable)'
    }
  }

  async function getUsageSessions(key: string, startIso: string, endIso: string): Promise<UsageSessionsReport> {
    const startMs = Date.parse(startIso)
    const endMs = Date.parse(endIso)
    if (typeof key !== 'string' || Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error('Invalid usage drill-down range')
    load()
    const index = committed
    if (!index) {
      const s = notReady()
      return { state: s.state, error: s.error, sessions: [], total: 0 }
    }
    const rows = sessionsFor(groupSessions(index), buildClaims(opts.attribution()), key, startMs, endMs)
    const top = rows.slice(0, SESSION_ROW_CAP)
    const sessions = await Promise.all(
      top.map(async (r) => ({
        sessionId: r.group.sessionId,
        title: await titleFor(r.group.mainFile),
        projectPath: r.group.cwd ?? '',
        processed: r.processed,
        output: r.output,
        activeMinutes: r.activeMinutes,
        lastIso: new Date(r.lastMs).toISOString(),
        headless: r.group.headless,
      })),
    )
    return { state: 'ready', error: lastError, sessions, total: rows.length }
  }

  return { refresh, getUsage, getUsageSessions }
}

let defaultIndexer: ReturnType<typeof createUsageIndexer> | null = null

function indexer() {
  defaultIndexer ??= createUsageIndexer({
    root: path.join(os.homedir(), '.claude', 'projects'),
    indexPath: path.join(process.env.APP_ROOT!, 'usage-index.json'),
    attribution: () => ({
      projects: listProjects().map((p) => ({ id: p.id, name: p.name, path: p.path })),
      experiments: listExperimentPaths(),
    }),
  })
  return defaultIndexer
}

export const getUsage = (query: UsageQuery) => indexer().getUsage(query)
export const getUsageSessions = (key: string, startIso: string, endIso: string) =>
  indexer().getUsageSessions(key, startIso, endIso)
