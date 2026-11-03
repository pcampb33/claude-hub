import fs from 'node:fs'
import readline from 'node:readline'
import { findSessionFiles, parseLine, extractText, isHeadlessSessionCached, readSessionTitle } from './sessions.ts'
import { listSubagentFiles, type SubagentFile } from './subagents.ts'
import { listProjects } from './registry.ts'
import type { SessionSearchCursor, SessionSearchMatch, SessionSearchResult } from '../shared/ipc-types'
import { compareSearchMatches } from '../shared/search-order.ts'

// A vanished file must cost one result, not the whole search (the curate hook
// churns these dirs — same reasoning as findSessionFiles' stat guard).
function statMtime(filePath: string): string {
  try {
    return fs.statSync(filePath).mtime.toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

const MIN_QUERY_LENGTH = 3
const MATCH_PER_FILE_CAP = 3 // per-file early exit — one noisy session can't dominate scan time
const GLOBAL_MATCH_CAP = 50 // stop the whole search once enough results exist
const CONCURRENT_FILE_SCANS = 6 // bounded concurrency, not unbounded Promise.all over every file
// How many bytes of transcript one search may read before it stops and says so.
//
// This search is I/O bound, not CPU bound. Measured on this machine: 1.3GB of
// JSONL across ~1000 transcripts, and a query that matches nothing reads every
// byte of it — ~5s with the page cache warm, ~15s cold. Making the per-line
// work cheaper buys nothing; streaming the same files and doing no parsing at
// all still cost 2.0s of the 3.3s, and a raw-substring pre-filter that skipped
// JSON.parse measured *slower* (5.2s) because lowercasing each line allocates.
// The only lever is reading fewer bytes.
//
// So the walk goes newest-first across every project and stops here. 250MB is
// roughly the last week of transcripts on this machine, which is what nearly
// every search is reaching for; the result reports what it did not reach and a
// cursor to resume from, so a complete sweep is this same call in a loop.
const DEFAULT_SCAN_BUDGET_BYTES = 250 * 1024 * 1024
// One session can spawn dozens of agents (80 in the largest on disk). Without
// a per-session ceiling a single fan-out fills GLOBAL_MATCH_CAP by itself and
// every other session vanishes from the results — measured: "the" returned 49
// of 50 matches from one session's agents.
const AGENT_MATCHES_PER_SESSION_CAP = 3

interface FileSearchResult {
  snippet: string
  matchCount: number
}

interface FileScan {
  hit: FileSearchResult | null
  // What this scan actually cost, charged against the budget. Taken from the
  // stream rather than the file size because MATCH_PER_FILE_CAP stops most
  // matching files early — charging the full size would spend the budget on
  // bytes nobody read.
  bytesRead: number
}

// Streams the file exactly like parseTranscriptFile/summarizeSession do —
// never retains a full SessionMessage[] the way readSession does, so
// memory stays O(1) per file regardless of the 22MB+ ceiling confirmed
// while building step 4.
async function searchSessionFile(
  filePath: string,
  query: string,
  // Subagent transcripts mark every line isSidechain, so scanning one means
  // opting in — the flag is what separates "a session's own turns" from
  // "an agent it spawned", not two copies of this loop.
  opts: { includeSidechain?: boolean } = {},
): Promise<FileScan> {
  const lowerQuery = query.toLowerCase()
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let matchCount = 0
  let snippet: string | null = null

  for await (const line of rl) {
    const parsed = parseLine(line)
    if (!parsed?.message) continue
    // A request's composed content (reminders, CLAUDE.md), not a turn; see parseTranscriptFile.
    if (parsed.type === 'api-request-blob') continue
    if (parsed.isSidechain && !opts.includeSidechain) continue
    const role = parsed.message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = extractText(parsed.message.content)

    const matchIndex = text.toLowerCase().indexOf(lowerQuery)
    if (matchIndex !== -1) {
      matchCount++
      if (!snippet) {
        const start = Math.max(0, matchIndex - 60)
        const end = Math.min(text.length, matchIndex + query.length + 60)
        snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
      }
    }

    if (matchCount >= MATCH_PER_FILE_CAP) break
  }

  rl.close()
  const bytesRead = stream.bytesRead
  stream.destroy()

  return { hit: matchCount > 0 ? { snippet: snippet ?? '', matchCount } : null, bytesRead }
}

// The subagent transcripts of one session, scanned in the same bounded batches
// as sessions (the largest fan-out on disk is 80 agents — a plain Promise.all
// over them would open 80 streams at once) and stopped as soon as the
// per-session ceiling is met.
async function searchAgentsOf(
  transcriptPath: string,
  query: string,
): Promise<{ hits: Array<{ agent: SubagentFile; hit: FileSearchResult }>; bytesRead: number }> {
  const agents = listSubagentFiles(transcriptPath)
  const hits: Array<{ agent: SubagentFile; hit: FileSearchResult }> = []
  let bytesRead = 0
  for (let i = 0; i < agents.length && hits.length < AGENT_MATCHES_PER_SESSION_CAP; i += CONCURRENT_FILE_SCANS) {
    const batch = agents.slice(i, i + CONCURRENT_FILE_SCANS)
    const results = await Promise.all(
      batch.map(async (agent) => ({
        agent,
        scan: await searchSessionFile(agent.jsonlPath, query, { includeSidechain: true }),
      })),
    )
    for (const r of results) {
      bytesRead += r.scan.bytesRead
      if (!r.scan.hit) continue
      hits.push({ agent: r.agent, hit: r.scan.hit })
      if (hits.length >= AGENT_MATCHES_PER_SESSION_CAP) break
    }
  }
  return { hits, bytesRead }
}

// Always searches every registered project — no filter/scope option.
// Per the council's resolution: a silently-missed hit in an unsearched
// project is worse than some cross-project noise, so nothing is ever
// excluded. currentProjectId only affects sort order (see below).
//
// Recency is a different matter from scope: the walk stops at
// DEFAULT_SCAN_BUDGET_BYTES and the caller is told, in the result, exactly how
// far back it got and how many sessions it never opened. Silently searching
// less is the thing to avoid — searching less and saying so is not.
//
// It also returns the cursor to resume from, which is what makes searching the
// whole corpus a loop of budgeted calls rather than one 5s block: each call
// returns in about a second, and the caller shows what it has so far.
export async function searchSessions(
  query: string,
  currentProjectId?: string,
  // startAfter resumes a walk. budgetBytes overrides the default ceiling; it
  // exists so the budget is testable without writing 250MB of fixtures.
  opts: { startAfter?: SessionSearchCursor; budgetBytes?: number } = {},
): Promise<SessionSearchResult> {
  const trimmedQuery = query.trim()
  if (trimmedQuery.length < MIN_QUERY_LENGTH) {
    return {
      query: trimmedQuery,
      matches: [],
      scannedSessionCount: 0,
      truncated: false,
      unscannedSessionCount: 0,
      oldestScanned: null,
      nextCursor: null,
    }
  }

  // One list across every project, ordered newest first. Project-at-a-time
  // order was fine while the walk always finished; under a budget it would
  // spend everything on whichever project the registry happens to list first.
  const targets = listProjects().flatMap((project) =>
    findSessionFiles(project.path).map((file) => ({ project, ...file })),
  )
  // The curate hook's own headless `claude -p` runs write transcripts into
  // these same project dirs, and their triage/extract prompts contain the
  // common terms people search for — left in, they crowd real sessions out of
  // GLOBAL_MATCH_CAP. Every other enumerator over these files already skips
  // them (latest-sessions, session-list-core). Resolved up front now rather
  // than inside the scan, because the counts this returns have to be exact:
  // "134 older sessions not searched" must not be counting hook transcripts
  // that would have been skipped anyway. Cached, so only the first search of a
  // process pays the head-reads (~0.5s here, and the old walk paid them too).
  const headless = await Promise.all(targets.map((t) => isHeadlessSessionCached(t.filePath)))
  // Ties broken by id so the ordering is total. Sorting by mtime alone leaves
  // same-millisecond transcripts in an arbitrary order, and a cursor can't
  // resume from a position the next call won't reproduce.
  const ordered = targets
    .filter((_, i) => !headless[i])
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id))

  // Everything strictly after the cursor in that total order. A resumed walk
  // therefore never re-opens a file the previous chunk already read, and never
  // steps over one whose mtime ties the cursor's.
  const after = opts.startAfter
  const remaining = after
    ? ordered.filter(
        (f) => f.mtimeMs < after.mtimeMs || (f.mtimeMs === after.mtimeMs && f.id.localeCompare(after.sessionId) > 0),
      )
    : ordered

  const matches: SessionSearchMatch[] = []
  let scannedSessionCount = 0
  let truncated = false
  let budget = opts.budgetBytes ?? DEFAULT_SCAN_BUDGET_BYTES
  let reached = 0

  while (reached < remaining.length && budget > 0 && matches.length < GLOBAL_MATCH_CAP) {
    const batch = remaining.slice(reached, reached + CONCURRENT_FILE_SCANS)
    reached += batch.length
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        scannedSessionCount++

        // The agents a session spawned are searched with it, so a hit and its
        // parent stay adjacent in the results and share one title read.
        const [own, agents] = await Promise.all([
          searchSessionFile(file.filePath, trimmedQuery),
          searchAgentsOf(file.filePath, trimmedQuery),
        ])
        const bytesRead = own.bytesRead + agents.bytesRead
        if (!own.hit && agents.hits.length === 0) return { bytesRead, fileMatches: [] }

        const base = {
          projectId: file.project.id,
          projectName: file.project.name,
          projectPath: file.project.path,
          sessionId: file.id,
          // Titles come from readSessionTitle, the same helper the session
          // list uses, so a session reads identically in both places — it
          // prefers an ai-title line and skips the wrapper turns (isMeta,
          // slash-command markup, harness-injected prompts) that an inline
          // "first user message" rule mistook for the human's opener. Only
          // matched files pay for it, and matches are capped.
          title: await readSessionTitle(file.filePath),
        }
        const fileMatches: SessionSearchMatch[] = []
        if (own.hit) {
          fileMatches.push({
            ...base,
            date: statMtime(file.filePath),
            snippet: own.hit.snippet,
            matchCount: own.hit.matchCount,
          })
        }
        for (const { agent, hit } of agents.hits) {
          fileMatches.push({
            ...base,
            // The agent's own mtime, not the session's — an agent that ran
            // days before the session was last touched sorts where it ran.
            date: statMtime(agent.jsonlPath),
            snippet: hit.snippet,
            matchCount: hit.matchCount,
            agent: { id: agent.id, agentType: agent.agentType, description: agent.description },
          })
        }
        return { bytesRead, fileMatches }
      }),
    )

    collect: for (const result of batchResults) {
      budget -= result.bytesRead
      for (const match of result.fileMatches) {
        matches.push(match)
        if (matches.length >= GLOBAL_MATCH_CAP) {
          truncated = true
          break collect
        }
      }
    }
  }

  // The "ranking boost" from the plan: a plain sort, not a fuzzy score —
  // matches from the currently-open project come first, everything else
  // follows by date. Concrete and testable, not asserted.
  matches.sort(compareSearchMatches(currentProjectId))

  const last = reached > 0 ? remaining[reached - 1] : null

  return {
    query: trimmedQuery,
    matches,
    scannedSessionCount,
    truncated,
    // What this walk never opened, and how far back it got. Both are exact:
    // `remaining` already has the hook transcripts filtered out, so this is a
    // count of real sessions a continued sweep would still have to offer.
    unscannedSessionCount: remaining.length - reached,
    oldestScanned: last ? new Date(last.mtimeMs).toISOString() : null,
    nextCursor: last && reached < remaining.length ? { mtimeMs: last.mtimeMs, sessionId: last.id } : null,
  }
}
