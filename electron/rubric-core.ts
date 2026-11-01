// The curation rubric — the criteria the auto-curation Stop hook applies when
// deciding which findings from a session are worth queuing to the vault inbox.
// Lives as an editable markdown file in the vault (RUBRIC.md) so the user can
// see and change it from the app's Rubric settings view without opening an
// editor; the extractor reads it fresh on every run. Electron-free (fs/path
// only) so both the headless hook script and the IPC handlers can use it.
import fs from 'node:fs'
import path from 'node:path'
import { VAULT_PATH } from './vault-core.ts'
import type { RubricSaveResult } from '../shared/ipc-types.ts'

export const RUBRIC_PATH = path.join(VAULT_PATH, 'RUBRIC.md')

// Fallback used when RUBRIC.md is missing or empty — keeps the extractor's
// behavior stable before the file is ever created, and is what the settings
// view shows as the starting point. Kept in sync with RUBRIC.md's content.
export const DEFAULT_RUBRIC = `# Vault Rubric — what earns a permanent note

A finding is worth saving ONLY if it is one of:

- **Gotcha** — a non-obvious bug or behavior that cost real back-and-forth to
  diagnose, and would cost it again cold. (The "I lost an hour to this" test.)
- **Generalizable pattern** — a technique confirmed to work beyond the one
  task, that you'd deliberately reach for again.
- **Contradicted assumption** — an API / library / tool behaved differently
  than you (or a competent engineer in this stack) would have assumed.
- **Load-bearing decision** — a choice whose *reasoning* you'd have to
  reconstruct from scratch if you forgot it.

Reject if ANY of these is true:

- Lookable-up in ~30 seconds (docs, \`--help\`, one search).
- Something a competent engineer in this stack already knows.
- Bound to one throwaway task, with no reuse.
- It is a session summary or a narrative of what happened.
- It cannot be stated crisply in 2-3 sentences.
- It is already covered by an existing note — append, don't duplicate.

Tie-breaker: "Would future-me, hitting this cold in 6 months, save 20+ minutes
by having this note?" If no, drop it.

Every note states three things: the finding (one sentence), why it is
non-obvious, and how to apply it.
`

// Read the rubric for injection into the extraction prompt (and for display).
// Falls back to DEFAULT_RUBRIC when the file is missing or blank so extraction
// never runs with an empty ruleset.
export function readRubric(): string {
  try {
    const text = fs.readFileSync(RUBRIC_PATH, 'utf-8').trim()
    return text || DEFAULT_RUBRIC
  } catch {
    return DEFAULT_RUBRIC
  }
}

// Persist an edited rubric. Refuses a blank rubric — clearing it entirely is
// almost always a mistake, and an empty ruleset would silently degrade every
// future curation run.
export function writeRubric(text: string): RubricSaveResult {
  if (!text.trim()) return { ok: false, message: 'Rubric cannot be empty.' }
  try {
    if (!fs.existsSync(VAULT_PATH)) fs.mkdirSync(VAULT_PATH, { recursive: true })
    fs.writeFileSync(RUBRIC_PATH, `${text.trim()}\n`)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
