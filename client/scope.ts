/** Fiber-owned effects that can also end early when one module is disabled. */
export function disposeHandle(value: unknown): void {
  if (typeof value === 'function') value();
  else if (value && typeof (value as { dispose?: unknown }).dispose === 'function') {
    void (value as { dispose(): unknown }).dispose();
  }
}

export function ownScope<T extends { effect: Function; inject: Function }>(parent: T): { ctx: T; dispose(): void } {
  let live = true;
  const handles: unknown[] = [];
  const own = (value: unknown) => { if (live) handles.push(value); else disposeHandle(value); return value; };
  const ctx = new Proxy(parent, {
    get(target, key) {
      if (key === 'effect') return (callback: () => unknown, label?: string) => {
        if (!live) return () => {};
        return own(target.effect(callback, label));
      };
      if (key === 'inject') return (names: readonly string[], callback: Function) => {
        if (!live) return () => {};
        return own(target.inject(names, callback));
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ctx, dispose() {
    if (!live) return;
    live = false;
    for (const handle of handles.splice(0).reverse()) disposeHandle(handle);
  } };
}
