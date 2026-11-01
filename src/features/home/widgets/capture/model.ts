// The vault note a write landed in, from its path. writeVaultNote appends to
// an existing note whose title matches, so this can differ from the title
// that was typed — the toast names where the text actually went.
export function noteNameFromPath(notePath: string | undefined): string | null {
  if (!notePath) return null
  const base = notePath.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.md$/i, '') || null
}
