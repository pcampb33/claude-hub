import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ScopedUsageWindow, UsageLimitsReport, UsageWindow } from '../shared/ipc-types'

// Account rate-limit windows (5-hour session + weekly) from the OAuth usage
// endpoint — the same source Claude Code's /usage command reads. The access
// token comes from Claude Code's own credentials file and never leaves the
// main process; the renderer only ever sees the UsageLimitsReport.
//
// Deliberately no token-refresh flow: refresh tokens rotate on use, so
// refreshing here would race Claude Code's own refresh and could invalidate
// its stored credentials. An expired token just reports unavailable — using
// Claude Code refreshes it as a side effect.

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'

interface RawWindow {
  utilization?: unknown
  resets_at?: unknown
}

function toWindow(raw: RawWindow | null | undefined): UsageWindow | null {
  if (!raw || typeof raw.utilization !== 'number' || typeof raw.resets_at !== 'string') return null
  return { utilization: raw.utilization, resetsAt: raw.resets_at }
}

// One entry of the endpoint's limits[]. Note the snake-case + `percent`
// (vs. the top-level windows' `utilization`), and that scope/model may be null.
interface RawLimit {
  group?: unknown
  percent?: unknown
  resets_at?: unknown
  scope?: { model?: { display_name?: unknown } | null } | null
}

// The most-constrained model-scoped weekly window, derived from limits[]:
// weekly-group entries carrying a non-empty model display_name, keyed on the
// highest percent. Defensive like toWindow — a malformed limits never throws.
function toScopedWeekly(limits: unknown): ScopedUsageWindow | null {
  if (!Array.isArray(limits)) return null
  let best: ScopedUsageWindow | null = null
  for (const raw of limits) {
    if (!raw || typeof raw !== 'object') continue
    const l = raw as RawLimit
    if (l.group !== 'weekly') continue
    const label = l.scope?.model?.display_name
    if (typeof label !== 'string' || label === '') continue
    if (typeof l.percent !== 'number' || typeof l.resets_at !== 'string') continue
    if (!best || l.percent > best.utilization) {
      best = { utilization: l.percent, resetsAt: l.resets_at, label }
    }
  }
  return best
}

// Pure mapping from the endpoint's response body to our report windows,
// split out so the shape handling is unit-testable without network or fs.
export function parseUsageResponse(body: unknown): Pick<UsageLimitsReport, 'fiveHour' | 'sevenDay' | 'scopedWeekly'> {
  const b = (body ?? {}) as { five_hour?: RawWindow | null; seven_day?: RawWindow | null; limits?: unknown }
  return {
    fiveHour: toWindow(b.five_hour),
    sevenDay: toWindow(b.seven_day),
    scopedWeekly: toScopedWeekly(b.limits),
  }
}

function unavailable(reason: string): UsageLimitsReport {
  return { available: false, reason, fiveHour: null, sevenDay: null, scopedWeekly: null }
}

// Process-wide cache + single-flight + failure backoff. The dashboard polls
// this every 5 minutes PER CLIENT, and there have been several clients at
// once (desktop app, browser tabs, drive scripts) — with no cache that
// multiplied into enough upstream calls that the endpoint 429'd the account (observed 2026-07-17; the vault's no-refresh rule for
// this endpoint exists for exactly this reason). Success is served from
// cache for SUCCESS_TTL_MS; a failure is held for FAILURE_TTL_MS so retries
// can't hammer; and a transient failure serves the last good report (these
// windows move slowly) for up to STALE_GRACE_MS rather than blanking the
// tiles — stamped with `staleAsOf` so a caller can tell a re-served reading
// from a current one instead of reading an hours-old number as live.
// TTL is deliberately long: the endpoint's quota is account-level and shared
// with every running Claude Code session's own limit checks (observed
// 2026-07-17: valid token, 429 with Retry-After ~21min while several
// always-on sessions ran) — the hub should be a near-zero consumer, not a
// competitor. ~2 upstream calls/hour per process.
const SUCCESS_TTL_MS = 30 * 60_000
const FAILURE_TTL_MS = 5 * 60_000
const STALE_GRACE_MS = 4 * 60 * 60_000

