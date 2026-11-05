import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindSection, createPageFormAdapter } from '../../client/forms.ts';
import type { ConfigForm, ConfigFormSnapshot, PathOperation } from '../../client/forms.ts';
import { createFieldEditor, createSettingsView } from '../../client/settings.ts';
import type { ModuleId } from '../../client/settings.ts';

function rootForm(value: unknown = { modules: {} }) {
  let snapshot: ConfigFormSnapshot = { status: 'ready', writable: true, revision: 7, value };
  const listeners = new Set<() => void>();
  const writes: { ops: readonly PathOperation[]; revision?: number }[] = [];
  let accept = true;
  let failure: Error | undefined;
  const form: ConfigForm = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async mutate(ops, revision) {
      writes.push({ ops, revision });
      if (failure) throw failure;
      if (!accept || revision !== snapshot.revision) return false;
      const value = structuredClone(snapshot.value) as Record<string, any>;
      for (const op of ops) {
        let target = value;
        for (const key of op.path.slice(0, -1)) target = target[key] ??= {};
        const key = op.path.at(-1)!;
        if (op.op === 'set') target[key] = op.value;
        else delete target[key];
      }
      update({ value, revision: snapshot.revision! + 1 });
      return true;
    },
  };
  function update(patch: Partial<ConfigFormSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  return { form, writes, update, listeners, refuse() { accept = false; }, fail(error: Error) { failure = error; } };
}

test('section forms cache identity and project accepted, base, and explicit user layers', () => {
  const root = rootForm({ modules: { context: { enabled: false, guidanceText: '' } }, metadata: { report: 'kept' } });
  root.update({ base: { modules: { context: { enabled: true } } }, user: { modules: { context: { enabled: false } } } });
  const path = ['modules', 'context'];
  const section = bindSection(root.form, path);
  path.push('do-not-mutate-prefix');
  assert.equal(section, bindSection(root.form, ['modules', 'context']));
  const first = section.getSnapshot();
  assert.equal(first, section.getSnapshot());
  assert.deepEqual(first.value, { enabled: false, guidanceText: '' });
  assert.deepEqual(first.base, { enabled: true });
  assert.deepEqual(first.user, { enabled: false });
  assert.equal(first.revision, 7);
  root.update({ revision: 8 });
  assert.notEqual(first, section.getSnapshot());
  assert.equal(section.getSnapshot().revision, 8);
  assert.equal(bindSection(root.form, ['missing']).getSnapshot().value, undefined);
});

test('section set/unset paths share the root revision and notifications, preserving falsy values', async () => {
  const root = rootForm();
  const section = bindSection(root.form, ['modules', 'retry']);
  let notifications = 0;
  const stop = section.subscribe(() => { notifications++; });
  const ops: PathOperation[] = [
    { op: 'set', path: ['enabled'], value: false },
    { op: 'set', path: ['errorCodes'], value: [] },
    { op: 'unset', path: ['providers'] },
  ];
  assert.equal(await section.mutate(ops, 7), true);
  assert.deepEqual(root.writes[0], { revision: 7, ops: [
    { op: 'set', path: ['modules', 'retry', 'enabled'], value: false },
    { op: 'set', path: ['modules', 'retry', 'errorCodes'], value: [] },
    { op: 'unset', path: ['modules', 'retry', 'providers'] },
  ] });
  assert.deepEqual(ops[0].path, ['enabled']);
  assert.equal(notifications, 1);
  stop(); root.update({ revision: 10 });
  assert.equal(notifications, 1);
  assert.equal(await section.mutate([{ op: 'set', path: ['enabled'], value: true }], 7), false);
  assert.equal(root.writes.length, 1);
});

