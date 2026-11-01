import { floorState } from '../../../floor/useFloorStatus.ts'
import { healthIsCurrent, isBroken, neverUsed } from '../../../extensions/model.ts'
import type {
  ConfigHealthReport,
  ExtensionsSnapshot,
  FloorStatusReport,
  GlobalConfigReport,
  RecallScorecard,
  VaultInboxReport,
} from '../../../../../shared/ipc-types'
import type { Tone } from '../../parts'
import type { PeekCtx, WidgetId } from '../../types'

// Everything that wants a decision, gathered from six sources and ranked.
// Shared by the widget, its peek and the Home headline so the three can never
// disagree about the count. Pure: the hook feeds it reads, tests feed it
// fixtures.
//
// A source still loading is "pending", a source that failed is "unchecked",
// and neither ever contributes a zero — "nothing needs you" is only said when
// every source answered.

export interface SourceRead<T> {
  status: 'loading' | 'error' | 'data'
  data?: T
  error: string | null
}

export interface HealthEntry {
  id: string
  name: string
  configHealth: ConfigHealthReport
}

export interface NeedsSources {
  inbox: SourceRead<VaultInboxReport>
  automations: SourceRead<GlobalConfigReport>
  floors: SourceRead<FloorStatusReport>
  health: SourceRead<HealthEntry[]>
  extensions: SourceRead<ExtensionsSnapshot>
  recall: SourceRead<RecallScorecard>
}

export type SourceKey = keyof NeedsSources

export const SOURCE_LABEL: Record<SourceKey, string> = {
  inbox: 'the vault inbox',
  automations: 'automations',
  floors: 'verify floors',
  health: 'CLAUDE.md health',
  extensions: 'extensions',
  recall: 'the recall experiment',
}

export interface NeedItem {
  key: string
  tone: Tone
  // The short figure in the row's badge: a count, a score.
  badge: string
  title: string
  sub: string
  cta: string
  // The longer reason, shown in the Needs peek.
  why: string
  peek: { widget: WidgetId; ctx: PeekCtx }
  nav: { view: string; param?: string; label: string }
}

export interface Unchecked {
  source: SourceKey
  error: string
}

export interface NeedsSummary {
  items: NeedItem[]
  pending: SourceKey[]
  unchecked: Unchecked[]
}

// The "80 = healthy" line the Projects map draws; below it a CLAUDE.md is
// costing points worth a look, below 70 it is red.
export const HEALTHY_SCORE = 80
const RED_SCORE = 70
// docs: the recall hook is a bounded experiment — "unhook if offers are still
// unread after ~a month" (same window as knowledge/RecallScorecard.tsx).
const RECALL_EXPERIMENT_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000


const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
export const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n))

