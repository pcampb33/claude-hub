import { Component, type ErrorInfo, type ReactNode } from 'react'

// Root render-error boundary. Before this, a throw inside any view's render
// unmounted the whole React tree to a blank white page with no way back but a
// restart (main.tsx rendered <App /> bare). Now a render throw is contained to
// a recoverable panel with the message and a reload. Boundaries only catch
// render/lifecycle throws — async fetch rejections are handled in the hooks.
interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[claude-hub] uncaught render error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-title">Something broke in the UI</div>
        <div className="error-boundary-message">{this.state.error.message}</div>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
