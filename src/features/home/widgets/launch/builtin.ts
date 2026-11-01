import { useMemo } from 'react'
import { COMMANDS } from '../../../commands/commands-data'
import { useSkillsRead, useSkillUsageRead } from '../../reads'
import { topSkills } from './launch'

// Claude Code's own client commands (/clear, /compact…). The usage index
// counts them when typed, but a pre-filled "Run /clear" can't do anything in
// a session, so like the Commands view the launch pad never offers to launch
// one. Same static catalog the Commands view uses.
const BY_NAME = new Map(COMMANDS.map((c) => [c.name.replace(/^\//, ''), c]))

// A built-in is only a built-in when no installed skill shadows its name.
export function builtinCommand(name: string, installed: { name: string }[] | undefined) {
  if (installed?.some((s) => s.name === name)) return null
  return BY_NAME.get(name) ?? null
}

// The usage read, ranked for the last 30 days, split into what the launch pad
// can launch and the built-ins it can only report.
export function useRankedSkills() {
  const usage = useSkillUsageRead()
  const installed = useSkillsRead()
  const list = installed.status === 'data' ? installed.data : undefined
  const ranked = useMemo(() => {
    const all = usage.status === 'data' ? topSkills(usage.data, Date.now()) : []
    return all.map((s) => ({ ...s, builtin: builtinCommand(s.name, list) !== null }))
  }, [usage.status, usage.data, list])
  return { usage, ranked, launchable: useMemo(() => ranked.filter((s) => !s.builtin), [ranked]) }
}
