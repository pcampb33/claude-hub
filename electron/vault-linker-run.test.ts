import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The vault layer resolves its root at import time, so the redirect has to
// happen before the dynamic import below — same shape as the APP_ROOT redirect
// in session-search.test.ts.
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-linker-'))
process.env.CLAUDE_HUB_VAULT = VAULT

const { materializeRelatedBlocks, writeMocs, recomputeLinksWith } = await import('./vault-linker-run.ts')
const { RELATED_BEGIN, RELATED_END } = await import('./vault-related-core.ts')
const { VAULT_PATH } = await import('./vault-core.ts')

// reset() deletes everything in the vault root, so prove the redirect took
// before anything here is allowed to delete a file. If a later edit turns the
// dynamic imports above into static ones, VAULT_PATH resolves before the env
// var is set and this test file would otherwise erase the real vault.
if (VAULT_PATH !== VAULT) throw new Error(`vault redirect failed: got ${VAULT_PATH}, refusing to run`)

const notePath = (id: string) => path.join(VAULT, `${id}.md`)
const statePath = path.join(VAULT, '.link-vault-state.json')
const linksPath = path.join(VAULT, '_links.jsonl')

function reset(): void {
  for (const entry of fs.readdirSync(VAULT)) fs.rmSync(path.join(VAULT, entry), { recursive: true, force: true })
}

function writeNote(id: string, body: string, project = 'claude-hub'): void {
  fs.writeFileSync(notePath(id), `---\nproject: ${project}\n---\n\n# ${id}\n\n${body}\n`)
}

function writeLinks(links: Array<{ from: string; to: string; weight?: number; kind?: string }>): void {
  fs.writeFileSync(
    linksPath,
    links.map((l) => JSON.stringify({ weight: 0.8, kind: 'see-also', ...l })).join('\n') + '\n',
  )
}

function readState(): Record<string, number> {
  return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, number>
}

// ---- materializeRelatedBlocks ----

test('materializeRelatedBlocks writes a Related block for each end of an edge, then is a no-op', () => {
  reset()
  writeNote('alpha', 'first note')
  writeNote('beta', 'second note')
  writeLinks([{ from: 'alpha', to: 'beta' }])

  const first = materializeRelatedBlocks()
  assert.equal(first.touched, 2, 'a single edge touches both endpoints')
  assert.equal(first.aborted, undefined)
  assert.match(fs.readFileSync(notePath('alpha'), 'utf-8'), /\[\[beta\]\]/)
  assert.match(fs.readFileSync(notePath('beta'), 'utf-8'), /\[\[alpha\]\]/)

  // The daily job runs whether or not anything changed, so an unchanged sweep
  // must not rewrite files — a rewrite is what makes a note look edited.
  const second = materializeRelatedBlocks()
  assert.equal(second.touched, 0)
  assert.equal(second.skipped, 2)
})

// The invariant the daily job depends on. Rewriting a note bumps its mtime; if
// the state entry were left behind, every note this job touches would look
// user-edited and get a fresh sonnet call on the next run — silently, nightly.
test('materializeRelatedBlocks advances the state entry of a note that was in sync', () => {
  reset()
  writeNote('alpha', 'first note')
  writeNote('beta', 'second note')
  writeLinks([{ from: 'alpha', to: 'beta' }])
  fs.writeFileSync(
    statePath,
    JSON.stringify({ alpha: fs.statSync(notePath('alpha')).mtimeMs, beta: fs.statSync(notePath('beta')).mtimeMs }),
  )

  materializeRelatedBlocks()

  const state = readState()
  assert.equal(state.alpha, fs.statSync(notePath('alpha')).mtimeMs, 'our own rewrite must not read as a user edit')
  assert.equal(state.beta, fs.statSync(notePath('beta')).mtimeMs)
})

// The other half: a note the user really did edit is already out of sync, and
// materializing must not quietly mark it done.
test('materializeRelatedBlocks leaves an already-dirty note still due for a re-link', () => {
  reset()
  writeNote('alpha', 'first note')
  writeNote('beta', 'second note')
  writeLinks([{ from: 'alpha', to: 'beta' }])
  // A stale recorded mtime is exactly what an edited-since-last-link note has.
  fs.writeFileSync(statePath, JSON.stringify({ alpha: 1, beta: fs.statSync(notePath('beta')).mtimeMs }))

  materializeRelatedBlocks()

  const state = readState()
  assert.equal(state.alpha, 1, 'a dirty note keeps its stale entry, so it stays pending')
  assert.notEqual(state.beta, 1)
})

test('materializeRelatedBlocks refuses to strip every block when the sidecar parses to nothing', () => {
  reset()
  writeNote('alpha', `first note\n\n${RELATED_BEGIN}\n## Related\n- [[beta]]\n${RELATED_END}`)
  writeNote('beta', `second note\n\n${RELATED_BEGIN}\n## Related\n- [[alpha]]\n${RELATED_END}`)
  // Truncated/clobbered: non-empty, but nothing survives parsing.
  fs.writeFileSync(linksPath, '{"from":"alpha","to":\n{"garbage"\n')

  const result = materializeRelatedBlocks()

  assert.ok(result.aborted, 'the wipe guard must fire')
  assert.equal(result.touched, 0)
  assert.match(fs.readFileSync(notePath('alpha'), 'utf-8'), /\[\[beta\]\]/, 'the graph survives a bad sidecar')
})

