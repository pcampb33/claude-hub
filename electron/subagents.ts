// Subagent transcripts a session left behind. Claude Code writes every
// subagent (Agent tool, Workflow tool, named agents) as
// <session-dir>/<sessionId>/subagents/**/agent-<agentId>.jsonl plus a sibling
// agent-<agentId>.meta.json ({agentType, description, toolUseId, spawnDepth,
// and worktreePath/worktreeBranch for worktree-isolated agents}). Workflow
// agents nest (subagents/workflows/wf_<id>/...) and sit alongside non-agent
// files (journal.jsonl), so discovery is a recursive walk filtered to the
// agent-* prefix. Electron-free, served through hub-service.ts.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { extractText, findSessionFiles, parseLine, parseTranscriptFile } from './sessions.ts'
import type { SessionMessage, SubagentSummary } from '../shared/ipc-types'

// The subagents dir sits beside its own transcript, so it must be derived
// from the matched session file's dirname — a project can have several
// session dirs (case variants, subfolder rollup; see findSessionDirs), and
// recomputing from the project path would look in the wrong one.
function subagentsRoot(transcriptPath: string): string {
  return path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents')
}

// One recursive walk collecting both file kinds per agent id. ~a third of
// metas on disk have no transcript (killed / never-ran agents), and
// jsonl-without-meta occurs too, so neither side is required.
function walkAgentFiles(root: string): Map<string, { jsonlPath?: string; metaPath?: string }> {
  const agents = new Map<string, { jsonlPath?: string; metaPath?: string }>()
  const entry = (id: string) => {
    let e = agents.get(id)
    if (!e) {
      e = {}
      agents.set(id, e)
    }
    return e
  }
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // no subagents dir, or vanished mid-scan
    }
    for (const item of entries) {
      const p = path.join(dir, item.name)
      if (item.isDirectory()) walk(p)
      else if (item.name.startsWith('agent-') && item.name.endsWith('.jsonl')) {
        entry(item.name.slice('agent-'.length, -'.jsonl'.length)).jsonlPath = p
      } else if (item.name.startsWith('agent-') && item.name.endsWith('.meta.json')) {
        entry(item.name.slice('agent-'.length, -'.meta.json'.length)).metaPath = p
      }
    }
  }
  walk(root)
  return agents
}

// Every agent transcript under a session's subagents dir. Used by the recall
// scorecard: subagent turns are NOT embedded in the main transcript, so a
// note the main agent delegated the reading of would otherwise score as
// "not read" (undercounting hits biases the experiment toward unhook).
export function listSubagentTranscripts(transcriptPath: string): string[] {
  const out: string[] = []
  for (const files of walkAgentFiles(subagentsRoot(transcriptPath)).values()) {
    if (files.jsonlPath) out.push(files.jsonlPath)
  }
  return out
}

export interface SubagentFile {
  id: string
  jsonlPath: string
  agentType: string
  description: string
}

// A session's agent transcripts with just enough meta to label a search hit.
// Deliberately cheaper than listSubagents(): no head-scan for timings, no stat
// — search runs this over every session it scans, and only needs to say which
// agent matched. Agents with no transcript are skipped (nothing to search).
export function listSubagentFiles(transcriptPath: string): SubagentFile[] {
  const out: SubagentFile[] = []
  for (const [id, files] of walkAgentFiles(subagentsRoot(transcriptPath))) {
    if (!files.jsonlPath) continue
    const meta = files.metaPath ? readMeta(files.metaPath) : null
    out.push({
      id,
      jsonlPath: files.jsonlPath,
      agentType: meta?.agentType ?? 'unknown',
      description: meta?.description ?? '',
    })
  }
  return out
}

interface AgentMeta {
  agentType?: string
  description?: string
  spawnDepth?: number
  worktreeBranch?: string
}

function readMeta(metaPath: string): AgentMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
    return {
      agentType: typeof raw.agentType === 'string' ? raw.agentType : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      spawnDepth: typeof raw.spawnDepth === 'number' ? raw.spawnDepth : undefined,
      worktreeBranch: typeof raw.worktreeBranch === 'string' ? raw.worktreeBranch : undefined,
    }
  } catch {
    return null // malformed or vanished — same as no meta
  }
}

