import { HomeView } from './features/home'
import { ExtensionsView } from './features/extensions'
import { ProjectListView } from './features/project-list'
import { ConfigView } from './features/config'
import { SandboxView } from './features/sandbox'
import { SkillsView } from './features/skills'
import { KnowledgeView } from './features/knowledge'
import { SessionSearchView } from './features/session-search'
import { SessionsView } from './features/sessions'
import { DesktopView } from './features/desktop'
import { CommandsView } from './features/commands'
import { WorkflowsView } from './features/workflows'
import { InboxView } from './features/inbox'
import { RubricSettingsView } from './features/rubric-settings'
import { GlobalView } from './features/global'
import { UsageView } from './features/usage'
import {
  CommandsIcon,
  ExtensionsIcon,
  GlobalIcon,
  HomeIcon,
  InboxIcon,
  KnowledgeIcon,
  LibraryIcon,
  ProjectsIcon,
  SandboxIcon,
  SearchIcon,
  SessionsIcon,
  SettingsIcon,
  SkillsIcon,
  UsageIcon,
  WorkflowsIcon,
} from './features/shared/icons'

// The single source of truth for the app's routable views: the rail's
// sections, the command palette, and the Ctrl+n shortcuts all derive from
// this table — a view added here appears everywhere at once (the palette
// drifted out of sync when this lived only in App.tsx). Route keys are kept
// stable across the 2026-10 redesign so every navigate() call and deep link
// still lands: `dashboard` is Home, `global` is Settings.
export const VIEWS = {
  dashboard: { label: 'Home', component: HomeView, icon: HomeIcon },
  inbox: { label: 'Inbox', component: InboxView, icon: InboxIcon },
  // The Sessions section: live terminals the hub owns, then the read-only
  // transcript history (route key unchanged, so old #/sessions links land).
  desktop: { label: 'Desktop', component: DesktopView, icon: SessionsIcon },
  sessions: { label: 'History', component: SessionsView, icon: SessionsIcon },
  projects: { label: 'Projects', component: ProjectListView, icon: ProjectsIcon },
  usage: { label: 'Usage', component: UsageView, icon: UsageIcon },
  // Per-project Claude Code config layers and the project's declared boundary.
  config: { label: 'Config', component: ConfigView, icon: ProjectsIcon },
  search: { label: 'Search', component: SessionSearchView, icon: SearchIcon },
  skills: { label: 'Skills', component: SkillsView, icon: SkillsIcon },
  knowledge: { label: 'Notes', component: KnowledgeView, icon: KnowledgeIcon },
  commands: { label: 'Commands', component: CommandsView, icon: CommandsIcon },
  workflows: { label: 'Workflows', component: WorkflowsView, icon: WorkflowsIcon },
  extensions: { label: 'Extensions', component: ExtensionsView, icon: ExtensionsIcon },
  sandbox: { label: 'Sandbox', component: SandboxView, icon: SandboxIcon },
  // Key is the route ("#/rubric"), so it has to say what the label says — it
  // was `settings` while the rail read "Rubric", and a deep link that names a
  // different view than the one it opens is a lie with a URL attached.
  rubric: { label: 'Rubric', component: RubricSettingsView, icon: SettingsIcon },
  // Everything that is not per-project: the ~/.claude hooks, the scheduled
  // jobs, the settings every session inherits, and the app's theme.
  global: { label: 'Settings', component: GlobalView, icon: GlobalIcon },
} as const

export type ViewKey = keyof typeof VIEWS

// The rail: eight sections, each one or more views. A section with several
// views shows them as a tab strip above the view (App.tsx); each tab is still
// its own route, so a deep link to `#/rubric` opens Knowledge on its Rubric
// tab. Ctrl+1..8 walk the sections. Settings sits at the foot of the rail.
//
// `search` is deliberately in no section: it is a route, not a destination.
// The titlebar's Ctrl+K trigger is always on screen and searches a superset
// (sessions, notes, skills, workflows). The view itself still matters — the
// palette caps its transcript scan at a byte budget and hands the full sweep
// to it (see command-palette) — so it stays routable, just not in the rail.
export type SectionKey = 'home' | 'sessions' | 'projects' | 'knowledge' | 'library' | 'extensions' | 'sandbox' | 'settings'

export interface Section {
  key: SectionKey
  label: string
  icon: (props: { className?: string }) => JSX.Element
  views: ViewKey[]
}

export const SECTIONS: Section[] = [
  { key: 'home', label: 'Home', icon: HomeIcon, views: ['dashboard'] },
  { key: 'sessions', label: 'Sessions', icon: SessionsIcon, views: ['desktop', 'sessions'] },
  { key: 'projects', label: 'Projects', icon: ProjectsIcon, views: ['projects', 'config', 'usage'] },
  { key: 'knowledge', label: 'Knowledge', icon: KnowledgeIcon, views: ['inbox', 'knowledge', 'rubric'] },
  { key: 'library', label: 'Library', icon: LibraryIcon, views: ['skills', 'commands', 'workflows'] },
  { key: 'extensions', label: 'Extensions', icon: ExtensionsIcon, views: ['extensions'] },
  { key: 'sandbox', label: 'Sandbox', icon: SandboxIcon, views: ['sandbox'] },
  { key: 'settings', label: 'Settings', icon: SettingsIcon, views: ['global'] },
]

export function sectionOf(view: ViewKey): Section | undefined {
  return SECTIONS.find((s) => s.views.includes(view))
}

// Every view reachable from the rail, in rail order — the palette's jump list.
export const NAV_ORDER: ViewKey[] = SECTIONS.flatMap((s) => s.views)

export function isViewKey(value: string): value is ViewKey {
  return value in VIEWS
}
