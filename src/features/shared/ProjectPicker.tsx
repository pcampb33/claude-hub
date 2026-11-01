import { useState } from 'react'
import { useRegisteredProjects } from './useRegisteredProjects'
import { ProjectListUnavailableOption } from './ProjectListUnavailable'

// The one home of the "which projects are valid copy/promote targets" policy
// (the pinned sandbox project is not one). Two modes:
// - fire-on-select (Sandbox's Promote): pass `onSelect`; choosing an option
//   IS the action.
// - controlled (explicit-button flows like Skills' "Copy to project"): pass
//   `value` + `onChange`; the parent owns the action button.
export function ProjectPicker({
  onSelect,
  value,
  onChange,
  placeholder = 'Promote to…',
  ariaLabel,
}: {
  onSelect?: (projectId: string) => void
  value?: string
  onChange?: (projectId: string) => void
  placeholder?: string
  ariaLabel?: string
}) {
  const { projects: all, error: projectsError } = useRegisteredProjects()
  const [selected, setSelected] = useState('')
  // The sandbox itself isn't a valid promote target.
  const projects = all.filter((p) => !p.pinned)

  const controlled = value !== undefined
  return (
    <select
      value={controlled ? value : selected}
      aria-label={ariaLabel}
      onChange={(e) => {
        if (controlled) {
          onChange?.(e.target.value)
          return
        }
        setSelected(e.target.value)
        if (e.target.value) onSelect?.(e.target.value)
      }}
    >
      <option value="">{placeholder}</option>
      {projectsError ? (
        <ProjectListUnavailableOption />
      ) : (
        projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))
      )}
    </select>
  )
}
