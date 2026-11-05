import assert from 'node:assert/strict';
import test from 'node:test';
import { validateModuleConfig } from '../../src/migration/validation.ts';

test('rejects source semantic constraints before migration ownership changes', () => {
  for (const config of [{ pressureStep: 0 }, { retryAttempts: 6 }, { guidanceText: 'x'.repeat(8001) }, { ptcModelTimeouts: { 'provider/model': 0 } }]) {
    assert.throws(() => validateModuleConfig('context', { enabled: true, ...config }));
  }
});

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import type { ModuleId, Values } from '../../src/migration/types.ts';

type Cases = { id: ModuleId; field: string; accept: unknown[]; reject: unknown[] };
const invalidScalar = [null, undefined, '0', false, {}, []];
const invalidNumber = [...invalidScalar, NaN, Infinity, -Infinity];
const cases: Cases[] = [
  { id: 'context', field: 'guidanceText', accept: ['', 'a'.repeat(8000), '😀'.repeat(4000)], reject: [null, undefined, false, 1, 'a'.repeat(8001), '😀'.repeat(4001)] },
  { id: 'context', field: 'notifyAtRatio', accept: [0, -0, Number.MIN_VALUE, 1 - Number.EPSILON], reject: [...invalidNumber, -Number.EPSILON, 1, 2] },
  { id: 'context', field: 'pressureStep', accept: [1, 10, 50], reject: [...invalidNumber, 0, -1, 51, 1.5] },
  { id: 'context', field: 'retryAttempts', accept: [0, 2, 5], reject: [...invalidNumber, -1, 6, 0.5] },
  { id: 'context', field: 'retryDelayMs', accept: [0, 1000, 60000], reject: [...invalidNumber, -1, 60001, 1.5] },
  { id: 'context', field: 'ptcTimeoutMs', accept: [0, 1, Number.MAX_SAFE_INTEGER, 1e100], reject: [...invalidNumber, -1, 0.5] },
  { id: 'context', field: 'ptcModelTimeouts', accept: [{}, { 'provider/model': 1 }, { '/': 1, 'provider/': 1e100, '/model': 100 }], reject: [null, undefined, [], 1, { model: 1 }, { 'provider/model': 0 }, { 'provider/model': -1 }, { 'provider/model': 0.5 }, { 'provider/model': NaN }, { 'provider/model': Infinity }, { 'provider/model': '1' }] },
  { id: 'retry', field: 'errorCodes', accept: [[], ['stream error', 'a', 'a b', '模型异常', 'a'.repeat(200)], Array(100).fill('x')], reject: [null, undefined, 'error', [1], [''], ['a'.repeat(201)], [' x'], ['x '], ['x:y'], ['a"b'], ["a'b"], ['a' + String.fromCharCode(96) + 'b'], ['a\nb'], ['a\tb'], ['a\u007fb'], Array(101).fill('x')] },
  { id: 'retry', field: 'providers', accept: [[], ['provider', 'route/model', 'a:b', 'a"b', '供应商', '\u0000', 'a'.repeat(200)], Array(100).fill('x')], reject: [null, undefined, 'provider', [false], [''], ['a'.repeat(201)], ['a b'], [' a'], ['a '], ['a\nb'], ['a\tb'], Array(101).fill('x')] },
  { id: 'chime', field: 'volume', accept: [0, -0, 0.5, 1], reject: [...invalidNumber, -Number.EPSILON, 1 + Number.EPSILON] },
  { id: 'chime', field: 'quietStyle', accept: ['short', 'silent'], reject: [null, undefined, '', 'Short', 'long', false] },
  { id: 'chime', field: 'bannerPlacement', accept: ['bottom-center', 'bottom-right', 'bottom-left', 'top-right', 'top-left', 'center', 'modal'], reject: [null, undefined, '', 'top-center', 'bottom', false] },
  { id: 'goalWait', field: 'maxHoldMs', accept: [0, -0, 1, Number.MAX_SAFE_INTEGER], reject: [...invalidNumber, -1, 0.5, Number.MAX_SAFE_INTEGER + 1] },
];
for (const field of ['compactTool', 'statusTool', 'guidance', 'pressureContext']) cases.push({ id: 'context', field, accept: [true, false], reject: [null, undefined, 0, 1, 'true', {}, []] });
for (const id of ['context', 'retry', 'chime', 'goalWait'] as const) cases.push({ id, field: 'enabled', accept: [true, false], reject: [null, undefined, 0, 1, 'true', {}, []] });
cases.push({ id: 'retry', field: 'retryEmptyResponse', accept: [true, false], reject: [null, undefined, 0, 1, 'true', {}, []] });
for (const field of ['chimeQuestion', 'chimeError', 'restMode', 'banner']) cases.push({ id: 'chime', field, accept: [true, false], reject: [null, undefined, 0, 1, 'true', {}, []] });
for (const field of ['waitForJobs', 'waitForSubagents']) cases.push({ id: 'goalWait', field, accept: [true, false], reject: [null, undefined, 0, 1, 'true', {}, []] });
for (const field of ['soundDone', 'soundBlocked', 'soundQuestion', 'soundError']) cases.push({ id: 'chime', field, accept: ['chime-soft', 'bell-bright', 'marimba', 'alert-low', 'alert-sharp', 'blip'], reject: [null, undefined, '', 'ding', 'Chime-soft', false, {}] });
for (const field of ['durationMs', 'debounceMs', 'quietShortMs', 'minRingMs']) cases.push({ id: 'chime', field, accept: [0, -0, 1, 21600000], reject: [...invalidNumber, -1, 0.5, 21600001, Number.MAX_SAFE_INTEGER + 1] });
for (const field of ['dndStart', 'dndEnd']) cases.push({ id: 'chime', field, accept: ['', '00:00', '23:59', '09:05'], reject: [null, undefined, false, '0:00', '24:00', '00:60', '12:1', ' 00:00', '00:00 ', '00:00\n', 'noon'] });

