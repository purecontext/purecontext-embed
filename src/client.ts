import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type ServicePaths, compareVersions, packageVersion, servicePaths } from './paths.js'
import type { Priority } from './queue.js'
import { type RpcResponse, isServing, rpc } from './rpc.js'
import type { ServiceStatus } from './serve.js'

// Texts per request. Priority is decided per text inside the service, so this
// only bounds each request's size and how long its socket sits silent.
const REQUEST_TEXTS = 32
const EMBED_TIMEOUT_MS = 10 * 60_000

export class EmbedServiceError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'EmbedServiceError'
  }
}

export interface EmbedOptions {
  priority?: Priority
  paths?: ServicePaths
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return false
}

function spawnService(paths: ServicePaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  try {
    if (statSync(paths.log).size > 1_000_000) renameSync(paths.log, `${paths.log}.1`)
  } catch {}
  const out = openSync(paths.log, 'a', 0o600)
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
  const child = spawn(process.execPath, [cli, 'serve', '--home', paths.home], {
    detached: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
  closeSync(out)
}

export async function serviceStatus(paths: ServicePaths = servicePaths()): Promise<ServiceStatus | null> {
  try {
    const res = await rpc(paths.socket, 'GET', '/status', undefined, 5_000)
    return res.status === 200 ? res.body : null
  } catch {
    return null
  }
}

// Starts the service when it is absent, detached so it outlives this process.
// A running service older than this package is stopped and replaced. An older
// client can respawn its own version during the handover and win the lock, so
// the version is checked again after the start; two newer clients converge, so
// one more round is enough.
export async function ensureService(paths: ServicePaths = servicePaths()): Promise<void> {
  for (let round = 0; round < 2; round++) {
    const running = await serviceStatus(paths)
    if (running) {
      if (compareVersions(running.version, packageVersion()) >= 0) return
      console.error(`[embed] replacing service ${running.version} with ${packageVersion()}`)
      await rpc(paths.socket, 'POST', '/stop', {}, 30_000).catch(() => {})
      await waitFor(async () => !(await isServing(paths.socket)), 30_000)
    }
    spawnService(paths)
    if (!(await waitFor(() => isServing(paths.socket), 15_000))) {
      throw new EmbedServiceError(`the embed service did not start; see ${paths.log}`, true)
    }
  }
  const running = await serviceStatus(paths)
  if (!running || compareVersions(running.version, packageVersion()) < 0) {
    throw new EmbedServiceError(
      `an older embed service (${running?.version ?? 'unknown'}) keeps replacing ${packageVersion()}; see ${paths.log}`,
      true,
    )
  }
}

export async function stopService(paths: ServicePaths = servicePaths()): Promise<boolean> {
  if (!(await isServing(paths.socket))) return false
  await rpc(paths.socket, 'POST', '/stop', {}, 30_000)
  return waitFor(async () => !(await isServing(paths.socket)), 30_000)
}

// The version check runs once per process and socket; after that a call goes
// straight to the socket and only a failed connection costs a status round trip.
const ready = new Map<string, Promise<void>>()

function ensureOnce(paths: ServicePaths): Promise<void> {
  let p = ready.get(paths.socket)
  if (!p) {
    p = ensureService(paths)
    ready.set(paths.socket, p)
    p.catch(() => ready.delete(paths.socket))
  }
  return p
}

const CONNECTION_ERRORS = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'])

function isConnectionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return (code !== undefined && CONNECTION_ERRORS.has(code)) || /socket hang up/.test(String(err))
}

function decode(base64: string): Float32Array {
  const buf = Buffer.from(base64, 'base64')
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

async function embedRequest(paths: ServicePaths, body: object): Promise<RpcResponse> {
  await ensureOnce(paths)
  try {
    const res = await rpc(paths.socket, 'POST', '/embed', body, EMBED_TIMEOUT_MS)
    if (res.status !== 503) return res
    // The service is stopping: an idle exit or a newer client's handover.
    await waitFor(async () => !(await isServing(paths.socket)), 30_000)
  } catch (err) {
    if (!isConnectionError(err)) throw new EmbedServiceError(`embed request failed: ${String(err)}`, true)
  }
  // The service exited between calls; start one and try once more.
  ready.delete(paths.socket)
  await ensureOnce(paths)
  try {
    return await rpc(paths.socket, 'POST', '/embed', body, EMBED_TIMEOUT_MS)
  } catch (err) {
    throw new EmbedServiceError(`embed request failed: ${String(err)}`, true)
  }
}

// One vector per text, in order. `modelDir` is a directory holding model.onnx
// and tokenizer.json; every client naming the same directory shares one load.
export async function embed(modelDir: string, texts: string[], opts: EmbedOptions = {}): Promise<Float32Array[]> {
  const paths = opts.paths ?? servicePaths()
  const priority = opts.priority ?? 'interactive'
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += REQUEST_TEXTS) {
    const slice = texts.slice(i, i + REQUEST_TEXTS)
    const res = await embedRequest(paths, { model: modelDir, texts: slice, priority })
    if (res.status !== 200) {
      const message = res.body?.error ?? `HTTP ${res.status}`
      throw new EmbedServiceError(`[embed] ${message}`, res.status >= 500)
    }
    const vectors: string[] = res.body.vectors
    if (vectors.length !== slice.length) {
      throw new EmbedServiceError(`[embed] asked for ${slice.length} vectors, got ${vectors.length}`, false)
    }
    for (const v of vectors) out.push(decode(v))
  }
  return out
}
