import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './harness.ts'
import type { Config } from '../../../src/modules/goal-wait/index.ts'

test('with no background work the gate consults the goal and mutates nothing', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)

  await harness.turnStopping(agent)
  harness.idle(agent)

  assert.equal(harness.goals.byKind('disarm').length, 0, 'no disarm without live work')
  assert.equal(harness.goals.byKind('resume').length, 0, 'no resume without a hold')
  assert.equal(harness.goals.byKind('pause').length, 0, 'the gate never pauses')
  assert.ok(harness.goals.byKind('get').length >= 2, 'the gate consults the goal at both checkpoints')
  assert.equal(harness.observations.at(-1), 'armed', 'the official driver still sees an armed goal')

  await harness.dispose()
})

test('a running owned job disarms the goal before the agent reaches idle', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  harness.job(agent)

  await harness.turnStopping(agent)
  assert.deepEqual(
    harness.goals.byKind('disarm').map((call) => call.agentId),
    ['agent-1'],
    'the gate disarms at turn-stopping, before idle',
  )

  harness.idle(agent)
  assert.equal(harness.observations.at(-1), 'disarmed', 'the official driver sees a disarmed goal at idle')
  assert.equal(harness.goals.peek(agent)?.phase, 'active', 'gating never changes the durable phase')
  assert.equal(harness.goals.byKind('pause').length, 0, 'the gate never pauses')

  await harness.dispose()
})

test('a settled job releases the hold after its notice turn ends, resuming exactly once', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  const job = harness.job(agent)

  await harness.turnStopping(agent)
  harness.idle(agent)
  assert.equal(harness.goals.peek(agent)?.activation, 'disarmed', 'held while the job runs')

  harness.settle(job)
  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('resume').length, 1, 'the gate resumes exactly once when the notice turn ends')
  assert.equal(harness.goals.peek(agent)?.activation, 'armed', 'the goal is armed again')

  harness.idle(agent)
  assert.equal(harness.observations.at(-1), 'armed', 'the official driver can continue at the next idle')
  assert.equal(harness.goals.byKind('resume').length, 1, 'no double resume')

  await harness.dispose()
})

test('live subagent descendants hold continuation, and gone children release it', async () => {
  const harness = await createHarness()
  const parent = harness.agent('parent')
  harness.goal(parent)

  // A resident child between turns is still an active activation epoch: it has
  // not settled, so its settlement notice has not reached the parent yet.
  const child = harness.agent('child-1', { parent: parent.session.id, status: 'idle' })
  await harness.turnStopping(parent)
  assert.equal(harness.goals.byKind('disarm').length, 1, 'a resident child holds continuation even while idle')
  assert.equal(child.status, 'idle')

  harness.agent('grandchild-1', { parent: 'session-child-1' })
  await harness.turnStopping(parent)
  assert.equal(harness.goals.byKind('disarm').length, 1, 'an already-held goal is not re-disarmed')

  harness.agents.drop('grandchild-1')
  harness.agents.drop('child-1')
  await harness.turnStopping(parent)
  assert.equal(harness.goals.byKind('resume').length, 1, 'release once no live descendant remains')
  assert.equal(harness.goals.peek(parent)?.activation, 'armed')

  await harness.dispose()
})

test('jobs owned by other sessions and unowned jobs never hold', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  const other = harness.agent('agent-2')
  harness.goal(agent)
  harness.job(other)
  harness.job(undefined)

  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 0, 'foreign and unowned jobs are not this agent\'s work')

  await harness.dispose()
})

test('an idle with no preceding turn-stopping still holds', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  harness.job(agent)

  harness.idle(agent)
  assert.equal(harness.goals.byKind('disarm').length, 1, 'the idle checkpoint is a safety net')
  assert.equal(harness.observations.at(-1), 'disarmed', 'the stand-in driver sees the gate first')

  await harness.dispose()
})

test('a goal the gate did not disarm is never resumed', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent, { activation: 'disarmed' })

  await harness.turnStopping(agent)
  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('resume').length, 0, 'a host disarm stays disarmed')

  await harness.dispose()
})