for (const item of cases) test(item.id + '.' + item.field + ' preserves valid values and rejects every semantic boundary violation', () => {
  for (const value of item.accept) {
    const config = { [item.field]: value };
    const before = structuredClone(config);
    assert.doesNotThrow(() => validateModuleConfig(item.id, config));
    assert.deepEqual(config, before, 'validation never defaults, coerces, or edits raw input');
  }
  for (const value of item.reject) assert.throws(() => validateModuleConfig(item.id, { [item.field]: value }), item.id + '.' + item.field + ' admitted invalid value');
});

test('missing fields remain default-resolver-owned and unknown fields are always rejected', () => {
  for (const id of ['context', 'retry', 'chime', 'goalWait'] as const) {
    const config = Object.freeze({ enabled: false });
    assert.doesNotThrow(() => validateModuleConfig(id, {}));
    assert.doesNotThrow(() => validateModuleConfig(id, config));
    for (const key of ['unexpected', '__jsExpr', 'credentials', 'quietDurationMs']) assert.throws(() => validateModuleConfig(id, { [key]: false }));
  }
});

test('raw object validation never reads accessors or executes volatile wrappers', () => {
  let called = 0;
  const getter = Object.defineProperty({}, 'enabled', { enumerable: true, get() { called++; throw new Error('must not execute'); } });
  const volatile = { get() { called++; throw new Error('must not execute'); } };
  for (const config of [getter, { enabled: volatile }, Object.create({ enabled: true }), new Date(), null, []]) {
    assert.throws(() => validateModuleConfig('context', config as Values));
  }
  const map = Object.defineProperty({}, 'provider/model', { enumerable: true, get() { called++; return 1; } });
  assert.throws(() => validateModuleConfig('context', { ptcModelTimeouts: map }));
  const list = Object.defineProperty([], '0', { enumerable: true, get() { called++; return 'x'; } });
  assert.throws(() => validateModuleConfig('retry', { errorCodes: list }));
  const customIterator = Object.defineProperty(['x'], Symbol.iterator, { value: function* () { called++; yield 'x'; } });
  assert.throws(() => validateModuleConfig('retry', { errorCodes: customIterator }));
  assert.throws(() => validateModuleConfig('retry', { errorCodes: Array(1) }));
  assert.equal(called, 0);
});

test('prototype-bearing keys, symbols, and non-enumerable fields cannot hide from admission', () => {
  for (const config of [JSON.parse('{"__proto__":{}}'), { constructor: true }, { prototype: true }, { [Symbol('secret')]: true }, Object.defineProperty({}, 'enabled', { value: true })]) {
    assert.throws(() => validateModuleConfig('context', config));
  }
  assert.throws(() => validateModuleConfig('unknown' as ModuleId, {}));
  assert.doesNotThrow(() => validateModuleConfig('context', Object.assign(Object.create(null), { enabled: false })));
});

test('audited standalone rules match original config-only validators on semantic values', { skip: !process.env.DSH_TEST_LEGACY_ROOT }, async () => {
  const root = process.env.DSH_TEST_LEGACY_ROOT!;
  const original = async (name: string) => import(pathToFileURL(join(root, name, 'lib', 'config.js')).href);
  const [context, chime, goal] = await Promise.all([original('dsh-tool-compact-context'), original('dsh-session-chime'), original('dsh-goal-wait-gate')]);
  // Retry has no config-only export. Extract only its schema declarations, never import/apply
  // the plugin entrypoint or its feature helpers. The source tree remains read-only.
  const retryRoot = join(root, 'dsh-stream-retry');
  const retryText = await readFile(join(retryRoot, 'src', 'index.ts'), 'utf8');
  const declarations = retryText.slice(retryText.indexOf('const identifier ='), retryText.indexOf('/** Read a live configuration reference'));
  const schema = retryText.slice(retryText.indexOf('export const Config ='), retryText.indexOf('/** Correct only terminal failure classification'));
  assert.ok(declarations.startsWith('const identifier =') && schema.startsWith('export const Config ='));
  const schemaPath = createRequire(join(retryRoot, 'package.json')).resolve('@deepseek-ai/schemastery');
  const Schema = (await import(pathToFileURL(schemaPath).href)).default;
  const retrySchema = new Script(declarations + schema.replace('export const Config', 'const Config') + '\nConfig;').runInNewContext({ Schema });
  const oracles: Record<ModuleId, (config: Values) => unknown> = {
    context: config => context.validateConfig(context.resolveConfig(config)),
    retry: config => retrySchema(config), chime: config => chime.resolveRowConfig(config), goalWait: config => goal.resolveConfig(config),
  };
  let checked = 0;
  for (const item of cases) {
    if (item.field === 'enabled' && item.id !== 'chime') continue; // Toolbox envelope, not a legacy field.
    for (const value of [...item.accept, ...item.reject]) {
      // Raw null/undefined rejection is intentional: source schemas sometimes default it.
      // Migration does not silently erase explicit malformed input or run live accessors.
      if (value === null || value === undefined) continue;
      const config = { [item.field]: value };
      let accepts = true; try { oracles[item.id](config); } catch { accepts = false; }
      let admitted = true; try { validateModuleConfig(item.id, config); } catch { admitted = false; }
      assert.equal(admitted, accepts, item.id + '.' + item.field + ' differs from original semantic validation');
      checked++;
    }
  }
  assert.ok(checked > 300, 'substantial original-source boundary parity corpus executed');
});
