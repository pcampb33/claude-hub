// Integration: desktop-core against a real host (spawned the production way,
// --launch and all) running a stand-in for the Claude Code binary. Windows-only.
// The tests share one module instance; each gets its own APP_ROOT and
// LOCALAPPDATA (both read per call) and disposes the core when done.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { LineDecoder, encode, type HostInfo, type HostMessage } from './desktop-protocol.ts'
import { sanitize } from './status.ts'
import type { DesktopColor, DesktopLaunchSpec, DesktopSession } from '../shared/ipc-types.ts'
import { killStandIns, launchedWith, pidAlive, waitFor, writeStandIn } from './desktop-test-support.ts'
import type { DesktopSnapshot, DesktopTerminalChunk } from '../shared/ipc-types.ts'

// The launch spec for a new session in a registered project.
function createIn(core: { createDesktopSession: (spec: DesktopLaunchSpec) => Promise<DesktopSession> }, key: string, name: string, color: DesktopColor) {
  return core.createDesktopSession({ target: { kind: 'project', key }, mode: 'new', name, color })
}

const HOST = fileURLToPath(new URL('./desktop-host.ts', import.meta.url))
const skip = process.platform !== 'win32'
const core = await import('./desktop-core.ts')
const opts = { hostScript: HOST, execPath: process.execPath }

let latest: DesktopSnapshot | null = null
const chunks: DesktopTerminalChunk[] = []
core.onDesktopSnapshot((s) => (latest = s))
core.onDesktopData((c) => chunks.push(c))
const snap = (what: string, ok: (s: DesktopSnapshot) => boolean, timeoutMs?: number) => waitFor(() => latest && ok(latest) && latest, what, timeoutMs)

// A fresh APP_ROOT with one registered project, and LOCALAPPDATA pointed into it.
function setup(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `desktop-core-${name}-`))
  const projectDir = path.join(dir, 'proj')
  fs.mkdirSync(projectDir)
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify([{ id: 'p1', name: 'proj', path: projectDir, addedAt: '2026-10-18T00:00:00.000Z' }]))
  // node --test runs each file in its own process, so these need no restoring.
  process.env.APP_ROOT = dir
  process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
  // A fake ~/.claude: the user's real session records and transcripts are never read.
  process.env.CLAUDE_HUB_CLAUDE_HOME = path.join(dir, '.claude')
  fs.mkdirSync(path.join(dir, '.claude', 'sessions'), { recursive: true })
  process.env.CLAUDE_HUB_DESKTOP_EXE = writeStandIn(dir)
  // No detached launcher: under node.exe it opens visible terminal windows.
  process.env.CLAUDE_HUB_DESKTOP_DIRECT_HOST = '1'
  delete process.env.CLAUDE_HUB_DESKTOP_PASSIVE
  delete process.env.CLAUDE_HUB_DESKTOP_IDLE_MS
  latest = null
  return { dir, projectDir, infoPath: core.hostInfoPath(), recordsPath: path.join(dir, 'desktop-sessions.json') }
}

// Close every live session first: killing the host alone leaves its pty
// children (the stand-ins) running.
async function teardown(dir: string, infoPath: string) {
  delete process.env.CLAUDE_HUB_DESKTOP_PASSIVE
  try {
    for (const s of (await core.getDesktop()).sessions) if (s.alive) await core.closeDesktopSession(s.id)
  } catch {
    // records unreadable or host gone: nothing left to close through the core
  }
  core.disposeDesktopCore()
  try {
    const { pid } = JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as { pid: number }
    if (pid !== process.pid && pidAlive(pid)) process.kill(pid)
  } catch {
    // host never started, or already gone
  }
  killStandIns(dir)
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch {
    // leave it to the OS temp cleanup
  }
}

// A raw protocol client, standing in for another hub instance.
async function rawClient(info: HostInfo) {
  const socket = net.connect(info.pipe)
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  const decoder = new LineDecoder()
  const messages: HostMessage[] = []
  socket.on('data', (c: string) => messages.push(...(decoder.push(c) as HostMessage[])))
  socket.write(encode({ t: 'hello', token: info.token }))
  await waitFor(() => messages.find((m) => m.t === 'welcome'), 'welcome')
  return { socket, messages }
}

