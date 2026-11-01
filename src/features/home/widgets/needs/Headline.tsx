import { headlineParts } from './needs-core'
import { useNeeds } from './useNeeds'
import './needs.css'

// The Home headline ("3 things need you"), from the same count the Needs you
// widget shows. Until every source has answered it says what it is still
// waiting on instead of claiming a number.
export function NeedsHeadline() {
  const { em, rest, note } = headlineParts(useNeeds())
  return (
    <>
      {em && <em>{em}</em>}
      {rest}
      {note && <span className="sub needs-headline-note"> · {note}</span>}
    </>
  )
}