test('a human re-arm wins: the gate drops its hold and does not re-disarm during the same wait', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  const goal = harness.goal(agent)
  const job = harness.job(agent)

  await harness.turnStopping(agent)
  assert.equal(harness.goals.peek(agent)?.activation, 'disarmed', 'gated while the job runs')

  // The user explicitly resumes while the background job is still running.
  const resumed = harness.goals.resume(agent, { id: goal.id, revision: goal.revision })
  assert.equal(resumed.activation, 'armed')

  await harness.turnStopping(agent)
  assert.equal(harness.goals.peek(agent)?.activation, 'armed', 'the explicit re-arm is not fought')
  assert.equal(harness.goals.byKind('disarm').length, 1, 'no second disarm during the same wait')

  // A later episode, after the work is gone, gates normally again.
  harness.settle(job)
  await harness.turnStopping(agent)
  harness.job(agent)
  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 2, 'a new wait is gated again')

  await harness.dispose()
})

test('a goal paused while held is dropped and never resumed', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  const goal = harness.goal(agent)
  const job = harness.job(agent)

  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 1)

  harness.goals.pause(agent, { id: goal.id, revision: goal.revision })
  harness.settle(job)
  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('resume').length, 0, 'a paused goal is not resumed')

  await harness.dispose()
})

test('an edit while held still releases with the current revision', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  const goal = harness.goal(agent)
  const job = harness.job(agent)
  await harness.turnStopping(agent)

  // An official edit commits a new revision and keeps the gate's disarm.
  const editedRevision = goal.revision + 1
  const live = harness.goals.peek(agent)
  assert.ok(live !== undefined)
  live.revision = editedRevision
  live.objective = 'edited objective'
  harness.settle(job)

  await harness.turnStopping(agent)
  const resumes = harness.goals.byKind('resume')
  assert.equal(resumes.length, 1)
  assert.equal(resumes[0]?.revision, editedRevision, 'released against the current revision')
  assert.equal(harness.goals.peek(agent)?.activation, 'armed')

  await harness.dispose()
})

test('a replaced goal drops the stale hold and gates the new goal', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  harness.job(agent)
  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 1)

  harness.goals.set(agent.session.id, {
    id: 'goal-2',
    revision: 1,
    objective: 'a new objective',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 0,
    maxGoalRounds: 256,
  })
  await harness.turnStopping(agent)
  const disarms = harness.goals.byKind('disarm')
  assert.equal(disarms.length, 2, 'the new armed goal is gated')
  assert.equal(disarms[1]?.goalId, 'goal-2')

  await harness.dispose()
})

test('unloading the plugin re-arms only the goals it gated', async () => {
  const harness = await createHarness()
  const gated = harness.agent('gated')
  const untouched = harness.agent('untouched')
  harness.goal(gated)
  harness.job(gated)
  harness.goal(untouched, { activation: 'disarmed' })
  harness.job(untouched)

  await harness.turnStopping(gated)
  await harness.turnStopping(untouched)
  assert.equal(harness.goals.byKind('disarm').length, 1, 'only the armed goal is gated')

  await harness.unload()
  const resumes = harness.goals.byKind('resume')
  assert.deepEqual(resumes.map((call) => call.agentId), ['gated'], 'only the gate\'s own hold is re-armed')
  assert.equal(harness.goals.peek(gated)?.activation, 'armed')
  assert.equal(harness.goals.peek(untouched)?.activation, 'disarmed')

  await harness.dispose()
})

test('an agent disposed while held is forgotten before unload', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  const job = harness.job(agent)
  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 1)

  harness.settle(job)
  harness.agents.drop('agent-1')
  await harness.unload()
  assert.equal(harness.goals.byKind('resume').length, 0, 'a disposed agent is never resumed')

  await harness.dispose()
})

test('a failing goal read is contained and logged', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  harness.job(agent)
  harness.goals.breakReads = true

  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 0, 'no mutation when the read fails')
  assert.ok(
    harness.warnings.some((warning) => warning.includes('evaluation failed')),
    'the failure is logged',
  )

  await harness.dispose()
})

test('waitForJobs: false gates on subagents only', async () => {
  const harness = await createHarness({ config: { waitForJobs: false } })
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  harness.job(agent)

  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 0, 'jobs are ignored')

  harness.agent('child-1', { parent: agent.session.id })
  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 1, 'subagents still gate')

  await harness.dispose()
})

test('waitForSubagents: false gates on jobs only', async () => {
  const harness = await createHarness({ config: { waitForSubagents: false } })
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  harness.agent('child-1', { parent: agent.session.id })

  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 0, 'subagents are ignored')

  harness.job(agent)
  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 1, 'jobs still gate')

  await harness.dispose()
})