test('desktop core: create, needs-you, slots, reattach, passive, input, exit, close+forget, resume, corrupt records', { skip }, async () => {
  const { dir, infoPath, recordsPath } = setup('main')
  try {
    // The host's pipe + token live under LOCALAPPDATA, never in the repo folder.
    assert.ok(infoPath.startsWith(path.join(dir, 'localappdata', 'claude-hub') + path.sep))

    // Nothing alive: reading the desktop never starts a host.
    const empty = await core.getDesktop()
    assert.deepEqual(empty.host, { state: 'down', error: null })
    assert.deepEqual(empty.records, { error: null })
    assert.deepEqual(empty.sessions, [])
    assert.deepEqual(empty.outside, { sessions: [], error: null })
    assert.equal(fs.existsSync(infoPath), false)

    core.initDesktopCore(opts)
    await assert.rejects(createIn(core, 'p1', '  ', 'teal'), /1-60/)
    await assert.rejects(createIn(core, 'p1', 'a"b', 'teal'), /double quote/)
    await assert.rejects(createIn(core, 'p1', 'ok', 'red' as never), /Color must be/)
    await assert.rejects(createIn(core, 'C:\\Windows', 'ok', 'teal'), /No registered project/)
    assert.equal(fs.existsSync(infoPath), false)

    const alpha = await createIn(core, 'p1', ' Alpha ', 'teal')
    assert.equal(alpha.name, 'Alpha')
    assert.equal(alpha.slot, 1)
    assert.equal(alpha.alive, true)
    assert.equal(alpha.targetName, 'proj')
    assert.ok(fs.existsSync(infoPath), 'create started the host')
    // Its folder grants only the user and SYSTEM: no inherited Users/sandbox read.
    const acl = execFileSync('icacls', [path.dirname(infoPath)], { encoding: 'utf-8' }).replace(path.dirname(infoPath), '')
    assert.doesNotMatch(acl, /\(I\)/, acl)
    assert.doesNotMatch(acl, /Users|Everyone|Authenticated/i, acl)
    assert.match(acl, new RegExp(os.userInfo().username, 'i'))

    const waiting = await snap('alpha needs-you', (s) => s.sessions[0]?.state === 'needs-you')
    assert.equal(waiting.host.state, 'up')
    assert.equal(waiting.sessions[0].stateDetail, 'Do you trust this folder?')

    const screen = await core.getDesktopScreen(alpha.id)
    assert.ok(screen.data.includes('args:["--session-id"'))
    await launchedWith(dir, ['--session-id', alpha.claudeSessionId, '--name', 'Alpha', '--append-system-prompt'])
    const alphaSeqs = chunks.filter((c) => c.id === alpha.id).map((c) => c.seq)
    assert.ok(alphaSeqs.length > 0 && alphaSeqs.includes(screen.seq))

    const beta = await createIn(core, 'p1', 'Beta', 'blue')
    assert.equal(beta.slot, 2)
    const swapped = await core.updateDesktopSession(beta.id, { slot: 1, name: 'Beta 2' })
    assert.equal(swapped.slot, 1)
    assert.equal(swapped.name, 'Beta 2')
    assert.deepEqual(
      (await core.getDesktop()).sessions.map((s) => [s.name, s.slot]),
      [['Beta 2', 1], ['Alpha', 2]],
    )
    await assert.rejects(core.updateDesktopSession(beta.id, { slot: 10 }), /Slot must be/)

    // Closing the pipe (hub quit) leaves the host and its sessions running.
    const hostPid = (JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as { pid: number }).pid
    core.disposeDesktopCore()
    latest = null
    core.initDesktopCore(opts)
    const reattached = await core.getDesktop()
    assert.equal(reattached.host.state, 'up')
    assert.deepEqual(reattached.sessions.map((s) => s.alive), [true, true])
    assert.equal(pidAlive(hostPid), true)

    await core.desktopResize(alpha.id, 100, 40)
    assert.equal((await core.getDesktopScreen(alpha.id)).cols, 100)
    await assert.rejects(core.desktopResize(alpha.id, 0, 40), /Terminal size/)

    // Passive (screenshot) mode shows everything and changes nothing: a
    // resize is dropped, every action is refused.
    process.env.CLAUDE_HUB_DESKTOP_PASSIVE = '1'
    await core.desktopResize(alpha.id, 50, 20)
    assert.equal((await core.getDesktopScreen(alpha.id)).cols, 100)
    assert.equal((await core.getDesktop()).sessions.length, 2)
    for (const action of [
      () => createIn(core, 'p1', 'Nope', 'teal'),
      () => core.resumeDesktopSession(alpha.id),
      () => core.closeDesktopSession(alpha.id),
      () => core.forgetDesktopSession(alpha.id),
      () => core.updateDesktopSession(alpha.id, { name: 'Nope' }),
      () => core.desktopInput(alpha.id, 'quit'),
    ]) {
      await assert.rejects(action(), /read-only/)
    }
    delete process.env.CLAUDE_HUB_DESKTOP_PASSIVE
    assert.equal((await core.getDesktop()).sessions.find((s) => s.id === alpha.id)?.alive, true)

    // Menu gone, no transcript yet: starting.
    await core.desktopInput(alpha.id, 'clear')
    await snap('alpha starting', (s) => s.sessions.find((x) => x.id === alpha.id)?.state === 'starting')

    await core.desktopInput(alpha.id, 'quit')
    const exited = await snap('alpha exited', (s) => s.sessions.find((x) => x.id === alpha.id)?.exitCode === 3)
    assert.equal(exited.sessions.find((x) => x.id === alpha.id)?.state, 'exited')
    await assert.rejects(core.desktopInput(alpha.id, 'x'), /not running/)
    await core.forgetDesktopSession(alpha.id)
    assert.equal((await core.getDesktop()).sessions.length, 1)

    await assert.rejects(core.forgetDesktopSession(beta.id), /still running/)
    await assert.rejects(core.resumeDesktopSession(beta.id), /already running/)
    // Close resolves only once the session has exited, so forget can follow at once.
    await core.closeDesktopSession(beta.id)
    assert.equal((await core.getDesktop()).sessions[0].state, 'exited')
    const resumed = await core.resumeDesktopSession(beta.id)
    assert.equal(resumed.alive, true)
    assert.equal(resumed.exitCode, null)
    await launchedWith(dir, ['--resume', beta.claudeSessionId, '--name', 'Beta 2', '--append-system-prompt'])
    await core.closeDesktopSession(beta.id)
    await core.forgetDesktopSession(beta.id)
    assert.deepEqual((await core.getDesktop()).sessions, [])

    // A corrupt records file is an error, never an empty desktop, and is never overwritten.
    fs.writeFileSync(recordsPath, '{ not json')
    const broken = await core.getDesktop()
    assert.deepEqual(broken.sessions, [])
    assert.match(broken.records.error ?? '', /unreadable/)
    assert.ok(broken.records.error?.includes(recordsPath))
    await assert.rejects(createIn(core, 'p1', 'Gamma', 'teal'), /unreadable/)
    assert.equal(fs.readFileSync(recordsPath, 'utf-8'), '{ not json')
  } finally {
    await teardown(dir, infoPath)
  }
})

