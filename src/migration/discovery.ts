import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Discovery, Distribution, ModuleId, NativeMigrationHost, Source, Values } from './types.ts';

/** Only these read-only native operations are admitted. Never load legacy plugin code. */
export interface NativeDiscoveryFacade {
  resolveBundleDir(binName: string, packageName: string, installAnchor: string, profileDir: string): string;
  loadOverlayPatches(binName: string, file: string): unknown[];
  composeEntries(layers: unknown[][], warn?: (message: string) => void): Values[];
}

const LEGACY: Record<ModuleId, string> = {
  context: 'dsh-tool-compact-context', retry: 'dsh-stream-retry',
  chime: 'dsh-session-chime', goalWait: 'dsh-goal-wait-gate',
};
const KNOWN_VERSIONS: Record<ModuleId, string> = { context: '0.4.7', retry: '0.1.9', chime: '0.6.0', goalWait: '0.3.0' };
const OLD_ROWS: Record<ModuleId, string[]> = {
  context: ['dsh-tool-compact-context'], retry: ['stream-retry'],
  chime: ['dsh-session-chime', 'session-chime'], goalWait: ['goal-wait-gate'],
};
const DISTRIBUTIONS: Record<string, readonly ModuleId[]> = {
  'dsh-toolbox': ['context', 'retry', 'chime', 'goalWait'],
  'dsh-toolbox-context': ['context'], 'dsh-toolbox-retry': ['retry'],
  'dsh-toolbox-chime': ['chime'], 'dsh-toolbox-goal-wait': ['goalWait'],
};
const record = (value: unknown): value is Values => !!value && typeof value === 'object' && !Array.isArray(value);
function expression(value: unknown, seen = new Set<unknown>()): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, child]) => key === '__jsExpr' || expression(child, seen));
}
function own(value: unknown, key: string): unknown {
  // In particular, never invoke LoaderEntry.disabled or interpolated config getters.
  return value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}
interface Row { value: Values; disabled: boolean; dynamic: boolean; ancestors: string[] }
function flatten(rows: unknown[], disabled = false, dynamic = false, ancestors: string[] = []): Row[] {
  return rows.flatMap(value => {
    if (!record(value)) throw new Error('composed loader row must be an object');
    const blocked = disabled || value.disabled === true;
    const uncertain = dynamic || expression(value.disabled);
    const row = { value, disabled: blocked, dynamic: uncertain, ancestors };
    if (value.group === true || value.name === 'cordis:group') {
      if (!Array.isArray(value.config)) return [row];
      return [row, ...flatten(value.config, blocked, uncertain, [...ancestors, String(value.id ?? '')])];
    }
    return [row];
  });
}
function patchesTouch(patches: unknown[], ids: Set<string>): boolean {
  return patches.some(patch => record(patch) && (ids.has(String(patch.id ?? '')) ||
    Array.isArray(patch.insert) && flatten(patch.insert).some(row => ids.has(String(row.value.id ?? '')))));
}
function overrideConfig(patches: unknown[], rowId: string, name?: string): unknown {
  let config: unknown;
  for (const patch of patches) {
    if (!record(patch)) continue;
    if (Array.isArray(patch.insert)) for (const row of flatten(patch.insert)) {
      if (row.value.id === rowId) config = row.value.config;
    }
    if (Array.isArray(patch.config) && patch.config.every(record)) for (const row of flatten(patch.config)) {
      if (row.value.id === rowId) config = row.value.config;
    }
    if (patch.id === rowId && Object.hasOwn(patch, 'config') && !patch.insert && (!patch.name || !name || patch.name === name)) config = patch.config;
  }
  return config;
}
function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }

