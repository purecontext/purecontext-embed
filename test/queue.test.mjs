import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PriorityQueue } from '../dist/queue.js'

const tick = () => new Promise((r) => setTimeout(r, 5))

test('an interactive task runs ahead of waiting batch tasks, after the one already running', async () => {
  const queue = new PriorityQueue()
  const order = []
  const task = (name) => async () => {
    order.push(name)
    await tick()
    return name
  }
  const batch = ['b1', 'b2', 'b3', 'b4'].map((n) => queue.push('batch', task(n)))
  await new Promise((r) => setImmediate(r))
  const interactive = queue.push('interactive', task('i1'))
  assert.deepEqual(await Promise.all([...batch, interactive]), ['b1', 'b2', 'b3', 'b4', 'i1'])
  assert.deepEqual(order, ['b1', 'i1', 'b2', 'b3', 'b4'])
  assert.equal(queue.busy, false)
})

test('one task at a time, and a failure does not stop the queue', async () => {
  const queue = new PriorityQueue()
  let running = 0
  let most = 0
  const work = (fail) => async () => {
    running++
    most = Math.max(most, running)
    await tick()
    running--
    if (fail) throw new Error('boom')
    return 'ok'
  }
  const results = await Promise.allSettled([
    queue.push('batch', work(false)),
    queue.push('interactive', work(true)),
    queue.push('batch', work(false)),
  ])
  assert.equal(most, 1)
  assert.deepEqual(
    results.map((r) => r.status),
    ['fulfilled', 'rejected', 'fulfilled'],
  )
  assert.deepEqual(queue.depths(), { interactive: 0, batch: 0 })
})
