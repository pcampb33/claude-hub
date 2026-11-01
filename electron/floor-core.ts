// Floor-status core: verify-ledger parsing, streak math, and report
// assembly (docs/leverage-architecture.md, ranked gap 7). Electron-free —
// scripts/record-verify.mjs imports this directly via plain `node`, same
// pattern as curate-core.ts. The ledger is append-only JSONL next to
// registry.json at APP_ROOT (machine-local, gitignored).
import fs from 'node:fs'
import path from 'node:path'
import { listProjects } from './registry.ts'
import { sanitize } from './status.ts'
import type {
  FloorDayStatus,
  FloorStatusReport,
  ProjectFloorStatus,
  RegistryEntry,
  VerifyRunRecord,
} from '../shared/ipc-types.ts'

export const HISTORY_DAYS = 14

export function ledgerPath(): string {
  return path.join(process.env.APP_ROOT!, 'verify-ledger.jsonl')
}

// Defensive line-by-line parse: one malformed or unknown-version line
// (partial write, hand edit, future schema bump) must never poison the
// rest of an append-only ledger.
export function parseLedgerLines(text: string): VerifyRunRecord[] {
  const records: VerifyRunRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = parsed as Partial<VerifyRunRecord>
    if (
      record.v === 1 &&
      typeof record.projectPath === 'string' &&
      typeof record.timestamp === 'string' &&
      typeof record.ok === 'boolean'
    ) {
      records.push(record as VerifyRunRecord)
    }
  }
  return records
}

export function appendVerifyRun(record: VerifyRunRecord): void {
  fs.appendFileSync(ledgerPath(), JSON.stringify(record) + '\n')
}

// Typed record assembly lives here, not in the untyped recorder script — a
// field typo there passes every gate while parseLedgerLines silently drops
// the lines (confirmed review finding). exitStatus takes execSync's
// err.status verbatim: a number normally, anything else (timeout/signal
// kill) becomes exitCode null.
export function makeVerifyRunRecord(input: {
  projectPath: string
  ok: boolean
  exitStatus: unknown
  durationMs: number
  command: string
  timestamp: string
}): VerifyRunRecord {
  return {
    v: 1,
    projectPath: input.projectPath,
    timestamp: input.timestamp,
    ok: input.ok,
    exitCode: typeof input.exitStatus === 'number' ? input.exitStatus : null,
    durationMs: input.durationMs,
    command: input.command,
  }
}

// Transcript dirname → registry entry, for the recorder's hook mode. Same
// match rule as curate-core's deriveProjectName (which returns a display
// name, not the entry — hook mode needs the whole entry for verifyCommand),
// extracted so the rule sits under tests instead of inline in the .mjs.
export function findEntryByTranscriptDirName(
  dirName: string,
  entries: RegistryEntry[],
): RegistryEntry | null {
  const lower = dirName.toLowerCase()
  return entries.find((p) => sanitize(p.path).toLowerCase() === lower) ?? null
}

// Streaks and the day strip work in whole *local* calendar days — a verify
// run belongs to the day the user experienced it on, not its UTC date.
function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// A day's status is the LAST run of that day ("ended the day green" is the
// signal that matters). `records` must be oldest→newest.
function statusByLocalDay(records: VerifyRunRecord[]): Map<string, FloorDayStatus> {
  const statusByDay = new Map<string, FloorDayStatus>()
  for (const record of records) {
    statusByDay.set(localDateKey(new Date(record.timestamp)), record.ok ? 'green' : 'red')
  }
  return statusByDay
}

// Load-bearing semantics: no records → null; latest run red → 0; otherwise
// the number of consecutive local calendar days ending at the most recent
// run's day that each have a green run.
//
// A day with NO run breaks the streak, and the count is anchored to the last
// run rather than to `now`. Both rules exist because the old definition
// (calendar days since the last red run) grew on its own while nobody ran
// anything: one green run in July still claimed a "42-day streak" six weeks
// later, from a ledger that had observed exactly one day. A streak may only
// count days somebody actually verified. How long ago that last run was is a
// separate fact, carried by latest.timestamp and rendered as staleness.
// `records` must be oldest→newest.
export function computeStreakDays(records: VerifyRunRecord[]): number | null {
  if (records.length === 0) return null
  const statusByDay = statusByLocalDay(records)
  const latest = new Date(records[records.length - 1].timestamp)
  let cursor = new Date(latest.getFullYear(), latest.getMonth(), latest.getDate())
  let days = 0
  while (statusByDay.get(localDateKey(cursor)) === 'green') {
    days++
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1)
  }
  return days
}

// Last HISTORY_DAYS local calendar days ending today, oldest→newest; 'none'
// if a day has no runs. `records` must be oldest→newest.
export function computeDayHistory(
  records: VerifyRunRecord[],
  now: Date,
): { date: string; status: FloorDayStatus }[] {
  const statusByDay = statusByLocalDay(records)
  const days: { date: string; status: FloorDayStatus }[] = []
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const date = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i))
    days.push({ date, status: statusByDay.get(date) ?? 'none' })
  }
  return days
}

export function buildFloorStatusReport(
  entries: RegistryEntry[],
  records: VerifyRunRecord[],
  now: Date,
): FloorStatusReport {
  const projects: ProjectFloorStatus[] = entries.map((entry) => {
    // Both sides are canonical registry paths, so a plain case-insensitive
    // comparison is the whole rule (same case-insensitivity discipline as
    // status.ts/curate-core.ts, minus their sanitize() step — no sanitized
    // dirnames are involved here).
    const own = records
      .filter((r) => r.projectPath.toLowerCase() === entry.path.toLowerCase())
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    return {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      verifyCommand: entry.verifyCommand ?? null,
      latest: own.length > 0 ? own[own.length - 1] : null,
      streakDays: computeStreakDays(own),
      days: computeDayHistory(own, now),
    }
  })
  return { generatedAt: now.toISOString(), historyDays: HISTORY_DAYS, projects }
}

// Composes registry + ledger directly (config-health.ts pattern) — no
// separate Electron wrapper; ipc-handlers.ts registers this as-is.
export function getFloorStatus(): FloorStatusReport {
  const records = fs.existsSync(ledgerPath())
    ? parseLedgerLines(fs.readFileSync(ledgerPath(), 'utf-8'))
    : []
  return buildFloorStatusReport(listProjects(), records, new Date())
}
