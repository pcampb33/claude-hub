#!/usr/bin/env node
// Direct, explicit vault write (dedup-checked against index.md) — for a
// human-driven "put this in the vault now" action. NOT used by the
// auto-curation Stop hook, which queues candidates instead; see
// curate-session.mjs.
import { writeVaultNote } from '../electron/vault-write-core.ts'

const [, , title, content] = process.argv

if (!title || !content) {
  console.error('Usage: node scripts/log-to-vault.mjs "<title>" "<content>"')
  process.exit(1)
}

const result = writeVaultNote(title, content)
console.log(JSON.stringify(result))
process.exit(result.ok ? 0 : 1)
