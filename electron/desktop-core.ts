// Session Desktop, main-process side: the client of the detached pty host
// (desktop-host.ts), the session records, and the per-session state the
// renderer shows. Electron-free; electron/desktop.ts wires its events to the
// window. Records: <APP_ROOT>/desktop-sessions.json. Running host:
// %LOCALAPPDATA%\claude-hub\desktop-host-<APP_ROOT hash>.json ({pid, pipe, token}).
//
// The host is spawned only by create/resume. Otherwise this module just
// reattaches to a host that is already running, which is how sessions
// survive a hub restart. Quitting the app closes the pipe and nothing else.
//
// CLAUDE_HUB_DESKTOP_PASSIVE=1 (scripts/screenshot-app.mjs): attach and show,
// never change anything. Resizes are dropped (an offscreen window's tiles would
// otherwise resize the user's real sessions) and every action is refused.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { listProjects } from './registry.ts'
import { listExperimentPaths } from './sandbox.ts'
import { findSessionDirs, scanSessionDirs } from './status.ts'
import { isHeadlessTranscript, readJsonlHead, readActivityTail } from './live-core.ts'
import { LineDecoder, encode, type ClientRequest, type HostEvent, type HostInfo, type HostMessage, type HostReply } from './desktop-protocol.ts'
import {
  assignSlot,
  deriveDesktopState,
  feedTypedLine,
  isClearCommand,
  loadRecords,
  lowestFreeSlot,
  resumeRefusal,
  saveRecords,
  startsWithClear,
  validateColor,
  validateName,
  validateSlot,
  validateTarget,
  type DesktopRecord,
  type TranscriptRead,
} from './desktop-model.ts'
import {
  FORK,
  claudeProjectsDir,
  claudeSessionsDir,
  decideTakeOver,
  isUuid,
  killTree,
  parseClaudeRecord,
  pidAlive,
  queryProcess,
  readClaudeProcesses,
  resolveTargetIn,
  targetForCwd,
  toOutsideSession,
  type ClaudeProcess,
  type ProcessFacts,
} from './desktop-outside.ts'
import { buildLaunchTargets, findTargetTranscript, type LaunchTarget } from './desktop-targets.ts'
import { planBoundaryLaunch } from './project-config.ts'
import type {
  DesktopColor,
  DesktopLaunchSpec,
  DesktopLaunchTargets,
  DesktopScreen,
  DesktopSession,
  DesktopSnapshot,
  DesktopTargetRef,
  DesktopTerminalChunk,
  LaunchTier,
  RegistryEntry,
  TakeOverResult,
} from '../shared/ipc-types.ts'

const POLL_MS = 3_000
// A session's tile refreshes this long after its output goes quiet, so a turn
// ending shows at once instead of on the next poll.
const QUIET_REFRESH_MS = 400
const HOST_START_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 3_000
const REQUEST_TIMEOUT_MS = 5_000
const RECONNECT_DELAY_MS = 250
const CLOSE_WAIT_MS = 5_000
// How long after a submitted /clear its new transcript is looked for.
const CLEAR_BIND_WINDOW_MS = 60_000
// A new session's size until the renderer mounts its terminal and resizes it.
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

const recordsPath = () => path.join(process.env.APP_ROOT!, 'desktop-sessions.json')

// The pipe + token give full control of a claude running as the user, so they
// live in the user's own LOCALAPPDATA, not the repo folder (which grants Users
// read). One file per APP_ROOT: a worktree build keeps its own records, so it
// must never attach to the main checkout's host.
export function hostInfoPath(): string {
  const root = path.resolve(process.env.APP_ROOT!).toLowerCase()
  const tag = createHash('sha256').update(root).digest('hex').slice(0, 12)
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'claude-hub', `desktop-host-${tag}.json`)
}

// LOCALAPPDATA isn't reliably owner-only (measured on this machine: a
// CodexSandboxUsers group inherits read on all of it), so the folder drops
// inheritance and grants only the user and SYSTEM. Throws if it can't: no
// host is started with a token others can read.
function restrictInfoDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  if (process.platform !== 'win32') return
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username
  try {
    execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' })
  } catch (err) {
    throw new Error(`Couldn't restrict ${dir} to your account, so the session host wasn't started: ${(err as Error).message}`)
  }
}

const passive = () => process.env.CLAUDE_HUB_DESKTOP_PASSIVE === '1'

function refuseIfPassive(): void {
  if (passive()) throw new Error('The session desktop is read-only here (screenshot mode)')
}

// ---- Events --------------------------------------------------------------

const snapshotListeners = new Set<(snapshot: DesktopSnapshot) => void>()
const dataListeners = new Set<(chunk: DesktopTerminalChunk) => void>()

export function onDesktopSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void {
  snapshotListeners.add(listener)
  return () => snapshotListeners.delete(listener)
}

export function onDesktopData(listener: (chunk: DesktopTerminalChunk) => void): () => void {
  dataListeners.add(listener)
  return () => dataListeners.delete(listener)
}

// ---- Host connection -----------------------------------------------------

// The host answered and said no (ok: false), so it did nothing; any other
// request failure (timeout, closed pipe) leaves what it did unknown.
class HostRefusal extends Error {}

interface HostConnection {
  pid: number
  // onOk runs synchronously as the reply is parsed, before any event that
  // arrived in the same chunk, so a create can mark its session live before
  // that session's exit event is handled.
  request(message: ClientRequest, onOk?: (reply: HostReply & { ok: true }) => void): Promise<HostReply & { ok: true }>
  close(): void
}

