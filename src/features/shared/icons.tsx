// Hand-drawn 16px inline icons — stroke 1.5, currentColor, no icon library.

interface IconProps {
  className?: string
}

function base(className?: string) {
  return {
    className,
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
}

/** Home — a house outline. */
export function HomeIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M2.5 7.2 8 2.5l5.5 4.7V13a1 1 0 0 1-1 1h-3v-3.5h-3V14h-3a1 1 0 0 1-1-1V7.2Z" />
    </svg>
  )
}

/** Library — three books on a shelf, one leaning. */
export function LibraryIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <rect x="2" y="3" width="3" height="11" rx="0.5" />
      <rect x="6" y="3" width="3" height="11" rx="0.5" />
      <path d="m10.3 4.2 2.8-.8 2 10.1-2.8.8-2-10.1Z" />
    </svg>
  )
}

/** Extensions — a puzzle piece. */
export function ExtensionsIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M3 5h2.5a1.5 1.5 0 1 1 3 0H11v2.5a1.5 1.5 0 1 1 0 3V13H8.5a1.5 1.5 0 1 0-3 0H3v-2.5a1.5 1.5 0 1 0 0-3V5Z" />
    </svg>
  )
}

/** Projects — folder. */
export function ProjectsIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.8h5A1.5 1.5 0 0 1 14 6.3v5.2a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
    </svg>
  )
}

/** Sessions — a terminal window with a prompt caret. */
export function SessionsIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <rect x="1.75" y="3" width="12.5" height="10" rx="1.5" />
      <path d="m4.75 7 1.75 1.75-1.75 1.75" />
      <path d="M8.75 10.5h2.5" />
    </svg>
  )
}

/** Search — magnifier. */
export function SearchIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.3 10.3 3.2 3.2" />
    </svg>
  )
}

/** Skills — spark / four-point star. */
export function SkillsIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M8 1.8 9.6 6.4 14.2 8 9.6 9.6 8 14.2 6.4 9.6 1.8 8 6.4 6.4Z" />
    </svg>
  )
}

/** Knowledge — open book. */
export function KnowledgeIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M8 3.5C6.8 2.6 5 2.3 2.5 2.5v10c2.5-.2 4.3.1 5.5 1 1.2-.9 3-1.2 5.5-1v-10C11 2.3 9.2 2.6 8 3.5Z" />
      <path d="M8 3.5v10" />
    </svg>
  )
}

/** Commands — terminal prompt. */
export function CommandsIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="m3 5 3.5 3L3 11" />
      <path d="M8.5 12H13" />
    </svg>
  )
}

/** Inbox — tray with a slot. */
export function InboxIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M2.5 9.5 4 3.2A1 1 0 0 1 5 2.5h6a1 1 0 0 1 1 .7l1.5 6.3" />
      <path d="M2.5 9.5H6l1 1.8h2l1-1.8h3.5v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z" />
    </svg>
  )
}

/** Workflows — branching pipeline of nodes. */
export function WorkflowsIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <circle cx="4" cy="8" r="1.8" />
      <circle cx="12" cy="4" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <path d="M5.7 7 10.3 4.7M5.7 9l4.6 2.3" />
    </svg>
  )
}

/** Sandbox — flask. */
export function SandboxIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M6.2 2h3.6M7 2.2v4.2L3.2 12a1.4 1.4 0 0 0 1.2 2.1h7.2a1.4 1.4 0 0 0 1.2-2.1L9 6.4V2.2" />
      <path d="M5 9.5h6" />
    </svg>
  )
}

/** Settings — sliders / two adjustable tracks. */
export function SettingsIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M2.5 5h7M11.5 5h2" />
      <circle cx="10" cy="5" r="1.6" />
      <path d="M2.5 11h2M6.5 11h7" />
      <circle cx="6" cy="11" r="1.6" />
    </svg>
  )
}

/** Global — globe: the layer above every project. */
export function GlobalIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12" />
      <path d="M8 2c1.8 1.7 2.8 3.8 2.8 6S9.8 12.3 8 14C6.2 12.3 5.2 10.2 5.2 8S6.2 3.7 8 2Z" />
    </svg>
  )
}

/** Refresh — circular arrow, spins while its action is loading. */
export function RefreshIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M13 8a5 5 0 1 1-1.7-3.75" />
      <path d="M13 1.8v2.9h-2.9" />
    </svg>
  )
}

/** Usage — stacked columns on a baseline. */
export function UsageIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M2 14h12" />
      <path d="M4 11.5V8M8 11.5V3.5M12 11.5V6.5" />
    </svg>
  )
}
