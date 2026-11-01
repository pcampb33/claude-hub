#!/usr/bin/env node
// Vault linker backfill. Reads every top-level note in the knowledge vault,
// asks one sonnet call to propose the weighted connections between them, and
// writes the result to the _links.jsonl sidecar the Knowledge graph merges in
// (electron/vault-graph.ts). Notes stay clean, Obsidian-compatible markdown —
// all edge data lives in the recomputable sidecar. Run manually:
//   node scripts/link-vault.mjs                # whole-corpus backfill
//   node scripts/link-vault.mjs --incremental  # only new/changed notes (per-note
//                                              # calls via vault-linker-run.ts) —
//                                              # the scheduled hands-off mode
//
// Electron-free imports need explicit .ts extensions under plain `node` (Vite
// resolves them transparently, Node's native TS support does not).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter } from '../electron/vault-project.ts'
import { stripRelatedBlock } from '../electron/vault-related-core.ts'
import { buildLinkPrompt, parseLinkOutput } from '../electron/vault-linker-core.ts'
import { recomputeLinks } from '../electron/vault-linker-run.ts'
import { callClaudeSync } from '../electron/call-claude-core.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const VAULT_PATH = 'C:\\projects\\claude-hub-vault'
const LINKS_PATH = path.join(VAULT_PATH, '_links.jsonl')
// Same exclusions as vault-graph.ts: the index page and the curation queue are
// not notes. (_links.jsonl is skipped for free — only *.md is read.)
const EXCLUDED = new Set(['index.md', '_inbox.md'])
const LOG_PATH = path.join(__dirname, 'link-vault.log')

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`
  console.log(line)
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`)
  } catch {
    /* logging must never break the run */
  }
}

function fmtCost(costUsd) {
  return costUsd == null ? 'n/a' : `$${costUsd.toFixed(4)}`
}

function readNotes() {
  return fs
    .readdirSync(VAULT_PATH)
    .filter((f) => f.endsWith('.md') && !EXCLUDED.has(f))
    .map((f) => ({
      id: f.slice(0, -'.md'.length),
      // Strip the materialized "## Related" block so the model never reads
      // its own prior output back as note content.
      content: stripRelatedBlock(parseFrontmatter(fs.readFileSync(path.join(VAULT_PATH, f), 'utf-8')).body).trim(),
    }))
}

function main() {
  const notes = readNotes()
  if (notes.length === 0) {
    log('no notes found; nothing to link')
    return
  }
  log(`linking ${notes.length} notes via sonnet…`)

  const { text, costUsd } = callClaudeSync('sonnet', buildLinkPrompt(notes))
  const edges = parseLinkOutput(text, notes.map((n) => n.id))

  if (edges.length === 0) {
    // Don't clobber an existing sidecar with an empty result — a transient
    // no-edge reply shouldn't wipe good links from a prior backfill.
    log(`model proposed no valid edges (cost=${fmtCost(costUsd)}); leaving sidecar untouched`)
    return
  }

  fs.writeFileSync(LINKS_PATH, `${edges.map((e) => JSON.stringify(e)).join('\n')}\n`)
  log(`wrote ${edges.length} edges to ${LINKS_PATH} (cost=${fmtCost(costUsd)})`)
}

async function incremental() {
  log('incremental link sweep…')
  const result = await recomputeLinks()
  if (!result.ok) {
    log(`FAILED: ${result.message}`)
    process.exit(1)
  }
  log(`re-linked ${result.linkedNotes} stale note(s); sidecar holds ${result.edgeCount} edges`)
  // Notes skipped because the model reply would not parse. linkOne reports each
  // one on stderr, which the 04:30 scheduled task does not capture — so without
  // this the log shows a smaller number and no reason for it, which is the same
  // absence-for-a-failure the skip was added to prevent.
  if (result.message) log(result.message)
}

try {
  if (process.argv.includes('--incremental')) {
    await incremental()
  } else {
    main()
  }
} catch (err) {
  log(`FAILED: ${err?.message ?? err}`)
  process.exit(1)
}
