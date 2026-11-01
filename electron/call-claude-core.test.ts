import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFileSync, spawn } from 'node:child_process'
import { awaitClaudeChild, callClaudeSync, claudeArgs, headlessEnv } from './call-claude-core.ts'

// Every headless `claude -p` in the hub goes through this module — curate
// triage/extract, inbox drain, both linker paths, the recall worker. The two
// things that make those calls safe are invisible at the call site and cannot
// be checked without spawning a real model, so they are checked here instead.

// The guard the whole automation spine rests on. Without it, a hub `claude -p`
// call trips the global vault-recall UserPromptSubmit hook, which spawns its
// own `claude -p`. The incremental linker shipped without this for a month.
test('headlessEnv marks the child as hub automation', () => {
  assert.equal(headlessEnv().CLAUDE_HUB_HEADLESS, '1')
})

test('headlessEnv inherits the parent environment rather than replacing it', () => {
  // A replaced env loses PATH, which is how `claude` (a .cmd shim on Windows)
  // is found at all.
  process.env.HUB_TEST_INHERITED = 'yes'
  try {
    assert.equal(headlessEnv().HUB_TEST_INHERITED, 'yes')
  } finally {
    delete process.env.HUB_TEST_INHERITED
  }
})

// The user-env API key belongs to another project; inheriting it made every
// hub call bill that account and fail once its spend limit was hit.
test('headlessEnv drops ANTHROPIC_API_KEY so the child uses the claude.ai login', () => {
  const saved = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    assert.equal('ANTHROPIC_API_KEY' in headlessEnv(), false)
    assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-test', 'the parent environment is left alone')
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  }
})

test('claudeArgs asks for the json envelope, which is where per-call cost comes from', () => {
  assert.deepEqual(claudeArgs('haiku'), ['-p', '--model', 'haiku', '--output-format', 'json'])
})

// The spawn uses shell:true (unavoidable: `claude` is a .cmd shim), so an argv
// entry carrying user or model text would be a real injection surface. The
// prompt goes through stdin; argv is fixed literals plus a model name.
test('claudeArgs never carries the prompt — only fixed literals and the model', () => {
  const prompt = 'a" & echo pwned & rem "'
  assert.equal(claudeArgs('sonnet').includes(prompt), false)
  assert.deepEqual(
    claudeArgs('sonnet').filter((arg) => arg !== 'sonnet'),
    ['-p', '--model', '--output-format', 'json'],
  )
})

// A stand-in for execFileSync, in the same spirit as fakeChild below: the sync
// deadline is an options field nobody can see from the call site, and letting a
// real `claude` hang to prove it costs a model call per test run.
type SyncExecCall = { file: string; args: readonly string[]; options: { timeout?: number; input?: string } }

function fakeExec(respond: () => string) {
  const calls: SyncExecCall[] = []
  const exec = (file: string, args: readonly string[], options: SyncExecCall['options']) => {
    calls.push({ file, args, options })
    return respond()
  }
  return { calls, asExec: exec as unknown as typeof execFileSync }
}

// spawnSync's shape for its own deadline, measured rather than guessed
// (Windows, shell:true): a null status and SIGTERM under code ETIMEDOUT, where
// a nonzero exit carries a status and no code.
const etimedout = () =>
  Object.assign(new Error('spawnSync C:\\WINDOWS\\system32\\cmd.exe ETIMEDOUT'), {
    code: 'ETIMEDOUT',
    status: null,
    signal: 'SIGTERM',
  })

// The defect: four of the five sync call sites pass no timeout, so the deadline
// was `undefined` — unbounded. The hook harness killed the node process instead,
// which is why 304 of 1681 curate runs (18.1%) logged no outcome at all.
test('a sync call with no timeout still gets the default deadline', () => {
  const exec = fakeExec(() => JSON.stringify({ result: 'answered', total_cost_usd: 0.5 }))
  assert.deepEqual(callClaudeSync('haiku', 'the prompt', {}, exec.asExec), { text: 'answered', costUsd: 0.5 })
  assert.equal(exec.calls[0].options.timeout, 5 * 60 * 1000)
  // The prompt rides stdin, never argv — the spawn is shell:true.
  assert.equal(exec.calls[0].options.input, 'the prompt')
  assert.equal(exec.calls[0].args.includes('the prompt'), false)
})

