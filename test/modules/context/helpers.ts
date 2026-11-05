// @ts-nocheck — regression port from the original JavaScript suite.
/** Shared fake session for selection and plugin tests. */

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);

/** @param {string} text */
function textMessage(text) {
  return { message: { role: 'user', content: [{ type: 'text', text }] } };
}

/** @param {string} text @param {number} calls */
function assistantMessage(text, calls = 0) {
  const content = [{ type: 'text', text }];
  for (let index = 0; index < calls; index += 1) {
    content.push({ type: 'tool-call', id: `call-${String(index)}`, name: 'read', arguments: '{}' });
  }
  return { message: { role: 'assistant', content } };
}

export function makeSession() {
  const events = [];
  const nodes = [];
  return {
    get seq() {
      return events.length;
    },
    get surface() {
      return { nodes: [...nodes] };
    },
    eventAt(seq) {
      return events[seq];
    },
    append(type, data) {
      const seq = events.length;
      events.push({ seq, type, data });
      if (SURFACE_TYPES.has(type)) nodes.push(seq);
      return seq;
    },
  };
}

/**
 * system + two completed turns + one open turn.
 * Turn 2 closes a tool call; the open turn has no tool calls yet.
 */
export function buildConversation() {
  const session = makeSession();
  session.append('turn/start', { turn: 1 });
  session.append('system/message', textMessage('system'));
  session.append('user/message', textMessage('u1'));
  session.append('assistant/message', assistantMessage('a1'));
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

  session.append('turn/start', { turn: 2 });
  session.append('user/message', textMessage('u2'));
  session.append('assistant/message', assistantMessage('a2', 1));
  session.append('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: 'r1' }] } });
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });

  session.append('turn/start', { turn: 3 });
  session.append('user/message', textMessage('u3'));
  session.append('assistant/message', assistantMessage('a3'));
  return session;
}
