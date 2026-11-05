import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parseDocument } from 'yaml';
import { rollbackMigration } from '../../src/migration/engine.ts';
import { profilePaths } from '../../src/migration/storage.ts';
import type { Distribution, LoaderEntry, ModuleId, NativeMigrationHost } from '../../src/migration/types.ts';

const anchor = process.env.DSH_TEST_INSTALL_ANCHOR ?? createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json');
const target: Distribution = { rowId: 'dsh-toolbox', packageName: 'dsh-toolbox', moduleIds: ['context', 'retry', 'chime', 'goalWait'] };
const packages = { retry: ['dsh-stream-retry', '0.1.9', 'stream-retry'], context: ['dsh-tool-compact-context', '0.4.7', 'dsh-tool-compact-context'] } as const;
async function fixture(t: TestContext, modules: ('context' | 'retry')[] = ['retry']) {
  const root = await mkdtemp(join(tmpdir(), 'toolbox-rollback-ownership-'));
  const home = join(root, 'HOME'), dshHome = join(home, 'DSH_HOME'), dir = join(dshHome, 'profiles', 'rollback-proof');
  await mkdir(dir, { recursive: true });
  const oldHome = process.env.HOME, oldDsh = process.env.DSH_HOME;
  process.env.HOME = home; process.env.DSH_HOME = dshHome;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldDsh;
    assert.ok(root.startsWith(join(tmpdir(), 'toolbox-rollback-ownership-')));
    await rm(root, { recursive: true, force: true });
  });
  const entries: LoaderEntry[] = [];
  const host: NativeMigrationHost = { profileContext: { dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, home: dshHome, overlays: [] }, loader: { entries: () => entries } };
  const pkg = async (name: string, version: string, row: object) => {
    const path = join(dir, 'node_modules', name); await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, version, type: 'module', exports: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    await writeFile(join(path, 'cordis.patch.yml'), JSON.stringify([{ insert: [row] }]));
    await writeFile(join(path, 'index.js'), 'throw new Error("migration must not import legacy feature code");');
  };
  await pkg('dsh-toolbox', '0.1.0', { id: 'dsh-toolbox', name: 'dsh-toolbox', config: { modules: {} } });
  for (const id of modules) { const [name, version, rowId] = packages[id]; await pkg(name, version, { id: rowId, name, config: {} }); }
  const names = modules.map(id => packages[id][0]);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(['dsh-toolbox', ...names].map(name => [name, '*'])), dsh: { profile: { bundles: ['dsh-toolbox', ...names] } } }));
  await writeFile(host.profileContext.patchPath, '[]\n');
  const engine = new URL('../../src/migration/engine.ts', import.meta.url).href;
  const script = 'import {runMigration,rollbackMigration} from ' + JSON.stringify(engine) + ';const target=' + JSON.stringify(target) + ';const host={profileContext:' + JSON.stringify(host.profileContext) + ',loader:{entries:()=>[]}};const result=await runMigration(host,target);await rollbackMigration(host,target,{operationId:result.operationId,modules:' + JSON.stringify(modules) + '});console.log(JSON.stringify(result));';
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env } });
  assert.equal(child.status, 0, child.stderr);
  const operationId = JSON.parse(child.stdout).operationId as string;
  const manifest = async () => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const addPeer = async (id: 'context' | 'retry') => {
    const name = 'dsh-toolbox-' + id;
    await pkg(name, '0.1.0', { id: 'peer-' + id, name, config: { modules: {} } });
    const value = await manifest(); value.dependencies[name] = '*'; value.dsh.profile.bundles.push(name); await writeFile(join(dir, 'package.json'), JSON.stringify(value));
  };
  const assertBlocked = async (id: 'context' | 'retry') => {
    const value = await manifest(); assert.equal(value.dsh.profile.bundles.includes(packages[id][0]), false, 'legacy bundle stays deselected');
    const text = await readFile(host.profileContext.patchPath, 'utf8');
    assert.ok(text.includes('dsh-toolbox-migration:' + operationId + ':' + id), 'owned legacy disable marker retained');
    const doc = parseDocument(text).toJS();
    const config = doc.findLast((row: any) => row.id === target.rowId && row.config)?.config;
    assert.equal(config.modules[id].enabled, false, 'new module remains disabled');
  };
  return { root, dir, host, entries, pkg, operationId, manifest, addPeer, assertBlocked };
}

test('rollback refuses a new selected peer after the migration host exited', async t => {
  const f = await fixture(t); await f.addPeer('retry');
  const report = await rollbackMigration(f.host, target, { operationId: f.operationId, modules: ['retry'] });
  assert.equal(report.modules.retry?.phase, 'conflict'); assert.match(report.modules.retry?.reason ?? '', /peer|distribution|owner/);
  await f.assertBlocked('retry');
});