test('an explicit timeout still wins over the default', () => {
  const exec = fakeExec(() => JSON.stringify({ result: 'ok', total_cost_usd: 0 }))
  callClaudeSync('haiku', 'p', { timeoutMs: 60_000 }, exec.asExec)
  assert.equal(exec.calls[0].options.timeout, 60_000)
})

// Callers log err.message and nothing else useful (a timeout has no .status),
// so spawnSync's own wording would tell them a spawn of cmd.exe failed — naming
// the wrapper, not the model call that hung.
test('a sync timeout is named as a timeout, not left as spawnSync wrapper noise', () => {
  const exec = fakeExec(() => {
    throw etimedout()
  })
  assert.throws(
    () => callClaudeSync('sonnet', 'p', {}, exec.asExec),
    (error: Error) =>
      /claude -p timed out after 300000ms/.test(error.message) && !/ETIMEDOUT|cmd\.exe/.test(error.message),
  )
})

// The other half of distinguishable: an answer of no must not start reading as
// nobody answering. Rethrown as-is, so .status survives for the callers' logs.
test('a nonzero exit is passed through untouched, never renamed as a timeout', () => {
  const failure = Object.assign(new Error('Command failed: claude -p'), { status: 2 })
  const exec = fakeExec(() => {
    throw failure
  })
  let caught: unknown
  try {
    callClaudeSync('sonnet', 'p', {}, exec.asExec)
  } catch (error) {
    caught = error
  }
  assert.equal(caught, failure)
  assert.equal((caught as { status: number }).status, 2)
  assert.doesNotMatch((caught as Error).message, /timed out/)
})

// Both variants share one phrasing on purpose. A caller that learns to
// recognise a deadline from one of them must not miss it from the other.
test('sync and async name their deadline identically', async () => {
  const exec = fakeExec(() => {
    throw etimedout()
  })
  let syncMessage = ''
  try {
    callClaudeSync('haiku', 'p', { timeoutMs: 10 }, exec.asExec)
  } catch (error) {
    syncMessage = (error as Error).message
  }
  const asyncMessage = ((await settlement(awaitClaudeChild(asChild(fakeChild()), 'p', 10))) as Error).message
  assert.equal(syncMessage, asyncMessage)
})

// A stand-in for the spawned child. Deliberately has no `pid`: the real
// deadline also tree-kills via taskkill, and a fake pid would have these tests
// spawn a real one. What it does expose is the kill count, which is the only
// way to tell a deadline that stopped the model call from one that just gave
// up on it.
function fakeChild() {
  const stdin = Object.assign(new EventEmitter(), {
    written: [] as string[],
    ended: false,
    write(chunk: string) {
      stdin.written.push(chunk)
      return true
    },
    end() {
      stdin.ended = true
    },
  })
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin,
    kills: 0,
    kill() {
      child.kills += 1
      return true
    },
  })
  return child
}

const asChild = (fake: ReturnType<typeof fakeChild>) => fake as unknown as ChildProcessWithoutNullStreams

const settlement = (promise: Promise<unknown>) => promise.then(() => null, (error: Error) => error)

const envelope = (result: string) => Buffer.from(JSON.stringify({ result, total_cost_usd: 0.5 }))

test('a clean exit still resolves through the json envelope, prompt via stdin', async () => {
  const child = fakeChild()
  const pending = awaitClaudeChild(asChild(child), 'the prompt', 60_000)
  child.stdout.emit('data', envelope('answered'))
  child.emit('close', 0)
  assert.deepEqual(await pending, { text: 'answered', costUsd: 0.5 })
  assert.deepEqual(child.stdin.written, ['the prompt'])
  assert.equal(child.stdin.ended, true)
})

