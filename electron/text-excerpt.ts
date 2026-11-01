import fs from 'node:fs'

// Shared by status.ts (CLAUDE.md) and sandbox.ts (LEARNINGS.md) — first
// non-empty line, heading markers stripped. Both are files whose opening line
// genuinely differs per project, which is the condition for this to say
// anything. The vault's index.md was a third caller and is not one any more:
// its first line is the `# Knowledge Vault Index` heading, identical every
// time, so the excerpt was a constant dressed as a summary.
export function readFirstLineExcerpt(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null
  const content = fs.readFileSync(filePath, 'utf-8')
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine?.replace(/^#+\s*/, '') ?? null
}
