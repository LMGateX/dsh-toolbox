import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMap, isSeq, parseDocument } from 'yaml';
import { inspectMigration } from './discovery.ts';
import { containsExpression, isRecord, planMigration, validateKnownConfig } from './planner.ts';
import { digest, profilePaths, readOptional, withProfileLock, writePrivate } from './storage.ts';
import type { Decision, Discovery, Distribution, MigrationPlan, MigrationReport, ModuleId, NativeMigrationHost, Values } from './types.ts';

interface Step { kind: 'target' | 'disable' | 'bundles'; before: string; after: string; done: boolean }
interface JournalEnvironment { identity: string; files: { path: string; hash: string | null }[]; paths: string[] }
interface Journal { environment?: JournalEnvironment; ownershipVersion?: 1; owners?: Partial<Record<ModuleId, string[]>>; schemaVersion: 1; operationId: string; profileId: string; targetRowId: string; runtimeObserved?: boolean; browserFenceFinalized?: boolean; browserReloadAfter?: number; origin: string; phase: 'prepared' | 'saved'; plan: MigrationPlan; steps: Step[]; backup: string; previous: Partial<Record<ModuleId, unknown>>; rollback?: Partial<Record<ModuleId, { origin: string; done: boolean }>>; recoveryWrites?: { patchBefore: string; patchAfter: string; manifestBefore: string; manifestAfter: string } }
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
      journal = { schemaVersion: 1, operationId, profileId: input.profileId, targetRowId: target.rowId, runtimeObserved: [...host.loader.entries()].some(entry => entry.options.id === target.rowId && !!entry.fiber), browserReloadAfter: plan.decisions.some(d => d.moduleId === 'chime' && d.source && d.phase === 'prepared') ? Date.now() : undefined, origin: processOrigin(), phase: 'prepared', environment: journalEnvironment(input), ownershipVersion: 1, owners: {}, plan: { ...plan, target: { ...target, validateModule: undefined } }, steps: rendered.steps, previous: rendered.previous, backup };
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
async function finishRecovery(host: NativeMigrationHost, target: Distribution, journal: Journal): Promise<void> {
  const paths = await profilePaths(host, target.rowId);
  const writes = journal.recoveryWrites!;
  if (Object.entries(journal.rollback ?? {}).some(([id, state]) => state?.done && hasLiveOwners(journal, id as ModuleId))) throw new Error('current target owner has not stopped; recovery replay refused');
  for (const [path, before, after] of [[paths.patch, writes.patchBefore, writes.patchAfter], [paths.manifest, writes.manifestBefore, writes.manifestAfter]]) {
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
      } else if (!pending.done && !hasLiveOwners(journal, id)) {
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
    journal.recoveryWrites = { patchBefore: input.patchText, patchAfter: String(doc), manifestBefore, manifestAfter: JSON.stringify(manifest, null, 2) + '\n' };
    await writePrivate(paths.journal, JSON.stringify(journal) + '\n');
    await finishRecovery(host, target, journal);
    return reportJournal(host, journal);
  });
}