function connectHost(info: HostInfo, onEvent: (event: HostEvent) => void, onClose: () => void): Promise<HostConnection> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(info.pipe)
    socket.setEncoding('utf8')
    const decoder = new LineDecoder()
    type Pending = { resolve: (r: HostReply & { ok: true }) => void; reject: (e: Error) => void; onOk?: (r: HostReply & { ok: true }) => void; timer: NodeJS.Timeout }
    const pending = new Map<number, Pending>()
    let nextRid = 1
    let welcomed = false
    let closedByUs = false
    const connectTimer = setTimeout(() => {
      socket.destroy()
      reject(new Error('the desktop host did not answer'))
    }, CONNECT_TIMEOUT_MS)

    const connection: HostConnection = {
      pid: info.pid,
      request(message, onOk) {
        return new Promise((res, rej) => {
          if (socket.destroyed) return rej(new Error('The desktop host connection is closed'))
          const rid = nextRid++
          const timer = setTimeout(() => {
            pending.delete(rid)
            rej(new Error('The desktop host did not reply in time'))
          }, REQUEST_TIMEOUT_MS)
          pending.set(rid, { resolve: res, reject: rej, onOk, timer })
          socket.write(encode({ ...message, rid }))
        })
      },
      close() {
        closedByUs = true
        socket.destroy()
      },
    }

    socket.on('connect', () => socket.write(encode({ t: 'hello', token: info.token })))
    socket.on('data', (chunk: string) => {
      let messages: unknown[]
      try {
        messages = decoder.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const raw of messages) {
        const msg = raw as HostMessage
        if (msg.t === 'welcome') {
          welcomed = true
          clearTimeout(connectTimer)
          resolve(connection)
        } else if (msg.t === 'reply') {
          const p = pending.get(msg.rid)
          if (!p) continue
          pending.delete(msg.rid)
          clearTimeout(p.timer)
          if (msg.ok) {
            p.onOk?.(msg)
            p.resolve(msg)
          } else {
            p.reject(new HostRefusal(msg.error))
          }
        } else {
          onEvent(msg)
        }
      }
    })
    socket.on('error', (err) => {
      if (!welcomed) {
        clearTimeout(connectTimer)
        reject(err)
      }
    })
    socket.on('close', () => {
      clearTimeout(connectTimer)
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('The desktop host connection closed'))
      }
      pending.clear()
      if (!welcomed) reject(new Error('the desktop host refused the connection'))
      else if (!closedByUs) onClose()
    })
  })
}

type InfoRead = { kind: 'none' } | { kind: 'error'; error: string } | { kind: 'ok'; info: HostInfo }

function readHostInfo(): InfoRead {
  let text: string
  try {
    text = fs.readFileSync(hostInfoPath(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' }
    return { kind: 'error', error: `Can't read ${hostInfoPath()}: ${(err as Error).message}` }
  }
  try {
    const info = JSON.parse(text) as HostInfo
    if (Number.isInteger(info.pid) && typeof info.pipe === 'string' && typeof info.token === 'string') return { kind: 'ok', info }
  } catch {
    // fall through
  }
  return { kind: 'error', error: `${hostInfoPath()} is malformed` }
}

// Remove an info file whose host is gone, unless a new host has rewritten it since.
function removeStaleInfo(stale: HostInfo): void {
  const now = readHostInfo()
  if (now.kind === 'ok' && now.info.pid === stale.pid && now.info.pipe === stale.pipe) fs.rmSync(hostInfoPath(), { force: true })
}

let config: { hostScript: string; execPath: string } | null = null
let conn: HostConnection | null = null
let connecting: Promise<void> | null = null
let starting = false
// Why the host is down, when it is. 'absent' = no host process (sessions are
// exited); 'unreachable' = a host process exists but can't be talked to (no
// claim about its sessions can be made).
let hostDown: { kind: 'absent' } | { kind: 'unreachable'; error: string } = { kind: 'absent' }
// A host this module let go of because none of its sessions was alive. The
// host stays up while any client is connected, so holding the pipe open would
// keep it alive forever; let go, it idles out. The poll doesn't reattach to
// it (it has no live session to show); create/resume still use it.
let releasedPid: number | null = null
// Alive sessions on the host: the pty's pid (null from a host too old to say)
// and the on-screen prompt state.
const live = new Map<string, { pid: number | null; prompting: boolean; line: string | null }>()
// Callers waiting for a session's exit event (closeDesktopSession).
const exitWaiters = new Map<string, Set<() => void>>()
// Per session: refresh once its output has been quiet for QUIET_REFRESH_MS.
const quietTimers = new Map<string, NodeJS.Timeout>()

// `live` is filled from the host's list on attach and from create replies. A
// create whose reply timed out, or a session another hub instance started,
// would otherwise run unseen: shown exited, forgettable, then reaped as an
// orphan on the next attach. So an event for an unknown id, the poll before
// letting go of the host, and forget re-read the host's list. Resolves false
// when it couldn't.
let reconciling: Promise<boolean> | null = null
function reconcile(): Promise<boolean> {
  const connection = conn
  if (!connection) return Promise.resolve(false)
  reconciling ??= connection
    .request({ t: 'list' })
    .then((reply) => {
      if (conn !== connection) return false
      for (const s of reply.sessions ?? []) if (!live.has(s.id)) live.set(s.id, { pid: hostPid(s.pid), prompting: s.prompting, line: s.line })
      return true
    })
    .catch(() => false)
    .finally(() => {
      reconciling = null
      scheduleRefresh()
    })
  return reconciling
}

function handleEvent(event: HostEvent): void {
  if (event.t === 'data') {
    if (!live.has(event.id)) void reconcile()
    const chunk = { id: event.id, seq: event.seq, data: event.d }
    for (const listener of dataListeners) listener(chunk)
    clearTimeout(quietTimers.get(event.id))
    quietTimers.set(
      event.id,
      setTimeout(() => {
        quietTimers.delete(event.id)
        scheduleRefresh()
      }, QUIET_REFRESH_MS),
    )
  } else if (event.t === 'prompting') {
    const current = live.get(event.id)
    if (current) live.set(event.id, { ...current, prompting: event.prompting, line: event.line })
    else void reconcile()
    scheduleRefresh()
  } else if (event.t === 'exit') {
    live.delete(event.id)
    typed.delete(event.id)
    clearTimeout(quietTimers.get(event.id))
    quietTimers.delete(event.id)
    // Through the same queue as create, so the record exists by then, and
    // queued before the waiters run, so a forget right after close sees it.
    if (!passive()) {
      void serial(async () => {
        const loaded = loadRecords(recordsPath())
        if (!loaded.ok || !loaded.records.some((r) => r.id === event.id)) return
        saveRecords(recordsPath(), loaded.records.map((r) => (r.id === event.id ? { ...r, exitCode: event.code } : r)))
      }).finally(scheduleRefresh)
    } else {
      scheduleRefresh()
    }
    const waiters = exitWaiters.get(event.id)
    exitWaiters.delete(event.id)
    for (const done of waiters ?? []) done()
  }
}

function waitForExit(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const waiters = exitWaiters.get(id) ?? new Set()
    exitWaiters.set(id, waiters)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      waiters.delete(done)
      if (waiters.size === 0) exitWaiters.delete(id)
      reject(new Error(`Asked the session to close, but it hadn't exited after ${CLOSE_WAIT_MS / 1000}s; it may still be running`))
    }, CLOSE_WAIT_MS)
    waiters.add(done)
  })
}

