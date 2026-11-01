#!/usr/bin/env node
// Thin CLI wrapper over the same promoteCore() logic the desktop UI uses —
// no MCP server, no listening process. Invoked by an agent via the Bash
// tool, documented in this project's CLAUDE.md for discoverability.
import { promoteCore } from '../electron/promote-core.ts'

const [, , sourcePath, targetProjectPath] = process.argv

if (!sourcePath || !targetProjectPath) {
  console.error('Usage: node scripts/register-skill.mjs <sourceSkillPath> <targetProjectPath>')
  process.exit(1)
}

const result = promoteCore(sourcePath, targetProjectPath)
console.log(JSON.stringify(result))
process.exit(result.ok ? 0 : 1)
