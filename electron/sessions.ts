import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { findSessionDirs } from './status.ts'
import type { SessionMessage, SessionSummary } from '../shared/ipc-types'

interface RawContentItem {
  type: string
  text?: string
  name?: string
}

interface RawLine {
  message?: { role?: string; content?: RawContentItem[] | string }
  isSidechain?: boolean
  isMeta?: boolean
  timestamp?: string
  entrypoint?: string
  type?: string
  title?: string
  aiTitle?: string
  promptSource?: string
}

// Exported for step 10 (session search), which will need the same
// line-parsing/text-extraction logic rather than reimplementing it.
export function parseLine(line: string): RawLine | null {
  try {
    return JSON.parse(line)
  } catch {
    // Non-JSON or malformed line — skip rather than crash the whole parse.
    return null
  }
}

// Content can be a plain string or an array of typed blocks (text/tool_use/
// tool_result/thinking/image). Real transcripts include non-text blocks;
// represent them with a short placeholder instead of dropping the turn
// silently.
export function extractText(content: RawContentItem[] | string | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((item) => {
      if (item.type === 'text') return item.text ?? ''
      if (item.type === 'tool_use') return `[tool: ${item.name ?? 'unknown'}]`
      if (item.type === 'tool_result') return '[tool result]'
      if (item.type === 'thinking') return '[thinking]'
      if (item.type === 'image') return '[image]'
      return ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
}

// Exported for step 10 (session search), which needs the same "enumerate
// a project's session files" logic rather than reimplementing it. mtimeMs and
// size come free from the stat this already does to filter directories out —
// session search orders its whole scan by them, and paying for a second stat
// pass over ~1000 files to learn what the first one already read would be silly.
export function findSessionFiles(projectPath: string): Array<{ id: string; filePath: string; mtimeMs: number; size: number }> {
  const files: Array<{ id: string; filePath: string; mtimeMs: number; size: number }> = []
  for (const dir of findSessionDirs(projectPath)) {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.jsonl')) continue
      const filePath = path.join(dir, entry)
      let stat: fs.Stats
      try {
        stat = fs.statSync(filePath)
      } catch {
        // Vanished between readdir and stat (the curate hook churns these).
        // Unguarded, one lost race made gatherCandidates skip the ENTIRE
        // project, dropping all its sessions from the list. Skip just the file.
        continue
      }
      if (!stat.isFile()) continue
      files.push({ id: entry.slice(0, -'.jsonl'.length), filePath, mtimeMs: stat.mtimeMs, size: stat.size })
    }
  }
  return files
}

// How far into the file the cheap scan keeps looking for a preferred
// {type:'ai-title'} line once a usable fallback title exists — Claude Code
// writes the title near the file start when it writes one.
const AI_TITLE_SCAN_LINES = 25

// Slash-command turns arrive as synthetic user messages in Claude Code's own
// markup — "<command-name>/clear</command-name>", its "<command-message>", and
// the "<local-command-stdout>" echo of the command's output. None is the
// human's message, so none makes a useful title (the isMeta local-command
// caveat that precedes them is skipped separately).
function isCommandWrapper(text: string): boolean {
  return /^<(command-|local-command-)/.test(text)
}

// The slash command inside such a turn, if it names one. The "<local-command-"
// wrappers (the caveat addressed to the model, the stdout echo of the
// command's output) carry no name and yield null.
function parseCommand(text: string): { name: string; args: string | null } | null {
  const name = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text)?.[1]
  if (!name) return null
  return { name, args: /<command-args>\s*([^<]+?)\s*<\/command-args>/.exec(text)?.[1] ?? null }
}

// …but a session the human only ever drove by slash command has no prose at
// all, and its command name + args are the only record of what it was for
// ("/loop 20m Continue autonomous work…"). Used as a last resort, below any
// real message. Only a command carrying args earns a title — a bare "/clear"
// (which opens most sessions here) says nothing the list doesn't already show.
function commandTitle(text: string): string | null {
  const cmd = parseCommand(text)
  return cmd?.args ? `${cmd.name} ${cmd.args}` : null
}

// extractText renders non-text blocks as placeholders ("[tool result]",
// "[image]"…). A session resumed onto a tool result has one as its first
// non-meta user turn, which titled those sessions "[tool result]" — never the
// human's message, so drop the placeholder lines and keep looking.
const PLACEHOLDER_LINE = /^\[(tool result|thinking|image|tool: [^\]]*)\]$/

