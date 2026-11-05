// @ts-nocheck — regression port from the original JavaScript suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNativeRetentionRange } from '../../../src/modules/context/manual.ts';
import { makeSession } from './helpers.ts';

const text = (role) => ({ message: { role, content: [{ type: 'text', text: role }] } });
const calls = (count) => ({
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'calls' },
      ...Array.from({ length: count }, (_, index) => ({ type: 'tool-call', id: `call-${String(index)}`, name: 'read', arguments: '{}' })),
    ],
  },
});

test('the retained-tail cut moves before a parallel tool-call group in one pass', () => {
  const session = makeSession();
  session.append('system/message', text('system'));
  session.append('user/message', text('user-1'));
  session.append('assistant/message', text('assistant-1'));
  session.append('user/message', text('user-2'));
  session.append('assistant/message', calls(3));
  session.append('tool/result', text('tool-1'));
  session.append('tool/result', text('tool-2'));
  session.append('tool/result', text('tool-3'));
  session.append('assistant/message', text('assistant-2'));

  const surface = session.surface.nodes;
  const measurement = {
    nodes: surface.map((seq) => ({ seq, tokens: 100, heuristicTokens: 100 })),
  };
  // The priced tail stops inside the parallel results; the only safe cut before
  // the open tool-call group is before the assistant message that started it.
  const range = selectNativeRetentionRange(session, measurement, 150);
  assert.deepEqual(range, { start: surface[1], end: surface[3] });
});
