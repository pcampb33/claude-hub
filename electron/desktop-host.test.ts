// Integration: the real pty host under plain node, driving a stand-in for the
// Claude Code binary. Windows-only (named pipe + ConPTY).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LineDecoder, encode, type ClientRequest, type HostInfo, type HostMessage } from './desktop-protocol.ts'
import { killStandIns, pidAlive, waitFor, writeStandIn } from './desktop-test-support.ts'

const HOST = fileURLToPath(new URL('./desktop-host.ts', import.meta.url))

interface Client {
  messages: HostMessage[]
  closed: () => boolean
  send: (raw: string) => void
  request: (req: ClientRequest) => Promise<HostMessage & { t: 'reply' }>
  end: () => void
}

function connect(info: HostInfo): Client {
  const socket = net.connect(info.pipe)
  socket.setEncoding('utf8')
  const decoder = new LineDecoder()
  const messages: HostMessage[] = []
  let closed = false
  let rid = 0
  socket.on('data', (chunk: string) => messages.push(...(decoder.push(chunk) as HostMessage[])))
  socket.on('close', () => (closed = true))
  socket.on('error', () => {})
  return {
    messages,
    closed: () => closed,
    send: (raw) => socket.write(raw),
    request(req) {
      const id = ++rid
      socket.write(encode({ ...req, rid: id }))
      return waitFor(() => messages.find((m): m is HostMessage & { t: 'reply' } => m.t === 'reply' && m.rid === id), `reply to ${req.t}`)
    },
    end: () => socket.end(),
  }
}

test('desktop host: auth, data/seq, screen, prompt, input, resize, exit, idle exit', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-host-test-'))
  const infoPath = path.join(dir, 'desktop-host.json')
  const host = spawn(process.execPath, [HOST, '--info', infoPath, '--idle-ms', '700'], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CLAUDE_HUB_DESKTOP_EXE: writeStandIn(dir), CLAUDE_HUB_HEADLESS: '1', CLAUDE_CODE_CHILD_SESSION: '1' },
  })
  const hostPid = host.pid!
  try {
    const info = await waitFor(() => fs.existsSync(infoPath) && (JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as HostInfo), 'desktop-host.json')
    assert.equal(info.pid, hostPid)
    assert.match(info.token, /^[0-9a-f]{64}$/)

    const client = connect(info)
    client.send(encode({ t: 'hello', token: info.token }))
    await waitFor(() => client.messages.find((m) => m.t === 'welcome'), 'welcome')

    // A wrong token, or anything but hello first, gets the socket dropped.
    const wrong = connect(info)
    wrong.send(encode({ t: 'hello', token: 'f'.repeat(64) }))
    await waitFor(() => wrong.closed(), 'wrong-token socket to close')
    assert.equal(wrong.messages.length, 0)
    const rude = connect(info)
    rude.send(encode({ t: 'list', rid: 1 }))
    await waitFor(() => rude.closed(), 'no-hello socket to close')
    assert.equal(rude.messages.length, 0)

    const created = await client.request({ t: 'create', id: 's1', cwd: dir, args: ['--session-id', 'abc', '--name', 'my name'], cols: 80, rows: 24 })
    assert.equal(created.ok, true)
    const prompt = await waitFor(() => client.messages.find((m) => m.t === 'prompting' && m.id === 's1'), 'prompting event')
    assert.deepEqual(prompt, { t: 'prompting', id: 's1', prompting: true, line: 'Do you trust this folder?' })

    const seqs = client.messages.flatMap((m) => (m.t === 'data' && m.id === 's1' ? [m.seq] : []))
    assert.ok(seqs.length > 0)
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'seq rises by one per chunk')

    const screenReply = await client.request({ t: 'screen', id: 's1' })
    assert.ok(screenReply.ok && screenReply.screen)
    assert.equal(screenReply.screen.cols, 80)
    assert.equal(screenReply.screen.rows, 24)
    assert.ok(screenReply.screen.seq >= 1)
    assert.ok(screenReply.screen.data.includes('args:["--session-id","abc","--name","my name"]'))
    // The pty env drops the hub's headless flag and Claude Code's own vars.
    assert.ok(screenReply.screen.data.includes('env:{"headless":null,"child":null}'))

    const list = await client.request({ t: 'list' })
    assert.ok(list.ok)
    assert.ok(created.ok && Number.isInteger(created.pid) && pidAlive(created.pid!), 'create reports the pty pid')
    assert.deepEqual(list.sessions, [{ id: 's1', pid: created.pid, prompting: true, line: 'Do you trust this folder?', seq: screenReply.screen.seq }])

    await client.request({ t: 'input', id: 's1', d: 'hi' })
    await waitFor(() => client.messages.some((m) => m.t === 'data' && m.d.includes('echo:"hi"')), 'echoed input')

    await client.request({ t: 'resize', id: 's1', cols: 100, rows: 30 })
    const resized = await client.request({ t: 'screen', id: 's1' })
    assert.ok(resized.ok && resized.screen)
    assert.equal(resized.screen.cols, 100)
    assert.equal(resized.screen.rows, 30)

    // The menu leaving the screen flips prompting back, once.
    await client.request({ t: 'input', id: 's1', d: 'clear' })
    await waitFor(() => client.messages.find((m) => m.t === 'prompting' && !m.prompting), 'prompting=false')
    assert.equal(client.messages.filter((m) => m.t === 'prompting').length, 2)

    const bad = await client.request({ t: 'input', id: 'nope', d: 'x' })
    assert.deepEqual(bad.ok ? null : bad.error, 'That session is not running')

    const early = await client.request({ t: 'forget', id: 's1' })
    assert.deepEqual(early.ok ? null : early.error, 'That session is still running')

    await client.request({ t: 'input', id: 's1', d: 'quit' })
    const exit = await waitFor(() => client.messages.find((m) => m.t === 'exit'), 'exit event')
    assert.deepEqual(exit, { t: 'exit', id: 's1', code: 3 })
    const after = await client.request({ t: 'list' })
    assert.ok(after.ok)
    assert.deepEqual(after.sessions, [])
    // An exited session's last screen is still there to show.
    const last = await client.request({ t: 'screen', id: 's1' })
    assert.ok(last.ok && last.screen?.data.includes('ready>'))
    // ...until it is forgotten, which frees the screen. Forgetting is idempotent.
    assert.equal((await client.request({ t: 'forget', id: 's1' })).ok, true)
    const gone = await client.request({ t: 'screen', id: 's1' })
    assert.deepEqual(gone.ok ? null : gone.error, 'No such session on the host')
    assert.equal((await client.request({ t: 'forget', id: 'never-existed' })).ok, true)

    // No pty and no client: the host leaves after --idle-ms and takes its info file with it.
    client.end()
    await waitFor(() => !pidAlive(hostPid), 'host to exit when idle', 4000)
    assert.equal(fs.existsSync(infoPath), false)
  } finally {
    if (pidAlive(hostPid)) process.kill(hostPid)
    killStandIns(dir)
    // A just-killed pty child can hold the dir for a moment; never mask the real failure.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } catch {
      // leave it to the OS temp cleanup
    }
  }
})
