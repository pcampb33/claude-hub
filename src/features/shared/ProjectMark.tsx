import './project-mark.css'

// Deterministic project glyph: hue hashed from the registry id (fixed
// ~55% sat / 60% light), 20px rounded square, 2-letter uppercase monogram
// in mono font. Cross-agent contract component — keep props { id, name }.
function hueFromId(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return ((hash % 360) + 360) % 360
}

export function ProjectMark({ id, name }: { id: string; name: string }) {
  const hue = hueFromId(id)
  const monogram = (name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) || '??').toUpperCase()
  return (
    <span
      className="project-mark"
      aria-hidden="true"
      style={{
        color: `hsl(${hue} 55% 60%)`,
        backgroundColor: `hsl(${hue} 55% 60% / 0.16)`,
        borderColor: `hsl(${hue} 55% 60% / 0.4)`,
      }}
    >
      {monogram}
    </span>
  )
}