test('desktop core: a stale info file (recycled pid, pipe gone) is removed, and create starts a fresh host', { skip }, async () => {
  const { dir, infoPath } = setup('stale')
  // A live pid (this test process) that is not a host, and a pipe nobody listens on.
  const writeStale = () => {
    fs.mkdirSync(path.dirname(infoPath), { recursive: true })
    fs.writeFileSync(infoPath, JSON.stringify({ pid: process.pid, pipe: String.raw`\\.\pipe\claude-hub-desktop-0000000000000000`, token: 'f'.repeat(64) }))
  }
  try {
    writeStale()
    const first = await core.getDesktop()
    assert.deepEqual(first.host, { state: 'down', error: null })
    assert.equal(fs.existsSync(infoPath), false, 'the stale info file is removed')
    writeStale()
    core.initDesktopCore(opts)
    const created = await createIn(core, 'p1', 'Fresh', 'teal')
    assert.equal(created.alive, true)
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as { pid: number }
    assert.notEqual(info.pid, process.pid)
  } finally {
    await teardown(dir, infoPath)
  }
})

test('desktop core: with its last session gone the hub lets go of the host, which idles out while the hub stays open', { skip }, async () => {
  const { dir, infoPath } = setup('idle')
  process.env.CLAUDE_HUB_DESKTOP_IDLE_MS = '500'
  try {
    core.initDesktopCore(opts)
    const s = await createIn(core, 'p1', 'Short', 'teal')
    const hostPid = (JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as { pid: number }).pid
    await core.closeDesktopSession(s.id)
    await core.forgetDesktopSession(s.id)
    // One poll (3s) to let go, then the host's idle timer.
    await waitFor(() => !pidAlive(hostPid), 'the host to idle out', 8000)
    assert.equal(fs.existsSync(infoPath), false)
    assert.deepEqual((await core.getDesktop()).host, { state: 'down', error: null })
  } finally {
    await teardown(dir, infoPath)
  }
})

test('desktop core: a live host session with no record is killed on attach; a failed create leaves no record', { skip }, async () => {
  const { dir, infoPath, recordsPath } = setup('orphan')
  try {
    core.initDesktopCore(opts)
    const kept = await createIn(core, 'p1', 'Kept', 'teal')
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as HostInfo
    const other = await rawClient(info)
    other.socket.write(encode({ t: 'create', id: 'orphan', cwd: dir, args: [], cols: 80, rows: 24, rid: 1 }))
    await waitFor(() => other.messages.find((m) => m.t === 'reply' && m.rid === 1), 'orphan created')

    core.disposeDesktopCore()
    core.initDesktopCore(opts)
    await waitFor(() => other.messages.find((m) => m.t === 'exit' && m.id === 'orphan'), 'the orphan to be killed')
    assert.equal(other.messages.some((m) => m.t === 'exit' && m.id === kept.id), false, 'the recorded session is left alone')
    other.socket.destroy()

    // A create the host refuses (no such cwd) removes the record it wrote first.
    fs.writeFileSync(
      path.join(dir, 'registry.json'),
      JSON.stringify([
        { id: 'p1', name: 'proj', path: path.join(dir, 'proj'), addedAt: '2026-10-18T00:00:00.000Z' },
        { id: 'gone', name: 'gone', path: path.join(dir, 'no-such-folder'), addedAt: '2026-10-18T00:00:00.000Z' },
      ]),
    )
    await assert.rejects(createIn(core, 'gone', 'Doomed', 'teal'))
    const records = (JSON.parse(fs.readFileSync(recordsPath, 'utf-8')) as { sessions: { name: string }[] }).sessions
    assert.deepEqual(records.map((r) => r.name), ['Kept'])
  } finally {
    await teardown(dir, infoPath)
  }
})