function handleClose(): void {
  conn = null
  live.clear()
  hostDown = { kind: 'unreachable', error: 'Lost the connection to the desktop host; reconnecting' }
  scheduleRefresh()
  // One quick retry; after that the poll retries every POLL_MS.
  setTimeout(() => void attach(false).then(scheduleRefresh), RECONNECT_DELAY_MS)
}

// A live host session with no record can only be the leftover of a create
// that failed after the host started it (the record is written first and
// removed on failure). Nobody can see or close it, so it is killed. A missing
// file is not "no records": every create writes it first, so with sessions on
// the host it was removed, and which are ours is unknown.
function reapOrphans(connection: HostConnection): void {
  if (passive()) return
  const loaded = loadRecords(recordsPath())
  if (!loaded.ok || loaded.missing) return // can't tell which are ours
  const known = new Set(loaded.records.map((r) => r.id))
  for (const id of live.keys()) {
    if (known.has(id)) continue
    console.warn(`[desktop] killing host session ${id}: it has no record (left over from a failed create)`)
    connection.request({ t: 'kill', id }).catch((err: unknown) => console.warn(`[desktop] couldn't kill orphan ${id}: ${(err as Error).message}`))
  }
}

async function open(info: HostInfo): Promise<void> {
  const connection = await connectHost(info, handleEvent, handleClose)
  try {
    const reply = await connection.request({ t: 'list' })
    live.clear()
    for (const s of reply.sessions ?? []) live.set(s.id, { pid: hostPid(s.pid), prompting: s.prompting, line: s.line })
  } catch (err) {
    connection.close()
    throw err
  }
  conn = connection
  releasedPid = null
  reapOrphans(connection)
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const hostPid = (pid: unknown): number | null => (Number.isSafeInteger(pid) && (pid as number) > 0 ? (pid as number) : null)

async function doAttach(spawnIfAbsent: boolean): Promise<void> {
  const current = readHostInfo()
  if (current.kind === 'error') {
    hostDown = { kind: 'unreachable', error: current.error }
    return
  }
  if (current.kind === 'ok' && !spawnIfAbsent && current.info.pid === releasedPid) {
    hostDown = { kind: 'absent' }
    return
  }
  if (current.kind === 'ok' && pidAlive(current.info.pid)) {
    try {
      await open(current.info)
      return
    } catch (err) {
      // Pipe names are random per host, so a missing pipe means the host is
      // gone and its pid was recycled. Anything else (refused, timed out)
      // leaves a host that may hold live sessions: no claim either way.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        hostDown = { kind: 'unreachable', error: `The desktop host (pid ${current.info.pid}) is running but unreachable: ${(err as Error).message}` }
        return
      }
      removeStaleInfo(current.info)
    }
  }
  hostDown = { kind: 'absent' }
  if (!spawnIfAbsent) return
  if (!config) throw new Error('Session Desktop is not initialised')
  restrictInfoDir(path.dirname(hostInfoPath()))
  starting = true
  scheduleRefresh()
  try {
    // Started detached under ELECTRON_RUN_AS_NODE; --launch makes it re-spawn
    // itself so its parent is dead and no tree-kill of the app reaches it.
    // CLAUDE_HUB_DESKTOP_IDLE_MS: tests only, like CLAUDE_HUB_DESKTOP_EXE.
    const idle = process.env.CLAUDE_HUB_DESKTOP_IDLE_MS ? ['--idle-ms', process.env.CLAUDE_HUB_DESKTOP_IDLE_MS] : []
    // CLAUDE_HUB_DESKTOP_DIRECT_HOST=1: tests only. Under node.exe (a console
    // program) every detached spawn gets its own console, which Windows
    // Terminal, as the default console, opens as a visible window that takes
    // focus (measured: ~9 per test run). A plain child shares the test's hidden
    // console and dies with it. electron.exe opens no console either way.
    const direct = process.env.CLAUDE_HUB_DESKTOP_DIRECT_HOST === '1'
    spawn(config.execPath, [config.hostScript, '--info', hostInfoPath(), ...idle, ...(direct ? [] : ['--launch'])], {
      detached: !direct,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).unref()
    const stalePid = current.kind === 'ok' ? current.info.pid : null
    let lastError = 'it never wrote its info file'
    for (const deadline = Date.now() + HOST_START_TIMEOUT_MS; Date.now() < deadline; ) {
      await delay(100)
      const next = readHostInfo()
      if (next.kind !== 'ok' || next.info.pid === stalePid || !pidAlive(next.info.pid)) continue
      try {
        await open(next.info)
        return
      } catch (err) {
        lastError = (err as Error).message
      }
    }
    hostDown = { kind: 'unreachable', error: `The desktop host didn't start within ${HOST_START_TIMEOUT_MS / 1000}s: ${lastError}` }
  } finally {
    starting = false
  }
}

// Connect to the running host, or with spawnIfAbsent start one. Resolves
// whether it's connected; the reason it isn't is in hostDown.
async function attach(spawnIfAbsent: boolean): Promise<boolean> {
  while (!conn) {
    if (connecting) {
      await connecting
      if (conn || !spawnIfAbsent) break
      continue
    }
    connecting = doAttach(spawnIfAbsent).finally(() => {
      connecting = null
    })
    await connecting
    break
  }
  return conn !== null
}

async function requireHost(): Promise<HostConnection> {
  if (await attach(true)) return conn!
  throw new Error(hostDown.kind === 'unreachable' ? hostDown.error : 'The desktop host is not running')
}

function connected(): HostConnection {
  if (conn) return conn
  throw new Error(hostDown.kind === 'unreachable' ? hostDown.error : 'The desktop host is not running')
}

// ---- Records -------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve()
let queued = 0

// Record mutations and the host calls they depend on run one at a time, so
// two creates can't take the same slot.
function serial<T>(fn: () => Promise<T>): Promise<T> {
  queued += 1
  const run = chain.then(fn, fn).finally(() => {
    queued -= 1
  })
  chain = run.catch(() => undefined)
  return run
}

function requireRecords(): DesktopRecord[] {
  const loaded = loadRecords(recordsPath())
  if (!loaded.ok) throw new Error(loaded.error)
  return loaded.records
}

function findRecord(records: DesktopRecord[], id: string): DesktopRecord {
  const record = records.find((r) => r.id === id)
  if (!record) throw new Error('No such desktop session')
  return record
}

// Sessions written to the records file whose host create hasn't answered yet;
// left out of snapshots so they never flash up as "exited".
const creating = new Set<string>()
// Sessions shown in their own window (desktop.ts owns the windows).
const popped = new Set<string>()

// ---- /clear rebinding ----------------------------------------------------

// The line being typed into each session (feedTypedLine), and the sessions
// that submitted /clear, by when. /clear makes Claude Code start a new
// transcript (new session id) in the same process; without rebinding, state
// and context would read the frozen old file and Resume would reopen the
// pre-clear conversation. Held in memory: a hub restart inside the window
// only loses the rebind, never a record.
const typed = new Map<string, string>()
const clearPending = new Map<string, number>()

// The transcript a /clear started: born after the /clear was submitted (2s of
// slack for clock granularity), not any record's, not a headless run, and
// opening with the /clear command line.
function findClearedTranscript(folder: string, sinceMs: number, taken: Set<string>): string | null {
  let best: { id: string; born: number } | null = null
  for (const dir of findSessionDirs(folder, claudeProjectsDir())) {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.jsonl')) continue
      const id = entry.slice(0, -'.jsonl'.length)
      if (taken.has(id)) continue
      const file = path.join(dir, entry)
      try {
        const born = fs.statSync(file).birthtimeMs
        if (born < sinceMs - 2_000 || (best && born <= best.born)) continue
        if (isHeadlessTranscript(file) || !startsWithClear(readJsonlHead(file))) continue
        best = { id, born }
      } catch {
        continue // deleted between readdir and read
      }
    }
  }
  return best?.id ?? null
}

