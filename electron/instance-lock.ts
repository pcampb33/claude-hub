// One hub per APP_ROOT. Two would both own desktop-sessions.json and the
// session host, each reaping and re-syncing the other's sessions.
//
// A named pipe, not app.requestSingleInstanceLock(): Electron's lock is per
// userData folder, which every build on this machine shares, so it would also
// refuse a worktree build (its own APP_ROOT, its own records). And the OS drops
// a pipe when its process dies, so a crash never leaves a stale lock.
import { createHash } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'

export function instancePipe(appRoot: string): string {
  const tag = createHash('sha256').update(path.resolve(appRoot).toLowerCase()).digest('hex').slice(0, 12)
  return `\\\\.\\pipe\\claude-hub-instance-${tag}`
}

export type InstanceClaim =
  | { kind: 'first'; server: net.Server } // this process holds the lock
  | { kind: 'second' } // a running hub holds it, and was asked to come forward
  | { kind: 'unknown'; error: string } // couldn't tell: start anyway rather than lock the user out

function listen(pipe: string, onSecond: () => void): Promise<net.Server | NodeJS.ErrnoException> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.end()
      onSecond()
    })
    server.once('error', resolve)
    server.listen(pipe, () => resolve(server))
  })
}

// Connects to the holder (which brings its window forward); false when nothing answers.
function knock(pipe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(pipe, () => {
      socket.end()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

// A pipe that's taken but doesn't answer belongs to a hub that is exiting:
// `npm run dev` restarts by force-killing the old app and spawning the new one
// straight after. Wait for it to go rather than refuse the replacement.
export async function claimInstance(pipe: string, onSecond: () => void, retryMs = 250, attempts = 8): Promise<InstanceClaim> {
  let last = ''
  for (let i = 0; i < attempts; i++) {
    const result = await listen(pipe, onSecond)
    if (result instanceof net.Server) return { kind: 'first', server: result }
    if (result.code !== 'EADDRINUSE') return { kind: 'unknown', error: result.message }
    if (await knock(pipe)) return { kind: 'second' }
    last = result.message
    await new Promise((r) => setTimeout(r, retryMs))
  }
  return { kind: 'unknown', error: `the instance lock stayed taken by a hub that doesn't answer (${last})` }
}
