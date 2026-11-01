import type { LaunchTier } from '../../../shared/ipc-types'
import './tier-chip.css'

// Without a title (Desktop, where the session's tier is all that's known),
// say generically what the tier enforces. The Config view passes the exact
// GuardStatus.covers instead.
const HINT: Record<LaunchTier, string> = {
  audit: 'Launched audit-only: nothing is blocked; crossings are reported in Projects › Config.',
  guarded:
    "Launched guarded: deny rules for Claude's file tools outside this project's boundary. Shell commands (Bash, PowerShell) are not fenced.",
  admin: 'claude-hub itself: it administers every project, so its sessions have no boundary.',
}

const LABEL: Record<LaunchTier, string> = { audit: 'Audit', guarded: 'Guarded', admin: 'Admin' }

// A project's boundary tier in one word. Never a word like "contained" or
// "secure": guarded fences Claude's file tools only.
export function TierChip({ tier, title }: { tier: LaunchTier; title?: string }) {
  return (
    <span className="tier-chip" data-tier={tier} title={title ?? HINT[tier]}>
      {LABEL[tier]}
    </span>
  )
}