test('nested binding prefixes once per level, and empty section paths retain root values', async () => {
  const root = rootForm();
  const modules = bindSection(root.form, ['modules']);
  const context = bindSection(modules, ['context']);
  await context.mutate([{ op: 'set', path: ['ptcTimeoutMs'], value: 0 }]);
  assert.deepEqual(root.writes[0].ops, [{ op: 'set', path: ['modules', 'context', 'ptcTimeoutMs'], value: 0 }]);
  assert.equal(bindSection(root.form, []).getSnapshot().value, root.form.getSnapshot().value);
});

test('read-only, loading, unavailable and unfenced sections never forward writes', async () => {
  for (const patch of [
    { writable: false }, { status: 'loading' as const }, { status: 'unavailable' as const }, { revision: undefined },
  ]) {
    const root = rootForm(); root.update(patch);
    assert.equal(await bindSection(root.form, ['modules', 'context']).mutate([{ op: 'unset', path: ['enabled'] }]), false);
    assert.equal(root.writes.length, 0);
  }
});

test('page adapter publishes only replacement snapshots, updates mutation endpoint, never invents revisions', async () => {
  const root = rootForm();
  const adapter = createPageFormAdapter({ state: root.form.getSnapshot(), mutate: root.form.mutate });
  const first = adapter.getSnapshot();
  assert.equal(adapter.getSnapshot(), first);
  let changes = 0;
  const stop = adapter.subscribe(() => { changes++; });
  let endpoint = 0;
  const mutate = async (_ops: readonly PathOperation[], revision?: number) => { endpoint++; assert.equal(revision, 7); return true; };
  adapter.update({ state: first, mutate });
  assert.equal(changes, 0);
  assert.equal(await adapter.mutate([{ op: 'set', path: ['x'], value: 0 }]), true);
  assert.equal(endpoint, 1);
  assert.equal(adapter.getSnapshot().revision, 7);
  root.update({ revision: 42 });
  adapter.update({ state: root.form.getSnapshot(), mutate: root.form.mutate });
  assert.equal(changes, 1);
  assert.equal(adapter.getSnapshot().revision, 42);
  assert.equal(await adapter.mutate([{ op: 'unset', path: ['x'] }], 7), false);
  stop(); root.update({ status: 'unavailable' });
  adapter.update({ state: root.form.getSnapshot(), mutate: root.form.mutate });
  assert.equal(changes, 1);
  assert.equal(await adapter.mutate([{ op: 'unset', path: ['x'] }]), false);
});

test('blank lists save explicit empty arrays, whereas Reset sends unset', async () => {
  const root = rootForm({ modules: { retry: { errorCodes: ['stream error'], providers: ['alpha'] } } });
  const editor = createFieldEditor(bindSection(root.form, ['modules', 'retry']), 'errorCodes');
  const stop = editor.start();
  editor.edit(' \n\n ');
  assert.equal(await editor.save(), true);
  assert.deepEqual(root.writes[0], { revision: 7, ops: [{ op: 'set', path: ['modules', 'retry', 'errorCodes'], value: [] }] });
  assert.equal(editor.getSnapshot().dirty, false);
  assert.equal(await editor.reset(), true);
  assert.deepEqual(root.writes[1].ops, [{ op: 'unset', path: ['modules', 'retry', 'errorCodes'] }]);
  stop(); assert.equal(root.listeners.size, 0);
});

test('a sibling edit invalidates a staged text revision without erasing the draft', async () => {
  const root = rootForm({ modules: { context: { guidanceText: 'old' }, retry: { enabled: true } } });
  const editor = createFieldEditor(bindSection(root.form, ['modules', 'context']), 'guidanceText');
  const stop = editor.start();
  editor.edit('my unsaved guidance');
  await bindSection(root.form, ['modules', 'retry']).mutate([{ op: 'set', path: ['enabled'], value: false }], 7);
  assert.equal(editor.getSnapshot().conflict, true);
  assert.equal(editor.getSnapshot().text, 'my unsaved guidance');
  assert.equal(editor.getSnapshot().revision, 7);
  assert.equal(await editor.save(), false);
  assert.equal(await editor.reset(), false);
  assert.equal(root.writes.length, 1);
  editor.discard();
  assert.equal(editor.getSnapshot().text, 'old');
  assert.equal(editor.getSnapshot().revision, 8);
  editor.edit('new'); assert.equal(await editor.save(), true);
  stop();
});

