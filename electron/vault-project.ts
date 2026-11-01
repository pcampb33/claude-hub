// A vault note's originating project is its natural grouping in the graph.
// Most notes carry almost no [[wikilinks]], so link-community clustering
// leaves them as isolated dots — project is the signal that actually exists.
// This module derives it two ways: a `project:` frontmatter tag (the durable,
// exact source, written at curation time) and, as a fallback for legacy notes
// that predate the tag, a precision-first text heuristic.

// Parse a leading `---\n...\n---` YAML block into flat key:value string pairs
// (the only shape vault notes use — no nested structures). Mirrors skills.ts's
// frontmatter reader, but also returns the body with the block stripped so the
// excerpt/title never accidentally becomes the frontmatter. No frontmatter →
// `{ frontmatter: {}, body: content }` unchanged.
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) return { frontmatter: {}, body: content }
  const frontmatter: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/)
    if (kv) frontmatter[kv[1]] = kv[2].trim()
  }
  // Drop the block plus a single blank line separating it from the body.
  const body = content.slice(match[0].length).replace(/^\r?\n/, '')
  return { frontmatter, body }
}

// SMALL, hand-tunable map of project-flavored jargon → registered project, for
// legacy notes that name their project's domain without naming the project
// itself. Precision over recall: a wrong grouping is worse than a neutral one,
// so keep these tight and only add an alias when the term is unambiguous.
const PROJECT_ALIASES: Array<{ project: string; pattern: RegExp }> = [
  { project: 'skyrim-agent', pattern: /skyrim|skse|navmesh|papyrus|bethesda/i },
  {
    project: 'claude-hub',
    pattern: /\bclaude-hub\b|\bvault\b|_inbox|\bworkflow|\bsandbox\b|\bregistry\b|curate-session/i,
  },
]

// Registered project names that are also everyday words — matching them by
// bare word is a false-positive magnet (a claude-hub note that merely mentions
// the "sandbox" feature is not a note from the `sandbox` project; genuine
// sandbox notes are tagged `sandbox:<experiment>` at curation anyway). These
// only attribute via an explicit frontmatter tag, never via text inference.
const AMBIGUOUS_PROJECT_NAMES = new Set(['sandbox', 'random', 'fullauto'])

// Infer a note's project from its text. Precision-first, three tiers:
//   1. A registered (non-ambiguous) project name appearing as a word wins.
//   2. Else project-flavored jargon (the alias map) → its project.
//   3. Else null — a cross-project principle that names no project stays
//      unattributed rather than being force-fit into a bucket.
export function deriveProject(text: string, projectNames: string[]): string | null {
  for (const name of projectNames) {
    if (AMBIGUOUS_PROJECT_NAMES.has(name.toLowerCase())) continue
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) return name
  }
  for (const { project, pattern } of PROJECT_ALIASES) {
    if (pattern.test(text)) return project
  }
  return null
}
