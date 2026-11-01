import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFirstLineExcerpt } from './text-excerpt.ts'
import { isHeadlessSessionCached } from './sessions.ts'
import { listProjects } from './registry.ts'
import { resolveKnownPath } from './resolve-known-path.ts'
import type { GitStatus, ProjectStatus } from '../shared/ipc-types'

const execFileAsync = promisify(execFile)

// A session dirname is derived by replacing `:`, `\`, `/`, `_`, and spaces
// with `-`, preserving case as-typed. (The plan's original rule missed the
// underscore case — confirmed against the real `J_doe` -> `J-doe` mapping
// in `~/.claude/projects/` while building this module; see the plan's
// Architecture decisions section for the corrected rule.) The same project
// opened from PowerShell vs Git Bash also produces different-case dirnames,
// so matching must be case-insensitive and merge sessions across every dir.
// Exported for step 4 (session history drill-down), which needs to locate
// and parse the same session directories/files this module already finds.
export function sanitize(projectPath: string): string {
  // Claude Code maps '.' to '-' too — the on-disk dir for
  // "C:\projects\claude-hub\.claude-worktrees\…" is
  // "C--projects-claude-hub--claude-worktrees-…" (the "\." collapsed to "--").
  // Omitting '.' meant any registered project whose path contained a dot
  // (worktrees, "foo.v2", "2.0") computed the wrong dirname and silently
  // reported zero sessions + blank live status. No current registered path has
  // a dot, so this is a latent-correctness fix, not a behavior change today.
  return projectPath.replace(/[.:\\/_ ]/g, '-')
}

// The cwd recorded inside a session dir's transcripts. Dir names are lossy
// (\ : . _ and space all collapse to '-'), so "claude-hub-sandbox" the
// sibling project and a "claude-hub\sandbox" subfolder encode identically —
// only the transcript cwd can tell them apart. A dir's cwd never changes
// once written, so successful reads are cached for the process lifetime.
// Failures are never cached: a cache that stores an error as a negative result
// answers "not ours" to a question nobody managed to ask.
const sessionDirCwdCache = new Map<string, string>()

const HEAD_BYTES = 64 * 1024
// A hook transcript — or any session that opens with a huge pasted prompt —
// starts with one enormous line, and the 64K head slices it in half: the JSON
// never parses, no cwd is found, and the dir used to vanish from every count
// derived from it. live-core.ts hit the same line probing the entrypoint marker
// and escalates the same way, which is what this mirrors: the small head stays
// the norm across 1855 transcripts / 1.7GB, and only an inconclusive read pays
// for the wide one.
const WIDE_HEAD_BYTES = 1024 * 1024

// What a probe of one prefix-named dir actually established. `null` used to mean
// both "read it, it belongs to a sibling project" and "could not read it at all",
// and both were dropped — so a read failure came back as a smaller count.
type SessionDirProbe =
  | { kind: 'cwd'; cwd: string } // classified: this is where its sessions ran
  | { kind: 'empty' } // listed fine, holds no transcripts — no sessions to lose
  | { kind: 'unknown' } // holds transcripts, none of them could be classified

function readHead(file: string, maxBytes: number): string | null {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const len = Math.min(fs.fstatSync(fd).size, maxBytes)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, 0)
      return buf.toString('utf-8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null // vanished between readdir and open — curate-hook churn
  }
}

function probeSessionDir(dir: string): SessionDirProbe {
  const cached = sessionDirCwdCache.get(dir)
  if (cached !== undefined) return { kind: 'cwd', cwd: cached }
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return { kind: 'unknown' }
  }
  if (files.length === 0) return { kind: 'empty' }
  // Sample a few files in case the first is malformed or mid-write; scan a
  // bounded window of head lines (a summary record has no cwd, real turns do).
  // Widen the read only after the cheap pass came back with nothing.
  for (const bytes of [HEAD_BYTES, WIDE_HEAD_BYTES]) {
    for (const file of files.slice(0, 3)) {
      const head = readHead(path.join(dir, file), bytes)
      if (head === null) continue
      for (const line of head.split('\n').slice(0, 20)) {
        try {
          const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
          if (typeof cwd === 'string' && cwd.length > 0) {
            sessionDirCwdCache.set(dir, cwd)
            return { kind: 'cwd', cwd }
          }
        } catch {
          // non-JSON or truncated-at-window line — keep scanning
        }
      }
    }
  }
  return { kind: 'unknown' }
}

