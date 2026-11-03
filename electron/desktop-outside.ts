// Session Desktop: Claude Code's own per-process records and the take-over
// decision. Electron-free.
//
// Claude Code writes ~/.claude/sessions/<pid>.json for every running process:
// {pid, sessionId, cwd, startedAt, procStart, kind, entrypoint, name, status,
// updatedAt, ...}. The format is internal and undocumented, so every field is
// checked and anything unexpected skips the entry (or reads as status
// 'unknown'). The <pid>.<hash>.key files beside them are never opened.
//
// procStart is the process's creation time as a Windows FILETIME (100ns ticks
// since 1601). Measured 2026-10-18: a live claude.exe's procStart equalled
// Win32_Process.CreationDate.ToFileTimeUtc() exactly.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { DesktopTargetRef, OutsideSession, RegistryEntry } from '../shared/ipc-types.ts'

// CLAUDE_HUB_CLAUDE_HOME replaces ~/.claude (tests only): the real session
// records and transcripts are never touched by a test.
export function claudeHome(): string {
  return process.env.CLAUDE_HUB_CLAUDE_HOME ?? path.join(os.homedir(), '.claude')
}

// CLAUDE_HUB_SESSIONS_DIR moves only the per-process records: a demo
// screenshot points it at an empty folder so the machine's other running
// sessions stay off the picture, while transcripts are still found.
export const claudeSessionsDir = () => process.env.CLAUDE_HUB_SESSIONS_DIR ?? path.join(claudeHome(), 'sessions')
export const claudeProjectsDir = () => path.join(claudeHome(), 'projects')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value)

// One Claude Code process, as its record describes it.
export interface ClaudeProcess {
  pid: number
  sessionId: string
  cwd: string
  name: string
  procStart: string | null // FILETIME digits; null = absent or malformed
  interactive: boolean // kind 'interactive' and entrypoint 'cli' (not a headless `claude -p`)
  status: OutsideSession['status']
  // Set only while status is 'waiting': what it waits on, in Claude Code's
  // words ("approve Bash: npm test", "input needed", "dialog open").
  waitingFor: string | null
  updatedAtIso: string | null
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const RECORD_FILE = /^(\d+)\.json$/

// null = not a usable record (malformed, or its pid disagrees with its file name).
export function parseClaudeRecord(text: string, fileName: string): ClaudeProcess | null {
  const filePid = RECORD_FILE.exec(fileName)?.[1]
  if (!filePid) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const { pid, sessionId, cwd } = raw
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || String(pid) !== filePid) return null
  if (!isUuid(sessionId) || typeof cwd !== 'string' || cwd.length === 0) return null
  // 'waiting' (Claude Code 2.1.316, measured 2026-11-02): a dialog blocks the
  // turn (a permission prompt, AskUserQuestion), named by waitingFor.
  const status =
    raw.status === 'idle' || raw.status === 'busy' || raw.status === 'shell' || raw.status === 'waiting' ? raw.status : 'unknown'
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? new Date(raw.updatedAt) : null
  return {
    pid: pid as number,
    sessionId,
    cwd,
    name: typeof raw.name === 'string' ? raw.name : '',
    procStart: typeof raw.procStart === 'string' && /^\d{1,20}$/.test(raw.procStart) ? raw.procStart : null,
    interactive: raw.kind === 'interactive' && raw.entrypoint === 'cli',
    status,
    waitingFor: status === 'waiting' && typeof raw.waitingFor === 'string' && raw.waitingFor ? raw.waitingFor : null,
    updatedAtIso: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.toISOString() : null,
  }
}

export type ClaudeProcessRead = { ok: true; processes: ClaudeProcess[]; error: string | null } | { ok: false; error: string }

