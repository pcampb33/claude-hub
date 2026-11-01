import { useMemo, useState, type ReactNode } from 'react'
import type { RegistryEntry, WorkflowEntry } from '../../../../../shared/ipc-types'
import { PeekContent } from '../../peek'
import { usePeekTarget } from '../../peek-context'
import { Actions, Btn, Code, KV, Loading, Row, RowList, Sec, Unreachable } from '../../parts'
import { useProjects, useSkillsRead, useSkillUsageRead, useWorkflowsRead } from '../../reads'
import type { DetailProps } from '../../types'
import { useNavigate } from '../../../shared/useHashRoute'
import { relativeTime } from '../../../shared/relative-time'
import { toast } from '../../../shared/toast'
import { launchTargets, recentWorkflows, shortDate, skillEntriesFor, skillStat, WINDOW_DAYS } from './launch'
import { builtinCommand, useRankedSkills } from './builtin'
import './launch.css'

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Project select + the launch button. The opened session has the invocation
// typed in and waits for Enter, so nothing runs from here.
function StartSession({
  label,
  allowed,
  defaultId,
  launch,
  extra,
}: {
  label: string
  allowed: (projects: RegistryEntry[]) => RegistryEntry[]
  defaultId: string | null
  launch: (projectId: string) => Promise<void>
  extra?: ReactNode
}) {
  const projects = useProjects()
  const options = projects.status === 'data' ? allowed(projects.data) : []
  const [picked, setPicked] = useState<string | null>(null)
  const value = picked && options.some((p) => p.id === picked) ? picked : (options.find((p) => p.id === defaultId) ?? options[0])?.id ?? ''
  const [busy, setBusy] = useState(false)

  const start = () => {
    const project = options.find((p) => p.id === value)
    if (!project) return
    setBusy(true)
    launch(project.id)
      .then(() => toast.success(`Opening Claude Code in ${project.name} with ${label} typed in. It waits for you to press Enter.`))
      .catch((err: unknown) => toast.error(`Couldn’t open a session: ${errText(err)}`))
      .finally(() => setBusy(false))
  }

  return (
    <Sec title="Start a session">
      {projects.status === 'loading' ? (
        <Loading rows={1} />
      ) : projects.status === 'error' ? (
        <Unreachable what="the project list" error={projects.error} onRetry={projects.refresh} />
      ) : options.length === 0 ? (
        <p className="sub">No registered project can run this.</p>
      ) : (
        <div className="launch-run">
          <select value={value} onChange={(e) => setPicked(e.target.value)} aria-label={`Project to open ${label} in`}>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Btn kind="primary" onClick={start} disabled={busy || !value}>
            Start session
          </Btn>
        </div>
      )}
      <p className="sub">Opens Claude Code with {label} typed in. Nothing runs until you press Enter there.</p>
      {extra}
    </Sec>
  )
}

// Jump chips to the other launchers, like the board's chip row.
function OtherLaunchers({ current }: { current: string }) {
  const { launchable } = useRankedSkills()
  const workflows = useWorkflowsRead()
  const peekTarget = usePeekTarget()
  const skills = launchable.slice(0, 6)
  const flows = workflows.status === 'data' ? recentWorkflows(workflows.data).slice(0, 3) : []
  if (skills.length + flows.length === 0) return null
  return (
    <Sec title="Other launchers">
      <div className="launch-chips">
        {skills
          .filter((s) => `/${s.name}` !== current)
          .map((s) => (
            <span key={s.name} className="launch-chip" {...peekTarget('launch', { cmd: `/${s.name}` }, `/${s.name}`)}>
              /{s.name}
              <small>{s.uses30}×</small>
            </span>
          ))}
        {flows
          .filter((w) => w.id !== current)
          .map((w) => (
            <span key={w.id} className="launch-chip launch-chip-wf" {...peekTarget('launch', { workflow: w.id }, `Workflow ${w.name}`)}>
              {w.name}
              <small>workflow</small>
            </span>
          ))}
      </div>
    </Sec>
  )
}

