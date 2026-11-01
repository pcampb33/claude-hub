// The global layer: everything that runs in every session, on a schedule, or
// applies to every project — the two `~/.claude` hooks, the Windows scheduled
// jobs, and the settings that are not per-project.
//
// The rule this module holds itself to is the one the floor status had to be
// taught: a row's state describes whether the thing is DOING ITS JOB, not
// whether it is configured. Task Scheduler only knows whether Windows started
// a process — on 2026-08-23 it reported `Running · LastResult=0` for a
// server task that was not actually reachable, and it reported nothing at all
// about the linker having skipped a day. So every scheduled row is graded on a
// *work* probe (a log line, a ledger record) and a task with no such probe
// grades 'unknown' — never 'ok' on scheduler state alone.
//
// Electron-free on purpose (hub-service.ts contract).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GlobalAutomation, GlobalConfigReport, GlobalItemState, GlobalSettings, JobFreshness } from '../shared/ipc-types.ts'
import { getJobFreshness, spendBreach } from './job-freshness.ts'
import { listSkills } from './skills.ts'
import { openPathInVSCode } from './launch-core.ts'

const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification', 'PreCompact'] as const

// Task Scheduler names this app owns. Enumerated by prefix rather than listed,
// so a job added later shows up here without a code change — and an unmapped
// one grades 'unknown' rather than being silently dropped from the page.
const TASK_PREFIX = 'claude-hub'

// Which freshness probe stands for which scheduled task. A task missing from
// this map still appears on the page; it just cannot be graded 'ok'.
const TASK_WORK_PROBE: Record<string, string> = {
  'claude-hub inbox drain': 'drain',
  'claude-hub floor verify': 'verify',
}

// Which freshness probe stands for which hook script.
const HOOK_WORK_PROBE: { script: string; probe: string }[] = [
  { script: 'curate-session.mjs', probe: 'curate' },
  { script: 'vault-recall.mjs', probe: 'recall' },
]

function claudeDir(): string {
  return path.join(os.homedir(), '.claude')
}

function settingsPath(): string {
  return path.join(claudeDir(), 'settings.json')
}

// ------------------------------------------------------------ scheduler ---

export interface ScheduledTaskRow {
  taskName: string
  state: string // Ready | Running | Disabled
  lastRunIso: string | null
  lastResult: number | null
  nextRunIso: string | null
  startWhenAvailable: boolean
  wakeToRun: boolean
}

// Task Scheduler reports a never-run task as 1999-11-30, and an ISO string it
// could not produce as empty. Both mean "no run to report" — neither is a date
// to render.
function taskDate(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = Date.parse(trimmed)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).getFullYear() < 2000 ? null : new Date(parsed).toISOString()
}

// One `Name|State|LastRun|LastResult|NextRun|StartWhenAvailable|WakeToRun` line.
// Returns null for anything that doesn't have all seven fields — a partial line
// is not a task nobody scheduled, it is output this parser did not understand.
export function parseTaskLine(line: string): ScheduledTaskRow | null {
  const parts = line.split('|')
  if (parts.length < 7) return null
  const [taskName, state, lastRun, lastResult, nextRun, startWhenAvailable, wakeToRun] = parts
  if (!taskName.trim() || !state.trim()) return null
  const result = Number.parseInt(lastResult.trim(), 10)
  return {
    taskName: taskName.trim(),
    state: state.trim(),
    lastRunIso: taskDate(lastRun),
    lastResult: Number.isFinite(result) ? result : null,
    nextRunIso: taskDate(nextRun),
    startWhenAvailable: startWhenAvailable.trim() === 'True',
    wakeToRun: wakeToRun.trim() === 'True',
  }
}

const TASK_QUERY = `Get-ScheduledTask | Where-Object { $_.TaskName -like '${TASK_PREFIX}*' } | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo
  $last = if ($i.LastRunTime) { $i.LastRunTime.ToString('o') } else { '' }
  $next = if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { '' }
  "$($_.TaskName)|$($_.State)|$last|$($i.LastTaskResult)|$next|$($_.Settings.StartWhenAvailable)|$($_.Settings.WakeToRun)"
}`