function stripPlaceholders(text: string): string {
  return text
    .split('\n')
    .filter((line) => !PLACEHOLDER_LINE.test(line))
    .join('\n')
    .trim()
}

const MAX_TITLE_LENGTH = 120

function clampTitle(text: string): string {
  return text.length > MAX_TITLE_LENGTH ? text.slice(0, MAX_TITLE_LENGTH) + '…' : text
}

// Hard ceiling on the scan. Without a usable fallback the loop would otherwise
// read a whole transcript (7MB ones exist) looking for prose that isn't there,
// breaking this module's metadata-only promise.
const TITLE_SCAN_LINE_LIMIT = 400

// A session's display title. Prefers a Claude-written {type:'ai-title'} line;
// otherwise the first real user prompt — skipping sidechain (subagent) turns,
// isMeta turns (the local-command caveat), and slash-command wrapper turns,
// none of which are the human's actual first message. Streams and stops as
// soon as a title is settled — never fully parses a large session file.
export async function readSessionTitle(filePath: string): Promise<string> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let title = '(no message found)'
  let firstUserMessage: string | null = null
  let firstCommand: string | null = null
  let lineIndex = 0
  for await (const line of rl) {
    const parsed = parseLine(line)
    lineIndex++
    if (parsed?.type === 'ai-title') {
      // Current transcripts carry the title as `aiTitle` (the field live-core
      // reads); accept the legacy `title` spelling too.
      const t = typeof parsed.aiTitle === 'string' ? parsed.aiTitle : typeof parsed.title === 'string' ? parsed.title : ''
      if (t.trim().length > 0) {
        firstUserMessage = null // the ai-title wins outright
        firstCommand = null
        title = t.trim()
        break
      }
    }
    // promptSource:"system" marks harness-injected user turns (e.g. an
    // "Ultraplan terminated: …" task notification); humans are "typed".
    if (
      firstUserMessage === null &&
      parsed?.message?.role === 'user' &&
      !parsed.isSidechain &&
      !parsed.isMeta &&
      parsed.promptSource !== 'system'
    ) {
      const text = extractText(parsed.message.content).trim()
      if (isCommandWrapper(text)) {
        if (firstCommand === null) firstCommand = commandTitle(text)
      } else {
        const prose = stripPlaceholders(text)
        if (prose.length > 0) firstUserMessage = clampTitle(prose)
      }
    }
    // Once a fallback exists, only keep reading while an ai-title could still
    // plausibly appear.
    if ((firstUserMessage ?? firstCommand) !== null && lineIndex >= AI_TITLE_SCAN_LINES) break
    if (lineIndex >= TITLE_SCAN_LINE_LIMIT) break
  }
  rl.close()
  stream.destroy()

  if (firstUserMessage !== null) return firstUserMessage
  if (firstCommand !== null) return clampTitle(firstCommand)
  return title
}

// Metadata-only: reads the mtime and a cheap title, never the full transcript.
async function summarizeSession(id: string, filePath: string): Promise<SessionSummary> {
  const date = fs.statSync(filePath).mtime.toISOString()
  const title = await readSessionTitle(filePath)
  return { id, date, title }
}

// A session's `entrypoint` marker sits on its first user-role line: 'sdk-cli'
// for a headless `claude -p` run (e.g. the curate-session Stop hook's own
// triage/extract calls, which write transcripts into the same project dir),
// 'cli' for a real interactive session. Streams only until that line — never
// parses the whole file — so it is cheap to run across every file when
// filtering a project's list.
export async function isHeadlessSession(filePath: string): Promise<boolean> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let headless = false
  for await (const line of rl) {
    const parsed = parseLine(line)
    if (!parsed?.message || parsed.message.role !== 'user' || parsed.isSidechain) continue
    headless = parsed.entrypoint === 'sdk-cli'
    break
  }
  rl.close()
  stream.destroy()

  return headless
}

// Memoized isHeadlessSession. A file's entrypoint is immutable — set once when
// the session starts, and session filenames are never-reused UUIDs — so a
// filePath→flag cache is always valid. Lets the dashboard's per-project status
// and activity passes share one scan per file instead of each re-reading every
// transcript on a load, and makes repeat loads instant.
const headlessCache = new Map<string, Promise<boolean>>()

