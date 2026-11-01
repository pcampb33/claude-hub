import { useSyncExternalStore } from 'react'
import { subscribeToasts, getToasts, dismissToast } from './toast'
import './toast.css'

// Renders the toast stack bottom-right. Mount exactly once, at App level.
export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts)

  if (toasts.length === 0) return null

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)} title="Dismiss">
          {t.message}
        </button>
      ))}
    </div>
  )
}