function bindClearedSessions(): Promise<void> {
  if (clearPending.size === 0 || passive()) return Promise.resolve()
  return serial(async () => {
    const loaded = loadRecords(recordsPath())
    if (!loaded.ok) return
    let places: Places
    try {
      places = readPlaces()
    } catch {
      return // retried next poll, until the window closes
    }
    let records = loaded.records
    let changed = false
    const now = Date.now()
    for (const [id, since] of clearPending) {
      const record = records.find((r) => r.id === id)
      let found: string | null = null
      try {
        if (record) found = findClearedTranscript(resolveTargetIn(record.target, places.projects, places.experiments ?? []).path, since, new Set(records.map((r) => r.claudeSessionId)))
      } catch {
        // unreadable session folder or target: retried next poll
      }
      if (found) {
        records = records.map((r) => (r.id === id ? { ...r, claudeSessionId: found } : r))
        changed = true
        clearPending.delete(id)
      } else if (!record || now - since > CLEAR_BIND_WINDOW_MS) {
        clearPending.delete(id)
      }
    }
    if (changed) {
      saveRecords(recordsPath(), records)
      scheduleRefresh()
    }
  })
}

// ---- Snapshot ------------------------------------------------------------

// Where sessions can run. experiments null = the sandbox couldn't be listed:
// an experiment session then reads as unknown, never as gone.
interface Places {
  projects: RegistryEntry[]
  experiments: string[] | null
  experimentsError: string | null
}

// Throws only when the registry can't be read.
function readPlaces(): Places {
  const projects = listProjects()
  try {
    return { projects, experiments: listExperimentPaths(), experimentsError: null }
  } catch (err) {
    return { projects, experiments: null, experimentsError: `Couldn't list the sandbox experiments: ${(err as Error).message}` }
  }
}

type ScanCache = Map<string, ReturnType<typeof scanSessionDirs>>

// What one snapshot reads once and every session shares.
interface SnapshotContext {
  places: Places
  cache: ScanCache // one session-folder scan per target folder
  claude: Map<number, ClaudeProcess> // Claude Code's records of live processes, by pid
}

function sessionDirsFor(folder: string, cache: ScanCache) {
  let scan = cache.get(folder)
  if (!scan) {
    scan = scanSessionDirs(folder, claudeProjectsDir())
    cache.set(folder, scan)
  }
  return scan
}

