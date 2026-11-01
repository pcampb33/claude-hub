import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Both roots redirected before the import, so the graph reads a tmp vault and a
// tmp registry instead of the real ones. Writing registry.json up front keeps
// registry.ts from seeding one (seeding `git init`s a real sandbox directory).
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-graph-vault-'))
process.env.CLAUDE_HUB_VAULT = VAULT
process.env.APP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-graph-root-'))
fs.writeFileSync(
  path.join(process.env.APP_ROOT, 'registry.json'),
  JSON.stringify([{ id: 'p1', name: 'skyrim-agent', path: 'C:\\proj\\skyrim', addedAt: '2026-07-01T00:00:00.000Z' }]),
)

const { getVaultGraph, readVaultNote } = await import('./vault-graph.ts')
const { RELATED_BEGIN, RELATED_END } = await import('./vault-related-core.ts')
const { VAULT_PATH } = await import('./vault-core.ts')

// reset() deletes everything in the vault root — prove the redirect took first.
// See vault-linker-run.test.ts for why this guard exists.
if (VAULT_PATH !== VAULT) throw new Error(`vault redirect failed: got ${VAULT_PATH}, refusing to run`)

function reset(): void {
  for (const entry of fs.readdirSync(VAULT)) fs.rmSync(path.join(VAULT, entry), { recursive: true, force: true })
}

function writeNote(id: string, content: string): void {
  fs.writeFileSync(path.join(VAULT, `${id}.md`), content)
}

const relatedBlock = (...targets: string[]) =>
  [RELATED_BEGIN, '## Related', ...targets.map((t) => `- [[${t}]]`), RELATED_END].join('\n')

// The invariant CLAUDE.md calls out by name: a materialized Related block is
// this system's own output, so counting its wikilinks as authored would inflate
// node sizes with edges nobody wrote and feed the linker its own answers.
test('a materialized Related block contributes no authored edge and no backlink', () => {
  reset()
  writeNote('alpha', `# alpha\n\nBody with a real [[beta]] link.\n\n${relatedBlock('gamma')}\n`)
  writeNote('beta', '# beta\n\nNothing links out of here.\n')
  writeNote('gamma', '# gamma\n\nNor here.\n')

  const graph = getVaultGraph()
  const alpha = graph.notes.find((n) => n.id === 'alpha')!
  const gamma = graph.notes.find((n) => n.id === 'gamma')!

  assert.deepEqual(alpha.outgoingLinks, ['beta'], 'only the hand-written link counts')
  assert.deepEqual(gamma.backlinks, [], 'a computed neighbour is not a backlink')
  assert.deepEqual(graph.notes.find((n) => n.id === 'beta')!.backlinks, ['alpha'])
  assert.equal(graph.edges.some((e) => e.target === 'gamma'), false)
})

test('a link to a note that does not exist is dropped rather than drawn as a ghost', () => {
  reset()
  writeNote('alpha', '# alpha\n\nPoints at [[beta]] and at [[never-written]].\n')
  writeNote('beta', '# beta\n')

  const graph = getVaultGraph()

  assert.deepEqual(graph.notes.find((n) => n.id === 'alpha')!.outgoingLinks, ['beta'])
  assert.deepEqual(graph.notes.map((n) => n.id).sort(), ['alpha', 'beta'])
})

test('links resolve case-insensitively and a note never links to itself', () => {
  reset()
  writeNote('alpha', '# alpha\n\nSee [[ALPHA]] and [[Beta]].\n')
  writeNote('beta', '# beta\n')

  assert.deepEqual(getVaultGraph().notes.find((n) => n.id === 'alpha')!.outgoingLinks, ['beta'])
})

// index.md is the landing page, _inbox.md the un-reviewed queue, RUBRIC.md the
// editable criteria. Any of the three rendering as a node is a visible bug, and
// every other vault reader already excludes them.
test('the landing page, the inbox and the rubric are not notes', () => {
  reset()
  writeNote('index', '# Knowledge Vault Index\n\n- [[alpha]]\n')
  writeNote('_inbox', '## queued thing\n')
  writeNote('RUBRIC', '# Vault Rubric\n')
  writeNote('alpha', '# alpha\n')

  const graph = getVaultGraph()

  assert.deepEqual(graph.notes.map((n) => n.id), ['alpha'])
  assert.deepEqual(graph.notes[0].backlinks, [], 'the index linking everywhere must not backlink everything')
})

test('frontmatter sets the project and never leaks into the excerpt', () => {
  reset()
  writeNote('alpha', '---\nproject: claude-hub\n---\n\n# Alpha heading\n\nBody.\n')
  // No frontmatter: the project is inferred from the body against the registry.
  writeNote('beta', '# Beta heading\n\nFound while working on skyrim-agent.\n')

  const graph = getVaultGraph()
  const alpha = graph.notes.find((n) => n.id === 'alpha')!

  assert.equal(alpha.project, 'claude-hub')
  assert.equal(alpha.excerpt, 'Alpha heading', 'heading markers stripped, frontmatter never seen')
  assert.equal(graph.notes.find((n) => n.id === 'beta')!.project, 'skyrim-agent')
})

test('computed sidecar edges join the web without becoming backlinks', () => {
  reset()
  writeNote('alpha', '# alpha\n')
  writeNote('beta', '# beta\n')
  fs.writeFileSync(
    path.join(VAULT, '_links.jsonl'),
    JSON.stringify({ from: 'alpha', to: 'beta', weight: 0.7, kind: 'see-also' }) + '\n',
  )

  const graph = getVaultGraph()

  assert.equal(graph.edges.length, 1)
  assert.equal(graph.edges[0].kind, 'see-also')
  assert.deepEqual(graph.notes.find((n) => n.id === 'beta')!.backlinks, [], 'node size stays an authored-only measure')
})

// The reading pane is the one place the Related block is meant to be visible —
// the strip is for the graph, not for the human.
test('readVaultNote strips frontmatter but keeps the Related block a reader wants', () => {
  reset()
  writeNote('alpha', `---\nproject: claude-hub\n---\n\n# alpha\n\nBody.\n\n${relatedBlock('beta')}\n`)
  writeNote('beta', '# beta\n')

  const text = readVaultNote('alpha')

  assert.equal(text.includes('project: claude-hub'), false)
  assert.match(text, /\[\[beta\]\]/)
})

test('readVaultNote refuses an id that is not a note in the vault', () => {
  reset()
  writeNote('alpha', '# alpha\n')
  assert.throws(() => readVaultNote('../../../etc/passwd'))
  assert.throws(() => readVaultNote('index'))
})

// The graph's "new note" ring reads createdAt. The nightly linker rewrites
// every linked note's Related block, which moves mtime — a July note lit up
// as new the morning after a relink. Birth time survives the rewrite.
test('createdAt is the birth time and survives a body rewrite that moves mtime', async () => {
  reset()
  writeNote('alpha', '# alpha\n\nFirst draft.\n')
  const before = getVaultGraph().notes.find((n) => n.id === 'alpha')!
  // Rewrite as the materializer would, after enough time for mtime to move.
  await new Promise((r) => setTimeout(r, 20))
  writeNote('alpha', `# alpha\n\nFirst draft.\n\n${relatedBlock('beta')}\n`)
  const after = getVaultGraph().notes.find((n) => n.id === 'alpha')!

  assert.equal(after.createdAt, before.createdAt)
  assert.ok(Date.parse(after.mtime) > Date.parse(before.mtime), 'the rewrite did move mtime — that is the trap')
})
