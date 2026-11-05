import test from 'node:test';
import assert from 'node:assert/strict';
import * as context from '../../src/modules/context/index.ts';
import type { Distribution } from '../../src/types.ts';
import { createRuntime, runTurn, MockAdapter } from '../modules/retry/runtime.ts';
import { loadHost, loaderFixture, until } from './loader-harness.ts';

test('context capabilities mount without a root engine and report missing engines for the exact agent', { timeout: 10000 }, async t => {
  const runtime = await createRuntime({ product: false, retry: false }); t.after(() => runtime.dispose());
  await runtime.ctx.plugin((await loadHost('dsh-token-meter')).default).await();
  const d: Distribution = { name: 'dsh-toolbox-context', moduleIds: ['context'], modulePlugins: { context } };
  const f = await loaderFixture(t, d, { modules: { context: { enabled: true, statusTool: true } }, migration: { auto: false } }, runtime.ctx);
  const state = await f.ready(); assert.equal(state.modules.context.phase, 'active');
  const handle = await runtime.createAgent({ sessionId: 'without-scoped-engine' });
  const compact = runtime.ctx.tools.get('compact_context', handle.agent);
  assert.ok(compact);
  const value = await compact.execute({}, { agent: handle.agent, signal: new AbortController().signal });
  assert.equal(value.ok, false); assert.match(value.reason, /no compaction backend.*agent/i);
  const status = await runtime.ctx.tools.get('context_status', handle.agent).execute({}, { agent: handle.agent, signal: new AbortController().signal });
  assert.equal(status.ok, true); assert.equal(status.policyKnown, false); assert.match(status.policyReason, /no compaction backend/i);
});

test('canonical context tools route to exact retained native preset engines in nested isolated groups', { timeout: 20000 }, async t => {
  const runtime = await createRuntime({ product: false, retry: false }); t.after(() => runtime.dispose());
  const ctx = runtime.ctx; await ctx.plugin((await loadHost('dsh-token-meter')).default).await();
  const d: Distribution = { name: 'dsh-toolbox-context', moduleIds: ['context'], modulePlugins: { context } };
  const initial = { modules: { context: { enabled: true, statusTool: true, retryAttempts: 0 } }, migration: { auto: false } };
  const f = await loaderFixture(t, d, initial, ctx); await f.ready();
  const basic = (await loadHost('dsh-compaction-basic')).default;
  f.importTable.set('@deepseek-ai/dsh-compaction-basic', basic);
  await ctx.plugin((await loadHost('dsh-agent-preset-registry')).default, { default: 'one' }).await();
  const presets = ctx.get('agentPresets') as any;
  const register = async (id: string, retainTokens?: number) => {
    const plugins = retainTokens === undefined ? [] : [{ id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { auto: false, retainTokens, thresholdRatio: 0.9, headroomTokens: 1000, maxTokens: 200 } }] }];
    const remove = await presets.register({ id, plugins }); t.after(remove); return remove;
  };
  const removeOne = await register('one', 100); await register('two', 300); await register('none');
  class ScopedAdapter extends MockAdapter { async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 200000 }, defaultMaxTokens: 1000 }; } }
  const create = async (id: string, instance = id) => {
    const state = { events: [], frames: [], requests: [] };
    ctx.llm.registerAdapter(['test-' + instance], new ScopedAdapter(state, { failures: 0 }));
    const handle = await ctx.agents.create({ sessionId: 'scoped-' + instance, agentOptions: { provider: 'test-' + instance, model: 'mock-model' }, setup: async (scope: any) => { await scope.get('agentPresets').mount(scope, id); } });
    t.after(() => handle.dispose()); return { ...handle, state };
  };
  const one = await create('one'); const two = await create('two'); const none = await create('none');
  const engineOne = presets.serviceFor(one.agent, 'compaction'); const engineTwo = presets.serviceFor(two.agent, 'compaction');
  assert.ok(engineOne); assert.ok(engineTwo); assert.notEqual(engineOne, engineTwo);
  assert.equal(one.agent.ctx.get('compaction'), undefined, 'outer public agent context does not see the nested isolated group');
  let wrongCalls = 0;
  ctx.reflect.provide('compaction', { config: { retainTokens: 999 }, async compactIfNeeded() { wrongCalls++; throw new Error('wrong host engine'); } });
  assert.equal((await ctx.llm.resolveModelInfo('test-one', 'mock-model')).context.contextWindow, 200000);
  const exec = (agent: any) => ({ agent, signal: new AbortController().signal });
  const read = (agent: any) => ctx.tools.get('context_status', agent).execute({}, exec(agent));
  const oneStatus = await read(one.agent); const twoStatus = await read(two.agent);
  assert.equal(oneStatus.retain, 100, JSON.stringify(oneStatus)); assert.equal(twoStatus.retain, 300, JSON.stringify(twoStatus));
  await removeOne(); await register('one', 200);
  const fresh = await create('one', 'one-new');
  assert.equal((await read(one.agent)).retain, 100, 'a live agent retains its original native revision');
  assert.equal((await read(fresh.agent)).retain, 200, 'a later agent joins the new native revision');
  assert.equal((await read(none.agent)).policyKnown, false);
  const missing = await ctx.tools.get('compact_context', none.agent).execute({}, exec(none.agent));
  assert.equal(missing.ok, false); assert.match(missing.reason, /no compaction backend/); assert.equal(wrongCalls, 0);
  const tools = ctx.tools.schemas(one.agent).filter((tool: any) => tool.name === 'compact_context'); assert.equal(tools.length, 1);
  await runTurn(one, 'Older context '.repeat(2000)); await runTurn(one, 'More history '.repeat(2000));
  await runTurn(two, 'Separate context '.repeat(2000)); await runTurn(two, 'Other history '.repeat(2000));
  const beforeTwo = [...two.agent.session.surface.nodes];
  // Native engine transaction and native summarization run through the offline
  // adapter. Only a normal user turn is opened; the tool selects native retention.
  one.agent.session.append('turn/start', { turn: 3 });
  const compactOne = await ctx.tools.get('compact_context', one.agent).execute({}, exec(one.agent));
  assert.equal(compactOne.ok, true, JSON.stringify(compactOne)); assert.equal(compactOne.mode, 'retention');
  assert.deepEqual([...two.agent.session.surface.nodes], beforeTwo, 'another preset engine never touches this session');
  const beforeOne = [...one.agent.session.surface.nodes];
  two.agent.session.append('turn/start', { turn: 3 });
  const compactTwo = await ctx.tools.get('compact_context', two.agent).execute({}, exec(two.agent));
  assert.equal(compactTwo.ok, true, JSON.stringify(compactTwo)); assert.equal(compactTwo.mode, 'retention');
  assert.deepEqual([...one.agent.session.surface.nodes], beforeOne, 'the second native engine never dispatches to the first session');
  assert.equal(wrongCalls, 0);
  await f.update({ ...initial, modules: { context: { ...initial.modules.context, statusTool: false } } });
  await until(() => ctx.tools.get('context_status', one.agent), value => value === undefined, 'scoped optional tool disabled');
  assert.ok(ctx.tools.get('compact_context', two.agent));
  await f.entry.update({ disabled: true }); await f.loader.await();
  assert.equal(ctx.tools.get('compact_context', one.agent), undefined); assert.equal(ctx.tools.get('compact_context', two.agent), undefined);
  assert.equal(presets.serviceFor(one.agent, 'compaction').config.retainTokens, 100);
  assert.equal(presets.serviceFor(two.agent, 'compaction').config.retainTokens, 300);
});