function targetFolder(target: DesktopTargetRef, places: Places): string | null {
  try {
    return resolveTargetIn(target, places.projects, places.experiments ?? []).path
  } catch {
    return null
  }
}

function targetName(target: DesktopTargetRef, places: Places): string {
  if (target.kind === 'experiment') return target.key
  return places.projects.find((p) => p.id === target.key)?.name ?? '(project no longer registered)'
}

function readTranscript(record: DesktopRecord, folder: string | null, cache: ScanCache): TranscriptRead {
  if (!folder) return { kind: 'unreadable' }
  try {
    for (const dir of sessionDirsFor(folder, cache).dirs) {
      const file = path.join(dir, `${record.claudeSessionId}.jsonl`)
      if (fs.existsSync(file)) return { kind: 'lines', lines: readActivityTail(file) }
    }
    return { kind: 'missing' }
  } catch {
    return { kind: 'unreadable' }
  }
}

function toSession(record: DesktopRecord, ctx: SnapshotContext): DesktopSession {
  const hostUnreachable = !conn && hostDown.kind === 'unreachable'
  const alive = conn !== null && live.has(record.id)
  const onScreen = live.get(record.id)
  const claude = onScreen?.pid != null ? ctx.claude.get(onScreen.pid) : undefined
  const derived = deriveDesktopState({
    alive,
    hostUnreachable,
    prompt: onScreen?.prompting ? { line: onScreen.line } : null,
    transcript: readTranscript(record, targetFolder(record.target, ctx.places), ctx.cache),
    claudeStatus: claude?.status ?? null,
    claudeWaitingFor: claude?.waitingFor ?? null,
  })
  return { ...record, targetName: targetName(record.target, ctx.places), poppedOut: popped.has(record.id), tier: record.tier ?? null, alive, ...derived }
}

// Interactive Claude Code processes that aren't desktop sessions (neither a
// host pty's pid nor a running record's conversation), from Claude Code's own
// per-process records; plus every live record by pid, for the desktop's own
// sessions' status. A process on an exited record's conversation is another
// terminal holding it, so it is listed (resume refuses it; take it over). With
// the host unreachable no record is known exited, so none is listed.
function readOutside(records: DesktopRecord[], places: Places): { outside: DesktopSnapshot['outside']; claude: Map<number, ClaudeProcess> } {
  const read = readClaudeProcesses(claudeSessionsDir(), pidAlive)
  if (!read.ok) return { outside: { sessions: null, error: read.error }, claude: new Map() }
  const ownPids = new Set<number>()
  for (const s of live.values()) if (s.pid !== null) ownPids.add(s.pid)
  const unknown = !conn && hostDown.kind === 'unreachable'
  const ownIds = new Set(records.filter((r) => unknown || live.has(r.id)).map((r) => r.claudeSessionId))
  const sessions = read.processes
    .filter((p) => p.interactive && !ownPids.has(p.pid) && !ownIds.has(p.sessionId))
    .map((p) => toOutsideSession(p, places.projects, places.experiments ?? []))
    .sort((a, b) => (b.updatedAtIso ?? '').localeCompare(a.updatedAtIso ?? '') || a.pid - b.pid)
  const errors: string[] = []
  if (read.error) errors.push(read.error)
  if (places.experiments === null && sessions.some((s) => s.target === null)) errors.push(`${places.experimentsError}, so a session in an experiment shows as an unknown folder`)
  return { outside: { sessions, error: errors.length > 0 ? errors.join('; ') : null }, claude: new Map(read.processes.map((p) => [p.pid, p])) }
}

function hostState(): DesktopSnapshot['host'] {
  if (conn) return { state: 'up', error: null }
  if (starting) return { state: 'starting', error: null }
  return { state: 'down', error: hostDown.kind === 'unreachable' ? hostDown.error : null }
}

function buildSnapshot(): DesktopSnapshot {
  let places: Places
  try {
    places = readPlaces()
  } catch (err) {
    const error = `Couldn't read the project registry (${path.join(process.env.APP_ROOT!, 'registry.json')}): ${(err as Error).message}`
    return { host: hostState(), records: { error }, sessions: [], outside: { sessions: null, error } }
  }
  const loaded = loadRecords(recordsPath())
  // Unreadable records: no sessions can be listed, and the desktop refuses
  // every change; the records error says so (never an empty desktop).
  const { outside, claude } = readOutside(loaded.ok ? loaded.records : [], places)
  if (!loaded.ok) return { host: hostState(), records: { error: loaded.error }, sessions: [], outside }
  const ctx: SnapshotContext = { places, cache: new Map(), claude }
  const sessions = loaded.records
    .filter((r) => !creating.has(r.id))
    .map((r) => toSession(r, ctx))
    .sort((a, b) => a.slot - b.slot)
  return { host: hostState(), records: { error: null }, sessions, outside }
}

function sessionNow(id: string): DesktopSession {
  const records = requireRecords()
  const places = readPlaces()
  return toSession(findRecord(records, id), { places, cache: new Map(), claude: readOutside(records, places).claude })
}

let lastSerialized = ''
let refreshTimer: NodeJS.Timeout | null = null

function refresh(): void {
  const snapshot = buildSnapshot()
  const serialized = JSON.stringify(snapshot)
  if (serialized === lastSerialized) return
  lastSerialized = serialized
  for (const listener of snapshotListeners) listener(snapshot)
}

function scheduleRefresh(): void {
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    refresh()
  }, 50)
}

// ---- Lifecycle -----------------------------------------------------------

let pollTimer: NodeJS.Timeout | null = null

// Let go of a host with nothing alive on it so it can idle out, once the
// host's own list agrees (`live` can miss a session; see reconcile).
async function releaseIfIdle(): Promise<void> {
  const idle = () => conn !== null && live.size === 0 && queued === 0 && exitWaiters.size === 0
  if (!idle() || !(await reconcile()) || !idle()) return
  releasedPid = conn!.pid
  conn!.close()
  conn = null
  hostDown = { kind: 'absent' }
}

