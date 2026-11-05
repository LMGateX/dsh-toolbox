import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { inspectMigration, type NativeDiscoveryFacade } from '../../src/migration/discovery.ts';
import type { Distribution, LoaderEntry, NativeMigrationHost, Values } from '../../src/migration/types.ts';

const target: Distribution = { rowId: 'dsh-toolbox', packageName: 'dsh-toolbox', moduleIds: ['context', 'retry', 'chime', 'goalWait'] };
const targetRow = { id: target.rowId, name: 'dsh-toolbox', config: { modules: {} } };
// A deliberately small JSON-only native facade. Real native YAML coverage is separate below.
const facade: NativeDiscoveryFacade = {
  resolveBundleDir(_bin, name, anchor, profile) {
    for (const base of [dirname(anchor), profile]) {
      const dir = join(base, 'node_modules', name);
      if (existsSync(join(dir, 'package.json'))) return dir;
    }
    throw new Error('fixture package not installed: ' + name);
  },
  loadOverlayPatches(_bin, file) { const value = JSON.parse(readFileSync(file, 'utf8')); if (!Array.isArray(value)) throw new Error('patch list required'); return value; },
  composeEntries(layers) {
    const rows: Values[] = [];
    const index = new Map<string, Values>();
    const add = (entries: Values[]) => { for (const entry of entries) { if (typeof entry.id === 'string') index.set(entry.id, entry); if (entry.group && Array.isArray(entry.config)) add(entry.config); } };
    for (const patch of structuredClone(layers.flat()) as Values[]) {
      if (Array.isArray(patch.insert)) {
        const parent = patch.id ? index.get(String(patch.id)) : undefined;
        if (patch.id && !parent?.group) continue;
        if (parent) { if (!Array.isArray(parent.config)) parent.config = []; (parent.config as Values[]).push(...patch.insert); }
        else rows.push(...patch.insert);
        add(patch.insert);
      } else {
        const row = index.get(String(patch.id));
        if (!row || patch.name && patch.name !== row.name) continue;
        for (const [key, value] of Object.entries(patch)) if (key !== 'id' && key !== 'name') row[key] = value;
      }
    }
    return rows;
  },
};
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'toolbox-discovery-'));
  const home = join(root, 'HOME');
  const dshHome = join(home, 'DSH_HOME');
  const dir = join(dshHome, 'profiles', 'explicit-test-profile');
  const installAnchor = join(root, 'installation', 'package.json');
  await mkdir(dir, { recursive: true });
  await mkdir(dirname(installAnchor), { recursive: true });
  await writeFile(installAnchor, '{}');
  const previous = { HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME };
  process.env.HOME = home; process.env.DSH_HOME = dshHome;
  t.after(async () => {
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    if (previous.DSH_HOME === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.DSH_HOME;
    await rm(root, { recursive: true, force: true });
  });
  const manifest: Values = { name: 'disposable-profile', dependencies: {}, dsh: { profile: { bundles: [] } } };
  const patchPath = join(dir, 'cordis.patch.yml');
  const host: NativeMigrationHost = { profileContext: { dir, patchPath, installAnchor, home: dshHome, overlays: [] }, nativeMigration: facade, loader: { entries: () => [] } };
  const save = async () => writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const patch = async (patches: unknown[]) => writeFile(patchPath, JSON.stringify(patches, null, 2) + '\n');
  const pkg = async (name: string, version: string, patches: unknown[] = [], options: { identity?: string; installed?: boolean; selected?: boolean; installation?: boolean } = {}) => {
    const base = options.installation ? dirname(installAnchor) : dir;
    const path = join(base, 'node_modules', name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: options.identity ?? name, version, type: 'module', exports: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    await writeFile(join(path, 'index.js'), 'throw new Error("discovery must never import legacy plugins");');
    await writeFile(join(path, 'cordis.patch.yml'), JSON.stringify(patches));
    if (options.installed !== false) (manifest.dependencies as Values)[name] = version;
    if (options.selected) ((manifest.dsh as any).profile.bundles as string[]).push(name);
    await save();
    return path;
  };
  await save();
  await patch([{ insert: [targetRow] }]);
  return { root, home, dshHome, dir, host, manifest, save, patch, pkg };
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) Object.assign(values, await snapshot(path));
    else if (entry.isFile()) values[path] = await readFile(path, 'utf8');
  }
  return values;
}

