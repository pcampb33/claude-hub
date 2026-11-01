// Tests must never call getConfigHealth/getCrossProjectRedundancy — they hit
// listProjects(), which requires process.env.APP_ROOT and seeds the real
// registry (including a `git init` of C:\projects\claude-hub-sandbox) as a
// side effect. Test at the auditFile/pure-function seam only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { countTokens } from 'gpt-tokenizer'
import { auditFile, splitSections, computeScore, findCrossProjectRedundancy } from './config-health.ts'
import type { ConfigHealthFinding } from '../shared/ipc-types.ts'

// buildRepoIndex runs `git rev-parse --show-toplevel` from the fixture dir, and
// git walks UP until it finds a repo. Tests that want the no-repo path were
// getting whatever repo happened to sit above the temp dir instead — on this
// machine a stray `git init` in %TEMP% made three of them enumerate 157k
// unrelated files and take 26s each (79s of an 80s file). They still passed,
// but through the repo-index branch rather than the null-index branch they
// name. Stopping the walk at the tmpdir makes the no-repo condition a property
// of the test rather than of the machine; the two tests that DO `git init`
// their own fixture are unaffected, since the ceiling only bounds the walk
// above tmpdir, not the fixture dir itself.
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir()

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'confighealth-'))
}

function writeClaudeMd(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content)
}

function audit(dir: string) {
  return auditFile(path.join(dir, 'CLAUDE.md'), 'project', [])
}

// Other heuristics may legitimately co-fire on the same fixture, so every
// assertion filters to the kind under test.
function ofKind(findings: ConfigHealthFinding[], kind: ConfigHealthFinding['kind']): ConfigHealthFinding[] {
  return findings.filter((f) => f.kind === kind)
}

function makeFinding(kind: ConfigHealthFinding['kind'], severity: ConfigHealthFinding['severity']): ConfigHealthFinding {
  return {
    id: `test:${kind}:${severity}`,
    source: 'project',
    sectionHeading: null,
    kind,
    severity,
    excerpt: '',
    detail: '',
    estimatedTokens: null,
  }
}

// ~30-word paragraph pair differing by one word — Jaccard on 3-word shingles
// is ~0.8, well over the 0.3 redundancy threshold, and each is >=50 chars.
// Deliberately avoids skill-shape trigger words ("when you", "steps:",
// "workflow", "follow these") and read-verb + .md constructions.
const PARAGRAPH_A =
  'The quick brown fox jumps over the lazy dog while the calm river flows gently past the old stone bridge under a bright summer sky full of drifting white clouds'
const PARAGRAPH_B = PARAGRAPH_A.replace('summer', 'winter')

// ~300 varied words — clearly over the 200-token oversized threshold under
// real gpt-tokenizer counts.
const BIG_BODY = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')

// --- splitSections ---

test('splitSections: LF input yields one section per ##/### heading', () => {
  const sections = splitSections('## A\nbody a\n### B\nbody b')
  assert.equal(sections.length, 2)
  assert.equal(sections[0].heading, 'A')
  assert.equal(sections[0].body.trim(), 'body a')
  assert.equal(sections[1].heading, 'B')
  assert.equal(sections[1].body.trim(), 'body b')
})

test('splitSections: CRLF input parses identically to LF, no \\r leaks into bodies', () => {
  const lf = splitSections('## A\nbody a\n### B\nbody b')
  const crlf = splitSections('## A\r\nbody a\r\n### B\r\nbody b')
  assert.deepEqual(crlf, lf)
  assert.deepEqual(crlf.map((s) => s.heading), ['A', 'B'])
  for (const s of crlf) assert.ok(!s.body.includes('\r'), 'body must not contain \\r')
})

test('splitSections: # and #### are not headings; pre-heading content gets heading null', () => {
  const sections = splitSections('intro text\n# H1\nmore intro\n## A\n#### H4\nbody after h4')
  assert.equal(sections.length, 2)
  assert.equal(sections[0].heading, null)
  assert.ok(sections[0].body.includes('# H1'))
  assert.ok(sections[0].body.includes('more intro'))
  assert.equal(sections[1].heading, 'A')
  assert.ok(sections[1].body.includes('#### H4'))
  assert.ok(sections[1].body.includes('body after h4'))
})

