import type { Decision, Discovery, MigrationPlan, ModuleId, Values } from './types.ts';

export const LEGACY_PACKAGES: Record<ModuleId, string> = {
  context: 'dsh-tool-compact-context', retry: 'dsh-stream-retry', chime: 'dsh-session-chime', goalWait: 'dsh-goal-wait-gate',
};
export const LEGACY_DEFAULTS: Record<ModuleId, Values> = {
  context: { compactTool: true, statusTool: false, guidance: false, guidanceText: '', pressureContext: false, notifyAtRatio: 0.25, pressureStep: 10, retryAttempts: 2, retryDelayMs: 1000, ptcTimeoutMs: 0, ptcModelTimeouts: {} },
  retry: { errorCodes: ['upstream_stream_read_error', 'stream_timeout', 'stream error'], providers: [], retryEmptyResponse: true },
  chime: { enabled: true, soundDone: 'chime-soft', soundBlocked: 'alert-low', soundQuestion: 'bell-bright', soundError: 'alert-sharp', chimeQuestion: true, chimeError: true, volume: 0.8, durationMs: 0, debounceMs: 1500, quietStyle: 'short', quietShortMs: 600, dndStart: '', dndEnd: '', restMode: false, minRingMs: 3000, banner: true, bannerPlacement: 'bottom-center' },
  goalWait: { waitForJobs: true, waitForSubagents: true, maxHoldMs: 0 },
};
const VERSIONS: Record<ModuleId, string[]> = { context: ['0.4.7'], retry: ['0.1.9'], chime: ['0.6.0'], goalWait: ['0.3.0'] };
/** Detached deep merge: arrays replace; prototype-bearing keys are never admitted. */
export function mergeValues(...layers: Values[]): Values {
  const out: Values = {};
  for (const layer of layers) for (const [key, value] of Object.entries(layer)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('unsafe configuration key');
    out[key] = isRecord(value) && isRecord(out[key]) ? mergeValues(out[key] as Values, value) : structuredClone(value);
  }
  return out;
}
export function isRecord(value: unknown): value is Values { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function containsExpression(value: unknown): boolean {
  return isRecord(value) ? Object.entries(value).some(([key, child]) => key === '__jsExpr' || containsExpression(child)) : Array.isArray(value) && value.some(containsExpression);
}
/** Conservative baseline field validation also protects standalone recovery/CLI calls. */
export function validateKnownConfig(id: ModuleId, config: Values): void {
  const defaults: Values = { ...LEGACY_DEFAULTS[id], enabled: true };
  for (const [key, value] of Object.entries(config)) {
    const expected = defaults[key];
    if (!Object.hasOwn(defaults, key)) throw new Error('unknown module field');
    if (Array.isArray(expected)) { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('invalid string list'); }
    else if (isRecord(expected)) { if (!isRecord(value) || Object.values(value).some(item => typeof item !== 'number' || !Number.isFinite(item) || item < 0)) throw new Error('invalid timeout map'); }
    else if (typeof value !== typeof expected) throw new Error('invalid module field type');
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error('invalid nonnegative number');
    if (['notifyAtRatio', 'volume'].includes(key) && Number(value) > 1) throw new Error('invalid ratio');
  }
}
/** The planner cannot mutate source documents or start a legacy plugin. */
export function planMigration(input: Discovery): MigrationPlan {
  const decisions: Decision[] = input.target.moduleIds.map(moduleId => {
    const sources = input.sources.filter(row => row.moduleId === moduleId);
    const conflict = (reason: string): Decision => ({ moduleId, phase: 'conflict', enabled: false, reason });
    if (input.problems.length) return conflict(input.problems.join('; '));
    if (input.moduleProblems?.[moduleId]?.length) return conflict(input.moduleProblems[moduleId]!.join('; '));
    if (input.peers[moduleId]?.length) return conflict('another Toolbox distribution owns this module');
    if (sources.length > 1) return conflict('multiple legacy instances require explicit recovery');
    const source = sources[0];
    if (source?.problem) return conflict(source.problem);
    const explicit = input.explicit[moduleId] ?? {};
    if (containsExpression(explicit) || source && (containsExpression(source.raw) || containsExpression(source.effective))) return conflict('dynamic configuration is not imported');
    if (!source) {
      const enabled = Object.hasOwn(explicit, 'enabled') ? explicit.enabled === true : !input.legacyMode;
      const config = mergeValues({ enabled }, explicit);
      try { validateKnownConfig(moduleId, config); input.target.validateModule?.(moduleId, config); } catch { return conflict('target schema validation failed'); }
      return { moduleId, phase: 'fresh', enabled, config };
    }
    if (!source.version || !VERSIONS[moduleId].includes(source.version)) return conflict('unsupported legacy version: ' + (source.version ?? 'unknown'));
    const defaults = LEGACY_DEFAULTS[moduleId];
    const unknown = Object.keys(source.effective).filter(key => !Object.hasOwn(defaults, key));
    if (unknown.length) return conflict('unsupported legacy configuration fields');
    const imported = mergeValues(defaults, source.effective);
    const config = mergeValues(imported, { enabled: !source.disabled && imported.enabled !== false }, explicit);
    try { validateKnownConfig(moduleId, config); input.target.validateModule?.(moduleId, config); } catch { return conflict('target schema validation failed'); }
    return { moduleId, phase: 'prepared', enabled: config.enabled === true, config, source };
  });
  return { profileId: input.profileId, revision: input.revision, target: input.target, legacyMode: input.legacyMode, decisions, problems: [...input.problems] };
}