test('rollback sees live peer inventory even when its selected profile row disappeared', async t => {
  const f = await fixture(t);
  f.entries.push({ id: 'include:gone-peer', options: { id: 'gone-peer', name: 'dsh-toolbox-retry' }, fiber: { state: 2 } });
  const report = await rollbackMigration(f.host, target, { operationId: f.operationId, modules: ['retry'] });
  assert.equal(report.modules.retry?.phase, 'conflict'); await f.assertBlocked('retry');
});

test('a conflicting peer blocks only its module while a disjoint requested source restores', async t => {
  const f = await fixture(t, ['context', 'retry']); await f.addPeer('retry');
  const report = await rollbackMigration(f.host, target, { operationId: f.operationId, modules: ['retry', 'context'] });
  assert.equal(report.modules.retry?.phase, 'conflict'); await f.assertBlocked('retry');
  assert.equal(report.modules.context?.phase, 'rolled-back');
  assert.ok((await f.manifest()).dsh.profile.bundles.includes(packages.context[0]));
});

for (const mutation of ['version', 'bundle config', 'profile config', 'HOME expression', 'launcher override', 'package identity', 'global ambiguity']) test('rollback retains owned disable switches after changed ' + mutation, async t => {
  const f = await fixture(t), path = join(f.dir, 'node_modules', packages.retry[0]);
  if (mutation === 'version' || mutation === 'package identity') {
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    if (mutation === 'version') manifest.version = '0.1.8'; else manifest.name = 'unrelated-new-source';
    await writeFile(join(path, 'package.json'), JSON.stringify(manifest));
  }
  if (mutation === 'bundle config') await writeFile(join(path, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'stream-retry', name: 'dsh-stream-retry', config: { providers: ['changed'] } }] }]));
  if (mutation === 'profile config') { const doc = parseDocument(await readFile(f.host.profileContext.patchPath, 'utf8')); doc.add({ id: 'stream-retry', config: { providers: ['changed'] } }); await writeFile(f.host.profileContext.patchPath, String(doc)); }
  if (mutation === 'HOME expression') await writeFile(join(f.host.profileContext.home, 'cordis.patch.yml'), '- id: stream-retry\n  disabled: !!js "false"\n');
  if (mutation === 'launcher override') f.host.profileContext.overlays = [{ id: 'stream-retry', disabled: false }];
  if (mutation === 'global ambiguity') { const manifest = await f.manifest(); manifest.dsh.profile.bundles.push('unresolvable-selected-owner'); await writeFile(join(f.dir, 'package.json'), JSON.stringify(manifest)); }
  const report = await rollbackMigration(f.host, target, { operationId: f.operationId, modules: ['retry'] });
  assert.equal(report.modules.retry?.phase, 'conflict'); assert.ok(report.modules.retry.reason); await f.assertBlocked('retry');
});

async function interruptedRestore(f: Awaited<ReturnType<typeof fixture>>, modules: ('context' | 'retry')[], patchAlreadyWritten: boolean) {
  const paths = await profilePaths(f.host, target.rowId), journal = JSON.parse(await readFile(paths.journal, 'utf8'));
  const patchBefore = await readFile(paths.patch, 'utf8'), manifestBefore = await readFile(paths.manifest, 'utf8');
  const doc = parseDocument(patchBefore), manifest = JSON.parse(manifestBefore);
  for (const id of modules) {
    const items = (doc.contents as any).items as { commentBefore?: string }[];
    const index = items.findIndex(row => row.commentBefore === 'dsh-toolbox-migration:' + f.operationId + ':' + id);
    assert.ok(index >= 0); doc.deleteIn([index]);
    manifest.dsh.profile.bundles.push(packages[id][0]); journal.rollback[id].done = true;
  }
  journal.recoveryWrites = { patchBefore, patchAfter: String(doc), manifestBefore, manifestAfter: JSON.stringify(manifest), restoreModules: modules };
  await writeFile(paths.journal, JSON.stringify(journal));
  if (patchAlreadyWritten) await writeFile(paths.patch, String(doc));
}

