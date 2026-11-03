// Scorecard for the vault recall-injection experiment (2026-08-09): turns
// scripts/vault-recall.log (the offer denominator — every attempt, match,
// delivery, and its cost) plus the session transcripts into the numbers the
// experiment's verdict is gated on: were offered notes actually READ?
// Methodology matches the hand-run 2026-08-09 evidence report: find the
// RECALL_MARKER in a delivered session's transcript, then look for Read
// tool calls on the offered notes' files.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { RECALL_MARKER, VAULT_DIR } from './recall-core.ts'
import { listSubagentTranscripts } from './subagents.ts'
import type { RecallOffer, RecallScorecard } from '../shared/ipc-types.ts'

// One session's merged log history. A session id can appear more than once
// (state pruned between runs), so outcomes only ever upgrade and costs sum.
export interface RecallLogRecord {
  sessionId: string
  project: string
  at: string // timestamp of the first `start` line
  outcome: 'attempted' | 'no-match' | 'matched' | 'delivered'
  titles: string[]
  costUsd: number
}

const OUTCOME_RANK = { attempted: 0, 'no-match': 1, matched: 2, delivered: 3 } as const

const LINE_RE = /^(\S+) \[pid (\d+)\] (.+)$/
const START_RE = /^start session=(\S+) project=(.+?) promptChars=\d+/
const MATCHED_RE = /^worker done: matched \d+ (\[.*\]) \(session=(\S+) cost=(\S+)\)$/
const NO_MATCH_RE = /^worker done: no-match \(session=(\S+) cost=(\S+)\)$/
// A paid call whose reply would not parse: an error with a cost, never a no-match.
const UNPARSEABLE_RE = /^worker exit: match reply unparseable \(session=(\S+) cost=(\S+)\)$/
const DELIVERED_RE = /^done: delivered \(session=(\S+)\)$/
// Legacy single-phase format (pre-worker, 2026-08-09 only): the injected
// line carries no session id, so it correlates to the same pid's start line.
const INJECTED_RE = /^done: injected \d+ (\[.*\]) \(cost=(\S+)\)$/

function parseCost(raw: string): number {
  const m = /^\$([\d.]+)$/.exec(raw)
  return m ? Number(m[1]) : 0 // 'n/a' — call died before reporting usage
}

