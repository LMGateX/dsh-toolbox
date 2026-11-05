/** Installed-host integration: real agents, goals, jobs and the unmodified native driver. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { goalWaitGate } from '../../../src/modules/goal-wait/index.ts'
import { createRuntime, load, runtimeVersion } from '../retry/runtime.ts'

test('conventional gate holds and releases beside the current official goal driver', { timeout: 10000 }, async (t) => {
  const runtime = await createRuntime({ product: false, retry: false })
  const { ctx } = runtime
  let detachController: (() => void) | undefined
  try {
    await ctx.plugin((await load<any>('dsh-goal')).default).await()
    await ctx.plugin((await load<any>('dsh-jobs-local')).default, {}).await()
    detachController = ctx.jobs.attachController('toolbox-host-gate-test')
    await ctx.plugin(goalWaitGate, {}).await()
    const native = await load<any>('dsh-goal-round-driver')
    const driver = ctx.plugin(native); await driver.await()
    const handle = await runtime.createAgent({ sessionId: 'toolbox-native-gate' })
    const { agent } = handle
    let finish!: (value: { status: string }) => void
    const done = new Promise<{ status: string }>(resolve => { finish = resolve })
    const id = ctx.jobs.start({ kind: 'workflow', label: 'offline held work', owner: agent.session.id,
      run: () => ({ done, cancel: () => finish({ status: 'killed' }) }) })
    const goal = ctx.goals.create(agent, { objective: 'Exercise the unmodified official driver', maxGoalRounds: 1 })
    await new Promise<void>(resolve => setImmediate(resolve))
    const held = ctx.goals.get(agent)
    assert.equal(held.phase, 'active'); assert.equal(held.activation, 'disarmed')
    assert.equal(held.revision, goal.revision); assert.equal(held.roundsStarted, 0)
    assert.equal(handle.state.requests.length, 0)
    assert.ok([...ctx.registry.values()].some((entry: any) => entry.name === 'goal-round-driver'))
    finish({ status: 'completed' })
    await ctx.jobs.wait(id, 1000, agent.session.id)
    const ended = new Promise<void>(resolve => {
      const remove = ctx.on('session/event', (session: any, event: any) => {
        if (session.id === agent.session.id && event.type === 'turn/end') { remove(); resolve() }
      })
    })
    ctx.emit('agent/status', { agent, status: 'idle' })
    await ended
    assert.equal(ctx.goals.get(agent).roundsStarted, 1)
    assert.equal(handle.state.requests.length, 1)
    assert.equal(driver.uid === null, false, 'the original native driver was not unloaded')
    t.diagnostic('real native goal driver and job registry: DSH ' + runtimeVersion)
  } finally { detachController?.(); await runtime.dispose() }
})
