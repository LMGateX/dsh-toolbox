import { bindSection, createPageFormAdapter } from './forms.ts';
import type { ConfigForm, ConfigFormSnapshot, ConfigPageForm, PathOperation } from './forms.ts';

export type ModuleId = 'context' | 'retry' | 'chime' | 'goalWait';
export interface SettingsDescriptor {
  rowId: string;
  packageName: string;
  moduleIds: readonly ModuleId[];
}
export interface SettingsStatus {
  modules?: Partial<Record<ModuleId, { phase?: string; ready?: boolean; enabled?: boolean; reason?: string }>>;
  report?: unknown;
}
export interface SettingsStatusStore {
  getSnapshot(): SettingsStatus | undefined;
  subscribe(listener: () => void): () => void;
}
export interface SettingsProps {
  view?: string;
  form?: ConfigPageForm;
  configForm?: ConfigForm;
  status?: SettingsStatusStore;
}

type TextField = 'guidanceText' | 'retryAttempts' | 'retryDelayMs' | 'ptcTimeoutMs'
  | 'ptcModelTimeouts' | 'errorCodes' | 'providers' | 'maxHoldMs';
interface DraftState {
  text: string;
  revision?: number;
  status: ConfigFormSnapshot['status'];
  writable: boolean;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  error: string;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

function format(field: TextField, value: unknown): string {
  if (field === 'errorCodes' || field === 'providers') return Array.isArray(value) ? value.join('\n') : '';
  if (field === 'ptcModelTimeouts') return Object.entries(record(value))
    .map(([key, ms]) => key + ' = ' + Number(ms) / 1000).join('\n');
  if (field === 'retryDelayMs' || field === 'ptcTimeoutMs') return String(Number(value ?? 0) / 1000);
  return String(value ?? '');
}
function number(text: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!text.trim()) throw new Error('Enter a number; use Reset to inherit.');
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error('Number is outside the allowed range.');
  return value;
}
function milliseconds(text: string, maxSeconds = Number.MAX_SAFE_INTEGER / 1000): number {
  const ms = Math.round(number(text, 0, maxSeconds) * 1000);
  if (!Number.isSafeInteger(ms)) throw new Error('Duration must fit whole milliseconds.');
  return ms;
}
function parse(field: TextField, text: string): unknown {
  if (field === 'guidanceText') {
    if (text.length > 8000) throw new Error('Guidance is limited to 8000 characters.');
    return text;
  }
  if (field === 'errorCodes' || field === 'providers') {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 100 || lines.some(line => line.length > 200
      || (field === 'providers' ? /\s/.test(line) : /[:"'\x00-\x1f\x7f]/.test(line) || line.includes(String.fromCharCode(96))))) {
      throw new Error('Use at most 100 identifiers of 200 characters; providers cannot contain whitespace and error codes cannot contain quotes, colons or control characters.');
    }
    return lines; // Deliberately [] for blank: Reset, not blank, removes the override.
  }
  if (field === 'ptcModelTimeouts') {
    const entries: [string, number][] = [];
    for (const line of text.split(/\r?\n/).map(line => line.trim())) {
      if (!line || line.startsWith('#')) continue;
      const equals = line.indexOf('=');
      const key = line.slice(0, equals).trim();
      if (equals <= 0 || !/^[^\s/]+\/[^\s]+$/.test(key)) throw new Error('Use provider/model = seconds, one per line.');
      const ms = milliseconds(line.slice(equals + 1));
      if (ms <= 0 || entries.some(([name]) => name === key)) throw new Error('Model timeouts must be positive and keys unique.');
      entries.push([key, ms]);
    }
    return Object.fromEntries(entries);
  }
  if (field === 'retryDelayMs' || field === 'ptcTimeoutMs') return milliseconds(text, field === 'retryDelayMs' ? 60 : undefined);
  const value = number(text, 0, field === 'retryAttempts' ? 5 : undefined);
  if (!Number.isSafeInteger(value)) throw new Error('Enter a non-negative whole number.');
  return value;
}

/** One staged native field. Drafts keep the exact revision read, even across sibling edits. */
export function createFieldEditor(form: ConfigForm, field: TextField) {
  const seed = (snapshot: ConfigFormSnapshot): DraftState => ({
    text: format(field, record(snapshot.value)[field]), revision: snapshot.revision,
    status: snapshot.status, writable: snapshot.writable,
    dirty: false, saving: false, conflict: false, error: '',
  });
  let state = seed(form.getSnapshot());
  const listeners = new Set<() => void>();
  const publish = (next: DraftState) => { state = next; for (const listener of listeners) listener(); };
  const sync = () => {
    const next = form.getSnapshot();
    publish(state.dirty || state.saving ? {
      ...state, status: next.status, writable: next.writable,
      conflict: state.conflict || next.revision !== state.revision,
    } : seed(next));
  };
  async function submit(reset: boolean): Promise<boolean> {
    const current = form.getSnapshot();
    if (state.saving || current.status !== 'ready' || !current.writable
      || current.revision === undefined) return false;
    if (state.conflict || current.revision !== state.revision) {
      publish({ ...state, conflict: true, error: 'Configuration changed. Discard this draft before editing again.' });
      return false;
    }
    let ops: PathOperation[];
    try {
      ops = reset ? [{ op: 'unset', path: [field] }]
        : [{ op: 'set', path: [field], value: parse(field, state.text) }];
    } catch (error) {
      publish({ ...state, error: error instanceof Error ? error.message : 'Invalid value.' });
      return false;
    }
    publish({ ...state, saving: true, error: '' });
    try {
      const ok = await form.mutate(ops, state.revision);
      if (ok) {
        // Page adapters may receive acceptance in the following React render.
        const next = form.getSnapshot();
        publish(next.revision !== state.revision ? seed(next) : {
          ...state, saving: false, dirty: false, conflict: false,
        });
      } else publish({ ...state, saving: false, conflict: true, error: 'Save refused. Discard the draft to load the accepted configuration.' });
      return ok;
    } catch {
      publish({ ...state, saving: false, error: 'Could not save. Check the connection and retry.' });
      return false;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { const stop = form.subscribe(sync); sync(); return stop; },
    edit(text: string) { if (!state.saving) publish({ ...state, text, dirty: true, error: '' }); },
    discard() { if (!state.saving) publish(seed(form.getSnapshot())); },
    save: () => submit(false),
    reset: () => submit(true),
  };
}

const labels: Record<ModuleId, string> = {
  context: 'Context compaction', retry: 'Stream and empty-response retry',
  chime: 'Session chime', goalWait: 'Goal wait',
};
const emptyStatus: SettingsStatusStore = { getSnapshot: () => undefined, subscribe: () => () => {} };

/** Uses the platform React instance. The chime component is the preserved custom editor. */
export function createSettingsView(
  React: any, descriptor: SettingsDescriptor, chimeEditor?: unknown, status?: SettingsStatusStore,
): (props: SettingsProps) => unknown {
  const h = React.createElement;
  const useSnapshot = (form: ConfigForm) => React.useSyncExternalStore(form.subscribe, form.getSnapshot, form.getSnapshot) as ConfigFormSnapshot;
  const style = { display: 'grid', gap: 12 };

  function TextControl({ form, field, label, hint }: { form: ConfigForm; field: TextField; label: string; hint?: string }) {
    const [editor] = React.useState(() => createFieldEditor(form, field));
    React.useEffect(() => editor.start(), [editor]);
    const draft = React.useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot) as DraftState;
    const disabled = draft.status !== 'ready' || !draft.writable || draft.revision === undefined || draft.saving;
    const id = descriptor.rowId + '-' + field;
    const multiline = ['guidanceText', 'errorCodes', 'providers', 'ptcModelTimeouts'].includes(field);
    return h('div', { style, 'data-field': field },
      h('label', { htmlFor: id }, label),
      h(multiline ? 'textarea' : 'input', {
        id, value: draft.text, disabled, rows: multiline ? 4 : undefined,
        type: multiline ? undefined : 'text', spellCheck: false,
        onChange: (event: any) => editor.edit(String(event.target.value)),
      }),
      hint && h('small', null, hint),
      draft.conflict && h('p', { role: 'alert' }, 'Configuration changed. Discard the draft to reload; it will not overwrite newer settings.'),
      draft.error && h('p', { role: 'alert' }, draft.error),
      h('div', null,
        h('button', { type: 'button', disabled: disabled || !draft.dirty || draft.conflict, onClick: () => { void editor.save(); } }, 'Save'),
        h('button', { type: 'button', disabled: draft.saving || !draft.dirty && !draft.conflict, onClick: () => editor.discard() }, 'Discard draft'),
        h('button', { type: 'button', disabled: disabled || draft.conflict, onClick: () => { void editor.reset(); } }, 'Reset to inherited')));
  }

  function Switch({ form, field, label, fallback = false }: { form: ConfigForm; field: string; label: string; fallback?: boolean }) {
    const snapshot = useSnapshot(form);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const value = record(snapshot.value)[field];
    return h('div', null,
      h('label', null, h('input', {
        type: 'checkbox', 'data-field': field, checked: typeof value === 'boolean' ? value : fallback,
        disabled: busy || snapshot.status !== 'ready' || !snapshot.writable || snapshot.revision === undefined,
        onChange: async (event: any) => {
          const current = form.getSnapshot();
          if (busy || current.status !== 'ready' || !current.writable || current.revision !== snapshot.revision) return;
          const checked = Boolean(event.target.checked);
          setBusy(true); setError('');
          try {
            if (!await form.mutate([{ op: 'set', path: [field], value: checked }], snapshot.revision)) setError('Save refused; reload the accepted configuration.');
          } catch { setError('Could not save. Check the connection and retry.'); }
          finally { setBusy(false); }
        },
      }), ' ', label),
      error && h('p', { role: 'alert' }, error));
  }

  function ModuleSection({ root, id, runtime }: { root: ConfigForm; id: ModuleId; runtime?: SettingsStatus }) {
    const form = bindSection(root, ['modules', id]);
    const snapshot = useSnapshot(form);
    const moduleStatus = runtime?.modules?.[id];
    const text = (field: TextField, label: string, hint?: string) => h(TextControl, { key: field, form, field, label, hint });
    const flag = (field: string, label: string, fallback = false) => h(Switch, { key: field, form, field, label, fallback });
    let fields: unknown[];
    if (id === 'context') fields = [
      flag('compactTool', 'Expose compact_context', true), flag('statusTool', 'Expose context_status (opt-in)'),
      flag('guidance', 'Add context guidance to the system prompt'),
      text('guidanceText', 'Custom guidance text', 'Empty uses built-in guidance; at most 8000 characters.'),
      flag('pressureContext', 'Experimental context-pressure line'),
      text('retryAttempts', 'Additional compaction retry attempts (0–5)'),
      text('retryDelayMs', 'Retry base delay (seconds)', '0–60 seconds; doubles per attempt.'),
      text('ptcTimeoutMs', 'Default PTC timeout (seconds)', '0 keeps the deployment default.'),
      text('ptcModelTimeouts', 'Per-model PTC timeouts (seconds)', 'One provider/model = seconds per line. Blank saves an explicit empty map.'),
      h('p', { key: 'yaml-note' }, 'Nonvolatile watermarks notifyAtRatio and pressureStep remain YAML-only. Compaction thresholds and retention belong to host compaction settings.'),
    ];
    else if (id === 'retry') fields = [
      text('errorCodes', 'Error codes', 'One exact, case-sensitive identifier per line. Blank saves []; Reset removes the override.'),
      text('providers', 'Provider routes', 'One route per line, no whitespace. Blank saves [] (all routes). Never enter credentials.'),
      flag('retryEmptyResponse', 'Retry empty model responses', true),
    ];
    else if (id === 'goalWait') fields = [
      flag('waitForJobs', 'Wait for running and stopping jobs', true),
      flag('waitForSubagents', 'Wait for live subagent descendants', true),
      text('maxHoldMs', 'Maximum hold (milliseconds)', '0 holds indefinitely. Does not change durable goal phase.'),
    ];
    else fields = chimeEditor
      ? [h(chimeEditor, { key: 'chime-editor', configForm: form })]
      : [h('p', { key: 'chime-unavailable', role: 'status' }, 'The custom chime editor is unavailable in this distribution.')];
    return h('section', { key: id, style, 'data-module': id, 'aria-label': labels[id] },
      h('h3', null, labels[id]),
      // The original custom editor already owns the same chime.enabled switch.
      (id !== 'chime' || !chimeEditor) && flag('enabled', 'Enable ' + labels[id], true),
      h('p', { role: 'status' }, moduleStatus
        ? [moduleStatus.phase ?? 'Status unknown', moduleStatus.ready === undefined ? '' : moduleStatus.ready ? 'ready' : 'not ready',
          moduleStatus.enabled === undefined ? '' : moduleStatus.enabled ? 'enabled' : 'disabled', moduleStatus.reason ?? ''].filter(Boolean).join(' · ')
        : 'Runtime status unavailable; saved configuration alone does not confirm activation.'),
      snapshot.status !== 'ready' && h('p', { role: 'status' }, snapshot.status === 'loading' ? 'Loading configuration…' : 'Configuration unavailable.'),
      snapshot.status === 'ready' && !snapshot.writable && h('p', { role: 'status' }, 'Read-only configuration.'),
      ...fields);
  }

  function Editor({ root, status: suppliedStatus }: { root: ConfigForm; status?: SettingsStatusStore }) {
    const snapshot = useSnapshot(root);
    const source = suppliedStatus ?? status ?? emptyStatus;
    const remote = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot) as SettingsStatus | undefined;
    const value = record(snapshot.value);
    const metadata = record(value.metadata);
    const runtime = remote ?? (value.status ?? metadata.status ?? metadata) as SettingsStatus;
    const report = runtime?.report ?? value.report;
    return h('div', { style, 'data-package': descriptor.packageName },
      h('h2', null, 'Toolbox settings'),
      ...descriptor.moduleIds.map(id => h(ModuleSection, { key: id, root, id, runtime })),
      report !== undefined && h('details', null, h('summary', null, 'Migration report'), h('pre', null, JSON.stringify(report, null, 2))));
  }
  function PageEditor({ form, status }: { form: ConfigPageForm; status?: SettingsStatusStore }) {
    const [adapter] = React.useState(() => createPageFormAdapter(form));
    React.useEffect(() => { adapter.update(form); }, [adapter, form, form.state]);
    return h(Editor, { root: adapter, status });
  }
  return function SettingsView(props: SettingsProps) {
    // Summary cards must not subscribe, allocate editors, or access form services.
    if (props.view === 'summary') return descriptor.moduleIds.map(id => labels[id]).join(' · ');
    if (props.form) return h(PageEditor, { form: props.form, status: props.status });
    if (props.configForm) return h(Editor, { key: descriptor.rowId, root: props.configForm, status: props.status });
    return h('p', { role: 'status' }, 'Configuration unavailable.');
  };
}