for (const partial of [false, true]) test('interrupted restoration replay revalidates new peers and resumes disjoint modules; patch written=' + partial, async t => {
  const f = await fixture(t, ['context', 'retry']);
  await interruptedRestore(f, ['retry', 'context'], partial); await f.addPeer('retry');
  const report = await rollbackMigration(f.host, target, { operationId: f.operationId, modules: ['retry', 'context'] });
  assert.equal(report.modules.retry?.phase, 'conflict'); await f.assertBlocked('retry');
  assert.equal(report.modules.context?.phase, 'rolled-back');
  const names = (await f.manifest()).dsh.profile.bundles;
  assert.ok(names.includes(packages.context[0])); assert.ok(names.includes('dsh-toolbox-retry'));
});

for (const enabled of [true, false]) test('unselected peer journal tracks real host PID, not mere process existence; enabled=' + enabled, { timeout: 15000 }, async t => {
  const f = await fixture(t), name = 'dsh-toolbox-retry';
  await f.pkg(name, '0.1.0', { id: name, name, config: { modules: {} } });
  const manifest = await f.manifest(); manifest.dependencies[name] = '*'; manifest.dsh.profile.bundles.push(name);
  await writeFile(join(f.dir, 'package.json'), JSON.stringify(manifest));
  const doc = parseDocument(await readFile(f.host.profileContext.patchPath, 'utf8'));
  doc.add({ id: name, config: { modules: { retry: { enabled } } } }); await writeFile(f.host.profileContext.patchPath, String(doc));
  const engine = new URL('../../src/migration/engine.ts', import.meta.url).href;
  const script = 'import {runMigration} from ' + JSON.stringify(engine) + ';const target={rowId:' + JSON.stringify(name) + ',packageName:' + JSON.stringify(name) + ',moduleIds:["retry"]};const host={profileContext:' + JSON.stringify(f.host.profileContext) + ',loader:{entries:()=>[{id:target.rowId,options:{id:target.rowId,name:target.packageName},fiber:{state:2}}]},moduleConfig:()=>({enabled:' + enabled + '})};await runMigration(host,target);process.send({pid:process.pid});process.on("message",()=>process.exit(0));';
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); });
  const exited = new Promise<void>((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error('peer host exited: ' + stderr))); child.once('error', reject); });
  try {
    const message = await new Promise<{ pid: number }>((resolve, reject) => { child.once('message', value => resolve(value as { pid: number })); child.once('error', reject); child.once('exit', () => reject(new Error('peer never registered: ' + stderr))); });
    const peerPaths = await profilePaths(f.host, name), peerJournal = JSON.parse(await readFile(peerPaths.journal, 'utf8'));
    assert.equal((peerJournal.owners.retry ?? []).some((owner: string) => owner.startsWith(message.pid + ':')), enabled);
    const selected = await f.manifest(); selected.dsh.profile.bundles = selected.dsh.profile.bundles.filter((value: string) => value !== name);
    await writeFile(join(f.dir, 'package.json'), JSON.stringify(selected));
    const report = await rollbackMigration(f.host, target, { operationId: f.operationId, modules: ['retry'] });
    assert.equal(report.modules.retry?.phase, enabled ? 'conflict' : 'rolled-back');
    if (enabled) {
      await f.assertBlocked('retry'); child.send('stop'); await exited;
      assert.equal((await rollbackMigration(f.host, target, { operationId: f.operationId, modules: ['retry'] })).modules.retry?.phase, 'rolled-back');
    }
  } finally {
    if (child.exitCode === null) child.send('stop');
    await exited;
  }
});

test('older saved journals without per-module source provenance fail closed rather than guessing', async t => {
  const f = await fixture(t), paths = await profilePaths(f.host, target.rowId);
  const journal = JSON.parse(await readFile(paths.journal, 'utf8')); delete journal.rollbackEvidence;
  await writeFile(paths.journal, JSON.stringify(journal));
  const report = await rollbackMigration(f.host, target, { operationId: f.operationId, modules: ['retry'] });
  assert.equal(report.modules.retry?.phase, 'conflict'); assert.match(report.modules.retry?.reason ?? '', /provenance/);
  await f.assertBlocked('retry');
});

test('a cleared peer conflict can restore later without replaying or overwriting unrelated edits', async t => {
  const f = await fixture(t); await f.addPeer('retry');
  assert.equal((await rollbackMigration(f.host, target, { operationId: f.operationId, modules: ['retry'] })).modules.retry?.phase, 'conflict');
  const manifest = await f.manifest(); manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => name !== 'dsh-toolbox-retry');
  manifest.description = 'unrelated later profile metadata'; await writeFile(join(f.dir, 'package.json'), JSON.stringify(manifest));
  const report = await rollbackMigration(f.host, target, { operationId: f.operationId, modules: ['retry'] });
  assert.equal(report.modules.retry?.phase, 'rolled-back');
  assert.equal((await f.manifest()).description, 'unrelated later profile metadata');
});
