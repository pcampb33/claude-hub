// Session Desktop pty host: one detached process that owns every desktop
// session's terminal, so a hub restart or crash doesn't take the sessions with
// it. Built to dist-electron/desktop-host.js and run by the main process under
// ELECTRON_RUN_AS_NODE (tests run this source under plain node).
//
//   desktop-host.js --info <path> [--idle-ms <n>] [--launch]
//
// --launch: re-spawn this script detached (same args, minus --launch) and exit
// at once. The real host's parent is then dead, so a tree-kill of the app
// (taskkill /T, Playwright cleanup) can't reach it.
//
// The host listens on a named pipe and writes {pid, pipe, token} to --info.
// Protocol: desktop-protocol.ts. It spawns ONLY the Claude Code binary
// (resolveClaudeExe); CLAUDE_HUB_DESKTOP_EXE replaces it, for tests only.
// It exits when no pty is alive and no client is connected for --idle-ms.
import fs from 'node:fs'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn as spawnChild } from 'node:child_process'
import nodePty from 'node-pty'
import xtermHeadless from '@xterm/headless'
import addonSerialize from '@xterm/addon-serialize'
import type { IPty } from 'node-pty'
import type { Terminal } from '@xterm/headless'
import type { SerializeAddon } from '@xterm/addon-serialize'
import { LineDecoder, encode, type ClientMessage, type ClientRequest, type HostMessage, type HostInfo } from './desktop-protocol.ts'
import { bottomLines, detectPrompt, ptyEnv, resolveClaudeExe, settleDelay } from './desktop-host-core.ts'

const argv = process.argv.slice(2)