function ago(iso: string, nowMs: number): string {
  const min = Math.round((nowMs - Date.parse(iso)) / 60_000)
  if (Number.isNaN(min)) return 'at an unknown time'
  if (min < 60) return `${Math.max(min, 0)}m ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

// Rank: what is broken, then what is waiting, then what is merely unknown.
const RANK = ['floor-red', 'automation', 'inbox', 'extensions', 'health', 'floor-stale', 'automation-unknown', 'recall']
const rankOf = (key: string) => RANK.findIndex((r) => key === r || key.startsWith(`${r}:`))

export function buildNeeds(src: NeedsSources, nowMs: number): NeedsSummary {
  const items: NeedItem[] = []
  const pending: SourceKey[] = []
  const unchecked: Unchecked[] = []

  // Returns the data only when the source answered; otherwise files it as
  // pending or unchecked.
  function read<T>(key: SourceKey, r: SourceRead<T>): T | null {
    if (r.status === 'loading') pending.push(key)
    else if (r.status === 'error') unchecked.push({ source: key, error: r.error ?? 'unknown error' })
    else if (r.data !== undefined) return r.data
    return null
  }

  const inbox = read('inbox', src.inbox)
  if (inbox && inbox.count > 0) {
    const projects = [...new Set(inbox.entries.map((e) => e.project).filter((p): p is string => !!p))]
    items.push({
      key: 'inbox',
      tone: 'accent',
      badge: String(inbox.count),
      title: `${plural(inbox.count, 'note')} waiting in the vault inbox`,
      sub: projects.length > 0 ? projects.join(' · ') : 'from recent sessions',
      cta: 'Review',
      why: 'Curated findings wait for you to add them to the vault or discard them. Nothing enters the vault without that.',
      peek: { widget: 'inbox', ctx: null },
      nav: { view: 'inbox', label: 'Open Inbox' },
    })
  }

  const config = read('automations', src.automations)
  if (config) {
    for (const a of config.automations.filter((x) => x.state === 'attention')) {
      items.push({
        key: `automation:${a.id}`,
        tone: 'danger',
        badge: '!',
        title: `${a.label} isn’t doing its job`,
        sub: a.detail,
        cta: 'Look',
        why: `${a.kind === 'hook' ? 'Hook' : 'Scheduled job'} (${a.trigger}). Its work probe says it isn’t doing its job.`,
        peek: { widget: 'automation', ctx: { item: a.id } },
        nav: { view: 'global', label: 'Open Settings' },
      })
    }
    const unknown = config.automations.filter((x) => x.state === 'unknown')
    // A failed scheduler query makes every scheduled row unknown for one
    // reason; that is one thing to look at, not five.
    const schedulerDown = config.schedulerError !== null
    if (schedulerDown && unknown.some((a) => a.kind === 'scheduled')) {
      items.push({
        key: 'automation-unknown:scheduler',
        tone: 'unknown',
        badge: '?',
        title: 'Scheduled jobs can’t be checked',
        sub: config.schedulerError ?? '',
        cta: 'Look',
        why: `The Task Scheduler query failed, so no scheduled job can be graded: ${config.schedulerError}`,
        peek: { widget: 'automation', ctx: null },
        nav: { view: 'global', label: 'Open Settings' },
      })
    }
    for (const a of unknown.filter((x) => !(schedulerDown && x.kind === 'scheduled'))) {
      items.push({
        key: `automation-unknown:${a.id}`,
        tone: 'unknown',
        badge: '?',
        title: `Can’t tell whether ${a.label} is working`,
        sub: a.detail,
        cta: 'Look',
        why: `${a.kind === 'hook' ? 'Hook' : 'Scheduled job'} (${a.trigger}). Nothing it leaves behind could be read, so it grades unknown, never ok.`,
        peek: { widget: 'automation', ctx: { item: a.id } },
        nav: { view: 'global', label: 'Open Settings' },
      })
    }
  }

  const floors = read('floors', src.floors)
  if (floors) {
    for (const p of floors.projects.filter((x) => x.verifyCommand !== null)) {
      const state = floorState(p, nowMs)
      if (state === 'green') continue
      const red = state === 'red'
      items.push({
        key: `${red ? 'floor-red' : 'floor-stale'}:${p.id}`,
        tone: red ? 'danger' : 'warn',
        badge: red ? '✕' : '?',
        title: red ? `${p.name}’s verify floor is red` : `${p.name}’s verify floor is unverified`,
        sub: p.latest
          ? `${red ? 'failed' : 'last ran'} ${ago(p.latest.timestamp, nowMs)} · ${p.verifyCommand}`
          : `never run · ${p.verifyCommand}`,
        cta: red ? 'Fix' : 'Look',
        why: red
          ? `The last run of \`${p.verifyCommand}\` exited ${p.latest?.exitCode ?? 'abnormally'}.`
          : p.latest
            ? 'No run in the last 48 hours: two scheduled runs did not reach it.'
            : 'A verify command is set but has never been recorded.',
        peek: { widget: 'projects', ctx: { project: p.id } },
        nav: { view: 'projects', param: p.id, label: 'Open in Projects' },
      })
    }
  }

  const health = read('health', src.health)
  if (health && health.length > 0) {
    const ranked = [...health].sort((a, b) => a.configHealth.score - b.configHealth.score)
    const worst = ranked[0]
    const score = worst.configHealth.score
    if (score < HEALTHY_SCORE) {
      const othersBelow = ranked.filter((e) => e.configHealth.score < HEALTHY_SCORE).length - 1
      items.push({
        key: `health:${worst.id}`,
        tone: score < RED_SCORE ? 'danger' : 'warn',
        badge: String(score),
        title: `${worst.name}’s CLAUDE.md scores ${score}/100`,
        sub: [
          `lowest of ${health.length}`,
          `~${kTokens(worst.configHealth.combinedEstimatedTokens)} tokens loaded every session`,
          othersBelow > 0 ? `${plural(othersBelow, 'other')} below ${HEALTHY_SCORE}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        cta: 'Fix',
        why: `Oversized sections, unconditional reads and skill-shaped procedures cost points; ${plural(worst.configHealth.findings.length, 'finding')}.`,
        peek: { widget: 'projects', ctx: { project: worst.id } },
        nav: { view: 'projects', param: worst.id, label: 'Open in Projects' },
      })
    }
  }

  const ext = read('extensions', src.extensions)
  if (ext) {
    // Without a current health check every status is 'unchecked': that is
    // unknown, not "nothing broken". A re-check running after a failed one
    // is not current either (the failure left every item unchecked).
    if (!healthIsCurrent(ext.health)) {
      if (ext.health.state === 'running') pending.push('extensions')
      else unchecked.push({ source: 'extensions', error: ext.health.error ?? 'no health check has completed yet' })
    } else {
      const broken = ext.items.filter(isBroken)
      if (broken.length > 0) {
        const failed = broken.filter((i) => i.status === 'failed').length
        const auth = broken.filter((i) => i.status === 'needs-auth').length
        const other = broken.length - failed - auth
        const allMcp = broken.every((i) => i.kind === 'mcp')
        const noneUsed = broken.every(neverUsed)
        items.push({
          key: 'extensions',
          tone: 'danger',
          badge: String(broken.length),
          title: `${plural(broken.length, allMcp ? 'MCP server' : 'extension')} can’t connect`,
          sub: [
            failed > 0 ? `${failed} fail on every start` : null,
            auth > 0 ? `${auth} need sign-in` : null,
            other > 0 ? `${other} awaiting approval or unrecognised` : null,
            noneUsed ? 'none ever used' : null,
          ]
            .filter(Boolean)
            .join(' · '),
          cta: 'Open',
          why: 'Every session tries to connect them at start. A failure that signing in can’t fix needs the server or plugin changed.',
          peek: { widget: 'needs', ctx: { item: 'extensions' } },
          nav: { view: 'extensions', label: 'Open Extensions' },
        })
      }
    }
  }

  const recall = read('recall', src.recall)
  if (recall && recall.since) {
    const deadline = Date.parse(recall.since) + RECALL_EXPERIMENT_DAYS * DAY_MS
    if (nowMs > deadline && recall.readSessions === 0) {
      items.push({
        key: 'recall',
        tone: 'warn',
        badge: '0',
        title: 'The recall experiment’s verdict is due',
        sub: [
          `no offered note read in ${RECALL_EXPERIMENT_DAYS} days`,
          `${recall.delivered} delivered`,
          recall.incompleteScans > 0 ? `${plural(recall.incompleteScans, 'transcript')} unreadable` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        cta: 'Look',
        why: 'The rule: still no reads after a month → unhook vault-recall and keep manual inbox approval.',
        peek: { widget: 'recall', ctx: null },
        nav: { view: 'knowledge', label: 'Open Knowledge' },
      })
    }
  }

  items.sort((a, b) => rankOf(a.key) - rankOf(b.key))
  return { items, pending, unchecked }
}

// The headline under the date: "<em>3 things</em> need you". While a source
// is still loading or failed it says so rather than claiming a number it
// does not have.
export function headlineParts(s: NeedsSummary): { em: string | null; rest: string; note: string | null } {
  const n = s.items.length
  const checking = s.pending.length > 0 ? `still checking ${s.pending.map((k) => SOURCE_LABEL[k]).join(', ')}` : null
  const failed = s.unchecked.length > 0 ? `couldn’t check ${s.unchecked.map((u) => SOURCE_LABEL[u.source]).join(', ')}` : null
  if (n > 0) {
    const note = [checking, failed].filter(Boolean).join(' · ')
    return { em: plural(n, 'thing'), rest: n === 1 ? ' needs you' : ' need you', note: note || null }
  }
  if (checking) return { em: null, rest: 'Checking what needs you…', note: failed }
  if (failed) return { em: null, rest: 'Nothing found so far', note: failed }
  return { em: null, rest: 'Nothing needs you', note: null }
}
