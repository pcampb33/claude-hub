// Rendering side of the vault graph's grouping: the cluster palette and the
// project → color map. The pure community/graph math (detectCommunities,
// nodeDegree) lives in shared/community.ts so the
// electron-side MOC generator can use it too.

// A muted categorical palette on the app's warm-dark ground — there's no
// categorical palette otherwise. Low-saturation so clusters read as tinted
// families rather than primary colors, but every entry is a distinct hue
// family: the previous eight paired dusty blue with slate and sand with ochre,
// which put three near-identical blues and two near-identical greens in one
// legend, and a 10-project vault cycled the 9th and 10th back onto exact
// duplicates of the 1st and 2nd. Ordered so the first entries are the furthest
// apart — most vaults only ever reach the first handful. Twelve is where
// perceptual separation runs out; beyond that it cycles and colors repeat.
export const CLUSTER_PALETTE = [
  '#7fa9d9', // blue
  '#e0a163', // amber
  '#7fc48a', // green
  '#d98ab8', // pink
  '#6fc7c9', // cyan
  '#b39ce0', // violet
  '#c8c46a', // olive
  '#dd7f77', // red
  '#9aa2ae', // gray
  '#a57f5c', // clay
  '#9b6f9e', // plum
  '#d9c9a0', // pale sand
]

// The same twelve hues, one step darker, for light themes (Clay): the dark
// palette's pastels wash out on a pale ground. Index-aligned with CLUSTER_PALETTE
// so the project → colour assignment never changes with the theme.
export const CLUSTER_PALETTE_LIGHT = [
  '#3f78b5',
  '#b9772a',
  '#3f8f55',
  '#b8548a',
  '#2a8f94',
  '#7c5cc0',
  '#8a8a22',
  '#c0463e',
  '#6b7380',
  '#8a5a35',
  '#7a4a80',
  '#a8955a',
]

// Re-tint a colour handed out by projectColorMap for the current ground.
// Anything not in the palette passes through untouched.
export function tintCluster(hex: string, light: boolean): string {
  if (!light) return hex
  const i = CLUSTER_PALETTE.indexOf(hex)
  return i < 0 ? hex : CLUSTER_PALETTE_LIGHT[i]
}

// Parse a theme token value (#rgb, #rrggbb or rgb()/rgba()) to channels.
export function parseColor(css: string): [number, number, number] | null {
  const s = css.trim()
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (h) {
    const x = h[1].length === 3 ? [...h[1]].map((c) => c + c).join('') : h[1]
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)]
  }
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function isLightColor(css: string): boolean {
  const c = parseColor(css)
  return c ? (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.5 : false
}

export function clusterColor(cluster: number): string {
  return CLUSTER_PALETTE[cluster % CLUSTER_PALETTE.length]
}

// Stable project → palette-color map for the graph's project grouping. Distinct
// non-null projects are sorted so index → color is deterministic, letting the
// canvas and the legend paint identical colors from one source. Null projects
// get no entry — callers paint those the neutral gray.
export function projectColorMap(projects: (string | null)[]): Map<string, string> {
  const distinct = [...new Set(projects.filter((p): p is string => p !== null))].sort()
  return new Map(distinct.map((p, i) => [p, clusterColor(i)]))
}
