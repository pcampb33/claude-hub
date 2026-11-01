import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listProjects } from './registry.ts'
import { resolveKnownPath } from './resolve-known-path.ts'
import type { SkillEntry } from '../shared/ipc-types'

// Root-only, no recursion — every real skill found lives at a project's
// root .claude/skills or .agents/skills. This is also what makes excluding
// node_modules/, ~/.claude/plugins/, and vendored trees automatic: the scan
// never walks the general project tree, so there's nothing to filter out.
const SKILL_SUBPATHS: Array<{ rel: string; source: SkillEntry['source'] }> = [
  { rel: '.claude/skills', source: '.claude/skills' },
  { rel: '.agents/skills', source: '.agents/skills' },
]

// Surrounding quotes are YAML syntax, not content — unstripped they rendered
// literally in the Skills list ("Use when the current task…").
function stripQuotes(value: string): string {
  const quoted = value.match(/^(['"])([\s\S]*)\1$/)
  return quoted ? quoted[2] : value
}

function parseFrontmatter(skillMdPath: string): { name?: string; description?: string } {
  try {
    const content = fs.readFileSync(skillMdPath, 'utf-8')
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return {}
    const fields: { name?: string; description?: string } = {}
    const lines = match[1].split('\n')
    for (let i = 0; i < lines.length; i++) {
      const keyMatch = lines[i].match(/^(name|description):\s*(.*)$/)
      if (!keyMatch) continue
      const [, key, rawValue] = keyMatch
      let value = rawValue.trim()
      // Block scalars (`>`, `|`, either with a chomp indicator) carry their
      // value on the following indented lines. Several real skills use `>`
      // for long descriptions, which showed up as a bare ">" without this.
      if (/^[>|][-+]?$/.test(value)) {
        const block: string[] = []
        while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s/.test(lines[i + 1]))) {
          block.push(lines[++i].trim())
        }
        value = block.filter(Boolean).join(' ')
      }
      if (value) fields[key as 'name' | 'description'] = stripQuotes(value)
    }
    return fields
  } catch {
    // Malformed SKILL.md — downgrade to folder-name-only rather than
    // dropping the whole scan, same defensive posture as sessions.ts.
    return {}
  }
}

function scanSkillsDir(
  dirPath: string,
  source: SkillEntry['source'],
  projectId: string | null,
  projectName: string,
): SkillEntry[] {
  if (!fs.existsSync(dirPath)) return []
  const entries: SkillEntry[] = []
  for (const folderName of fs.readdirSync(dirPath)) {
    const skillPath = path.join(dirPath, folderName)
    // Skill folders are sometimes symlinks, and a dangling one survives
    // readdir but throws on stat. Skip that entry instead of losing the whole
    // scan — an unguarded throw here blanks both the Skills view and
    // getConfigHealth (which calls listSkills) for every project.
    let stat: fs.Stats
    try {
      stat = fs.statSync(skillPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const skillMdPath = path.join(skillPath, 'SKILL.md')
    const frontmatter = fs.existsSync(skillMdPath) ? parseFrontmatter(skillMdPath) : {}
    entries.push({
      id: skillPath,
      name: frontmatter.name ?? folderName,
      description: frontmatter.description ?? null,
      path: skillPath,
      source,
      projectId,
      projectName,
      mtime: stat.mtime.toISOString(),
    })
  }
  return entries
}

export function listSkills(): SkillEntry[] {
  const globalSkillsDir = path.join(os.homedir(), '.claude', 'skills')
  const results: SkillEntry[] = [...scanSkillsDir(globalSkillsDir, 'global', null, 'global')]

  for (const project of listProjects()) {
    if (!fs.existsSync(project.path)) continue
    for (const { rel, source } of SKILL_SUBPATHS) {
      results.push(...scanSkillsDir(path.join(project.path, rel), source, project.id, project.name))
    }
  }

  return results
}

// Read a skill's SKILL.md full text for the detail pane's disclosure.
// Validates against listSkills() first — the renderer only ever hands back
// a path this module already enumerated, never a raw path (mirrors
// workflows.ts readWorkflowSource).
export function readSkillSource(skillPath: string): string {
  resolveKnownPath(skillPath, listSkills().map((s) => s.path), 'skill')
  return fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf-8')
}
