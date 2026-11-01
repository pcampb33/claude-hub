// Automation freshness: is each background job actually current?
//
// This system's real work happens in hooks and scheduled jobs, and until now
// none of it was visible anywhere in the app — every automation writes a log to
// disk and nothing reads one. A job that stops running does not announce
// itself; its log simply stops, which reads as "quiet", not "did not run".
// That is the repo's own bug class ("no flag may mean both 'not yet' and
// 'never'") sitting in the layer that does the actual work.
//
// It happened for real: on 2026-08-22 the vault linker's scheduled task fired
// and produced no log line at all, and nothing in the app said so.
//
// The rule this module holds itself to: where it cannot tell, it reports
// `unknown` — never a reassuring default. A missing log is "never instrumented",
// not "never ran"; an unparseable timestamp is "unknown", not "stale".
import fs from 'node:fs'
import path from 'node:path'
import type { JobFreshness, JobSpendWindow } from '../shared/ipc-types.ts'

// Each automation, its log, and how often it is expected to produce output.
// `expectedIntervalHours: null` = event-driven (fires per session), so silence
// is not evidence of failure and staleness is not computable.
const JOBS: { id: string; label: string; log: string; expectedIntervalHours: number | null }[] = [
  { id: 'curate', label: 'Curate hook (SessionEnd)', log: 'curate-session.log', expectedIntervalHours: null },
  { id: 'recall', label: 'Vault recall hook', log: 'vault-recall.log', expectedIntervalHours: null },
  { id: 'drain', label: 'Inbox drain (daily noon)', log: 'drain-inbox.log', expectedIntervalHours: 24 },
  { id: 'verify', label: 'Floor verify (daily 04:45)', log: 'record-verify.log', expectedIntervalHours: 24 },
]

function logPath(file: string): string {
  return path.join(process.env.APP_ROOT!, 'scripts', file)
}

// Leading ISO timestamp of a log line, or null when the line does not carry
// one (a continuation line, a spilled stderr fragment).
export function parseLogStamp(line: string): string | null {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)
  return m ? m[1] : null
}

// The message a script actually wrote, with the leading stamp and the two
// hooks' `[pid N] ` tag removed, so the matchers below see the text and not the
// bookkeeping around it.
function logMessage(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '').replace(/^\[pid \d+\]\s*/, '')
}

// Does this dated log line record a failed run?
//
// The first version of this was three tokens (`FAILED:`, `failed:`, `error:`)
// guessed at the logs instead of read off them, and it missed most of what the
// scripts write. Two it missed outright: `exit: unusable plan (…) — inbox
// untouched`, a drain that paid for a sonnet call and changed nothing, and
// `  promote FAILED, left queued: …`, a failed write to the vault — that one
// missed on PUNCTUATION alone, because the pattern demanded `FAILED:` and the
// line writes `FAILED,`. Both rendered green.
//
// So: enumerated from the emitters (drain-inbox, link-vault,
// curate-session, vault-recall) rather than guessed, and matched on the fault
// WORD with no punctuation attached. Their benign exits — `no inbox file`,
// `inbox has no parseable entries`, `below pre-filter`, `vault empty` — carry
// none of these words, which is what keeps this from crying wolf daily.
//
// A word list can still only catch failures a script bothers to announce, so it
// is half the detector: isInProgressLine below is the structural half, for runs
// that end by saying nothing at all. A line matching neither is still NOT a
// failure and NOT a success — the caller keeps its recency verdict, so a
// reworded log degrades to "cannot tell" instead of turning into a false green.
export function isFailureLine(line: string): boolean {
  return /\b(failed|unusable|unparseable|error)\b|no valid edges/i.test(logMessage(line))
}

// Does this dated line say a run STARTED rather than finished?
//
// Each script opens with a line (`start: …`, `incremental link sweep…`) and
// closes with an outcome (`done: …`, `exit: …`, `re-linked N stale note(s)`).
// An opening or mid-run line standing as the last thing in the log therefore
// means the run never reported an outcome: it was killed, or it crashed past
// its own catch (drain-inbox has no top-level try/catch at all). That is a
// state no keyword list can reach, because a run that dies silently writes no
// keyword by definition. Real instance: drain's `start: 62 inbox entries, 42
// vault notes (dedup-only)` stood as the last line for 24 hours, reading green.
//
// Enumerated from the same emitters' non-terminal lines. Deliberately a
// recogniser for STARTS, not for ENDS: treating every unrecognised line as
// "never finished" would turn a reworded success into a false red, and a
// watchdog that cries wolf gets ignored.
export function isInProgressLine(line: string): boolean {
  return /^(start[: ]|parsed \d|plan:|reusing cached plan|backed up inbox|linking \d|incremental link sweep|PROMOTE |KEEP |WARN )/.test(
    logMessage(line),
  )
}

