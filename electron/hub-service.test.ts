import test from 'node:test'
import assert from 'node:assert/strict'
import { hubService, ELECTRON_ONLY_CHANNELS, PUSH_CHANNELS } from './hub-service.ts'
import { IPC_CHANNELS } from '../shared/ipc-types.ts'

// Drift guard: a channel added to IPC_CHANNELS must land in exactly one
// bucket — the transport-agnostic map (served by ipcMain AND the hub
// server) or the electron-only list (registered individually in
// ipc-handlers.ts). Catching it here means "forgot to wire the new
// channel" fails `npm test` instead of surfacing as a dead button on one
// transport.
test('every invoke channel is served or explicitly electron-only', () => {
  for (const channel of Object.values(IPC_CHANNELS)) {
    if (PUSH_CHANNELS.has(channel)) continue
    const served = channel in hubService
    const electronOnly = ELECTRON_ONLY_CHANNELS.has(channel)
    assert.ok(served || electronOnly, `channel "${channel}" has no handler in either bucket`)
    assert.ok(!(served && electronOnly), `channel "${channel}" is registered in both buckets`)
  }
})

test('push channels never appear in the service map', () => {
  for (const channel of PUSH_CHANNELS) {
    assert.ok(!(channel in hubService), `push channel "${channel}" must not have an invoke handler`)
  }
})
