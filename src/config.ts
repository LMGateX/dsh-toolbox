import Schema from '@deepseek-ai/schemastery';
import type { Distribution, ModuleId } from './types.ts';

/** Read and detach native volatile references without losing false, zero, or empty lists. */
export function plain<T = unknown>(value: unknown): T {
  if (value && typeof value === 'object' && typeof Reflect.get(value, 'get') === 'function') return plain(Reflect.get(value, 'get').call(value));
  if (Array.isArray(value)) return value.map(item => plain(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)])) as T;
  return value as T;
}

/** Clone feature schemas: distribution-specific editability must not mutate feature policy. */
export function createConfig(distribution: Distribution): Schemastery<any> {
  const modules: Record<string, Schemastery<any>> = {};
  for (const id of distribution.moduleIds) {
    const feature = distribution.modulePlugins[id];
    const schema = feature?.Config as Schemastery<any> | undefined;
    if (!schema?.dict) throw new TypeError('Toolbox module has no object configuration schema: ' + id);
    const fields: Record<string, Schemastery<any>> = {};
    for (const [key, field] of Object.entries(schema.dict)) {
      const cloned = Schema(field.toJSON());
      fields[key] = cloned.meta.volatile ? cloned : cloned.volatile();
    }
    fields.enabled = Schema.boolean().default(true).description('Enable this module; disabled modules register no feature effects.').volatile();
    modules[id] = Schema.object(fields).default({});
  }
  return Schema.object({
    modules: Schema.object(modules).default({}),
    migration: Schema.object({auto: Schema.boolean().default(true).description('Automatically import known legacy plugins using a recoverable handover.').volatile()}).default({}),
  });
}

/** Schema-level migration validation; feature apply() performs its additional semantic checks. */
export function validateModule(distribution: Distribution, id: ModuleId, value: Record<string, unknown>): void {
  const feature = distribution.modulePlugins[id];
  const schema = feature?.Config as Schemastery<any> | undefined;
  if (!schema) throw new TypeError('Unsupported module: ' + id);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new TypeError('Module enabled must be boolean');
  schema(value);
  // Feature exports may expose stricter semantic validation/resolution than JSON schema.
  const validators = feature as unknown as Record<string, unknown>;
  if (typeof validators.resolveConfig === 'function') {
    const resolved = validators.resolveConfig(value);
    if (typeof validators.validateConfig === 'function') validators.validateConfig(resolved);
  } else if (typeof validators.resolveRowConfig === 'function') validators.resolveRowConfig(value);
}
