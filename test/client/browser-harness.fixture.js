import React from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';

const descriptor = window.descriptor;
const ctx = new Context();
const views = new Map();
const root = createRoot(document.getElementById('root'));
const h = React.createElement;
window.starts = 0;
const NativeAudio = window.AudioContext;
window.AudioContext = class extends NativeAudio {
  createBufferSource() {
    const source = super.createBufferSource();
    const start = source.start.bind(source);
    source.start = (...args) => { window.starts++; return start(...args); };
    return source;
  }
};
let snapshot = { status: 'ready', writable: true, revision: 1, value: JSON.parse(localStorage.getItem(descriptor.rowId) || 'null') || { modules: Object.fromEntries(descriptor.moduleIds.map(id => [id, { enabled: true, ...(id === 'context' ? { retryAttempts: 2, retryDelayMs: 1000, ptcTimeoutMs: 0, ptcModelTimeouts: {} } : {}), ...(id === 'chime' ? { debounceMs: 0, durationMs: 5000, minRingMs: 3000, banner: true } : {}) }])) } };
const listeners = new Set();
const form = {
  getSnapshot: () => snapshot,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async mutate(ops, revision) {
    if (revision !== snapshot.revision || !snapshot.writable) return false;
    const value = structuredClone(snapshot.value);
    for (const op of ops) {
      const keys = [...op.path]; const key = keys.pop(); let node = value;
      for (const item of keys) node = node[item] ??= {};
      if (op.op === 'unset') delete node[key]; else node[key] = op.value;
    }
    snapshot = { ...snapshot, revision: snapshot.revision + 1, value };
    localStorage.setItem(descriptor.rowId, JSON.stringify(value));
    for (const fn of listeners) fn();
    return true;
  },
};
const provide = (name, value) => { ctx.provide(name); ctx.set(name, value); };
function render() {
  root.render(h(React.Fragment, null, ...[...views].filter(([key]) => !key.startsWith('plugins.row.config:')).map(([key, entry]) => h(entry.view, { key, view: 'page', ...(entry.options.inject?.() ?? {}) }))));
}
provide('configForms', { get: () => form, whileServed(rows, callback) { return callback(); } });
provide('slots', {
  inject(name, callback) { return callback(); },
  register(options, view) { const key = options.name + ':' + (options.key ?? options.id); views.set(key, { options, view }); render(); return () => { views.delete(key); render(); }; },
});
let sessions = { ids: [], byId: {} };
const sessionListeners = new Set();
provide('sessions', { list: { getSnapshot: () => sessions, subscribe(fn) { sessionListeners.add(fn); return () => sessionListeners.delete(fn); } } });
window.setRunning = running => { sessions = { ids: ['a'], byId: { a: { running, title: 'Browser test session' } } }; for (const fn of sessionListeners) fn(); };
window.accepted = () => snapshot.value;
window.disableChime = () => form.mutate([{op:'set',path:['modules','chime','enabled'],value:false}],snapshot.revision);
window.fiber = undefined;
window.__ModuleLoader__ = { load(entry) { window.loadedId = entry.id; window.fiber = ctx.plugin(entry.factory(name => { if (name !== 'react') throw new Error(name); return React; })); } };
window.unload = async () => { await window.fiber?.dispose(); await ctx.fiber.dispose(); root.unmount(); };
window.ready = true;
