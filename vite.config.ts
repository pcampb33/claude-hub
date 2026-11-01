import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`. desktop-host is the Session Desktop's
        // detached pty host: built beside main.js, run by the main process
        // under ELECTRON_RUN_AS_NODE so it outlives the app.
        entry: { main: 'electron/main.ts', 'desktop-host': 'electron/desktop-host.ts' },
        // Native (node-pty) and its terminal-model companions load from
        // node_modules at runtime; bundling would break the .node binaries.
        vite: { build: { rollupOptions: { external: ['node-pty', '@xterm/headless', '@xterm/addon-serialize'] } } },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: process.env.NODE_ENV === 'test'
        // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
        ? undefined
        : {},
    }),
  ],
})