function SkillPeek({ cmd }: { cmd: string }) {
  const name = cmd.replace(/^\//, '')
  const usage = useSkillUsageRead()
  const skills = useSkillsRead()
  const navigate = useNavigate()
  const now = Date.now()
  const u = usage.status === 'data' ? usage.data.find((x) => x.skill === name) : undefined
  const stat = u ? skillStat(u, now) : null
  const entries = skills.status === 'data' ? skillEntriesFor(skills.data, name) : []
  const entry = entries.find((e) => e.projectId === null) ?? entries[0]
  const builtin = builtinCommand(name, skills.status === 'data' ? skills.data : undefined)

  return (
    <>
      <Sec>
        {skills.status === 'loading' ? (
          <Loading rows={2} />
        ) : skills.status === 'error' ? (
          <Unreachable what="the skills list" error={skills.error} onRetry={skills.refresh} />
        ) : entry ? (
          <>
            <span className="launch-kind">skill · {entries.map((e) => e.projectName).join(', ')}</span>
            <p>{entry.description ?? 'No description in its SKILL.md.'}</p>
          </>
        ) : builtin ? (
          <>
            <span className="launch-kind">built-in command · {builtin.category}</span>
            <p>{builtin.description}</p>
          </>
        ) : (
          <>
            <span className="launch-kind">skill · not in your skills folders</span>
            <p className="sub">
              Used in sessions but not found under ~/.claude/skills or any project, so it comes from a plugin or ships with
              Claude Code. The hub has no description for it.
            </p>
          </>
        )}
      </Sec>
      <Sec title="Use">
        {usage.status === 'loading' ? (
          <Loading rows={3} />
        ) : usage.status === 'error' ? (
          <Unreachable what="skill usage" error={usage.error} onRetry={usage.refresh} />
        ) : stat ? (
          <KV
            rows={[
              [`Last ${WINDOW_DAYS} days`, stat.uses30],
              ['All time', stat.usesAll],
              ['Last used', stat.lastUsed ? `${shortDate(stat.lastUsed)} · ${relativeTime(stat.lastUsed, now)}` : '—'],
              ['Projects', stat.projects.length],
            ]}
          />
        ) : (
          <p className="sub">No use of /{name} in any session transcript.</p>
        )}
      </Sec>
      {stat && stat.projects.length > 0 && (
        <Sec title="Where it gets used (all time)">
          <RowList>
            {stat.projects.slice(0, 8).map((p) => (
              <Row key={p.name} label={p.name} figure={`${p.count}×`} />
            ))}
          </RowList>
        </Sec>
      )}
      {builtin ? (
        <Sec title="Start a session">
          <p className="sub">
            Built-in commands are handled by the Claude Code client itself, so the hub can’t launch one for you. Type{' '}
            /{name} at a session prompt.
          </p>
        </Sec>
      ) : (
        <StartSession
          label={`/${name}`}
          allowed={(projects) => launchTargets(entries, projects)}
          defaultId={stat?.recentProjectId ?? entry?.projectId ?? null}
          launch={(projectId) => window.hubApi.launchCommandSession(name, projectId)}
        />
      )}
      <OtherLaunchers current={cmd} />
      <Sec bare>
        <Actions>
          {builtin ? (
            <Btn onClick={() => navigate('commands', `builtin:${name}`)}>Open in Commands</Btn>
          ) : (
            <Btn
              onClick={() => entry && navigate('skills', entry.id)}
              disabled={!entry}
              title={entry ? undefined : 'Not in your skills folders, so the Library has no entry for it'}
            >
              Open in Library
            </Btn>
          )}
        </Actions>
      </Sec>
    </>
  )
}

function WorkflowPeek({ id }: { id: string }) {
  const workflows = useWorkflowsRead()
  const navigate = useNavigate()
  if (workflows.status === 'loading') return <Loading rows={4} />
  if (workflows.status === 'error')
    return <Unreachable what="workflows" error={workflows.error} onRetry={workflows.refresh} />
  const wf: WorkflowEntry | undefined = workflows.data.find((w) => w.id === id)
  if (!wf)
    return (
      <Sec>
        <p className="sub">This workflow is no longer in ~/.claude/workflows or any project’s .claude/workflows.</p>
      </Sec>
    )
  const agents = wf.composition.agentCount
  return (
    <>
      <Sec>
        <span className="launch-kind">workflow · {wf.projectName}</span>
        <p>{wf.description ?? 'No description in its meta block.'}</p>
        {wf.whenToUse && <p className="sub">When to use: {wf.whenToUse}</p>}
        {wf.example && <Code>{wf.example}</Code>}
      </Sec>
      <Sec title="Use">
        <KV
          rows={[
            ['Runs', <span className="sub">not counted: workflow runs leave no record the hub reads</span>],
            ['Last edited', `${shortDate(wf.mtime)} · ${relativeTime(wf.mtime, Date.now())}`],
            ['Agents', `${agents}${wf.composition.dynamic ? '+ (fans out at run time)' : ''}`],
            ['Phases', wf.composition.phases.length],
          ]}
        />
      </Sec>
      <StartSession
        label={`the ${wf.name} workflow`}
        allowed={(projects) => launchTargets([wf], projects)}
        defaultId={wf.projectId}
        launch={(projectId) => window.hubApi.launchWorkflowSession(wf.path, projectId, '')}
      />
      <OtherLaunchers current={wf.id} />
      <Sec bare>
        <Actions>
          <Btn onClick={() => navigate('workflows', wf.id)}>Open in Library</Btn>
        </Actions>
      </Sec>
    </>
  )
}

function Overview() {
  const { usage, ranked } = useRankedSkills()
  const workflows = useWorkflowsRead()
  const navigate = useNavigate()
  const peekTarget = usePeekTarget()
  const flows = useMemo(() => (workflows.status === 'data' ? recentWorkflows(workflows.data) : []), [workflows.status, workflows.data])
  return (
    <>
      <Sec title={`Commands used in the last ${WINDOW_DAYS} days`}>
        {usage.status === 'loading' ? (
          <Loading rows={4} />
        ) : usage.status === 'error' ? (
          <Unreachable what="skill usage" error={usage.error} onRetry={usage.refresh} />
        ) : ranked.length === 0 ? (
          <p className="sub">No skill or command used in the last {WINDOW_DAYS} days.</p>
        ) : (
          <RowList>
            {ranked.slice(0, 15).map((s) => (
              <Row
                key={s.name}
                label={s.builtin ? `/${s.name} · built-in` : `/${s.name}`}
                figure={`${s.uses30} · ${s.usesAll} all time`}
                target={peekTarget('launch', { cmd: `/${s.name}` }, `/${s.name} details`)}
              />
            ))}
          </RowList>
        )}
        <p className="sub">
          Counted from session transcripts: Skill-tool calls and typed slash commands. Built-ins stay off the board because
          the hub can’t launch them.
        </p>
      </Sec>
      <Sec title="Workflows, most recently edited">
        {workflows.status === 'loading' ? (
          <Loading rows={3} />
        ) : workflows.status === 'error' ? (
          <Unreachable what="workflows" error={workflows.error} onRetry={workflows.refresh} />
        ) : flows.length === 0 ? (
          <p className="sub">No workflows in ~/.claude or any project.</p>
        ) : (
          <RowList>
            {flows.slice(0, 8).map((w) => (
              <Row
                key={w.id}
                label={w.name}
                figure={`${w.projectName} · edited ${shortDate(w.mtime)}`}
                target={peekTarget('launch', { workflow: w.id }, `Workflow ${w.name} details`)}
              />
            ))}
          </RowList>
        )}
        <p className="sub">Workflow runs are not counted, so these are ordered by last edit.</p>
      </Sec>
      <Sec bare>
        <Actions>
          <Btn kind="primary" onClick={() => navigate('commands')}>
            Open Commands
          </Btn>
          <Btn onClick={() => navigate('workflows')}>Open Workflows</Btn>
        </Actions>
      </Sec>
    </>
  )
}

export function LaunchDetail({ ctx }: DetailProps) {
  const cmd = typeof ctx?.cmd === 'string' ? ctx.cmd : null
  const workflowId = typeof ctx?.workflow === 'string' ? ctx.workflow : null
  const workflows = useWorkflowsRead()
  const wfName = workflowId && workflows.status === 'data' ? workflows.data.find((w) => w.id === workflowId)?.name : null
  return (
    <PeekContent crumb="Launch pad" title={cmd ?? (workflowId ? (wfName ?? 'Workflow') : 'Launch pad')}>
      {cmd ? <SkillPeek key={cmd} cmd={cmd} /> : workflowId ? <WorkflowPeek key={workflowId} id={workflowId} /> : <Overview />}
    </PeekContent>
  )
}
