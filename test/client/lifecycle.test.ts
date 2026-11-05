import assert from 'node:assert/strict';
import test from 'node:test';
import { createChimeAdapter } from '../../client/chime.ts';
import { mountChimeController } from '../../client/index.ts';
import { createStatusStore, capturePageProof, legacyChimeAtBoot } from '../../client/status.ts';

const React: any = { createElement: (...args: any[]) => args, useState: (f: any) => [f(), () => {}], useEffect() {}, useSyncExternalStore: (_s: any, get: any) => get() };
const api = createChimeAdapter(React);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function clock() {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return { timers, setTimer(fn: () => void, _ms: number) { timers.set(++seq, fn); return seq; }, clearTimer(id: unknown) { timers.delete(id as number); }, next() { const entry = [...timers][0]; assert.ok(entry); timers.delete(entry[0]); entry[1](); } };
}
function store<T>(value: T) {
  let current = value;
  const listeners = new Set<() => void>();
  return { listeners, getSnapshot: () => current, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }, set(next: T) { current = next; for (const fn of listeners) fn(); } };
}

test('watcher disposal clears settle timers and ignores all later inputs', () => {
  const c = clock(); let rings = 0;
  const watcher = api.createWatcher({ now: () => 0, setTimer: c.setTimer, clearTimer: c.clearTimer, readSettings: () => api.settingsOf({}), ring: () => rings++ });
  watcher.update({ ids: ['a'], byId: { a: { running: true } } });
  watcher.update({ ids: ['a'], byId: { a: { running: false } } });
  assert.equal(c.timers.size, 1);
  watcher.dispose(); watcher.dispose();
  assert.equal(c.timers.size, 0);
  watcher.reportError('a');
  watcher.update({ ids: ['a'], byId: { a: { running: true } } });
  watcher.update({ ids: ['a'], byId: { a: { running: false } } });
  assert.equal(c.timers.size, 0); assert.equal(rings, 0);
});

test('audio stop and disposal fence decode completions before a source can start', async () => {
  let starts = 0; let closes = 0;
  const decodes: ((value: any) => void)[] = [];
  (globalThis as any).window = { AudioContext: class {
    state = 'running'; destination = {};
    resume() { return Promise.resolve(); }
    close() { closes++; return Promise.resolve(); }
    decodeAudioData() { return new Promise(resolve => decodes.push(resolve)); }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    createBufferSource() { return { connect() {}, start() { starts++; }, stop() {} }; }
  } };
  const audio = api.createAudio(() => api.settingsOf({}));
  const one = audio.play('chime-soft', 50);
  audio.stop(); decodes[0]!({ duration: 0.5 }); await one;
  assert.equal(starts, 0);
  const two = audio.play('bell-bright', 50);
  audio.dispose(); audio.dispose(); decodes[1]!({ duration: 0.5 }); await two;
  assert.equal(starts, 0); assert.equal(closes, 1);
  await audio.play('chime-soft', 50); assert.equal(starts, 0);
});

test('new play replaces a pending decode without stale playback', async () => {
  let starts = 0;
  const decodes: ((value: any) => void)[] = [];
  (globalThis as any).window = { AudioContext: class {
    state = 'running'; destination = {};
    close() { return Promise.resolve(); }
    decodeAudioData() { return new Promise(resolve => decodes.push(resolve)); }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    createBufferSource() { return { connect() {}, start() { starts++; }, stop() {} }; }
  } };
  const audio = api.createAudio(() => api.settingsOf({}));
  const a = audio.play('chime-soft', 50); const b = audio.play('bell-bright', 50);
  decodes[0]!({ duration: 0.5 }); await a; assert.equal(starts, 0);
  decodes[1]!({ duration: 0.5 }); await flush(); assert.equal(starts, 1);
  audio.dispose(); await b;
});

test('controller gates runtime, not editing, on namespace, module and host ownership', () => {
  const form = Object.assign(store<any>({ status: 'ready', writable: false, revision: 0, value: { enabled: true } }), { mutate: async () => false });
  const status = store<any>({ modules: {} });
  let mounts = 0; let disposals = 0;
  const dispose = mountChimeController({}, form, status, { createView() {}, mount() { mounts++; return () => disposals++; } });
  assert.equal(mounts, 0);
  status.set({ modules: { chime: { ready: true, enabled: true, phase: 'active' } } }); assert.equal(mounts, 1);
  status.set({ modules: { chime: { ready: true, enabled: true, phase: 'active' } } }); assert.equal(mounts, 1);
  form.set({ ...form.getSnapshot(), value: { enabled: false } }); assert.equal(disposals, 1);
  form.set({ ...form.getSnapshot(), value: { enabled: true } }); assert.equal(mounts, 2);
  form.set({ ...form.getSnapshot(), status: 'unavailable' }); assert.equal(disposals, 2);
  dispose(); dispose(); assert.equal(form.listeners.size, 0); assert.equal(status.listeners.size, 0);
});

test('host-clock page proof uses exact sanitized row key; unknown boot is unsafe', () => {
  const key = '__DSH_TOOLBOX_PAGE_test_row__';
  (globalThis as any)[key] = { servedAt: 123 };
  assert.equal(capturePageProof('test-row'), 123); delete (globalThis as any)[key];
  assert.equal(capturePageProof('test-row'), undefined);
  assert.equal(legacyChimeAtBoot(undefined), true);
  assert.equal(legacyChimeAtBoot({ entries: [] }), false);
  assert.equal(legacyChimeAtBoot({ entries: [{ id: 'dsh-session-chime' }] }), true);
});

for (const scenario of [
  { legacy: true, served: 300, after: 200, ready: false },
  { legacy: false, served: undefined, after: 200, ready: false },
  { legacy: false, served: 200, after: 200, ready: false },
  { legacy: false, served: 201, after: 200, ready: true },
  { legacy: false, served: undefined, after: undefined, ready: true },
]) test('status reload fence ' + JSON.stringify(scenario), async () => {
  const c = clock();
  const s = createStatusStore('row name', { ...c, legacyAtBoot: scenario.legacy, pageServedAt: scenario.served, fetch: (async (url: string, options: any) => {
    assert.equal(url, '/toolbox/row%20name/status'); assert.equal(options.credentials, 'same-origin');
    return { ok: true, json: async () => ({ modules: { chime: { ready: true, enabled: true, phase: 'active' } }, report: { browserReloadAfter: scenario.after } }) };
  }) as any });
  const stop = s.start(); await flush(); assert.equal(s.getSnapshot().modules.chime?.ready, scenario.ready); stop(); assert.equal(c.timers.size, 0);
});

test('status transport failure closes previously ready capability and disposal cancels late result', async () => {
  const c = clock(); let calls = 0; let resolve: (value: any) => void = () => {};
  const s = createStatusStore('row', { ...c, legacyAtBoot: false, fetch: (async () => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ modules: { chime: { ready: true, enabled: true, phase: 'active' } } }) };
    if (calls === 2) throw new Error('offline');
    return await new Promise(r => resolve = r);
  }) as any });
  const stop = s.start(); await flush(); assert.equal(s.getSnapshot().modules.chime?.ready, true);
  c.next(); await flush(); assert.equal(s.getSnapshot().modules.chime, undefined);
  c.next(); await flush(); stop(); resolve({ ok: true, json: async () => ({ modules: { chime: { ready: true, enabled: true, phase: 'active' } } }) }); await flush();
  assert.equal(s.getSnapshot().modules.chime, undefined); assert.equal(c.timers.size, 0);
});
