import type { SessionMessage } from '../../../shared/ipc-types'

// The transcript parser flattens non-text content blocks to placeholder
// lines — "[tool: Name]", "[tool result]", "[thinking]", "[image]" (see
// electron/sessions.ts extractText) — so a turn's text can mix real prose
// with markers. Splitting them back out here keeps the parser, and every
// other consumer of it, untouched.
//
// A tool_use becomes a chip. The rest are dropped: a tool RESULT is the
// echo of a chip that is already shown (and renders as a large empty bubble
// on the user side, since results arrive as user-role turns), and thinking
// is not conversation. Dropping them is what makes this read like a
// conversation instead of a log.
const TOOL_LINE = /^\[tool: (.+)\]$/
const NOISE_LINE = /^\[(tool result|thinking|image)\]$/

export function splitTurn(text: string): { prose: string; tools: string[] } {
  const prose: string[] = []
  const tools: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const match = TOOL_LINE.exec(trimmed)
    if (match) tools.push(match[1])
    else if (!NOISE_LINE.test(trimmed)) prose.push(line)
  }
  return { prose: prose.join('\n').trim(), tools }
}

// MCP tool names arrive as mcp__<server>__<leaf>. Chips and the sessions
// list show the leaf ("browser_navigate"); roll-up tallies group by server
// ("playwright ×5") so ten browser_* calls read as one thing.
const MCP_NAME = /^mcp__(.+?)__(.+)$/

export function toolLeaf(name: string): string {
  const match = MCP_NAME.exec(name)
  return match ? match[2] : name
}

// Claude Code stamps `"model": "<synthetic>"` on assistant turns it wrote
// itself — an API error, an interrupt — so a transcript whose tail ends on
// one never says which model ran. That is an absence, not a model name:
// print nothing, the way a session that never named one already does.
export function realModel(model: string | undefined): string | undefined {
  return model && !model.startsWith('<') ? model : undefined
}

function tallyKey(name: string): string {
  const match = MCP_NAME.exec(name)
  return match ? match[1] : name
}

// "Read ×3 · playwright ×5 · ToolSearch · Glob" — first-appearance order.
export function runSummary(tools: string[]): string {
  const counts = new Map<string, number>()
  for (const tool of tools) {
    const key = tallyKey(tool)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(' · ')
}

// A transcript rendered as a flat sequence of prose bubbles and tool RUNS —
// consecutive tool chips merge into one run even across message boundaries,
// because that is how they read: one burst of work between two sentences.
export type TranscriptItem =
  | { kind: 'prose'; role: 'user' | 'assistant'; text: string; msgIndex: number }
  | { kind: 'run'; tools: string[]; runKey: number }

export function flattenTranscript(messages: SessionMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  // Runs are keyed by the index of their first tool call across the whole
  // transcript — stable as a live tail appends, so an open strip stays open.
  let toolCount = 0
  messages.forEach((message, msgIndex) => {
    const { prose, tools } = splitTurn(message.text)
    if (prose) items.push({ kind: 'prose', role: message.role, text: prose, msgIndex })
    for (const tool of tools) {
      const last = items[items.length - 1]
      if (last?.kind === 'run') last.tools.push(tool)
      else items.push({ kind: 'run', tools: [tool], runKey: toolCount })
      toolCount += 1
    }
  })
  return items
}
