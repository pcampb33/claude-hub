// Session Desktop wire protocol between the main process (desktop-core.ts) and
// the detached pty host (desktop-host.ts): newline-delimited JSON over a named
// pipe. Electron-free and dependency-free; both ends import it.
//
// A client's first message must be `hello` with the token from the host's
// info file (desktop-core.ts hostInfoPath), or the host drops the socket.
// Every later client message carries a request id (`rid`) and gets exactly one
// `reply`. Events (`data`, `exit`, `prompting`) go to every authenticated
// client, unasked.

// What the host writes to its info file (--info) once it is listening.
export interface HostInfo {
  pid: number
  pipe: string
  token: string
}

export type ClientRequest =
  | { t: 'create'; id: string; cwd: string; args: string[]; cols: number; rows: number }
  | { t: 'input'; id: string; d: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill'; id: string }
  // Drop an exited session's screen (refused while it runs; no-op if unknown).
  | { t: 'forget'; id: string }
  | { t: 'screen'; id: string }
  | { t: 'list' }

export type ClientMessage = { t: 'hello'; token: string } | (ClientRequest & { rid: number })

// A live session as the host reports it in a `list` reply.
export interface HostSessionInfo {
  id: string
  pid: number // the pty's process: Claude Code's ~/.claude/sessions/<pid>.json
  prompting: boolean
  line: string | null
  seq: number
}

// Serialized terminal state. `seq` is the last chunk the serialization
// includes, so a client drops chunks <= seq and applies the rest.
export interface HostScreen {
  seq: number
  data: string
  cols: number
  rows: number
}

export type HostReply =
  // pid: on a create reply, the new pty's process id.
  | { t: 'reply'; rid: number; ok: true; screen?: HostScreen; sessions?: HostSessionInfo[]; pid?: number }
  | { t: 'reply'; rid: number; ok: false; error: string }

export type HostEvent =
  | { t: 'welcome'; pid: number }
  // seq rises by one per chunk per session.
  | { t: 'data'; id: string; seq: number; d: string }
  // code null = the pty reported no exit code.
  | { t: 'exit'; id: string; code: number | null }
  // Emitted only on change. `line` = the question above the choice menu, if any.
  | { t: 'prompting'; id: string; prompting: boolean; line: string | null }

export type HostMessage = HostReply | HostEvent

export function encode(message: ClientMessage | HostMessage): string {
  return JSON.stringify(message) + '\n'
}

// A line longer than this without a newline is not a protocol message; refuse
// it rather than buffer without bound. Big enough for any paste.
export const MAX_LINE_CHARS = 16 * 1024 * 1024

// Splits a character stream into parsed messages. Chunks arrive cut anywhere,
// including mid-line, so the unterminated tail is kept for the next push.
// Feed it decoded strings (socket.setEncoding('utf8')) so a multi-byte
// character split across chunks is reassembled before it gets here.
// Throws on a malformed line or an oversized one: the caller drops the peer.
export class LineDecoder {
  private buffer = ''

  push(chunk: string): unknown[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    if (this.buffer.length > MAX_LINE_CHARS) throw new Error('protocol line too long')
    const messages: unknown[] = []
    for (const line of lines) {
      if (line.trim().length === 0) continue
      messages.push(JSON.parse(line))
    }
    return messages
  }
}
