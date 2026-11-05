import test from 'node:test';
import assert from 'node:assert/strict';
import * as context from '../../src/modules/context/index.ts';
import * as retry from '../../src/modules/retry/index.ts';
import * as chime from '../../src/modules/chime/index.ts';
import * as goalWait from '../../src/modules/goal-wait/index.ts';
import type { Distribution } from '../../src/types.ts';
import { loadHost, loaderFixture } from './loader-harness.ts';

// The real SettingsForms service projects and validates every field. The editor
// adapter deliberately targets real Loader entries; disk persistence remains the
// separate migration/native ConfigEditor suite's concern, not a claim here.
test('native SettingsForms exposes and writes every original feature field without remounting the root', { timeout: 10000 }, async t => {
  const d: Distribution = { name: 'dsh-toolbox', moduleIds: ['context', 'retry', 'chime', 'goalWait'], modulePlugins: { context, retry, chime, goalWait } };
  const initial = { modules: Object.fromEntries(d.moduleIds.map(id => [id, { enabled: false }])), migration: { auto: false } };
  const f = await loaderFixture(t, d, initial); await f.ready();
  f.ctx.reflect.provide('configEditor', {
    documentPath: f.profile + '/cordis.patch.yml',
    entries: () => [f.entry],
    configuration: () => [{ entry: f.entry, inherited: {}, override: structuredClone(f.entry.options.config ?? {}) }],
    async edit(entry: any, change: (raw: any, inherited: any) => any) {
      const next = change(structuredClone(entry.options.config ?? {}), {});
      entry.fiber.resolveConfig(next); await entry.update({ config: next }); await f.loader.await();
    },
  });
  await f.ctx.plugin((await loadHost('dsh-settings')).default).await();
  const settings = f.ctx.get('settings') as any;
  const before = settings.describe().find((row: any) => row.ns === d.name);
  assert.ok(before); assert.equal(before.applies, 'live');
  for (const id of d.moduleIds) assert.deepEqual(Object.keys(before.value.modules[id]).sort(), [...new Set(['enabled', ...Object.keys((d.modulePlugins[id]!.Config as any).dict)])].sort());
  const next = { modules: {
    context: { enabled: false, compactTool: false, statusTool: true, guidance: true, guidanceText: 'Native settings fixture', pressureContext: true, notifyAtRatio: 0.5, pressureStep: 20, retryAttempts: 1, retryDelayMs: 0, ptcTimeoutMs: 300, ptcModelTimeouts: { 'test/model': 700 } },
    retry: { enabled: false, errorCodes: [], providers: ['test'], retryEmptyResponse: false },
    chime: { enabled: false, soundDone: 'bell-bright', soundBlocked: 'chime-soft', soundQuestion: 'marimba', soundError: 'blip', chimeQuestion: false, chimeError: false, volume: 0, durationMs: 0, debounceMs: 0, quietStyle: 'silent', quietShortMs: 0, dndStart: '22:00', dndEnd: '06:00', restMode: true, minRingMs: 0, banner: false, bannerPlacement: 'center' },
    goalWait: { enabled: false, waitForJobs: false, waitForSubagents: false, maxHoldMs: 99 },
  }, migration: { auto: false } };
  const owner = f.entry.fiber;
  await settings.update(d.name, next, before.revision);
  const after = settings.describe().find((row: any) => row.ns === d.name);
  assert.deepEqual(after.value, next);
  assert.equal(f.entry.fiber, owner);
  assert.ok(after.revision > before.revision);
  await assert.rejects(() => settings.update(d.name, { modules: { retry: { errorCodes: ['late'] } } }, before.revision), /revision|conflict|changed/i);
});
