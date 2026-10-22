import { existsSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { isAbsolute } from 'node:path'
import { acquireLock, readLockPid } from './lock.js'
import { type Embedder, type ModelLoader, loadFastembed } from './model.js'
import { type ServicePaths, packageVersion, servicePaths } from './paths.js'
import { PRIORITIES, type Priority, PriorityQueue } from './queue.js'
import { isServing } from './rpc.js'

const DEFAULT_IDLE_EXIT_MS = 30 * 60_000
const SOCKET_CHECK_MS = 5_000
const MAX_BODY_BYTES = 64 * 1024 * 1024

export interface ModelStatus {
  dir: string
  state: 'loading' | 'ready' | 'failed'
  loadedAt: string | null
  lastUsedAt: string | null
  count: number
  dims: number | null
  error: string | null
}

export interface ServiceStatus {
  version: string
  pid: number
  startedAt: string
  home: string
  idleExitMs: number
  lastRequestAt: string | null
  queue: Record<Priority, number> & { running: boolean }
  models: ModelStatus[]
  memory: { rss: number; heapUsed: number }
}

export interface ServeOptions {
  loadModel?: ModelLoader
  idleExitMs?: number
}

export interface ServiceHandle {
  stop: (why: string) => Promise<void>
  done: Promise<void>
}

interface ModelEntry extends ModelStatus {
  ready: Promise<Embedder>
}

class Stopping extends Error {}

const log = (msg: string) => console.error(`${new Date().toISOString()} [embed] ${msg}`)
const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0]

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

interface EmbedRequest {
  dir: string
  texts: string[]
  priority: Priority
}

function validateEmbed(body: unknown): EmbedRequest {
  const { model, texts, priority = 'interactive' } = (body ?? {}) as Record<string, unknown>
  if (typeof model !== 'string' || !isAbsolute(model)) throw new Error('model must be an absolute directory path')
  if (!Array.isArray(texts) || !texts.every((t) => typeof t === 'string')) throw new Error('texts must be strings')
  if (!PRIORITIES.includes(priority as Priority)) throw new Error(`priority must be one of ${PRIORITIES.join(', ')}`)
  let dir: string
  try {
    dir = realpathSync(model)
  } catch {
    throw new Error(`model directory not found: ${model}`)
  }
  return { dir, texts, priority: priority as Priority }
}

const toBase64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')

