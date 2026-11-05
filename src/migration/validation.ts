import type { ModuleId, Values } from './types.ts';

/**
 * Config-only migration admission for the audited legacy versions. This deliberately
 * imports no feature entrypoints: split distributions must not bundle other modules.
 * Bounds mirror context validateConfig, retry Config, chime resolveRowConfig, and
 * goal-wait resolveConfig. Omitted fields are left for the existing default resolver.
 */
type Rule = (value: unknown, field: string) => void;
function reject(field: string, requirement: string): never {
  throw new TypeError('migration ' + field + ': ' + requirement);
}
function plain(value: unknown, field: string): asserts value is Values {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(field, 'plain object required');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject(field, 'plain object required');
}
function entries(value: Values, field: string): [string, unknown][] {
  return Reflect.ownKeys(value).map(key => {
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) reject(field, 'unsafe configuration key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject(field, 'only enumerable inert data fields are supported');
    return [key, descriptor.value];
  });
}
const boolean: Rule = (value, field) => { if (typeof value !== 'boolean') reject(field, 'boolean required'); };
const number = (minimum: number, maximum = Infinity, integer = false, safe = false, exclusiveMaximum = false): Rule => (value, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum ||
      (exclusiveMaximum ? value >= maximum : value > maximum) ||
      (integer && !Number.isInteger(value)) || (safe && !Number.isSafeInteger(value))) reject(field, 'number outside supported bounds or integer precision');
};
const string = (maximum = Infinity, minimum = 0, pattern?: RegExp): Rule => (value, field) => {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || pattern && !pattern.test(value)) reject(field, 'string outside supported length or format');
};
const choice = (allowed: readonly string[]): Rule => (value, field) => {
  if (typeof value !== 'string' || !allowed.includes(value)) reject(field, 'unsupported option');
};
const list = (item: Rule): Rule => (value, field) => {
  if (!Array.isArray(value) || value.length > 100) reject(field, 'array of at most 100 strings required');
  // Never read volatile accessors, sparse-array holes, or custom iterators during inspection.
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) reject(field, 'inert array required');
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) reject(field, 'inert array items required');
    item(descriptor.value, field);
  }
};
const timeoutMap: Rule = (value, field) => {
  plain(value, field);
  for (const [key, timeout] of entries(value, field)) {
    // The source contract requires a slash, not nonempty provider/model segments.
    if (!key.includes('/')) reject(field, 'provider/model keys required');
    number(1, Infinity, true)(timeout, field);
  }
};
const duration = number(0, 21_600_000, true, true);
const sounds = ['chime-soft', 'bell-bright', 'marimba', 'alert-low', 'alert-sharp', 'blip'];
const identifier = string(200, 1, /^[^:\s"'\x60\u0000-\u001f\u007f](?:[^:"'\x60\u0000-\u001f\u007f]*[^:\s"'\x60\u0000-\u001f\u007f])?$/u);
const clock = string(Infinity, 0, /^(?:|(?:[01]\d|2[0-3]):[0-5]\d)$/);
const rules: Record<ModuleId, Record<string, Rule>> = {
  context: {
    enabled: boolean, compactTool: boolean, statusTool: boolean, guidance: boolean,
    guidanceText: string(8000), pressureContext: boolean,
    notifyAtRatio: number(0, 1, false, false, true), pressureStep: number(1, 50, true),
    retryAttempts: number(0, 5, true), retryDelayMs: number(0, 60_000, true),
    ptcTimeoutMs: number(0, Infinity, true), ptcModelTimeouts: timeoutMap,
  },
  retry: { enabled: boolean, errorCodes: list(identifier), providers: list(string(200, 1, /^\S+$/u)), retryEmptyResponse: boolean },
  chime: {
    enabled: boolean, soundDone: choice(sounds), soundBlocked: choice(sounds), soundQuestion: choice(sounds), soundError: choice(sounds),
    chimeQuestion: boolean, chimeError: boolean, volume: number(0, 1), durationMs: duration, debounceMs: duration,
    quietStyle: choice(['short', 'silent']), quietShortMs: duration, dndStart: clock, dndEnd: clock,
    restMode: boolean, minRingMs: duration, banner: boolean,
    bannerPlacement: choice(['bottom-center', 'bottom-right', 'bottom-left', 'top-right', 'top-left', 'center', 'modal']),
  },
  goalWait: { enabled: boolean, waitForJobs: boolean, waitForSubagents: boolean, maxHoldMs: number(0, Infinity, true, true) },
};

/** Validate detached raw module fields without defaults, coercion, mutation, or code evaluation. */
export function validateModuleConfig(id: ModuleId, config: Values): void {
  if (!Object.hasOwn(rules, id)) reject('module', 'unknown module');
  plain(config, id);
  for (const [key, value] of entries(config, id)) {
    if (!Object.hasOwn(rules[id], key)) reject(id + '.' + key, 'unknown configuration field');
    rules[id][key]!(value, id + '.' + key);
  }
}
