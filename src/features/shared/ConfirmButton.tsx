import { useEffect, useRef, useState } from 'react'

// Two-step destructive action: first click arms ("Confirm remove?"),
// second click within 3s fires. Same timer pattern LaunchActions used
// for its transient states.
const ARM_MS = 3000

export function ConfirmButton({
  label,
  confirmLabel = 'Confirm remove?',
  onConfirm,
  title,
  disabled,
}: {
  label: string
  confirmLabel?: string
  onConfirm: () => void
  // A destructive action that is currently unsafe stays visible and says why
  // on hover, rather than vanishing — same shape as the Resume-in-terminal
  // gate it sits beside in the session detail.
  title?: string
  disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => clearTimeout(timer.current), [])

  const handleClick = () => {
    if (!armed) {
      setArmed(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setArmed(false), ARM_MS)
      return
    }
    clearTimeout(timer.current)
    setArmed(false)
    onConfirm()
  }

  return (
    <button
      className={`btn-ghost confirm-button${armed ? ' armed' : ''}`}
      onClick={handleClick}
      title={title}
      disabled={disabled}
    >
      {armed ? confirmLabel : label}
    </button>
  )
}
