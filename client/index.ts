import { bindSection, type ConfigForm } from './forms.ts';
import { createSettingsView, type SettingsDescriptor } from './settings.ts';
import { capturePageProof, createStatusStore, legacyChimeAtBoot, type StatusStore } from './status.ts';
import { ownScope } from './scope.ts';

export interface ChimeAdapter {
  mount(ctx: any, form: ConfigForm): () => void;
  createView(ctx: any): unknown;
}
export type ChimeAdapterFactory = (React: any) => ChimeAdapter;
export type ToolboxClientDescriptor = SettingsDescriptor;

/** Public build seam: generated entry supplies selected imports and platform React. */
export function createToolboxClient(descriptor: ToolboxClientDescriptor, React: any, makeChime?: ChimeAdapterFactory) {
  if (!descriptor.rowId || !descriptor.packageName) throw new TypeError('Distribution identities are required');
  const inject = ['slots', 'configForms'];
  const pageServedAt = capturePageProof(descriptor.rowId);
  const legacyAtBoot = legacyChimeAtBoot((globalThis as any).__DSH_BOOT__);
  function apply(ctx: any): void {
    const root = ctx.configForms.get(descriptor.rowId) as ConfigForm;
    const owned = ownScope(ctx);
    const status = createStatusStore(descriptor.rowId, { pageServedAt, legacyAtBoot });
    owned.ctx.effect(() => status.start(), 'toolbox: host status');
    const chime = descriptor.moduleIds.includes('chime') ? makeChime?.(React) : undefined;
    const View = createSettingsView(React, descriptor, chime?.createView(owned.ctx), status);
    owned.ctx.effect(() => ctx.configForms.whileServed([descriptor.rowId], () => {
      const offRow = ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config', key: descriptor.packageName + '#' + descriptor.rowId,
        inject: () => ({ configForm: root }),
      }, View));
      const offBundle = ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: descriptor.packageName,
        inject: () => ({ configForm: root }),
      }, View));
      return () => { offRow(); offBundle(); };
    }), 'toolbox: unified settings');
    if (chime) {
      owned.ctx.inject(['sessions'], (scope: any) => {
        const form = bindSection(root, ['modules', 'chime']);
        return mountChimeController(scope, form, status, chime);
      });
    }
    ctx.effect(() => owned.dispose, 'toolbox: distribution lifetime');
  }
  const exported = { inject, apply };
  Object.defineProperty(exported, Symbol.toStringTag, { value: 'Module' });
  return exported;
}

/** Changes one capability lifetime without restarting the package or sibling settings. */
export function mountChimeController(ctx: any, form: ConfigForm, status: StatusStore, chime: ChimeAdapter): () => void {
  let live = true;
  let stop: (() => void) | undefined;
  const sync = () => {
    if (!live) return;
    const config = form.getSnapshot();
    const current = status.getSnapshot().modules.chime;
    const wanted = config.status === 'ready' && !!config.value && (config.value as any).enabled === true && current?.ready === true && current.enabled === true;
    if (wanted && stop === undefined) stop = chime.mount(ctx, form);
    else if (!wanted && stop !== undefined) { const previous = stop; stop = undefined; previous(); }
  };
  const offForm = form.subscribe(sync);
  const offStatus = status.subscribe(sync);
  sync();
  return () => {
    if (!live) return;
    live = false;
    offForm(); offStatus();
    const previous = stop; stop = undefined; previous?.();
  };
}
