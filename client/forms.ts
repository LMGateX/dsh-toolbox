/** Structural native configForms contracts; no host or React runtime dependency. */
export interface ConfigFormSnapshot<T = unknown> {
  status: 'loading' | 'ready' | 'unavailable';
  value?: T;
  base?: unknown;
  user?: unknown;
  revision?: number;
  writable: boolean;
}

export type PathOperation =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] };

export interface ConfigForm<T = unknown> {
  getSnapshot(): ConfigFormSnapshot<T>;
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly PathOperation[], expectedRevision?: number): Promise<boolean>;
}

/** DSH's page owns the subscription and supplies each accepted snapshot as props. */
export interface ConfigPageForm<T = unknown> {
  readonly state: ConfigFormSnapshot<T>;
  readonly mutate: ConfigForm<T>['mutate'];
}
export type NativePageForm<T = unknown> = ConfigPageForm<T>;
export interface PageFormAdapter<T = unknown> extends ConfigForm<T> {
  update(page: ConfigPageForm<T>): void;
}

function writable(snapshot: ConfigFormSnapshot, revision?: number): boolean {
  return snapshot.status === 'ready' && snapshot.writable
    && snapshot.revision !== undefined
    && (revision === undefined || revision === snapshot.revision);
}

/** Adapt page props without inventing, incrementing, or rebasing Host revisions. */
export function createPageFormAdapter<T = unknown>(initial: ConfigPageForm<T>): PageFormAdapter<T> {
  let page = initial;
  let snapshot = initial.state;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async mutate(ops, expectedRevision) {
      if (!writable(snapshot, expectedRevision) || ops.length === 0) return false;
      return page.mutate(ops, expectedRevision ?? snapshot.revision);
    },
    update(next) {
      page = next;
      if (snapshot === next.state) return;
      snapshot = next.state;
      for (const listener of listeners) listener();
    },
  };
}

function atPath(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== 'object'
      || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const bindings = new WeakMap<ConfigForm, Map<string, ConfigForm>>();

/**
 * A section shares its root's write queue and revision. Both form and projected
 * snapshot identities are stable until their respective input changes.
 */
export function bindSection<T = unknown>(root: ConfigForm, path: readonly string[]): ConfigForm<T> {
  const prefix = [...path];
  const key = JSON.stringify(prefix);
  let cache = bindings.get(root);
  if (!cache) bindings.set(root, cache = new Map());
  const existing = cache.get(key);
  if (existing) return existing as ConfigForm<T>;
  let accepted: ConfigFormSnapshot | undefined;
  let projected: ConfigFormSnapshot<T>;
  const form: ConfigForm<T> = {
    getSnapshot() {
      const next = root.getSnapshot();
      if (accepted !== next) {
        accepted = next;
        projected = {
          ...next,
          value: atPath(next.value, prefix) as T | undefined,
          base: atPath(next.base, prefix),
          user: atPath(next.user, prefix),
        };
      }
      return projected;
    },
    subscribe: listener => root.subscribe(listener),
    async mutate(ops, expectedRevision) {
      const snapshot = root.getSnapshot();
      if (!writable(snapshot, expectedRevision) || ops.length === 0) return false;
      const prefixed = ops.map(op => op.op === 'set'
        ? { op: 'set' as const, path: [...prefix, ...op.path], value: op.value }
        : { op: 'unset' as const, path: [...prefix, ...op.path] });
      return root.mutate(prefixed, expectedRevision ?? snapshot.revision);
    },
  };
  cache.set(key, form);
  return form;
}