// The guard is about a *lost* edge set, not an honestly empty one — a vault
// whose notes carry no blocks yet must still be allowed to materialize nothing.
test('materializeRelatedBlocks proceeds on an empty edge set when no note carries a block', () => {
  reset()
  writeNote('alpha', 'first note')
  writeNote('beta', 'second note')
  fs.writeFileSync(linksPath, '')

  const result = materializeRelatedBlocks()

  assert.equal(result.aborted, undefined)
  assert.equal(result.touched, 0)
})

// ---- writeMocs ----

test('writeMocs generates both pages under MOCs/ and reports them unchanged on a second run', () => {
  reset()
  writeNote('alpha', 'first note', 'claude-hub')
  writeNote('beta', 'second note', 'skyrim-agent')
  writeLinks([{ from: 'alpha', to: 'beta' }])

  const first = writeMocs()
  assert.deepEqual(first.map((r) => r.name).sort(), ['By origin.md', 'Map of Content.md'])
  assert.ok(
    first.every((r) => r.changed),
    'a vault with no MOCs yet gets both written',
  )
  // The subfolder is load-bearing: every top-level *.md scan in the hub would
  // otherwise parse the generated pages back as notes.
  assert.deepEqual(fs.readdirSync(path.join(VAULT, 'MOCs')).sort(), ['By origin.md', 'Map of Content.md'])
  assert.match(fs.readFileSync(path.join(VAULT, 'MOCs', 'By origin.md'), 'utf-8'), /skyrim-agent/)

  assert.ok(
    writeMocs().every((r) => !r.changed),
    'nothing changed, so nothing is rewritten',
  )
})

test('writeMocs in dry-run mode reports the diff and writes nothing', () => {
  reset()
  writeNote('alpha', 'first note')
  writeLinks([])

  const result = writeMocs(true)

  assert.ok(result.every((r) => r.changed))
  assert.equal(fs.existsSync(path.join(VAULT, 'MOCs')), false, 'a preview must not create the folder')
})

// ---- recomputeLinks (the per-note sweep) ----

// Stale recorded mtime for `pending`, current mtimes for the rest — exactly the
// state a note edited since its last linking has, and the only way to make one
// note (not the whole vault) due for a call.
function markPending(pending: string, inSync: string[]): void {
  const state: Record<string, number> = { [pending]: 1 }
  for (const id of inSync) state[id] = fs.statSync(notePath(id)).mtimeMs
  fs.writeFileSync(statePath, JSON.stringify(state))
}

// The defect this sweep was shipped with: the parser answers [] for a reply
// that isn't JSON, the writer wrote that through, and the state advance meant
// the note was never retried — a permanent, unbacked deletion of its edges.
test('an unparseable reply keeps the note edges and leaves the note due for the next run', async () => {
  reset()
  writeNote('alpha', 'first note')
  writeNote('beta', 'second note')
  writeLinks([{ from: 'alpha', to: 'beta' }])
  markPending('alpha', ['beta'])

  const result = await recomputeLinksWith(async () => ({ text: "I'm sorry, I can't help with that." }))

  assert.match(fs.readFileSync(linksPath, 'utf-8'), /"from":"alpha","to":"beta"/, 'the edge survives')
  assert.equal(readState().alpha, 1, 'the note stays pending so the next run retries it')
  assert.match(fs.readFileSync(notePath('alpha'), 'utf-8'), /\[\[beta\]\]/, 'and the loss never reaches the body')
  assert.equal(result.ok, true)
  assert.equal(result.linkedNotes, 0, 'nothing was linked, so nothing may be counted as linked')
  assert.match(result.message ?? '', /did not parse/, 'the skip is reported, not folded into a smaller count')
})

// The other half of the distinction: zero edges IS a legitimate answer, and an
// honest one must still clear the note's stale edges and mark it done.
test('a reply that genuinely proposes no edges clears the note edges and marks it linked', async () => {
  reset()
  writeNote('alpha', 'first note')
  writeNote('beta', 'second note')
  writeLinks([{ from: 'alpha', to: 'beta' }])
  markPending('alpha', ['beta'])

  const result = await recomputeLinksWith(async () => ({ text: '{"edges": []}' }))

  assert.equal(result.linkedNotes, 1)
  assert.equal(result.edgeCount, 0)
  assert.equal(result.message, undefined, 'an answered "no edges" is not a skip')
  assert.equal(fs.readFileSync(linksPath, 'utf-8').trim(), '')
  assert.equal(readState().alpha, fs.statSync(notePath('alpha')).mtimeMs, 'a real answer marks the note done')
})

// The fence is not incidental: the models wrap JSON in ```json despite being
// told not to, so a shape check that skipped stripCodeFence would treat every
// normal reply as unparseable and silently stop linking anything.
test('a parseable reply replaces the note edges and advances its state', async () => {
  reset()
  writeNote('alpha', 'first note')
  writeNote('beta', 'second note')
  writeNote('gamma', 'third note')
  writeLinks([{ from: 'alpha', to: 'beta' }])
  markPending('alpha', ['beta', 'gamma'])

  const result = await recomputeLinksWith(async () => ({
    text: '```json\n{"edges":[{"from":"alpha","to":"gamma","weight":0.9,"kind":"causal"}]}\n```',
  }))

  assert.equal(result.linkedNotes, 1)
  const sidecar = fs.readFileSync(linksPath, 'utf-8')
  assert.match(sidecar, /"from":"alpha","to":"gamma"/)
  assert.doesNotMatch(sidecar, /beta/, 'a re-link replaces the note edges, never appends to them')
  assert.equal(readState().alpha, fs.statSync(notePath('alpha')).mtimeMs)
  assert.match(fs.readFileSync(notePath('gamma'), 'utf-8'), /\[\[alpha\]\]/)
})
