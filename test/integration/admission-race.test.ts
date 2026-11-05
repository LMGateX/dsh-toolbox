/** Actual root runtime/Cordis; only migration observations are controlled to expose an await boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

test('root reads fresh admission after awaiting a different module disposer', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(resolve('.sandbox-root-admission-'));
  const key = '__toolbox_admission_' + randomUUID().replaceAll('-', '_');
  const listeners = new Set<() => void>();
  const observations: any = { modules: { context: { ready: true }, retry: { ready: true } } };
  const controller = { state: () => structuredClone(observations), settled: Promise.resolve({}),
    subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }, dispose() {} };
  (globalThis as any)[key] = controller;
  const compiled = await build({ entryPoints: [resolve('src/runtime.ts')], bundle: true, write: false,
    platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'controlled-migration-observations', setup(b) {
      b.onResolve({ filter: /migration/ }, () => ({ path: 'migration', namespace: 'observations' }));
      b.onLoad({ filter: /.*/, namespace: 'observations' }, () => ({ contents: 'export function startAutomaticMigration(){return globalThis[' + JSON.stringify(key) + ']}', loader: 'js' }));
    } }] });
  const entry = join(dir, 'runtime.mjs'); await writeFile(entry, compiled.outputFiles[0].contents);
  const { createToolboxPlugin } = await import(pathToFileURL(entry).href);
  const ctx = new Context();
  ctx.reflect.provide('profileContext', {}); ctx.reflect.provide('loader', {});
  let release!: () => void; const held = new Promise<void>(done => { release = done; });
  let began!: () => void; const disposing = new Promise<void>(done => { began = done; });
  let contextMounts = 0, retryMounts = 0;
  t.after(async () => { release(); await ctx.fiber.dispose(); delete (globalThis as any)[key]; assert.ok(dir.startsWith(resolve('.sandbox-root-admission-'))); await rm(dir, { recursive: true, force: true }); });
  const Config = Schema.object({ enabled: Schema.boolean().default(true) });
  const distribution = { name: 'dsh-toolbox', moduleIds: ['context', 'retry'], modulePlugins: {
    context: { name: 'fixture-context', Config, apply(child: Context) { contextMounts++; child.effect(() => async () => { began(); await held; }); } },
    retry: { name: 'fixture-retry', Config, apply() { retryMounts++; } },
  } };
  const config = { modules: { context: { enabled: true }, retry: { enabled: false } } };
  const root = ctx.plugin({ apply(owner: Context) { createToolboxPlugin(distribution).apply(owner, config); } });
  await root.await();
  for (let i = 0; contextMounts !== 1 && i < 100; i++) await new Promise(done => setImmediate(done));
  assert.equal(contextMounts, 1); assert.equal(retryMounts, 0);
  config.modules.context.enabled = false; for (const fn of listeners) fn(); await disposing;
  // The old reconciliation already cloned ready=true before it blocked in context disposal.
  config.modules.retry.enabled = true; observations.modules.retry = { ready: false, phase: 'pending' };
  for (const fn of listeners) fn(); release();
  for (let i = 0; i < 20; i++) await new Promise(done => setImmediate(done));
  assert.equal(retryMounts, 0, 'pending durable registration must not mount through a pre-await snapshot');
  observations.modules.retry = { ready: true, phase: 'complete' }; for (const fn of listeners) fn();
  for (let i = 0; Number(retryMounts) !== 1 && i < 100; i++) await new Promise(done => setImmediate(done));
  assert.equal(retryMounts, 1, 'fresh admitted observation permits exactly one mount');
});
