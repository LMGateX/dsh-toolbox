import test from 'node:test';
import assert from 'node:assert/strict';
import * as chime from '../../src/modules/chime/index.ts';
import * as context from '../../src/modules/context/index.ts';
import type { Distribution } from '../../src/types.ts';
import { loaderFixture } from './loader-harness.ts';

const distribution: Distribution = { name: 'dsh-toolbox-chime', moduleIds: ['chime'], modulePlugins: { chime } };

test('status route uses actual native owner cookies, Host and Origin admission and GET-only policy', { timeout: 10000 }, async t => {
  const f = await loaderFixture(t, distribution, { modules: { chime: { enabled: true } }, migration: { auto: false } });
  await f.ready();
  const owner = f.request(); assert.equal(owner.code, 200);
  assert.equal(owner.headers['Cache-Control'], 'no-store');
  assert.equal(owner.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(JSON.parse(owner.body).distribution, distribution.name);
  assert.equal(f.request('GET', { host: f.host }).code, 401);
  assert.equal(f.request('GET', { host: 'untrusted.invalid', cookie: f.ownerCookie }).code, 403);
  assert.equal(f.request('GET', { host: f.host, cookie: f.ownerCookie, origin: 'http://untrusted.invalid' }).code, 403);
  assert.equal(f.request('POST').code, 405); assert.equal(f.request('HEAD').code, 405);
  assert.equal(f.request('POST', { host: f.host }).code, 401, 'authentication runs before method handling');
  const connection = f.ctx.get('connection') as any; const admit = connection.admit;
  connection.admit = () => ({ peer: { principal: { kind: 'untrusted-test-principal' } } });
  try { assert.equal(f.request().code, 403, 'an admitted non-owner never sees status'); } finally { connection.admit = admit; }
  const table: any[] = []; (f.ctx.emit as any)('webserver/index-inject', table);
  assert.ok(table.some(item => item.name === '__DSH_TOOLBOX_PAGE_dsh_toolbox_chime__' && Number.isFinite(item.value.servedAt)));
  await f.entry.update({ disabled: true }); await f.loader.await();
  assert.equal(f.request().code, 404, 'route is removed with its owner fiber');
});

test('a configured peer capability fails closed and is reported as a conflict, not an ordinary disable', { timeout: 10000 }, async t => {
  const d: Distribution = { name: 'dsh-toolbox-context', moduleIds: ['context'], modulePlugins: { context } };
  const f = await loaderFixture(t, d, { modules: { context: { enabled: true } }, migration: { auto: false } }, undefined,
    [{ id: 'other-owner', name: 'dsh-toolbox', config: { modules: { context: { enabled: true } } } }]);
  const state = await f.ready();
  assert.equal(state.modules.context.ready, false);
  assert.equal(state.report.modules.context.phase, 'conflict');
  assert.equal(state.modules.context.phase, 'conflict');
  assert.match(state.modules.context.reason, /another Toolbox distribution/);
});
