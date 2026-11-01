import { IPC_CHANNELS, type HubApi } from '../shared/ipc-types.ts'

// The renderer half of the typed IPC contract, minus Electron.
//
// preload.ts used to spell out all 69 invoke methods by hand, each one the
// same line: `name: (...args) => ipcRenderer.invoke(IPC_CHANNELS.name, ...args)`.
// Git says what that cost — preload.ts and shared/ipc-types.ts changed together
// in 28 commits, 70% of every commit that touched either, by far the strongest
// co-change pair in the repo. Adding one channel meant editing four files, and
// this was the file that carried no decision, only transcription.
//
// Split out from preload.ts so it can be tested: preload.ts imports `electron`
// at module scope and cannot load under `node --test`. Same reasoning as
// launch-core.ts and live-core.ts.

// The push channels are subscriptions, not request/response calls. The
// renderer reaches them through hubApi.on*, which preload still writes out by
// hand — each one wraps a listener and returns an unsubscribe.
export const EVENT_CHANNEL_KEYS = ['sandboxJobsChanged', 'verifyJobsChanged', 'liveUpdate', 'desktopUpdate', 'desktopData'] as const

type EventChannelKey = (typeof EVENT_CHANNEL_KEYS)[number]
type EventMethod = 'onSandboxJobsChanged' | 'onVerifyJobsChanged' | 'onLiveUpdate' | 'onDesktopUpdate' | 'onDesktopData'

/** Every HubApi member that is a plain invoke — all of them but the three subscriptions. */
export type InvokeApi = Omit<HubApi, EventMethod>
export type InvokeChannelKey = Exclude<keyof typeof IPC_CHANNELS, EventChannelKey>

// Compile-time proof that the channel map and the API still describe the same
// surface. This is the guarantee the hand-written list bought and the reason
// generating it is not a downgrade: adding a method to HubApi without a
// channel — or a channel without a method — was a tsc error before and still
// is. The error just lands here instead of on a missing property.
// Stated as two `extends never` constraints rather than one boolean equality
// so the compiler error names the offending key ("registry:foo does not
// satisfy never") instead of the useless "Type 'false' does not satisfy 'true'".
type Unmatched<T extends never> = T
export type _EveryApiMethodHasAChannel = Unmatched<Exclude<keyof InvokeApi, InvokeChannelKey>>
export type _EveryChannelHasAnApiMethod = Unmatched<Exclude<InvokeChannelKey, keyof InvokeApi>>

export type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>

export function buildInvokeApi(invoke: Invoke): InvokeApi {
  const keys = (Object.keys(IPC_CHANNELS) as (keyof typeof IPC_CHANNELS)[]).filter(
    (key): key is InvokeChannelKey => !(EVENT_CHANNEL_KEYS as readonly string[]).includes(key),
  )
  // The one thing the hand-written list did not need. Keys are proven above,
  // but nothing type-checks that each generated function's parameters match its
  // HubApi signature — they do, trivially, because every one forwards its
  // arguments in order, and preload-core.test.ts pins that it keeps doing so.
  return Object.fromEntries(keys.map((key) => [key, (...args: unknown[]) => invoke(IPC_CHANNELS[key], ...args)])) as InvokeApi
}
