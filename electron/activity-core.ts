import fs from 'node:fs'
import path from 'node:path'
import { listProjects } from './registry.ts'
import { findSessionDirs } from './status.ts'
import { isHeadlessSessionCached } from './sessions.ts'
import type { ProjectActivityHistory } from '../shared/ipc-types'

const HISTORY_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

// Pure, testable core of the bucketing: given ms timestamps (day keys or
// fallback mtimes) and a reference "now" (ms), return per-local-day counts
// over the last HISTORY_DAYS
// (oldest→newest, ending on now's local day). Extracted from the filesystem
// walk so the day-index arithmetic — the part most prone to a silent
// off-by-one / DST regression — is unit-testable without touching disk.
export function bucketMtimesByDay(mtimesMs: number[], nowMs: number): number[] {
  const startOfToday = new Date(nowMs)
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()

  const days = new Array<number>(HISTORY_DAYS).fill(0)
  for (const mtimeMs of mtimesMs) {
    // Bucket by whole-calendar-day offset from today. Rounding the day
    // difference (rather than flooring the raw ms delta) keeps DST shifts and
    // sub-day boundaries from nudging a file into the wrong bucket.
    const fileDay = new Date(mtimeMs)
    fileDay.setHours(0, 0, 0, 0)
    const diffDays = Math.round((todayMs - fileDay.getTime()) / DAY_MS)
    const dayIndex = HISTORY_DAYS - 1 - diffDays
    if (dayIndex >= 0 && dayIndex < HISTORY_DAYS) days[dayIndex] += 1
  }
  return days
}

// Local-midnight ms for a timestamp — the dedup key for "was active on this
// calendar day". Same setHours(0,0,0,0) local-day logic as the bucketer.
function dayKeyOf(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Scan a chunk of JSONL for the distinct local days its lines' top-level
// `timestamp` fields land on. JSON.parse per line (not a regex) because
// message content routinely embeds `"timestamp":"…"` strings — including
// nested ones like file-history-snapshot lines — and only the top-level field
// is the write time. `consumed` is the byte offset just past the last newline:
// the incremental reader resumes there, so a partially-written trailing line
// is re-scanned next call. That re-scan is safe — day-set union is idempotent
// — so a trailing line that already parses cleanly is counted immediately.
export function scanChunkForDays(chunk: Buffer): { dayKeys: Set<number>; consumed: number } {
  const dayKeys = new Set<number>()
  for (const line of chunk.toString('utf8').split('\n')) {
    if (!line.includes('"timestamp"')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      const ts = (parsed as { timestamp?: unknown }).timestamp
      if (typeof ts !== 'string') continue
      const ms = Date.parse(ts)
      if (!Number.isNaN(ms)) dayKeys.add(dayKeyOf(ms))
    } catch {
      continue // partial or corrupt line
    }
  }
  return { dayKeys, consumed: chunk.lastIndexOf(0x0a) + 1 }
}

// Per-file day-set cache so repeated calls (the dashboard's 30s tick) cost a
// stat() per file: only bytes appended since the last scan are read (session
// JSONLs are append-only). `consumed` is written as an absolute offset, so a
// concurrent duplicate scan converges instead of double-advancing.
interface FileDayState {
  size: number
  mtimeMs: number
  consumed: number
  dayKeys: Set<number>
}
const fileDayCache = new Map<string, FileDayState>()

export async function activeDayKeysFor(
  filePath: string,
  stat: { size: number; mtimeMs: number },
): Promise<Set<number>> {
  const cached = fileDayCache.get(filePath)
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.dayKeys

  // Reset on shrink (rewrite/truncation) — the offset no longer lines up.
  const entry: FileDayState =
    cached && stat.size >= cached.consumed ? cached : { size: 0, mtimeMs: 0, consumed: 0, dayKeys: new Set() }
  const start = entry.consumed

  const handle = await fs.promises.open(filePath, 'r')
  let read: number
  const buf = Buffer.allocUnsafe(Math.max(0, stat.size - start))
  try {
    read = (await handle.read(buf, 0, buf.length, start)).bytesRead
  } finally {
    await handle.close()
  }
  const { dayKeys, consumed } = scanChunkForDays(buf.subarray(0, read))
  for (const key of dayKeys) entry.dayKeys.add(key)
  entry.consumed = start + consumed
  entry.size = stat.size
  entry.mtimeMs = stat.mtimeMs
  fileDayCache.set(filePath, entry)
  return entry.dayKeys
}

// Per-project session-activity history over the last 14 local days
// (oldest→newest, ending today). Headless `claude -p` transcripts
// (curate-session hook runs) are excluded via the shared cache so the trend
// reflects real interactive work, matching the session list and counts.
// Reuses the same session-dir resolution as status.ts / live.ts so it sees
// exactly the dirs those modules see.
//
// A session counts once on EACH local day one of its lines was written (its
// per-line timestamps), so long/resumed sessions no longer collapse into
// their last-write day. Files whose mtime predates the window are skipped
// without a read — mtime is the last write, so no line inside can land in the
// window. A file with no parseable timestamps falls back to its mtime day.
export async function getActivityHistory(): Promise<ProjectActivityHistory[]> {
  const nowMs = Date.now()
  const windowStart = new Date(nowMs)
  windowStart.setHours(0, 0, 0, 0)
  windowStart.setDate(windowStart.getDate() - (HISTORY_DAYS - 1))
  const windowStartMs = windowStart.getTime()

  return Promise.all(
    listProjects().map(async (entry) => {
      const files: Array<{ filePath: string; stat: fs.Stats }> = []
      for (const dir of findSessionDirs(entry.path)) {
        let entries: string[]
        try {
          entries = fs.readdirSync(dir)
        } catch {
          continue
        }
        for (const file of entries) {
          if (!file.endsWith('.jsonl')) continue
          const filePath = path.join(dir, file)
          let stat: fs.Stats
          try {
            stat = fs.statSync(filePath)
          } catch {
            continue // deleted between readdir and stat
          }
          if (!stat.isFile()) continue
          if (stat.mtimeMs < windowStartMs) continue // can't contribute a window day
          files.push({ filePath, stat })
        }
      }
      const headless = await Promise.all(files.map((f) => isHeadlessSessionCached(f.filePath)))
      const stamps: number[] = []
      await Promise.all(
        files.map(async (f, i) => {
          if (headless[i]) return
          let dayKeys: Set<number>
          try {
            dayKeys = await activeDayKeysFor(f.filePath, f.stat)
          } catch {
            dayKeys = new Set() // deleted mid-scan → mtime fallback
          }
          if (dayKeys.size === 0) stamps.push(f.stat.mtimeMs)
          else stamps.push(...dayKeys)
        }),
      )
      return { registryId: entry.id, days: bucketMtimesByDay(stamps, nowMs) }
    }),
  )
}
