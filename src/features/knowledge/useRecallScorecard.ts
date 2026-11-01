import { useEffect, useState } from 'react'
import type { RecallScorecard } from '../../../shared/ipc-types'

export function useRecallScorecard() {
  const [scorecard, setScorecard] = useState<RecallScorecard | null>(null)

  useEffect(() => {
    // Same degradation contract as useVaultInfo: the scorecard is a passive
    // experiment readout — absence is acceptable, never an error state.
    let cancelled = false
    window.hubApi.getRecallScorecard().then(
      (sc) => !cancelled && setScorecard(sc),
      () => !cancelled && setScorecard(null),
    )
    return () => {
      cancelled = true
    }
  }, [])

  return scorecard
}
