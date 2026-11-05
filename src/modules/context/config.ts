// Adapted from dsh-tool-compact-context; original MIT license retained in NOTICE.txt.
import z from '@deepseek-ai/schemastery';

/** Fields the loader may hand over as volatile accessors. */
const CONFIG_KEYS = [
  'compactTool',
  'statusTool',
  'guidance',
  'guidanceText',
  'pressureContext',
  'notifyAtRatio',
  'pressureStep',
  'retryAttempts',
  'retryDelayMs',
  'ptcTimeoutMs',
  'ptcModelTimeouts',
] as const;

/** Read one field, unwrapping the volatile accessor when the loader provided one. */
function liveValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    const read = Reflect.get(value, 'get');
    if (typeof read === 'function') return read.call(value);
  }
  return value;
}

/** Unwrap one field and detach it from the loader's immutable view. */
function plainValue(value: unknown): unknown {
  const live = liveValue(value);
  if (live !== null && typeof live === 'object') {
    try {
      return structuredClone(live);
    } catch {
      return live;
    }
  }
  return live;
}

/**
 * Host row schema. Every field has a default, so the row can be enabled with
 * an empty config.
 *
 * The fields rendered by the Web form are marked volatile on purpose: DSH's
 * settings service builds a row form only from volatile fields, and a settings
 * write is accepted only beneath a volatile node. The numeric watermark fields
 * (notifyAtRatio, pressureStep) stay in YAML and are deliberately not volatile.
 */
export const Config: Schemastery<any, any, any> = z.object({
  compactTool: z.boolean().default(true)
    .description('Expose the model-facing compact_context tool.')
    .volatile(),
  statusTool: z.boolean().default(false)
    .description('Expose the read-only context_status tool. Opt-in: its schema and results can influence behavior and history.')
    .volatile(),
  guidance: z.boolean().default(false)
    .description('Add a context-policy section to the system prompt. Off by default: prefer writing the strategy in AGENTS.md, or enable this and optionally customize guidanceText.')
    .volatile(),
  guidanceText: z.string().default('')
    .description('Custom policy text for the guidance section. Empty uses the built-in default. Only used when guidance is true; capped at 8000 characters.')
    .volatile(),
  pressureContext: z.boolean().default(false)
    .description('Experimental: append a quantized context-pressure line as runtime context from the token-meter projection. Off by default because it adds unrequested content and history.')
    .volatile(),
  notifyAtRatio: z.number().default(0.25)
    .description('Window fraction at which the optional pressure line appears.'),
  pressureStep: z.number().default(10)
    .description('Percentage quantization for the optional pressure line.'),
  retryAttempts: z.number().default(2)
    .description('Additional attempts after a transient compaction failure (for example a model API error). Deterministic failures such as an oversized summary are not retried.')
    .volatile(),
  retryDelayMs: z.number().default(1000)
    .description('Base delay between transient-failure retries, in milliseconds; doubles per attempt.')
    .volatile(),
  ptcTimeoutMs: z.number().default(0)
    .description('Experimental: default PTC run timeout in milliseconds when run_code did not pass timeoutMs. 0 leaves the deployment default. Requires a mounted PtcRuntime whose resolve() can be wrapped.')
    .volatile(),
  ptcModelTimeouts: z.dict(z.number()).default({})
    .description('Experimental per-provider/model PTC defaults, keyed by "provider/model"; applies when run_code did not pass timeoutMs.')
    .volatile(),
});

/** Resolved row config passed to apply(). */
export interface ResolvedConfig {
  compactTool: boolean;
  statusTool: boolean;
  guidance: boolean;
  guidanceText: string;
  pressureContext: boolean;
  notifyAtRatio: number;
  pressureStep: number;
  retryAttempts: number;
  retryDelayMs: number;
  ptcTimeoutMs: number;
  ptcModelTimeouts: Record<string, number>;
}

/**
 * Resolve a loader-passed config whose volatile fields are accessors.
 * The schema applies defaults and validates the plain values; the accessor
 * wrappers it produces for volatile fields are unwrapped for apply() and the
 * tool implementations.
 *
 * @param raw row config: plain values, volatile accessors, or a mix
 * @returns a plain resolved config
 */
export function resolveConfig(raw: unknown = {}): ResolvedConfig {
  const input: Record<string, unknown> = raw !== null && typeof raw === 'object'
    ? raw as Record<string, unknown>
    : {};
  const plain: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    if (input[key] !== undefined) plain[key] = plainValue(input[key]);
  }
  const resolved = Config(plain) as unknown as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) output[key] = liveValue(resolved[key]);
  return output as unknown as ResolvedConfig;
}

/**
 * Reject values the row schema cannot express (integers, ranges).
 * @param config resolved row config
 */
export function validateConfig(config: ResolvedConfig): void {
  const integer = (key: 'pressureStep' | 'retryAttempts' | 'retryDelayMs' | 'ptcTimeoutMs', min: number): void => {
    const value = config[key];
    if (!Number.isInteger(value) || value < min) {
      throw new TypeError(`tool-compact-context: ${key} must be an integer >= ${String(min)}`);
    }
  };
  if (typeof config.compactTool !== 'boolean') throw new TypeError('tool-compact-context: compactTool must be a boolean');
  if (typeof config.statusTool !== 'boolean') throw new TypeError('tool-compact-context: statusTool must be a boolean');
  if (typeof config.guidance !== 'boolean') throw new TypeError('tool-compact-context: guidance must be a boolean');
  if (typeof config.guidanceText !== 'string') throw new TypeError('tool-compact-context: guidanceText must be a string');
  if (config.guidanceText.length > 8000) throw new TypeError('tool-compact-context: guidanceText must be at most 8000 characters');
  if (typeof config.pressureContext !== 'boolean') throw new TypeError('tool-compact-context: pressureContext must be a boolean');
  integer('pressureStep', 1);
  if (config.pressureStep > 50) throw new TypeError('tool-compact-context: pressureStep must be at most 50');
  if (typeof config.notifyAtRatio !== 'number' || !(config.notifyAtRatio >= 0 && config.notifyAtRatio < 1)) {
    throw new TypeError('tool-compact-context: notifyAtRatio must be a number in [0, 1)');
  }
  integer('retryAttempts', 0);
  if (config.retryAttempts > 5) throw new TypeError('tool-compact-context: retryAttempts must be at most 5');
  integer('retryDelayMs', 0);
  if (config.retryDelayMs > 60000) throw new TypeError('tool-compact-context: retryDelayMs must be at most 60000');
  integer('ptcTimeoutMs', 0);
  if (config.ptcModelTimeouts === null || typeof config.ptcModelTimeouts !== 'object' || Array.isArray(config.ptcModelTimeouts)) {
    throw new TypeError('tool-compact-context: ptcModelTimeouts must be an object keyed by provider/model');
  }
  for (const [key, value] of Object.entries(config.ptcModelTimeouts)) {
    if (!key.includes('/')) throw new TypeError(`tool-compact-context: ptcModelTimeouts key ${JSON.stringify(key)} must be "provider/model"`);
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`tool-compact-context: ptcModelTimeouts[${JSON.stringify(key)}] must be a positive integer`);
  }
}