// The head of an agent transcript carries both facts a listing needs: the
// first timestamped line (when it started) and the first user turn (the
// agent's own prompt). The prompt stands in as a description for the metas
// that carry none — every workflow agent writes only {agentType, spawnDepth},
// ~28% of the agents on disk — so a fan-out doesn't render as N identical
// rows. Capped so a listing never reads more than the head (files run to 7MB).
const HEAD_SCAN_LINES = 10
const PROMPT_SNIPPET_MAX = 120

function promptSnippet(text: string): string {
  const firstLine = text.trim().split('\n', 1)[0].trim()
  return firstLine.length > PROMPT_SNIPPET_MAX ? `${firstLine.slice(0, PROMPT_SNIPPET_MAX - 1).trimEnd()}…` : firstLine
}

async function readHead(jsonlPath: string): Promise<{ startedAt: string | null; prompt: string }> {
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let startedAt: string | null = null
  let prompt = ''
  let lineIndex = 0
  try {
    for await (const line of rl) {
      const parsed = parseLine(line)
      if (!startedAt && typeof parsed?.timestamp === 'string' && parsed.timestamp.length > 0) {
        startedAt = parsed.timestamp
      }
      if (!prompt && parsed?.message?.role === 'user') {
        prompt = promptSnippet(extractText(parsed.message.content))
      }
      if (startedAt && prompt) break
      if (++lineIndex >= HEAD_SCAN_LINES) break
    }
  } catch {
    // Vanished mid-read — report whatever the head yielded before it went.
  } finally {
    rl.close()
    stream.destroy()
  }
  return { startedAt, prompt }
}

// Metadata-only listing of a session's subagents. sessionId is matched
// against findSessionFiles() results (the enumerate-then-exact-match
// pattern), never concatenated into a path — hostile ids yield [].
export async function listSubagents(projectPath: string, sessionId: string): Promise<SubagentSummary[]> {
  const match = findSessionFiles(projectPath).find((f) => f.id === sessionId)
  if (!match) return []

  const out: SubagentSummary[] = []
  for (const [id, files] of walkAgentFiles(subagentsRoot(match.filePath))) {
    const meta = files.metaPath ? readMeta(files.metaPath) : null
    let startedAt: string | null = null
    let endedAt: string | null = null
    let hasTranscript = false
    let prompt = ''
    if (files.jsonlPath) {
      try {
        endedAt = fs.statSync(files.jsonlPath).mtime.toISOString()
        hasTranscript = true
        const head = await readHead(files.jsonlPath)
        startedAt = head.startedAt
        prompt = head.prompt
      } catch {
        // Vanished between walk and stat — report as transcript-less rather
        // than dropping the whole listing.
        endedAt = null
        hasTranscript = false
      }
    }
    const summary: SubagentSummary = {
      id,
      agentType: meta?.agentType ?? 'unknown',
      description: meta?.description || prompt,
      spawnDepth: meta?.spawnDepth ?? 1,
      startedAt,
      endedAt,
      hasTranscript,
    }
    if (meta?.worktreeBranch) summary.worktreeBranch = meta.worktreeBranch
    out.push(summary)
  }

  // Launch order; agents with no readable start time sink to the end, and the
  // id tie-break keeps the order deterministic across runs.
  out.sort((a, b) => {
    if (a.startedAt && b.startedAt) return a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)
    if (a.startedAt) return -1
    if (b.startedAt) return 1
    return a.id.localeCompare(b.id)
  })
  return out
}

// A subagent's full transcript. agentId is a lookup key into the walked file
// map, never joined into a path. Empty for unknown ids and meta-only agents.
export async function readSubagent(
  projectPath: string,
  sessionId: string,
  agentId: string,
): Promise<SessionMessage[]> {
  const match = findSessionFiles(projectPath).find((f) => f.id === sessionId)
  if (!match) return []
  const files = walkAgentFiles(subagentsRoot(match.filePath)).get(agentId)
  if (!files?.jsonlPath) return []
  try {
    return await parseTranscriptFile(files.jsonlPath, { includeSidechain: true })
  } catch {
    return [] // vanished between walk and open
  }
}
