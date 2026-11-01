import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { countTokens } from 'gpt-tokenizer'
import { listSkills } from './skills.ts'
import { listProjects } from './registry.ts'
import { resolveKnownPath } from './resolve-known-path.ts'
import type {
  ConfigHealthFileSummary,
  ConfigHealthFinding,
  ConfigHealthReport,
  CrossProjectRedundancyFinding,
  CrossProjectRedundancyReport,
} from '../shared/ipc-types'

export interface Section {
  heading: string | null
  body: string
}

// Claude Code's own @path import syntax — structurally identical to a
// prose "also read this file" instruction, just native syntax instead.
const IMPORT_PATTERN = /@([^\s]+\.md)/g
const UNCONDITIONAL_READ_PATTERN = /\b(read|see|refer to|also read|check)\s+[`']?([\w./-]+\.md)[`']?/gi
const CONDITIONAL_MARKERS = /\b(when|if|only if|before|for .* tasks?)\b/i
const PATH_REFERENCE_PATTERN = /`([^`]+\.(?:md|ts|tsx|js|jsx|json))`|\[([^\]]+)\]\(([^)]+)\)/g
const SKILL_SHAPE_MARKERS = /\b(when you|when doing|steps?:|workflow|follow these)\b/i
const OVERSIZED_TOKEN_THRESHOLD = 200
const REDUNDANCY_THRESHOLD = 0.3
const SEVERITY_WEIGHT: Record<ConfigHealthFinding['severity'], number> = { warn: 8, info: 3 }

function estimateTokens(text: string): number {
  return countTokens(text)
}

// Applied at every read boundary. A trailing \r defeats the heading regex's
// `$` (JS `.` doesn't match \r), which collapsed whole CRLF files — including
// the user's global ~/.claude/CLAUDE.md — into one untitled section, breaking
// every section-level heuristic and leaking \r into excerpts and token counts.
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export function splitSections(text: string): Section[] {
  const lines = text.split(/\r?\n/)
  const sections: Section[] = []
  let current: Section = { heading: null, body: '' }
  for (const line of lines) {
    const headingMatch = line.match(/^#{2,3}\s+(.+)$/)
    if (headingMatch) {
      if (current.body.trim()) sections.push(current)
      current = { heading: headingMatch[1].trim(), body: '' }
    } else {
      current.body += line + '\n'
    }
  }
  if (current.body.trim()) sections.push(current)
  return sections
}

// Follows @path imports one level deep so the token estimate reflects what
// actually loads unconditionally, not just the top-level file's own bytes
// — the same false-confidence bug the council flagged for MCP, recurring
// internally if imports weren't followed.
function resolveImports(text: string, baseDir: string): string {
  let combined = text
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const importPath = path.isAbsolute(match[1]) ? match[1] : path.join(baseDir, match[1])
    try {
      if (fs.existsSync(importPath)) combined += '\n\n' + normalizeNewlines(fs.readFileSync(importPath, 'utf-8'))
    } catch {
      // Unreadable import — skip, don't crash the whole audit.
    }
  }
  return combined
}

function findUnconditionalReads(sections: Section[], source: ConfigHealthFinding['source']): ConfigHealthFinding[] {
  const findings: ConfigHealthFinding[] = []
  for (const section of sections) {
    for (const match of section.body.matchAll(UNCONDITIONAL_READ_PATTERN)) {
      // Sentence-boundary-aware, not a fixed char window (which was
      // asymmetric — 80 chars back, 20 forward — and could both miss a
      // conditional clause that trails the match, and false-negative on
      // an unrelated "when"/"if" from an earlier, different sentence).
      // The sentence-end search starts AFTER the matched reference — the
      // matched path always contains a dot (".md"), which otherwise
      // terminates the context early and hides trailing conditionals
      // ("read `x.md` only if deploying" fired as unconditional).
      const matchIndex = match.index ?? 0
      const matchEnd = matchIndex + match[0].length
      const sentenceStart = Math.max(section.body.lastIndexOf('.', matchIndex), section.body.lastIndexOf('\n', matchIndex)) + 1
      const nextPeriod = section.body.indexOf('.', matchEnd)
      const nextNewline = section.body.indexOf('\n', matchEnd)
      const sentenceEnd =
        nextPeriod === -1 ? (nextNewline === -1 ? section.body.length : nextNewline) : nextNewline === -1 ? nextPeriod : Math.min(nextPeriod, nextNewline)
      const context = section.body.slice(sentenceStart, sentenceEnd)
      if (CONDITIONAL_MARKERS.test(context)) continue
      findings.push({
        id: `${source}:${section.heading ?? 'root'}:unconditional-read:${findings.length}`,
        source,
        sectionHeading: section.heading,
        kind: 'unconditional-read',
        severity: 'warn',
        excerpt: match[0],
        detail: `Unconditional instruction to read "${match[2]}" — pays its cost on every session, even unrelated ones. Consider converting to a Skill with a specific description.`,
        estimatedTokens: null,
      })
    }
    for (const match of section.body.matchAll(IMPORT_PATTERN)) {
      findings.push({
        id: `${source}:${section.heading ?? 'root'}:import:${findings.length}`,
        source,
        sectionHeading: section.heading,
        kind: 'unconditional-read',
        severity: 'warn',
        excerpt: match[0],
        detail: `@-import pulls in "${match[1]}" unconditionally on every session — same cost class as a prose "also read" instruction.`,
        estimatedTokens: null,
      })
    }
  }
  return findings
}

// Cached repo file index for findStaleReferences' second-chance lookup.
//
// "not a repo" and "the listing failed" are NOT the same answer, and collapsing
// them is a bug with teeth: a miss here becomes a stale-reference warning that
// costs health points. A non-repo baseDir (the global ~/.claude CLAUDE.md)
// genuinely has no index, so that negative IS cached — otherwise it's one
// failing git spawn per project per dashboard refresh. But a real repo whose
// ls-files blew up (git absent, the 10MB maxBuffer, an index.lock) knows
// nothing about its files, and answering "no index" for the whole TTL would
// flag every relative reference in that repo as missing.
type RepoIndex =
  | { kind: 'index'; files: Set<string> }
  | { kind: 'not-a-repo' }
  | { kind: 'unavailable' } // real repo, listing failed — cannot judge, never cached

const repoIndexCache = new Map<string, { index: RepoIndex; builtAt: number }>()
const REPO_INDEX_TTL_MS = 30_000

function getRepoFileIndex(baseDir: string): RepoIndex {
  const key = path.resolve(baseDir)
  const cached = repoIndexCache.get(key)
  if (cached && Date.now() - cached.builtAt < REPO_INDEX_TTL_MS) return cached.index

  let toplevel: string
  try {
    // Two-step on purpose: ls-files restricts output to the cwd subtree, so
    // running it from a nested baseDir would miss root-relative files.
    // stderr ignored — a non-repo baseDir prints "fatal: not a git repository"
    // otherwise, once per dir per TTL window.
    toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: baseDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
  } catch {
    const notRepo: RepoIndex = { kind: 'not-a-repo' }
    repoIndexCache.set(key, { index: notRepo, builtAt: Date.now() })
    return notRepo
  }

  let listing: string
  try {
    listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: toplevel,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    })
  } catch {
    // Deliberately NOT cached: retry on the next audit rather than freeze a
    // wrong answer in place for the TTL.
    return { kind: 'unavailable' }
  }

  // git ls-files already outputs forward slashes; lowercased because this
  // is a Windows-local app — matches NTFS's case-insensitive existsSync
  // semantics.
  const built: RepoIndex = {
    kind: 'index',
    files: new Set(
      listing
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.toLowerCase()),
    ),
  }
  repoIndexCache.set(key, { index: built, builtAt: Date.now() })
  return built
}

function findStaleReferences(sections: Section[], source: ConfigHealthFinding['source'], baseDir: string): ConfigHealthFinding[] {
  const findings: ConfigHealthFinding[] = []
  for (const section of sections) {
    for (const match of section.body.matchAll(PATH_REFERENCE_PATTERN)) {
      // PATH_REFERENCE_PATTERN has 3 capture groups: backtick-path=1,
      // link-text=2, link-href=3. Was `match[1] ?? match[4]` — group 4
      // doesn't exist, so every markdown-style [text](path) reference was
      // silently skipped, halving this heuristic's real coverage.
      const refPath = match[1] ?? match[3]
      if (!refPath || refPath.startsWith('http')) continue
      // Placeholder/glob characters mean it's a pattern example, not a path
      // claim (`use<Name>.ts`, `*-core.ts`, `${VAR}/x.ts`).
      if (/[<>*{}$]/.test(refPath)) continue
      // A '...' ellipsis marks an elided/illustrative path ("somewhere under
      // ~/.claude/..."), not a literal claim — same class as the glob skip.
      // A leading '~' is a home-relative path this checker never expands, so it
      // can neither confirm nor fairly flag it: every ~-ref would existSync-miss
      // and read as stale. Both were a real false positive (skyrim-agent's
      // "~/.claude/.../MEMORY.md" cost 8 points). The /\.{3,}/ guard needs THREE
      // dots, so a two-dot "../x.md" parent ref stays checked as before.
      if (/\.{3,}/.test(refPath) || refPath.startsWith('~')) continue
      // Bare filename with no separator = prose mention, not a path claim.
      // Conscious trade: a deleted root-level file mentioned bare is no
      // longer caught — bare filenames were the dominant false-positive
      // class (sessions.ts, index.tsx, cross-repo _inbox.md), each costing
      // 8 warn points.
      if (!/[/\\]/.test(refPath)) continue
      const pushFinding = () =>
        findings.push({
          id: `${source}:${section.heading ?? 'root'}:stale:${findings.length}`,
          source,
          sectionHeading: section.heading,
          kind: 'stale-reference',
          severity: 'warn',
          excerpt: refPath,
          detail: `Referenced path "${refPath}" doesn't exist on disk.`,
          estimatedTokens: null,
        })
      if (path.isAbsolute(refPath)) {
        if (!fs.existsSync(refPath)) pushFinding()
        continue
      }
      if (fs.existsSync(path.join(baseDir, refPath))) continue
      // Lazy — only reached on an existsSync miss, so healthy configs never
      // spawn git. Rescues refs written relative to the repo root when the
      // CLAUDE.md lives elsewhere.
      const repo = getRepoFileIndex(baseDir)
      // Unknown is not missing: with no listing to check against, staying quiet
      // is the only honest answer.
      if (repo.kind === 'unavailable') continue
      if (repo.kind === 'index' && repo.files.has(refPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()))
        continue
      pushFinding()
    }
  }
  return findings
}

