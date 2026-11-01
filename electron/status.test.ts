import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitize, findSessionDirs, scanSessionDirs, parseBranchHeader } from './status.ts'

// status.ts pulls in registry.ts, which SEEDS a registry.json (and git-inits a
// sandbox dir) when APP_ROOT points somewhere without one. Pin it at a tmpdir
// with a registry already in place so these tests can never touch the real one.
process.env.APP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-status-root-'))
fs.writeFileSync(path.join(process.env.APP_ROOT, 'registry.json'), '[]')

// sanitize() must mirror Claude Code's project-dir naming exactly, or
// findSessionDirs() looks in the wrong ~/.claude/projects folder and a project
// silently reports zero sessions.
test('sanitize maps drive colon, slashes, spaces and underscores to dashes', () => {
  assert.equal(sanitize('C:\\projects\\claude-hub'), 'C--projects-claude-hub')
  assert.equal(sanitize('C:\\Users\\J_doe\\Desktop\\claude projects\\bladesbanter'), 'C--Users-J-doe-Desktop-claude-projects-bladesbanter')
})

// The regression: a dot must collapse too. Real on-disk dir for
// "C:\projects\claude-hub\.claude-worktrees\agent-x" is
// "C--projects-claude-hub--claude-worktrees-agent-x" ("\." -> "--").
test('sanitize maps dots to dashes (worktrees, versioned folders)', () => {
  assert.equal(
    sanitize('C:\\projects\\claude-hub\\.claude-worktrees\\agent-x'),
    'C--projects-claude-hub--claude-worktrees-agent-x',
  )
  assert.equal(sanitize('C:\\projects\\foo.v2'), 'C--projects-foo-v2')
})

// The encoding is lossy: a session run in a SUBFOLDER of the project and a
// sibling project whose name extends it with a hyphen both produce dirs
// prefixed "<project>-". Roll up the former (else the project looks idle
// while its sandbox experiments / worktrees are active), never the latter —
// the transcript's recorded cwd is the discriminator.
test('findSessionDirs rolls up subfolder dirs but not hyphen-sibling projects', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-dirs-'))
  try {
    const exact = path.join(base, 'C--projects-claude-hub')
    fs.mkdirSync(exact)

    const sub = path.join(base, 'C--projects-claude-hub-experiments-alpha')
    fs.mkdirSync(sub)
    fs.writeFileSync(
      path.join(sub, 'a.jsonl'),
      JSON.stringify({ cwd: 'C:\\projects\\claude-hub\\experiments\\alpha' }) + '\n',
    )

    const sibling = path.join(base, 'C--projects-claude-hub-sandbox')
    fs.mkdirSync(sibling)
    fs.writeFileSync(path.join(sibling, 'b.jsonl'), JSON.stringify({ cwd: 'C:\\projects\\claude-hub-sandbox' }) + '\n')

    const dirs = findSessionDirs('C:\\projects\\claude-hub', base)
    assert.deepEqual(dirs.sort(), [exact, sub].sort())
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('findSessionDirs skips prefix dirs with no transcripts and scans past no-cwd head lines', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-dirs-'))
  try {
    // No transcripts at all → cannot prove it belongs to the project → excluded.
    // Not "unknown" either: an empty dir holds no sessions, so excluding it
    // subtracts nothing from any count.
    fs.mkdirSync(path.join(base, 'C--projects-claude-hub-mystery'))

    // First line is a summary record without cwd; a later line carries it.
    const late = path.join(base, 'C--projects-claude-hub-late-cwd')
    fs.mkdirSync(late)
    fs.writeFileSync(
      path.join(late, 'c.jsonl'),
      JSON.stringify({ type: 'summary', title: 'x' }) +
        '\n' +
        JSON.stringify({ cwd: 'C:\\projects\\claude-hub\\late-cwd' }) +
        '\n',
    )

    const scan = scanSessionDirs('C:\\projects\\claude-hub', base)
    assert.deepEqual(scan.dirs, [late])
    assert.deepEqual(scan.unknown, [])
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

// The 64K head slices a hook transcript's opening prompt line in half, the JSON
// never parses, and the dir used to be dropped from every count derived from it
// (sessionCount, Stale-14d, the heatmap). Retry wide before giving up — same
// escalation live-core.ts uses for the entrypoint marker.
test('findSessionDirs classifies a dir whose first transcript line exceeds the small head', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-dirs-'))
  try {
    const big = path.join(base, 'C--projects-claude-hub-big-prompt')
    fs.mkdirSync(big)
    // One line, cwd and all, well past 64K — exactly the shape a pasted-prompt
    // or hook transcript opens with.
    fs.writeFileSync(
      path.join(big, 'a.jsonl'),
      JSON.stringify({ cwd: 'C:\\projects\\claude-hub\\big-prompt', text: 'x'.repeat(80_000) }) + '\n',
    )

    const scan = scanSessionDirs('C:\\projects\\claude-hub', base)
    assert.deepEqual(scan.dirs, [big])
    assert.deepEqual(scan.unknown, [])
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

// The defect's other half: a dir that holds sessions but cannot be classified
// must be reported as unknown, never silently folded into a smaller total.
test('scanSessionDirs reports an unclassifiable session dir instead of dropping it', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-dirs-'))
  try {
    const good = path.join(base, 'C--projects-claude-hub')
    fs.mkdirSync(good)

    // Transcripts exist, but nothing in them parses — not even at the wide head.
    const corrupt = path.join(base, 'C--projects-claude-hub-corrupt')
    fs.mkdirSync(corrupt)
    fs.writeFileSync(path.join(corrupt, 'a.jsonl'), 'not json at all\n')

    const scan = scanSessionDirs('C:\\projects\\claude-hub', base)
    assert.deepEqual(scan.dirs, [good])
    assert.deepEqual(scan.unknown, [corrupt])
    // The confident list stays confident — an unreadable dir is never counted
    // as this project's, only named.
    assert.deepEqual(findSessionDirs('C:\\projects\\claude-hub', base), [good])
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

// getGitStatus reads the branch out of `git status -b` now instead of spending
// a second process on `rev-parse --abbrev-ref HEAD`. It has to keep answering
// what rev-parse answered, across every header git writes.
test('parseBranchHeader reads the branch out of every status -b header form', () => {
  assert.equal(parseBranchHeader('## feat/session-subagents'), 'feat/session-subagents')
  assert.equal(parseBranchHeader('## v2...origin/v2'), 'v2')
  assert.equal(parseBranchHeader('## main...origin/main [ahead 1, behind 2]'), 'main')
  // rev-parse --abbrev-ref prints "HEAD" on a detached head; so does this.
  assert.equal(parseBranchHeader('## HEAD (no branch)'), 'HEAD')
  assert.equal(parseBranchHeader('## No commits yet on master'), 'master')
})
