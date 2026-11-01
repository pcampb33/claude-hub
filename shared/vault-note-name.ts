// The one place that knows how a vault note's title becomes its filename.
//
// This lives in `shared/` rather than `electron/` because both sides of the
// mapping need it and the renderer cannot import from `electron/` (no file in
// `src/` does). Before this module the two halves lived apart and had already
// drifted into a defect: `vault-write-core.ts` sanitised a title before writing
// it, while `matchExistingTitle` compared the **raw** title against the
// already-sanitised filename stems on disk. For any title containing one of
// these nine characters the match could never succeed, so the writer took its
// "this note is new" branch and `fs.writeFileSync` **truncated the existing
// note** instead of appending to it. 64 of 205 notes in the live vault (31%)
// carry a title that can never match its own filename.
//
// Keeping the pair adjacent is the point. A comment asserting that two modules
// agree is where parity goes to die — this repo has three such comments and two
// of them were already false.

// The characters Windows forbids in a filename. Every one collapses to '-', so
// the mapping is many-to-one and NOT invertible: both "a/b" and "a:b" become
// "a-b".
const FORBIDDEN = /[\\/:*?"<>|]/g

export function vaultNoteNameFor(title: string): string {
  return title.replace(FORBIDDEN, '-').trim()
}

// Compare a title against on-disk note names the way the filesystem will.
// Both sides are sanitised first: the stem is already sanitised by construction
// (it came off disk), and sanitising it again is a no-op, so this is safe and
// makes the symmetry explicit rather than assumed.
export function matchesNoteName(title: string, noteName: string): boolean {
  return vaultNoteNameFor(title).toLowerCase().trim() === vaultNoteNameFor(noteName).toLowerCase().trim()
}

// Presentation-only inverse, used by the Knowledge view and the command palette
// so a note reads the way its author wrote it.
//
// Deliberately partial, and it must stay that way: FORBIDDEN is many-to-one, so
// a true inverse does not exist. Restoring only ": " in the exact shape the
// sanitiser produces (a hyphen tight against the preceding word, followed by a
// space) recovers the overwhelmingly common case without inventing colons
// inside "64-nearest" or "gap — foe sensor". A note whose title contained a
// slash still renders with a colon; that is a known, bounded inaccuracy, and it
// is strictly better than showing the raw sanitised stem.
export function displayNoteTitle(title: string): string {
  return title.replace(/(\S)- /g, '$1: ')
}
