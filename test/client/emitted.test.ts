import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { Context } from '@deepseek-ai/cordis';

const distributions = [
  { packageName: 'dsh-toolbox', rowId: 'dsh-toolbox', moduleIds: ['context','retry','chime','goalWait'] },
  ...['context','retry','chime','goalWait'].map(id => ({ packageName: 'dsh-toolbox-' + (id === 'goalWait' ? 'goal-wait' : id), rowId: 'dsh-toolbox-' + (id === 'goalWait' ? 'goal-wait' : id), moduleIds: [id] })),
];

export async function emitted(descriptor: typeof distributions[number]) {
  const withChime = descriptor.moduleIds.includes('chime');
  const contents = 'import {createToolboxClient} from "./client/index.ts";\n' + (withChime ? 'import {createChimeAdapter} from "./client/chime.ts";\n' : '') + 'window.__ModuleLoader__.load({id:' + JSON.stringify(descriptor.packageName) + ',factory(require){return createToolboxClient(' + JSON.stringify(descriptor) + ', require("react")' + (withChime ? ',createChimeAdapter' : '') + ');}});';
  const result = await build({ stdin: { contents, resolveDir: new URL('../../', import.meta.url).pathname, sourcefile: 'generated-entry.ts', loader: 'ts' }, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022' });
  return result.outputFiles[0]!.text;
}

function load(source: string, legacy = false) {
  const entries: any[] = [];
  const timers = new Map<number, Function>(); let seq = 0;
  const events = new Map<string, Set<Function>>();
  const React: any = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props, children }), useState: (f: any) => [typeof f === 'function' ? f() : f, () => {}], useEffect() {}, useSyncExternalStore: (_s: any, read: any) => read() };
  const sandbox: any = {
    __ModuleLoader__: { load(entry: any) { entries.push(entry); } },
    __DSH_BOOT__: { entries: legacy ? [{ id: 'dsh-session-chime' }] : [] },
    addEventListener(name: string, fn: Function) { let set = events.get(name); if (!set) events.set(name, set = new Set()); set.add(fn); },
    removeEventListener(name: string, fn: Function) { events.get(name)?.delete(fn); },
    setTimeout(fn: Function, _delay: number) { timers.set(++seq, fn); return seq; }, clearTimeout(id: number) { timers.delete(id); },
    AbortController, Date, console,
    fetch: async () => ({ ok: true, json: async () => ({ modules: { chime: { phase: 'active', ready: true, enabled: true } } }) }),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  return { entries, sandbox, timers, events, materialize(entry: any) { return entry.factory((name: string) => { assert.equal(name, 'react'); return React; }); } };
}

for (const descriptor of distributions) test('emitted native client loads ' + descriptor.packageName, async () => {
  const source = await emitted(descriptor);
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
  assert.equal(source.includes('data:audio/wav;base64,'), descriptor.moduleIds.includes('chime'));
  const h = load(source);
  assert.equal(h.entries.length, 1); assert.equal(h.entries[0].id, descriptor.packageName);
  const plugin = h.materialize(h.entries[0]);
  assert.equal(Object.prototype.toString.call(plugin), '[object Module]');
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'configForms']);
  const ctx = new Context();
  const register = (name: string, value: unknown) => { ctx.provide(name); ctx.set(name, value); };
  let snapshot: any = { status: 'ready', writable: true, revision: 0, value: { modules: Object.fromEntries(descriptor.moduleIds.map(id => [id, { enabled: true }])) } };
  const listeners = new Set<() => void>();
  const form = { getSnapshot: () => snapshot, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }, mutate: async () => true };
  const slots = new Map<string, any>();
  register('configForms', { get: () => form, whileServed(_rows: any, callback: Function) { return callback(); } });
  register('slots', { inject(_name: any, callback: Function) { return callback(); }, register(options: any, view: any) { const key = options.name + ':' + (options.key ?? options.id); slots.set(key, { options, view }); return () => slots.delete(key); } });
  const fiber = ctx.plugin(plugin); await fiber;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.ok(slots.has('plugins.row.config:' + descriptor.packageName + '#' + descriptor.rowId));
  assert.ok(slots.has('plugins.bundle.config:' + descriptor.packageName));
  assert.equal(slots.has('sidebar.footer.action:session-chime-rest'), false, 'missing sessions must not block configuration, nor start runtime');
  if (descriptor.moduleIds.includes('chime')) {
    register('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe(fn: Function) { return () => {}; } } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(slots.has('sidebar.footer.action:session-chime-rest'), true);
    assert.equal(h.events.get('pointerdown')?.size, 1);
    snapshot = { ...snapshot, revision: 1, value: { modules: { ...snapshot.value.modules, chime: { enabled: false } } } };
    for (const listener of listeners) listener();
    assert.equal(slots.has('sidebar.footer.action:session-chime-rest'), false);
    assert.equal(slots.has('shell.overlay:session-chime-banner'), false);
    assert.equal(h.events.get('pointerdown')?.size, 0);
    assert.ok(slots.has('plugins.bundle.config:' + descriptor.packageName));
  }
  await fiber.dispose(); await ctx.fiber.dispose();
  assert.equal(slots.size, 0); assert.equal(listeners.size, 0); assert.equal(h.timers.size, 0);
});

test('all emitted distribution scripts concatenate without globals or old registration ids', async () => {
  const sources = await Promise.all(distributions.map(emitted));
  const h = load(sources.join('\n'));
  assert.deepEqual(h.entries.map(entry => entry.id), distributions.map(d => d.packageName));
  for (const entry of h.entries) assert.equal(typeof h.materialize(entry).apply, 'function');
});
