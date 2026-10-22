import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// macOS caps a unix socket path at 104 bytes.
const MAX_SOCKET_PATH = 103

export interface ServicePaths {
  home: string
  socket: string
  lock: string
  log: string
}

export function servicePaths(
  home = process.env.PURECONTEXT_EMBED_HOME ?? join(homedir(), '.config', 'purecontext', 'embed'),
): ServicePaths {
  const socket = join(home, 'serve.sock')
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    throw new Error(`[embed] service socket path is too long for a unix socket: ${socket}`)
  }
  return { home, socket, lock: join(home, 'serve.lock'), log: join(home, 'serve.log') }
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return pkg.version
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
