import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { embed } from '../dist/index.js'
import { servicePaths } from '../dist/paths.js'
import { rpc } from '../dist/rpc.js'
import { serve } from '../dist/serve.js'

// A call that forgets its fixture paths falls back to the default home; point
// that at a throwaway folder so no test can reach the live service.
const root = mkdtempSync(join(tmpdir(), 'pce-'))
process.env.PURECONTEXT_EMBED_HOME = join(root, 'default-home')
after(() => rmSync(root, { recursive: true, force: true }))

let homes = 0
const freshPaths = () => servicePaths(join(root, `h${++homes}`))

const modelDir = join(root, 'model')
mkdirSync(modelDir)
symlinkSync(modelDir, join(root, 'model-link'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A fake model: the vector is [length, first char code, call number], and
// each embedding takes `delayMs`, so tests can see order and priority.
function fakeLoader({ delayMs = 0, log = [], loads = [] } = {}) {
  return async (dir) => {
    loads.push(dir)
    let calls = 0
    return {
      async embed(text) {
        log.push(text)
        await sleep(delayMs)
        return Float32Array.from([text.length, text.charCodeAt(0) || 0, ++calls])
      },
    }
  }
}

test('vectors come back exact and in order, and one load serves every path to the same directory', async () => {
  const paths = freshPaths()
  const loads = []
  const service = await serve(paths, { loadModel: fakeLoader({ loads }) })
  try {
    const a = await embed(modelDir, ['hello', 'a longer text'], { paths })
    assert.deepEqual(
      a.map((v) => [...v]),
      [
        [5, 104, 1],
        [13, 97, 2],
      ],
    )
    const b = await embed(join(root, 'model-link'), ['x'], { paths })
    assert.deepEqual([...b[0]], [1, 120, 3])
    assert.equal(loads.length, 1)
    const status = (await rpc(paths.socket, 'GET', '/status')).body
    assert.equal(status.models.length, 1)
    assert.equal(status.models[0].count, 3)
    assert.equal(status.models[0].dims, 3)
    assert.equal(status.models[0].state, 'ready')
  } finally {
    await service.stop('test over')
  }
})

test('a batch of more texts than one request holds comes back whole and in order', async () => {
  const paths = freshPaths()
  const service = await serve(paths, { loadModel: fakeLoader() })
  try {
    const texts = Array.from({ length: 70 }, (_, i) => 'y'.repeat(i + 1))
    const vectors = await embed(modelDir, texts, { paths, priority: 'batch' })
    assert.deepEqual(
      vectors.map((v) => v[0]),
      texts.map((t) => t.length),
    )
  } finally {
    await service.stop('test over')
  }
})

test('an interactive request overtakes a batch request already queued', async () => {
  const paths = freshPaths()
  const log = []
  const service = await serve(paths, { loadModel: fakeLoader({ delayMs: 20, log }) })
  try {
    const batch = embed(modelDir, ['b1', 'b2', 'b3', 'b4', 'b5'], { paths, priority: 'batch' })
    while (log.length === 0) await sleep(5)
    await embed(modelDir, ['i1'], { paths, priority: 'interactive' })
    assert.ok(log.indexOf('i1') <= 2, `interactive ran at position ${log.indexOf('i1')}: ${log.join(' ')}`)
    await batch
    assert.equal(log.length, 6)
  } finally {
    await service.stop('test over')
  }
})

test('bad requests are refused with 400 and leave the service up', async () => {
  const paths = freshPaths()
  const service = await serve(paths, { loadModel: fakeLoader() })
  try {
    for (const body of [
      { model: 'relative/dir', texts: ['a'] },
      { model: join(root, 'missing'), texts: ['a'] },
      { model: modelDir, texts: [1] },
      { model: modelDir, texts: ['a'], priority: 'urgent' },
    ]) {
      const res = await rpc(paths.socket, 'POST', '/embed', body)
      assert.equal(res.status, 400, JSON.stringify(body))
    }
    assert.equal((await rpc(paths.socket, 'GET', '/status')).status, 200)
  } finally {
    await service.stop('test over')
  }
})

test('a model that fails to load is refused with 422, not retryable, and the next request loads again', async () => {
  const paths = freshPaths()
  let attempt = 0
  const flaky = async (dir) => {
    if (++attempt === 1) throw new Error('no model.onnx')
    return fakeLoader()(dir)
  }
  const service = await serve(paths, { loadModel: flaky })
  try {
    await assert.rejects(
      embed(modelDir, ['a'], { paths }),
      (err) => err.retryable === false && /no model\.onnx/.test(err.message),
    )
    const [v] = await embed(modelDir, ['a'], { paths })
    assert.equal(v[0], 1)
  } finally {
    await service.stop('test over')
  }
})

test('stopping mid-batch answers the waiting request with 503 and removes the socket and lock', async () => {
  const paths = freshPaths()
  const log = []
  const service = await serve(paths, { loadModel: fakeLoader({ delayMs: 30, log }) })
  const pending = rpc(
    paths.socket,
    'POST',
    '/embed',
    { model: modelDir, texts: ['1', '2', '3', '4', '5', '6'] },
    30_000,
  )
  while (log.length === 0) await sleep(5)
  await service.stop('test')
  const res = await pending
  assert.equal(res.status, 503)
  assert.ok(log.length < 6, `every text ran: ${log.join(' ')}`)
  assert.equal(existsSync(paths.socket), false)
  assert.equal(existsSync(paths.lock), false)
})

test('the service exits by itself after the idle time, and not while a request runs', async () => {
  const paths = freshPaths()
  const service = await serve(paths, { loadModel: fakeLoader({ delayMs: 300 }), idleExitMs: 150 })
  // Straight to the socket, so a premature exit shows as a 503 rather than a
  // client retry against a newly spawned service.
  const res = await rpc(paths.socket, 'POST', '/embed', { model: modelDir, texts: ['slow', 'slower'] }, 10_000)
  assert.equal(res.status, 200, 'the service stopped while a request was running')
  await Promise.race([service.done, sleep(3000).then(() => assert.fail('did not exit when idle'))])
  assert.equal(existsSync(paths.socket), false)
})

test('a second service on the same home steps aside', async () => {
  const paths = freshPaths()
  const first = await serve(paths, { loadModel: fakeLoader() })
  try {
    const second = await serve(paths, { loadModel: fakeLoader() })
    await second.done
    assert.equal((await rpc(paths.socket, 'GET', '/status')).body.pid, process.pid)
    const [v] = await embed(modelDir, ['still here'], { paths })
    assert.equal(v[0], 10)
  } finally {
    await first.stop('test over')
  }
})
