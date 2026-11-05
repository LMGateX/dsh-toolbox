import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, resolveConfig } from '../../../src/modules/goal-wait/config.ts'
import { createHarness } from './harness.ts'

test('gate schema exposes each original field as a volatile setting', () => {
  const shape = Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }
  for (const key of ['waitForJobs', 'waitForSubagents', 'maxHoldMs']) assert.equal(shape.dict[key].meta?.volatile, true)
  assert.deepEqual(resolveConfig(), { waitForJobs: true, waitForSubagents: true, maxHoldMs: 0 })
})

test('live gate policy releases its own hold without a driver replacement or remount', async () => {
  let waitForJobs = true
  const h = await createHarness({ rawConfig: { waitForJobs: { get: () => waitForJobs }, waitForSubagents: false } })
  try {
    const agent = h.agent('live-policy'); h.goal(agent); h.job(agent)
    await h.turnStopping(agent)
    assert.equal(h.goals.peek(agent)?.activation, 'disarmed')
    waitForJobs = false
    await h.turnStopping(agent)
    assert.equal(h.goals.peek(agent)?.activation, 'armed')
    assert.equal(h.goals.byKind('resume').length, 1)
    waitForJobs = true
    await h.turnStopping(agent)
    assert.equal(h.goals.peek(agent)?.activation, 'disarmed')
    assert.equal(h.goals.byKind('disarm').length, 2)
  } finally { await h.dispose() }
})

test('invalid live settings preserve the last accepted policy', async () => {
  let value: unknown = true
  const h = await createHarness({ rawConfig: { waitForJobs: { get: () => value as boolean }, waitForSubagents: false } })
  try {
    const agent = h.agent('bad-policy'); h.goal(agent); h.job(agent)
    await h.turnStopping(agent)
    value = 'invalid'
    await h.turnStopping(agent)
    assert.equal(h.goals.peek(agent)?.activation, 'disarmed')
    assert.equal(h.goals.byKind('resume').length, 0)
    assert.ok(h.warnings.some(line => line.includes('invalid live policy ignored')))
  } finally { await h.dispose() }
})