test('an invalid config fails the mount with a clear error', async () => {
  await assert.rejects(() => createHarness({ config: { maxHoldMs: -1 } }), /maxHoldMs/)
  await assert.rejects(() => createHarness({ config: { maxHoldMs: 1.5 } }), /maxHoldMs/)
  await assert.rejects(
    () => createHarness({ config: { waitForJobs: 'yes' } as unknown as Config }),
    /waitForJobs/,
  )
})

test('the plugin loads without a jobs service and still gates subagents', async () => {
  const harness = await createHarness({ mountJobs: false })
  const parent = harness.agent('parent')
  harness.goal(parent)
  harness.agent('child-1', { parent: parent.session.id })

  await harness.turnStopping(parent)
  assert.equal(harness.goals.byKind('disarm').length, 1)

  await harness.dispose()
})

test('maxHoldMs releases a stuck hold exactly once, with one warning', async () => {
  const harness = await createHarness({ config: { maxHoldMs: 20 } })
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  harness.job(agent)

  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 1)

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(harness.goals.byKind('resume').length, 1, 'the stuck hold is released')
  assert.equal(harness.goals.peek(agent)?.activation, 'armed')
  assert.equal(
    harness.warnings.filter((warning) => warning.includes('hold expired')).length,
    1,
    'exactly one warning per hold',
  )

  await harness.dispose()
})

test('a goal created while the agent is already idle is gated before the driver can inject', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.job(agent)

  harness.createGoal(agent)

  assert.equal(harness.goals.byKind('disarm').length, 1, 'creation is evaluated immediately')
  assert.equal(harness.goals.peek(agent)?.activation, 'disarmed', 'the new goal never gets an empty round')

  await harness.dispose()
})

test('every hold and release is logged with the goal identity and reason', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  const job = harness.job(agent)

  await harness.turnStopping(agent)
  harness.settle(job)
  await harness.turnStopping(agent)

  const held = harness.infos.filter((line) => line.includes('held') && line.includes('goal-1'))
  const released = harness.infos.filter((line) => line.includes('released') && line.includes('goal-1'))
  assert.equal(held.length, 1, 'one hold line')
  assert.equal(released.length, 1, 'one release line')

  await harness.dispose()
})

test('a completed goal is never gated and never re-armed, even with live work', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent, { phase: 'complete', activation: 'disarmed' })
  harness.job(agent)

  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 0, 'a finished goal is not held')
  assert.equal(harness.goals.byKind('resume').length, 0, 'a finished goal is not re-armed')

  await harness.dispose()
})

test('a goal completed while held is dropped and left disarmed', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  const goal = harness.goal(agent)
  const job = harness.job(agent)

  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 1, 'held while the job runs')

  harness.goals.complete(agent, { id: goal.id, revision: goal.revision })
  assert.equal(harness.goals.peek(agent)?.phase, 'complete')
  assert.equal(harness.goals.peek(agent)?.activation, 'disarmed', 'completion disarms by itself')

  harness.settle(job)
  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('resume').length, 0, 'a completed goal is never re-armed')

  await harness.dispose()
})

test('a goal started after a restart is gated before the driver can inject', async () => {
  // A fresh process: no holds survive, and a restored active goal reads disarmed
  // until the user starts it again.
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  const goal = harness.goal(agent, { activation: 'disarmed' })
  harness.job(agent)

  harness.goals.resume(agent, { id: goal.id, revision: goal.revision })

  assert.equal(harness.goals.byKind('disarm').length, 1, 'the restarted goal is gated like any other arming')
  assert.equal(harness.goals.peek(agent)?.activation, 'disarmed')

  await harness.dispose()
})

test('the plugin mounts and unloads on a live context', async () => {
  const harness = await createHarness()
  await harness.unload()
  await harness.dispose()
})

test('a blocked goal is never held or resumed, including on unload', async () => {
  const h = await createHarness(); const agent = h.agent('blocked');
  h.goal(agent, { phase: 'blocked', activation: 'disarmed' }); h.job(agent);
  await h.turnStopping(agent); await h.unload();
  assert.equal(h.goals.byKind('disarm').length, 0);
  assert.equal(h.goals.byKind('resume').length, 0);
  await h.dispose();
});

test('an independent fork is not mistaken for a live subagent descendant', async () => {
  const h = await createHarness(); const parent = h.agent('fork-parent'); h.goal(parent);
  const fork = h.agent('independent-fork', { parent: parent.session.id });
  fork.session.header.origin = 'fork';
  await h.turnStopping(parent);
  assert.equal(h.goals.byKind('disarm').length, 0);
  await h.dispose();
});
