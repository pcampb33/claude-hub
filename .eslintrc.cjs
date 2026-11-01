module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
  overrides: [
    {
      // Domain modules under electron/ must stay Electron-free — several
      // are imported directly by CLI scripts via plain `node` (see
      // CLAUDE.md), and 'electron' has no real exports outside Electron's
      // own process. Only the files below are the actual Electron-coupled
      // boundary (main process entry, preload bridge, the centralized IPC
      // registration file, and the few modules whose IPC-facing behavior
      // genuinely needs an Electron API like shell/dialog).
      files: ['electron/**/*.ts'],
      excludedFiles: [
        'electron/main.ts',
        'electron/preload.ts',
        'electron/ipc-handlers.ts',
        'electron/launch.ts',
        'electron/live.ts',
        'electron/desktop.ts',
        'electron/vault.ts',
        'electron/dialog.ts',
        'electron/session-delete.ts',
        'electron/window-state.ts',
      ],
      rules: {
        'no-restricted-imports': ['error', { paths: [{ name: 'electron', message: "Domain modules under electron/ must stay Electron-free — see CLAUDE.md." }] }],
      },
    },
  ],
}
