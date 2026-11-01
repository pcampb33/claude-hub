import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { RegistryEntry } from '../shared/ipc-types'

function registryPath(): string {
  return path.join(process.env.APP_ROOT!, 'registry.json')
}
const SANDBOX_PATH = 'C:\\projects\\claude-hub-sandbox'

function ensureSandbox(): void {
  if (!fs.existsSync(SANDBOX_PATH)) {
    fs.mkdirSync(SANDBOX_PATH, { recursive: true })
  }
  if (!fs.existsSync(path.join(SANDBOX_PATH, '.git'))) {
    execFileSync('git', ['init'], { cwd: SANDBOX_PATH, windowsHide: true })
  }
}

function seedRegistry(): RegistryEntry[] {
  ensureSandbox()
  const now = new Date().toISOString()
  return [
    { id: randomUUID(), name: 'sandbox', path: SANDBOX_PATH, pinned: true, addedAt: now },
  ]
}

function readRegistry(): RegistryEntry[] {
  if (!fs.existsSync(registryPath())) {
    const seeded = seedRegistry()
    writeRegistry(seeded)
    return seeded
  }
  return JSON.parse(fs.readFileSync(registryPath(), 'utf-8'))
}

function writeRegistry(entries: RegistryEntry[]): void {
  fs.writeFileSync(registryPath(), JSON.stringify(entries, null, 2) + '\n')
}

export function listProjects(): RegistryEntry[] {
  return readRegistry()
}

export function addProject(projectPath: string): RegistryEntry {
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new Error(`Not a directory: ${projectPath}`)
  }
  const entries = readRegistry()
  const normalized = path.resolve(projectPath).toLowerCase()
  const duplicate = entries.find((e) => path.resolve(e.path).toLowerCase() === normalized)
  if (duplicate) {
    throw new Error(`Already registered as "${duplicate.name}"`)
  }
  const entry: RegistryEntry = {
    id: randomUUID(),
    name: path.basename(projectPath),
    path: projectPath,
    addedAt: new Date().toISOString(),
  }
  entries.push(entry)
  writeRegistry(entries)
  return entry
}

export function removeProject(id: string): void {
  const entries = readRegistry().filter((e) => e.id !== id)
  writeRegistry(entries)
}

// verifyCommand executes on this machine whenever Run verify is clicked. It
// was hand-edit-only by design until the floor card grew an inline setter
// (2026-07-17, a user-approved posture change — the renderer already holds
// equivalent spawn powers via the launch actions). Blank clears the
// key entirely (absent, matching the seed shape), disabling the CTA again.
export function setVerifyCommand(id: string, command: string): RegistryEntry {
  const entries = readRegistry()
  const entry = entries.find((e) => e.id === id)
  if (!entry) {
    throw new Error(`No project with id: ${id}`)
  }
  const trimmed = command.trim()
  if (trimmed) entry.verifyCommand = trimmed
  else delete entry.verifyCommand
  writeRegistry(entries)
  return entry
}

export function setPinned(id: string, pinned: boolean): RegistryEntry {
  const entries = readRegistry()
  const entry = entries.find((e) => e.id === id)
  if (!entry) {
    throw new Error(`No project with id: ${id}`)
  }
  // Keep the field absent (not `false`) when unpinning — matches the seed
  // shape, where only pinned entries carry the key at all.
  if (pinned) entry.pinned = true
  else delete entry.pinned
  writeRegistry(entries)
  return entry
}