test('composes raw inherited config; preserves groups, disabled rows, exact text and profile scope', async t => {
  const f = await fixture(t);
  await f.pkg('dsh-stream-retry', '0.1.9', [{ insert: [{ id: 'disabled-group', name: 'cordis:group', group: true, disabled: true, config: [{ id: 'my-retry', name: 'dsh-stream-retry', config: { providers: ['old'], retryEmptyResponse: true } }] }] }], { selected: true });
  await f.pkg('dsh-session-chime', '0.6.0', [{ insert: [{ id: 'session-chime', name: 'dsh-session-chime', config: { volume: 0, soundDone: '', banner: false } }] }], { selected: true });
  await f.patch([{ insert: [targetRow] }, { id: 'my-retry', config: { providers: [], retryEmptyResponse: false } }]);
  const other = join(f.dshHome, 'profiles', 'never-read'); await mkdir(other); await writeFile(join(other, 'package.json'), 'malformed!');
  const before = await snapshot(f.root);
  const result = await inspectMigration(f.host, target);
  assert.deepEqual(await snapshot(f.root), before);
  assert.equal(result.patchText, before[f.host.profileContext.patchPath]);
  assert.equal(result.manifestText, before[join(f.dir, 'package.json')]);
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources[0].effective, { providers: [], retryEmptyResponse: false });
  assert.equal(result.sources[0].disabled, true);
  assert.equal(result.sources[0].bundleSelected, true);
  assert.deepEqual(result.sources[1].effective, { volume: 0, soundDone: '', banner: false });
  assert.equal(Object.hasOwn(result.sources[1].effective, 'debounceMs'), false, 'defaults belong to planner');
  assert.deepEqual(result.problems, []);
});

test('profile-only explicit target fields exclude bundle defaults and higher layers', async t => {
  const f = await fixture(t);
  await f.pkg('dsh-toolbox', '0.1.0', [{ insert: [{ ...targetRow, config: { modules: { retry: { enabled: true, providers: ['bundle'] }, context: { enabled: true } } } }] }], { selected: true });
  await f.patch([{ id: target.rowId, config: { modules: { retry: { enabled: false, providers: [] } } } }]);
  await writeFile(join(f.dshHome, 'cordis.patch.yml'), JSON.stringify([{ id: target.rowId, config: { modules: { retry: { providers: ['home'] } } } }]));
  const result = await inspectMigration(f.host, target);
  assert.deepEqual(result.explicit, { retry: { enabled: false, providers: [] } });
  assert.match(result.moduleProblems?.retry?.join(';') ?? '', /higher-priority/);
});

test('bundle -> profile -> HOME -> launcher order and revision include every layer/version', async t => {
  const f = await fixture(t);
  const packageDir = await f.pkg('dsh-stream-retry', '0.1.9', [{ insert: [{ id: 'stream-retry', name: 'dsh-stream-retry', config: { providers: ['bundle'] } }] }], { selected: true });
  await f.patch([{ insert: [targetRow] }, { id: 'stream-retry', config: { providers: ['profile'] } }]);
  const homePatch = join(f.dshHome, 'cordis.patch.yml');
  await writeFile(homePatch, JSON.stringify([{ id: 'stream-retry', config: { providers: ['home'] } }]));
  f.host.profileContext.overlays = [{ id: 'stream-retry', config: { providers: ['launcher'] } }];
  const first = await inspectMigration(f.host, target);
  assert.deepEqual(first.sources[0].effective, { providers: ['launcher'] });
  assert.match(first.sources[0].problem ?? '', /higher-priority/);
  const stable = await inspectMigration(f.host, target); assert.equal(first.revision, stable.revision);
  await writeFile(homePatch, (await readFile(homePatch, 'utf8')) + '\n');
  const second = await inspectMigration(f.host, target); assert.notEqual(first.revision, second.revision);
  const path = join(packageDir, 'package.json'); const pkg = JSON.parse(await readFile(path, 'utf8')); pkg.version = '0.1.99'; await writeFile(path, JSON.stringify(pkg));
  const third = await inspectMigration(f.host, target); assert.notEqual(second.revision, third.revision); assert.match(third.sources[0].problem ?? '', /unsupported legacy version/);
  f.host.profileContext.overlays = []; const fourth = await inspectMigration(f.host, target); assert.notEqual(third.revision, fourth.revision);
});

