// Shared "only operate on a path already returned by a known-good
// enumerator, never trust a raw renderer-supplied path" helper. Three
// call sites needed this shape independently (launch.ts's registry-id
// lookup stays separate — it's keyed by id, not path, a genuinely
// different shape) before it was worth generalizing; this is that point.
export function resolveKnownPath(candidate: string, knownPaths: string[], label: string): string {
  if (!knownPaths.includes(candidate)) {
    throw new Error(`No known ${label} at path "${candidate}"`)
  }
  return candidate
}
