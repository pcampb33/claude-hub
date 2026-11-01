import { useCallback, useEffect, useState } from 'react'
import { toast } from '../shared/toast'

export function useRubricSettings() {
  const [rubric, setRubric] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setRubric(await window.hubApi.getRubric())
      setError(null)
    } catch (err) {
      // Don't strand the view on a disabled, empty textarea (see useFloorStatus).
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const save = useCallback(async (text: string): Promise<boolean> => {
    setSaving(true)
    const res = await window.hubApi.saveRubric(text)
    setSaving(false)
    if (res.ok) {
      toast.success('Rubric saved. It applies from the next session.')
      setRubric(text)
    } else {
      toast.error(res.message ?? 'Could not save the rubric.')
    }
    return res.ok
  }, [])

  return { rubric, loading, error, refresh, saving, save }
}