test('installed but deselected packages migrate disabled raw overrides; row ids alone never identify packages', async t => {
  const f = await fixture(t);
  await f.pkg('dsh-stream-retry', '0.1.9', [{ insert: [{ id: 'stream-retry', name: 'dsh-stream-retry', config: { providers: ['not-selected'] } }] }]);
  await f.pkg('alias-for-chime', '0.6.0', [], { identity: 'dsh-session-chime' });
  await f.pkg('unrelated', '1.0.0');
  await f.patch([{ insert: [targetRow, { id: 'dsh-tool-compact-context', name: 'unrelated' }] }, { id: 'stream-retry', config: { providers: [], retryEmptyResponse: false } }, { id: 'session-chime', config: { volume: 0 } }]);
  const result = await inspectMigration(f.host, target);
  assert.equal(result.legacyMode, true); assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources.map(source => [source.moduleId, source.disabled, source.bundleSelected]), [['retry', true, false], ['chime', true, false]]);
  assert.deepEqual(result.sources[0].effective, { providers: [], retryEmptyResponse: false });
  assert.deepEqual(result.sources[1].effective, { volume: 0 });
});

test('dynamic expressions, plural instances and custom startup ownership fail closed locally without evaluating getters', async t => {
  const f = await fixture(t);
  await f.pkg('dsh-stream-retry', '0.1.9');
  await f.pkg('dsh-goal-wait-gate', '0.3.0');
  const row = { id: 'first', name: 'dsh-stream-retry', disabled: { __jsExpr: 'throw new Error("never evaluate")' }, config: { providers: [] } };
  await f.patch([{ insert: [targetRow, row, { ...row, id: 'second', disabled: false }, { id: 'gate', name: 'dsh-goal-wait-gate', config: {} }] }]);
  const entry = { id: 'first', options: { id: 'first', name: 'dsh-stream-retry' }, fiber: { state: 2 }, get disabled(): boolean { throw new Error('getter was evaluated'); } } satisfies LoaderEntry;
  f.host.loader.entries = () => [entry]; f.host.startupOwner = 'experimental-pinned-driver';
  const result = await inspectMigration(f.host, target);
  assert.match(result.sources[0].problem ?? '', /dynamic.*multiple legacy instances/);
  assert.equal(result.sources[0].active, true);
  assert.match(result.moduleProblems?.goalWait?.join(';') ?? '', /custom startup/);
  assert.equal(result.moduleProblems?.context, undefined); assert.deepEqual(result.problems, []);
});

test('distinct split owners coexist while duplicate module peers are detected', async t => {
  const f = await fixture(t);
  await f.pkg('dsh-toolbox-context', '0.1.0'); await f.pkg('dsh-toolbox-retry', '0.1.0'); await f.pkg('dsh-toolbox-chime', '0.1.0');
  await f.patch([{ insert: [{ id: 'context-target', name: 'dsh-toolbox-context', config: { modules: {} } }, { id: 'retry-peer', name: 'dsh-toolbox-retry', config: { modules: {} } }, { id: 'chime-peer', name: 'dsh-toolbox-chime', config: { modules: {} } }] }]);
  const split: Distribution = { rowId: 'context-target', packageName: 'dsh-toolbox-context', moduleIds: ['context'] };
  const first = await inspectMigration(f.host, split); assert.equal(first.peers.context, undefined); assert.deepEqual(first.peers.retry, ['retry-peer']);
  await f.patch([{ insert: [{ id: 'context-target', name: 'dsh-toolbox-context' }, { id: 'duplicate-context', name: 'dsh-toolbox-context' }] }]);
  const second = await inspectMigration(f.host, split); assert.deepEqual(second.peers.context, ['duplicate-context']);
});

test('canonical profile identity survives symlinks and absent target is diagnosed', async t => {
  const f = await fixture(t);
  const first = await inspectMigration(f.host, target);
  const alias = join(f.root, 'profile-alias'); await symlink(f.dir, alias, 'dir');
  f.host.profileContext.dir = alias;
  const second = await inspectMigration(f.host, target); assert.equal(first.profileId, second.profileId);
  await f.patch([]); const third = await inspectMigration(f.host, target); assert.match(third.moduleProblems?.retry?.join(';') ?? '', /target row is absent/);
});

