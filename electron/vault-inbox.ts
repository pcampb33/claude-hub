import fs from 'node:fs'
import path from 'node:path'
import { removeInboxEntry, writeVaultNote } from './vault-write-core.ts'
import { VAULT_PATH } from './vault-core.ts'
import type { VaultInboxEntry, VaultInboxReport, VaultWriteResult } from '../shared/ipc-types'

const INBOX_PATH = path.join(VAULT_PATH, '_inbox.md')

// The inverse of vault-write-core's queueVaultCandidate, which appends:
//   \n## {title}\n\n_{timestamp}[ — {project}] — session {sessionId} — {justification}_\n\n{content}\n
// Same entry-detection rule as hasQueuedTitle: a '## ' line only counts as
// a queued entry when the line two below is the metadata line (starts with
// '_', names the session) — candidate bodies are unsanitized markdown, so
// an H2 inside a body must not parse as an entry.
export function parseInbox(inboxText: string): VaultInboxEntry[] {
  const entries: VaultInboxEntry[] = []
  const lines = inboxText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('## ')) continue
    const meta = lines[i + 2] ?? ''
    if (!meta.startsWith('_') || !meta.includes(' — session ')) continue

    // Strip the underscore wrapping, then split on the fixed ' — session '
    // marker: left side is "timestamp[ — project]", right side is
    // "sessionId — justification".
    const inner = meta.replace(/^_/, '').replace(/_\s*$/, '')
    const sessionSplit = inner.split(' — session ')
    const left = sessionSplit[0]
    const right = sessionSplit.slice(1).join(' — session ')

    const leftDash = left.indexOf(' — ')
    const timestamp = leftDash === -1 ? left : left.slice(0, leftDash)
    const project = leftDash === -1 ? null : left.slice(leftDash + 3)

    const rightDash = right.indexOf(' — ')
    const sessionId = rightDash === -1 ? right : right.slice(0, rightDash)
    let rest = rightDash === -1 ? '' : right.slice(rightDash + 3)

    // Optional confidence segment sits between the session id and the
    // justification: "high — ...". Absent on pre-confidence entries → null.
    let confidence: VaultInboxEntry['confidence'] = null
    const confMatch = rest.match(/^(high|medium|low) — ([\s\S]*)$/)
    if (confMatch) {
      confidence = confMatch[1] as VaultInboxEntry['confidence']
      rest = confMatch[2]
    }

    entries.push({ title: line.slice(3).trim(), timestamp, project, sessionId, justification: rest, confidence })
  }
  return entries
}

// parseInbox extracts only metadata; the batch-drain job also needs each
// entry's content body (to write a promoted note and to give the dedup model
// enough to judge sameness). Same detection rule and document order as
// parseInbox, so the two arrays align 1:1 by index — we reuse parseInbox for
// metadata rather than re-parsing it, and only compute the body slices here.
export interface VaultInboxBlock extends VaultInboxEntry {
  content: string
}
export function parseInboxBlocks(inboxText: string): VaultInboxBlock[] {
  const meta = parseInbox(inboxText)
  const lines = inboxText.split('\n')
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i + 2] ?? ''
    if (lines[i].startsWith('## ') && m.startsWith('_') && m.includes(' — session ')) starts.push(i)
  }
  // Body is everything after the metadata line (start+2) up to the next entry.
  return meta.map((entry, k) => {
    const start = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length
    const content = lines.slice(start + 3, end).join('\n').trim()
    return { ...entry, content }
  })
}

// inboxPath is injectable for tests only; production callers use the default.
// Entries carry the body an approval would write (the triage card's preview).
export function getVaultInbox(inboxPath: string = INBOX_PATH): VaultInboxReport {
  if (!fs.existsSync(inboxPath)) return { count: 0, entries: [] }
  const blocks = parseInboxBlocks(fs.readFileSync(inboxPath, 'utf-8'))
  return { count: blocks.length, entries: blocks.map(({ content, ...entry }) => ({ ...entry, body: content })) }
}

// The human gate. Approve → promote the candidate's body into the vault as a
// real note (writeVaultNote: dedups/append by title against index.md), then
// drop it from the queue. Reject → just drop it. Either way the entry leaves
// _inbox.md. Nothing reaches the vault except through an approve here.
export function resolveInboxEntry(
  sessionId: string,
  title: string,
  action: 'approve' | 'reject',
  inboxPath: string = INBOX_PATH,
): VaultWriteResult {
  if (!fs.existsSync(inboxPath)) return { ok: false, message: 'Inbox is empty.' }
  const inboxText = fs.readFileSync(inboxPath, 'utf-8')
  const { text, content } = removeInboxEntry(inboxText, title, sessionId)
  if (content === null) return { ok: false, message: 'Entry not found — it may already be resolved.' }

  // Promote before removing from the queue, so a failed vault write leaves the
  // candidate queued rather than silently lost.
  // Surfaced to the caller so an approve can link the new note immediately
  // (hub-service) instead of waiting for the daily linker sweep.
  let notePath: string | undefined
  let commit: VaultWriteResult['commit']
  let message: string | undefined
  if (action === 'approve') {
    // Reuse parseInbox (already extracts the entry's project) so the originating
    // project survives into the promoted note's frontmatter instead of being
    // dropped — it's the graph's grouping key.
    const project =
      parseInbox(inboxText).find(
        (e) => e.title.toLowerCase().trim() === title.toLowerCase().trim() && e.sessionId === sessionId,
      )?.project ?? undefined
    const written = writeVaultNote(title, content, project)
    if (!written.ok) return written
    notePath = written.notePath
    // Forwarded, not dropped: an approve that wrote the note while the vault
    // commit failed is a successful write with no undo behind it, and the
    // caller cannot learn that if this function rebuilds the result from
    // scratch. Same reason the write path made it a typed field.
    commit = written.commit
    message = written.message
  }
  fs.writeFileSync(inboxPath, text)
  return { ok: true, notePath, message, commit }
}