test('desktop core: a missing records file is not "no records": the next attach kills nothing', { skip }, async () => {
  const { dir, infoPath, recordsPath } = setup('missing')
  try {
    core.initDesktopCore(opts)
    const kept = await createIn(core, 'p1', 'Kept', 'teal')
    const other = await rawClient(JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as HostInfo)
    fs.rmSync(recordsPath)

    core.disposeDesktopCore()
    core.initDesktopCore(opts)
    assert.equal((await core.getDesktop()).host.state, 'up')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.equal(other.messages.some((m) => m.t === 'exit' && m.id === kept.id), false, 'the running session is left alone')
    other.socket.write(encode({ t: 'list', rid: 1 }))
    const listed = await waitFor(() => other.messages.find((m) => m.t === 'reply' && m.rid === 1), 'the host list')
    assert.deepEqual((listed as { sessions?: { id: string }[] }).sessions?.map((s) => s.id), [kept.id])

    // No record left to close it through the core: end it directly.
    other.socket.write(encode({ t: 'kill', id: kept.id, rid: 2 }))
    await waitFor(() => other.messages.find((m) => m.t === 'exit' && m.id === kept.id), 'the session to exit')
    other.socket.destroy()
  } finally {
    await teardown(dir, infoPath)
  }
})

test('desktop core: a submitted /clear rebinds the record to the transcript it starts', { skip }, async () => {
  const { dir, projectDir, infoPath, recordsPath } = setup('clear')
  const sessionDir = path.join(dir, '.claude', 'projects', sanitize(projectDir))
  fs.mkdirSync(sessionDir, { recursive: true })
  const line = (o: object) => JSON.stringify(o) + '\n'
  try {
    core.initDesktopCore(opts)
    const s = await createIn(core, 'p1', 'Clearer', 'teal')
    fs.writeFileSync(path.join(sessionDir, `${s.claudeSessionId}.jsonl`), line({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'hi' } }))

    // Typed with a correction; the hub sees the keystrokes it relays.
    for (const key of ['/', 'c', 'l', 'e', 'x', '\x7f', 'a', 'r', '\r']) await core.desktopInput(s.id, key)
    // A busy unrelated session started meanwhile is not the cleared one.
    fs.writeFileSync(path.join(sessionDir, 'unrelated.jsonl'), line({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'other work' } }))
    const cleared = 'cleared-session'
    fs.writeFileSync(
      path.join(sessionDir, `${cleared}.jsonl`),
      line({ type: 'mode', mode: 'normal' }) +
        line({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>' } }),
    )
    await snap('rebound to the new transcript', (x) => x.sessions[0]?.claudeSessionId === cleared, 8000)
    const saved = (JSON.parse(fs.readFileSync(recordsPath, 'utf-8')) as { sessions: { claudeSessionId: string }[] }).sessions
    assert.equal(saved[0].claudeSessionId, cleared)
  } finally {
    await teardown(dir, infoPath)
  }
})