function findOversizedSections(sections: Section[], source: ConfigHealthFinding['source']): ConfigHealthFinding[] {
  const findings: ConfigHealthFinding[] = []
  for (const section of sections) {
    const tokens = estimateTokens(section.body)
    if (tokens <= OVERSIZED_TOKEN_THRESHOLD) continue
    findings.push({
      id: `${source}:${section.heading ?? 'root'}:oversized:${findings.length}`,
      source,
      sectionHeading: section.heading,
      kind: 'oversized-section',
      severity: 'info',
      excerpt: section.body.trim().slice(0, 100) + '…',
      detail: `Section "${section.heading ?? '(untitled)'}" is ~${tokens} tokens, loaded on every session. Consider converting to a Skill with a specific description so it only loads when relevant.`,
      estimatedTokens: tokens,
    })
  }
  return findings
}

function shingles(text: string, n = 3): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
  const result = new Set<string>()
  for (let i = 0; i <= words.length - n; i++) result.add(words.slice(i, i + n).join(' '))
  return result
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const shingle of a) if (b.has(shingle)) intersection++
  return intersection / (a.size + b.size - intersection)
}

// Covers two of the three redundancy sources named in the plan: overlap
// against other sections in the same file, and overlap against existing
// skill descriptions. Cross-project comparison (one project's CLAUDE.md vs.
// every other registered project's) is a separate function/report below,
// not folded in here — it needs every registered project's content, not
// just the one file being audited, so it doesn't fit this function's shape.
function findRedundantContent(sections: Section[], source: ConfigHealthFinding['source'], existingSkillDescriptions: string[]): ConfigHealthFinding[] {
  const findings: ConfigHealthFinding[] = []
  sections.forEach((section, i) => {
    if (section.body.trim().length < 50) return
    const sectionShingles = shingles(section.body)

    for (const other of sections.slice(i + 1)) {
      if (jaccardSimilarity(sectionShingles, shingles(other.body)) > REDUNDANCY_THRESHOLD) {
        findings.push({
          id: `${source}:${section.heading ?? 'root'}:redundant-section:${findings.length}`,
          source,
          sectionHeading: section.heading,
          kind: 'redundant-content',
          severity: 'info',
          excerpt: section.body.trim().slice(0, 100) + '…',
          detail: `Section "${section.heading ?? '(untitled)'}" substantially overlaps with section "${other.heading ?? '(untitled)'}" in the same file.`,
          estimatedTokens: estimateTokens(section.body),
        })
        return
      }
    }

    for (const desc of existingSkillDescriptions) {
      if (jaccardSimilarity(sectionShingles, shingles(desc)) > REDUNDANCY_THRESHOLD) {
        findings.push({
          id: `${source}:${section.heading ?? 'root'}:redundant-skill:${findings.length}`,
          source,
          sectionHeading: section.heading,
          kind: 'redundant-content',
          severity: 'info',
          excerpt: section.body.trim().slice(0, 100) + '…',
          detail: `Section "${section.heading ?? '(untitled)'}" substantially overlaps with an existing skill's description — likely redundant, consider trimming.`,
          estimatedTokens: estimateTokens(section.body),
        })
        return
      }
    }
  })
  return findings
}

