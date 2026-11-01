import { THEMES, useTheme } from '../shared/theme'

// Settings → Theme. Each card previews its theme with its own swatches
// (rendered under that theme's data-theme scope), so you see what you pick.
export function ThemePicker() {
  const [theme, setTheme] = useTheme()
  return (
    <div className="theme-picker" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={theme === t.id}
          className="theme-card"
          data-theme={t.id}
          onClick={() => setTheme(t.id)}
        >
          <span className="theme-card-swatches" aria-hidden="true">
            <i style={{ background: 'var(--bg-base)' }} />
            <i style={{ background: 'var(--bg-surface)' }} />
            <i style={{ background: 'var(--accent)' }} />
            <i style={{ background: 'var(--ok)' }} />
            <i style={{ background: 'var(--warn)' }} />
          </span>
          <span className="theme-card-name">{t.label}</span>
          <span className="theme-card-note">{t.note}</span>
        </button>
      ))}
    </div>
  )
}