// Resolves once the socket is listening, or at once when another service
// already serves it; `done` settles when this service has stopped.
export async function serve(paths: ServicePaths = servicePaths(), opts: ServeOptions = {}): Promise<ServiceHandle> {
  const loadModel = opts.loadModel ?? loadFastembed
  const idleExitMs = opts.idleExitMs ?? (Number(process.env.PURECONTEXT_EMBED_IDLE_MS) || DEFAULT_IDLE_EXIT_MS)
  const noop: ServiceHandle = { stop: async () => {}, done: Promise.resolve() }

  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  if (await isServing(paths.socket)) {
    log('service already running; exiting')
    return noop
  }
  if (!acquireLock(paths.lock)) {
    log('another service holds the lock; exiting')
    return noop
  }

  const version = packageVersion()
  const startedAt = new Date().toISOString()
  const queue = new PriorityQueue()
  const models = new Map<string, ModelEntry>()
  // Each open request's cancel, so a stop can turn its waiting texts into a
  // 503 the client retries against the next service.
  const open = new Set<(err: Error) => void>()
  let lastActivity = Date.now()
  let lastRequestAt: string | null = null
  let shuttingDown = false
  let idleTimer: NodeJS.Timeout | null = null
  let socketTimer: NodeJS.Timeout | null = null
  let finish: () => void = () => {}
  const done = new Promise<void>((r) => {
    finish = r
  })

  const modelFor = (dir: string): Promise<Embedder> => {
    let entry = models.get(dir)
    if (!entry || entry.state === 'failed') {
      const started = Date.now()
      const fresh: ModelEntry = {
        dir,
        state: 'loading',
        loadedAt: null,
        lastUsedAt: null,
        count: entry?.count ?? 0,
        dims: null,
        error: null,
        ready: loadModel(dir),
      }
      fresh.ready.then(
        () => {
          fresh.state = 'ready'
          fresh.loadedAt = new Date().toISOString()
          log(`loaded ${dir} in ${Date.now() - started} ms`)
        },
        (err) => {
          fresh.state = 'failed'
          fresh.error = firstLine(err)
          log(`cannot load ${dir}: ${firstLine(err)}`)
        },
      )
      models.set(dir, fresh)
      entry = fresh
    }
    return entry.ready
  }

  const embedOne = async (dir: string, text: string): Promise<Float32Array> => {
    const vector = await (await modelFor(dir)).embed(text)
    const entry = models.get(dir)
    if (entry) {
      entry.count++
      entry.lastUsedAt = new Date().toISOString()
      if (entry.dims === null) entry.dims = vector.length
      else if (entry.dims !== vector.length) {
        throw new Error(`the model returned ${vector.length} dimensions after returning ${entry.dims}`)
      }
    }
    return vector
  }

  const embed = async (req: EmbedRequest, res: ServerResponse) => {
    let cancelled: Error | null = null
    const cancel = (err: Error) => {
      cancelled ??= err
    }
    open.add(cancel)
    res.on('close', () => {
      if (!res.writableFinished) cancel(new Error('the client went away'))
    })
    try {
      const vectors = await Promise.all(
        req.texts.map((text) =>
          queue.push(req.priority, async () => {
            if (cancelled) throw cancelled
            return embedOne(req.dir, text)
          }),
        ),
      ).catch((err) => {
        cancel(err)
        throw err
      })
      send(res, 200, { dims: vectors[0]?.length ?? null, vectors: vectors.map(toBase64) })
    } catch (err) {
      if (err instanceof Stopping) send(res, 503, { error: err.message })
      else send(res, 500, { error: firstLine(err) })
    } finally {
      open.delete(cancel)
      lastActivity = Date.now()
    }
  }

  const status = (): ServiceStatus => {
    const mem = process.memoryUsage()
    return {
      version,
      pid: process.pid,
      startedAt,
      home: paths.home,
      idleExitMs,
      lastRequestAt,
      queue: { ...queue.depths(), running: queue.busy },
      models: [...models.values()].map(({ ready, ...m }) => m),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed },
    }
  }

  const stop = async (why: string) => {
    if (shuttingDown) return done
    shuttingDown = true
    log(`shutting down: ${why}`)
    if (idleTimer) clearInterval(idleTimer)
    if (socketTimer) clearInterval(socketTimer)
    for (const cancel of open) cancel(new Stopping('the embed service is stopping; retry'))
    // The text already running finishes; everything behind it was cancelled.
    while (queue.busy) await new Promise((r) => setTimeout(r, 20))
    await new Promise<void>((r) => {
      server.close(() => r())
      server.closeAllConnections()
    })
    try {
      unlinkSync(paths.socket)
    } catch {}
    if (readLockPid(paths.lock) === process.pid) {
      try {
        unlinkSync(paths.lock)
      } catch {}
    }
    finish()
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://service')
      if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, status())
      if (req.method === 'POST' && url.pathname === '/embed') {
        lastActivity = Date.now()
        lastRequestAt = new Date().toISOString()
        if (shuttingDown) return send(res, 503, { error: 'the embed service is stopping; retry' })
        return await embed(validateEmbed(await readBody(req)), res)
      }
      if (req.method === 'POST' && url.pathname === '/stop') {
        send(res, 200, { status: 'stopping' })
        void stop('stop requested')
        return
      }
      send(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
    } catch (err) {
      send(res, 400, { error: firstLine(err) })
    }
  })

  // Several racers can each believe they took the lock; the file's contents
  // name the one winner, and everyone else backs out before the socket.
  if (readLockPid(paths.lock) !== process.pid) {
    log('lost the lock to another service; exiting')
    return noop
  }
  try {
    unlinkSync(paths.socket)
  } catch {}
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(paths.socket, () => {
      server.off('error', reject)
      resolve()
    })
  })
  if (readLockPid(paths.lock) !== process.pid) {
    log('lost the lock to another service; exiting')
    server.close()
    return noop
  }
  log(`embed service ${version} listening on ${paths.socket} (pid ${process.pid}, idle exit ${idleExitMs} ms)`)

  idleTimer = setInterval(
    () => {
      if (open.size === 0 && !queue.busy && Date.now() - lastActivity >= idleExitMs) {
        void stop(`no requests for ${idleExitMs} ms`)
      }
    },
    Math.min(idleExitMs, 60_000),
  )

  // A racer that lost the lock late may have unlinked this socket; listen again.
  socketTimer = setInterval(() => {
    if (shuttingDown || existsSync(paths.socket) || readLockPid(paths.lock) !== process.pid) return
    log('socket file is gone; listening again')
    server.closeAllConnections()
    server.close(() => {
      const failed = (err: Error) => log(`re-listen failed: ${err.message}`)
      server.once('error', failed)
      server.listen(paths.socket, () => server.off('error', failed))
    })
  }, SOCKET_CHECK_MS)

  return { stop, done }
}
