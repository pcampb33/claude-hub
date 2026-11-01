import { useMemo, useState } from 'react'
import { WidgetCard } from '../shared/WidgetCard'
import { toast } from '../shared/toast'
import type { ConfigHealthReport, CrossProjectRedundancyFinding } from '../../../shared/ipc-types'

// One collapsed disclosure row — local findings and cross-project overlaps
// share the shape so both render through the same row component.
interface FindingRow {
  id: string
  severity: 'info' | 'warn'
  // 'global' rows come from ~/.claude/CLAUDE.md (getConfigHealth merges both
  // files' findings) — they must stay visually distinct, and the Open CTA
  // must not pretend the project's own CLAUDE.md contains them.
  source: 'project' | 'global'
  section: string
  kind: string
  tokens: number | null
  excerpt: string
  detail: string
}

// The scanner's rule vocabulary, given a surface a reader outside this
// codebase can act on: `label` replaces the raw rule id in the collapsed row,
// `fix` is the move the rule implies (the per-instance `detail` describes the
// evidence, and only sometimes names an action). Keyed loosely so an
// unrecognised kind falls back to printing itself rather than rendering blank.
const KIND_COPY: Record<string, { label: string; fix: string } | undefined> = {
  'unconditional-read': {
    label: 'Loaded on every session',
    fix: 'Move it behind a Skill description so it only loads when it is relevant.',
  },
  'stale-reference': {
    label: 'Points at a missing path',
    fix: 'Update the path or drop the reference — every session is being sent somewhere that no longer exists.',
  },
  'oversized-section': {
    label: 'Large section, always loaded',
    fix: 'Split it into a Skill so its tokens are spent only when the topic comes up.',
  },
  'redundant-content': {
    label: 'Duplicated content',
    fix: 'Keep one copy and cross-reference it, or extract the shared part into a Skill.',
  },
  'skill-shaped-candidate': {
    label: 'Reads like a Skill',
    fix: 'Extract the procedure into a Skill with a sharp description.',
  },
}

// Biggest cost first, unmeasured last. Findings arrive in file order, which
// across a 17-section CLAUDE.md is indistinguishable from no order — and the
// token count is the only number that separates one "Large section, always
// loaded" row from the next.
const byCost = (a: FindingRow, b: FindingRow) => (b.tokens ?? -1) - (a.tokens ?? -1)

