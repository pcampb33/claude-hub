// The one way a failed project list is allowed to appear in a <select>.
//
// Five dropdowns render the registry, and every one of them used to show an
// empty list when the read failed — a control that works perfectly and offers
// nothing, which reads as "no projects registered" rather than "nobody could
// find out". Kept as one component so the five cannot drift into five
// different silences.
export function ProjectListUnavailableOption() {
  return (
    <option value="" disabled>
      Project list unavailable
    </option>
  )
}
