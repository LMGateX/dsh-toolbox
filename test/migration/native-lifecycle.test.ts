import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { rollbackMigration } from '../../src/migration/engine.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { inspectMigration, startAutomaticMigration } from '../../src/migration/index.ts';
import type { Distribution, MigrationController, NativeMigrationHost, Values } from '../../src/migration/types.ts';

const target: Distribution = { rowId: 'dsh-toolbox', packageName: 'dsh-toolbox', moduleIds: ['retry'] };
const require = createRequire(import.meta.url);
const anchor = process.env.DSH_TEST_INSTALL_ANCHOR ?? require.resolve('@deepseek-ai/dsh/package.json');
const hostRequire = createRequire(anchor);
const load = (name: string) => import(pathToFileURL(hostRequire.resolve(name)).href);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'toolbox-native-lifecycle-'));
  const home = join(root, 'HOME');
  const dshHome = join(home, 'DSH_HOME');
  const dir = join(dshHome, 'profiles', 'native-proof');
  await mkdir(dir, { recursive: true });
  const oldHome = process.env.HOME, oldDsh = process.env.DSH_HOME;
  process.env.HOME = home; process.env.DSH_HOME = dshHome;
  const [{ Context }, { default: Loader }, { default: Hmr }, boot] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-hmr'), load('@deepseek-ai/dsh-app-boot'),
  ]);
  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(dir).href + '/';
  const controllers: MigrationController[] = [];
  const allowStop = deferred();
  const targetAllowStop = deferred();
  t.after(async () => {
    allowStop.resolve(); targetAllowStop.resolve(); for (const controller of controllers) controller.dispose();
    await ctx.fiber.dispose();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldDsh;
    assert.ok(root.startsWith(join(tmpdir(), 'toolbox-native-lifecycle-')));
    await rm(root, { recursive: true, force: true });
  });
  await ctx.plugin(Loader);
  await ctx.plugin((await load('@deepseek-ai/cordis-plugin-timer')).default);
  // No profileContext is registered with HMR: this fixture explicitly owns native reconciliation.
  // Therefore no unrelated profile-normalization path is invoked during inspection.
  t.diagnostic('installing HMR');
  await ctx.plugin(Hmr, { base: dir, root: [], ignored: [], debounce: 0 });
  t.diagnostic('HMR active');
  const hmr = ctx.get('hmr');
  assert.ok(hmr, 'actual native HMR initialized (use node --expose-internals if needed)');
  const patchPath = join(dir, 'cordis.patch.yml');
  const baseFile = join(dir, 'cordis.yml');
  const profile = { dir, home: dshHome, patchPath, installAnchor: anchor, overlays: [] };
  const proof = {
    events: [] as string[], oldActive: 0, targetActive: 0, returned: 0,
    stopStarted: deferred(), allowStop, targetStopStarted: deferred(), targetAllowStop, controllers,
    module: undefined as Values | undefined,
    bootstrap(_pluginContext: unknown, config: Values) {
      proof.module = (config.modules as Record<string, Values>)?.retry;
      const controller = startAutomaticMigration(host, target);
      controllers.push(controller);
      return controller;
    },
  };
  const host: NativeMigrationHost = {
    profileContext: profile, loader: ctx.loader,
    get: name => ctx.get(name), moduleConfig: () => proof.module,
    on: (event, listener) => ctx.on(event, listener),
  };
  ctx.provide('nativeMigrationProof', proof);
  const pkg = async (name: string, version: string, row: object, source: string) => {
    const path = join(dir, 'node_modules', name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, version, type: 'module', exports: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    await writeFile(join(path, 'cordis.patch.yml'), JSON.stringify([{ insert: [row] }]));
    await writeFile(join(path, 'index.js'), source);
  };
  await pkg('dsh-stream-retry', '0.1.9', { id: 'stream-retry', name: 'dsh-stream-retry', config: { errorCodes: [], providers: [], retryEmptyResponse: false } }, [
    "export const name = 'inert-legacy-retry-proof';",
    'export function apply(ctx) {',
    "  const proof = ctx.get('nativeMigrationProof');",
    "  proof.oldActive++; proof.events.push('source-start');",
    "  ctx.effect(() => async () => {",
    "    proof.events.push('source-stop-begin'); proof.stopStarted.resolve();",
    '    await proof.allowStop.promise;',
    "    proof.oldActive--; proof.events.push('source-stopped');",
    '  });',
    '}',
  ].join('\n'));
  await pkg('dsh-toolbox', '0.1.0', { id: 'dsh-toolbox', name: 'dsh-toolbox', config: { modules: {} } }, [
    "export const name = 'inert-toolbox-bootstrap-proof';",
    'export function apply(ctx, config) {',
    "  const proof = ctx.get('nativeMigrationProof');",
    "  proof.events.push('target-bootstrap');",
    '  const controller = proof.bootstrap(ctx, config);',
    '  let active = false;',
    '  const unsubscribe = controller.subscribe(state => {',
    '    if (state.modules.retry?.ready && state.modules.retry.enabled && !active) {',
    "      if (proof.oldActive) throw new Error('new feature started before legacy disposal');",
    "      active = true; proof.targetActive++; proof.events.push('target-feature-start');",
    '    }',
    '  });',
    "  ctx.effect(() => async () => {",
    '    unsubscribe(); controller.dispose();',
    "    if (active) { proof.targetStopStarted.resolve(); await proof.targetAllowStop.promise; proof.targetActive--; proof.events.push('target-feature-stop'); }",
    '  });',
    "  proof.returned++; proof.events.push('target-apply-return');",
    '}',
  ].join('\n'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'disposable-native-proof', dependencies: { 'dsh-toolbox': '*', 'dsh-stream-retry': '*' }, dsh: { profile: { bundles: ['dsh-stream-retry', 'dsh-toolbox'] } } }));
  await writeFile(patchPath, '[]\n'); await writeFile(baseFile, '[]\n');
  const patches = async () => {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const layers = [];
    for (const name of manifest.dsh.profile.bundles) {
      const path = boot.resolveBundleDir('native-proof', name, anchor, dir);
      layers.push(...boot.loadOverlayPatches('native-proof', join(path, 'cordis.patch.yml')));
    }
    layers.push(...boot.loadOverlayPatches('native-proof', patchPath));
    return layers;
  };
  const mount = () => hmr.runExclusive(async () => {
    await boot.mountRootInclude(ctx, baseFile, await patches());
    await ctx.loader.await(); await boot.auditStartupEntries(ctx, 'native-proof');
  });
  const refresh = () => patches().then(value => boot.reconcileProfilePatches(ctx, value, 'native-proof'));
  const reconcile = () => hmr.runExclusive(refresh);
  const reconcilePatches = (value: unknown[]) => hmr.runExclusive(() => boot.reconcileProfilePatches(ctx, value, 'native-proof'));
  return { root, dir, patchPath, host, ctx, hmr, proof, patches, mount, reconcile, refresh, reconcilePatches };
}

