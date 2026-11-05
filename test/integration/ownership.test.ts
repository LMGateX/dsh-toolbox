import test from 'node:test';
import assert from 'node:assert/strict';
import * as retry from '../../src/modules/retry/index.ts';
import * as goalWait from '../../src/modules/goal-wait/index.ts';
import type { Distribution } from '../../src/types.ts';
import { createRuntime } from '../modules/retry/runtime.ts';
import { loaderFixture, loadHost, pause, until } from './loader-harness.ts';

test('a captured native stream sees live retry policy, then becomes inert when its module is disabled', { timeout: 10000 }, async t => {
  const runtime = await createRuntime({ product: false, retry: false }); t.after(() => runtime.dispose());
  const d: Distribution = { name: 'dsh-toolbox-retry', moduleIds: ['retry'], modulePlugins: { retry } };
  const initial = { modules: { retry: { enabled: true, errorCodes: [] as string[], retryEmptyResponse: false } }, migration: { auto: false } };
  const f = await loaderFixture(t, d, initial, runtime.ctx); await f.ready();
  const capture = async () => {
    let release!: () => void; const hold = new Promise<void>(done => { release = done; });
    async function* source() { yield { type: 'text-delta', index: 0, text: 'prefix' }; await hold; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'custom', message: 'custom: interrupted' } } }; }
    const stream = runtime.ctx.waterfall(runtime.ctx.llm, 'llm/stream', { provider: 'test', signal: new AbortController().signal }, source);
    const iterator = stream[Symbol.asyncIterator](); await iterator.next();
    return { iterator, release };
  };
  const captured = await capture();
  await f.update({ ...initial, modules: { retry: { ...initial.modules.retry, errorCodes: ['custom'] } } }); await pause();
  captured.release(); const rewritten = await captured.iterator.next();
  assert.equal(rewritten.value.reason.failure.code, 'TRANSPORT');
  const obsolete = await capture();
  await f.update({ ...initial, modules: { retry: { ...initial.modules.retry, enabled: false, errorCodes: ['custom'] } } });
  await until(() => f.status(), state => state.modules.retry.phase === 'disabled', 'retry disabled');
  obsolete.release(); const untouched = await obsolete.iterator.next();
  assert.equal(untouched.value.reason.failure.code, 'custom');
});

test('root policy-only goal updates preserve held authority beside the unmodified native driver', { timeout: 10000 }, async t => {
  const runtime = await createRuntime({ product: false, retry: false }); t.after(() => runtime.dispose());
  const ctx = runtime.ctx;
  await ctx.plugin((await loadHost('dsh-goal')).default).await();
  await ctx.plugin((await loadHost('dsh-jobs-local')).default, {}).await();
  const detach = ctx.jobs.attachController('root-gate-lifecycle'); t.after(detach);
  await ctx.plugin(await loadHost('dsh-goal-round-driver')).await();
  const d: Distribution = { name: 'dsh-toolbox-goal-wait', moduleIds: ['goalWait'], modulePlugins: { goalWait } };
  const initial = { modules: { goalWait: { enabled: true, waitForJobs: true, waitForSubagents: true, maxHoldMs: 0 } }, migration: { auto: false } };
  const f = await loaderFixture(t, d, initial, ctx); await f.ready();
  const handle = await runtime.createAgent({ sessionId: 'root-held-goal' });
  const baseline = handle.state.requests.length;
  let finish!: (value: any) => void; const done = new Promise<any>(resolve => { finish = resolve; });
  const jobId = ctx.jobs.start({ kind: 'workflow', label: 'root policy gate fixture', owner: handle.agent.id, run: () => ({ done, cancel: () => finish({ status: 'killed' }) }) });
  const goal = ctx.goals.create(handle.agent, { objective: 'Maintain held authority through live edits', maxGoalRounds: 1 });
  await pause(); assert.equal(ctx.goals.get(handle.agent).activation, 'disarmed');
  const live = () => [...ctx.registry.values()].flatMap((item: any) => item.name === 'toolbox-goal-wait' ? [...item.fibers] : []).find((fiber: any) => fiber.uid !== null);
  const before = live();
  await f.update({ ...initial, modules: { goalWait: { ...initial.modules.goalWait, waitForSubagents: false } } }); await pause();
  assert.equal(live(), before);
  assert.equal(ctx.goals.get(handle.agent).activation, 'disarmed');
  assert.equal(ctx.goals.get(handle.agent).revision, goal.revision);
  assert.equal(ctx.goals.get(handle.agent).roundsStarted, 0);
  assert.equal(handle.state.requests.length, baseline, 'no native reservation slips between policy owners');
  await f.update({ ...initial, modules: { goalWait: { ...initial.modules.goalWait, waitForJobs: false, waitForSubagents: false } } });
  await until(() => ctx.goals.get(handle.agent).activation, activation => activation === 'armed', 'live policy releases owned hold');
  finish({ status: 'completed' }); await ctx.jobs.wait(jobId, 1000, handle.agent.session.id);
  await until(() => handle.state.requests.length, count => count === baseline + 1, 'native round follows policy release');
  await handle.agent.whenIdle();
  assert.equal(ctx.goals.get(handle.agent).roundsStarted, 1);
  assert.ok([...ctx.registry.values()].some((entry: any) => entry.name === 'goal-round-driver'));
});

test('a module saved disabled initially can be enabled by a later native volatile write', { timeout: 10000 }, async t => {
  const runtime = await createRuntime({ product: false, retry: false }); t.after(() => runtime.dispose());
  const d: Distribution = { name: 'dsh-toolbox-retry', moduleIds: ['retry'], modulePlugins: { retry } };
  const initial = { modules: { retry: { enabled: false } }, migration: { auto: false } };
  const f = await loaderFixture(t, d, initial, runtime.ctx); await f.ready();
  assert.equal(f.status().modules.retry.phase, 'disabled');
  await f.update({ ...initial, modules: { retry: { enabled: true } } });
  await until(() => f.status(), state => state.modules.retry.phase === 'active', 'initially disabled module becomes active');
});
