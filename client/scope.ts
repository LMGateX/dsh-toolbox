/** Fiber-owned effects that can also end early when one module is disabled. */
export function disposeHandle(value: unknown): unknown {
  if (typeof value === 'function') return value();
  if (value && typeof (value as { dispose?: unknown }).dispose === 'function') {
    return (value as { dispose(): unknown }).dispose();
  }
}

export function ownScope<T extends { effect: Function; inject: Function }>(parent: T): { ctx: T; dispose(): Promise<void> } {
  let live = true;
  let disposal: Promise<void> | undefined;
  const handles: unknown[] = [];
  const own = (value: unknown) => {
    if (live) handles.push(value);
    else { try { void Promise.resolve(disposeHandle(value)).catch(() => {}); } catch {} }
    return value;
  };
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
    if (disposal) return disposal;
    live = false;
    const pending = handles.splice(0).reverse().map(handle => {
      try { return Promise.resolve(disposeHandle(handle)); }
      catch (error) { return Promise.reject(error); }
    });
    // Dispose every handle even if one fails; join native asynchronous Fiber cleanup.
    disposal = Promise.allSettled(pending).then(() => {});
    return disposal;
  } };
}
