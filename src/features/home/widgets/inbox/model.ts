import type { VaultInboxEntry, VaultWriteResult } from '../../../../../shared/ipc-types'

// An inbox entry's identity — what resolveInboxEntry keys on. Indexes shift
// as entries are resolved, so in-flight state is tracked by this instead.
export function entryKey(e: VaultInboxEntry): string {
  return `${e.sessionId}\u0000${e.title}`
}

export function shortTitle(title: string, max = 48): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title
}

// What to tell the user after a vault write. `ok: false` is a failure even
// though the call resolved, and a write whose commit failed landed with no
// undo — neither may read as a clean success.
export function writeToast(result: VaultWriteResult, success: string): { kind: 'success' | 'error'; message: string } {
  if (!result.ok) return { kind: 'error', message: result.message ?? 'The vault write failed.' }
  if (result.commit?.kind === 'failed') {
    return { kind: 'error', message: `${success}, but the vault commit failed — no undo for this one. ${result.commit.message}` }
  }
  return { kind: 'success', message: success }
}
