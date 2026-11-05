import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { NativeDiscoveryFacade } from './discovery.ts';
import { isDeepStrictEqual } from 'node:util';
import { isMap, isSeq, parseDocument } from 'yaml';
import { inspectMigration } from './discovery.ts';
import { containsExpression, isRecord, planMigration, validateKnownConfig } from './planner.ts';
import { digest, profilePaths, readOptional, withProfileLock, writePrivate } from './storage.ts';
import type { Decision, Discovery, Distribution, MigrationPlan, MigrationReport, ModuleId, NativeMigrationHost, Values } from './types.ts';

interface Step { kind: 'target' | 'disable' | 'bundles'; before: string; after: string; done: boolean }
interface JournalEnvironment { identity: string; files: { path: string; hash: string | null }[]; paths: string[] }
interface RollbackEvidence { packageDir?: string; files?: { path: string; hash: string }[]; patchPaths?: string[]; problem?: string }
interface Journal { rollbackEvidence?: Partial<Record<ModuleId, RollbackEvidence>>; environment?: JournalEnvironment; ownershipVersion?: 1; owners?: Partial<Record<ModuleId, string[]>>; schemaVersion: 1; operationId: string; profileId: string; targetRowId: string; runtimeObserved?: boolean; browserFenceFinalized?: boolean; browserReloadAfter?: number; origin: string; phase: 'prepared' | 'saved'; plan: MigrationPlan; steps: Step[]; backup: string; previous: Partial<Record<ModuleId, unknown>>; rollback?: Partial<Record<ModuleId, { origin: string; done: boolean; conflict?: string }>>; recoveryWrites?: { patchBefore: string; patchAfter: string; manifestBefore: string; manifestAfter: string; restoreModules?: ModuleId[] } }
/** Stable across HMR but different after a genuine process restart, without process-global state. */
const processOrigin = () => process.pid + ':' + performance.timeOrigin;
const document = (text: string) => {
  const doc = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] });
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error('profile patch must be a valid YAML sequence');
  return doc as typeof doc & { contents: import('yaml').YAMLSeq };
};
function targetIndex(doc: ReturnType<typeof document>, target: Distribution): number {
  return doc.contents!.items.findLastIndex((row, index) => isMap(row) && doc.getIn([index, 'id']) === target.rowId && !row.has('insert') && (!row.has('name') || doc.getIn([index, 'name']) === (target.packageName ?? target.rowId)));
}
function targetConfig(doc: ReturnType<typeof document>, target: Distribution, fallback: Values): { index: number; config: Values } {
  let index = targetIndex(doc, target);
  if (index < 0) { doc.add(doc.createNode({ id: target.rowId, name: target.packageName ?? target.rowId, config: fallback })); index = doc.contents!.items.length - 1; }
  const raw = doc.getIn([index, 'config'], true);
  const config = raw && 'toJSON' in Object(raw) ? (raw as { toJSON(): unknown }).toJSON() : raw;
  return { index, config: isRecord(config) ? config : structuredClone(fallback) };
}
function renderSteps(input: Discovery, plan: MigrationPlan, operationId: string): { steps: Step[]; previous: Journal['previous'] } {
  const targetRow = input.rows.find(row => row.id === plan.target.rowId && row.name === (plan.target.packageName ?? plan.target.rowId));
  if (!targetRow) throw new Error('Toolbox target row is not addressable in the active profile');
  const fallback = isRecord(targetRow.config) ? targetRow.config : {};
  if (containsExpression(fallback)) throw new Error('dynamic target configuration cannot be rewritten safely');
  const doc = document(input.patchText || '[]\n');
  const { index, config } = targetConfig(doc, plan.target, fallback);
  const modules = isRecord(config.modules) ? config.modules : {};
  const previous: Journal['previous'] = {};
  for (const decision of plan.decisions) if (decision.config && decision.phase !== 'conflict') { previous[decision.moduleId] = modules[decision.moduleId] ?? null; modules[decision.moduleId] = decision.config; }
  config.modules = modules;
  doc.setIn([index, 'config'], config);
  const imported = String(doc);
  for (const decision of plan.decisions) if (decision.source?.rowId && decision.phase === 'prepared') {
    // Native management semantics: a final literal override, not another insert.
    const node = doc.createNode({ id: decision.source.rowId, name: decision.source.moduleName ?? decision.source.packageName, disabled: true });
    node.commentBefore = 'dsh-toolbox-migration:' + operationId + ':' + decision.moduleId;
    doc.add(node);
  }
  const disabled = String(doc);
  const manifest = structuredClone(input.manifest);
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : {};
  const profile = isRecord(dsh.profile) ? dsh.profile : {};
  const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
  const removed = new Set(plan.decisions.filter(d => d.phase === 'prepared' && d.source?.bundleSelected).map(d => d.source!.bundleName ?? d.source!.packageName));
  profile.bundles = bundles.filter(name => !removed.has(String(name)));
  dsh.profile = profile; manifest.dsh = dsh;
  const manifestAfter = removed.size ? JSON.stringify(manifest, null, 2) + '\n' : input.manifestText;
  return { previous, steps: [
    { kind: 'target', before: input.patchText, after: imported, done: false },
    { kind: 'disable', before: imported, after: disabled, done: false },
    { kind: 'bundles', before: input.manifestText, after: manifestAfter, done: false },
  ] };
}
export interface ExecutionOptions { retry?: boolean; /** Fault injection at durable stage seams, never emitted in a report. */ checkpoint?: (stage: string) => void | Promise<void> }
async function loadJournal(host: NativeMigrationHost, target: Distribution): Promise<Journal | null> {
  const paths = await profilePaths(host, target.rowId);
  const text = await readOptional(paths.journal);
  if (!text) return null;
  const value = JSON.parse(text) as Journal;
  if (value.schemaVersion !== 1 || value.targetRowId !== target.rowId || !Array.isArray(value.steps)) throw new Error('unrecognized migration journal');
  return value;
}
function journalEnvironment(input: Discovery): JournalEnvironment {
  if (!input.environmentIdentity || !input.inputFiles) throw new Error('immutable discovery input evidence unavailable');
  const writable = new Set([join(input.profile.dir, 'package.json'), input.profile.patchPath]);
  return { identity: input.environmentIdentity, files: input.inputFiles.filter(file => !writable.has(file.path)), paths: input.inputFiles.map(file => file.path) };
}
/** Validate every participating input, not merely the two profile documents we own. */
async function validateJournalInputs(host: NativeMigrationHost, target: Distribution, journal: Journal): Promise<Discovery> {
  const current = await inspectMigration(host, target);
  const evidence = journal.environment;
  if (!evidence || !current.environmentIdentity || !current.inputFiles) throw new Error('journal has no immutable input evidence; unsafe retry refused');
  if (current.profileId !== journal.profileId || current.environmentIdentity !== evidence.identity) throw new Error('migration environment identity changed');
  const knownPaths = new Set(evidence.paths);
  if (current.inputFiles.some(file => !knownPaths.has(file.path))) throw new Error('migration input resolution changed');
  for (const file of evidence.files) {
    const value = await readOptional(file.path);
    if ((value === null ? null : digest(value)) !== file.hash) throw new Error('migration environment input changed');
  }
  // An interrupted write may be at its recorded before OR after image, never an arbitrary earlier stage.
  const paths = await profilePaths(host, target.rowId);
  const firstPending = journal.steps.findIndex(step => !step.done);
  const allowed = new Map<string, Set<string>>();
  for (let i = 0; i < journal.steps.length; i++) {
    const step = journal.steps[i]!;
    const path = step.kind === 'bundles' ? paths.manifest : paths.patch;
    if (!allowed.has(path)) allowed.set(path, new Set([step.before]));
    if (step.done) {
      if (firstPending >= 0 && i > firstPending) throw new Error('journal step ordering is invalid');
      allowed.set(path, new Set([step.after]));
    } else if (i === firstPending) allowed.get(path)!.add(step.after);
  }
  for (const [path, values] of allowed) if (!values.has(await readOptional(path) ?? '')) throw new Error('concurrent profile edit; migration paused without overwrite');
  if (current.problems.length) throw new Error('current profile ownership cannot be validated');
  for (const decision of journal.plan.decisions) {
    if (decision.phase === 'conflict') continue;
    if (current.moduleProblems?.[decision.moduleId]?.length || current.peers[decision.moduleId]?.length) throw new Error('current module ownership changed');
    const sources = current.sources.filter(source => source.moduleId === decision.moduleId);
    if (sources.some(source => source.problem) || sources.length !== (decision.source ? 1 : 0)) throw new Error('current legacy ownership changed');
    if (decision.source && (sources[0]!.packageName !== decision.source.packageName || sources[0]!.version !== decision.source.version || (sources[0]!.moduleName ?? sources[0]!.packageName) !== (decision.source.moduleName ?? decision.source.packageName))) throw new Error('current legacy identity or version changed');
    if (decision.config) { validateKnownConfig(decision.moduleId, decision.config); target.validateModule?.(decision.moduleId, decision.config); }
  }
  return current;
}
function liveLegacy(host: NativeMigrationHost, decision: Decision): boolean {
  if (!decision.source) return false;
  return [...host.loader.entries()].some(entry => (entry.options.name === (decision.source!.moduleName ?? decision.source!.packageName) || entry.options.id === decision.source!.rowId) && !!entry.fiber && (entry.fiber.state !== undefined || !!entry.fiber.inertia));
}
function plain(value: unknown): unknown {
  if (value && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') return plain((value as { get(): unknown }).get());
  if (Array.isArray(value)) return value.map(plain);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
  return value;
}
function runningModuleConfig(host: NativeMigrationHost, target: Distribution, id: ModuleId): Values | undefined {
  const entry = [...host.loader.entries()].find(value => value.options.id === target.rowId && value.options.name === (target.packageName ?? target.rowId));
  const root = plain(entry?.fiber?.effectiveConfig);
  const modules = isRecord(root) && isRecord(root.modules) ? root.modules : {};
  const value = host.moduleConfig?.(id) ?? modules[id];
  return isRecord(value) ? value : undefined;
}
export function moduleConfigAdopted(host: NativeMigrationHost, target: Distribution, id: ModuleId, desired: Values): boolean {
  const actual = runningModuleConfig(host, target, id);
  return !!actual && Object.entries(desired).every(([key, value]) => isDeepStrictEqual(actual[key], value));
}
function runningConfigMatches(host: NativeMigrationHost, journal: Journal, decision: Decision, current?: Discovery): boolean {
  const row = current?.rows.find(value => value.id === journal.targetRowId);
  const desiredRoot = isRecord(row?.config) ? row.config : {};
  const desiredModules = isRecord(desiredRoot.modules) ? desiredRoot.modules : {};
  const desired = desiredModules[decision.moduleId] ?? decision.config;
  return isRecord(desired) && moduleConfigAdopted(host, journal.plan.target, decision.moduleId, desired);
}
/** Register before any ready result can authorize mounting; keep previous owners until proven exited. */
async function observeOwners(host: NativeMigrationHost, journal: Journal, current: Discovery): Promise<void> {
  if (journal.ownershipVersion !== 1) return;
  const target = [...host.loader.entries()].find(entry => entry.options.id === journal.targetRowId && entry.options.name === (journal.plan.target.packageName ?? journal.targetRowId));
  if (!target?.fiber) return; // A CLI process is not a target runtime owner.
  let changed = journal.runtimeObserved !== true;
  journal.runtimeObserved = true;
  journal.owners ??= {};
  for (const decision of journal.plan.decisions) {
    if (!decision.config || decision.phase === 'conflict' || journal.rollback?.[decision.moduleId]?.done) continue;
    const actual = runningModuleConfig(host, journal.plan.target, decision.moduleId);
    const requested = current.explicit[decision.moduleId]?.enabled ?? decision.enabled;
    // Disabled startup owns no feature. An unknown config with an enabled request is conservative.
    if (actual?.enabled === false || actual?.enabled !== true && requested !== true) continue;
    const owners = journal.owners[decision.moduleId] ??= [];
    if (!owners.includes(processOrigin())) { owners.push(processOrigin()); changed = true; }
  }
  if (changed) {
    const paths = await profilePaths(host, journal.targetRowId);
    await writePrivate(paths.journal, JSON.stringify(journal) + '\n');
  }
}
function hasLiveOwners(journal: Journal, id: ModuleId): boolean {
  return (journal.owners?.[id] ?? []).some(owner => !originExited(owner));
}
/** Observe actual native ownership; persisted values are never proof of live application. */
export function reportJournal(host: NativeMigrationHost, journal: Journal, current?: Discovery): MigrationReport {
  const modules: MigrationReport['modules'] = {};
  for (const decision of journal.plan.decisions) {
    const id = decision.moduleId;
    if (journal.recoveryWrites) { modules[id] = { phase: 'prepared', ready: false, enabled: false, reason: 'recovery write replay requires explicit retry' }; continue; }
    if (journal.rollback?.[id]?.conflict) { modules[id] = { phase: 'conflict', enabled: false, ready: false, reason: journal.rollback[id]!.conflict }; continue; }
    if (journal.rollback?.[id]) { modules[id] = { phase: journal.rollback[id]!.done ? 'rolled-back' : 'restart-required', enabled: false, ready: false, reason: journal.rollback[id]!.done ? 'selectively restored legacy settings' : 'restart host, then repeat rollback to restore old ownership' }; continue; }
    const enabled = current?.explicit[id]?.enabled === undefined ? decision.enabled : current.explicit[id]!.enabled === true;
    if (current?.peers[id]?.length || current?.moduleProblems?.[id]?.length || current?.sources.some(source => source.moduleId === id && !!source.problem) || current?.problems.length) { modules[id] = { phase: 'conflict', ready: false, enabled, reason: 'current profile ownership changed; inspect before retry' }; continue; }
    if (!decision.source && current?.sources.some(source => source.moduleId === id && !source.disabled)) { modules[id] = { phase: 'conflict', ready: false, enabled, reason: 'new legacy ownership was added after migration' }; continue; }
    if (decision.phase === 'conflict') { modules[id] = { phase: 'conflict', ready: false, enabled: false, reason: decision.reason }; continue; }
    if (journal.phase !== 'saved') { modules[id] = { phase: 'prepared', ready: false, enabled, reason: 'migration interrupted; retry validates durable steps' }; continue; }
    if (decision.config && !runningConfigMatches(host, journal, decision, current)) { modules[id] = { phase: 'restart-required', ready: false, enabled, reason: 'running Toolbox configuration has not adopted imported settings' }; continue; }
    if (decision.source && journal.origin === processOrigin() && !host.handoverAcknowledged?.(id, decision.source)) { modules[id] = { phase: 'restart-required', ready: false, enabled, reason: 'native post-disposal configuration acknowledgment required' }; continue; }
    if (decision.source && journal.origin !== processOrigin() && journal.runtimeObserved && !originExited(journal.origin)) { modules[id] = { phase: 'restart-required', ready: false, enabled, reason: 'original profile host is still alive or cannot be verified stopped' }; continue; }
    if (decision.source && liveLegacy(host, decision)) { modules[id] = { phase: 'restart-required', ready: false, enabled, reason: 'legacy runtime has not stopped' }; continue; }
    if (decision.source && id === 'chime' && (!journal.browserFenceFinalized || journal.origin === processOrigin())) { modules[id] = { phase: 'restart-required', ready: false, enabled, reason: 'fresh host and page required to discard legacy audio work' }; continue; }
    if (decision.source && host.get?.('hmr') === undefined && journal.origin === processOrigin()) { modules[id] = { phase: 'restart-required', ready: false, enabled, reason: 'no native reload acknowledgment; restart required' }; continue; }
    modules[id] = { phase: decision.source ? 'applied' : 'fresh', ready: true, enabled };
  }
  return { browserReloadAfter: journal.browserReloadAfter, schemaVersion: 1, operationId: journal.operationId, profileId: journal.profileId, targetRowId: journal.targetRowId, modules, problems: [...journal.plan.problems] };
}
export async function dryRunMigration(host: NativeMigrationHost, target: Distribution): Promise<MigrationPlan> { return planMigration(await inspectMigration(host, target)); }
/** Persistence only. The host's existing file watcher owns all Loader/HMR reconciliation. */
export async function runMigration(host: NativeMigrationHost, target: Distribution, options: ExecutionOptions = {}): Promise<MigrationReport> {
  return withProfileLock(host, async () => {
    const paths = await profilePaths(host, target.rowId);
    const input = await inspectMigration(host, target);
    let journal = await loadJournal(host, target);
    if (journal && journal.profileId !== input.profileId) throw new Error('journal belongs to another profile');
    if (journal?.phase === 'saved') {
      await observeOwners(host, journal, input);
      // Finalize the page fence only on a genuinely fresh host, never a page opened during the old handover.
      if (journal.browserReloadAfter && !journal.browserFenceFinalized && performance.timeOrigin >= journal.browserReloadAfter && [...host.loader.entries()].some(entry => entry.options.id === target.rowId && !!entry.fiber) && (!journal.runtimeObserved || originExited(journal.origin))) {
        journal.browserReloadAfter = performance.timeOrigin;
        journal.browserFenceFinalized = true;
        await writePrivate(paths.journal, JSON.stringify(journal) + '\n');
      }
      return reportJournal(host, journal, input);
    }
    if (journal && !options.retry) return reportJournal(host, journal, input);
    if (!journal) {
      const plan = planMigration(input);
      // A conflict-only/fresh plan needs no writes, yet still has an inspectable report.
      if (!plan.legacyMode || plan.decisions.every(d => d.phase === 'conflict')) {
        const ephemeral: Journal = { schemaVersion: 1, operationId: randomUUID(), profileId: input.profileId, targetRowId: target.rowId, origin: processOrigin(), phase: 'saved', plan, steps: [], backup: '', previous: {} };
        return reportJournal(host, ephemeral, input);
      }
      const operationId = randomUUID();
      const rendered = renderSteps(input, plan, operationId);
      const backup = join(paths.root, operationId + '.backup.json');
      journal = { schemaVersion: 1, operationId, profileId: input.profileId, targetRowId: target.rowId, runtimeObserved: [...host.loader.entries()].some(entry => entry.options.id === target.rowId && !!entry.fiber), browserReloadAfter: plan.decisions.some(d => d.moduleId === 'chime' && d.source && d.phase === 'prepared') ? Date.now() : undefined, origin: processOrigin(), phase: 'prepared', environment: journalEnvironment(input), rollbackEvidence: await captureRollbackEvidence(host, plan), ownershipVersion: 1, owners: {}, plan: { ...plan, target: { ...target, validateModule: undefined } }, steps: rendered.steps, previous: rendered.previous, backup };
      await options.checkpoint?.('before-backup');
      await writePrivate(backup, JSON.stringify({ schemaVersion: 1, profileId: input.profileId, manifest: input.manifestText, patch: input.patchText }) + '\n');
      await options.checkpoint?.('after-backup');
      await writePrivate(paths.journal, JSON.stringify(journal) + '\n');
      await options.checkpoint?.('after-journal');
      if ((await inspectMigration(host, target)).revision !== input.revision) throw new Error('profile changed before migration commit');
    }
    await validateJournalInputs(host, target, journal);
    for (const step of journal.steps) {
      if (step.done) continue;
      const path = step.kind === 'bundles' ? paths.manifest : paths.patch;
      let actual = await readOptional(path) ?? '';
      if (actual !== step.before && actual !== step.after) throw new Error('concurrent profile edit; migration paused without overwrite');
      await options.checkpoint?.('before-' + step.kind);
      await validateJournalInputs(host, target, journal);
      actual = await readOptional(path) ?? '';
      if (actual !== step.before && actual !== step.after) throw new Error('concurrent profile edit; migration paused without overwrite');
      if (actual !== step.after) await writePrivate(path, step.after);
      await options.checkpoint?.('after-' + step.kind);
      step.done = true;
      await writePrivate(paths.journal, JSON.stringify(journal) + '\n');
    }
    journal.phase = 'saved';
    await writePrivate(paths.journal, JSON.stringify(journal) + '\n');
    await options.checkpoint?.('after-saved');
    const current = await inspectMigration(host, target);
    await observeOwners(host, journal, current);
    const report = reportJournal(host, journal, current);
    await writePrivate(join(paths.root, target.rowId + '.report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  });
}

const PEER_MODULES: Record<string, readonly ModuleId[]> = {
  'dsh-toolbox': ['context', 'retry', 'chime', 'goalWait'],
  'dsh-toolbox-context': ['context'], 'dsh-toolbox-retry': ['retry'],
  'dsh-toolbox-chime': ['chime'], 'dsh-toolbox-goal-wait': ['goalWait'],
};
async function rollbackNative(host: NativeMigrationHost): Promise<NativeDiscoveryFacade> {
  return host.nativeMigration ?? await import(pathToFileURL(createRequire(host.profileContext.installAnchor).resolve('@deepseek-ai/dsh-app-boot')).href) as NativeDiscoveryFacade;
}
async function sourcePackage(host: NativeMigrationHost, decision: Decision, native: NativeDiscoveryFacade) {
  const source = decision.source!;
  const specifier = source.bundleName ?? source.moduleName ?? source.packageName;
  let dir: string;
  if (specifier.startsWith('file:') || isAbsolute(specifier)) {
    dir = dirname(specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier);
    while (await readOptional(join(dir, 'package.json')) === null) {
      if (dirname(dir) === dir) throw new Error('source package unavailable');
      dir = dirname(dir);
    }
  } else {
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
    dir = native.resolveBundleDir('dsh-toolbox rollback', name, host.profileContext.installAnchor, host.profileContext.dir);
  }
  dir = await realpath(dir);
  const path = join(dir, 'package.json');
  const manifest = JSON.parse(await readOptional(path) ?? 'null') as Values | null;
  if (!manifest || manifest.name !== source.packageName || manifest.version !== source.version) throw new Error('source package identity or version changed');
  return { dir, path, manifest };
}
async function captureRollbackEvidence(host: NativeMigrationHost, plan: MigrationPlan): Promise<Partial<Record<ModuleId, RollbackEvidence>>> {
  const result: Partial<Record<ModuleId, RollbackEvidence>> = {};
  const native = await rollbackNative(host);
  for (const decision of plan.decisions) if (decision.source && decision.phase !== 'conflict') {
    try {
      const info = await sourcePackage(host, decision, native);
      const bundle = isRecord(info.manifest.dsh) && isRecord(info.manifest.dsh.bundle) ? info.manifest.dsh.bundle : undefined;
      const declared = typeof bundle?.patch === 'string' ? [bundle.patch] : bundle?.patch ?? [];
      if (!Array.isArray(declared) || declared.some(value => typeof value !== 'string')) throw new Error('source bundle paths unavailable');
      const patchPaths = await Promise.all(declared.map(value => realpath(join(info.dir, value as string))));
      const files = [];
      for (const path of [info.path, ...patchPaths]) {
        const text = await readOptional(path); if (text === null) throw new Error('source layer unavailable');
        files.push({ path, hash: digest(text) });
      }
      result[decision.moduleId] = { packageDir: info.dir, files, patchPaths };
    } catch { result[decision.moduleId] = { problem: 'original source provenance could not be recorded; automatic restoration refused' }; }
  }
  return result;
}
function ownedMarker(journal: Journal, id: ModuleId): string { return 'dsh-toolbox-migration:' + journal.operationId + ':' + id; }
function sourceRows(rows: unknown[], ancestors: string[] = []): { row: Values; ancestors: string[] }[] {
  return rows.flatMap(row => !isRecord(row) ? [] : [{ row, ancestors }, ...(row.group === true || row.name === 'cordis:group') && Array.isArray(row.config) ? sourceRows(row.config, [...ancestors, String(row.id ?? '')]) : []]);
}
async function peerJournalConflict(host: NativeMigrationHost, target: Distribution, id: ModuleId, profileId: string): Promise<string | undefined> {
  for (const [rowId, ids] of Object.entries(PEER_MODULES)) {
    if (rowId === target.rowId || !ids.includes(id)) continue;
    const paths = await profilePaths(host, rowId), text = await readOptional(paths.journal);
    if (text === null) continue;
    try {
      const peer = JSON.parse(text) as Journal;
      if (peer.schemaVersion !== 1 || peer.profileId !== profileId || peer.targetRowId !== rowId) return 'peer distribution ownership journal is ambiguous';
      if (peer.ownershipVersion !== 1 && peer.runtimeObserved && !originExited(peer.origin)) return 'peer distribution runtime ownership cannot be verified';
      const owners = peer.owners?.[id] ?? [];
      if (!Array.isArray(owners) || owners.some(origin => typeof origin !== 'string' || !originExited(origin))) return 'another profile host still owns this module through a peer distribution';
    } catch { return 'peer distribution ownership journal cannot be verified'; }
  }
  return undefined;
}
/** Inspect a fresh module ownership boundary; unrelated package/profile edits are allowed. */
async function rollbackConflict(host: NativeMigrationHost, target: Distribution, journal: Journal, decision: Decision, current: Discovery): Promise<string | undefined> {
  const id = decision.moduleId, source = decision.source;
  if (current.problems.length) return 'profile discovery is ambiguous; legacy restoration refused';
  if (current.moduleProblems?.[id]?.length) return current.moduleProblems[id]!.join('; ');
  if (current.peers[id]?.length) return 'another selected Toolbox distribution owns this module';
  for (const entry of host.loader.entries()) {
    const options = entry.options;
    if (options.id === target.rowId && options.name === (target.packageName ?? target.rowId)) continue;
    const ids = PEER_MODULES[options.name] ?? PEER_MODULES[options.id];
    if (ids?.includes(id) && entry.fiber && (entry.fiber.state !== undefined || entry.fiber.inertia)) return 'another live Toolbox distribution owns this module';
  }
  const remotePeer = await peerJournalConflict(host, target, id, current.profileId);
  if (remotePeer) return remotePeer;
  if (!source) return undefined;
  const candidates = current.sources.filter(value => value.moduleId === id);
  if (candidates.length !== 1 || candidates[0]!.problem) return 'current legacy source is ambiguous or unsupported';
  if (candidates[0]!.packageName !== source.packageName || candidates[0]!.version !== source.version) return 'legacy package identity or version changed';
  const evidence = journal.rollbackEvidence?.[id];
  if (!evidence?.packageDir || !evidence.files || !evidence.patchPaths) return evidence?.problem ?? 'journal lacks per-module source provenance; restoration refused';
  try {
    const native = await rollbackNative(host), info = await sourcePackage(host, decision, native);
    if (info.dir !== evidence.packageDir) return 'legacy source resolution changed';
    for (const file of evidence.files) {
      const text = await readOptional(file.path);
      if (text === null || digest(text) !== file.hash) return 'legacy source package or bundle configuration changed';
    }
    const profile = native.loadOverlayPatches('dsh-toolbox rollback', current.profile.patchPath);
    const homePath = join(current.profile.home, 'cordis.patch.yml');
    const home = await readOptional(homePath) === null ? [] : native.loadOverlayPatches('dsh-toolbox rollback', homePath);
    const higher = [...home, ...current.profile.overlays ?? []];
    let base: unknown[] = current.rows;
    if (source.bundleSelected) {
      const patches = evidence.patchPaths.flatMap(path => native.loadOverlayPatches('dsh-toolbox rollback', path));
      base = native.composeEntries([patches, profile]);
    }
    const matches = sourceRows(base).filter(value => value.row.id === source.rowId && value.row.name === (source.moduleName ?? source.packageName));
    if (source.rowId && matches.length !== 1) return 'legacy source row identity or instance count changed';
    const ids = new Set([source.rowId, ...matches.flatMap(value => value.ancestors)]);
    if (higher.some(value => isRecord(value) && (ids.has(String(value.id ?? '')) || Array.isArray(value.insert) && sourceRows(value.insert).some(child => ids.has(String(child.row.id ?? '')))))) return 'higher-priority HOME or launcher overlay controls the legacy source';
    const config = source.rowId ? matches[0]!.row.config ?? {} : candidates[0]!.effective;
    if (!isRecord(config) || containsExpression(config)) return 'legacy source configuration is dynamic or malformed';
    validateKnownConfig(id, config);
    if (!isDeepStrictEqual(config, source.effective)) return 'legacy source configuration changed after migration';
  } catch { return 'legacy source provenance or configuration could not be verified'; }
  return undefined;
}

function markerIndex(doc: ReturnType<typeof document>, journal: Journal, decision: Decision): number {
  const source = decision.source;
  if (!source?.rowId) return -1;
  return doc.contents.items.findLastIndex((row, i) => isMap(row) && row.commentBefore === ownedMarker(journal, decision.moduleId) && row.items.length === 3 &&
    doc.getIn([i, 'id']) === source.rowId && doc.getIn([i, 'name']) === (source.moduleName ?? source.packageName) && doc.getIn([i, 'disabled']) === true);
}
function restoreIntent(journal: Journal): ModuleId[] {
  const writes = journal.recoveryWrites!;
  if (writes.restoreModules) return writes.restoreModules;
  // Older recovery intents have no explicit module list. Infer only the owned enabling deltas.
  const before = document(writes.patchBefore), after = document(writes.patchAfter);
  const bundles = (text: string): string[] => JSON.parse(text).dsh?.profile?.bundles ?? [];
  const beforeBundles = bundles(writes.manifestBefore), afterBundles = bundles(writes.manifestAfter);
  return journal.plan.decisions.filter(decision => journal.rollback?.[decision.moduleId]?.done &&
    (markerIndex(before, journal, decision) >= 0 && markerIndex(after, journal, decision) < 0 ||
      decision.source?.bundleSelected && !beforeBundles.includes(decision.source.bundleName ?? decision.source.packageName) && afterBundles.includes(decision.source.bundleName ?? decision.source.packageName)))
    .map(decision => decision.moduleId);
}
/** Rebase only exact owned restore deltas; never replay an old whole-profile enabling image. */
async function rebaseRecovery(host: NativeMigrationHost, target: Distribution, journal: Journal, ids: ModuleId[]): Promise<void> {
  const current = await inspectMigration(host, target), old = journal.recoveryWrites!;
  const doc = document(current.patchText), manifest = structuredClone(current.manifest);
  const { config } = targetConfig(doc, target, {});
  const modules = isRecord(config.modules) ? config.modules : {};
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : {}, profile = isRecord(dsh.profile) ? dsh.profile : {};
  let bundles = Array.isArray(profile.bundles) ? [...profile.bundles] : [];
  for (const id of ids) {
    const decision = journal.plan.decisions.find(value => value.moduleId === id);
    if (!decision?.config || !journal.rollback?.[id]) throw new Error('unrecognized recovery restore intent');
    if (!isDeepStrictEqual(modules[id], { ...decision.config, enabled: false })) throw new Error('newer module edit prevents recovery replay');
    const state = journal.rollback[id]!;
    const conflict = hasLiveOwners(journal, id) ? 'current target runtime owner has not stopped; restoration refused' : await rollbackConflict(host, target, journal, decision, current);
    const matching = markerIndex(doc, journal, decision), source = decision.source;
    if (conflict) {
      state.done = false; state.conflict = conflict;
      if (source?.rowId && matching < 0) {
        // A crash may have removed our marker before enabling its bundle. Restore that exact
        // owned disable operation, but do not guess after an unrelated patch edit.
        if (current.patchText !== old.patchAfter) throw new Error('legacy override changed during recovery; restoration refused');
        const row = doc.createNode({ id: source.rowId, name: source.moduleName ?? source.packageName, disabled: true });
        row.commentBefore = ownedMarker(journal, id); doc.add(row);
      }
      if (source?.bundleSelected) bundles = bundles.filter(name => name !== (source.bundleName ?? source.packageName));
      continue;
    }
    delete state.conflict;
    if (source?.rowId) {
      if (matching >= 0) doc.deleteIn([matching]);
      else if (current.patchText !== old.patchAfter) throw new Error('legacy override changed during recovery; restoration refused');
    }
    if (source?.bundleSelected && !bundles.includes(source.bundleName ?? source.packageName)) bundles.push(source.bundleName ?? source.packageName);
    state.done = true;
  }
  config.modules = modules;
  // Marker deletion shifts indices; resolve the existing target override again.
  doc.setIn([targetIndex(doc, target), 'config'], config);
  profile.bundles = bundles; dsh.profile = profile; manifest.dsh = dsh;
  journal.recoveryWrites = { patchBefore: current.patchText, patchAfter: String(doc), manifestBefore: current.manifestText,
    manifestAfter: JSON.stringify(manifest, null, 2) + '\n', restoreModules: ids };
  const paths = await profilePaths(host, target.rowId);
  await writePrivate(paths.journal, JSON.stringify(journal) + '\n');
}
async function finishRecovery(host: NativeMigrationHost, target: Distribution, journal: Journal, attempt = 0): Promise<void> {
  const paths = await profilePaths(host, target.rowId), ids = restoreIntent(journal);
  if (ids.length) await rebaseRecovery(host, target, journal, ids);
  const writes = journal.recoveryWrites!;
  for (const [path, before, after] of [[paths.patch, writes.patchBefore, writes.patchAfter], [paths.manifest, writes.manifestBefore, writes.manifestAfter]]) {
    if (ids.length) {
      const fresh = await inspectMigration(host, target);
      let changed = false;
      for (const id of ids) if (journal.rollback?.[id]?.done) {
        const decision = journal.plan.decisions.find(value => value.moduleId === id)!;
        if (hasLiveOwners(journal, id) || await rollbackConflict(host, target, journal, decision, fresh)) changed = true;
      }
      if (changed) {
        if (attempt >= 2) throw new Error('ownership changed repeatedly during recovery; restore refused');
        return finishRecovery(host, target, journal, attempt + 1);
      }
    }
    const current = await readOptional(path) ?? '';
    if (current !== before && current !== after) throw new Error('newer edit prevents recovery replay');
    if (current !== after) await writePrivate(path, after);
  }
  delete journal.recoveryWrites;
  await writePrivate(paths.journal, JSON.stringify(journal) + '\n');
}
function originExited(origin: string): boolean {
  const pid = Number(origin.split(':')[0]);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/** Selective two-stage recovery. New ownership is disabled before any old owner may return. */
export async function rollbackMigration(host: NativeMigrationHost, target: Distribution, options: { operationId: string; modules: readonly ModuleId[] }): Promise<MigrationReport> {
  return withProfileLock(host, async () => {
    const journal = await loadJournal(host, target);
    const input = await inspectMigration(host, target);
    if (!journal || journal.operationId !== options.operationId || journal.profileId !== input.profileId) throw new Error('unknown migration operation for this profile');
    if (journal.phase !== 'saved') throw new Error('finish or explicitly repair interrupted migration before selective rollback');
    if (journal.ownershipVersion !== 1) throw new Error('journal has no complete target owner registry; recovery refused');
    await observeOwners(host, journal, input);
    if (journal.recoveryWrites) { await finishRecovery(host, target, journal); return reportJournal(host, journal); }
    const paths = await profilePaths(host, target.rowId);
    const doc = document(input.patchText);
    const { index, config } = targetConfig(doc, target, {});
    const values = isRecord(config.modules) ? config.modules : {};
    journal.rollback ??= {};
    for (const id of options.modules) {
      const decision = journal.plan.decisions.find(d => d.moduleId === id);
      if (!decision?.config || decision.phase === 'conflict') throw new Error('module was not imported by this operation');
      const pending = journal.rollback[id];
      const expected = pending ? { ...decision.config, enabled: false } : decision.config;
      if (!pending?.done && !isDeepStrictEqual(values[id], expected)) throw new Error('newer module edit prevents rollback');
      if (!pending) {
        journal.rollback[id] = { origin: (journal.owners?.[id] ?? []).includes(processOrigin()) ? processOrigin() : '', done: false };
        values[id] = { ...decision.config, enabled: false };
      }
      const state = journal.rollback[id]!;
      if (!state.done) {
        const conflict = await rollbackConflict(host, target, journal, decision, input);
        if (conflict) { state.conflict = conflict; continue; }
        delete state.conflict;
      }
      if (pending && !pending.done && !hasLiveOwners(journal, id)) {
        // Only remove this operation's literal disabled override, preserving any later rows.
        if (decision.source?.rowId) {
          const rows = doc.contents!.items;
          const matching = rows.findLastIndex((row, i) => isMap(row) && doc.getIn([i, 'id']) === decision.source!.rowId && doc.getIn([i, 'name']) === (decision.source!.moduleName ?? decision.source!.packageName) && doc.getIn([i, 'disabled']) === true && row.items.length === 3 && row.commentBefore === 'dsh-toolbox-migration:' + journal.operationId + ':' + id);
          if (matching < 0) throw new Error('legacy override changed; rollback refused');
          doc.deleteIn([matching]);
        }
        pending.done = true;
      }
    }
    config.modules = values;
    // Locate again: removing a legacy row may shift indices.
    doc.setIn([targetIndex(doc, target), 'config'], config);
    const manifestBefore = await readOptional(paths.manifest) ?? '{}';
    const manifest = JSON.parse(manifestBefore) as Values;
    const dsh = isRecord(manifest.dsh) ? manifest.dsh : {};
    const profile = isRecord(dsh.profile) ? dsh.profile : {};
    const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
    for (const id of options.modules) {
      const decision = journal.plan.decisions.find(d => d.moduleId === id);
      if (journal.rollback[id]?.done && decision?.source?.bundleSelected && !bundles.includes(decision.source.bundleName ?? decision.source.packageName)) bundles.push(decision.source.bundleName ?? decision.source.packageName);
    }
    profile.bundles = bundles; dsh.profile = profile; manifest.dsh = dsh;
    journal.recoveryWrites = { patchBefore: input.patchText, patchAfter: String(doc), manifestBefore, manifestAfter: JSON.stringify(manifest, null, 2) + '\n', restoreModules: options.modules.filter(id => journal.rollback?.[id]?.done) };
    await writePrivate(paths.journal, JSON.stringify(journal) + '\n');
    await finishRecovery(host, target, journal);
    return reportJournal(host, journal);
  });
}
