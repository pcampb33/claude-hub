import type { HubFootprint } from '../../../shared/ipc-types'
import { ErrorNotice } from '../shared/ErrorNotice'

// Everything claude-hub has applied outside its own folder, in one card, so
// none of it has to be remembered. Read from the real state on every load.
export function Footprint({ footprint, hooks, scheduled }: { footprint: HubFootprint; hooks: number; scheduled: number }) {
  const { scope, curate, recallOutside, denyRules, denyRulesError, folders } = footprint
  return (
    <div className="card global-settings">
      {scope.error && <ErrorNotice message={`Hook scope: ${scope.error}. The hooks are running on the workspace alone.`} />}
      <dl>
        <dt>Global hooks</dt>
        <dd>
          {hooks} in ~/.claude/settings.json. Claude Code starts them in every session, but they only act in{' '}
          <code>{scope.workspace}</code>
          {scope.outside.length > 0 && (
            <>
              {' '}
              and {scope.outside.length} registered project{scope.outside.length === 1 ? '' : 's'} outside it:{' '}
              {scope.outside.map((p) => p.name).join(', ')}
            </>
          )}
          . Elsewhere they stop before reading anything.
          <span className="global-settings-note">
            {' '}
            · last 30 days:{' '}
            {curate === null
              ? 'curate log unreadable'
              : `curate reviewed ${curate.reviewed} session${curate.reviewed === 1 ? '' : 's'} with a model call, stood down outside the scope ${curate.outside}×`}
            {recallOutside !== null && recallOutside > 0 && `, recall stood down ${recallOutside}×`}
          </span>
        </dd>
        <dt>Scheduled tasks</dt>
        <dd>{scheduled} in Task Scheduler, working on claude-hub&apos;s own data</dd>
        <dt>Deny rules</dt>
        <dd>
          {denyRules === null
            ? denyRulesError
            : denyRules.length === 0
              ? 'none written into any project'
              : `written into .claude/settings.local.json of ${denyRules.map((d) => `${d.name} (${d.rules})`).join(', ')}`}
        </dd>
        <dt>Folders</dt>
        <dd>
          {folders.map((f, i) => (
            <span key={f.label}>
              {i > 0 && ' · '}
              {f.label} <code>{f.path}</code>
            </span>
          ))}
        </dd>
        <dt>Promoted skills</dt>
        <dd>
          Promote to global copies a skill into ~/.claude/skills (listed under Global skills below); claude-hub doesn&apos;t
          record which ones it copied
        </dd>
      </dl>
    </div>
  )
}