// The live processes' records. A folder that can't be listed is an error
// (never "none running"); a record of a live pid that can't be read or parsed
// is skipped and counted in `error`, since the list is then short.
export function readClaudeProcesses(dir: string, alive: (pid: number) => boolean): ClaudeProcessRead {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch (err) {
    return { ok: false, error: `Couldn't read Claude Code's session records (${dir}): ${(err as Error).message}` }
  }
  const processes: ClaudeProcess[] = []
  let unreadable = 0
  for (const entry of entries) {
    const pid = RECORD_FILE.exec(entry)?.[1]
    if (!pid || !alive(Number(pid))) continue
    let text: string
    try {
      text = fs.readFileSync(path.join(dir, entry), 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable += 1 // ENOENT: it exited meanwhile
      continue
    }
    const parsed = parseClaudeRecord(text, entry)
    if (parsed) processes.push(parsed)
    else unreadable += 1
  }
  const error = unreadable > 0 ? `${unreadable} running Claude Code session record(s) couldn't be read, so the list may be short` : null
  return { ok: true, processes, error }
}

// Case-insensitive, separator- and trailing-slash-agnostic.
export function normalizePath(p: string): string {
  return path.win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase()
}

// A folder's target: a registered project, else a sandbox experiment, by
// exact path. Anything else is null: the desktop never launches in a folder
// it doesn't know.
export function targetForCwd(cwd: string, projects: RegistryEntry[], experimentPaths: string[]): { target: DesktopTargetRef; name: string } | null {
  const want = normalizePath(cwd)
  const project = projects.find((p) => normalizePath(p.path) === want)
  if (project) return { target: { kind: 'project', key: project.id }, name: project.name }
  const experiment = experimentPaths.find((p) => normalizePath(p) === want)
  if (experiment) return { target: { kind: 'experiment', key: path.win32.basename(experiment) }, name: path.win32.basename(experiment) }
  return null
}

// A target's folder and display name. Experiments match by folder name only
// against the enumerated list, so no renderer string becomes a path.
export function resolveTargetIn(target: DesktopTargetRef, projects: RegistryEntry[], experimentPaths: string[]): { path: string; name: string } {
  if (target.kind === 'project') {
    const project = projects.find((p) => p.id === target.key)
    if (!project) throw new Error(`No registered project with id "${target.key}"`)
    return { path: project.path, name: project.name }
  }
  const experiment = experimentPaths.find((p) => path.win32.basename(p) === target.key)
  if (!experiment) throw new Error(`No sandbox experiment named "${target.key}"`)
  return { path: experiment, name: target.key }
}

export function toOutsideSession(proc: ClaudeProcess, projects: RegistryEntry[], experimentPaths: string[]): OutsideSession {
  const mapped = targetForCwd(proc.cwd, projects, experimentPaths)
  return {
    pid: proc.pid,
    sessionId: proc.sessionId,
    name: proc.name,
    cwd: proc.cwd,
    target: mapped?.target ?? null,
    targetName: mapped?.name ?? null,
    status: proc.status,
    updatedAtIso: proc.updatedAtIso,
  }
}

// ---- Take-over -----------------------------------------------------------

// What Windows says about a pid and its parent (queryProcess).
export interface ProcessFacts {
  pid: number
  name: string
  created: string // FILETIME digits
  parent: { pid: number; name: string; created: string; commandLine: string } | null
}

// The cmd.exe a shortcut or launcher wraps claude in ("cmd /k claude",
// "cmd.exe /c C:\...\claude.exe --resume ..."). Killing it ends the terminal
// tab with the session instead of dropping back to a prompt.
export function isClaudeWrapper(commandLine: string): boolean {
  return /^\s*"?(?:[^"]*[\\/])?cmd(?:\.exe)?"?\s+(?:\/[a-z]\s+)*\/[kc]\s+"?(?:[^"\s]*[\\/])?claude(?:\.exe|\.cmd)?\b/i.test(commandLine)
}

const START_SLACK = 20_000_000n // 2s in FILETIME ticks

export type TakeOverDecision = { close: true; killPid: number; viaWrapper: boolean } | { close: false; note: string }

export const FORK = 'the conversation continues here as a fork.'

// Close only a process proven to be the one the record describes (claude.exe,
// same start time, so not a recycled pid) and only while it waits for a
// prompt. Every other case leaves it running and forks, and says why.
export function decideTakeOver(input: {
  closeOld: boolean
  status: OutsideSession['status']
  procStart: string | null
  facts: ProcessFacts | null
  factsError: string | null
}): TakeOverDecision {
  const { closeOld, status, procStart, facts } = input
  if (!closeOld) return { close: false, note: `You chose to leave it running; ${FORK}` }
  if (status === 'busy') return { close: false, note: `It was busy, so it's still running; ${FORK}` }
  if (status === 'shell') return { close: false, note: `It was running a shell command, so it's still running; ${FORK}` }
  if (status === 'waiting') return { close: false, note: `It was waiting on a prompt mid-turn, so it's still running; ${FORK}` }
  if (status !== 'idle') return { close: false, note: `Its state couldn't be read, so it was left running; ${FORK}` }
  if (!facts) return { close: false, note: `Couldn't inspect the process (${input.factsError ?? 'not found'}), so it was left running; ${FORK}` }
  if (facts.name.toLowerCase() !== 'claude.exe') return { close: false, note: `Process ${facts.pid} is ${facts.name}, not claude.exe, so it was left alone; ${FORK}` }
  if (!procStart || absDiff(BigInt(facts.created), BigInt(procStart)) > START_SLACK) {
    return { close: false, note: `Process ${facts.pid} didn't start when Claude Code's record says, so it may not be that session; it was left alone and ${FORK}` }
  }
  const parent = facts.parent
  const viaWrapper = !!parent && parent.name.toLowerCase() === 'cmd.exe' && isClaudeWrapper(parent.commandLine) && BigInt(parent.created) <= BigInt(facts.created)
  return { close: true, killPid: viaWrapper ? parent!.pid : facts.pid, viaWrapper }
}

const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a)

export function parseProcessFacts(stdout: string, pid: number): ProcessFacts | null {
  const raw = JSON.parse(stdout.trim() || 'null') as Record<string, unknown> | null
  if (!raw || typeof raw.name !== 'string' || typeof raw.created !== 'string' || !/^\d+$/.test(raw.created)) return null
  const p = raw.parent as Record<string, unknown> | null
  const parent =
    p && Number.isSafeInteger(p.pid) && typeof p.name === 'string' && typeof p.created === 'string' && /^\d+$/.test(p.created)
      ? { pid: p.pid as number, name: p.name, created: p.created, commandLine: typeof p.commandLine === 'string' ? p.commandLine : '' }
      : null
  return { pid, name: raw.name, created: raw.created, parent }
}

function run(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message))
      else resolve(String(stdout))
    })
  })
}

const assertPid = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Not a process id')
}

// Only the validated integer reaches the script. null = no such process.
export async function queryProcess(pid: number): Promise<ProcessFacts | null> {
  assertPid(pid)
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'`,
    `if (-not $p) { 'null'; exit }`,
    `$q = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$p.ParentProcessId)`,
    `$parent = $null`,
    `if ($q) { $parent = @{ pid = [int]$q.ProcessId; name = [string]$q.Name; created = [string]$q.CreationDate.ToFileTimeUtc(); commandLine = [string]$q.CommandLine } }`,
    `@{ name = [string]$p.Name; created = [string]$p.CreationDate.ToFileTimeUtc(); parent = $parent } | ConvertTo-Json -Compress`,
  ].join('; ')
  return parseProcessFacts(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 15_000), pid)
}

export async function killTree(pid: number): Promise<void> {
  assertPid(pid)
  await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 10_000)
}
