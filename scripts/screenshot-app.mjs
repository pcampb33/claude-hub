#!/usr/bin/env node
// Real-Electron screenshot harness. Launches the ACTUAL built desktop app
// (real preload → real window.hubApi → real ipcMain handlers → real
// registry.json / session / vault data) and screenshots each view. This is
// verification against real data, NOT a browser mock — nothing here stubs
// IPC or fixtures the DOM.
//
// USAGE:
//   npx vite build                         # produces dist/ (renderer) AND
//                                          # dist-electron/main.js + preload
//                                          # via vite-plugin-electron.
//   node scripts/screenshot-app.mjs [outDir]
//
//   [outDir] defaults to <os-temp>/claude-hub-shots. It is created if absent.
//   SHOT_THEMES=nord,catppuccin,clay shoots every view once per theme, as
//   real-<view>-<theme>.png; unset, it shoots the app's saved theme only.
//   Only `vite build` is required (`npm run build` also typechecks first).
//
// HOW IT WORKS:
//   electron/main.ts loads the built renderer via loadFile(dist/index.html)
//   whenever VITE_DEV_SERVER_URL is unset — which it is here — so the window
//   is the production renderer wired to the real main process. Playwright's
//   _electron.launch() drives the installed Electron binary directly (it does
//   NOT need Playwright's bundled browsers, which is why @playwright/test was
//   installed with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).
//
//   Routing is hash-based; we set window.location.hash in-page and wait for
//   the view container to re-render before shooting.
//
//   NOTE: under Playwright's _electron.launch the window's initial loadFile
//   occasionally races to chrome-error://chromewebdata/. The harness detects
//   this and re-navigates the same window to the built index.html (the preload
//   is per-webContents, so hubApi/IPC stay real). Harmless no-op when the first
//   load succeeds.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(__dirname, '..')
const mainEntry = path.join(repoRoot, 'dist-electron', 'main.js')
const rendererIndex = path.join(repoRoot, 'dist', 'index.html')

// View keys must match the VIEWS table in src/nav.ts (it moved out of
// App.tsx). "#/" alone does not parse (useHashRoute requires a segment after
// "#/"), so dashboard is addressed explicitly as "#/dashboard".
//
// A key that no longer exists does NOT fail loudly here: useHashRoute falls
// back to dashboard, so the harness would happily write a picture of the
// Dashboard into real-<stale-key>.png and call it evidence. Keep this array
// in step with nav.ts, and see the assertion in main() that catches drift.
const VIEWS = ['dashboard', 'inbox', 'desktop', 'sessions', 'projects', 'config', 'usage', 'skills', 'knowledge', 'extensions', 'sandbox', 'commands', 'workflows', 'search', 'rubric', 'global']
const THEMES = process.env.SHOT_THEMES ? process.env.SHOT_THEMES.split(',') : [null]

// Real data arrives over IPC (not the network), so networkidle is not a
// meaningful signal here — settle a fixed moment after the view container
// mounts to let hubApi promises resolve and render.
const SETTLE_MS = 1500

async function main() {
  const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'claude-hub-shots'))
  fs.mkdirSync(outDir, { recursive: true })

  if (!fs.existsSync(mainEntry)) {
    console.error(`[screenshot-app] Build output missing: ${mainEntry}`)
    console.error('[screenshot-app] Run `npx vite build` first.')
    process.exit(1)
  }

  console.log(`[screenshot-app] Launching real Electron app from ${mainEntry}`)
  // Hidden mode (electron/main.ts): the window renders offscreen at a fixed
  // 1500x950, so no OS window ever appears or takes focus from the user.
  // Shots come from capturePage; Playwright's page.screenshot hangs on it.
  // Passive desktop (electron/desktop-core.ts): this instance shares APP_ROOT,
  // so it attaches to the user's real session host; passive, it only shows,
  // and its 1500x950 tiles never resize (garble) the user's live sessions.
  const app = await electron.launch({
    args: [mainEntry],
    cwd: repoRoot,
    env: { ...process.env, CLAUDE_HUB_HIDDEN_WINDOW: '1', CLAUDE_HUB_DESKTOP_PASSIVE: '1' },
  })
  const capture = async (outPath) => {
    const b64 = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'),
    )
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'))
  }

  // Theme shots write the saved theme, and this instance shares the user's
  // Electron storage: put their choice back before closing.
  let win, savedTheme
  try {
    win = await app.firstWindow()

    // Startup race: under Playwright's _electron.launch the window's initial
    // loadFile() intermittently lands on chrome-error://chromewebdata/ instead
    // of the built renderer. The preload is bound to the webContents (not the
    // document), so navigating the same window to the built index.html via
    // file:// recovers a fully real page — window.hubApi and IPC stay live.
    // If the first load succeeded, url() is a file:// URL and we skip this.
    await win.waitForTimeout(1_000)
    if (win.url().startsWith('chrome-error')) {
      console.log('[screenshot-app] initial load raced to chrome-error; recovering via goto')
      await win.goto(pathToFileURL(rendererIndex).href)
    }

    // Wait for the app shell before touching routes.
    await win.waitForSelector('main.app-content', { timeout: 30_000 })
    savedTheme = await win.evaluate(() => localStorage.getItem('claude-hub:theme'))

    for (const theme of THEMES) {
    if (theme) {
      // Same effect as Settings → Theme (src/features/shared/theme.ts).
      await win.evaluate((t) => {
        document.documentElement.dataset.theme = t
        localStorage.setItem('claude-hub:theme', t)
      }, theme)
    }
    for (const view of VIEWS) {
      await win.evaluate((h) => {
        window.location.hash = h
      }, `#/${view}`)

      // The active view lives in a keyed `.view-transition` div that remounts
      // per route — waiting for it confirms the hashchange took effect.
      await win.waitForSelector('main.app-content .view-transition', { timeout: 15_000 })
      await win.waitForTimeout(SETTLE_MS)

      // ...but "a view mounted" is not "the view I asked for mounted". An
      // unknown key falls back to dashboard and rewrites the hash, so without
      // this the harness writes a Dashboard screenshot to real-<key>.png and
      // reports success — evidence that lies, which is worse than no evidence.
      const landed = await win.evaluate(() => window.location.hash)
      if (landed !== `#/${view}`) {
        throw new Error(
          `route drift: asked for #/${view}, landed on ${landed || '(none)'}. ` +
            'The VIEWS array here is out of step with the VIEWS table in src/nav.ts.',
        )
      }

      const outPath = path.join(outDir, theme ? `real-${view}-${theme}.png` : `real-${view}.png`)
      await capture(outPath)
      console.log(`[screenshot-app] wrote ${outPath}`)
    }
    }
  } finally {
    if (savedTheme !== undefined) {
      await win.evaluate((t) => {
        if (t === null) localStorage.removeItem('claude-hub:theme')
        else localStorage.setItem('claude-hub:theme', t)
      }, savedTheme)
    }
    await app.close()
  }

  console.log(`[screenshot-app] Done. ${VIEWS.length * THEMES.length} screenshots in ${outDir}`)
}

main().catch((err) => {
  console.error('[screenshot-app] FAILED:', err)
  process.exit(1)
})
