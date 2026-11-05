/** Root schema/preflight tests; feature schemas are the single policy source. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, plain, validateModule } from '../../src/config.ts';
import * as context from '../../src/modules/context/index.ts';
import * as retry from '../../src/modules/retry/index.ts';
import * as chime from '../../src/modules/chime/index.ts';
import * as goalWait from '../../src/modules/goal-wait/index.ts';
import type { Distribution } from '../../src/types.ts';

const combined: Distribution = { name: 'dsh-toolbox', moduleIds: ['context', 'retry', 'chime', 'goalWait'], modulePlugins: { context, retry, chime, goalWait } };

test('every original feature field and module switch is editable in the combined native schema', () => {
  const schema = createConfig(combined);
  for (const id of combined.moduleIds) {
    const original = combined.modulePlugins[id]!.Config as any;
    const fields = (schema as any).dict.modules.dict[id].dict;
    assert.deepEqual(Object.keys(fields).sort(), [...new Set([...Object.keys(original.dict), 'enabled'])].sort());
    for (const [key, field] of Object.entries(fields)) assert.equal((field as any).meta.volatile, true, id + '.' + key);
  }
  assert.equal((context.Config as any).dict.notifyAtRatio.meta.volatile, undefined, 'cloning does not mutate source schemas');
  assert.equal((context.Config as any).dict.pressureStep.meta.volatile, undefined);
});

test('root schema retains exact original defaults, with one chime enabled flag', () => {
  const values = plain<any>(createConfig(combined)({}));
  assert.deepEqual(values.modules.context, { ...context.resolveConfig(), enabled: true });
  assert.deepEqual(values.modules.retry, { errorCodes: ['upstream_stream_read_error', 'stream_timeout', 'stream error'], providers: [], retryEmptyResponse: true, enabled: true });
  assert.deepEqual(values.modules.chime, chime.resolveRowConfig());
  assert.deepEqual(values.modules.goalWait, { ...goalWait.resolveConfig(), enabled: true });
});

test('root volatile snapshots preserve false, zero and empty replacement lists while detaching objects', () => {
  const input = { modules: { context: { enabled: false, guidanceText: '', retryAttempts: 0, retryDelayMs: 0, ptcModelTimeouts: {} }, retry: { errorCodes: [], providers: [], retryEmptyResponse: false }, chime: { volume: 0, debounceMs: 0, restMode: false }, goalWait: { waitForJobs: false, maxHoldMs: 0 } } };
  const values = plain<any>(createConfig(combined)(input));
  assert.equal(values.modules.context.enabled, false); assert.equal(values.modules.context.retryAttempts, 0);
  assert.equal(values.modules.context.guidanceText, ''); assert.deepEqual(values.modules.context.ptcModelTimeouts, {});
  assert.deepEqual(values.modules.retry.errorCodes, []); assert.equal(values.modules.retry.retryEmptyResponse, false);
  assert.equal(values.modules.chime.volume, 0); assert.equal(values.modules.goalWait.waitForJobs, false);
  values.modules.retry.errorCodes.push('detached'); assert.deepEqual(input.modules.retry.errorCodes, []);
});

test('split schemas expose only their selected capability and do not mutate the combined schema', () => {
  for (const id of combined.moduleIds) {
    const schema = createConfig({ ...combined, name: 'dsh-toolbox-' + id, moduleIds: [id] });
    assert.deepEqual(Object.keys((schema as any).dict.modules.dict), [id]);
  }
  assert.deepEqual(Object.keys((createConfig(combined) as any).dict.modules.dict), [...combined.moduleIds]);
});

test('migration preflight rejects context semantic violations before owner handover', () => {
  for (const invalid of [{ retryAttempts: -1 }, { retryAttempts: 0.5 }, { retryAttempts: 6 }, { retryDelayMs: 60001 }, { pressureStep: 0 }, { pressureStep: 51 }, { notifyAtRatio: 1 }, { guidanceText: 'x'.repeat(8001) }, { ptcModelTimeouts: { 'provider/model': 0 } }]) {
    assert.throws(() => validateModule(combined, 'context', { enabled: true, ...invalid }), JSON.stringify(invalid).slice(0, 100));
  }
});

test('migration preflight retains source semantic validation for gate and chime', () => {
  assert.throws(() => validateModule(combined, 'goalWait', { maxHoldMs: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => validateModule(combined, 'chime', { durationMs: 21600001 }));
  assert.throws(() => validateModule(combined, 'retry', { errorCodes: ['bad:description'] }));
});
