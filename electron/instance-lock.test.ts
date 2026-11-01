import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { claimInstance, instancePipe } from './instance-lock.ts'

const root = (name: string) => path.join(os.tmpdir(), `instance-lock-${process.pid}-${name}`)

test('a second claim on the same APP_ROOT is refused and brings the first forward', async () => {
  const pipe = instancePipe(root('same'))
  let knocks = 0
  const first = await claimInstance(pipe, () => knocks++)
  assert.equal(first.kind, 'first')
  const second = await claimInstance(pipe, () => assert.fail('the refused claim must not listen'))
  assert.equal(second.kind, 'second')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(knocks, 1)
  if (first.kind === 'first') first.server.close()
})

test('a worktree build (another APP_ROOT) gets its own lock; case and trailing slash do not matter', async () => {
  assert.equal(instancePipe('C:\\Projects\\Hub\\'), instancePipe('c:\\projects\\hub'))
  const a = await claimInstance(instancePipe(root('main')), () => {})
  const b = await claimInstance(instancePipe(root('worktree')), () => {})
  assert.deepEqual([a.kind, b.kind], ['first', 'first'])
  for (const c of [a, b]) if (c.kind === 'first') c.server.close()
})

test('a hub that was killed leaves no stale lock', async () => {
  const pipe = instancePipe(root('killed'))
  const holder = spawn(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => console.log("up"))', pipe], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
  await new Promise((r) => holder.stdout!.once('data', r))
  assert.equal((await claimInstance(pipe, () => {})).kind, 'second')
  holder.kill()
  await new Promise((r) => holder.once('exit', r))
  const after = await claimInstance(pipe, () => {})
  assert.equal(after.kind, 'first')
  if (after.kind === 'first') after.server.close()
})
