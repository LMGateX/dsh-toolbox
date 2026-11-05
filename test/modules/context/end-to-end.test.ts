// @ts-nocheck — regression port from the original JavaScript suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import {
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import { apply, Config } from '../../../src/modules/context/index.ts';

function realSession() {
  const session = Session.create(SessionId('compact-tool-e2e-test'));
  const user = (text) => session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  );
  const assistant = (text, calls = []) => {
    const content = [{ type: 'text', text }];
    for (const call of calls) content.push({ type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: '{}' });
    const message = createAssistantMessage({ content, source: { provider: 'test', model: 'test' } });
    return session.append('assistant/message', { turn: 1, step: 1, message, stream: [] }, { surfaceOp: 'append' });
  };

  session.append('turn/start', { turn: 1 });
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('system') }, { surfaceOp: 'append' });
  user('u1');
  assistant('a1');
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

  session.append('turn/start', { turn: 2 });
  user('u2');
  assistant('a2', [{ id: 'call-1', name: 'read' }]);
  session.append('tool/result', {
    turn: 2,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId('call-1'), content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });

  session.append('turn/start', { turn: 3 });
  user('u3');
  assistant('a3');
  return session;
}

function meterFor(token = 500) {
  return {
    measure(session) {
      const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: token, heuristicTokens: token }));
      return { nodes, surfaceTokens: nodes.length * token, totalTokens: nodes.length * token };
    },
    estimateMessage() {
      return 1;
    },
  };
}

/** A real BasicCompactionEngine with only the summarizer stubbed. */
function engineWithStubSummarizer() {
  const engine = Object.create(BasicCompactionEngine.prototype);
  engine.config = {
    thresholdRatio: 0.4,
    headroomTokens: 1000,
    retainRatio: 0.1,
    retainTokens: undefined,
    auto: false,
    modelPolicies: [],
    compactionRetries: 0,
    maxOverflowRetries: 0,
    summarizationProvider: undefined,
    summarizationModel: undefined,
    maxTokens: undefined,
  };
  engine.ctx = {
    tokenMeter: null,
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: 10000 }, defaultMaxTokens: 1000 };
      },
    },
    get() {
      return undefined;
    },
    waterfall: () => false,
  };
  engine.summarize = async () => ({
    summary: [{ type: 'text', text: '## Primary Request and Intent\n- test' }],
    rawOutput: [],
    provider: 'test',
    model: 'test',
    maxTokens: 1,
  });
  return engine;
}

test('the model-facing tool delegates to the real native pressure policy', async () => {
  const session = realSession();
  session.requestHeader = () => ({ config: { provider: 'test', model: 'test', maxTokens: 1000 } });
  const meter = meterFor();
  const engine = engineWithStubSummarizer();
  engine.ctx.tokenMeter = meter;

  const ctx = {
    tools: {
      definitions: new Map(),
      register(definition) { this.definitions.set(definition.name, definition); },
    },
    compaction: engine,
    tokenMeter: meter,
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: 10000 }, defaultMaxTokens: 1000 };
      },
    },
    systemPrompt: { section() {}, context() {} },
    get() { return undefined; },
  };
  apply(ctx, Config({}));

  const result = await ctx.tools.definitions.get('compact_context').execute(
    {},
    { agent: { session, options: {} }, signal: new AbortController().signal },
  );
  assert.equal(result.ok, true);
  assert.equal(result.compactedItems, 5);
  assert.equal(result.freedTokens, 2500);
  assert.equal(result.mode, 'pressure');
  assert.equal(session.surface.nodes.length, 4);
  assert.equal(session.eventAt(session.surface.nodes[1]).data.source.kind, 'compact-checkpoint');
});

test('below the native threshold, uses the native retained-tail selection', async () => {
  const session = realSession();
  session.requestHeader = () => ({ config: { provider: 'test', model: 'test', maxTokens: 1000 } });
  const meter = meterFor(300);
  const engine = engineWithStubSummarizer();
  engine.ctx.tokenMeter = meter;

  const ctx = {
    tools: {
      definitions: new Map(),
      register(definition) { this.definitions.set(definition.name, definition); },
    },
    compaction: engine,
    tokenMeter: meter,
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: 10000 }, defaultMaxTokens: 1000 };
      },
    },
    systemPrompt: { section() {}, context() {} },
    get() { return undefined; },
  };
  apply(ctx, Config({}));

  const result = await ctx.tools.definitions.get('compact_context').execute(
    {},
    {
      agent: { session, options: { provider: 'test', model: 'test' } },
      signal: new AbortController().signal,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'retention');
  assert.equal(result.compactedItems, 3);
  assert.equal(result.freedTokens, 900);
  assert.equal(session.surface.nodes.length, 6);
});