function poll(): void {
  // No records and no host: no session to watch, only the outside list
  // (a few small files), so no rebind or reattach.
  if (!conn && !connecting && clearPending.size === 0) {
    const loaded = loadRecords(recordsPath())
    if (loaded.ok && loaded.records.length === 0) return refresh()
  }
  void releaseIfIdle()
    .then(() => bindClearedSessions())
    .catch(() => undefined)
    .then(() => (conn || connecting ? undefined : attach(false)))
    .then(refresh)
}

// hostScript: dist-electron/desktop-host.js; execPath: the Electron binary
// (run as node via ELECTRON_RUN_AS_NODE). Passed in so this stays Electron-free.
export function initDesktopCore(options: { hostScript: string; execPath: string }): void {
  disposeDesktopCore()
  config = options
  pollTimer = setInterval(poll, POLL_MS)
  void attach(false).then(refresh)
}

// Close the pipe and stop polling. Never kills the host: its sessions outlive the app.
export function disposeDesktopCore(): void {
  if (pollTimer) clearInterval(pollTimer)
  if (refreshTimer) clearTimeout(refreshTimer)
  pollTimer = null
  refreshTimer = null
  conn?.close()
  conn = null
  live.clear()
  reconciling = null
  hostDown = { kind: 'absent' }
  releasedPid = null
  typed.clear()
  clearPending.clear()
  for (const timer of quietTimers.values()) clearTimeout(timer)
  quietTimers.clear()
  popped.clear()
  lastSerialized = ''
}

// ---- HubApi --------------------------------------------------------------

export async function getDesktop(): Promise<DesktopSnapshot> {
  if (!conn) await attach(false)
  return buildSnapshot()
}

// The folder guarded launches' generated settings files live in: beside the
// host info, so restrictInfoDir's owner-only ACL covers them.
export const boundarySettingsDir = () => path.join(path.dirname(hostInfoPath()), 'boundaries')

// The launch's boundary: the statement for every tier, plus for guarded the
// neighbours' --add-dir and a --settings file holding the deny rules (named
// by its content's hash, so a running session's file is never rewritten).
// The admin (claude-hub itself) launches with none of it.
function boundaryArgs(target: DesktopTargetRef, places: Places): { tier: LaunchTier; args: string[] } {
  const plan = planBoundaryLaunch(target, places)
  if (plan.settings === null) return { tier: plan.tier, args: plan.args }
  restrictInfoDir(path.dirname(hostInfoPath()))
  fs.mkdirSync(boundarySettingsDir(), { recursive: true })
  const file = path.join(boundarySettingsDir(), `${createHash('sha256').update(plan.settings).digest('hex').slice(0, 16)}.json`)
  fs.writeFileSync(file, plan.settings)
  return { tier: plan.tier, args: [...plan.args, '--settings', file] }
}

// Start a new desktop session running `args` in `cwd`. Runs inside serial().
async function launch(
  records: DesktopRecord[],
  spec: { target: DesktopTargetRef; cwd: string; name: string; color: DesktopColor; claudeSessionId: string; args: string[] },
): Promise<DesktopSession> {
  const slot = lowestFreeSlot(records)
  const id = randomUUID()
  const boundary = boundaryArgs(spec.target, readPlaces())
  const record: DesktopRecord = {
    id,
    claudeSessionId: spec.claudeSessionId,
    name: spec.name,
    color: spec.color,
    slot,
    target: spec.target,
    createdAtIso: new Date().toISOString(),
    exitCode: null,
    tier: boundary.tier,
  }
  // Record first: a session the host starts must never be one nobody can
  // see or kill. A failed create removes it again; a hub that quits midway
  // leaves an exited record (forgettable), never an orphaned claude.
  saveRecords(recordsPath(), [...records, record])
  creating.add(id)
  try {
    const host = await requireHost()
    try {
      await host.request({ t: 'create', id, cwd: spec.cwd, args: [...spec.args, ...boundary.args], cols: DEFAULT_COLS, rows: DEFAULT_ROWS }, (reply) =>
        live.set(id, { pid: hostPid(reply.pid), prompting: false, line: null }),
      )
    } catch (err) {
      // A create that timed out may have started anyway.
      host.request({ t: 'kill', id }).catch(() => undefined)
      throw err
    }
  } catch (err) {
    const now = loadRecords(recordsPath())
    if (now.ok) saveRecords(recordsPath(), now.records.filter((r) => r.id !== id))
    throw err
  } finally {
    creating.delete(id)
  }
  scheduleRefresh()
  return sessionNow(id)
}

// The outside list as the snapshot computes it, for a decision made now.
function outsideNow(records: DesktopRecord[]): DesktopSnapshot['outside'] {
  return readOutside(records, readPlaces()).outside
}

// The folder a target runs in, resolved here from the registry or the
// enumerated sandbox experiments; the renderer never sends a path.
function resolveTarget(target: DesktopTargetRef): { path: string; name: string } {
  const places = readPlaces()
  if (target.kind === 'experiment' && places.experiments === null) throw new Error(places.experimentsError!)
  return resolveTargetIn(target, places.projects, places.experiments ?? [])
}

export function createDesktopSession(spec: DesktopLaunchSpec): Promise<DesktopSession> {
  return serial(async () => {
    refuseIfPassive()
    const target = validateTarget(spec?.target)
    const name = validateName(spec.name)
    const color = validateColor(spec.color)
    if (spec.mode !== 'new' && spec.mode !== 'resume') throw new Error("Mode must be 'new' or 'resume'")
    const { path: cwd } = resolveTarget(target)
    const records = requireRecords()
    if (spec.mode === 'new') {
      const claudeSessionId = randomUUID()
      return launch(records, { target, cwd, name, color, claudeSessionId, args: ['--session-id', claudeSessionId, '--name', name] })
    }
    const sessionId = spec.sessionId
    if (!isUuid(sessionId)) throw new Error(`Not a session id: "${String(sessionId)}"`)
    findTargetTranscript(claudeProjectsDir(), cwd, sessionId)
    const refusal = resumeRefusal(sessionId, records, new Set(live.keys()), outsideNow(records))
    if (refusal) throw new Error(refusal)
    return launch(records, { target, cwd, name, color, claudeSessionId: sessionId, args: ['--resume', sessionId, '--name', name] })
  })
}