export interface SessionDirScan {
  /** Dirs the scan proved belong to this project. */
  dirs: string[]
  /**
   * Prefix-named dirs holding transcripts that could not be read or classified
   * even at the wide head. Their sessions belong either to this project or to a
   * hyphen-named sibling and nobody found out which, so while this is non-empty
   * every total derived from `dirs` is a floor, not a count.
   */
  unknown: string[]
}

export function scanSessionDirs(
  projectPath: string,
  base: string = path.join(os.homedir(), '.claude', 'projects'),
): SessionDirScan {
  const scan: SessionDirScan = { dirs: [], unknown: [] }
  if (!fs.existsSync(base)) return scan
  const target = sanitize(projectPath).toLowerCase()
  const prefix = target + '-'
  const root = projectPath.toLowerCase()
  for (const entry of fs.readdirSync(base)) {
    const lower = entry.toLowerCase()
    const full = path.join(base, entry)
    if (lower === target) {
      scan.dirs.push(full)
      continue
    }
    // Sessions started in a SUBFOLDER of the project (sandbox experiments,
    // worktrees, nested workspaces) get their own encoded dir; roll them up
    // so the project doesn't look idle while its subfolders are active. The
    // encoding is ambiguous with sibling projects (see probeSessionDir), so
    // confirm the recorded cwd really sits inside this project.
    if (!lower.startsWith(prefix)) continue
    const probe = probeSessionDir(full)
    if (probe.kind === 'cwd') {
      const cwd = probe.cwd.toLowerCase()
      if (cwd === root || cwd.startsWith(root + '\\') || cwd.startsWith(root + '/')) scan.dirs.push(full)
    } else if (probe.kind === 'unknown') {
      // Neither confirmed ours nor confirmed a sibling's — nobody found out.
      // Naming it is the only honest option; dropping it silently subtracts
      // real sessions from counts that are then rendered as fact.
      scan.unknown.push(full)
    }
  }
  return scan
}

// The confident half of the scan, for the callers that only take a list of dirs
// (sessions.ts, live-core.ts, activity-core.ts, skill-usage.ts). Anything that
// reports a total to a user should read scanSessionDirs() instead, so it can say
// what it could not reach rather than quietly subtracting it.
export function findSessionDirs(
  projectPath: string,
  base: string = path.join(os.homedir(), '.claude', 'projects'),
): string[] {
  return scanSessionDirs(projectPath, base).dirs
}

// Counts only what scanSessionDirs() could attribute. `ProjectStatus` has no
// field for scan.unknown yet (shared/ipc-types.ts), so a project with an
// unclassifiable session dir still reports its floor as a total here — the one
// place left where this scan rounds "could not read" down to "none".
async function getSessionSummary(
  projectPath: string,
): Promise<{ sessionCount: number; lastActivity: string | null; unreadableSessionDirs: number }> {
  // scanSessionDirs separates "classified" from "could not read even at the wide
  // head". Counting only `dirs` would round an unreadable directory down to zero
  // sessions and render it as fact.
  const { dirs, unknown } = scanSessionDirs(projectPath)
  const files: Array<{ filePath: string; mtimeMs: number }> = []

  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = path.join(dir, file)
      let stat: fs.Stats
      try {
        stat = fs.statSync(filePath)
      } catch {
        // Vanished between readdir and stat — the curate hook churns .jsonl
        // files under here constantly. Every sibling scan guards this; this
        // one didn't, so a lost race rejected the whole getProjectStatus (the
        // primary dashboard read). Skip the file.
        continue
      }
      if (!stat.isFile()) continue
      files.push({ filePath, mtimeMs: stat.mtimeMs })
    }
  }

  // Exclude headless `claude -p` transcripts (curate-session hook runs) so the
  // count and last-activity reflect real interactive work — matching the
  // session list, which filters them too. Reads run in parallel to keep the
  // per-file entrypoint scan off the critical path.
  const headless = await Promise.all(files.map((f) => isHeadlessSessionCached(f.filePath)))
  let sessionCount = 0
  let lastActivityMs = 0
  files.forEach((f, i) => {
    if (headless[i]) return
    sessionCount++
    if (f.mtimeMs > lastActivityMs) lastActivityMs = f.mtimeMs
  })

  return {
    sessionCount,
    lastActivity: lastActivityMs > 0 ? new Date(lastActivityMs).toISOString() : null,
    unreadableSessionDirs: unknown.length,
  }
}