test('desktop core: every launch carries the boundary statement; guarded adds --settings deny rules and --add-dir; claude-hub itself launches with none; an unreadable boundaries file refuses', { skip }, async () => {
  const { dir, projectDir, infoPath, recordsPath } = setup('boundary')
  const neighbour = path.join(dir, 'neighbour proj')
  const other = path.join(dir, 'other')
  fs.mkdirSync(neighbour)
  fs.mkdirSync(other)
  const entry = (id: string, name: string, p: string) => ({ id, name, path: p, addedAt: '2026-10-18T00:00:00.000Z' })
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify([entry('p1', 'proj', projectDir), entry('p2', 'neighbour proj', neighbour), entry('p3', 'other', other), entry('hub', 'hub', dir)]))
  const pc = await import('./project-config.ts')
  const { rulePath } = await import('./project-config-core.ts')
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? ''
  try {
    core.initDesktopCore(opts)
    const audited = await createIn(core, 'p1', 'Audited', 'teal')
    assert.equal(audited.tier, 'audit')
    const auditArgs = await launchedWith(dir, ['--session-id', audited.claudeSessionId])
    assert.match(after(auditArgs, '--append-system-prompt'), /this session belongs to proj at .*crossings are logged\.$/)
    assert.equal(auditArgs.includes('--settings'), false)
    assert.equal(auditArgs.includes('--add-dir'), false)

    await pc.setBoundary({ kind: 'project', key: 'p1' }, { tier: 'guarded', neighbours: [{ target: { kind: 'project', key: 'p2' }, access: 'write' }] })
    const guarded = await createIn(core, 'p1', 'Guarded', 'blue')
    assert.equal(guarded.tier, 'guarded')
    const args = await launchedWith(dir, ['--session-id', guarded.claudeSessionId])
    const statement = after(args, '--append-system-prompt')
    assert.match(statement, /neighbour proj at .*neighbour proj \(read and write\)/)
    assert.match(statement, /file tools are blocked from other projects; don't use shell commands to reach them either\.$/)
    assert.ok(statement.length <= 1000)
    assert.equal(after(args, '--add-dir'), neighbour)
    const settingsFile = after(args, '--settings')
    assert.ok(settingsFile.startsWith(path.join(dir, 'localappdata', 'claude-hub', 'boundaries') + path.sep), settingsFile)
    const deny = (JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { permissions: { deny: string[] } }).permissions.deny
    for (const tool of ['Read', 'Edit', 'NotebookEdit']) assert.ok(deny.includes(`${tool}(${rulePath(other)})`), tool)
    assert.equal(deny.some((r) => r.includes(rulePath(neighbour)) || r.includes(rulePath(projectDir))), false, 'own folder and write neighbour are open')
    const saved = (JSON.parse(fs.readFileSync(recordsPath, 'utf-8')) as { sessions: { id: string; tier?: string }[] }).sessions
    assert.deepEqual(saved.map((s) => [s.id, s.tier]), [[audited.id, 'audit'], [guarded.id, 'guarded']])

    // Resume relaunches under the boundary as it is now.
    await core.closeDesktopSession(audited.id)
    const resumed = await core.resumeDesktopSession(audited.id)
    assert.equal(resumed.tier, 'guarded')
    assert.ok((await launchedWith(dir, ['--resume', audited.claudeSessionId])).includes('--settings'))

    // claude-hub itself (APP_ROOT) is the admin: no statement, no rules, whatever is saved.
    const admin = await createIn(core, 'hub', 'Admin', 'teal')
    assert.equal(admin.tier, 'admin')
    const adminArgs = await launchedWith(dir, ['--session-id', admin.claudeSessionId])
    for (const flag of ['--append-system-prompt', '--settings', '--add-dir']) assert.equal(adminArgs.includes(flag), false, flag)
    await core.closeDesktopSession(admin.id)

    // An unreadable boundary never launches as something weaker.
    fs.writeFileSync(path.join(dir, 'boundaries.json'), '{ nope')
    await assert.rejects(createIn(core, 'p1', 'Nope', 'teal'), /boundaries\.json is unreadable/)
    assert.equal((await core.getDesktop()).sessions.length, 3)
  } finally {
    await teardown(dir, infoPath)
  }
})

// ---- Outside sessions, take-over, resume -----------------------------------

