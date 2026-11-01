import { useEffect, useRef, useState } from 'react'
import { Command } from 'cmdk'
import type { RegistryEntry, SkillEntry, WorkflowEntry } from '../../../shared/ipc-types'
import { ProjectMark } from '../shared/ProjectMark'
import { toast } from '../shared/toast'
import { VIEWS, NAV_ORDER, SECTIONS, sectionOf } from '../../nav'
import { useGlobalSearch } from './useGlobalSearch'
import { MODE_CHIPS, MODE_PLACEHOLDERS, MODE_PREFIXES, type PaletteMode } from './mode'
import { scorePaletteItem } from './score'
import './command-palette.css'
import { readRegisteredProjects } from '../shared/useRegisteredProjects'

// Derived from the same table as the rail so a new view can never be missing
// here. Ctrl+n opens a rail section, so only a single-view section's view
// owns its digit; a tab inside Knowledge or Library shows its section instead
// (Ctrl+4 reopens whichever Knowledge tab you were last on).
const VIEW_ITEMS = NAV_ORDER.map((key) => {
  const section = sectionOf(key)
  const index = section ? SECTIONS.indexOf(section) : -1
  return {
    key,
    label: VIEWS[key].label,
    icon: VIEWS[key].icon,
    kind: section && section.views.length > 1 ? section.label : index >= 0 ? `Ctrl ${index + 1}` : 'view',
  }
})

const PROJECT_ACTIONS = [
  { label: 'Open folder', run: (id: string) => window.hubApi.openFolder(id) },
  { label: 'Open in VS Code', run: (id: string) => window.hubApi.openInVSCode(id) },
  { label: 'Open terminal', run: (id: string) => window.hubApi.openTerminal(id) },
  { label: 'Copy path', run: (id: string) => window.hubApi.copyPath(id) },
] as const

// With nothing typed the palette used to mount every note, skill and workflow
// it had — 273 items in an unranked wall. Each corpus arrives newest-first, so
// showing only the head of it is the ranking. A term lifts the cap entirely
// (cmdk can only match what is mounted, so capping under a query would hide
// real hits); a corpus-specific mode raises it, because asking for @notes is
// asking to browse them.
const IDLE_CAP = 5
const MODE_CAP = 30

const PREFIX_HINTS = Object.entries(MODE_PREFIXES) as [string, keyof typeof MODE_CHIPS][]

