/** Read-only host status. Failure closes browser capability, never settings access. */
export interface ModuleStatus { phase: string; ready: boolean; enabled: boolean; reason?: string; }
export interface ToolboxStatus {
  modules: Record<string, ModuleStatus>;
  report?: unknown;
  browserReloadAfter?: number;
  distribution?: unknown;
  error?: string;
}
export interface StatusStore { getSnapshot(): ToolboxStatus; subscribe(listener: () => void): () => void; }
export interface StatusEnvironment {
  fetch: typeof fetch;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  pageServedAt: number | undefined;
  legacyAtBoot: boolean;
}

/** Immutable boot manifest is deliberate: removing a later graph cannot clear old closures. */
export function legacyChimeAtBoot(boot: unknown): boolean {
  if (!boot || typeof boot !== 'object' || !Array.isArray((boot as any).entries)) return true;
  return (boot as any).entries.some((entry: any) => entry?.id === 'dsh-session-chime');
}

/** Host-clock proof is emitted only while serving a full index, not status polling/HMR. */
export function capturePageProof(rowId: string): number | undefined {
  const key = '__DSH_TOOLBOX_PAGE_' + rowId.replace(/[^a-zA-Z0-9_]/g, '_') + '__';
  const value = (globalThis as any)[key]?.servedAt;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function createStatusStore(rowId: string, environment?: Partial<StatusEnvironment>) {
  const env: StatusEnvironment = {
    fetch: (...args) => globalThis.fetch(...args),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    pageServedAt: capturePageProof(rowId),
    legacyAtBoot: legacyChimeAtBoot((globalThis as any).__DSH_BOOT__),
    ...environment,
  };
  let snapshot: ToolboxStatus = { modules: {}, error: 'Waiting for host status' };
  let live = false;
  let generation = 0;
  let timer: unknown;
  let controller: AbortController | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: ToolboxStatus) => { snapshot = next; for (const listener of listeners) listener(); };
  function accept(raw: unknown): ToolboxStatus {
    if (!raw || typeof raw !== 'object' || !raw || typeof (raw as any).modules !== 'object' || (raw as any).modules === null || Array.isArray((raw as any).modules)) throw new Error('Invalid status');
    const next = raw as ToolboxStatus;
    const report = next.report as { browserReloadAfter?: number } | undefined;
    const reloadAfter = next.browserReloadAfter ?? report?.browserReloadAfter;
    const chime = next.modules.chime;
    if (chime && (env.legacyAtBoot || (reloadAfter !== undefined && (typeof reloadAfter !== 'number' || !Number.isFinite(reloadAfter) || env.pageServedAt === undefined || env.pageServedAt <= reloadAfter)))) {
      return { ...next, modules: { ...next.modules, chime: { ...chime, ready: false, phase: 'reload-required', reason: 'Reload this page after the legacy chime has been disabled.' } } };
    }
    return next;
  }
  async function pump(token: number): Promise<void> {
    if (!live || token !== generation) return;
    controller = new AbortController();
    const thisController = controller;
    const deadline = env.setTimer(() => thisController.abort(), 2500);
    try {
      const response = await env.fetch('/toolbox/' + encodeURIComponent(rowId) + '/status', { credentials: 'same-origin', cache: 'no-store', signal: thisController.signal });
      if (!response.ok) throw new Error('Status unavailable');
      const next = accept(await response.json());
      if (live && token === generation) publish(next);
    } catch {
      if (live && token === generation) publish({ modules: {}, error: 'Host status unavailable; browser chime is paused.' });
    } finally {
      env.clearTimer(deadline);
      if (live && token === generation) timer = env.setTimer(() => { void pump(token); }, 1000);
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    start() {
      if (live) return () => {};
      live = true;
      const token = ++generation;
      void pump(token);
      return () => {
        if (!live || token !== generation) return;
        live = false;
        generation += 1;
        controller?.abort();
        if (timer !== undefined) env.clearTimer(timer);
        timer = undefined;
      };
    },
  };
}
