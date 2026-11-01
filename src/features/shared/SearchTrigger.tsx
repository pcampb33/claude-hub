import { SearchIcon } from './icons'
import './search-trigger.css'

// The titlebar affordance that opens the global palette.
//
// Deliberately a button rather than an <input>: the palette owns the real
// input and the focus trap, so a second focusable text box here would be
// somewhere to type that does nothing.
export function SearchTrigger({ onOpen, className = '' }: { onOpen: () => void; className?: string }) {
  return (
    <button
      type="button"
      className={`search-trigger ${className}`.trim()}
      onClick={onOpen}
      title="Search everything (Ctrl K)"
    >
      <SearchIcon className="search-trigger-icon" />
      <span className="search-trigger-label">Search sessions, notes, skills…</span>
      <span className="search-trigger-kbd">Ctrl K</span>
    </button>
  )
}
