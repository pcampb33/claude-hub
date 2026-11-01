// VS Code-style mode prefixes: typing one as the first character of an empty
// input narrows the palette to a single corpus.
//
// The prefix is held as state and drawn as a chip rather than left in the
// input. That is not cosmetic — cmdk scores every item against the raw input
// string, and a '@' or '#' appears in no note title or skill name, so leaving
// the prefix in the box would filter the very group the prefix just asked for
// down to nothing.
export type PaletteMode = 'all' | 'views' | 'transcripts' | 'notes' | 'library'
export type NarrowMode = Exclude<PaletteMode, 'all'>

export const MODE_PREFIXES: Record<string, NarrowMode> = {
  '>': 'views',
  '#': 'transcripts',
  '@': 'notes',
  // Skills and workflows share one prefix because they share one shape: both
  // are invoked as /name in a session, and neither is big enough to be worth
  // its own key.
  '/': 'library',
}

export const MODE_CHIPS: Record<NarrowMode, string> = {
  views: 'Views & actions',
  transcripts: 'Transcripts',
  notes: 'Notes',
  library: 'Skills & workflows',
}

export const MODE_PLACEHOLDERS: Record<PaletteMode, string> = {
  all: 'Search sessions, notes, skills, workflows — or jump to a view…',
  views: 'Jump to a view, or run a project action…',
  transcripts: 'Search inside session transcripts…',
  notes: 'Search the knowledge vault…',
  library: 'Search skills and workflows…',
}
