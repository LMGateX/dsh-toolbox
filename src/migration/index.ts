import { dryRunMigration, moduleConfigAdopted, rollbackMigration, runMigration } from './engine.ts';
import type { BootstrapOptions, MigrationController, MigrationReport, MigrationState, NativeMigrationHost } from './types.ts';
export * from './types.ts';
export { inspectMigration } from './discovery.ts';
export { planMigration, LEGACY_DEFAULTS, LEGACY_PACKAGES } from './planner.ts';
export { dryRunMigration, runMigration, rollbackMigration } from './engine.ts';

/**
 * Synchronous bootstrap. apply must return without awaiting settled.
 * Timers here never call HMR/configEditor/pluginManager; native watchers own reloads.
 * Disposal cancels observers only, not an already-journaled persistence commit.
 */
export function startAutomaticMigration(host: NativeMigrationHost, options: BootstrapOptions): MigrationController {
  let state: MigrationState = { modules: Object.fromEntries(options.moduleIds.map(id => [id, { phase: 'pending', ready: false, enabled: false }])) };
  const listeners = new Set<(state: MigrationState) => void>();
  let closed = false;
  let acknowledged: { id: string; name: string; fiber: boolean }[] | undefined;
  const nativeHost: NativeMigrationHost = Object.create(host) as NativeMigrationHost;
  nativeHost.handoverAcknowledged = (id, source) => host.handoverAcknowledged?.(id, source) ?? (acknowledged !== undefined && !acknowledged.some(entry => entry.fiber && (entry.name === (source.moduleName ?? source.packageName) || entry.id === source.rowId)));
  let active: Promise<MigrationReport> | undefined;
  let refreshRequested = false;
  const lastEnabled = new Map(options.moduleIds.map(id => [id, moduleConfigAdopted(host, options, id, { enabled: true })]));
  const enableRevision = new Map(options.moduleIds.map(id => [id, 0]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (report: MigrationReport) => void;
  const settled = new Promise<MigrationReport>(done => { resolve = done; });
  const publish = (report: MigrationReport) => {
    if (!closed) {
      state = { modules: report.modules, report };
      for (const listener of listeners) { try { listener(structuredClone(state)); } catch { host.logger?.warn('Toolbox migration observer failed'); } }
      options.onReport?.(report);
    }
    return report;
  };
  const failure = (): MigrationReport => ({ schemaVersion: 1, operationId: '', profileId: '', targetRowId: options.rowId,
    modules: Object.fromEntries(options.moduleIds.map(id => [id, { phase: 'failed', ready: false, enabled: false, reason: 'migration failed closed; inspect private journal and retry' }])), problems: ['migration could not complete safely'] });
  const notify = () => {
    for (const listener of listeners) { try { listener(structuredClone(state)); } catch { host.logger?.warn('Toolbox migration observer failed'); } }
  };
  /** Root state reads and native notifications share this synchronous admission fence. */
  const invalidateEnabledTransitions = () => {
    if (closed) return false;
    let changed = false;
    const modules = { ...state.modules };
    for (const id of options.moduleIds) {
      const enabled = moduleConfigAdopted(host, options, id, { enabled: true });
      const previous = lastEnabled.get(id);
      lastEnabled.set(id, enabled);
      if (!enabled || previous) continue;
      changed = true;
      enableRevision.set(id, enableRevision.get(id)! + 1);
      if (modules[id]?.ready) modules[id] = { ...modules[id]!, phase: 'pending', ready: false, reason: 'enabled target ownership registration pending' };
    }
    if (changed) {
      state = { ...state, modules, report: state.report ? { ...state.report, modules } : undefined };
      notify();
    }
    return changed;
  };
  const refresh = () => { if (!closed) { if (active) refreshRequested = true; else void execute(); } };
  const execute = (retry = false) => {
    if (active) return active;
    const scannedEnableRevision = new Map(enableRevision);
    active = (options.auto === false ? dryRunMigration(host, options).then(plan => ({ schemaVersion: 1 as const, operationId: '', profileId: plan.profileId, targetRowId: options.rowId,
      modules: Object.fromEntries(plan.decisions.map(d => {
        const adopted = !!d.config && moduleConfigAdopted(host, options, d.moduleId, d.config);
        const ready = !d.source && d.phase !== 'conflict' && adopted;
        return [d.moduleId, { phase: d.source ? 'pending' : d.phase === 'conflict' ? 'conflict' : ready ? d.phase : 'restart-required', ready, enabled: d.enabled, reason: d.phase === 'conflict' ? d.reason : d.source ? 'automatic migration disabled' : !adopted ? 'running Toolbox configuration has not adopted planned settings' : d.reason }];
      })), problems: plan.problems })) : runMigration(nativeHost, options, { retry }))
      .then(report => {
        invalidateEnabledTransitions();
        const modules = { ...report.modules };
        for (const id of options.moduleIds) {
          if (scannedEnableRevision.get(id) === enableRevision.get(id)) continue;
          refreshRequested = true;
          if (modules[id]?.ready) modules[id] = { ...modules[id]!, phase: 'pending', ready: false, reason: 'enabled target ownership registration pending' };
        }
        return publish({ ...report, modules });
      }).catch(() => { host.logger?.warn('Toolbox automatic migration failed closed; inspect and retry'); return publish(failure()); }).finally(() => { active = undefined; if (refreshRequested && !closed) { refreshRequested = false; queueMicrotask(() => { void execute(); }); } });
    return active;
  };
  const launch = () => {
    timer = setTimeout(() => { if (closed) { resolve(failure()); return; } void execute().then(report => {
      resolve(report);
      // A bounded observation window catches native teardown after the file watcher runs.
      let remaining = 25;
      const observe = () => {
        if (closed || remaining-- <= 0 || options.auto === false) return;
        if (!Object.entries(state.modules).some(([id, value]) => id !== 'chime' && value?.phase === 'restart-required')) return;
        timer = setTimeout(() => { void execute().then(observe); }, 200);
        timer.unref?.();
      };
      observe();
    }); }, 0);
    timer.unref?.();
  };
  const unacknowledge = host.on?.('app-boot/config-reload', () => {
    // Capture synchronously at the native post-disposal event, not after an async file read.
    acknowledged = [...host.loader.entries()].map(entry => ({ id: entry.options.id, name: entry.options.name, fiber: !!entry.fiber }));
    invalidateEnabledTransitions(); refresh();
  });
  const unvolatile = host.on?.('loader/volatile-update', () => {
    invalidateEnabledTransitions(); refresh();
  });
  const unready = host.appReady?.onReady(launch);
  if (!host.appReady) launch();
  return {
    state: () => { if (invalidateEnabledTransitions()) refresh(); return structuredClone(state); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    settled,
    inspect: () => dryRunMigration(host, options),
    retry: () => execute(true),
    async rollback(input) {
      // Close local feature gates before staging persistent recovery.
      state = { ...state, modules: { ...state.modules } };
      for (const id of input.modules) state.modules[id] = { phase: 'pending', ready: false, enabled: false, reason: 'selective recovery requested' };
      for (const listener of listeners) listener(structuredClone(state));
      return publish(await rollbackMigration(host, options, input));
    },
    dispose() { closed = true; unready?.(); unacknowledge?.(); unvolatile?.(); if (timer) clearTimeout(timer); listeners.clear(); resolve(failure()); },
  };
}