function findSkillShapedCandidates(sections: Section[], source: ConfigHealthFinding['source']): ConfigHealthFinding[] {
  const findings: ConfigHealthFinding[] = []
  for (const section of sections) {
    if (!SKILL_SHAPE_MARKERS.test(section.body)) continue
    const tokens = estimateTokens(section.body)
    if (tokens <= 50) continue
    findings.push({
      id: `${source}:${section.heading ?? 'root'}:candidate:${findings.length}`,
      source,
      sectionHeading: section.heading,
      kind: 'skill-shaped-candidate',
      severity: 'info',
      excerpt: section.body.trim().slice(0, 100) + '…',
      detail: `Section "${section.heading ?? '(untitled)'}" describes a specific procedure — a candidate to convert into a Skill with a sharp description, so it only loads when relevant.`,
      estimatedTokens: tokens,
    })
  }
  return findings
}

// Deliberate call, not an accident: unweighted, "info"-severity findings
// (oversized-section, skill-shaped-candidate, redundant-content — all
// lower-confidence heuristics by design) could otherwise accumulate
// without bound, letting ten weak signals outweigh two genuine "warn"
// problems (stale-reference, unconditional-read). Capped per kind so
// volume of low-confidence findings can't dominate the score.
const INFO_KIND_CAP = 15