export function isHeadlessSessionCached(filePath: string): Promise<boolean> {
  let cached = headlessCache.get(filePath)
  if (!cached) {
    cached = isHeadlessSession(filePath)
    cached.catch(() => headlessCache.delete(filePath)) // never memoize a failed read
    headlessCache.set(filePath, cached)
  }
  return cached
}

export async function listSessions(projectPath: string): Promise<SessionSummary[]> {
  const files = findSessionFiles(projectPath)
  // Exclude headless `claude -p` runs (the curate-session Stop hook's own
  // model calls) so the list shows only real interactive sessions. Filtering
  // first also means the (more expensive) title scan runs on the survivors,
  // not on every hook transcript.
  const headlessFlags = await Promise.all(files.map((f) => isHeadlessSessionCached(f.filePath)))
  const realFiles = files.filter((_, i) => !headlessFlags[i])
  const summaries = await Promise.all(realFiles.map((f) => summarizeSession(f.id, f.filePath)))
  return summaries.sort((a, b) => b.date.localeCompare(a.date))
}

// Exported for scripts/curate-session.mjs, which needs the same clean
// user/assistant text (not the raw JSONL) to review — much cheaper than
// sending a 20MB+ raw transcript to a review model.
export async function parseTranscriptFile(
  filePath: string,
  opts: { includeSidechain?: boolean } = {},
): Promise<SessionMessage[]> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  const messages: SessionMessage[] = []
  for await (const line of rl) {
    const parsed = parseLine(line)
    if (!parsed?.message) continue
    // Sidechain turns are subagent-internal activity, not the user's actual
    // conversation — filtered out of the default transcript view. Reading a
    // subagent's own file (100% sidechain lines) opts in via the flag.
    if (parsed.isSidechain && !opts.includeSidechain) continue
    const role = parsed.message.role
    if (role !== 'user' && role !== 'assistant') continue

    const text = extractText(parsed.message.content).trim()
    if (text.length === 0) continue

    messages.push({ role, text, timestamp: parsed.timestamp ?? '' })
  }

  return messages
}

// A finished subagent reports back as a whole synthetic user turn wrapped in
// Claude Code's task-notification envelope: routing metadata (<task-id>,
// <tool-use-id>, <output-file>, <status>), then the agent's actual report in
// <result>, then a <usage> token tally. Only the report reads as a message.
// Matched as the WHOLE turn, open tag to close — this app is used to read code,
// and transcripts legitimately contain markup, so nothing narrower than the
// exact envelope is safe to strip on sight.
const TASK_NOTIFICATION = /^<task-notification>[\s\S]*<\/task-notification>$/

// Greedy to the LAST </result>: the envelope can carry a <diagnostics> block
// between the report and <usage>, and the report itself is free-form prose.
const TASK_RESULT = /<result>([\s\S]*)<\/result>/
const TASK_SUMMARY = /<summary>([\s\S]*?)<\/summary>/

// How one parsed turn should read. Returns null for turns that are only
// harness bookkeeping and should not appear at all. Exported for tests only:
// readSession itself resolves through the real ~/.claude/projects, which a
// test has no hermetic way to stand in for.
//
// Read-side only, deliberately: the shared parseTranscriptFile feeds
// scripts/curate-session.mjs, where messages.length gates a paid `claude -p`
// call against MIN_TURNS_FOR_REVIEW (and with it the hook's recursion safety),
// plus sandbox.ts and subagents.ts. Dropping turns there would quietly move
// spend; dropping them here only changes what a human sees.
export function readableTurn(text: string): string | null {
  if (isCommandWrapper(text)) {
    // Render the command itself rather than dropping the turn: that a /clear
    // or /compact happened is the explanation for the turns around it. The
    // nameless wrappers are the harness talking to itself, so they go.
    const cmd = parseCommand(text)
    if (!cmd) return null
    return cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name
  }
  if (!TASK_NOTIFICATION.test(text)) return text
  // A failed or empty agent has no <result>; its one-line <summary> is then
  // the whole of what happened.
  return TASK_RESULT.exec(text)?.[1].trim() || TASK_SUMMARY.exec(text)?.[1].trim() || null
}

export async function readSession(projectPath: string, sessionId: string): Promise<SessionMessage[]> {
  const match = findSessionFiles(projectPath).find((f) => f.id === sessionId)
  if (!match) return []
  const messages = await parseTranscriptFile(match.filePath)
  return messages.flatMap((m) => {
    const text = readableTurn(m.text)
    return text === null ? [] : [{ ...m, text }]
  })
}