// ------------------------------------------------------------------ spend ---
//
// Every automation logs what its model calls cost, and nothing read it. From
// 2026-10-14 the curate hook curated its own headless transcripts: 851 of
// October's 1,375 paid runs, about $80 a week against a normal $8–10, and
// nobody noticed for two and a half weeks. The number was on disk every time.

// Twice the highest normal week (curate, $8–10). One constant for every job.
export const SPEND_CEILING_7D_USD = 20

// A run's TOTAL cost is on its closing line only. drain-inbox also prints the
// same cost on its mid-run `plan:` line, so counting every `cost=` would bill a
// drain twice; recall's `worker done:` and its legacy single-phase
// `done: injected` are different runs, never the same one twice. drain's
// `exit: unusable plan` writes the number without the `$`.
const COST_RE = /^(?:worker )?(?:done|exit):.*\bcost=(n\/a|\$?\d+(?:\.\d+)?)/

const DAY_MS = 864e5

function emptyWindow(): JobSpendWindow {
  return { usd: 0, runs: 0, unknownCostRuns: 0 }
}

function computeSpend(lines: string[], now: number): NonNullable<JobFreshness['spend']> {
  const spend = { day: emptyWindow(), week: emptyWindow(), month: emptyWindow() }
  for (const line of lines) {
    if (!line.includes('cost=')) continue // cheap skip: curate's log is ~3.7MB
    const m = COST_RE.exec(logMessage(line))
    if (!m) continue
    const stamp = parseLogStamp(line)
    const age = stamp ? now - Date.parse(stamp) : NaN
    if (!(age >= 0 && age <= 30 * DAY_MS)) continue // undated, after `now`, or older than every window
    const unknown = m[1] === 'n/a'
    const usd = unknown ? 0 : Number(m[1].replace('$', ''))
    if (!unknown && usd === 0) continue // a cached plan: no call was made
    const windows = age <= DAY_MS ? [spend.day, spend.week, spend.month] : age <= 7 * DAY_MS ? [spend.week, spend.month] : [spend.month]
    for (const w of windows) {
      w.runs++
      w.usd += usd
      if (unknown) w.unknownCostRuns++
    }
  }
  return spend
}

// The over-budget sentence, or null when the last 7 days are under the ceiling.
// Judged on the costs that were reported; n/a runs can only add to it.
export function spendBreach(spend: JobFreshness['spend']): string | null {
  if (!spend || spend.week.usd <= SPEND_CEILING_7D_USD) return null
  const unknown = spend.week.unknownCostRuns ? ` plus ${spend.week.unknownCostRuns} run(s) of unknown cost` : ''
  return `spent $${spend.week.usd.toFixed(2)} in 7 days${unknown} (ceiling $${SPEND_CEILING_7D_USD}) — normal is under $10`
}

