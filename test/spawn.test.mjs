import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { embed, ensureService, serviceStatus, stopService } from '../dist/index.js'
import { servicePaths } from '../dist/paths.js'

// A call that forgets its fixture paths falls back to the default home; point
// that at a throwaway folder so no test can reach the live service.
const root = mkdtempSync(join(tmpdir(), 'pce-spawn-'))
process.env.PURECONTEXT_EMBED_HOME = join(root, 'default-home')

let homes = 0
const started = []
const freshPaths = () => {
  const paths = servicePaths(join(root, `h${++homes}`))
  started.push(paths)
  return paths
}
after(async () => {
  for (const paths of started) await stopService(paths).catch(() => {})
  rmSync(root, { recursive: true, force: true })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const realModel = process.env.PURECONTEXT_EMBED_TEST_MODEL ?? join(homedir(), '.cairn', 'models', 'bge-large-en-v1.5')
const hasModel = existsSync(join(realModel, 'model.onnx'))

test('ensureService starts a detached service that outlives the call', async () => {
  const paths = freshPaths()
  assert.equal(await serviceStatus(paths), null)
  await ensureService(paths)
  const status = await serviceStatus(paths)
  assert.equal(status.version, version)
  assert.notEqual(status.pid, process.pid)
  assert.ok(alive(status.pid))
  await ensureService(paths)
  assert.equal((await serviceStatus(paths)).pid, status.pid, 'a second ensure started another service')
  assert.equal(await stopService(paths), true)
  for (let i = 0; i < 50 && alive(status.pid); i++) await sleep(100)
  assert.equal(alive(status.pid), false)
  assert.equal(existsSync(paths.lock), false)
})

// A copy of this package that says it is 0.0.1, served from a path the lock
// still recognises as the embed service. `listenDelayMs` holds it between
// taking the lock and listening, as a slow start would.
function startOldService(home, { listenDelayMs = 0 } = {}) {
  const old = join(root, `old-${listenDelayMs}`, 'embed')
  if (!existsSync(old)) {
    mkdirSync(old, { recursive: true })
    cpSync(fileURLToPath(new URL('../dist', import.meta.url)), join(old, 'dist'), { recursive: true })
    writeFileSync(
      join(old, 'package.json'),
      JSON.stringify({ name: '@purecontext/embed', version: '0.0.1', type: 'module' }),
    )
    const serveJs = join(old, 'dist', 'serve.js')
    const source = readFileSync(serveJs, 'utf8')
    const marker = 'const version = packageVersion();'
    assert.ok(source.includes(marker), 'the delay marker is gone from serve.js')
    writeFileSync(
      serveJs,
      source.replace(marker, `await new Promise((r) => setTimeout(r, ${listenDelayMs})); ${marker}`),
    )
  }
  const child = spawn(process.execPath, [join(old, 'dist', 'cli.js'), 'serve', '--home', home], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

test('a client replaces an older service with its own version', async () => {
  const paths = freshPaths()
  startOldService(paths.home)
  let status = null
  for (let i = 0; i < 100 && !status; i++) {
    status = await serviceStatus(paths)
    if (!status) await sleep(100)
  }
  assert.equal(status?.version, '0.0.1')

  await ensureService(paths)
  const now = await serviceStatus(paths)
  assert.equal(now.version, version)
  assert.notEqual(now.pid, status.pid)
  assert.equal(alive(status.pid), false, 'the old service is still running')
})

test('a client whose own start loses the lock to an older service still ends on its version', async () => {
  // The older service holds the lock but is not listening yet, so this
  // client's spawn backs out and the first service to answer is the old one.
  const paths = freshPaths()
  startOldService(paths.home, { listenDelayMs: 1500 })
  for (let i = 0; i < 50 && !existsSync(paths.lock); i++) await sleep(50)
  assert.ok(existsSync(paths.lock), 'the old service never took the lock')
  assert.equal(await serviceStatus(paths), null, 'the old service listened before the race began')

  await ensureService(paths)
  assert.equal((await serviceStatus(paths)).version, version)
})

test('a spawned service exits when idle, and the next call starts a new one', async () => {
  const paths = freshPaths()
  process.env.PURECONTEXT_EMBED_IDLE_MS = '300'
  try {
    await ensureService(paths)
    const first = await serviceStatus(paths)
    assert.equal(first.idleExitMs, 300)
    for (let i = 0; i < 50 && alive(first.pid); i++) await sleep(100)
    assert.equal(alive(first.pid), false, 'the service did not exit when idle')
    assert.equal(existsSync(paths.socket), false)
    await ensureService(paths)
    assert.notEqual((await serviceStatus(paths)).pid, first.pid)
  } finally {
    // biome-ignore lint/performance/noDelete: an env var set to undefined becomes the string "undefined"
    delete process.env.PURECONTEXT_EMBED_IDLE_MS
  }
})

test(
  'the real model gives 1024 unit vectors that rank related text closer',
  { skip: !hasModel && `no model at ${realModel}` },
  async () => {
    const paths = freshPaths()
    const texts = [
      'The backup service snapshots every database once a day.',
      'Each SQLite database gets a daily snapshot from the backup service.',
      'She planted tomatoes along the south fence in April.',
    ]
    const [a, b, c] = await embed(realModel, texts, { paths, priority: 'batch' })
    const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0)
    for (const v of [a, b, c]) {
      assert.equal(v.length, 1024)
      assert.ok(Math.abs(Math.sqrt(dot(v, v)) - 1) < 1e-4, 'vector is not unit length')
    }
    assert.ok(dot(a, b) > dot(a, c) + 0.1, `related ${dot(a, b)} vs unrelated ${dot(a, c)}`)
    const status = await serviceStatus(paths)
    assert.equal(status.models[0].dims, 1024)
    assert.equal(status.models[0].count, 3)
  },
)

test(
  'embed starts a new service when the last one exited between calls',
  { skip: !hasModel && `no model at ${realModel}` },
  async () => {
    const paths = freshPaths()
    const [first] = await embed(realModel, ['the same text'], { paths })
    const { pid } = await serviceStatus(paths)
    assert.equal(await stopService(paths), true)
    const [second] = await embed(realModel, ['the same text'], { paths })
    assert.notEqual((await serviceStatus(paths)).pid, pid)
    assert.deepEqual([...second], [...first])
  },
)
