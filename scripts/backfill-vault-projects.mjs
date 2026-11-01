#!/usr/bin/env node
// Backfill `project:` frontmatter onto legacy vault notes. Run MANUALLY to
// persist the project inference (so the graph groups off a durable tag instead
// of re-deriving from text on every read). Safe and IDEMPOTENT: notes that
// already carry a `project:` tag are skipped, and notes whose project can't be
// inferred are left untouched. Nothing is deleted; each note only gains a
// leading frontmatter block. Review with `git diff` in the vault afterwards.
//
//   node scripts/backfill-vault-projects.mjs
//
// Node-executed (not bundled by Vite), so relative imports carry explicit .ts
// extensions per the repo convention.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter, deriveProject } from '../electron/vault-project.ts'
import { listProjects } from '../electron/registry.ts'

// registry.ts reads process.env.APP_ROOT lazily inside its functions; this
// script runs from its own directory, so point APP_ROOT at the app root (where
// registry.json lives) before listProjects() is ever called.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')

const VAULT_PATH = 'C:\\projects\\claude-hub-vault'
// index.md is the landing page, _inbox.md the review queue — neither is a note.
const EXCLUDED = new Set(['index.md', '_inbox.md'])

const projectNames = listProjects().map((p) => p.name)
const files = fs.existsSync(VAULT_PATH)
  ? fs.readdirSync(VAULT_PATH).filter((f) => f.endsWith('.md') && !EXCLUDED.has(f))
  : []

let tagged = 0
let already = 0
let noSignal = 0

for (const filename of files) {
  const filePath = path.join(VAULT_PATH, filename)
  const content = fs.readFileSync(filePath, 'utf-8')
  const { frontmatter, body } = parseFrontmatter(content)

  if (frontmatter.project) {
    already++
    continue
  }
  // A note with other frontmatter but no project: leave it — merging into an
  // existing block is out of scope for this one-shot; flag it for a manual look.
  if (Object.keys(frontmatter).length > 0) {
    console.log(`skip (has frontmatter, no project): ${filename}`)
    continue
  }

  const project = deriveProject(body, projectNames)
  if (!project) {
    noSignal++
    continue
  }

  fs.writeFileSync(filePath, `---\nproject: ${project}\n---\n\n${content}`)
  console.log(`tagged ${filename} -> ${project}`)
  tagged++
}

console.log(`\nDone: ${tagged} tagged, ${already} already tagged, ${noSignal} no inferable project (left null).`)
