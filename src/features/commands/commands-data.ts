export interface CommandEntry {
  name: string
  description: string
  category: string
}

// Static reference, not fetched live — Claude Code's own `/help` is the
// source of truth if this drifts. Curated to the commands worth having a
// quick lookup for, not an exhaustive dump of every alias.
export const COMMANDS: CommandEntry[] = [
  { category: 'Session', name: '/clear', description: 'Start a fresh conversation (previous stays in /resume)' },
  { category: 'Session', name: '/resume', description: 'Resume a past conversation by ID or name' },
  { category: 'Session', name: '/branch', description: 'Create a conversation branch to try a different direction' },
  { category: 'Session', name: '/fork', description: 'Spawn a background subagent on a task while you continue' },
  { category: 'Session', name: '/rename', description: 'Rename the current session' },

  { category: 'Configuration', name: '/config', description: 'Adjust theme, model, output style, and settings' },
  { category: 'Configuration', name: '/model', description: 'Switch AI model' },
  { category: 'Configuration', name: '/effort', description: 'Adjust reasoning effort (low/medium/high/xhigh/max)' },
  { category: 'Configuration', name: '/theme', description: 'Change color theme' },
  { category: 'Configuration', name: '/keybindings', description: 'Open the keyboard shortcuts file' },

  { category: 'Context & Memory', name: '/context', description: 'Visualize context usage as a colored grid' },
  { category: 'Context & Memory', name: '/compact', description: 'Summarize the conversation to free up context' },
  { category: 'Context & Memory', name: '/memory', description: 'Edit CLAUDE.md, enable/disable auto-memory' },
  { category: 'Context & Memory', name: '/init', description: 'Initialize a project with a CLAUDE.md guide' },

  { category: 'Code Review', name: '/diff', description: 'Interactive diff viewer for changes' },
  { category: 'Code Review', name: '/code-review', description: 'Review the diff for bugs and cleanups' },
  { category: 'Code Review', name: '/simplify', description: 'Review code for cleanup opportunities and apply fixes' },
  { category: 'Code Review', name: '/security-review', description: 'Analyze pending changes for security vulnerabilities' },

  { category: 'Agents & Parallel Work', name: '/agents', description: 'Manage subagent configurations' },
  { category: 'Agents & Parallel Work', name: '/background', description: 'Detach the session to run as a background agent' },
  { category: 'Agents & Parallel Work', name: '/tasks', description: 'View and manage background work' },

  { category: 'MCP & Tools', name: '/mcp', description: 'Manage MCP server connections' },
  { category: 'MCP & Tools', name: '/skills', description: 'List available skills; toggle visibility' },
  { category: 'MCP & Tools', name: '/permissions', description: 'Manage allow/ask/deny rules for tools' },
  { category: 'MCP & Tools', name: '/hooks', description: 'View hook configurations' },

  { category: 'Workflows', name: '/plan', description: 'Enter plan mode before large changes' },
  { category: 'Workflows', name: '/loop', description: 'Run a prompt repeatedly on an interval' },
  { category: 'Workflows', name: '/schedule', description: 'Create or manage routines on cloud infrastructure' },

  { category: 'Diagnostics', name: '/doctor', description: 'Diagnose the Claude Code installation and settings' },
  { category: 'Diagnostics', name: '/usage', description: 'Show session cost and activity stats' },
  { category: 'Diagnostics', name: '/status', description: 'Show version, model, account, connectivity' },

  { category: 'Navigation', name: '/cd', description: 'Move the session to a new working directory' },
  { category: 'Navigation', name: '/add-dir', description: 'Add an extra directory for file access' },
]