test('stale drafts fence writes even before subscription, and refusal retains draft', async () => {
  const root = rootForm({ modules: { retry: { providers: ['a'] } } });
  const editor = createFieldEditor(bindSection(root.form, ['modules', 'retry']), 'providers');
  editor.edit('b'); root.update({ revision: 9 });
  assert.equal(await editor.save(), false);
  assert.equal(root.writes.length, 0);
  editor.discard(); editor.edit('b'); root.refuse();
  assert.equal(await editor.save(), false);
  assert.equal(root.writes[0].revision, 9);
  assert.equal(editor.getSnapshot().text, 'b');
  assert.equal(editor.getSnapshot().dirty, true);
  assert.equal(editor.getSnapshot().conflict, true);
});

test('text editors refuse unavailable/read-only writes and preserve transport-failed drafts', async () => {
  const root = rootForm({ modules: { retry: { providers: [] } } });
  const editor = createFieldEditor(bindSection(root.form, ['modules', 'retry']), 'providers');
  const stop = editor.start(); editor.edit('route');
  root.update({ writable: false });
  assert.equal(await editor.save(), false); assert.equal(root.writes.length, 0);
  root.update({ writable: true, status: 'unavailable' });
  assert.equal(await editor.reset(), false); assert.equal(root.writes.length, 0);
  root.update({ status: 'ready' }); root.fail(new Error('offline'));
  assert.equal(await editor.save(), false);
  assert.equal(editor.getSnapshot().text, 'route');
  assert.equal(editor.getSnapshot().dirty, true);
  assert.match(editor.getSnapshot().error, /connection/);
  stop();
});

test('context durations render seconds and persist milliseconds, including zero and model overrides', async () => {
  const root = rootForm({ modules: { context: { retryDelayMs: 1500, ptcTimeoutMs: 0, ptcModelTimeouts: { 'p/m': 2500 } } } });
  const section = bindSection(root.form, ['modules', 'context']);
  const delay = createFieldEditor(section, 'retryDelayMs');
  const timeout = createFieldEditor(section, 'ptcTimeoutMs');
  const models = createFieldEditor(section, 'ptcModelTimeouts');
  const stops = [delay.start(), timeout.start(), models.start()];
  assert.equal(delay.getSnapshot().text, '1.5');
  assert.equal(models.getSnapshot().text, 'p/m = 2.5');
  delay.edit('0.125'); assert.equal(await delay.save(), true);
  timeout.edit('0'); assert.equal(await timeout.save(), true);
  models.edit('p/m = 1.234\nother/model = 2'); assert.equal(await models.save(), true);
  assert.deepEqual(root.writes.map(write => (write.ops[0] as any).value), [125, 0, { 'p/m': 1234, 'other/model': 2000 }]);
  models.edit(''); assert.equal(await models.save(), true);
  assert.deepEqual((root.writes.at(-1)!.ops[0] as any).value, {});
  stops.forEach(stop => stop());
});

test('text validation rejects unsafe durations, attempts and malformed model/list values without writes', async () => {
  const cases = [
    ['retryAttempts', '-1'], ['retryAttempts', '6'], ['retryAttempts', '0.5'],
    ['retryDelayMs', '61'], ['ptcTimeoutMs', 'Infinity'], ['ptcTimeoutMs', '1e20'], ['maxHoldMs', '1.2'],
    ['ptcModelTimeouts', 'missing-key = 1'], ['ptcModelTimeouts', 'p/m = 0'],
    ['ptcModelTimeouts', 'p/m = 1\np/m = 2'], ['providers', 'has space'], ['errorCodes', 'bad:code'],
    ['guidanceText', 'x'.repeat(8001)],
  ] as const;
  for (const [field, value] of cases) {
    const root = rootForm();
    const editor = createFieldEditor(bindSection(root.form, ['modules', 'context']), field);
    editor.edit(value); assert.equal(await editor.save(), false, field + ': ' + value.slice(0, 30));
    assert.equal(root.writes.length, 0); assert.notEqual(editor.getSnapshot().error, '');
  }
});