// Async: a sync PowerShell call held the main thread ~1s on every Home load.
const execFileAsync = promisify(execFile)

async function readScheduledTasks(): Promise<{ rows: ScheduledTaskRow[]; error: string | null }> {
  try {
    const { stdout: out } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TASK_QUERY], {
      encoding: 'utf-8',
      timeout: 20_000,
      windowsHide: true,
    })
    const rows = out.split('\n').map(parseTaskLine).filter((r): r is ScheduledTaskRow => r !== null)
    return { rows, error: null }
  } catch (err) {
    // A failed query is not "no scheduled jobs". Say so, and let every
    // scheduled row report 'unknown'.
    return { rows: [], error: err instanceof Error ? err.message.split('\n')[0] : String(err) }
  }
}

// ------------------------------------------------------------- settings ---

function readSettings(): GlobalSettings {
  const file = settingsPath()
  const empty = {
    path: file,
    model: null,
    effortLevel: null,
    modelEffortLevels: [],
    permissionsAllow: null,
    permissionsDeny: null,
    statusLineCommand: null,
    claudeMdBytes: null,
    globalSkills: [] as string[],
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }
  }

  const permissions = (parsed.permissions ?? {}) as { allow?: unknown[]; deny?: unknown[] }
  const modelSettings = (parsed.modelSettings ?? {}) as Record<string, { effortLevel?: unknown } | null>
  const modelEffortLevels = Object.entries(modelSettings).flatMap(([model, s]) =>
    typeof s?.effortLevel === 'string' ? [{ model, effortLevel: s.effortLevel }] : [],
  )
  const statusLine = (parsed.statusLine ?? null) as { command?: string } | null
  let claudeMdBytes: number | null = null
  try {
    claudeMdBytes = fs.statSync(path.join(claudeDir(), 'CLAUDE.md')).size
  } catch {
    claudeMdBytes = null // no global CLAUDE.md, or unreadable — not "0 bytes"
  }
  let globalSkills: string[] = []
  try {
    globalSkills = listSkills()
      .filter((s) => s.source === 'global')
      .map((s) => s.name)
      .sort()
  } catch {
    globalSkills = []
  }

  return {
    path: file,
    error: null,
    model: typeof parsed.model === 'string' ? parsed.model : null,
    effortLevel: typeof parsed.effortLevel === 'string' ? parsed.effortLevel : null,
    modelEffortLevels,
    permissionsAllow: Array.isArray(permissions.allow) ? permissions.allow.length : 0,
    permissionsDeny: Array.isArray(permissions.deny) ? permissions.deny.length : 0,
    statusLineCommand: typeof statusLine?.command === 'string' ? statusLine.command : null,
    claudeMdBytes,
    globalSkills,
  }
}

// Every hook registered in settings.json, in the shape the page renders. The
// command text is read verbatim — this module never rewrites it.
export function parseHooks(settings: unknown): { event: string; command: string }[] {
  const hooks = (settings as { hooks?: Record<string, unknown> })?.hooks
  if (!hooks || typeof hooks !== 'object') return []
  const out: { event: string; command: string }[] = []
  for (const event of HOOK_EVENTS) {
    const groups = (hooks as Record<string, unknown>)[event]
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const entries = (group as { hooks?: unknown[] })?.hooks
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        const command = (entry as { command?: unknown })?.command
        if (typeof command === 'string' && command.trim()) out.push({ event, command: command.trim() })
      }
    }
  }
  return out
}