// Hard deadline on the single-flight slot. A fetch that never settles wedges
// `inFlight` for the process's lifetime — every later call gets handed the
// same pending promise, and `.finally` (the only place the slot is cleared)
// never runs, so the tile renders a blank em-dash forever. Observed
// 2026-08-10: a desktop app 2h11m in, ~26 five-minute polls, never rendered a
// number, while a second process on the same machine fetched fine. The
// request's own AbortSignal is not enough to rule that out (it only covers
// the request once undici owns it), so this settles the slot unconditionally.
const DEADLINE_MS = 20_000

// Always resolves — never rejects — so the caller's `.finally` always fires.
export function settleWithin(
  promise: Promise<UsageLimitsReport>,
  ms: number = DEADLINE_MS,
): Promise<UsageLimitsReport> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(unavailable('timeout')), ms)
    // Don't hold a short-lived node process open on the timer.
    timer.unref?.()
    promise.then(resolve, () => resolve(unavailable('request-failed'))).finally(() => clearTimeout(timer))
  })
}

export interface UsageCacheState {
  lastGood: { report: UsageLimitsReport; at: number } | null
  lastServed: { report: UsageLimitsReport; at: number; ok: boolean } | null
}

// The cache's two serve paths, split out of getUsageLimits for the same reason
// parseUsageResponse is its own function: both are testable this way without
// network, fs or module-state surgery. There are genuinely two — a caller
// inside the TTL never reaches the fetch — so a stamp applied on only one of
// them still hands out unmarked stale readings.

// Serve path 1: the un-expired cache entry. null means "go fetch".
export function servedFromCache(state: UsageCacheState, now: number): UsageLimitsReport | null {
  const served = state.lastServed
  if (!served) return null
  return now - served.at < (served.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS) ? served.report : null
}

// Serve path 2: fold a settled fetch into the cache and pick what to serve.
// A failure inside the grace window re-serves the last good reading stamped
// with `staleAsOf`, as a COPY — lastGood.report is the very object already
// handed to whoever received it fresh, so stamping in place would retro-mark
// that reading as stale. The copy is what goes into lastServed, so path 1
// re-serves it stamped for the whole FAILURE_TTL_MS that follows.
export function recordFetch(state: UsageCacheState, fresh: UsageLimitsReport, at: number): UsageLimitsReport {
  if (fresh.available) {
    state.lastGood = { report: fresh, at }
    state.lastServed = { report: fresh, at, ok: true }
    return fresh
  }
  const good = state.lastGood
  const report = good && at - good.at < STALE_GRACE_MS ? { ...good.report, staleAsOf: good.at } : fresh
  state.lastServed = { report, at, ok: false }
  return report
}

const cache: UsageCacheState = { lastGood: null, lastServed: null }
let inFlight: Promise<UsageLimitsReport> | null = null

export function getUsageLimits(): Promise<UsageLimitsReport> {
  const cached = servedFromCache(cache, Date.now())
  if (cached) return Promise.resolve(cached)
  if (inFlight) return inFlight
  inFlight = settleWithin(fetchUsageLimits())
    .then((fresh) => recordFetch(cache, fresh, Date.now()))
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

async function fetchUsageLimits(): Promise<UsageLimitsReport> {
  let accessToken: unknown
  let expiresAt: unknown
  try {
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'))
    accessToken = creds?.claudeAiOauth?.accessToken
    expiresAt = creds?.claudeAiOauth?.expiresAt
  } catch {
    return unavailable('no-credentials')
  }
  if (typeof accessToken !== 'string' || accessToken === '') return unavailable('no-credentials')
  if (typeof expiresAt === 'number' && expiresAt <= Date.now()) return unavailable('token-expired')

  try {
    const res = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return unavailable(`http-${res.status}`)
    return { available: true, ...parseUsageResponse(await res.json()) }
  } catch {
    return unavailable('request-failed')
  }
}