type Node = { type: string; props: Record<string, any>; children: any[] };
function renderer() {
  const cleanups: (() => void)[] = [];
  const React = {
    createElement(type: any, props: any, ...children: any[]): any {
      if (typeof type === 'function') return type(props ?? {});
      return { type, props: props ?? {}, children };
    },
    useState(initial: any) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect(effect: () => (() => void) | undefined) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot(); },
  };
  return { React, cleanup() { cleanups.reverse().forEach(fn => fn()); } };
}
function nodes(tree: any): Node[] {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.children ?? []).flatMap(nodes)];
}
function contents(tree: any): string {
  if (!tree || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return (tree.children ?? []).map(contents).join(' ');
}
const all: readonly ModuleId[] = ['context', 'retry', 'chime', 'goalWait'];
const descriptor = { rowId: 'dsh-toolbox', packageName: 'dsh-toolbox', moduleIds: all };

test('summary is hook-free and does not read either form source', () => {
  const React = new Proxy({ createElement: () => {} }, { get(target, key) {
    if (key === 'createElement') return target.createElement;
    throw new Error('summary accessed React hooks');
  } });
  const view = createSettingsView(React, descriptor);
  const props = { view: 'summary', get form(): never { throw new Error('read native form'); }, get configForm(): never { throw new Error('read shared form'); } };
  assert.match(view(props) as string, /Context.*retry.*chime.*Goal/i);
});

test('combined settings expose all original controls and exactly one custom chime enabled switch', async () => {
  const root = rootForm({ modules: { context: { enabled: true }, retry: { enabled: false }, chime: { enabled: true }, goalWait: { enabled: true } },
    metadata: { status: { modules: { context: { phase: 'saved/restart-required', ready: false, enabled: true, reason: 'reload host' } }, report: { migrated: true } } } });
  const render = renderer();
  let chimeForm: ConfigForm | undefined;
  function ChimeEditor({ configForm }: { configForm: ConfigForm }) {
    chimeForm = configForm;
    return render.React.createElement('input', { type: 'checkbox', 'data-field': 'enabled', 'data-custom-chime': true });
  }
  const view = createSettingsView(render.React, descriptor, ChimeEditor);
  const tree = view({ configForm: root.form });
  const sections = nodes(tree).filter(node => node.type === 'section');
  assert.deepEqual(sections.map(node => node.props['data-module']), all);
  const enabled = nodes(tree).filter(node => node.type === 'input' && node.props['data-field'] === 'enabled');
  assert.equal(enabled.length, 4);
  assert.equal(enabled[1].props.checked, false);
  assert.equal(chimeForm, bindSection(root.form, ['modules', 'chime']));
  const fields = new Set(nodes(tree).map(node => node.props['data-field']).filter(Boolean));
  for (const field of ['compactTool', 'statusTool', 'guidance', 'guidanceText', 'pressureContext', 'retryAttempts', 'retryDelayMs', 'ptcTimeoutMs', 'ptcModelTimeouts', 'errorCodes', 'providers', 'retryEmptyResponse', 'waitForJobs', 'waitForSubagents', 'maxHoldMs']) assert.equal(fields.has(field), true, field);
  assert.equal(fields.has('notifyAtRatio'), false);
  assert.match(contents(tree), /notifyAtRatio.*pressureStep.*YAML-only/);
  assert.match(contents(tree), /saved\/restart-required.*not ready.*reload host/);
  assert.match(contents(tree), /Migration report.*migrated/s);
  await enabled[1].props.onChange({ target: { checked: true } });
  assert.deepEqual(root.writes[0], { revision: 7, ops: [{ op: 'set', path: ['modules', 'retry', 'enabled'], value: true }] });
  assert.equal((root.form.getSnapshot().value as any).modules.context.enabled, true);
  render.cleanup();
});

test('split descriptors render only selected modules and page form takes precedence over fallback', async () => {
  for (const id of all) {
    const shared = rootForm(); const native = rootForm();
    const render = renderer();
    const view = createSettingsView(render.React, { rowId: 'split-' + id, packageName: 'split-' + id, moduleIds: [id] });
    const tree = view({ configForm: shared.form, form: { state: native.form.getSnapshot(), mutate: native.form.mutate } });
    assert.deepEqual(nodes(tree).filter(node => node.type === 'section').map(node => node.props['data-module']), [id]);
    const enabled = nodes(tree).find(node => node.type === 'input' && node.props['data-field'] === 'enabled')!;
    await enabled.props.onChange({ target: { checked: false } });
    assert.equal(shared.writes.length, 0);
    assert.deepEqual(native.writes[0].ops, [{ op: 'set', path: ['modules', id, 'enabled'], value: false }]);
    render.cleanup();
  }
});

test('read-only and unavailable views disable controls; handlers still cannot write if invoked', async () => {
  for (const patch of [{ writable: false }, { status: 'unavailable' as const }]) {
    const root = rootForm(); root.update(patch);
    const render = renderer();
    const tree = createSettingsView(render.React, descriptor)({ configForm: root.form });
    const inputs = nodes(tree).filter(node => node.type === 'input' || node.type === 'textarea');
    assert.ok(inputs.length > 10);
    assert.equal(inputs.every(node => node.props.disabled), true);
    for (const node of inputs.filter(node => node.props.type === 'checkbox')) await node.props.onChange({ target: { checked: false } });
    assert.equal(root.writes.length, 0);
    render.cleanup();
  }
});

test('status store overrides metadata and reports missing runtime status honestly', () => {
  const root = rootForm(); const render = renderer();
  const store = { getSnapshot: () => ({ modules: { retry: { phase: 'conflict', ready: false, enabled: false, reason: 'duplicate owner' } }, report: { recovered: false } }), subscribe: () => () => {} };
  const tree = createSettingsView(render.React, descriptor, undefined, store)({ configForm: root.form });
  assert.match(contents(tree), /conflict.*not ready.*disabled.*duplicate owner/);
  assert.match(contents(tree), /saved configuration alone does not confirm activation/);
  assert.match(contents(tree), /recovered/);
  render.cleanup();
});

test('package fallback preserves native form receivers and stable React store callbacks', () => {
  const listeners = new Set<() => void>();
  const native: ConfigForm & { state: ConfigFormSnapshot } = {
    state: { status: 'ready', writable: true, revision: 4, value: { modules: {} } },
    getSnapshot() { assert.equal(this, native); return this.state; },
    subscribe(listener) { assert.equal(this, native); listeners.add(listener); return () => { listeners.delete(listener); }; },
    async mutate() { assert.equal(this, native); return true; },
  };
  const render = renderer();
  const callbacks: { subscribe: Function; read: Function }[] = [];
  const cleanups: (() => void)[] = [];
  const React = {
    ...render.React,
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, read: () => unknown) {
      callbacks.push({ subscribe, read }); cleanups.push(subscribe(() => {})); return read();
    },
  };
  const view = createSettingsView(React, { rowId: 'native', packageName: 'native', moduleIds: [] });
  view({ view: 'page', configForm: native });
  view({ view: 'page', configForm: native });
  assert.equal(callbacks[0]!.subscribe, callbacks[2]!.subscribe);
  assert.equal(callbacks[0]!.read, callbacks[2]!.read);
  cleanups.forEach(cleanup => cleanup()); render.cleanup();
  assert.equal(listeners.size, 0);
});
