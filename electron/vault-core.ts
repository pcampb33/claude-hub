// Vault location + info — Electron-free so the CLI scripts and vault-graph
// (both node-loaded) can use it. The "open in Obsidian/Explorer" action
// stays in vault.ts, which needs Electron's shell.
import fs from 'node:fs'
import path from 'node:path'
import type { VaultInfo } from '../shared/ipc-types.ts'

// Overridable so a test can point the vault layer at a tmpdir — the same
// escape hatch APP_ROOT and USERPROFILE already give the registry and the
// session scans. Never set in normal use; read once at import, so a test has
// to set it before importing anything downstream of this module.
export const VAULT_PATH = process.env.CLAUDE_HUB_VAULT ?? 'C:\\projects\\claude-hub-vault'
const INDEX_PATH = path.join(VAULT_PATH, 'index.md')

const DEFAULT_INDEX = `# Knowledge Vault Index

Plain markdown notes, linked with \`[[note-name]]\`, same convention as
Claude's own memory system. Small, focused files — link liberally.

- (no notes yet)
`

export function ensureVault(): void {
  if (!fs.existsSync(VAULT_PATH)) {
    fs.mkdirSync(VAULT_PATH, { recursive: true })
  }
  if (!fs.existsSync(INDEX_PATH)) {
    fs.writeFileSync(INDEX_PATH, DEFAULT_INDEX)
  }
}

export function getVaultInfo(): VaultInfo {
  ensureVault()
  return { path: VAULT_PATH }
}