// The local file a hook command runs, if it names one. Used to answer "is this
// hook pointing at a script that still exists?" — a hook whose script moved
// still looks perfectly configured and fails on every single session.
export function hookScriptPath(command: string): string | null {
  const match = command.match(/[A-Za-z]:[\\/][^\s"']+\.(?:mjs|js|cjs|ts|py|ps1|cmd|bat)/)
  return match ? match[0] : null
}

// --------------------------------------------------------------- grading ---

// A work probe's freshness → the row's verdict. 'stale' is the only state that
// accuses; 'unknown' stays 'unknown' all the way to the screen.
function stateFromFreshness(job: JobFreshness | undefined): { state: GlobalItemState; detail: string } {
  if (!job) return { state: 'unknown', detail: 'no probe reads this job — nothing here can tell whether it ran' }
  if (job.state === 'stale') return { state: 'attention', detail: job.detail }
  if (job.state === 'unknown') return { state: 'unknown', detail: job.detail }
  return { state: 'ok', detail: job.detail }
}

// Over budget is its own finding, separate from freshness: the curate hook was
// graded ok through the whole 2026-10 incident while it spent $80 a
// week curating its own transcripts. The row has one verdict, so a breach
// raises it to 'attention' and the freshness sentence stays in the detail;
// JobFreshness.state itself is never touched, and runRecordWarnings still keys
// on the freshness grade (a current job's scheduler record says nothing).
function withSpend(graded: { state: GlobalItemState; detail: string }, job: JobFreshness | undefined) {
  const breach = spendBreach(job?.spend ?? null)
  if (!breach) return graded
  return { state: 'attention' as const, detail: `${breach}; ${graded.detail}` }
}

// Human trigger text from the task's own schedule. Task Scheduler's trigger
// objects don't survive the pipe-delimited query, so this reads the next run
// rather than inventing a cadence it did not check.
function triggerText(row: ScheduledTaskRow): string {
  if (!row.nextRunIso) return 'scheduled'
  const at = new Date(row.nextRunIso)
  return `next ${at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
}

export function scheduledWarnings(row: ScheduledTaskRow): string[] {
  const warnings: string[] = []
  // The linker's 2026-08-23 skip, in one line: asleep at the trigger time means
  // that run never happens and is never retried.
  if (!row.startWhenAvailable && !row.wakeToRun) {
    warnings.push('a run missed while the machine is asleep is never retried')
  }
  if (row.state === 'Disabled') warnings.push('the task is disabled')
  return warnings
}

// Task Scheduler's LastTaskResult in words. Enumerated from the codes these
// jobs actually produce; anything else is reported as its raw code rather than
// glossed, because an unrecognised result is not a success.
export function taskResultText(code: number | null): string | null {
  if (code === null) return null
  switch (code >>> 0) {
    case 0:
    case 0x41300: // SCHED_S_TASK_READY — the normal idle state, not an outcome
      return null
    case 0x41301:
      return 'still running'
    case 0x41303:
      return 'has never run'
    case 0x41306:
      return 'terminated by a stop request'
    case 0x800710e0:
      // What Windows records for a task it killed rather than one that exited:
      // an explicit stop, the task's own execution-time limit, or shutdown.
      return 'terminated rather than finished (0x800710E0 — a stop, its execution-time limit, or the machine shutting down)'
    default:
      return `reported 0x${(code >>> 0).toString(16).toUpperCase()}`
  }
}

function whenText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// What Task Scheduler recorded about the last attempt, joined to what the job's
// own log shows. These are two independent records of the same run and this
// page only ever read one of them.
//
// The scheduler knows whether Windows STARTED the process; the log knows
// whether the process did anything. A stale log alone cannot tell those apart,
// and the vault linker's two missed days are one of each: on 2026-08-22 the
// task started at 04:36 and was terminated (0x800710E0) before it wrote its
// first line, and on 2026-08-23 it never started at all. Both rendered as the
// same sentence — "last output 65.5h ago" — which is the missing record item 12
// of the audit backlog asks for, and it was already on disk.
//
// Only speaks for a row that is already in trouble: on a healthy job the
// scheduler's record adds nothing. `probeLastRunIso` is `undefined` when no
// work probe reads this task at all, `null` when a probe exists but could not
// date a run — the three cases give three different sentences, and none of them
// guesses.
export function runRecordWarnings(
  row: ScheduledTaskRow,
  probeLastRunIso: string | null | undefined,
  troubled: boolean,
): string[] {
  if (!troubled) return []
  if (!row.lastRunIso) return ['Task Scheduler has no record of this task ever starting']

  const startedAt = Date.parse(row.lastRunIso)
  const logged = probeLastRunIso ? Date.parse(probeLastRunIso) : null
  const out: string[] = []
  if (probeLastRunIso === undefined || logged === null || !Number.isFinite(logged)) {
    out.push(`Task Scheduler last started it ${whenText(row.lastRunIso)}`)
  } else if (logged >= startedAt) {
    // Every start the scheduler knows about is accounted for in the log, so the
    // runs that are missing were never launched.
    out.push(`Task Scheduler has not started it since ${whenText(row.lastRunIso)} — the missing runs never began`)
  } else {
    out.push(`Task Scheduler started it ${whenText(row.lastRunIso)} and the log has nothing after that — that run produced no output`)
  }

  // A currently-running task's LastTaskResult belongs to an earlier instance,
  // not to the run named above — attaching it there would date the code wrong.
  const result = row.state === 'Running' ? null : taskResultText(row.lastResult)
  if (result) out.push(`that run: ${result}`)
  return out
}

// ------------------------------------------------------------ the report ---

// Every hook registered in the settings file at `file`, graded on its probe.
export function hookAutomations(file: string, byId: Map<string, JobFreshness>): GlobalAutomation[] {
  const automations: GlobalAutomation[] = []
  let rawSettings: unknown = null
  try {
    rawSettings = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    // No settings.json is no hooks. One that exists but cannot be read or
    // parsed is hooks nobody can list — and a broken file is exactly when every
    // session's hooks are dead — so it is one 'unknown' row, never an absence.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err)
    return [
      {
        id: 'hook:settings-unreadable',
        label: 'Global hooks',
        kind: 'hook',
        trigger: 'settings.json',
        command: '',
        state: 'unknown',
        detail: `could not read ${file}: ${why} — which hooks are registered, and whether any run, is unknown`,
        lastRunIso: null,
        warnings: [],
        taskName: null,
        running: false,
        logId: null,
      },
    ]
  }
  for (const hook of parseHooks(rawSettings)) {
    const scriptPath = hookScriptPath(hook.command)
    const probeId = HOOK_WORK_PROBE.find((h) => hook.command.includes(h.script))?.probe
    const job = probeId ? byId.get(probeId) : undefined
    let state: GlobalItemState
    let detail: string
    if (scriptPath && !fs.existsSync(scriptPath)) {
      // Configured perfectly, dead on every session.
      state = 'attention'
      detail = `the script is not at ${scriptPath} — this hook fails on every session`
    } else {
      const graded = withSpend(stateFromFreshness(job), job)
      state = graded.state
      detail = graded.detail
    }
    automations.push({
      id: `hook:${hook.event}:${scriptPath ?? hook.command}`,
      label: job?.label ?? `${hook.event} hook`,
      kind: 'hook',
      trigger: hook.event,
      command: hook.command,
      state,
      detail,
      lastRunIso: job?.lastRunIso ?? null,
      warnings: [],
      taskName: null,
      running: false,
      logId: probeId ? `log:${probeId}` : null,
    })
  }
  return automations
}

// Every scheduled job: what the scheduler query returned, plus every job a work
// probe expects. Built from the query's rows alone, a failed query or a task
// deleted from Task Scheduler took the job off the page with its probe's verdict.
export function scheduledAutomations(
  rows: ScheduledTaskRow[],
  schedulerError: string | null,
  byId: Map<string, JobFreshness>,
): GlobalAutomation[] {
  const automations: GlobalAutomation[] = []
  for (const row of rows) {
    const probeId = TASK_WORK_PROBE[row.taskName]
    const probe = probeId ? byId.get(probeId) : undefined
    const fresh = stateFromFreshness(probe)
    const { state, detail } = withSpend(fresh, probe)
    automations.push({
      id: `task:${row.taskName}`,
      label: row.taskName,
      kind: 'scheduled',
      trigger: triggerText(row),
      command: '',
      state,
      detail,
      lastRunIso: row.lastRunIso,
      warnings: [
        ...scheduledWarnings(row),
        ...runRecordWarnings(row, probe ? probe.lastRunIso : undefined, fresh.state !== 'ok'),
      ],
      taskName: row.taskName,
      running: row.state === 'Running',
      logId: probeId ? `log:${probeId}` : null,
    })
  }
  const listed = new Set(rows.map((r) => r.taskName))
  for (const [taskName, probeId] of Object.entries(TASK_WORK_PROBE)) {
    if (listed.has(taskName)) continue
    const probe = byId.get(probeId)
    const graded = withSpend(stateFromFreshness(probe), probe)
    // Unreadable scheduler: the job may be fine, but only a stale log can say
    // otherwise. Readable scheduler without the task: it will not run again.
    const state: GlobalItemState = schedulerError ? (graded.state === 'attention' ? 'attention' : 'unknown') : 'attention'
    const why = schedulerError
      ? `Task Scheduler could not be read (${schedulerError})`
      : 'not registered in Task Scheduler, so it will not run'
    automations.push({
      id: `task:${taskName}`,
      label: taskName,
      kind: 'scheduled',
      trigger: schedulerError ? 'schedule unknown' : 'not registered',
      command: '',
      state,
      detail: `${why}; ${graded.detail}`,
      lastRunIso: probe?.lastRunIso ?? null,
      warnings: [],
      taskName: null,
      running: false,
      logId: `log:${probeId}`,
    })
  }
  return automations.sort((a, b) => a.label.localeCompare(b.label))
}

export async function getGlobalConfig(): Promise<GlobalConfigReport> {
  const settings = readSettings()
  const freshness = await getJobFreshness()
  const byId = new Map(freshness.map((j) => [j.id, j]))
  const { rows, error: schedulerError } = await readScheduledTasks()

  // Hooks run inside every session, in every project; scheduled jobs on a timer.
  const automations = [...hookAutomations(settingsPath(), byId), ...scheduledAutomations(rows, schedulerError, byId)]

  // A failed scheduler query is reported as itself as well as on each job's row,
  // so a view can say why every scheduled grade is unknown.
  return {
    generatedAt: new Date().toISOString(),
    automations,
    settings,
    schedulerError,
  }
}

// --------------------------------------------------------------- actions ---

// Start one scheduled job, or restart it if it is already running. The name is
// checked against the live enumeration rather than trusted: the renderer picks
// from what this module listed, it does not get to name a task.
export async function runGlobalTask(taskName: string): Promise<GlobalConfigReport> {
  const { rows, error } = await readScheduledTasks()
  if (error) throw new Error(`could not read Task Scheduler: ${error}`)
  const row = rows.find((r) => r.taskName === taskName)
  if (!row) throw new Error(`unknown scheduled task: ${taskName}`)

  // Stop-then-start, because every one of these tasks is IgnoreNew: starting a
  // running task is a silent no-op, so a "Restart" that only started would lie.
  const script = [
    `Stop-ScheduledTask -TaskName '${row.taskName}' -ErrorAction SilentlyContinue`,
    `Start-ScheduledTask -TaskName '${row.taskName}'`,
  ].join('; ')
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf-8',
    timeout: 60_000,
    windowsHide: true,
  })
  return getGlobalConfig()
}

// Every file this page can open, by id. The enumerator IS the validation
// (electron/resolve-known-path.ts's rule): the renderer sends an id from this
// list, never a path.
export function globalFilePaths(): Record<string, string> {
  const scriptsDir = path.join(process.env.APP_ROOT!, 'scripts')
  return {
    settings: settingsPath(),
    claudemd: path.join(claudeDir(), 'CLAUDE.md'),
    'log:curate': path.join(scriptsDir, 'curate-session.log'),
    'log:recall': path.join(scriptsDir, 'vault-recall.log'),
    'log:drain': path.join(scriptsDir, 'drain-inbox.log'),
    'log:verify': path.join(scriptsDir, 'record-verify.log'),
  }
}

export function openGlobalFile(fileId: string): void {
  const target = globalFilePaths()[fileId]
  if (!target) throw new Error(`unknown global file: ${fileId}`)
  openPathInVSCode(target)
}