export function resumeDesktopSession(id: string): Promise<DesktopSession> {
  return serial(async () => {
    refuseIfPassive()
    const records = requireRecords()
    const record = findRecord(records, id)
    const { path: cwd } = resolveTarget(record.target)
    const host = await requireHost()
    if (live.has(id)) throw new Error('That session is already running')
    // Its conversation running in another terminal: two processes would interleave it.
    const refusal = resumeRefusal(record.claudeSessionId, records.filter((r) => r.id !== id), new Set(live.keys()), outsideNow(records))
    if (refusal) throw new Error(refusal)
    const boundary = boundaryArgs(record.target, readPlaces())
    try {
      await host.request(
        { t: 'create', id, cwd, args: ['--resume', record.claudeSessionId, '--name', record.name, ...boundary.args], cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
        (reply) => live.set(id, { pid: hostPid(reply.pid), prompting: false, line: null }),
      )
    } catch (err) {
      // A create that timed out may have started anyway, as in launch. A
      // refusal started nothing; "already running" means `live` missed it.
      if (err instanceof HostRefusal) void reconcile()
      else host.request({ t: 'kill', id }).catch(() => undefined)
      throw err
    }
    saveRecords(recordsPath(), records.map((r) => (r.id === id ? { ...r, exitCode: null, tier: boundary.tier } : r)))
    scheduleRefresh()
    return sessionNow(id)
  })
}

// Resolves once the session has exited (and its exit is queued for the
// records), so a forget right after it succeeds.
export async function closeDesktopSession(id: string): Promise<void> {
  refuseIfPassive()
  findRecord(requireRecords(), id)
  const host = connected()
  if (!live.has(id)) return // already exited
  const exited = waitForExit(id)
  try {
    await host.request({ t: 'kill', id })
  } catch (err) {
    exited.catch(() => undefined)
    throw err
  }
  await exited
}

export function forgetDesktopSession(id: string): Promise<void> {
  return serial(async () => {
    refuseIfPassive()
    const records = requireRecords()
    findRecord(records, id)
    if (!conn && hostDown.kind === 'unreachable') throw new Error(`Can't confirm the session has exited: ${hostDown.error}`)
    // Its record is the only thing keeping a running session from being reaped.
    if (conn && !(await reconcile())) throw new Error("Can't confirm the session has exited: the desktop host didn't list its sessions")
    if (live.has(id)) throw new Error('That session is still running; close it first')
    saveRecords(recordsPath(), records.filter((r) => r.id !== id))
    clearPending.delete(id)
    // Free the host's copy of its last screen. Best effort: the host also
    // drops every exited screen when it idles out.
    if (conn) await conn.request({ t: 'forget', id }).catch(() => undefined)
    scheduleRefresh()
  })
}

export function updateDesktopSession(id: string, patch: { name?: string; color?: DesktopColor; slot?: number }): Promise<DesktopSession> {
  return serial(async () => {
    refuseIfPassive()
    let records = requireRecords()
    findRecord(records, id)
    const name = patch.name === undefined ? undefined : validateName(patch.name)
    const color = patch.color === undefined ? undefined : validateColor(patch.color)
    if (patch.slot !== undefined) records = assignSlot(records, id, validateSlot(patch.slot))
    records = records.map((r) => (r.id === id ? { ...r, ...(name !== undefined && { name }), ...(color !== undefined && { color }) } : r))
    saveRecords(recordsPath(), records)
    scheduleRefresh()
    return sessionNow(id)
  })
}

export async function getDesktopScreen(id: string): Promise<DesktopScreen> {
  findRecord(requireRecords(), id)
  const reply = await connected().request({ t: 'screen', id })
  if (!reply.screen) throw new Error('The desktop host sent no screen')
  return { id, ...reply.screen }
}

// Hot path (every keystroke): checks the host's live list, not the records
// file. A forgotten session can't be live (forget refuses a live one).
function liveSession(id: string): HostConnection {
  const host = connected()
  if (!live.has(id)) throw new Error('That session is not running')
  return host
}

export async function desktopInput(id: string, data: string): Promise<void> {
  refuseIfPassive()
  if (typeof data !== 'string') throw new Error('Input must be text')
  // Well under the protocol's line cap, past which the host drops the connection.
  if (data.length > 1_000_000) throw new Error('Input is too large to send at once')
  const host = liveSession(id)
  const line = feedTypedLine(typed.get(id) ?? '', data)
  typed.set(id, line.buffer)
  if (line.submitted.some(isClearCommand)) clearPending.set(id, Date.now())
  await host.request({ t: 'input', id, d: data })
}

export async function desktopResize(id: string, cols: number, rows: number): Promise<void> {
  if (passive()) return
  const sane = (n: unknown, max: number) => Number.isInteger(n) && (n as number) >= 2 && (n as number) <= max
  if (!sane(cols, 1000) || !sane(rows, 500)) throw new Error('Terminal size must be whole numbers (cols 2-1000, rows 2-500)')
  await liveSession(id).request({ t: 'resize', id, cols, rows })
}

export async function listDesktopTargets(): Promise<DesktopLaunchTargets> {
  const errors: string[] = []
  let places: Places = { projects: [], experiments: [], experimentsError: null }
  try {
    places = readPlaces()
  } catch (err) {
    errors.push(`Couldn't read the project registry: ${(err as Error).message}`)
  }
  if (places.experimentsError) errors.push(places.experimentsError)
  const loaded = loadRecords(recordsPath())
  const outside = readOutside(loaded.ok ? loaded.records : [], places).outside
  if (outside.sessions === null) errors.push(`${outside.error}, so conversations running elsewhere aren't marked`)
  else if (outside.error) errors.push(outside.error)
  const targets: LaunchTarget[] = [
    ...places.projects.map((p) => ({ ref: { kind: 'project' as const, key: p.id }, name: p.name, path: p.path })),
    ...(places.experiments ?? []).map((e) => ({ ref: { kind: 'experiment' as const, key: path.win32.basename(e) }, name: path.win32.basename(e), path: e })),
  ]
  return buildLaunchTargets({
    targets,
    base: claudeProjectsDir(),
    liveElsewhere: new Set((outside.sessions ?? []).map((s) => s.sessionId)),
    errors,
    nowMs: Date.now(),
  })
}

// Claude Code's record for a running process, or throws saying why not.
function readClaudeRecord(pid: number): ClaudeProcess {
  const file = path.join(claudeSessionsDir(), `${pid}.json`)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No running Claude Code session has process id ${pid}`)
    throw new Error(`Couldn't read ${file}: ${(err as Error).message}`)
  }
  const parsed = parseClaudeRecord(text, `${pid}.json`)
  if (!parsed) throw new Error(`Claude Code's record for process ${pid} is in a format this hub doesn't recognise`)
  return parsed
}

