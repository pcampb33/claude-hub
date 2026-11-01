import fs from 'node:fs'
import path from 'node:path'

export interface PromoteCoreResult {
  ok: boolean
  reason?: 'conflict' | 'source-missing' | 'target-missing' | 'error'
  message?: string
  destPath?: string // populated on success — the copy's actual location
}

// Conflict-refusing copy of a skill folder into an explicit skills dir —
// the shared tail of both promote shapes below.
export function copySkillInto(sourcePath: string, destDir: string): PromoteCoreResult {
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    return { ok: false, reason: 'source-missing', message: `Source not found: ${sourcePath}` }
  }

  const skillName = path.basename(sourcePath)
  const destPath = path.join(destDir, skillName)

  if (fs.existsSync(destPath)) {
    return { ok: false, reason: 'conflict', message: `"${skillName}" already exists in ${destDir}` }
  }

  try {
    fs.mkdirSync(destDir, { recursive: true })
    fs.cpSync(sourcePath, destPath, { recursive: true })
    return { ok: true, destPath }
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

// No Electron dependency — this is the one shared mechanism behind both
// the Skills Library's "Copy to project" and the Sandbox's "Promote"
// action (Electron IPC), and register-skill.mjs (CLI, for agents). Refuses
// on a name conflict rather than overwriting; no provenance/sync tracking.
export function promoteCore(sourcePath: string, targetProjectPath: string): PromoteCoreResult {
  if (!fs.existsSync(targetProjectPath)) {
    return { ok: false, reason: 'target-missing', message: `Target project path not found: ${targetProjectPath}` }
  }
  return copySkillInto(sourcePath, path.join(targetProjectPath, '.claude', 'skills'))
}
