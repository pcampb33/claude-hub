import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IPC_CHANNELS } from '../shared/ipc-types.ts'
import { buildInvokeApi, EVENT_CHANNEL_KEYS } from './preload-core.ts'

// preload.ts is the renderer's only door to the main process, and it is the one
// module that cannot be smoke-tested by launching anything: it imports
// `electron` at module scope. So a break here is invisible to every other
// check in the suite and shows up only as a dead desktop app.
// That is exactly why the generated half lives in preload-core.ts.

function recordingInvoke() {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const invoke = (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args })
    return Promise.resolve(null)
  }
  return { calls, invoke }
}

test('builds one method per invoke channel, and none for the push channels', () => {
  const { invoke } = recordingInvoke()
  const api = buildInvokeApi(invoke) as unknown as Record<string, unknown>

  const invokeKeys = Object.keys(IPC_CHANNELS).filter((k) => !(EVENT_CHANNEL_KEYS as readonly string[]).includes(k))
  assert.deepEqual(Object.keys(api).sort(), invokeKeys.sort())

  // The four push channels are subscriptions; a generated invoke method for one
  // would be a method that silently never resolves.
  for (const key of EVENT_CHANNEL_KEYS) {
    assert.equal(api[key], undefined, `${key} must not get an invoke method`)
  }
})

test('every generated member is a function', () => {
  const { invoke } = recordingInvoke()
  const api = buildInvokeApi(invoke) as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(api)) {
    assert.equal(typeof value, 'function', `${key} is not callable`)
  }
})

// The property the type system cannot check: each generated function forwards
// its own channel, and forwards its arguments in order and unaltered. A
// transposition here would type-check perfectly and break at runtime.
test('each method forwards its own channel with the arguments in order', () => {
  const { calls, invoke } = recordingInvoke()
  const api = buildInvokeApi(invoke)

  void api.setPinned('project-id', true)
  void api.searchSessions('needle', 'current-project', { startAfter: { mtimeMs: 5, sessionId: 'abc' } })
  void api.listProjects()

  assert.deepEqual(calls, [
    { channel: IPC_CHANNELS.setPinned, args: ['project-id', true] },
    {
      channel: IPC_CHANNELS.searchSessions,
      args: ['needle', 'current-project', { startAfter: { mtimeMs: 5, sessionId: 'abc' } }],
    },
    { channel: IPC_CHANNELS.listProjects, args: [] },
  ])
})

// Channel names are the wire format: main registers handlers under these exact
// strings. A generated bridge makes it easy to rename a key and silently move
// the wire name with it, so pin a few that cross the process boundary.
test('the channel strings themselves have not drifted', () => {
  assert.equal(IPC_CHANNELS.listProjects, 'registry:list')
  assert.equal(IPC_CHANNELS.setPinned, 'registry:set-pinned')
  assert.equal(IPC_CHANNELS.liveUpdate, 'live:update')
})