// Async — execFileSync blocked Electron's single-threaded main process for
// every one of these 4 git spawns per project. With 16+ registered projects
// and the renderer firing status fetches via Promise.all, that sync-ness
// meant the main process serialized ~130ms/project regardless (measured:
// ~2s of UI-freezing work at 16 projects) — the renderer-side concurrency
// was fake. Promise.all here gives genuine concurrency, both across the 4
// git calls per project and across projects (main process stays responsive
// between awaits instead of blocking start-to-finish).
// `git status -b` prints the branch several ways, and this has to keep saying
// what `rev-parse --abbrev-ref HEAD` used to: the plain name, or "HEAD" when
// detached.
export function parseBranchHeader(header: string): string {
  const line = header.replace(/^## /, '')
  if (line.startsWith('HEAD (no branch)')) return 'HEAD'
  // Reachable only if the caller ever asks for status without the log below,
  // which fails on a repo with no commits — but it is the documented header
  // for that repo, and "No" is a bad thing to call a branch.
  const noCommits = /^No commits yet on (.+)$/.exec(line)
  if (noCommits) return noCommits[1]
  return line.split('...')[0].split(' ')[0]
}

// Two `git` invocations per project, not four. Nearly all the work is in
// `status`; the other three were mostly process startup, which is not free at
// this width — the fan-out asked for 60 spawns at once across 15 projects, and
// `git --version` alone across those projects measures 56ms of the 283ms the
// four-call version cost. Folding the branch into the status call and the two
// log formats into one takes that to 203ms.
async function getGitStatus(projectPath: string): Promise<GitStatus | null> {
  try {
    const run = async (args: string[]) => {
      const { stdout } = await execFileAsync('git', args, { cwd: projectPath, encoding: 'utf-8' })
      return stdout
    }

    const [statusOutput, lastCommit] = await Promise.all([
      run(['status', '--porcelain', '-b']),
      run(['log', '-1', '--format=%cI%n%s']),
    ])

    const [header, ...changes] = statusOutput.split('\n')
    const [lastCommitDate, lastCommitMessage] = lastCommit.split('\n')

    return {
      branch: parseBranchHeader(header),
      dirty: changes.some((line) => line.trim().length > 0),
      lastCommitDate: lastCommitDate?.trim() || null,
      lastCommitMessage: lastCommitMessage?.trim() || null,
    }
  } catch {
    // Not a git repo, no commits yet, or git itself failed — either way, no
    // git status. (Unchanged: the old four-call version also returned null for
    // all of these, because one rejection failed the whole Promise.all.)
    return null
  }
}

function getClaudeMdExcerpt(projectPath: string): string | null {
  return readFirstLineExcerpt(path.join(projectPath, 'CLAUDE.md'))
}

export async function getProjectStatus(projectPath: string): Promise<ProjectStatus> {
  // Only report on a registered project — projectPath becomes a `git` cwd and
  // a CLAUDE.md read below, so a raw renderer/HTTP path must not reach them.
  // A registered-but-deleted path still validates (it's in the registry) and
  // is correctly reported as pathExists:false.
  resolveKnownPath(
    projectPath,
    listProjects().map((p) => p.path),
    'registered project',
  )
  const pathExists = fs.existsSync(projectPath)

  if (!pathExists) {
    return { pathExists, git: null, sessionCount: 0, lastActivity: null, claudeMdExcerpt: null, unreadableSessionDirs: 0 }
  }

  const { sessionCount, lastActivity, unreadableSessionDirs } = await getSessionSummary(projectPath)

  return {
    pathExists,
    git: await getGitStatus(projectPath),
    sessionCount,
    lastActivity,
    unreadableSessionDirs,
    claudeMdExcerpt: getClaudeMdExcerpt(projectPath),
  }
}
