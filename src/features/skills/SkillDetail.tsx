import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '../shared/toast'
import { useNavigate } from '../shared/useHashRoute'
import { usePromote } from '../shared/usePromote'
import { ProjectPicker } from '../shared/ProjectPicker'
import type { PromoteResult, SkillInvocationRecord } from '../../../shared/ipc-types'
import type { SkillWithUsage } from './useSkillsList'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const SPARK_WEEKS = 12
// Below this many weeks with a run, the 12-week axis is more gutter than
// chart — state the window's contents instead of drawing a shape into it.
const SPARK_MIN_WEEKS = 3
const RECENT_LIMIT = 10

// Bucket invocation timestamps into the trailing 12 calendar weeks
// (oldest→newest, last bucket ends now).
function weeklyBuckets(invocations: SkillInvocationRecord[], nowMs: number): number[] {
  const buckets = new Array<number>(SPARK_WEEKS).fill(0)
  for (const inv of invocations) {
    const age = nowMs - new Date(inv.ts).getTime()
    if (Number.isNaN(age) || age < 0 || age >= SPARK_WEEKS * WEEK_MS) continue
    buckets[SPARK_WEEKS - 1 - Math.floor(age / WEEK_MS)]++
  }
  return buckets
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// CRLF-insensitive equality for the identical/diverged badge — the copies
// live on one Windows machine, but a git-checkout copy can still differ from
// a hand-saved one purely in line endings.
function normalizeSource(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

// The detail pane for the selected skill. Keyed on skill.id by the parent so
// per-selection state (target project, tailor, source disclosure) resets on
// selection change. Leads with the usage evidence, then description and the
// SKILL.md disclosure, and ends in two explicit action blocks — the button is
// the action, never the select.
export function SkillDetail({
  skill,
  duplicates,
  sessionTitles,
  onPromote,
  onPromoteAndTailor,
  onPromoteToGlobal,
  onReadSource,
  onRefresh,
}: {
  skill: SkillWithUsage
  duplicates: SkillWithUsage[] // other installed copies of the same name
  // sessionId → title for the "Recent invocations" links, owned by
  // useSkillsList (refreshed with the list). null while loading/unavailable.
  sessionTitles: Map<string, string> | null
  onPromote: (sourcePath: string, targetProjectId: string) => Promise<PromoteResult>
  onPromoteAndTailor: (sourcePath: string, targetProjectId: string) => Promise<PromoteResult>
  onPromoteToGlobal: (sourcePath: string) => Promise<PromoteResult>
  onReadSource: (skillPath: string) => Promise<string>
  onRefresh: () => void
}) {
  const navigate = useNavigate()
  const { promoteWith } = usePromote(skill.path, onPromote)
  const [tailor, setTailor] = useState(false)
  const [target, setTarget] = useState('')
  const [copying, setCopying] = useState(false)
  const [promoting, setPromoting] = useState(false)
  const [source, setSource] = useState<string | null>(null)
  const [sourceOpen, setSourceOpen] = useState(false)
  // A skill's description is its frontmatter trigger block, not prose — often
  // ten-plus lines of "MANDATORY TRIGGERS: …". Clamped by default so it can't
  // out-shout the usage evidence above it, which is the reason to open a skill.
  const [descOpen, setDescOpen] = useState(false)
  const [descOverflows, setDescOverflows] = useState(false)
  // 'identical' | 'diverged' per duplicate, in duplicates order; null while
  // the SKILL.md comparison is still loading (or failed — no badge then).
  const [dupCompare, setDupCompare] = useState<('identical' | 'diverged')[] | null>(null)

  useEffect(() => {
    if (duplicates.length === 0) return
    let alive = true
    Promise.all([onReadSource(skill.path), ...duplicates.map((d) => onReadSource(d.path))])
      .then(([self, ...others]) => {
        if (!alive) return
        const norm = normalizeSource(self)
        setDupCompare(others.map((t) => (normalizeSource(t) === norm ? 'identical' : 'diverged')))
      })
      .catch(() => {
        // comparison unavailable — the strip still lists the copies, badge-less
      })
    return () => {
      alive = false
    }
    // Keyed remount per selection: skill/duplicates are fixed for this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const nowMs = useMemo(() => Date.now(), [])
  const buckets = useMemo(() => weeklyBuckets(skill.invocations, nowMs), [skill.invocations, nowMs])
  const bucketMax = Math.max(...buckets, 1)
  const activeWeeks = buckets.filter((v) => v > 0).length
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const inv of skill.invocations) counts.set(inv.project, (counts.get(inv.project) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [skill.invocations])
  // With every project on a single invocation the bars are all 100% of a
  // maximum of 1 — full-width bars that encode nothing. Drop them there and
  // let the counts speak; a real spread still gets the comparison.
  const projectMax = projectCounts[0]?.[1] ?? 1
  const showBars = projectMax > 1
  const recent = skill.invocations.slice(0, RECENT_LIMIT)

  const handleCopy = async () => {
    if (!target) return
    setCopying(true)
    try {
      await promoteWith(tailor ? onPromoteAndTailor : onPromote, target)
    } finally {
      setCopying(false)
    }
  }

  const projectCopyCount = 1 + duplicates.filter((d) => d.source !== 'global').length
  const hasGlobalCopy = duplicates.some((d) => d.source === 'global')

  const handlePromoteGlobal = async () => {
    setPromoting(true)
    try {
      const res = await onPromoteToGlobal(skill.path)
      if (res.ok) {
        toast.success('Promoted to ~/.claude/skills — available in every project.')
        onRefresh()
      } else {
        toast.error(res.message ?? 'Promote failed.')
      }
    } finally {
      setPromoting(false)
    }
  }

  // Offer "Show more" only when the clamp is actually hiding something —
  // measured on mount (the pane is keyed per selection, so it remounts) rather
  // than guessed from a character count, whose right threshold varies with the
  // pane width. Stays true once set, so "Show less" survives the expansion.
  const measureDesc = useCallback((el: HTMLParagraphElement | null) => {
    if (el) setDescOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [])

  const toggleSource = async (open: boolean) => {
    if (open && source === null) {
      try {
        setSource(await onReadSource(skill.path))
      } catch {
        toast.error('Could not read SKILL.md.')
        return
      }
    }
    setSourceOpen(open)
  }

  return (
    <article className="card skill-detail">
      <div className="skill-detail-eyebrow">{skill.path}</div>

      <header className="skill-detail-header">
        <div className="skill-detail-headline">
          <div className="skill-detail-title-row">
            <strong className="skill-detail-name">{skill.name}</strong>
            <span className="badge badge-neutral">{skill.source}</span>
          </div>
          {/* For global skills the byline would just repeat the badge — only
              project skills get their owning project named. */}
          {skill.source !== 'global' && <div className="skill-detail-byline">{skill.projectName}</div>}
        </div>
      </header>

      {duplicates.length > 0 && (
        <div className="dup-strip">
          <span className="dup-strip-glyph">⧉</span>
          <span>Also installed in</span>
          {duplicates.map((d, i) => (
            <span className="dup-strip-item" key={d.id}>
              <button type="button" className="dup-link" onClick={() => navigate('skills', d.id)}>
                {d.projectName} →
              </button>
              {dupCompare?.[i] && (
                <span className={`badge ${dupCompare[i] === 'identical' ? 'badge-clean' : 'badge-dirty'}`}>
                  {dupCompare[i]}
                </span>
              )}
            </span>
          ))}
          <span className="dup-note">
            Copies are compared by SKILL.md content. Usage is merged by name across all copies, so every copy shares
            the totals below.
          </span>
        </div>
      )}

      <div className="skill-detail-label">Usage</div>
      {skill.usedCount > 0 && skill.lastUsed ? (
        <>
          <div className="usage-stats">
            <div className="usage-stat">
              <div className="usage-stat-num">{skill.usedCount}×</div>
              <div className="usage-stat-cap">invocations</div>
            </div>
            <div className="usage-stat">
              <div className="usage-stat-num">{new Date(skill.lastUsed).toLocaleDateString()}</div>
              <div className="usage-stat-cap">last used</div>
            </div>
            <div className="usage-stat">
              <div className="usage-stat-num">{new Set(skill.invocations.map((i) => i.project)).size || '—'}</div>
              <div className="usage-stat-cap">projects</div>
            </div>
            {activeWeeks >= SPARK_MIN_WEEKS ? (
              <div className="usage-spark">
                <div className="spark-bars">
                  {buckets.map((v, i) => (
                    <div
                      key={i}
                      className={`spark-bar${v === 0 ? ' zero' : ''}`}
                      style={v > 0 ? { height: `${Math.max(Math.round((v / bucketMax) * 100), 8)}%` } : undefined}
                      data-v={v}
                    />
                  ))}
                </div>
                <div className="spark-axis">
                  <span>{shortDate(nowMs - SPARK_WEEKS * WEEK_MS)}</span>
                  <span>per week</span>
                  <span>{shortDate(nowMs)}</span>
                </div>
              </div>
            ) : (
              <div className="usage-spark sparse">
                {activeWeeks === 0
                  ? `No runs in the last ${SPARK_WEEKS} weeks.`
                  : `${activeWeeks} of the last ${SPARK_WEEKS} weeks had a run — too sparse to chart.`}
              </div>
            )}
          </div>

          {skill.invocations.length > 0 && (
            <div className="usage-evidence">
              <div>
                <div className="skill-detail-label">Where</div>
                {projectCounts.map(([project, count]) => (
                  <div className={`proj-row${showBars ? '' : ' no-bar'}`} key={project}>
                    <span className="proj-name" title={project}>
                      {project}
                    </span>
                    {showBars && (
                      <span className="proj-bar-track">
                        <span className="proj-bar" style={{ width: `${Math.round((count / projectMax) * 100)}%` }} />
                      </span>
                    )}
                    <span className="proj-count">{count}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="skill-detail-label">Recent invocations</div>
                {recent.map((inv, i) => {
                  const title = sessionTitles?.get(inv.sessionId)
                  return (
                    <div className="invok-row" key={`${inv.sessionId}-${inv.ts}-${i}`}>
                      <span className="invok-date">{new Date(inv.ts).toLocaleDateString()}</span>
                      <span className="invok-proj" title={inv.project}>
                        {inv.project}
                      </span>
                      <span className="invok-title">{title ?? ''}</span>
                      {/* Only sessions still in the recent-sessions window get a
                          link — a pruned/aged-out id would land the Sessions
                          view on an unrelated fallback selection. */}
                      {title !== undefined && (
                        <a
                          className="invok-open"
                          href={`#/sessions/${encodeURIComponent(inv.sessionId)}`}
                          onClick={(e) => {
                            e.preventDefault()
                            navigate('sessions', inv.sessionId)
                          }}
                        >
                          open session →
                        </a>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="skill-detail-usage-empty">Not used yet in any session.</p>
      )}

      <div className="skill-detail-label">Description</div>
      {skill.description ? (
        <>
          <p
            ref={measureDesc}
            className={`skill-detail-desc${descOpen ? '' : ' clamped'}${descOverflows ? ' has-more' : ''}`}
          >
            {skill.description}
          </p>
          {descOverflows && (
            <button
              type="button"
              className="skill-desc-more"
              onClick={() => setDescOpen((v) => !v)}
              aria-expanded={descOpen}
            >
              {descOpen ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      ) : (
        <p className="skill-detail-desc skill-detail-desc-empty">No description.</p>
      )}

      <details
        className="skill-source"
        open={sourceOpen}
        onToggle={(e) => {
          const open = (e.currentTarget as HTMLDetailsElement).open
          if (open !== sourceOpen) void toggleSource(open)
        }}
      >
        <summary>
          <span className="skill-source-caret">▸</span>
          <code>View SKILL.md</code>
          <span className="skill-source-meta">
            {source !== null ? `${source.split('\n').length} lines · ` : ''}modified{' '}
            {new Date(skill.mtime).toLocaleDateString()}
          </span>
        </summary>
        {source !== null && <pre>{source}</pre>}
      </details>

      <div className="action-grid">
        <div className="action-block">
          <div className="action-block-title">Copy to project</div>
          <div className="action-block-row">
            <ProjectPicker
              value={target}
              onChange={setTarget}
              placeholder="Choose project…"
              ariaLabel="Copy target project"
            />
            <button onClick={handleCopy} disabled={!target || copying}>
              {copying ? 'Copying…' : 'Copy'}
            </button>
          </div>
          <label className="skill-detail-tailor">
            <input type="checkbox" checked={tailor} onChange={(e) => setTailor(e.target.checked)} />
            Open for editing after copy
          </label>
          <p className="action-block-hint">
            Copies into the chosen project's <code>.claude/skills/</code>. Refuses on name conflict.
          </p>
        </div>

        {skill.source !== 'global' && (
          <div className="action-block global">
            <div className="action-block-title">Promote to global</div>
            <div className="action-block-row">
              <button className="btn-primary" onClick={handlePromoteGlobal} disabled={promoting || hasGlobalCopy}>
                {promoting ? 'Promoting…' : 'Promote to ~/.claude/skills'}
              </button>
            </div>
            <p className="action-block-hint">
              {hasGlobalCopy ? (
                <>A global copy of this name already exists — nothing to promote.</>
              ) : (
                <>
                  Makes it available in <strong>every project, including future ones</strong>.{' '}
                  {projectCopyCount > 1 ? `The ${projectCopyCount} project copies stay` : 'The project copy stays'}{' '}
                  untouched — review and remove them after verifying the global one triggers. Refuses on name
                  conflict.
                </>
              )}
            </p>
          </div>
        )}
      </div>
    </article>
  )
}