export function computeScore(findings: ConfigHealthFinding[]): number {
  const warnPenalty = findings.filter((f) => f.severity === 'warn').length * SEVERITY_WEIGHT.warn

  const infoPenaltyByKind = new Map<string, number>()
  for (const finding of findings) {
    if (finding.severity !== 'info') continue
    const current = infoPenaltyByKind.get(finding.kind) ?? 0
    infoPenaltyByKind.set(finding.kind, Math.min(current + SEVERITY_WEIGHT.info, INFO_KIND_CAP))
  }
  const infoPenalty = [...infoPenaltyByKind.values()].reduce((sum, p) => sum + p, 0)

  return Math.max(0, 100 - warnPenalty - infoPenalty)
}

export function auditFile(
  claudeMdPath: string,
  source: 'project' | 'global',
  existingSkillDescriptions: string[],
): { summary: ConfigHealthFileSummary; findings: ConfigHealthFinding[] } {
  if (!fs.existsSync(claudeMdPath)) {
    return { summary: { exists: false, path: claudeMdPath, estimatedTokens: null }, findings: [] }
  }

  // Same base dir for both resolveImports and findStaleReferences — a
  // relative reference in the global CLAUDE.md must resolve against
  // ~/.claude/, not whichever project happens to be under audit. This was
  // a real bug: findStaleReferences previously always used the audited
  // project's path, producing false "stale" findings on valid global
  // references.
  const baseDir = path.dirname(claudeMdPath)
  const raw = normalizeNewlines(fs.readFileSync(claudeMdPath, 'utf-8'))
  const combined = resolveImports(raw, baseDir)
  const sections = splitSections(raw)

  const findings = [
    ...findUnconditionalReads(sections, source),
    ...findStaleReferences(sections, source, baseDir),
    ...findOversizedSections(sections, source),
    ...findRedundantContent(sections, source, existingSkillDescriptions),
    ...findSkillShapedCandidates(sections, source),
  ]

  return {
    summary: { exists: true, path: claudeMdPath, estimatedTokens: estimateTokens(combined) },
    findings,
  }
}

// Home asks for every project's health at once, and each listSkills() re-reads
// every SKILL.md in every project (~300ms of main thread per fan-out). One scan
// serves the whole burst; a skill added mid-window shows up 30s later.
let skillDescriptionsCache: { descriptions: string[]; builtAt: number } | null = null
const SKILL_DESCRIPTIONS_TTL_MS = 30_000

function skillDescriptions(): string[] {
  if (skillDescriptionsCache && Date.now() - skillDescriptionsCache.builtAt < SKILL_DESCRIPTIONS_TTL_MS)
    return skillDescriptionsCache.descriptions
  const descriptions = listSkills()
    .map((s) => s.description)
    .filter((d): d is string => d !== null)
  skillDescriptionsCache = { descriptions, builtAt: Date.now() }
  return descriptions
}

