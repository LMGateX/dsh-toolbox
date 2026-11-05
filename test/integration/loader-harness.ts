/** Real Cordis/Loader/Connection fixture, with a disposable active profile and no listening socket. */
import { Context } from '@deepseek-ai/cordis';
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import type { Distribution, ModuleId } from '../../src/types.ts';
import { createToolboxPlugin } from '../../src/runtime.ts';

export const requireHost = createRequire(process.env.DSH_RUNTIME_ROOT ? join(resolve(process.env.DSH_RUNTIME_ROOT), 'package.json') : createRequire(new URL('../../package.json', import.meta.url)).resolve('@deepseek-ai/dsh/package.json'));
export const loadHost = async (name: string): Promise<any> => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)).href);
export const pause = () => new Promise<void>(done => setTimeout(done, 10));
export async function until<T>(read: () => T, accepts: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 4000;
  let value = read();
  while (!accepts(value)) { if (Date.now() >= deadline) throw new Error('Timed out: ' + label + ' ' + JSON.stringify(value)); await pause(); value = read(); }
  return value;
}
export function response() {
  return { code: 0, headers: {} as Record<string, any>, body: '', writeHead(code: number, headers: Record<string, any> = {}) { this.code = code; this.headers = headers; }, end(value = '') { this.body += value; } };
}
export async function loaderFixture(t: TestContext, distribution: Distribution, config: Record<string, any>, suppliedContext?: Context, extraRows: Record<string, any>[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'toolbox-root-lifecycle-'));
  const profile = join(root, 'home', 'profiles', 'isolated');
  const home = join(root, 'home'); await mkdir(profile, { recursive: true });
  const ctx = suppliedContext ?? new Context();
  ctx.baseUrl = pathToFileURL(requireHost.resolve('@deepseek-ai/dsh/package.json')).href;
  const routes = new Map<string, any>(); const importTable = new Map<string, any>();
  const initial = structuredClone(config);
  const plugin = createToolboxPlugin(distribution);
  importTable.set(distribution.name, plugin);
  const NativeInclude = (await loadHost('cordis-plugin-include')).default;
  class FixtureInclude extends NativeInclude {
    import(name: string, stack?: () => string[]) { return importTable.has(name) ? importTable.get(name) : super.import(name, stack); }
  }
  class MemoryLoader extends Loader { override import(name: string, stack?: () => string[]) {
    if (name === 'cordis:include') return FixtureInclude;
    return importTable.has(name) ? importTable.get(name) : super.import(name, stack);
  } }
  const loader = new MemoryLoader(ctx, { baseUrl: ctx.baseUrl });
  loader.builtins.group = Group;
  const patchPath = join(profile, 'cordis.patch.yml');
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-root-profile', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }));
  const save = async (rows: unknown[]) => writeFile(patchPath, JSON.stringify([{ insert: rows }], null, 2));
  await save([{ id: distribution.name, name: distribution.name, config: initial }, ...extraRows]);
  ctx.reflect.provide('profileContext', { dir: profile, patchPath, home, installAnchor: requireHost.resolve('@deepseek-ai/dsh/package.json'), overlays: [] });
  ctx.reflect.provide('webServer', { register(route: any) { if (routes.has(route.path)) throw new Error('duplicate route'); routes.set(route.path, route); return () => { if (routes.get(route.path) === route) routes.delete(route.path); }; } });
  const records = new Map();
  ctx.reflect.provide('credentials', { async modifyRecord(key: string, edit: (value: any) => Promise<any>) { const next = await edit(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key); } });
  const connectionPlugin = await loadHost('dsh-client-connection');
  await ctx.plugin(connectionPlugin, {}).await();
  const connection = ctx.get('connection') as any;
  const host = '127.0.0.1:43999'; const launch = new URL(connection.authenticatedUrl('http://' + host + '/'));
  const login = response(); connection.authorizeIndex({ method: 'GET', url: launch.pathname + launch.search, headers: { host } }, login);
  const setCookie = login.headers['Set-Cookie'] ?? login.headers['set-cookie'];
  const ownerCookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  const request = (method = 'GET', headers: Record<string, string> = { host, cookie: ownerCookie }, name = distribution.name) => {
    const result = response(); const route = routes.get('/toolbox/' + encodeURIComponent(name) + '/status');
    if (!route) { result.code = 404; return result; }
    route.handler({ method, headers }, result); return result;
  };
  const status = (name = distribution.name) => { const result = request('GET', { host, cookie: ownerCookie }, name); if (result.code !== 200) return { httpCode: result.code }; return JSON.parse(result.body); };
  let closed = false;
  const dispose = async () => { if (closed) return; closed = true; await ctx.fiber.dispose(); if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('toolbox-root-lifecycle-')) throw new Error('unsafe fixture cleanup'); await rm(root, { recursive: true, force: true }); };
  t.after(dispose);
  // Native ConfigEditor owns persistence and profile reconciliation. A bare
  // Loader row has no profile writer and would leave adoption fences comparing
  // changed in-memory settings against the old persisted profile.
  const boot = await loadHost('dsh-app-boot');
  const baseFile = join(profile, 'cordis.yml'); await writeFile(baseFile, '[]\n');
  await boot.mountRootInclude(ctx, baseFile, boot.readProfilePatches('dsh', ctx.get('profileContext')));
  await loader.await();
  const entry = [...loader.entries()].find(row => row.options.id === distribution.name);
  if (!entry?.fiber) throw new Error('native Include did not mount the Toolbox row');
  const fiber = entry.fiber;
  const update = async (next: Record<string, any>) => {
    let editor = ctx.get('configEditor') as any;
    if (editor === undefined) { await ctx.plugin((await loadHost('dsh-config-editor')).default).await(); editor = ctx.get('configEditor'); }
    await editor.edit(entry, () => structuredClone(next));
    await loader.await();
  };
  return { root, profile, home, ctx, loader, entry, fiber, routes, request, status, update, save, importTable, host, ownerCookie, dispose,
    ready: async (ids: readonly ModuleId[] = distribution.moduleIds) => until(() => status(), state => state.report !== undefined && ids.every(id => ['active', 'disabled', 'missing-dependency', 'conflict', 'failed'].includes(state.modules?.[id]?.phase)), 'root module admission') };
}
