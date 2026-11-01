// How the palette decides whether a row matches what you typed.
//
// cmdk's built-in scorer is a *subsequence* match: it accepts a row whenever
// the query's letters appear in order anywhere in the text, however far apart.
// That is fine for a fixed menu of twenty commands and wrong for four corpora
// of a few hundred rows each — typing "firewall" ranked a note titled
// "PowerShell 5.1 whole-file rewrite mojibakes UTF-8" as a hit, because
// f·i·r·e·w·a·l·l all occur in it in order. Once the mode prefixes invited
// searching one corpus deliberately, that stopped being a curiosity and
// started being the common case.
//
// So: every whitespace-separated term must appear as a contiguous run. The
// scoring beyond that only orders the survivors, and orders them the way you
// would expect — a title that starts with what you typed beats one that
// mentions it in the middle, and a short title beats a long one that happens
// to contain the same words.
//
// Rolling our own rather than reaching for command-score: cmdk 1.1.1 bundles
// that package internally and does not re-export it, and a subsequence scorer
// is the thing being replaced anyway.

const WORD_BOUNDARY = /[\s\-_/:.]/

// Term placement, best first. A run at the very start of the value is what you
// almost always meant; a run starting a word inside it is the next best thing.
const STARTS_VALUE = 1
const STARTS_WORD = 0.8
const MID_WORD = 0.5

function scoreTerm(value: string, term: string): number {
  const at = value.indexOf(term)
  if (at === -1) return 0
  if (at === 0) return STARTS_VALUE
  return WORD_BOUNDARY.test(value[at - 1]) ? STARTS_WORD : MID_WORD
}

// cmdk treats any score > 0 as a match and sorts by it descending, so this
// returns 0 for "not a match" and something in (0, 1] otherwise.
export function scorePaletteItem(value: string, search: string): number {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return 1 // nothing typed — everything shows, in list order

  const haystack = value.toLowerCase()
  let total = 0
  for (const term of terms) {
    const score = scoreTerm(haystack, term)
    if (score === 0) return 0 // every term must be present, not just most of them
    total += score
  }

  // Mean of the term scores, then a gentle preference for shorter values so a
  // note titled exactly what you typed outranks a paragraph that contains it.
  // Capped so a long title is nudged, never buried: the shortest possible
  // value keeps its full score and everything past 120 characters bottoms out
  // at 0.8 of it.
  const mean = total / terms.length
  const brevity = 1 - 0.2 * Math.min(haystack.length, 120) / 120
  return mean * brevity
}
