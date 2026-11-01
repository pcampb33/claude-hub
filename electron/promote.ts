import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listProjects } from './registry.ts'
import { listSkills } from './skills.ts'
import { listExperimentPaths } from './sandbox.ts'
import { promoteCore, copySkillInto } from './promote-core.ts'
import { resolveKnownPath } from './resolve-known-path.ts'
import { openPathInVSCode } from './launch-core.ts'
import type { PromoteResult } from '../shared/ipc-types'

type ValidatedTarget = { ok: true; targetPath: string } | { ok: false; result: PromoteResult }

// Resolves targetProjectId by registry lookup AND sourcePath against the
// union of listSkills()/listExperimentPaths() output — this promotion writes
// into a real project's .claude/skills/ (fs.cpSync), so both sides of the
// copy need the same "only operate on a known-good path" discipline
// launch.ts established. sourcePath validation was previously missing
// despite ipc-types.ts's HubApi comment claiming it happened — closed here.
// Shared by promoteToProject and promoteAndTailor so both get identical
// validation instead of it drifting between the two entry points.
function resolveTargetAndValidateSource(sourcePath: string, targetProjectId: string): ValidatedTarget {
  const target = listProjects().find((p) => p.id === targetProjectId)
  if (!target) {
    return {
      ok: false,
      result: { ok: false, reason: 'target-missing', message: `No registered project with id "${targetProjectId}"` },
    }
  }

  const knownSourcePaths = [...listSkills().map((s) => s.path), ...listExperimentPaths()]
  try {
    resolveKnownPath(sourcePath, knownSourcePaths, 'promote source')
  } catch (err) {
    return { ok: false, result: { ok: false, reason: 'source-missing', message: (err as Error).message } }
  }

  return { ok: true, targetPath: target.path }
}

export function promoteToProject(sourcePath: string, targetProjectId: string): PromoteResult {
  const validated = resolveTargetAndValidateSource(sourcePath, targetProjectId)
  if (!validated.ok) return validated.result
  return promoteCore(sourcePath, validated.targetPath)
}

// Promote a skill to ~/.claude/skills, where every project — including future
// ones — picks it up. The destination sits OUTSIDE any registered project, so
// there is no registry-id to look up: the source is validated against the
// listSkills() enumerator instead, and the copy keeps register-skill.mjs's
// refuse-on-conflict semantics (via copySkillInto).
export function promoteSkillToGlobal(sourcePath: string): PromoteResult {
  try {
    resolveKnownPath(sourcePath, listSkills().map((s) => s.path), 'skill')
  } catch (err) {
    return { ok: false, reason: 'source-missing', message: (err as Error).message }
  }
  return copySkillInto(sourcePath, path.join(os.homedir(), '.claude', 'skills'))
}

// Copy-then-tailor: same conflict-refusing copy as promoteToProject, then
// opens the copy in VS Code for hand-editing. Deliberately not an
// LLM-rewrite pass — matches step 9's "prove it manually first" principle
// and avoids reopening the "how aggressive should auto-writing be" question
// the vault curator already settled by never auto-writing on someone's
// behalf (see vault-write-core.ts's queueVaultCandidate).
export function promoteAndTailor(sourcePath: string, targetProjectId: string): PromoteResult {
  const validated = resolveTargetAndValidateSource(sourcePath, targetProjectId)
  if (!validated.ok) return validated.result

  const result = promoteCore(sourcePath, validated.targetPath)
  if (result.ok && result.destPath) {
    // The copy already succeeded (fs.cpSync done) by this point — a VS Code
    // launch failure (e.g. assertSafeForCmdShim rejecting a legal-but-
    // blocklisted path character) must not mask that success. Without this,
    // the throw propagates uncaught through ipcMain.handle, the renderer's
    // await never resolves normally, and the UI shows no feedback at all
    // for a promote that actually worked.
    // Open the copy's SKILL.md, not its folder — the checkbox promises
    // "open for editing", and handing `code` a directory opens a workspace
    // instead of the skill text. Sandbox experiments are valid sources too
    // and need not have a SKILL.md, so fall back to the folder for those.
    const skillFile = path.join(result.destPath, 'SKILL.md')
    try {
      openPathInVSCode(existsSync(skillFile) ? skillFile : result.destPath)
    } catch (err) {
      console.error('[promote] promoteAndTailor: copy succeeded but failed to open in VS Code:', err)
    }
  }
  return result
}