function parseTitles(raw: string): string[] {
  try {
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

export function parseRecallLog(text: string): { records: RecallLogRecord[]; errors: number; spendUsd: number } {
  const bySession = new Map<string, RecallLogRecord>()
  const lastStartByPid = new Map<string, string>()
  let errors = 0
  let spendUsd = 0

  const touch = (sessionId: string, at: string): RecallLogRecord => {
    let rec = bySession.get(sessionId)
    if (!rec) {
      rec = { sessionId, project: '', at, outcome: 'attempted', titles: [], costUsd: 0 }
      bySession.set(sessionId, rec)
    }
    return rec
  }
  const upgrade = (rec: RecallLogRecord, outcome: RecallLogRecord['outcome']) => {
    if (OUTCOME_RANK[outcome] > OUTCOME_RANK[rec.outcome]) rec.outcome = outcome
  }
  const addTitles = (rec: RecallLogRecord, titles: string[]) => {
    for (const t of titles) if (!rec.titles.includes(t)) rec.titles.push(t)
  }

  for (const line of text.split('\n')) {
    const parsed = LINE_RE.exec(line.trim())
    if (!parsed) continue
    const [, at, pid, msg] = parsed

    let m: RegExpExecArray | null
    if ((m = START_RE.exec(msg))) {
      const rec = touch(m[1], at)
      rec.project ||= m[2]
      lastStartByPid.set(pid, m[1])
    } else if ((m = MATCHED_RE.exec(msg))) {
      const rec = touch(m[2], at)
      addTitles(rec, parseTitles(m[1]))
      upgrade(rec, 'matched')
      const cost = parseCost(m[3])
      rec.costUsd += cost
      spendUsd += cost
    } else if ((m = NO_MATCH_RE.exec(msg))) {
      const rec = touch(m[1], at)
      upgrade(rec, 'no-match')
      const cost = parseCost(m[2])
      rec.costUsd += cost
      spendUsd += cost
    } else if ((m = UNPARSEABLE_RE.exec(msg))) {
      const cost = parseCost(m[2])
      touch(m[1], at).costUsd += cost
      spendUsd += cost
      errors++
    } else if ((m = DELIVERED_RE.exec(msg))) {
      upgrade(touch(m[1], at), 'delivered')
    } else if ((m = INJECTED_RE.exec(msg))) {
      const sessionId = lastStartByPid.get(pid)
      if (sessionId) {
        const rec = touch(sessionId, at)
        addTitles(rec, parseTitles(m[1]))
        upgrade(rec, 'delivered') // single-phase injected = delivered
        const cost = parseCost(m[2])
        rec.costUsd += cost
        spendUsd += cost
      }
    } else if (msg.includes('error') || msg.includes('failed')) {
      errors++
    }
    // Anything else (cap skips, index-missing exits) is deliberate silence,
    // not an error — ignored.
  }

  return { records: [...bySession.values()], errors, spendUsd }
}

// --- transcript scan --------------------------------------------------------

function normalizePath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase()
}

// Titles the given transcript line reads from the vault, restricted to the
// offered set. offered maps lowercased title -> canonical title.
// null (not []) when the line looks like a tool_use record but will not parse:
// that is "unknown", not "read nothing". Transcripts are appended live, so an
// in-flight session's last line is routinely a partial write — and the verdict
// this feeds ("still 0 read → unhook") must not count unknown as a miss.
//
// Two channels, because the Read tool is not the only way a note's content
// reaches a session. Measured 2026-08-23: three delivered sessions
// (08-11 ea09921d, 08-19 c007389a, 08-23 96951e04) opened the offered note
// with `cat "<vault>/<title>.md"` and this scan called every one of them "not
// read" — which is how the handoff came to record "0 read since 08-11" as a
// relevance verdict. Harness instructions that prefer shell reads over the
// Read tool make that the normal case, not the exotic one. A shell read is
// matched on the note's *filename*, not on the vault prefix, because those
// commands write the path in every form there is (`C:/…`, `/c/…`, or `cd`ed
// to and relative); `<title>.md` is distinctive enough to stand alone. A
// command that writes or lists that exact file would count as a read — an
// over-count of a kind this experiment has never produced, and one that stays
// visible because the read is always printed with the title it hit.
export function readsInLine(line: string, offered: Map<string, string>, vaultDir: string): string[] | null {
  if (!line.includes('"tool_use"')) return []
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  const content = (entry as { message?: { content?: unknown } })?.message?.content
  if (!Array.isArray(content)) return []

  const prefix = normalizePath(vaultDir).replace(/\\$/, '') + '\\'
  const out: string[] = []
  const hit = (canonical: string | undefined) => {
    if (canonical && !out.includes(canonical)) out.push(canonical)
  }
  for (const item of content) {
    const block = item as { type?: unknown; name?: unknown; input?: { file_path?: unknown; command?: unknown } }
    if (block.type !== 'tool_use') continue
    if (typeof block.input?.command === 'string') {
      const cmd = block.input.command.toLowerCase()
      for (const [lower, canonical] of offered) if (cmd.includes(`${lower}.md`)) hit(canonical)
    }
    if (block.name !== 'Read' || typeof block.input?.file_path !== 'string') continue
    const fp = normalizePath(block.input.file_path)
    if (!fp.startsWith(prefix)) continue
    const rel = fp.slice(prefix.length)
    if (!rel.endsWith('.md') || rel.includes('\\')) continue // top-level notes only
    hit(offered.get(rel.slice(0, -'.md'.length)))
  }
  return out
}

// One scanner for the tests and the real transcripts: production streams the
// file through it (transcripts run to many MB). It used to keep a copy of
// this loop, so the tests checked a function production never called.
export async function scanTranscriptLines(
  lines: Iterable<string> | AsyncIterable<string>,
  offeredTitles: string[],
  vaultDir: string,
): Promise<ScanResult> {
  const offered = new Map(offeredTitles.map((t) => [t.toLowerCase(), t]))
  let markerSeen = false
  let unparsedLines = 0
  const readTitles: string[] = []
  for await (const line of lines) {
    if (!markerSeen && line.includes(RECALL_MARKER)) markerSeen = true
    const hits = readsInLine(line, offered, vaultDir)
    if (hits === null) {
      unparsedLines++
      continue
    }
    for (const t of hits) {
      if (!readTitles.includes(t)) readTitles.push(t)
    }
  }
  return { markerSeen, readTitles, unparsedLines }
}

interface ScanResult {
  markerSeen: boolean
  readTitles: string[]
  unparsedLines: number // tool_use lines that would not parse — reads unknown, not absent
}

function scanTranscriptFile(filePath: string, offeredTitles: string[], vaultDir: string): Promise<ScanResult> {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf-8'), crlfDelay: Infinity })
  return scanTranscriptLines(rl, offeredTitles, vaultDir)
}

// Session ids come from the hook's log (ultimately from Claude Code hook
// input) — constrain to a plain filename before touching the filesystem.
const SESSION_ID_RE = /^[\w-]+$/

export function findTranscript(sessionId: string, projectsRoot: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  let dirs: string[]
  try {
    dirs = fs.readdirSync(projectsRoot)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

// --- the scorecard ----------------------------------------------------------

export async function computeRecallScorecard(
  opts: { logPath?: string; projectsRoot?: string; vaultDir?: string } = {},
): Promise<RecallScorecard> {
  const logPath = opts.logPath ?? path.join(process.env.APP_ROOT!, 'scripts', 'vault-recall.log')
  const projectsRoot = opts.projectsRoot ?? path.join(os.homedir(), '.claude', 'projects')
  const vaultDir = opts.vaultDir ?? VAULT_DIR

  let text = ''
  try {
    text = fs.readFileSync(logPath, 'utf-8')
  } catch {
    // No log yet — the hook has never fired; an all-zero scorecard is honest.
  }
  const { records, errors, spendUsd } = parseRecallLog(text)

  const offers: RecallOffer[] = []
  for (const rec of records) {
    if (rec.outcome !== 'matched' && rec.outcome !== 'delivered') continue
    let transcriptFound = false
    let markerSeen = false
    let readTitles: string[] = []
    let unparsedLines = 0
    if (rec.outcome === 'delivered') {
      const transcript = findTranscript(rec.sessionId, projectsRoot)
      if (transcript) {
        transcriptFound = true
        ;({ markerSeen, readTitles, unparsedLines } = await scanTranscriptFile(transcript, rec.titles, vaultDir))
        // markerSeen stays main-transcript-only (the offer is injected into
        // the main context); reads count wherever they happened.
        for (const sub of listSubagentTranscripts(transcript)) {
          const scan = await scanTranscriptFile(sub, rec.titles, vaultDir)
          unparsedLines += scan.unparsedLines
          for (const t of scan.readTitles) {
            if (!readTitles.includes(t)) readTitles.push(t)
          }
        }
      }
    }
    offers.push({
      sessionId: rec.sessionId,
      project: rec.project,
      at: rec.at,
      titles: rec.titles,
      delivered: rec.outcome === 'delivered',
      transcriptFound,
      markerSeen,
      readTitles,
      unparsedLines,
    })
  }
  offers.sort((a, b) => b.at.localeCompare(a.at))

  return {
    attempts: records.length,
    noMatch: records.filter((r) => r.outcome === 'no-match').length,
    offers,
    delivered: offers.filter((o) => o.delivered).length,
    readSessions: offers.filter((o) => o.readTitles.length > 0).length,
    // A read rate of 0 only means "nobody read one" if every transcript was
    // fully readable; these are the sessions where that cannot be claimed.
    incompleteScans: offers.filter((o) => o.readTitles.length === 0 && o.unparsedLines > 0).length,
    spendUsd,
    errors,
    since: records.length > 0 ? records.reduce((min, r) => (r.at < min ? r.at : min), records[0].at) : null,
  }
}