const ps = (script: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8', windowsHide: true }).trim()
// The process's start as a FILETIME, read through a different API than the core's.
const startOf = (pid: number) => ps(`(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`)
const uuid = (n: number) => `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`

test('desktop core: outside sessions, own status from Claude Code, resume, and take-over (close vs fork)', { skip }, async () => {
  const { dir, projectDir, infoPath } = setup('takeover')
  const sessionsDir = path.join(dir, '.claude', 'sessions')
  const transcriptDir = path.join(dir, '.claude', 'projects', sanitize(projectDir))
  fs.mkdirSync(transcriptDir, { recursive: true })
  // An outside "claude.exe": node under that name, idling.
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const claudeExe = path.join(bin, 'claude.exe')
  try {
    fs.linkSync(process.execPath, claudeExe)
  } catch {
    fs.copyFileSync(process.execPath, claudeExe)
  }
  const idler = path.join(bin, 'outside.mjs')
  fs.writeFileSync(idler, 'setInterval(() => {}, 1000)\n')
  const started: number[] = []
  const startOutside = () => {
    const child = spawn(claudeExe, [idler], { windowsHide: true, stdio: 'ignore' })
    started.push(child.pid!)
    return child.pid!
  }
  const record = (pid: number, over: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(sessionsDir, `${pid}.json`),
      JSON.stringify({ pid, cwd: projectDir, kind: 'interactive', entrypoint: 'cli', name: `outside-${pid}`, status: 'idle', updatedAt: Date.now(), ...over }),
    )
  const transcript = (id: string) =>
    fs.writeFileSync(path.join(transcriptDir, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: projectDir, entrypoint: 'cli', message: { role: 'user', content: 'hi' } }) + '\n')
  // Every launch also carries the boundary statement after these.
  const argsShown = (args: string[]) => launchedWith(dir, [...args, '--append-system-prompt'])
  const byPid = (x: unknown[], y: unknown[]) => Number(x[0]) - Number(y[0])
  try {
    core.initDesktopCore(opts)

    // -- Outside listing: live interactive processes only, mapped to their target.
    const a = startOutside()
    record(a, { sessionId: uuid(1), procStart: startOf(a) })
    record(process.pid, { sessionId: uuid(90), entrypoint: 'sdk-cli' }) // headless: not listed
    record(2_000_000_000, { sessionId: uuid(91) }) // dead pid: not listed
    record(process.ppid, { sessionId: uuid(92), cwd: 'D:\\nowhere' }) // unknown folder: listed, no target
    const outside = (await core.getDesktop()).outside
    assert.equal(outside.error, null)
    assert.deepEqual(
      outside.sessions?.map((s) => [s.pid, s.sessionId, s.target, s.targetName, s.status]).sort(byPid),
      [
        [a, uuid(1), { kind: 'project', key: 'p1' }, 'proj', 'idle'],
        [process.ppid, uuid(92), null, null, 'idle'],
      ].sort(byPid),
    )

    // -- Take-over refusals: nothing is closed or started.
    const takeOpts = { name: 'Took', color: 'teal' as const, closeOld: true }
    await assert.rejects(core.takeOverSession(1.5, uuid(1), takeOpts), /Not a process id/)
    await assert.rejects(core.takeOverSession(a, 'x; calc', takeOpts), /Not a session id/)
    await assert.rejects(core.takeOverSession(a, uuid(2), takeOpts), /different conversation/)
    await assert.rejects(core.takeOverSession(process.ppid, uuid(92), takeOpts), /isn't a registered project or sandbox experiment/)
    await assert.rejects(core.takeOverSession(process.pid, uuid(90), takeOpts), /isn't an interactive/)
    await assert.rejects(core.takeOverSession(424242, uuid(1), takeOpts), /No running Claude Code session has process id 424242/)
    assert.equal(pidAlive(a), true)
    assert.equal(fs.existsSync(infoPath), false)

    // -- Idle, verified claude.exe: closed, and the same id resumes here.
    const took = await core.takeOverSession(a, uuid(1), takeOpts)
    assert.equal(took.closedOld, true)
    assert.equal(took.note, null)
    assert.equal(pidAlive(a), false)
    assert.equal(took.session.claudeSessionId, uuid(1))
    assert.deepEqual(took.session.target, { kind: 'project', key: 'p1' })
    await argsShown(['--resume', uuid(1), '--name', 'Took'])
    await assert.rejects(core.takeOverSession(a, uuid(1), takeOpts), /No running Claude Code session|already on the desktop/)

    // -- Wrapped in "cmd /c claude": the wrapper is closed with it.
    const wrapper = spawn('cmd.exe', ['/c', claudeExe, idler], { windowsHide: true, stdio: 'ignore' })
    started.push(wrapper.pid!)
    const b = await waitFor(() => Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${wrapper.pid} and Name='claude.exe'").ProcessId`)) || null, 'the wrapped claude.exe', 8000)
    record(b, { sessionId: uuid(2), procStart: startOf(b) })
    const wrapped = await core.takeOverSession(b, uuid(2), { ...takeOpts, name: 'Wrapped' })
    assert.equal(wrapped.closedOld, true)
    assert.equal(pidAlive(b), false)
    await waitFor(() => !pidAlive(wrapper.pid!), 'the cmd wrapper to exit')

    // -- A start time that doesn't match the record: left alone, forked under a new id.
    const c = startOutside()
    record(c, { sessionId: uuid(3), procStart: String(BigInt(startOf(c)) - 36_000_000_000n) })
    const mismatch = await core.takeOverSession(c, uuid(3), { ...takeOpts, name: 'Forked' })
    assert.equal(mismatch.closedOld, false)
    assert.match(mismatch.note ?? '', /didn't start when Claude Code's record says/)
    assert.equal(pidAlive(c), true)
    const forkId = mismatch.session.claudeSessionId
    assert.notEqual(forkId, uuid(3))
    await argsShown(['--resume', uuid(3), '--fork-session', '--session-id', forkId, '--name', 'Forked'])

    // -- Busy: left running, forked.
    const d = startOutside()
    record(d, { sessionId: uuid(4), procStart: startOf(d), status: 'busy' })
    const busy = await core.takeOverSession(d, uuid(4), { ...takeOpts, name: 'Busy' })
    assert.deepEqual([busy.closedOld, busy.note], [false, "It was busy, so it's still running; the conversation continues here as a fork."])
    assert.equal(pidAlive(d), true)

    // The forked-from processes are still outside sessions; the desktop's own are not.
    const after = await core.getDesktop()
    assert.deepEqual(after.outside.sessions?.map((s) => s.sessionId).sort(), [uuid(3), uuid(4), uuid(92)])

    // -- Own state from Claude Code's record for the pty's pid: busy reads as working.
    const ownPid = core.desktopPtyPid(took.session.id)
    assert.ok(ownPid && pidAlive(ownPid))
    await core.desktopInput(took.session.id, 'clear') // the stand-in's trust menu off screen
    await snap('took starting', (s) => s.sessions.find((x) => x.id === took.session.id)?.state === 'starting')
    // A conversation id no record holds, so only the pid keeps it off the outside list.
    record(ownPid, { sessionId: uuid(50), status: 'busy' })
    await snap('took working', (s) => s.sessions.find((x) => x.id === took.session.id)?.state === 'working', 5000)
    assert.equal((await core.getDesktop()).outside.sessions?.some((s) => s.pid === ownPid), false, "the pty pid is the desktop's own")

    // -- Resume a past conversation from the target's folder.
    const spec = (sessionId: string) => ({ target: { kind: 'project' as const, key: 'p1' }, mode: 'resume' as const, sessionId, name: 'Again', color: 'blue' as const })
    transcript(uuid(5))
    transcript(uuid(4))
    await assert.rejects(core.createDesktopSession(spec('nope')), /Not a session id/)
    await assert.rejects(core.createDesktopSession(spec(uuid(6))), /No conversation/)
    await assert.rejects(core.createDesktopSession(spec(uuid(4))), /another terminal \(pid \d+\); take it over instead/)
    await assert.rejects(core.createDesktopSession({ ...spec(uuid(5)), target: { kind: 'experiment', key: '..\\proj' } }), /No sandbox experiment|Couldn't list/)
    const again = await core.createDesktopSession(spec(uuid(5)))
    assert.equal(again.claudeSessionId, uuid(5))
    await argsShown(['--resume', uuid(5), '--name', 'Again'])
    await assert.rejects(core.createDesktopSession(spec(uuid(5))), /already open on the desktop as "Again"/)

    // -- Claude Code's records unreadable: outside is unknown, never "none".
    fs.rmSync(sessionsDir, { recursive: true, force: true })
    const blind = await core.getDesktop()
    assert.equal(blind.outside.sessions, null)
    assert.match(blind.outside.error ?? '', /Couldn't read Claude Code's session records/)
  } finally {
    for (const pid of started) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        // already gone
      }
    }
    await teardown(dir, infoPath)
  }
})

test('desktop core: Resume refuses a conversation another terminal holds; the outside list shows it, and take-over replaces the exited tile', { skip }, async () => {
  const { dir, projectDir, infoPath, recordsPath } = setup('conflict')
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const claudeExe = path.join(bin, 'claude.exe')
  try {
    fs.linkSync(process.execPath, claudeExe)
  } catch {
    fs.copyFileSync(process.execPath, claudeExe)
  }
  const idler = path.join(bin, 'outside.mjs')
  fs.writeFileSync(idler, 'setInterval(() => {}, 1000)\n')
  let outsidePid: number | null = null
  try {
    core.initDesktopCore(opts)
    const tile = await createIn(core, 'p1', 'Tile', 'teal')
    await core.closeDesktopSession(tile.id)
    // e.g. `claude --continue` in a terminal picked up the tile's conversation.
    const child = spawn(claudeExe, [idler], { windowsHide: true, stdio: 'ignore' })
    outsidePid = child.pid!
    fs.writeFileSync(
      path.join(dir, '.claude', 'sessions', `${outsidePid}.json`),
      JSON.stringify({ pid: outsidePid, sessionId: tile.claudeSessionId, cwd: projectDir, kind: 'interactive', entrypoint: 'cli', name: 'term', status: 'idle', updatedAt: Date.now(), procStart: startOf(outsidePid) }),
    )

    await assert.rejects(core.resumeDesktopSession(tile.id), /another terminal \(pid \d+\); take it over instead/)
    assert.equal((await core.getDesktop()).sessions[0].alive, false)
    assert.deepEqual((await core.getDesktop()).outside.sessions?.map((s) => [s.pid, s.sessionId]), [[outsidePid, tile.claudeSessionId]])

    const took = await core.takeOverSession(outsidePid, tile.claudeSessionId, { name: 'Took', color: 'blue', closeOld: true })
    assert.equal(took.closedOld, true)
    assert.equal(pidAlive(outsidePid), false)
    const saved = (JSON.parse(fs.readFileSync(recordsPath, 'utf-8')) as { sessions: { id: string; claudeSessionId: string }[] }).sessions
    assert.deepEqual(saved.map((r) => [r.id, r.claudeSessionId]), [[took.session.id, tile.claudeSessionId]], 'one record per conversation')
  } finally {
    if (outsidePid) {
      try {
        execFileSync('taskkill', ['/PID', String(outsidePid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        // already gone
      }
    }
    await teardown(dir, infoPath)
  }
})

// ---- live map vs the host ----------------------------------------------------

test("desktop core: `live` follows the host: a timed-out resume is killed; sessions it missed are found by the poll, forget and events", { skip }, async () => {
  const { dir, infoPath, recordsPath } = setup('reconcile')
  const ids = ['r1', 'r2', 'r3', 'r4']
  fs.writeFileSync(
    recordsPath,
    JSON.stringify({
      version: 2,
      sessions: ids.map((id, i) => ({ id, claudeSessionId: uuid(i + 1), name: id, color: 'teal', slot: i + 1, target: { kind: 'project', key: 'p1' }, createdAtIso: '2026-10-18T00:00:00.000Z', exitCode: 0 })),
    }),
  )
  // A stand-in host: its sessions are entries in `running`, nothing is spawned.
  // A create is never answered (the reply is lost), as after a stall.
  const running: { id: string; pid: number; prompting: boolean; line: string | null; seq: number }[] = []
  const kills: string[] = []
  const sockets = new Set<net.Socket>()
  const token = 'a'.repeat(64)
  const pipe = String.raw`\\.\pipe\claude-hub-desktop-test-${process.pid}-${Date.now()}`
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    const decoder = new LineDecoder()
    socket.on('data', (chunk: string) => {
      for (const raw of decoder.push(chunk) as { t: string; rid: number; id?: string; token?: string }[]) {
        const reply = (extra: object) => socket.write(encode({ t: 'reply', rid: raw.rid, ok: true, ...extra } as HostMessage))
        if (raw.t === 'hello') {
          if (raw.token !== token) return void socket.destroy()
          sockets.add(socket)
          socket.write(encode({ t: 'welcome', pid: process.pid }))
        } else if (raw.t === 'list') {
          reply({ sessions: running })
        } else if (raw.t === 'kill') {
          kills.push(raw.id!)
          // Meanwhile another hub instance starts r3; no event of it reaches this one.
          if (raw.id === 'r1') running.push({ id: 'r3', pid: 2_000_000_003, prompting: false, line: null, seq: 0 })
          const at = running.findIndex((s) => s.id === raw.id)
          if (at < 0) {
            socket.write(encode({ t: 'reply', rid: raw.rid, ok: false, error: 'That session is not running' }))
            continue
          }
          running.splice(at, 1)
          reply({})
          for (const s of sockets) s.write(encode({ t: 'exit', id: raw.id!, code: null }))
        } else if (raw.t === 'create') {
          running.push({ id: raw.id!, pid: 2_000_000_001, prompting: false, line: null, seq: 0 })
        } else {
          reply({})
        }
      }
    })
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(pipe, resolve))
  fs.mkdirSync(path.dirname(infoPath), { recursive: true })
  fs.writeFileSync(infoPath, JSON.stringify({ pid: process.pid, pipe, token }))
  const alive = (id: string) => (s: DesktopSnapshot) => s.host.state === 'up' && s.sessions.find((x) => x.id === id)?.alive === true
  try {
    core.initDesktopCore(opts)
    assert.equal((await core.getDesktop()).host.state, 'up')

    // A resume whose create reply never comes may have started anyway: killed.
    await assert.rejects(core.resumeDesktopSession('r1'), /did not reply in time/)
    await waitFor(() => kills.includes('r1'), 'the timed-out resume to be killed')

    // Nothing live as far as the hub knows; the poll asks the host before
    // letting go of it, and finds r3.
    await snap('r3 alive, found by the poll', alive('r3'), 8000)
    await assert.rejects(core.forgetDesktopSession('r3'), /still running/)

    // Forget asks the host too.
    running.push({ id: 'r2', pid: 2_000_000_002, prompting: false, line: null, seq: 0 })
    await assert.rejects(core.forgetDesktopSession('r2'), /still running/)

    // An event for a session the hub doesn't know: the host's list is read.
    running.push({ id: 'r4', pid: 2_000_000_004, prompting: true, line: 'Allow this?', seq: 3 })
    for (const s of sockets) s.write(encode({ t: 'prompting', id: 'r4', prompting: true, line: 'Allow this?' }))
    const asked = await snap('r4 needs-you', (s) => s.sessions.find((x) => x.id === 'r4')?.state === 'needs-you')
    assert.equal(asked.sessions.find((x) => x.id === 'r4')?.stateDetail, 'Allow this?')
  } finally {
    await teardown(dir, infoPath)
    for (const s of sockets) s.destroy()
    server.close()
  }
})