test('all four verified packages are found and installation-native version resolution wins', async t => {
  const f = await fixture(t);
  const items = [
    ['dsh-tool-compact-context', '0.4.7', 'context'], ['dsh-stream-retry', '0.1.9', 'retry'],
    ['dsh-session-chime', '0.6.0', 'chime'], ['dsh-goal-wait-gate', '0.3.0', 'goalWait'],
  ] as const;
  for (const [name, version] of items) await f.pkg(name, version, [{ insert: [{ id: name, name, config: {} }] }], { selected: true });
  await f.pkg('dsh-stream-retry', '0.1.8-unsupported', [], { installation: true, installed: false });
  const result = await inspectMigration(f.host, target);
  assert.deepEqual(result.sources.map(source => source.moduleId).sort(), items.map(item => item[2]).sort());
  const retry = result.sources.find(source => source.moduleId === 'retry')!;
  assert.equal(retry.version, '0.1.8-unsupported');
  assert.match(retry.problem ?? '', /unsupported legacy version/);
  assert.equal(result.sources[0].problem, undefined);
});

test('name assertions do not create explicit target fields and foreign target identities fail closed', async t => {
  const f = await fixture(t);
  await f.patch([{ insert: [targetRow] }, { id: target.rowId, name: 'not-the-toolbox', config: { modules: { retry: { enabled: false } } } }]);
  const first = await inspectMigration(f.host, target);
  assert.deepEqual(first.explicit, {});
  await f.pkg('foreign-package', '1.0.0');
  await f.patch([{ insert: [{ id: target.rowId, name: 'foreign-package' }] }]);
  const second = await inspectMigration(f.host, target);
  assert.match(second.moduleProblems?.retry?.join(';') ?? '', /package identity/);
});

test('verified npm aliases retain actual bundle/module identities and startup subpaths are unsupported', async t => {
  const f = await fixture(t);
  await f.pkg('renamed-chime', '0.6.0', [{ insert: [{ id: 'custom-chime', name: 'renamed-chime', config: { volume: 0 } }] }], { identity: 'dsh-session-chime', selected: true });
  await f.pkg('dsh-goal-wait-gate', '0.3.0');
  await f.patch([{ insert: [targetRow, { id: 'custom-startup', name: 'dsh-goal-wait-gate/startup', config: {} }] }]);
  const result = await inspectMigration(f.host, target);
  const chime = result.sources.find(source => source.moduleId === 'chime')!;
  assert.equal(chime.packageName, 'dsh-session-chime'); assert.equal(chime.moduleName, 'renamed-chime'); assert.equal(chime.bundleName, 'renamed-chime');
  const gate = result.sources.find(source => source.moduleId === 'goalWait')!;
  assert.match(gate.problem ?? '', /custom startup entrypoint/);
});

test('malformed input fails without filesystem writes', async t => {
  const f = await fixture(t); await writeFile(f.host.profileContext.patchPath, 'not json');
  const before = await snapshot(f.root); await assert.rejects(inspectMigration(f.host, target)); assert.deepEqual(await snapshot(f.root), before);
});

test('native helper resolves only from explicit installation; retired bundles and !!js remain read-only', async t => {
  const f = await fixture(t);
  f.host.profileContext.installAnchor = process.env.DSH_TEST_INSTALL_ANCHOR ?? createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json');
  delete f.host.nativeMigration;
  await f.pkg('dsh-session-chime', '0.6.0', [{ insert: [{ id: 'session-chime', name: 'dsh-session-chime', config: { volume: 0 } }] }], { selected: true });
  await writeFile(f.host.profileContext.patchPath, `- insert:
    - id: dsh-toolbox
      name: dsh-toolbox
- id: session-chime
  disabled: !!js '(() => { throw new Error("MUST NOT RUN") })()'
`);
  await chmod(join(f.dir, 'package.json'), 0o400); await chmod(f.host.profileContext.patchPath, 0o400);
  const before = await snapshot(f.root);
  const result = await inspectMigration(f.host, target);
  assert.equal(result.sources[0].rowId, 'session-chime'); assert.match(result.sources[0].problem ?? '', /dynamic/);
  assert.equal(result.sources[0].version, '0.6.0'); assert.deepEqual(await snapshot(f.root), before);
  const req = createRequire(f.host.profileContext.installAnchor);
  assert.ok(req.resolve('@deepseek-ai/dsh-app-boot'));
});