test('real native Loader/HMR bootstrap persists without nested HMR and keeps target gated until async legacy disposal', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  // Keep the test alive while the intentionally unref'ed bootstrap timer completes.
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  t.diagnostic('mounting native tree');
  await f.mount();
  t.diagnostic('native tree mounted');
  assert.equal(f.proof.returned, 1, 'synchronous target apply returned and Loader settlement completed');
  assert.equal(f.proof.oldActive, 1); assert.equal(f.proof.targetActive, 0);
  const initial = await f.proof.controllers[0].settled;
  t.diagnostic('migration persisted: ' + JSON.stringify(initial.modules));
  assert.equal(initial.modules.retry?.phase, 'restart-required');
  assert.equal(initial.modules.retry?.ready, false);
  assert.equal(f.proof.targetActive, 0, 'persisted enabled config is not proof of native handover');
  const persisted = await inspectMigration(f.host, target);
  assert.equal(persisted.sources[0].disabled, true);
  assert.deepEqual(persisted.explicit.retry, { enabled: true, errorCodes: [], providers: [], retryEmptyResponse: false });
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'package.json'), 'utf8')).dsh.profile.bundles, ['dsh-toolbox']);
  // A genuine completed stage-1 native reload adopts target config but retains the old owner.
  // That acknowledgment must not authorize handover, even after its event has been observed.
  await f.reconcilePatches([{ insert: [
    { id: 'stream-retry', name: 'dsh-stream-retry', config: { errorCodes: [], providers: [], retryEmptyResponse: false } },
    ...persisted.rows,
  ] }]);
  const stageOne = await f.proof.controllers.at(-1)!.retry();
  assert.equal(stageOne.modules.retry?.ready, false, 'partial native reload acknowledgment still contains the old fiber');
  assert.equal(f.proof.oldActive, 1); assert.equal(f.proof.targetActive, 0);
  t.diagnostic('starting reconciliation');
  const reloading = f.reconcile();
  await Promise.race([f.proof.stopStarted.promise, reloading.then(() => { throw new Error('reconciliation ended without starting legacy disposal: ' + JSON.stringify(f.proof.events)); })]);
  t.diagnostic('disposal started');
  assert.equal(f.proof.oldActive, 1, 'disposer is still pending');
  assert.equal(f.proof.targetActive, 0, 'new feature remains gated while old async disposer owns effects');
  const duringDisposal = await f.proof.controllers.at(-1)!.retry();
  assert.equal(duringDisposal.modules.retry?.ready, false, 'native pending disposal must remain an ownership blocker');
  assert.equal(f.proof.targetActive, 0);
  f.proof.allowStop.resolve(); await reloading;
  assert.equal(f.proof.oldActive, 0);
  const applied = await f.proof.controllers.at(-1)!.retry();
  assert.equal(applied.modules.retry?.phase, 'applied'); assert.equal(applied.modules.retry?.ready, true);
  assert.equal(f.proof.targetActive, 1);
  assert.ok(f.proof.events.indexOf('source-stopped') < f.proof.events.indexOf('target-feature-start'));
  await assert.rejects(f.hmr.runExclusive(() => f.hmr.runExclusive(() => {})), /cannot be nested/, 'actual HMR nested-transaction protection is active');
});

