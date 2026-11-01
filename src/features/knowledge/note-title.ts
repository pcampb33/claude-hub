// Why the renderer needs an inverse at all: a vault note's id IS its filename
// stem, and vault-graph hands that stem to the UI as the note's title, so
// "Skyrim SKSE refscan: 64-nearest cap" arrives here as "…refscan- 64-nearest
// cap" — sanitisation the reader was never meant to see.
//
// The function itself now lives beside the sanitiser it undoes, so the two
// halves of the mapping cannot drift apart again (that drift was already a
// truncating bug once — see shared/vault-note-name.ts). Re-exported rather
// than moved outright because the Knowledge view's four components import it
// from here.
export { displayNoteTitle } from '../../../shared/vault-note-name'