// The defect this file's deadline exists for: without it a `claude` that never
// answers leaves this promise pending forever, and the Knowledge view's
// "Relinking…" with it.
test('a hung call rejects on the deadline and kills the child', async () => {
  const child = fakeChild()
  const error = await settlement(awaitClaudeChild(asChild(child), 'prompt', 10))
  assert.ok(error instanceof Error)
  assert.match(error.message, /timed out after 10ms/)
  assert.equal(child.kills, 1, 'a deadline that leaves the model call running is half a fix')
})

// "Timed out" and "exited nonzero" are different facts about the call and must
// not read alike — one is nobody answering, the other is an answer of no.
test('the timeout rejection is distinguishable from an exit-code failure', async () => {
  const hung = fakeChild()
  const failed = fakeChild()
  // settlement() before the emit: it attaches the rejection handler, and a
  // rejection nobody is listening for yet is an unhandled one.
  const pending = settlement(awaitClaudeChild(asChild(failed), 'prompt', 60_000))
  failed.stderr.emit('data', Buffer.from('boom'))
  failed.emit('close', 2)
  const timedOut = await settlement(awaitClaudeChild(asChild(hung), 'prompt', 10))
  const exited = await pending
  assert.match((exited as Error).message, /exited 2: boom/)
  assert.doesNotMatch((exited as Error).message, /timed out/)
  assert.doesNotMatch((timedOut as Error).message, /exited/)
})

// Killing the child produces a 'close' of its own, so the losing race here is
// real, not hypothetical.
test('a close arriving after the timeout cannot turn the failure into a result', async () => {
  const child = fakeChild()
  const pending = awaitClaudeChild(asChild(child), 'prompt', 10)
  assert.match(((await settlement(pending)) as Error).message, /timed out/)
  child.stdout.emit('data', envelope('late'))
  child.emit('close', 0)
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(((await settlement(pending)) as Error).message, /timed out/)
  assert.equal(child.kills, 1, 'the deadline fired once and was cleared')
})

// A pid is reusable the moment its process exits, so a deadline left armed
// past a finished call would eventually taskkill /T /F whatever inherited it —
// and hold the event loop open until it did.
test('a settled call disarms the deadline — no late kill', async () => {
  const child = fakeChild()
  const pending = awaitClaudeChild(asChild(child), 'prompt', 10)
  child.stdout.emit('data', envelope('fast'))
  child.emit('close', 0)
  assert.deepEqual(await pending, { text: 'fast', costUsd: 0.5 })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(child.kills, 0)
})

// child.on('error') covers the ChildProcess, not its stdin. A `claude` that
// dies before reading the prompt raises EPIPE on the stream, and an
// EventEmitter with no 'error' listener throws out of the event loop — so this
// emit would take down the Electron main process rather than fail the call.
test('an EPIPE on stdin rejects the call instead of crashing the process', async () => {
  const child = fakeChild()
  const pending = awaitClaudeChild(asChild(child), 'prompt', 60_000)
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  child.stdin.emit('error', epipe)
  assert.equal(await settlement(pending), epipe)
})

// The fakes above have no pid, so they can't see the order of the two kills.
// A real shell:true tree can: kill() the cmd.exe wrapper first and taskkill /T
// finds no process to walk, leaving the grandchild (here ping, standing in for
// `claude`) running. Hidden and non-detached, so it opens no window.
test('a timed-out shell child is killed with its whole tree', async () => {
  const child = spawn('ping -n 60 127.0.0.1', { shell: true, windowsHide: true })
  const grandchildren = () =>
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}").ProcessId`],
      { encoding: 'utf-8', windowsHide: true },
    ).trim()
  const error = await settlement(awaitClaudeChild(child, 'prompt', 1500))
  assert.match((error as Error).message, /timed out/)
  // Not 'close': with the wrapper dead and the tree alive, the grandchild holds
  // the pipes and 'close' waits for it to exit on its own, which reads as a pass.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const left = grandchildren()
  if (left) for (const pid of left.split(/\s+/)) execFileSync('taskkill', ['/pid', pid, '/F'], { windowsHide: true })
  assert.equal(left, '', 'the grandchild outlived the deadline')
})
