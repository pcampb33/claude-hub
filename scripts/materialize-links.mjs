#!/usr/bin/env node
// Materialize the vault's computed edges (_links.jsonl) into each note's
// marker-delimited "## Related" section of [[wikilinks]], so Obsidian pointed
// at the vault gets a real graph/backlinks. claude-hub's own parsers strip
// the block (vault-related-core.ts), so app behavior is unchanged. The linker
// runs (vault-linker-run.ts) keep the blocks fresh hands-off after this
// one-time backfill; both call the same materializeRelatedBlocks routine.
// Also (re)generates the MOCs/ entry-point pages via the same writeMocs the
// linker runs call — dry-run reports what would change without writing.
//   node scripts/materialize-links.mjs --dry-run  # preview, writes NOTHING
//   node scripts/materialize-links.mjs            # backup + upsert + state fixup
//
// No LLM calls — pure fs. Electron-free imports need explicit .ts extensions
// under plain `node` (Vite resolves them transparently, Node does not).

import fs from 'node:fs'
import path from 'node:path'
import { parseLinksFile } from '../electron/vault-linker-core.ts'
import { neighborsOf, buildRelatedBlock } from '../electron/vault-related-core.ts'
import { materializeRelatedBlocks, writeMocs } from '../electron/vault-linker-run.ts'
import { VAULT_PATH } from '../electron/vault-core.ts'
const LINKS_PATH = path.join(VAULT_PATH, '_links.jsonl')
// Same candidate set as materializeRelatedBlocks: top-level notes only —
// index.md is the landing page, RUBRIC.md the curation rubric, _-prefixed
// files are queues/sidecars, subfolders (_archive, _inbox-backups) not notes.
const EXCLUDED = new Set(['index.md', '_inbox.md', 'RUBRIC.md'])

function listNoteFiles() {
  return fs
    .readdirSync(VAULT_PATH)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !EXCLUDED.has(f))
}

const links = fs.existsSync(LINKS_PATH)
  ? parseLinksFile(
      fs.readFileSync(LINKS_PATH, 'utf-8'),
      listNoteFiles().map((f) => f.slice(0, -'.md'.length)),
    )
  : []

if (process.argv.includes('--dry-run')) {
  const withNeighbors = listNoteFiles()
    .map((f) => ({ id: f.slice(0, -'.md'.length) }))
    .map(({ id }) => ({ id, neighbors: neighborsOf(links, id) }))
    .filter((n) => n.neighbors.length > 0)
    .sort((a, b) => b.neighbors.length - a.neighbors.length)
  const zeroEdge = listNoteFiles().length - withNeighbors.length
  console.log(`dry-run: ${listNoteFiles().length} notes, ${links.length} sidecar edges`)
  console.log(`${withNeighbors.length} notes would get a Related block; ${zeroEdge} edge-less notes untouched\n`)
  for (const n of withNeighbors) {
    console.log(`  ${String(n.neighbors.length).padStart(3)}  ${n.id}`)
  }
  console.log('\n--- sample blocks ---')
  for (const n of withNeighbors.slice(0, 2)) {
    console.log(`\n[${n.id}]`)
    console.log(buildRelatedBlock(n.neighbors))
  }
  console.log('\n--- MOCs ---')
  for (const m of writeMocs(true)) {
    console.log(`\n${m.changed ? 'would write' : 'unchanged'}: MOCs/${m.name}`)
    for (const heading of m.content.match(/^## .+$/gm) ?? []) {
      console.log(`  ${heading}`)
    }
  }
  console.log('\ndry-run: no files written.')
} else {
  // The vault is not git — back up every top-level note before rewriting.
  const backupDir = path.join(VAULT_PATH, '_backups', `materialize-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  fs.mkdirSync(backupDir, { recursive: true })
  for (const f of fs.readdirSync(VAULT_PATH).filter((f) => f.endsWith('.md'))) {
    fs.copyFileSync(path.join(VAULT_PATH, f), path.join(backupDir, f))
  }
  console.log(`backed up top-level notes -> ${backupDir}`)
  const { touched, skipped, edges } = materializeRelatedBlocks()
  console.log(`done: ${touched} notes touched, ${skipped} unchanged, ${edges} edges materialized`)
  for (const m of writeMocs()) {
    console.log(`MOC ${m.changed ? 'written' : 'unchanged'}: MOCs/${m.name}`)
  }
}