test('actual native HMR file watcher serializes persisted profile reload and ownership handover', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  await f.mount();
  await f.proof.controllers[0].settled;
  const observed = deferred();
  f.ctx.on('app-boot/config-reload', () => observed.resolve());
  let armed = false;
  const unwatch = await f.hmr.watchConfig(f.patchPath, async () => {
    if (!armed) return;
    await f.refresh();
  });
  t.after(() => unwatch());
  armed = true;
  // This real filesystem change, not a direct reconciliation call, drives the native watcher.
  await writeFile(f.patchPath, (await readFile(f.patchPath, 'utf8')) + '\n# native watcher proof\n');
  await f.proof.stopStarted.promise;
  assert.equal(f.proof.oldActive, 1);
  assert.equal(f.proof.targetActive, 0);
  const during = await f.proof.controllers.at(-1)!.retry();
  assert.equal(during.modules.retry?.ready, false, 'watcher transaction must retain the old-owner disposal fence');
  f.proof.allowStop.resolve();
  await observed.promise;
  const applied = await f.proof.controllers.at(-1)!.retry();
  assert.equal(applied.modules.retry?.phase, 'applied');
  assert.equal(f.proof.oldActive, 0); assert.equal(f.proof.targetActive, 1);
  assert.ok(f.proof.events.indexOf('source-stopped') < f.proof.events.indexOf('target-feature-start'));
});
test('real native host B remains the rollback owner while its async Toolbox disposer is absent from Loader inventory', {timeout:15_000},async t=>{
  const f=await fixture(t);const keep=setInterval(()=>{},1000);t.after(()=>clearInterval(keep));
  // A performs a genuinely offline migration and exits before native host B starts its target.
  const script="import {runMigration} from "+JSON.stringify(new URL('../../src/migration/engine.ts',import.meta.url).href)+";const host={profileContext:"+JSON.stringify(f.host.profileContext)+",loader:{entries:()=>[]}};console.log(JSON.stringify(await runMigration(host,"+JSON.stringify(target)+")));";
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const migrated=JSON.parse(child.stdout);
  await f.mount();const controller=f.proof.controllers.at(-1)!;
  await controller.settled;
  assert.equal(controller.state().modules.retry?.ready,true);
  assert.equal(f.proof.targetActive,1);assert.equal(f.proof.oldActive,0);
  const first=await controller.rollback({operationId:migrated.operationId,modules:['retry']});
  assert.equal(first.modules.retry?.phase,'restart-required');
  const entry=[...f.ctx.loader.entries()].find((entry:any)=>entry.options.id==='dsh-toolbox')!;
  // Native remove detaches the entry before its owned asynchronous disposer settles.
  f.ctx.loader.remove(entry.id);
  await f.proof.targetStopStarted.promise;
  assert.ok(![...f.ctx.loader.entries()].some((entry:any)=>entry.options.id==='dsh-toolbox'));
  assert.equal(f.proof.targetActive,1,'new effect is still alive during pending native teardown');
  const repeated=await rollbackMigration(f.host,target,{operationId:migrated.operationId,modules:['retry']});
  assert.equal(repeated.modules.retry?.phase,'restart-required');
  const manifest=JSON.parse(await readFile(join(f.dir,'package.json'),'utf8'));
  assert.ok(!manifest.dsh.profile.bundles.includes('dsh-stream-retry'));
  assert.equal(f.proof.oldActive,0,'old source is not restored while B still owns its pending new effect');
  f.proof.targetAllowStop.resolve();await entry.fiber.await();
  assert.equal(f.proof.targetActive,0);
});
