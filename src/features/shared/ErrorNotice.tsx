// Inline "this view failed to load" strip. Rendered above a view's content
// when its fetch hook reports an error, so a rejected IPC surfaces a reason +
// a retry instead of a silently empty pane. Pairs with the try/catch/finally
// in the fetch hooks (see useFloorStatus): the finally clears loading, this
// shows why the result is missing.
export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-notice" role="alert">
      <span className="error-notice-message">{message}</span>
      {onRetry && (
        <button className="btn btn-ghost error-notice-retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}
