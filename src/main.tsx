import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/rubik'
import '@fontsource-variable/lexend'
import '@fontsource-variable/nunito'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import App from './App.tsx'
import './index.css'
import { ErrorBoundary } from './features/shared/ErrorBoundary'
import { initTheme } from './features/shared/theme'
import { POP_OUT_ROUTE, PopOutTile } from './features/desktop/PopOut'

initTheme()

// A desktop session popped out to its own window renders alone, before (and
// instead of) the app shell.
const popOut = POP_OUT_ROUTE.exec(window.location.hash)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>{popOut ? <PopOutTile id={decodeURIComponent(popOut[1])} /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
)