// "notes", "notes and skills", "notes, skills and transcripts" — the palette
// names what it could not read, because a missing corpus is otherwise
// indistinguishable from an empty one.
function listCorpora(names: string[]): string {
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean
  onClose: () => void
  onNavigate: (view: string, param?: string) => void
}) {
  const [projects, setProjects] = useState<RegistryEntry[]>([])
  // Three states, like every other reader of the registry: an empty Actions
  // group must not be how a failed read looks. Kept as its own effect rather
  // than useRegisteredProjects because the palette re-reads on every open, so
  // a project registered mid-session shows up without an app restart.
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [mode, setMode] = useState<PaletteMode>('all')
  const { failed, notes, skills, workflows, transcripts, coverage, searching, reset, minTranscriptQuery } = useGlobalSearch(
    open,
    term,
    mode,
  )
  const inputRef = useRef<HTMLInputElement>(null)
  // The element focused before the palette opened, so close() can return focus
  // there instead of blurring to <body> (which restarts the next Tab at the top
  // of the document).
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocus.current = document.activeElement as HTMLElement | null
    void readRegisteredProjects().then(
      (list) => {
        setProjects(list)
        setProjectsError(null)
      },
      (err: unknown) => setProjectsError(err instanceof Error ? err.message : String(err)),
    )
    // Focus the input once the overlay renders.
    const timer = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(timer)
  }, [open])

  if (!open) return null

  const close = () => {
    onClose()
    setTerm('')
    setMode('all')
    reset()
    // Restore focus to whatever the user had focused before opening, so the
    // next keystroke/Tab continues from there.
    previousFocus.current?.focus()
  }

  // A prefix typed — or pasted — at the head of an empty input becomes the
  // mode and is peeled off before cmdk ever scores against it.
  const changeTerm = (next: string) => {
    if (term === '' && next.length > 0) {
      const prefixed = MODE_PREFIXES[next[0]]
      if (prefixed) {
        setMode(prefixed)
        setTerm(next.slice(1))
        return
      }
    }
    setTerm(next)
  }

  const promoteSkill = async (skill: SkillEntry) => {
    // Close first: the copy is a filesystem round-trip and the toast, not a
    // frozen palette, is what reports how it went.
    close()
    const result = await window.hubApi.promoteSkillToGlobal(skill.id)
    if (result.ok) toast.success(`Promoted ${skill.name} to ~/.claude/skills — available in every project.`)
    else toast.error(result.message ?? `Could not promote ${skill.name}.`)
  }

  const runWorkflow = (workflow: WorkflowEntry, projectId: string) => {
    // Args deliberately empty — the same thing the launch panel sends when you
    // fill nothing in. The opened session still waits for your Enter.
    void window.hubApi.launchWorkflowSession(workflow.id, projectId, '')
    close()
  }

  const showViews = mode === 'all' || mode === 'views'
  // Actions are a long tail (one row per project × action), so in the mixed
  // mode they stay out of the way until a term can narrow them.
  const showActions = mode === 'views' || (mode === 'all' && term.length > 0)
  const showNotes = mode === 'all' || mode === 'notes'
  const showLibrary = mode === 'all' || mode === 'library'
  const showTranscripts = mode === 'all' || mode === 'transcripts'
  const cap = term ? undefined : mode === 'all' ? IDLE_CAP : MODE_CAP

  // Transcript hits arrive from the server already matched, so cmdk must not
  // filter them a second time against its own client-side rules — a snippet
  // matching deep inside a transcript rarely matches the session's title, and
  // cmdk would drop exactly the results the search just paid to find. Giving
  // each item a value that contains the raw term keeps it in the list.
  const transcriptValue = (index: number) => `transcript-${index} ${term}`
  const shortfall = minTranscriptQuery - term.trim().length

  return (
    <div className="palette-scrim" onMouseDown={close}>
      <div
        className="palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Command
          label="Command palette"
          // Substring matching in place of cmdk's built-in subsequence scorer,
          // which matched far more than it should over corpora this size —
          // see score.ts.
          filter={scorePaletteItem}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              close()
            } else if (e.key === 'Backspace' && mode !== 'all' && term === '') {
              // Backspace past the start of the term deletes the mode chip,
              // the way it deletes any other character before it.
              e.preventDefault()
              setMode('all')
            } else if (e.key === 'Tab') {
              // Focus trap: the input is the only tab stop (list items navigate
              // by arrow keys, cmdk's roving aria), so keep Tab from walking
              // into the app behind the scrim.
              e.preventDefault()
              inputRef.current?.focus()
            }
          }}
        >
          <div className="palette-input-row">
            {mode !== 'all' && (
              <span className="palette-mode-chip">
                {MODE_CHIPS[mode]}
                <button
                  type="button"
                  className="palette-mode-clear"
                  aria-label={`Clear the ${MODE_CHIPS[mode]} filter`}
                  onClick={() => {
                    setMode('all')
                    inputRef.current?.focus()
                  }}
                >
                  ×
                </button>
              </span>
            )}
            <Command.Input
              ref={inputRef}
              value={term}
              onValueChange={changeTerm}
              placeholder={MODE_PLACEHOLDERS[mode]}
            />
          </div>
          <Command.List>
            {/* "No matches." is a claim about the corpus, so it is withheld
                when a corpus failed — the footer says what happened instead,
                in one place rather than two. */}
            {(searching || failed.length === 0) && (
              <Command.Empty>{searching ? 'Searching transcripts…' : 'No matches.'}</Command.Empty>
            )}
            {showViews && (
              <Command.Group heading="Views">
                {VIEW_ITEMS.map(({ key, label, icon: Icon, kind }) => (
                  <Command.Item
                    key={key}
                    value={`view ${label}`}
                    onSelect={() => {
                      onNavigate(key)
                      close()
                    }}
                  >
                    <Icon className="palette-item-icon" />
                    <span>{label}</span>
                    <span className="palette-item-kind">{kind}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Sessions lead the content groups. They are the first thing the
                trigger promises, and this group only ever fills under a query
                (the search needs three characters), so idle order is unchanged
                — but below Notes/Skills/Workflows a word as ordinary as
                "session" pushed every transcript hit past the fold. */}
            {showTranscripts && transcripts.length > 0 && (
              <Command.Group heading="Transcripts">
                {transcripts.map((match, index) => (
                  <Command.Item
                    key={`t:${match.sessionId}:${match.agent?.id ?? ''}`}
                    value={transcriptValue(index)}
                    onSelect={() => {
                      onNavigate('sessions', match.sessionId)
                      close()
                    }}
                  >
                    <span className="palette-item-text">
                      {match.agent?.description || match.title}
                      <span className="palette-item-snippet">{match.snippet}</span>
                    </span>
                    <span className="palette-item-kind">
                      {match.agent ? `${match.agent.agentType} agent` : match.projectName}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {showNotes && notes.length > 0 && (
              <Command.Group heading="Notes">
                {notes.slice(0, cap).map((note) => (
                  <Command.Item
                    key={`note:${note.id}`}
                    // The de-sanitised title first, because a row must be
                    // findable by the text it shows; the raw filename stem is
                    // appended only when the sanitiser changed something, so a
                    // pasted [[wikilink]] still lands. The Knowledge view's
                    // search accepts both forms too.
                    value={`note ${note.title}${note.id === note.title ? '' : ` ${note.id}`}`}
                    onSelect={() => {
                      onNavigate('knowledge', note.id)
                      close()
                    }}
                  >
                    <span className="palette-item-text">{note.title}</span>
                    <span className="palette-item-kind">{note.project ?? 'note'}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {showLibrary && skills.length > 0 && (
              <Command.Group heading="Skills">
                {skills.slice(0, cap).map((skill) => (
                  <Command.Item
                    key={`skill:${skill.id}`}
                    value={`skill ${skill.name} ${skill.description ?? ''}`}
                    onSelect={() => {
                      onNavigate('skills', skill.id)
                      close()
                    }}
                  >
                    <span className="palette-item-text">{skill.name}</span>
                    <span className="palette-item-kind">{skill.projectName}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {showLibrary && workflows.length > 0 && (
              <Command.Group heading="Workflows">
                {workflows.slice(0, cap).map((workflow) => (
                  <Command.Item
                    key={`workflow:${workflow.id}`}
                    value={`workflow ${workflow.name} ${workflow.description ?? ''}`}
                    onSelect={() => {
                      onNavigate('workflows', workflow.id)
                      close()
                    }}
                  >
                    <span className="palette-item-text">{workflow.name}</span>
                    <span className="palette-item-kind">
                      {workflow.source === 'global' ? 'global' : 'project'}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Actions come last, because this group is combinatorial — every
                project × every action, plus every promotable skill and every
                runnable workflow — and cmdk cannot rank it down for us: its
                group sort looks the group element up by internal id while the
                element carries its heading in data-value, so it silently
                matches nothing and group order is only ever DOM order. Ahead
                of the content groups it filled the 320px list on its own.
                Slicing it instead would drop matches before they were scored,
                the same trap the idle cap above names, so it is ranked down
                rather than capped. It is hidden entirely while the input is
                empty, so the idle jump list keeps its Views-first order. */}
            {showActions && (
              <Command.Group heading="Actions">
                {projectsError && (
                  <Command.Item value="projects-unavailable" disabled>
                    <span className="palette-item-hint">Project list unavailable — {projectsError}</span>
                  </Command.Item>
                )}
                {projects.flatMap((project) =>
                  PROJECT_ACTIONS.map((action) => (
                    <Command.Item
                      key={`${project.id}:${action.label}`}
                      value={`${project.name} ${action.label}`}
                      onSelect={() => {
                        action.run(project.id)
                        close()
                      }}
                    >
                      <ProjectMark id={project.id} name={project.name} />
                      <span>
                        {project.name}
                        <span className="palette-item-action"> — {action.label}</span>
                      </span>
                    </Command.Item>
                  )),
                )}
                {/* A skill that is already global has nowhere to be promoted to. */}
                {skills
                  .filter((skill) => skill.source !== 'global')
                  .map((skill) => (
                    <Command.Item
                      key={`promote:${skill.id}`}
                      value={`${skill.name} promote skill to global`}
                      onSelect={() => void promoteSkill(skill)}
                    >
                      <span>
                        {skill.name}
                        <span className="palette-item-action"> — promote to global</span>
                      </span>
                      <span className="palette-item-kind">{skill.projectName}</span>
                    </Command.Item>
                  ))}
                {/* A global workflow has no project to open the session in. */}
                {workflows
                  .filter((workflow) => workflow.projectId !== null)
                  .map((workflow) => (
                    <Command.Item
                      key={`run:${workflow.id}`}
                      value={`${workflow.name} run workflow in session`}
                      onSelect={() => runWorkflow(workflow, workflow.projectId as string)}
                    >
                      <span>
                        {workflow.name}
                        <span className="palette-item-action"> — run in session</span>
                      </span>
                      <span className="palette-item-kind">{workflow.projectName}</span>
                    </Command.Item>
                  ))}
              </Command.Group>
            )}

            {/* The transcript search stops at a byte budget, so these hits are
                the newest slice of the corpus and nothing else. Saying so is
                the point: "No matches." over sessions nobody opened is a wrong
                answer. The sweep itself belongs to the Search view — a modal
                jump list is the wrong place to run a five-second walk — so
                this hands the query over instead of running it here. */}
            {showTranscripts && coverage && coverage.unscanned > 0 && (
              <Command.Item
                value={`transcript-more ${term}`}
                onSelect={() => {
                  onNavigate('search', term.trim())
                  close()
                }}
              >
                <span className="palette-item-text">
                  Search {coverage.unscanned} older session{coverage.unscanned === 1 ? '' : 's'}
                  <span className="palette-item-snippet">
                    Only sessions back to{' '}
                    {new Date(coverage.oldestScanned ?? Date.now()).toLocaleDateString()} were searched here
                  </span>
                </span>
                <span className="palette-item-kind">Search</span>
              </Command.Item>
            )}

            {showTranscripts && shortfall > 0 && term.trim().length > 0 && (
              <Command.Item value={`hint ${term}`} disabled>
                <span className="palette-item-hint">
                  Type {shortfall} more character{shortfall === 1 ? '' : 's'} to search transcripts
                </span>
              </Command.Item>
            )}
          </Command.List>
          {failed.length > 0 && (
            <div className="palette-degraded" role="status">
              Couldn&apos;t reach {listCorpora(failed)} — those results are missing, not absent.
            </div>
          )}
          {mode === 'all' && term === '' && (
            <div className="palette-hints">
              {PREFIX_HINTS.map(([prefix, narrow]) => (
                <span key={prefix} className="palette-hint">
                  <kbd>{prefix}</kbd> {MODE_CHIPS[narrow].toLowerCase()}
                </span>
              ))}
            </div>
          )}
        </Command>
      </div>
    </div>
  )
}
