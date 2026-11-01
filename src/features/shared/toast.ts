// Module-level pub-sub singleton — no React context needed. Any code can
// call toast.success()/toast.error(); ToastHost (mounted once in App) is
// the only subscriber that renders them.

export interface ToastItem {
  id: number
  kind: 'success' | 'error'
  message: string
}

const AUTO_DISMISS_MS = 4000

type Listener = () => void

let toasts: ToastItem[] = []
let nextId = 1
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

function push(kind: ToastItem['kind'], message: string): void {
  const id = nextId++
  toasts = [...toasts, { id, kind, message }]
  emit()
  setTimeout(() => dismissToast(id), AUTO_DISMISS_MS)
}

// useSyncExternalStore-shaped: subscribe returns an unsubscribe, and
// getToasts returns a stable reference until the next emit.
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getToasts(): ToastItem[] {
  return toasts
}

export const toast = {
  success: (message: string) => push('success', message),
  error: (message: string) => push('error', message),
}
