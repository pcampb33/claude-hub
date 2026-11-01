import { useEffect, useState } from 'react'

// The dial's hand and the "in 44m" countdown are about the current minute;
// without a tick they freeze at whenever the data last arrived.
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