export function assessJob(
  id: string,
  label: string,
  logFile: string,
  expectedIntervalHours: number | null,
  now: number = Date.now(),
): JobFreshness {
  const file = logPath(logFile)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch {
    // No log at all. This job may be running perfectly and simply never have
    // been instrumented — saying "stale" here would invent a failure.
    return { id, label, state: 'unknown', detail: `no log at scripts/${logFile}`, lastLine: null, lastRunIso: null, hoursSince: null, spend: null }
  }

  const lines = text.split('\n').filter((l) => l.trim())
  const lastLine = lines.at(-1) ?? null
  const spend = computeSpend(lines, now)
  if (!lastLine) {
    return { id, label, state: 'unknown', detail: 'log exists but is empty', lastLine: null, lastRunIso: null, hoursSince: null, spend }
  }

  // Walk back for the last DATED line rather than demanding one on the final
  // line. These logs carry multi-line entries — a spawn failure spills the
  // child's stderr, a crash spills a stack — so the final line is routinely a
  // continuation. Requiring a stamp there reported `unknown` for a job that had
  // in fact just run and logged normally: a false alarm in the module built to
  // stop false claims.
  let stamp: string | null = null
  let stampedLine: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = parseLogStamp(lines[i])
    if (s) {
      stamp = s
      stampedLine = lines[i]
      break
    }
  }
  if (!stamp) {
    return { id, label, state: 'unknown', detail: 'no log line carries a timestamp', lastLine, lastRunIso: null, hoursSince: null, spend }
  }
  // Report the dated line — it is the one the timestamp describes.
  const reportedLine = stampedLine ?? lastLine

  const parsed = Date.parse(stamp)
  if (!Number.isFinite(parsed)) {
    return { id, label, state: 'unknown', detail: `unparseable timestamp ${stamp}`, lastLine: reportedLine, lastRunIso: null, hoursSince: null, spend }
  }

  const hoursSince = Math.max(0, (now - parsed) / 36e5)

  // Recency alone cannot tell a job that is working from one that runs and
  // fails every time. The first version judged only the timestamp, so a hook
  // whose every run ended `FAILED: …` still rolled up as "reporting" — a green
  // light over a broken job, which is this module's own bug class one level up.
  //
  // Two questions, in order, because they have different answers: did the last
  // run FAIL, and did it FINISH? The vocabulary for both is enumerated from the
  // scripts (see the two matchers above) and stays deliberately narrow — an
  // unrecognised line is read as neither, keeping the recency verdict, so a
  // reworded log never silently becomes a pass or a panic.
  if (isFailureLine(reportedLine)) {
    return {
      id,
      label,
      state: 'stale',
      detail: `last run failed — ${reportedLine.slice(stamp.length).trim().slice(0, 120)}`,
      lastLine: reportedLine,
      lastRunIso: stamp,
      hoursSince,
      spend,
    }
  }

  // A run that announced itself and never announced an outcome did not finish.
  // Recently, that is most likely a run still in flight — curate's sonnet
  // extraction takes tens of seconds, a linker sweep minutes — and calling that
  // broken would be a false red on a job doing its work. Long past any
  // plausible run, it is a job that died mid-flight, which is exactly the
  // 24-hour-old `start:` line this check exists for.
  //
  // Checked BEFORE the event-driven branch on purpose: "silence is not a fault"
  // is about a hook nobody triggered, and a half-finished run is not silence.
  if (isInProgressLine(reportedLine)) {
    const IN_FLIGHT_HOURS = 1
    const running = hoursSince <= IN_FLIGHT_HOURS
    return {
      id,
      label,
      state: running ? 'unknown' : 'stale',
      detail: running
        ? `started ${Math.round(hoursSince * 60)}m ago and has not reported an outcome yet — it may still be running`
        : `started ${hoursSince.toFixed(1)}h ago and never reported an outcome — that run did not finish`,
      lastLine: reportedLine,
      lastRunIso: stamp,
      hoursSince,
      spend,
    }
  }

  // Event-driven jobs have no schedule to be late against.
  if (expectedIntervalHours === null) {
    return { id, label, state: 'event-driven', detail: 'fires per session; silence is not a fault', lastLine: reportedLine, lastRunIso: stamp, hoursSince, spend }
  }

  // ONE missed run is the fault, not two. The first draft of this waited for two
  // intervals on the theory that a machine asleep at the trigger is noise — but
  // the incident that motivated the feature is exactly that case, and the linker
  // task has StartWhenAvailable=False, so a run missed while asleep is gone
  // permanently rather than delayed. Waiting for a second miss would have let
  // the 2026-08-22 skip render green, which is the failure this exists to catch.
  //
  // GRACE_HOURS absorbs ordinary jitter (a task fires minutes late, a sweep runs
  // long) without absorbing a whole missed run.
  const GRACE_HOURS = 6
  const state = hoursSince > expectedIntervalHours + GRACE_HOURS ? 'stale' : 'current'
  const detail =
    state === 'stale'
      ? `last output ${hoursSince.toFixed(1)}h ago — it has missed at least one scheduled run (expected every ${expectedIntervalHours}h)`
      : `last output ${hoursSince.toFixed(1)}h ago`
  return { id, label, state, detail, lastLine: reportedLine, lastRunIso: stamp, hoursSince, spend }
}

export function getJobFreshness(): JobFreshness[] {
  return JOBS.map((j) => assessJob(j.id, j.label, j.log, j.expectedIntervalHours))
}