if (argv.includes('--launch')) {
  spawnChild(process.execPath, [...process.execArgv, process.argv[1], ...argv.filter((a) => a !== '--launch')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()
  process.exit(0)
}

function argValue(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const infoPath = argValue('--info')
if (!infoPath) process.exit(2)
const INFO_PATH: string = infoPath
const IDLE_MS = Number(argValue('--idle-ms') ?? 30_000)
const HELLO_TIMEOUT_MS = 5_000
// Beside the info file (under %LOCALAPPDATA%); the host has no stdio, so this
// is where it says why.
const LOG_PATH = INFO_PATH.replace(/\.json$/i, '') + '.log'

function log(message: string): void {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${process.pid}] ${message}\n`)
  } catch {
    // Nowhere left to report to.
  }
}

// Resolved once at start: the test override, or the real binary.
const override = process.env.CLAUDE_HUB_DESKTOP_EXE
const EXE: { exe: string } | { error: string } = override
  ? { exe: override }
  : resolveClaudeExe(process.env.PATH, (file) => {
      try {
        return fs.statSync(file).isFile()
      } catch {
        return false
      }
    })

interface Session {
  id: string
  pty: IPty | null // null once exited
  term: Terminal
  serializer: SerializeAddon
  seq: number
  prompting: boolean
  line: string | null
  settleTimer: NodeJS.Timeout | null
  pendingSince: number // when the first output not yet checked for a menu arrived
}

// Exited sessions stay until forgotten or replaced (a resume reuses the id) so
// their last screen can still be fetched; only live ptys keep the host running.
const sessions = new Map<string, Session>()
const clients = new Set<net.Socket>()
let idleTimer: NodeJS.Timeout | null = null

function broadcast(message: HostMessage): void {
  const line = encode(message)
  for (const client of clients) client.write(line)
}

function checkIdle(): void {
  const busy = clients.size > 0 || [...sessions.values()].some((s) => s.pty !== null)
  if (busy) {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    return
  }
  if (!idleTimer) idleTimer = setTimeout(shutdown, IDLE_MS)
}

function shutdown(): void {
  // Only exited sessions are left by now (a live pty keeps the host busy).
  for (const session of sessions.values()) session.term.dispose()
  sessions.clear()
  try {
    const info = JSON.parse(fs.readFileSync(INFO_PATH, 'utf-8')) as HostInfo
    if (info.pid === process.pid) fs.rmSync(INFO_PATH, { force: true })
  } catch {
    // Already gone, or another host's file: leave it.
  }
  process.exit(0)
}

// After output settles, flush the parser (write('') calls back once every
// earlier chunk is parsed) and look for a choice menu. Emit only on change.
function checkPrompt(session: Session): void {
  session.settleTimer = null
  session.term.write('', () => {
    const { prompting, line } = detectPrompt(bottomLines(session.term))
    if (prompting === session.prompting && line === session.line) return
    session.prompting = prompting
    session.line = line
    broadcast({ t: 'prompting', id: session.id, prompting, line })
  })
}

function validSize(cols: number, rows: number): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0
}

function create(req: Extract<ClientRequest, { t: 'create' }>): number {
  if ('error' in EXE) throw new Error(EXE.error)
  if (!validSize(req.cols, req.rows)) throw new Error('bad terminal size')
  const existing = sessions.get(req.id)
  if (existing?.pty) throw new Error('That session is already running')
  const pty = nodePty.spawn(EXE.exe, req.args, {
    name: 'xterm-256color',
    cols: req.cols,
    rows: req.rows,
    cwd: req.cwd,
    env: ptyEnv(process.env),
  })
  existing?.term.dispose()
  const term = new xtermHeadless.Terminal({ cols: req.cols, rows: req.rows, scrollback: 5000, allowProposedApi: true })
  const serializer = new addonSerialize.SerializeAddon()
  term.loadAddon(serializer)
  const session: Session = { id: req.id, pty, term, serializer, seq: 0, prompting: false, line: null, settleTimer: null, pendingSince: 0 }
  sessions.set(req.id, session)
  pty.onData((d) => {
    session.seq += 1
    term.write(d)
    broadcast({ t: 'data', id: session.id, seq: session.seq, d })
    if (session.settleTimer) clearTimeout(session.settleTimer)
    else session.pendingSince = Date.now()
    session.settleTimer = setTimeout(() => checkPrompt(session), settleDelay(session.pendingSince, Date.now()))
  })
  pty.onExit(({ exitCode }) => {
    session.pty = null
    if (session.settleTimer) clearTimeout(session.settleTimer)
    session.settleTimer = null
    session.prompting = false
    session.line = null
    broadcast({ t: 'exit', id: session.id, code: typeof exitCode === 'number' ? exitCode : null })
    checkIdle()
  })
  checkIdle()
  return pty.pid
}

function live(id: string): Session & { pty: IPty } {
  const session = sessions.get(id)
  if (!session?.pty) throw new Error('That session is not running')
  return session as Session & { pty: IPty }
}

function handle(socket: net.Socket, msg: ClientMessage): void {
  if (msg.t === 'hello' || typeof msg.rid !== 'number') {
    socket.destroy()
    return
  }
  const reply = (extra: object = {}) => socket.write(encode({ t: 'reply', rid: msg.rid, ok: true, ...extra }))
  try {
    switch (msg.t) {
      case 'create':
        return void reply({ pid: create(msg) })
      case 'input':
        live(msg.id).pty.write(String(msg.d))
        return void reply()
      case 'resize': {
        if (!validSize(msg.cols, msg.rows)) throw new Error('bad terminal size')
        const session = live(msg.id)
        session.pty.resize(msg.cols, msg.rows)
        session.term.resize(msg.cols, msg.rows)
        return void reply()
      }
      case 'kill':
        live(msg.id).pty.kill()
        return void reply()
      case 'forget': {
        const session = sessions.get(msg.id)
        if (session?.pty) throw new Error('That session is still running')
        session?.term.dispose()
        sessions.delete(msg.id)
        return void reply()
      }
      case 'screen': {
        const session = sessions.get(msg.id)
        if (!session) throw new Error('No such session on the host')
        // Writes parse in order: this callback runs once every chunk up to
        // the current seq is in the model, and none after it.
        const seq = session.seq
        session.term.write('', () => {
          reply({ screen: { seq, data: session.serializer.serialize(), cols: session.term.cols, rows: session.term.rows } })
        })
        return
      }
      case 'list':
        return void reply({
          sessions: [...sessions.values()]
            .flatMap((s) => (s.pty ? [{ id: s.id, pid: s.pty.pid, prompting: s.prompting, line: s.line, seq: s.seq }] : [])),
        })
      default:
        socket.destroy()
    }
  } catch (err) {
    socket.write(encode({ t: 'reply', rid: msg.rid, ok: false, error: err instanceof Error ? err.message : String(err) }))
  }
}

const token = crypto.randomBytes(32).toString('hex')
const tokenBuffer = Buffer.from(token)
const pipe = String.raw`\\.\pipe\claude-hub-desktop-` + crypto.randomBytes(8).toString('hex')

function tokenMatches(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false
  const buf = Buffer.from(candidate)
  return buf.length === tokenBuffer.length && crypto.timingSafeEqual(buf, tokenBuffer)
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  const decoder = new LineDecoder()
  let authed = false
  const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS)
  socket.on('data', (chunk: string) => {
    let messages: unknown[]
    try {
      messages = decoder.push(chunk)
    } catch {
      socket.destroy()
      return
    }
    for (const raw of messages) {
      if (socket.destroyed) return
      const msg = raw as ClientMessage
      if (!authed) {
        if (msg?.t !== 'hello' || !tokenMatches(msg.token)) {
          socket.destroy()
          return
        }
        authed = true
        clearTimeout(helloTimer)
        clients.add(socket)
        checkIdle()
        socket.write(encode({ t: 'welcome', pid: process.pid }))
        continue
      }
      handle(socket, msg)
    }
  })
  socket.on('close', () => {
    clearTimeout(helloTimer)
    if (clients.delete(socket)) checkIdle()
  })
})

server.on('error', (err) => {
  log(`pipe server failed: ${err.message}`)
  process.exit(1)
})

// A bug in one handler must not take every session down with the process.
process.on('uncaughtException', (err) => log(`uncaught: ${err.stack ?? err.message}`))

server.listen(pipe, () => {
  const info: HostInfo = { pid: process.pid, pipe, token }
  const tmp = `${INFO_PATH}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(info))
  fs.renameSync(tmp, INFO_PATH)
  if ('error' in EXE) log(EXE.error)
  checkIdle()
})
