// One shared, briefly-cached read per key, for data several views each fetch
// on mount.
//
// Views are never unmounted in this app — the outgoing one is still mounted
// when the incoming one mounts — so every hook's mount effect re-runs on every
// crossing. Measured by instrumenting `window.hubApi` and walking all ten
// views twice: the second lap re-fetched 22 distinct channels, `listProjects`
// six times and `getVaultInbox` six, for data that had not changed.
//
// Deliberately not a blanket cache over the whole hubApi surface: most channels
// want to be live, and a previous global single-flight is what wedged the usage
// tile at "—". This is opt-in, per key, and expires fast.
const FRESH_MS = 10_000

interface Entry {
  request: Promise<unknown>
  startedAt: number
  settled: boolean
}

const entries = new Map<string, Entry>()

export function sharedRead<T>(key: string, read: () => Promise<T>, allowCached = true): Promise<T> {
  const existing = entries.get(key)
  // An in-flight read is joined even by a forced one — starting a second only
  // asks the same question twice. Only a settled answer can be stale.
  if (existing && (!existing.settled || (allowCached && Date.now() - existing.startedAt < FRESH_MS))) {
    return existing.request as Promise<T>
  }

  const request = read()
  const entry: Entry = { request, startedAt: Date.now(), settled: false }
  void request.then(
    () => {
      entry.settled = true
    },
    // A failed read is not an answer worth handing the next caller.
    () => {
      if (entries.get(key) === entry) entries.delete(key)
    },
  )

  entries.set(key, entry)
  return request
}