// Progressive-disclosure findings panel: severity rollup chips in the header,
// collapsed rows (section + ~N tok, with the rule's human phrasing under it)
// expanding on select to excerpt + detail + fix + an "Open CLAUDE.md" CTA. The
// section heading owns its own line so the thing that identifies the finding is
// the last text to be clipped, not the first.
// The report is fetched once by the parent detail pane (ProjectDetail owns
// useConfigHealth so the header HealthRing and this panel share a single scan).
export function ConfigHealth({
  report,
  loading,
  projectId,
  projectPath,
  crossProjectFindings: allCrossProjectFindings,
  crossProjectError,
}: {
  report: ConfigHealthReport | null
  loading: boolean
  projectId: string
  projectPath: string
  // null = the overlap scan has not landed or failed. Distinct from [], which
  // is the measured claim that this project overlaps nothing.
  crossProjectFindings: CrossProjectRedundancyFinding[] | null
  crossProjectError: string | null
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  const rows = useMemo(
    (): FindingRow[] =>
      (report?.findings ?? []).map((f) => ({
        id: f.id,
        severity: f.severity,
        source: f.source,
        section: f.sectionHeading ?? '(untitled intro)',
        kind: f.kind,
        tokens: f.estimatedTokens,
        excerpt: f.excerpt,
        detail: f.detail,
      })),
    [report],
  )

  // allCrossProjectFindings is fetched once for every registered project at
  // the list level (see useCrossProjectRedundancy) — filtered here to just
  // the findings involving this card's project, mapped to the same row shape.
  const crossRows = useMemo(
    (): FindingRow[] =>
      (allCrossProjectFindings ?? [])
        .filter((f) => f.projectAPath === projectPath || f.projectBPath === projectPath)
        .map((f, i) => {
          const otherName = f.projectAPath === projectPath ? f.projectBName : f.projectAName
          const ownHeading = f.projectAPath === projectPath ? f.sectionHeading : f.otherSectionHeading
          return {
            id: `xp-${i}`,
            severity: 'info' as const,
            source: 'project' as const,
            section: ownHeading ?? '(untitled)',
            kind: 'redundant-content',
            tokens: f.estimatedTokens,
            excerpt: f.excerpt,
            detail: `${Math.round(f.similarity * 100)}% similar to ${otherName} — section "${
              ownHeading ?? '(untitled)'
            }" substantially overlaps with content in ${otherName}'s CLAUDE.md; consider extracting to a shared skill instead.`,
          }
        }),
    [allCrossProjectFindings, projectPath],
  )

  // Ranked, not listed. Sixteen identically-shaped Info rows rendered in file
  // order buried the one actionable warning seventh from the top; severity
  // now owns a group heading (so the row itself no longer repeats a chip that
  // says the same word sixteen times) and cost orders within it.
  const warnRows = useMemo(() => rows.filter((r) => r.severity === 'warn').sort(byCost), [rows])
  const infoRows = useMemo(() => rows.filter((r) => r.severity === 'info').sort(byCost), [rows])

  // Rollup chips count the scored (local) findings — the same set the header
  // ring's severity split reflects. Cross-project overlaps sit in their own
  // group below and don't feed the score.
  const warnCount = warnRows.length
  const infoCount = infoRows.length

  // Opens the file itself. A 'global' finding lives in ~/.claude/CLAUDE.md,
  // not this project's — the main process resolves that from the null id.
  const openClaudeMd = (source: FindingRow['source']) => () => {
    window.hubApi
      .openClaudeMd(source === 'global' ? null : projectId)
      .catch(() => toast.error('Open in VS Code failed.'))
  }

  const renderRow = (row: FindingRow) => {
    const open = openId === row.id
    const copy = KIND_COPY[row.kind]
    return (
      <div key={row.id} className="finding-row">
        <button
          type="button"
          className="finding-row-head"
          aria-expanded={open}
          onClick={() => setOpenId(open ? null : row.id)}
        >
          <span className={`finding-caret${open ? ' open' : ''}`}>›</span>
          <span className="finding-row-text">
            <span className="finding-row-top">
              <span className="finding-section" title={row.section}>
                {row.section}
              </span>
              {row.tokens !== null && <span className="finding-tokens">~{row.tokens.toLocaleString()} tok</span>}
            </span>
            <span className="finding-row-sub">
              <span className="finding-kind">{copy?.label ?? row.kind}</span>
              {row.source === 'global' && (
                <span className="finding-src-chip" title="From the global ~/.claude/CLAUDE.md, not this project's">
                  global
                </span>
              )}
            </span>
          </span>
        </button>
        {open && (
          <div className="finding-row-body">
            <div className="finding-excerpt">{row.excerpt}</div>
            <div className="finding-detail">{row.detail}</div>
            {copy && (
              <div className="finding-fix">
                <span className="finding-fix-label">Fix</span>
                {copy.fix}
              </div>
            )}
            <div className="finding-cta">
              <button className="btn-ghost" onClick={openClaudeMd(row.source)}>
                {row.source === 'global' ? 'Open global CLAUDE.md' : 'Open CLAUDE.md'}
              </button>
              {row.source === 'global' && <span className="finding-src-note">applies to every project</span>}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <WidgetCard
      title="Findings"
      padding={false}
      action={
        report && rows.length > 0 ? (
          <span className="config-health-chips">
            {warnCount > 0 && (
              <span className="sev-chip sev-chip-warn">
                <span className="sev-chip-dot" />
                {warnCount} warn
              </span>
            )}
            {infoCount > 0 && (
              <span className="sev-chip sev-chip-info">
                <span className="sev-chip-dot" />
                {infoCount} info
              </span>
            )}
          </span>
        ) : undefined
      }
    >
      <div className="config-health-panel">
        {loading && !report && <div className="config-health-status">Checking config health…</div>}
        {report && (
          <>
            {rows.length === 0 && crossRows.length === 0 && (
              <div className="config-health-status">No findings — config looks healthy.</div>
            )}
            {warnRows.length > 0 && (
              <div className="config-health-group-head config-health-group-warn">Needs attention</div>
            )}
            {warnRows.map(renderRow)}
            {infoRows.length > 0 && <div className="config-health-group-head">Informational</div>}
            {infoRows.map(renderRow)}
            {crossRows.length > 0 && (
              <>
                <div className="config-health-group-head">Overlaps with other projects</div>
                {crossRows.map(renderRow)}
              </>
            )}
            {/* Without this the panel simply shows no overlaps when the scan
                failed — indistinguishable from a project that genuinely
                duplicates nothing, which is a claim about a comparison that
                never ran. */}
            {crossProjectError !== null && (
              <div className="config-health-note">
                Overlap with other projects couldn't be checked — {crossProjectError}
              </div>
            )}
            {report.mcpUnmeasured && (
              <div className="config-health-note">
                MCP/hooks context cost isn't measured yet — not covered by this score.
              </div>
            )}
          </>
        )}
      </div>
    </WidgetCard>
  )
}