async function waitPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (!pidAlive(pid)) return true
    await delay(100)
  }
  return !pidAlive(pid)
}

// Move a conversation running in another terminal onto the desktop. The old
// process is closed only when decideTakeOver proves it is the recorded,
// idle claude.exe; then the same session id resumes here. Otherwise it keeps
// running and the conversation forks here under a new id (--session-id with
// --fork-session, so the record knows the fork's id from the start).
export function takeOverSession(pid: number, sessionId: string, opts: { name: string; color: DesktopColor; closeOld: boolean }): Promise<TakeOverResult> {
  return serial(async () => {
    refuseIfPassive()
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Not a process id')
    if (!isUuid(sessionId)) throw new Error(`Not a session id: "${String(sessionId)}"`)
    const name = validateName(opts?.name)
    const color = validateColor(opts?.color)
    const closeOld = opts.closeOld === true
    const before = readClaudeRecord(pid)
    if (before.sessionId !== sessionId) throw new Error(`Process ${pid} is running a different conversation now`)
    if (!before.interactive) throw new Error(`Process ${pid} isn't an interactive Claude Code session`)
    const places = readPlaces()
    const mapped = targetForCwd(before.cwd, places.projects, places.experiments ?? [])
    if (!mapped) throw new Error(`It runs in ${before.cwd}, which isn't a registered project or sandbox experiment, so the desktop can't start it there`)
    const cwd = resolveTargetIn(mapped.target, places.projects, places.experiments ?? []).path
    const records = requireRecords()
    // An exited tile on this conversation is taken over too: once the old
    // process is closed and the new session runs, the tile's record goes, so
    // one conversation never keeps two.
    const held = records.find((r) => r.claudeSessionId === sessionId)
    if (held && live.has(held.id)) throw new Error('That conversation is already on the desktop')
    lowestFreeSlot(records) // a full desktop refuses before anything is closed
    planBoundaryLaunch(mapped.target, places) // so does a boundary that can't be read
    if (!pidAlive(pid)) throw new Error(`Process ${pid} has exited; resume the conversation instead`)
    await requireHost() // nothing is closed unless the session can start here

    let facts: ProcessFacts | null = null
    let factsError: string | null = null
    let status = before.status
    if (closeOld && status === 'idle') {
      try {
        facts = await queryProcess(pid)
      } catch (err) {
        factsError = (err as Error).message
      }
      // It may have started a turn while Windows was asked.
      try {
        const again = readClaudeRecord(pid)
        status = again.sessionId === sessionId ? again.status : 'unknown'
      } catch {
        status = 'unknown'
      }
    }
    const decision = decideTakeOver({ closeOld, status, procStart: before.procStart, facts, factsError })
    let closedOld = false
    let note = decision.close ? null : decision.note
    if (decision.close) {
      try {
        await killTree(decision.killPid)
        closedOld = await waitPidGone(pid, CLOSE_WAIT_MS)
        if (!closedOld) note = `It hadn't exited ${CLOSE_WAIT_MS / 1000}s after being closed, so it may still be running; ${FORK}`
      } catch (err) {
        closedOld = !pidAlive(pid)
        if (!closedOld) note = `Couldn't close it (${(err as Error).message}), so it's still running; ${FORK}`
      }
    }
    const claudeSessionId = closedOld ? sessionId : randomUUID()
    const args = closedOld
      ? ['--resume', sessionId, '--name', name]
      : ['--resume', sessionId, '--fork-session', '--session-id', claudeSessionId, '--name', name]
    const session = await launch(records, { target: mapped.target, cwd, name, color, claudeSessionId, args })
    if (closedOld && held) saveRecords(recordsPath(), requireRecords().filter((r) => r.id !== held.id))
    return { session, closedOld, note }
  })
}

// ---- Pop-out ---------------------------------------------------------------

// The name of a desktop session that can be popped out; refuses unless `id`
// is a desktop session that is running.
export function poppableName(id: string): string {
  const record = findRecord(requireRecords(), id)
  if (!live.has(id)) throw new Error('That session is not running')
  return record.name
}

export function setPoppedOut(id: string, poppedOut: boolean): void {
  if (poppedOut) popped.add(id)
  else popped.delete(id)
  scheduleRefresh()
}

// The pty's process id (tests).
export function desktopPtyPid(id: string): number | null {
  return live.get(id)?.pid ?? null
}
