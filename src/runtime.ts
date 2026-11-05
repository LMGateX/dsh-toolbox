import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createConfig, plain, validateModule } from './config.ts';
import { startAutomaticMigration } from './migration/index.ts';
import type { MigrationController, NativeMigrationHost } from './migration/types.ts';
import type { Distribution, ModuleId, ModuleState } from './types.ts';

interface RunningModule { fiber: Fiber; fingerprint: string }

/** One product shell; feature policy stays in independently disposed child fibers. */
export function createToolboxPlugin(distribution: Distribution) {
  return {
    name: distribution.name,
    inject: [],
    Config: createConfig(distribution),
    apply(ctx: Context, config: Record<string, any>) {
      const log = ctx.logger(distribution.name);
      const scopes = new Map<ModuleId, RunningModule>();
      const statuses: Partial<Record<ModuleId, ModuleState>> = {};
      let closed = false;
      let queue: Promise<void> = Promise.resolve();
      let controller: MigrationController;
      let unsubscribe = () => {};
      const root = ctx as unknown as Record<string, any>;
      const moduleConfig = (id: ModuleId) => plain<Record<string, unknown>>(config.modules?.[id] ?? {});
      const get = (name: string) => ctx.get(name);
      const migrationHost = {
        profileContext: root.profileContext,
        loader: root.loader,
        appReady: get('appReady'),
        get,
        logger: log,
        moduleConfig,
      } as NativeMigrationHost;

      const setFiberState = (id: ModuleId, fiber: Fiber) => {
        if (closed || scopes.get(id)?.fiber !== fiber) return;
        if (fiber.state === 2) statuses[id] = {phase: 'active'};
        else if (fiber.state === 0) {
          const dependencies = Object.keys(fiber.inject).filter(key => !get(key));
          statuses[id] = {phase: 'missing-dependency', reason: 'Waiting for services: ' + dependencies.join(', ')};
        } else if (fiber.state === 3) statuses[id] = {phase: 'failed', reason: 'Feature activation failed; inspect the host log.'};
        else statuses[id] = {phase: 'migration-pending', reason: 'Feature lifecycle transition in progress.'};
      };

      const reconcile = async () => {
        if (closed) return;
        const migration = controller.state();
        for (const id of distribution.moduleIds) {
          if (closed) return;
          const values = moduleConfig(id);
          const handover = migration.modules[id];
          const enabled = values.enabled !== false && handover?.enabled !== false;
          const allowed = handover?.ready === true && enabled;
          const current = scopes.get(id);
          const fingerprint = JSON.stringify(values);
          if (current && (!allowed || current.fingerprint !== fingerprint)) {
            scopes.delete(id);
            await current.fiber.dispose();
            if (closed) return;
          }
          if (!allowed) {
            statuses[id] = !enabled ? {phase: 'disabled'} : {
              phase: handover?.phase === 'conflict' ? 'conflict' : handover?.phase === 'failed' ? 'failed' : 'migration-pending',
              reason: handover?.reason ?? 'Waiting for safe migration and ownership discovery.',
            };
            continue;
          }
          const existing = scopes.get(id);
          if (existing) { setFiberState(id, existing.fiber); continue; }
          try {
            validateModule(distribution, id, values);
            const plugin = distribution.modulePlugins[id];
            if (!plugin) throw new TypeError('Distribution module implementation missing: ' + id);
            const fiber = ctx.plugin(plugin as Plugin, values);
            scopes.set(id, {fiber, fingerprint});
            setFiberState(id, fiber);
            void fiber.await().then(() => setFiberState(id, fiber), () => setFiberState(id, fiber));
          } catch (error) {
            statuses[id] = {phase: 'failed', reason: error instanceof Error ? error.message : 'Feature activation failed'};
            log.warn('Module %s did not activate: %s', id, error);
          }
        }
      };
      const schedule = () => {
        if (closed) return;
        queue = queue.then(reconcile).catch(error => { if (!closed) log.warn('Module reconciliation failed: %s', error); });
      };
      const start = () => {
        unsubscribe();
        controller?.dispose();
        controller = startAutomaticMigration(migrationHost, {
          rowId: distribution.name,
          packageName: distribution.name,
          moduleIds: distribution.moduleIds,
          auto: plain<Record<string, unknown>>(config.migration ?? {}).auto !== false,
          validateModule: (id, value) => validateModule(distribution, id, value),
        });
        unsubscribe = controller.subscribe(schedule);
        void controller.settled.catch(error => { if (!closed) log.warn('Migration failed: %s', error); });
        schedule();
      };
      start();
      let previousAuto = plain<Record<string, unknown>>(config.migration ?? {}).auto;
      // Native Loader limits this event to the owning root fiber; child scopes are remounted selectively.
      (ctx.on as any)('loader/volatile-update', () => {
        const auto = plain<Record<string, unknown>>(config.migration ?? {}).auto;
        if (auto !== previousAuto) { previousAuto = auto; start(); }
        schedule();
      });
      ctx.on('internal/status', fiber => {
        for (const [id, current] of scopes) if (current.fiber === fiber) setFiberState(id, fiber);
      });

      // Clock-independent fresh-page proof: generated at index render, never at client hot-load.
      (ctx.on as any)('webserver/index-inject', (table: any[]) => table.push({
        kind: 'global',
        name: '__DSH_TOOLBOX_PAGE_' + distribution.name.replace(/[^a-zA-Z0-9_]/g, '_') + '__',
        value: {servedAt: Date.now()},
      }));
      const status = () => {
        const state = controller.state();
        for (const [id, current] of scopes) setFiberState(id, current.fiber);
        return {
          distribution: distribution.name,
          modules: Object.fromEntries(distribution.moduleIds.map(id => [id, {
            ...state.modules[id], ...statuses[id],
            ready: state.modules[id]?.ready === true && statuses[id]?.phase === 'active',
            enabled: moduleConfig(id).enabled !== false && state.modules[id]?.enabled !== false,
          }])),
          report: state.report,
          browserReloadAfter: state.report?.browserReloadAfter,
        };
      };
      // Native Connection admission applies owner authentication and Host/Origin fences.
      ctx.inject(['webServer', 'connection'], routeCtx => {
        const services = routeCtx as unknown as Record<string, any>;
        const handler = (req: IncomingMessage, res: ServerResponse) => {
          const admission = services.connection.admit(req);
          if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return; }
          if (admission.peer.principal.kind !== 'owner') { res.writeHead(403); res.end(); return; }
          if (req.method !== 'GET') { res.writeHead(405, {Allow: 'GET'}); res.end(); return; }
          res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
          res.end(JSON.stringify(status()));
        };
        routeCtx.effect(() => services.webServer.register({kind: 'exact', path: '/toolbox/' + encodeURIComponent(distribution.name) + '/status', handler}));
      });
      ctx.effect(() => async () => {
        closed = true;
        unsubscribe();
        controller.dispose();
        await queue;
        await Promise.all([...scopes.values()].map(current => current.fiber.dispose()));
        scopes.clear();
      });
    },
  };
}