// --- auditFile CRLF end-to-end ---

test('auditFile: CRLF file with an oversized section keeps its real heading and a \\r-free excerpt', () => {
  const dir = makeTempDir()
  try {
    writeClaudeMd(dir, ['## Heading', BIG_BODY].join('\r\n') + '\r\n')
    const { findings } = audit(dir)
    const oversized = ofKind(findings, 'oversized-section')
    assert.equal(oversized.length, 1)
    assert.equal(oversized[0].sectionHeading, 'Heading')
    assert.ok(!oversized[0].excerpt.includes('\r'), 'excerpt must not contain \\r')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('auditFile: CRLF file with only small sections produces no oversized findings', () => {
  const dir = makeTempDir()
  try {
    writeClaudeMd(dir, '## One\r\nshort body text\r\n## Two\r\nanother small body\r\n## Three\r\na third tiny body\r\n')
    const { findings } = audit(dir)
    assert.equal(ofKind(findings, 'oversized-section').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- stale-reference ---

test('stale-reference: placeholder and glob refs are skipped', () => {
  const dir = makeTempDir()
  try {
    writeClaudeMd(
      dir,
      'Modules live in `electron/<name>.ts` and `*-core.ts` files, hooks in `use<Name>.ts`, and `${VAR}/x.ts` templates\n',
    )
    const { findings } = audit(dir)
    assert.equal(ofKind(findings, 'stale-reference').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stale-reference: an ellipsis-elided path and a ~-home path are skipped (illustrative / unresolvable)', () => {
  // Regression: skyrim-agent's `~/.claude/.../MEMORY.md` was flagged stale and
  // cost 8 points — the '...' is an elision and '~' is never expanded, so
  // neither is a checkable literal-path claim.
  const dir = makeTempDir()
  try {
    writeClaudeMd(dir, 'Auto-memory lives at `~/.claude/.../MEMORY.md` and config under `~/.config/app.json`\n')
    const { findings } = audit(dir)
    assert.equal(ofKind(findings, 'stale-reference').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stale-reference: a two-dot "../x.md" parent ref is still checked (three-dot guard must not catch it)', () => {
  const dir = makeTempDir()
  try {
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub', 'CLAUDE.md'), 'History in `../gone.md` upstream\n')
    const { findings } = auditFile(path.join(dir, 'sub', 'CLAUDE.md'), 'project', [])
    const stale = ofKind(findings, 'stale-reference')
    assert.equal(stale.length, 1)
    assert.equal(stale[0].excerpt, '../gone.md')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stale-reference: a bare filename with no separator is a prose mention, not a path claim', () => {
  const dir = makeTempDir()
  try {
    writeClaudeMd(dir, 'The `sessions.ts` module handles transcript parsing\n')
    const { findings } = audit(dir)
    assert.equal(ofKind(findings, 'stale-reference').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stale-reference: a relative path that exists next to the CLAUDE.md is not flagged', () => {
  const dir = makeTempDir()
  try {
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', 'foo.md'), '# Foo\n')
    writeClaudeMd(dir, 'Roadmap details live in `docs/foo.md` for planning\n')
    const { findings } = audit(dir)
    assert.equal(ofKind(findings, 'stale-reference').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stale-reference: a missing relative path in a non-repo dir is flagged (null repo index)', () => {
  const dir = makeTempDir()
  try {
    writeClaudeMd(dir, 'Roadmap details live in `docs/missing.md` for planning\n')
    const { findings } = audit(dir)
    const stale = ofKind(findings, 'stale-reference')
    assert.equal(stale.length, 1)
    assert.equal(stale[0].severity, 'warn')
    assert.equal(stale[0].excerpt, 'docs/missing.md')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stale-reference: the git repo file index rescues a ref that misses existsSync against baseDir', () => {
  const dir = makeTempDir()
  try {
    execFileSync('git', ['init'], { cwd: dir })
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n')
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub', 'CLAUDE.md'), 'Full details live in `docs/guide.md` at the repo root\n')
    const { findings } = auditFile(path.join(dir, 'sub', 'CLAUDE.md'), 'project', [])
    assert.equal(ofKind(findings, 'stale-reference').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stale-reference: the repo index does not over-rescue a path missing from the repo too', () => {
  const dir = makeTempDir()
  try {
    execFileSync('git', ['init'], { cwd: dir })
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n')
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub', 'CLAUDE.md'), 'Full details live in `docs/nope.md` at the repo root\n')
    const { findings } = auditFile(path.join(dir, 'sub', 'CLAUDE.md'), 'project', [])
    const stale = ofKind(findings, 'stale-reference')
    assert.equal(stale.length, 1)
    assert.equal(stale[0].excerpt, 'docs/nope.md')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stale-reference: absolute paths — existing is clean, missing is flagged', () => {
  // Absolute Windows paths contain backslashes (a separator, so the
  // bare-filename skip does not trip) and no <>*{}$ characters (so the
  // placeholder skip does not trip either).
  const dir = makeTempDir()
  try {
    const claudeMdPath = path.join(dir, 'CLAUDE.md')
    const missingAbs = path.join(dir, 'nowhere.md')
    fs.writeFileSync(claudeMdPath, 'Config lives at `' + claudeMdPath + '` and history at `' + missingAbs + '`\n')
    const { findings } = audit(dir)
    const stale = ofKind(findings, 'stale-reference')
    assert.equal(stale.length, 1)
    assert.equal(stale[0].excerpt, missingAbs)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stale-reference: markdown links are checked, http links are skipped', () => {
  const dir = makeTempDir()
  try {
    writeClaudeMd(dir, 'History in [g](./docs/gone.md) and docs at [d](https://example.com/x.md)\n')
    const { findings } = audit(dir)
    const stale = ofKind(findings, 'stale-reference')
    assert.equal(stale.length, 1)
    assert.equal(stale[0].excerpt, './docs/gone.md')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- unconditional-read ---

test('unconditional-read: an unconditional "read X" instruction is flagged', () => {
  const dir = makeTempDir()
  try {
    fs.mkdirSync(path.join(dir, 'notes'))
    fs.writeFileSync(path.join(dir, 'notes', 'context.md'), 'context notes\n')
    writeClaudeMd(dir, 'Always read `notes/context.md` at start.\n')
    const { findings } = audit(dir)
    const reads = ofKind(findings, 'unconditional-read')
    assert.equal(reads.length, 1)
    assert.equal(reads[0].severity, 'warn')
    assert.ok(reads[0].excerpt.includes('notes/context.md'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unconditional-read: a leading conditional marker suppresses the finding', () => {
  const dir = makeTempDir()
  try {
    fs.mkdirSync(path.join(dir, 'notes'))
    fs.writeFileSync(path.join(dir, 'notes', 'release.md'), 'release notes\n')
    writeClaudeMd(dir, 'When doing release work, read `notes/release.md` for background.\n')
    const { findings } = audit(dir)
    assert.equal(ofKind(findings, 'unconditional-read').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unconditional-read: a trailing conditional after the path suppresses the finding', () => {
  // Regression: the sentence-end search previously stopped at the first '.'
  // after the match START — the '.' inside `x.md` itself — so a trailing
  // conditional clause was never inside the inspected context and this
  // fired as unconditional.
  const dir = makeTempDir()
  try {
    fs.mkdirSync(path.join(dir, 'notes'))
    fs.writeFileSync(path.join(dir, 'notes', 'x.md'), 'deploy notes\n')
    writeClaudeMd(dir, 'Read `notes/x.md` only if deploying.\n')
    const { findings } = audit(dir)
    assert.equal(ofKind(findings, 'unconditional-read').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unconditional-read: an @-import is flagged and its content counts toward estimatedTokens', () => {
  const dir = makeTempDir()
  try {
    const raw = 'General project background notes for orientation\n\n@extra.md\n'
    writeClaudeMd(dir, raw)
    fs.writeFileSync(path.join(dir, 'extra.md'), Array.from({ length: 50 }, (_, i) => `extra${i}`).join(' ') + '\n')
    const { summary, findings } = audit(dir)
    const reads = ofKind(findings, 'unconditional-read')
    assert.equal(reads.length, 1)
    assert.equal(reads[0].excerpt, '@extra.md')
    assert.ok(
      (summary.estimatedTokens ?? 0) > countTokens(raw),
      'estimatedTokens must include the @-imported file, not just the top-level text',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- computeScore ---

test('computeScore: no findings scores 100', () => {
  assert.equal(computeScore([]), 100)
})

test('computeScore: two warn findings score 84', () => {
  const findings = [makeFinding('stale-reference', 'warn'), makeFinding('unconditional-read', 'warn')]
  assert.equal(computeScore(findings), 84)
})

test('computeScore: six info findings of one kind cap at 15 penalty (85)', () => {
  const findings = Array.from({ length: 6 }, () => makeFinding('oversized-section', 'info'))
  assert.equal(computeScore(findings), 85)
})

test('computeScore: warns plus two capped info kinds combine (55)', () => {
  const findings = [
    ...Array.from({ length: 3 }, () => makeFinding('stale-reference', 'warn')),
    ...Array.from({ length: 10 }, () => makeFinding('oversized-section', 'info')),
    ...Array.from({ length: 2 }, () => makeFinding('redundant-content', 'info')),
  ]
  // 100 - 3*8 - min(10*3, 15) - 2*3 = 55
  assert.equal(computeScore(findings), 55)
})

test('computeScore: floors at 0, never negative', () => {
  const findings = Array.from({ length: 15 }, () => makeFinding('stale-reference', 'warn'))
  assert.equal(computeScore(findings), 0)
})

// --- redundancy ---

test('redundant-content: two near-identical sections in one file produce exactly one finding naming both headings', () => {
  const dir = makeTempDir()
  try {
    writeClaudeMd(dir, '## First\n' + PARAGRAPH_A + '\n## Second\n' + PARAGRAPH_B + '\n')
    const { findings } = audit(dir)
    const redundant = ofKind(findings, 'redundant-content')
    // findRedundantContent returns after the first match per section, so the
    // pair yields exactly one finding, not two.
    assert.equal(redundant.length, 1)
    assert.ok(redundant[0].detail.includes('"First"'))
    assert.ok(redundant[0].detail.includes('"Second"'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('redundant-content: a section overlapping an existing skill description is flagged as skill overlap', () => {
  const dir = makeTempDir()
  try {
    writeClaudeMd(dir, '## Guidance\n' + PARAGRAPH_A + '\n')
    const { findings } = auditFile(path.join(dir, 'CLAUDE.md'), 'project', [PARAGRAPH_B])
    const redundant = ofKind(findings, 'redundant-content')
    assert.equal(redundant.length, 1)
    assert.ok(redundant[0].detail.includes("overlaps with an existing skill's description"))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- cross-project ---

test('findCrossProjectRedundancy: CRLF and LF projects match with real headings (regression: CRLF used to null headings)', () => {
  const projectA = {
    name: 'alpha',
    path: 'C:\\projects\\alpha',
    sections: splitSections('## Shared A\r\n' + PARAGRAPH_A + '\r\n'),
  }
  const projectB = {
    name: 'beta',
    path: 'C:\\projects\\beta',
    sections: splitSections('## Shared B\n' + PARAGRAPH_B + '\n'),
  }
  const findings = findCrossProjectRedundancy([projectA, projectB])
  assert.equal(findings.length, 1)
  assert.ok(findings[0].similarity > 0.3)
  assert.equal(findings[0].sectionHeading, 'Shared A')
  assert.equal(findings[0].otherSectionHeading, 'Shared B')
})

// --- edge ---

test('auditFile: a nonexistent path reports exists false, null tokens, no findings', () => {
  const dir = makeTempDir()
  try {
    const missing = path.join(dir, 'nope', 'CLAUDE.md')
    const { summary, findings } = auditFile(missing, 'project', [])
    assert.equal(summary.exists, false)
    assert.equal(summary.estimatedTokens, null)
    assert.equal(findings.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