/** Inspect only the active profile. All configuration remains inert, detached raw data. */
export async function inspectMigration(host: NativeMigrationHost, target: Distribution): Promise<Discovery> {
  const input = host.profileContext;
  const profile = { ...input, dir: await realpath(input.dir), patchPath: resolve(input.patchPath),
    installAnchor: await realpath(input.installAnchor), home: await realpath(input.home) };
  const profileId = createHash('sha256').update(profile.dir).digest('hex');
  const texts = new Map<string, string | null>();
  const problems: string[] = [];
  const moduleProblems: Partial<Record<ModuleId, string[]>> = {};
  const addProblem = (ids: readonly ModuleId[], reason: string) => {
    for (const id of ids) (moduleProblems[id] ??= []).push(reason);
  };
  const text = async (path: string, optional = false): Promise<string> => {
    if (texts.has(path)) return texts.get(path) ?? '';
    try { const value = await readFile(path, 'utf8'); texts.set(path, value); return value; }
    catch (error) { if (!optional || errorCode(error) !== 'ENOENT') throw error; texts.set(path, null); return ''; }
  };
  const json = async (path: string): Promise<Values> => {
    const value: unknown = JSON.parse(await text(path));
    if (!record(value)) throw new Error('package manifest must be a JSON object');
    return value;
  };
  const manifestPath = join(profile.dir, 'package.json');
  const manifestText = await text(manifestPath);
  const manifest = await json(manifestPath);
  const patchText = await text(profile.patchPath, true);
  let facade = (host as NativeMigrationHost & { nativeMigration?: NativeDiscoveryFacade }).nativeMigration;
  if (!facade) {
    const helperPath = createRequire(profile.installAnchor).resolve('@deepseek-ai/dsh-app-boot');
    const native = await import(pathToFileURL(helperPath).href) as NativeDiscoveryFacade;
    facade = native;
    // Include the actual native helper version/code identity in the input revision.
    await text(helperPath);
    const helperManifest = createRequire(profile.installAnchor).resolve('@deepseek-ai/dsh-app-boot/package.json');
    await text(helperManifest);
  }
  for (const key of ['resolveBundleDir', 'loadOverlayPatches', 'composeEntries'] as const) {
    if (typeof facade[key] !== 'function') throw new Error('read-only native migration helper unavailable: ' + key);
  }
  const native = facade;
  const layer = async (path: string, optional = false): Promise<unknown[]> => {
    await text(path, optional);
    return texts.get(path) === null ? [] : native.loadOverlayPatches('dsh-toolbox migration', path);
  };
  const dsh = record(manifest.dsh) ? manifest.dsh : {};
  const settings = record(dsh.profile) ? dsh.profile : {};
  const selected = settings.bundles ?? [];
  if (!Array.isArray(selected) || selected.some(name => typeof name !== 'string')) throw new Error('dsh.profile.bundles must be a string array');
  const bundles = selected as string[];
  const packageCache = new Map<string, { dir: string; manifest: Values } | undefined>();
  const metadata = async (name: string): Promise<{ dir: string; manifest: Values } | undefined> => {
    if (packageCache.has(name)) return packageCache.get(name);
    try {
      let dir: string;
      if (name.startsWith('file:') || isAbsolute(name)) {
        let path = name.startsWith('file:') ? fileURLToPath(name) : name;
        dir = dirname(path);
        for (;;) {
          try { await text(join(dir, 'package.json')); break; }
          catch (error) { if (errorCode(error) !== 'ENOENT' || dirname(dir) === dir) throw error; dir = dirname(dir); }
        }
      } else {
        const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]!;
        dir = native.resolveBundleDir('dsh-toolbox migration', packageName, profile.installAnchor, profile.dir);
      }
      const result = { dir: await realpath(dir), manifest: await json(join(dir, 'package.json')) };
      packageCache.set(name, result);
      return result;
    } catch { packageCache.set(name, undefined); return undefined; }
  };
  const bundleLayers: unknown[][] = [];
  for (const name of bundles) {
    const info = await metadata(name);
    if (!info) {
      const id = (Object.keys(LEGACY) as ModuleId[]).find(id => LEGACY[id] === name);
      if (id) addProblem([id], 'cannot inspect selected legacy bundle: ' + name);
      else problems.push('cannot inspect selected bundle: ' + name);
      continue;
    }
    try {
      const packageDsh = record(info.manifest.dsh) ? info.manifest.dsh : {};
      const bundle = record(packageDsh.bundle) ? packageDsh.bundle : {};
      const paths = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch;
      if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) throw new Error('invalid dsh.bundle.patch');
      const patches: unknown[] = [];
      for (const path of paths as string[]) patches.push(...await layer(join(info.dir, path)));
      bundleLayers.push(patches);
    } catch {
      const id = (Object.keys(LEGACY) as ModuleId[]).find(id => LEGACY[id] === info.manifest.name);
      if (id) addProblem([id], 'cannot inspect legacy bundle patches: ' + name);
      else problems.push('cannot inspect selected bundle patches: ' + name);
    }
  }
  const profilePatches = await layer(profile.patchPath, true);
  const homePatches = await layer(join(profile.home, 'cordis.patch.yml'), true);
  const launcherPatches = structuredClone(input.overlays ?? []) as unknown[];
  const higher = [...homePatches, ...launcherPatches];
  const rows = native.composeEntries([...bundleLayers, profilePatches, homePatches, launcherPatches]);
  const flat = flatten(rows);
  if (flat.some(row => (row.value.group === true || row.value.name === 'cordis:group') && expression(row.value.config) && !Array.isArray(row.value.config))) problems.push('dynamic group configuration prevents safe owner discovery');
  const sources: Source[] = [];
  const peers: Partial<Record<ModuleId, string[]>> = {};
  const explicit: Partial<Record<ModuleId, Values>> = {};
  const targetName = flat.find(row => row.value.id === target.rowId)?.value.name;
  const targetConfig = overrideConfig(profilePatches, target.rowId, typeof targetName === 'string' ? targetName : target.packageName);
  if (record(targetConfig) && record(targetConfig.modules)) {
    for (const id of target.moduleIds) {
      if (record(targetConfig.modules[id])) explicit[id] = structuredClone(targetConfig.modules[id]) as Values;
      else if (Object.hasOwn(targetConfig.modules, id)) addProblem([id], 'target module configuration must be an object');
    }
  } else if (expression(targetConfig)) addProblem(target.moduleIds, 'dynamic target configuration is not imported');
  const live = [...host.loader.entries()];
  const active = (rowId: unknown, name: unknown): boolean => live.some(entry => {
    const options = own(entry, 'options');
    return own(options, 'id') === rowId && own(options, 'name') === name && own(own(entry, 'fiber'), 'state') === 2;
  });
  for (const row of flat) {
    const name = row.value.name;
    if (typeof name !== 'string' || row.value.group === true || name === 'cordis:group') continue;
    const info = await metadata(name);
    const identity = info?.manifest.name;
    const moduleId = (Object.keys(LEGACY) as ModuleId[]).find(id => LEGACY[id] === identity || !info && LEGACY[id] === name);
    const rowId = typeof row.value.id === 'string' ? row.value.id : undefined;
    const ids = new Set([...row.ancestors, rowId ?? '']);
    if (moduleId) {
      const rawConfig = rowId ? overrideConfig(profilePatches, rowId, name) : undefined;
      const reasons: string[] = [];
      if (!rowId) reasons.push('legacy instance has no stable row id');
      const rootName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
      if (moduleId === 'goalWait' && name !== rootName) reasons.push('unsupported custom startup entrypoint for goal wait');
      if (row.dynamic || expression(row.value.config)) reasons.push('dynamic legacy configuration is not imported');
      if (row.value.config != null && !record(row.value.config)) reasons.push('legacy configuration must be an object');
      if (patchesTouch(higher, ids)) reasons.push('higher-priority HOME or launcher overlay owns this legacy row');
      const version = typeof info?.manifest.version === 'string' ? info.manifest.version : undefined;
      if (version !== KNOWN_VERSIONS[moduleId]) reasons.push('unsupported legacy version: ' + (version ?? 'unknown'));
      const bundleName = bundles.find(bundle => bundle === name || identity !== undefined && packageCache.get(bundle)?.manifest.name === identity);
      sources.push({ moduleId, packageName: LEGACY[moduleId], moduleName: name, bundleName, version, rowId,
        raw: record(rawConfig) ? structuredClone(rawConfig) : {},
        effective: record(row.value.config) ? structuredClone(row.value.config) : {},
        disabled: row.disabled, active: active(rowId, name), bundleSelected: bundleName !== undefined,
        ...(reasons.length ? { problem: reasons.join('; ') } : {}) });
    }
    const distribution = typeof identity === 'string' ? DISTRIBUTIONS[identity] : DISTRIBUTIONS[name];
    if (distribution) {
      if (rowId === target.rowId && (identity === (target.packageName ?? 'dsh-toolbox') || name === target.packageName || name === target.rowId)) {
        if (row.dynamic) addProblem(target.moduleIds, 'dynamic target enablement is not migrated');
        if (record(row.value.config) && expression(row.value.config.modules)) {
          const modules = row.value.config.modules;
          if (record(modules)) for (const id of target.moduleIds) {
            if (expression(modules[id])) addProblem([id], 'dynamic target module configuration is not migrated');
          }
          else addProblem(target.moduleIds, 'dynamic target module configuration is not migrated');
        }
        if (patchesTouch(higher, ids)) addProblem(target.moduleIds, 'higher-priority HOME or launcher overlay owns the target row');
        continue;
      }
      const modules = record(row.value.config) && record(row.value.config.modules) ? row.value.config.modules : {};
      for (const id of distribution) {
        const config = modules[id];
        if ((!row.disabled && !(record(config) && config.enabled === false)) || active(rowId, name) || row.dynamic) {
          (peers[id] ??= []).push(rowId ?? name);
        }
      }
    }
  }
  // Installed, deselected legacy packages still establish migration mode and disabled state.
  // Do not use their shipped bundle config as live effective config: only persisted overrides apply.
  const dependencies = Object.assign({}, record(manifest.dependencies) ? manifest.dependencies : {}, record(manifest.optionalDependencies) ? manifest.optionalDependencies : {});
  for (const name of new Set([...Object.keys(dependencies), ...bundles])) {
    const info = await metadata(name);
    const moduleId = (Object.keys(LEGACY) as ModuleId[]).find(id => info?.manifest.name === LEGACY[id] || !info && name === LEGACY[id]);
    if (!moduleId || sources.some(source => source.moduleId === moduleId)) continue;
    const possibleIds = OLD_ROWS[moduleId];
    const configs = possibleIds.map(rowId => ({ rowId, value: overrideConfig([...profilePatches, ...higher], rowId) })).filter(item => item.value !== undefined);
    const config = configs[0];
    const version = typeof info?.manifest.version === 'string' ? info.manifest.version : undefined;
    const reasons: string[] = [];
    if (configs.length > 1) reasons.push('multiple legacy override instances require explicit recovery');
    if (expression(config?.value)) reasons.push('dynamic legacy configuration is not imported');
    if (version !== KNOWN_VERSIONS[moduleId]) reasons.push('unsupported legacy version: ' + (version ?? 'unknown'));
    sources.push({ moduleId, packageName: LEGACY[moduleId], moduleName: name, bundleName: bundles.includes(name) ? name : undefined, version, rowId: config?.rowId,
      raw: record(config?.value) ? structuredClone(config.value) : {}, effective: record(config?.value) ? structuredClone(config.value) : {},
      disabled: true, active: false, bundleSelected: bundles.includes(name), ...(reasons.length ? { problem: reasons.join('; ') } : {}) });
  }
  for (const id of Object.keys(LEGACY) as ModuleId[]) {
    const matches = sources.filter(source => source.moduleId === id);
    if (matches.length > 1) for (const source of matches) source.problem = [source.problem, 'multiple legacy instances require explicit recovery'].filter(Boolean).join('; ');
  }
  if (host.startupOwner && host.startupOwner !== 'native') addProblem(['goalWait'], 'unsupported custom startup owner: ' + host.startupOwner);
  const targetRows = flat.filter(row => row.value.id === target.rowId);
  if (targetRows.length === 0) addProblem(target.moduleIds, 'target row is absent from the active profile');
  for (const row of targetRows) {
    const info = typeof row.value.name === 'string' ? await metadata(row.value.name) : undefined;
    const expected = target.packageName ?? (DISTRIBUTIONS[target.rowId] ? target.rowId : 'dsh-toolbox');
    if (row.value.name !== expected && info?.manifest.name !== expected) addProblem(target.moduleIds, 'target row package identity does not match the requested distribution');
  }
  if (targetRows.length > 1) addProblem(target.moduleIds, 'multiple target instances require explicit recovery');
  const revision = createHash('sha256').update(JSON.stringify({ profileId, installAnchor: profile.installAnchor,
    files: [...texts].sort(([a], [b]) => a.localeCompare(b)), overlays: launcherPatches,
    target: { rowId: target.rowId, packageName: target.packageName, moduleIds: target.moduleIds }, startupOwner: host.startupOwner ?? null,
  })).digest('hex');
  const inputFiles = [...texts].map(([path, value]) => ({ path, hash: value === null ? null : createHash('sha256').update(value).digest('hex') }));
  const environmentIdentity = createHash('sha256').update(JSON.stringify({ profileId, installAnchor: profile.installAnchor, home: profile.home, overlays: launcherPatches, startupOwner: host.startupOwner ?? null, target: { rowId: target.rowId, packageName: target.packageName, moduleIds: target.moduleIds } })).digest('hex');
  return { profileId, profile, revision, manifest, patchText, manifestText, rows, sources, target, explicit, peers,
    problems, legacyMode: sources.length > 0, moduleProblems, inputFiles, environmentIdentity };
}