export function getConfigHealth(projectPath: string): ConfigHealthReport {
  // Only inspect a registered project — projectPath flows to fs reads and a
  // `git` cwd below, so a raw renderer/HTTP path must not reach them. Every
  // caller already passes a listProjects() path; this enforces it.
  resolveKnownPath(
    projectPath,
    listProjects().map((p) => p.path),
    'registered project',
  )
  const existingSkillDescriptions = skillDescriptions()

  const projectResult = auditFile(path.join(projectPath, 'CLAUDE.md'), 'project', existingSkillDescriptions)
  const globalResult = auditFile(path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'global', existingSkillDescriptions)

  const findings = [...projectResult.findings, ...globalResult.findings].sort(
    (a, b) => (b.estimatedTokens ?? 0) - (a.estimatedTokens ?? 0),
  )

  return {
    projectPath,
    generatedAt: new Date().toISOString(),
    project: projectResult.summary,
    global: globalResult.summary,
    // MCP tool descriptions are the same "unconditional load" cost via a
    // different mechanism (dynamic server manifests, not a flat file) —
    // explicitly surfaced as unmeasured rather than silently omitted, per
    // the council's resolution: a health check that reports "healthy"
    // while ignoring the largest possible cost is worse than not shipping.
    mcpUnmeasured: true,
    combinedEstimatedTokens: (projectResult.summary.estimatedTokens ?? 0) + (globalResult.summary.estimatedTokens ?? 0),
    findings,
    score: computeScore(findings),
  }
}

export interface ProjectSections {
  name: string
  path: string
  sections: Section[]
}

// Sequenced after bulk-registration on purpose — with only 1-2 real
// projects this signal rarely fires; it needs the real corpus. Reuses the
// same shingles()/jaccardSimilarity()/REDUNDANCY_THRESHOLD helpers as
// findRedundantContent, just applied across projects instead of within one
// file — the actual signal worth catching: near-duplicate prose in two
// different projects' CLAUDE.md, the concrete "this should be a shared
// skill instead" indicator. O(N^2 * sections^2) across project pairs, but
// at registered-project scale (tens, not thousands) this is milliseconds —
// not worth engineering around unless that stops being true.
export function findCrossProjectRedundancy(projects: ProjectSections[]): CrossProjectRedundancyFinding[] {
  const findings: CrossProjectRedundancyFinding[] = []

  // Shingle every eligible section once, up front — the first version
  // recomputed shingles(sectionB.body) inside the innermost loop, redoing
  // it once per *opposing* section instead of once per section overall
  // (O(sectionsA * sectionsB) shingle computations instead of
  // O(sectionsA + sectionsB)). Invisible at the measured 18ms/5-project
  // scale since it's small-N there, but would silently multiply with a
  // single large section once more registered projects have a CLAUDE.md.
  const shingled = projects.map((p) => ({
    ...p,
    sections: p.sections
      .filter((s) => s.body.trim().length >= 50)
      .map((s) => ({ section: s, shingles: shingles(s.body) })),
  }))

  for (let i = 0; i < shingled.length; i++) {
    for (let j = i + 1; j < shingled.length; j++) {
      const a = shingled[i]
      const b = shingled[j]
      for (const { section: sectionA, shingles: shinglesA } of a.sections) {
        for (const { section: sectionB, shingles: shinglesB } of b.sections) {
          const similarity = jaccardSimilarity(shinglesA, shinglesB)
          if (similarity <= REDUNDANCY_THRESHOLD) continue

          findings.push({
            projectAName: a.name,
            projectAPath: a.path,
            projectBName: b.name,
            projectBPath: b.path,
            sectionHeading: sectionA.heading,
            otherSectionHeading: sectionB.heading,
            excerpt: sectionA.body.trim().slice(0, 100) + '…',
            similarity,
            estimatedTokens: estimateTokens(sectionA.body),
          })
        }
      }
    }
  }

  return findings
}

export function getCrossProjectRedundancy(): CrossProjectRedundancyReport {
  const projects: ProjectSections[] = listProjects()
    .map((p): ProjectSections | null => {
      const claudeMdPath = path.join(p.path, 'CLAUDE.md')
      if (!fs.existsSync(claudeMdPath)) return null
      const raw = normalizeNewlines(fs.readFileSync(claudeMdPath, 'utf-8'))
      return { name: p.name, path: p.path, sections: splitSections(raw) }
    })
    .filter((p): p is ProjectSections => p !== null)

  const findings = findCrossProjectRedundancy(projects).sort(
    (a, b) => (b.estimatedTokens ?? 0) - (a.estimatedTokens ?? 0),
  )

  return {
    generatedAt: new Date().toISOString(),
    scannedProjectCount: projects.length,
    findings,
  }
}
