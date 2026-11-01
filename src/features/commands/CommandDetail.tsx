import type { CommandItem } from './useCommands'
import { copyText } from '../shared/copy-text'

// The detail half of the pair: the selected command, its description in full
// (the master row ellipsises it), and its actions spelled out as buttons that
// are there on a cold read. The old grid hid Copy/Run behind :hover, so the
// view showed 54 commands and no way to act on any of them.
export function CommandDetail({
  command,
  onRun,
  runNote,
}: {
  command: CommandItem
  onRun?: () => void
  // Always rendered: either what Run does, or why this command has none.
  runNote: string
}) {
  const slash = `/${command.name}`
  return (
    <div className="command-detail">
      <div className="command-detail-eyebrow">
        {command.live ? 'Your skill · found on disk' : `Built-in · ${command.group}`}
      </div>
      <h3 className="command-detail-name">{slash}</h3>
      {/* Same wording as the Skills list: a blank line would read as both
          "never run" and "we didn't look". */}
      {command.usageCount !== null && (
        <div className={`command-detail-usage${command.usageCount === 0 ? ' unused' : ''}`}>
          {command.usageCount > 0 ? `used ${command.usageCount}×` : 'Not used yet'}
        </div>
      )}

      <p className={`command-detail-desc${command.description ? '' : ' empty'}`}>
        {command.description || 'No description in this skill’s frontmatter.'}
      </p>

      <div className="command-use">
        <div className="command-use-title">Use it</div>
        <div className="command-use-row">
          <button
            type="button"
            onClick={() =>
              void copyText(slash, {
                success: `Copied ${slash} — paste it into any session.`,
                failure: `Couldn't copy ${slash}.`,
              })
            }
          >
            Copy {slash}
          </button>
          {onRun && (
            <button type="button" className="command-run" onClick={onRun}>
              Run in session ↗
            </button>
          )}
        </div>
        <p className="command-use-note">{runNote}</p>
      </div>
    </div>
  )
}
