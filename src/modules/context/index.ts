// Adapted from dsh-tool-compact-context; original MIT license retained in NOTICE.txt.
/**
 * Model-facing on-demand context compaction and read-only context status.
 *
 * The compaction tool prefers the mounted backend's native
 * `compactIfNeeded(agent, 'pressure', signal)`. When that declines below the
 * threshold, it uses the backend's resolved retention and the native
 * `compactRegion` transaction so the model can compact early. The backend
 * still owns threshold, retention, model policy, pruning, and retries; the
 * plugin contains only a retained-tail range-selection shim.
 *
 * The status tool is lazy by design: it returns a reading only when the model
 * asks, so nothing changes the prompt prefix until a call is made. The
 * optional runtime pressure line is off by default; a static guidance section
 * is cache-stable for a given deployment.
 *
 * @module dsh-tool-compact-context
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-token-meter';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { Config, resolveConfig, validateConfig } from './config.ts';
import type { ResolvedConfig } from './config.ts';
import { COMPACT_TOOL, GUIDANCE, STATUS_TOOL, compactDescription, statusDescription } from './guidance.ts';
import { pressurePercent, pressureText, readPressure } from './pressure.ts';
import { readPolicy } from './policy.ts';
import { installPtcTimeoutOverride } from './ptc-timeout.ts';
import { selectNativeRetentionRange } from './manual.ts';
import { buildStatus, renderStatus } from './status.ts';
import type { ContextStatus, StatusOptions } from './status.ts';

/** Stable Cordis plugin name. */
export const name = 'toolbox-context';

/** Services the tools cannot work without. */
export const inject = ['tools', 'compaction', 'tokenMeter', 'systemPrompt', 'llm'];

export { Config, resolveConfig };

/** Prompt placement: after the PTC-only instruction (800), before tool guidance (900). */
const SECTION_ORDER = 850;

/** Runtime-context placement: last, after the Web-surface line (210). */
const CONTEXT_ORDER = 220;

/** The compact tool's canonical result. */
interface CompactResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly compactedItems?: number;
  readonly freedTokens?: number;
  readonly contextPercent?: number;
  readonly mode?: 'pressure' | 'retention';
}

/** @param reason */
function failed(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** @param error */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether the failure is the recoverable "surface moved under us" race. */
function isSurfaceChanged(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if ((error as { name?: string }).name === 'SurfaceChangedError') return true;
  if ((error as { code?: unknown }).code === 'changed') return true;
  const message = errorMessage(error);
  return message.includes('surface changed')
    || message.includes('selected span changed')
    || message.includes('no longer a valid replacement target');
}

/** Deterministic failures where another attempt cannot help. */
function isDeterministicFailure(error: unknown): boolean {
  const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string') {
    if (code === 'MAX_TOKENS'
      || code === 'UNSUPPORTED_CONTENT'
      || code === 'INVALID_MODEL_INFO'
      || code === 'INVALID_MODEL_CONTEXT'
      || code === 'INVALID_MODEL_MAX_TOKENS'
      || code === 'INVALID_MODEL_REASONING'
      || code === 'commit'
      || code === 'persistence') {
      return true;
    }
  }
  const lower = errorMessage(error).toLowerCase();
  return lower.includes('not smaller than the shadowed content')
    || lower.includes('summarization truncated at the token cap')
    || lower.includes('cannot contain image output')
    || lower.includes('durability checkpoint failed')
    || lower.includes('did not commit cleanly')
    || lower.includes('no open turn')
    || lower.includes('not a balanced boundary')
    || lower.includes('no provider/model available')
    || lower.includes('no context capacity')
    || lower.includes('leaving no pressure budget')
    || lower.includes('compaction still above threshold')
    || lower.includes('compaction already in progress')
    || lower.includes('unmatched compaction')
    || lower.includes('does not match the current session surface')
    || lower.includes('not found in surface')
    || lower.includes('retained-tail policy is unavailable')
    || lower.includes('could not read the native retention policy')
    || lower.includes('could not select a native retained-tail range')
    || lower.includes('invalid api key')
    || lower.includes('unauthorized')
    || lower.includes('forbidden');
}

/** Whether a failed compaction is worth retrying after a short delay. */
function isRetryableFailure(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  if (isSurfaceChanged(error)) return false;
  const record = error !== null && typeof error === 'object' ? error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  } : {};
  if (record.code === 'busy' || record.code === 'cancelled') return false;
  const status = typeof record.status === 'number' ? record.status
    : typeof record.statusCode === 'number' ? record.statusCode
      : typeof record.response?.status === 'number' ? record.response.status
        : undefined;
  if (status !== undefined
    && status !== 0
    && status !== 408
    && status !== 425
    && status !== 429
    && status < 500) {
    return false;
  }
  return !isDeterministicFailure(error);
}

/** Abortable backoff between transient-failure retries. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Map an expected compaction failure to a model-readable reason. */
function describeError(error: unknown): string {
  const message = errorMessage(error);
  const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === 'busy') return 'compaction is already running; try again after the current step';
  if (code === 'cancelled') return 'compaction was cancelled';
  if (message.includes('no open turn')) return 'compaction is only available inside an active turn';
  if (message.includes('not a balanced boundary')) return 'the native selection would split a tool call from its result; try again after the next step';
  if (message.includes('not smaller than the shadowed content')) return 'a summary would not be smaller than the selected history; continue without compacting';
  if (message.includes('no provider/model available')) return 'no model route is available for summarization';
  if (message.includes('no context capacity')) return 'the compaction backend has no context capacity for the current route; check compaction-basic model configuration';
  if (message.includes('leaving no pressure budget')) return 'the compaction backend reserves more output/headroom than the context window allows; check compaction-basic model configuration';
  if (message.includes('compaction still above threshold')) return 'the native policy could not bring pressure below its threshold; continue with smaller steps or adjust the deployment compaction policy';
  if (message.includes('compaction already in progress')) return 'compaction is already running; try again after the current step';
  return `compaction failed: ${message}`;
}

/** compact_context takes no arguments; the native policy owns selection. */
function parseCompactArgs(raw: unknown): { ok: true } | { error: string } {
  if (raw === null || raw === undefined) return { ok: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'arguments must be an object' };
  }
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length > 0) {
    return { error: `compact_context takes no arguments; the native compaction policy chooses the range and retention (got ${keys.join(', ')})` };
  }
  return { ok: true };
}

/** Parse and validate context_status arguments. */
function parseStatusArgs(raw: unknown): StatusOptions | { error: string } {
  if (raw === null || raw === undefined) {
    return { includePolicy: true, includeBreakdown: false };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'arguments must be an object' };
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== 'include_policy' && key !== 'include_breakdown') {
      return { error: `unknown argument ${JSON.stringify(key)}; supported arguments are include_policy and include_breakdown` };
    }
  }
  const includePolicy = input.include_policy === undefined ? true : input.include_policy;
  const includeBreakdown = input.include_breakdown === undefined ? false : input.include_breakdown;
  if (typeof includePolicy !== 'boolean') return { error: 'include_policy must be a boolean' };
  if (typeof includeBreakdown !== 'boolean') return { error: 'include_breakdown must be a boolean' };
  return { includePolicy, includeBreakdown };
}

/** One compaction attempt can succeed through the native pressure gate or the native-retention fallback. */
type AttemptOutcome =
  | { kind: 'ok'; result: CompactionResult; mode: 'pressure' | 'retention' }
  | { kind: 'empty' }
  | { kind: 'failed'; reason: string; retryable?: boolean }
  | { kind: 'retry' };

/**
 * Below the native pressure threshold, compact through the native transaction
 * using the backend's resolved retention. This is the compatibility shim for
 * the missing public manual trigger; it contains no plugin retention policy.
 */
async function attemptNativeRetention(input: {
  ctx: Context;
  agent: Agent;
  signal: AbortSignal;
}): Promise<AttemptOutcome> {
  const { ctx, agent, signal } = input;
  const session = agent.session;
  let policy;
  try {
    // Only the window is consumed here; the token-meter fallback cannot
    // supply one, so never pay its O(surface) scan for this read.
    policy = await readPolicy(ctx, session, agent, readPressure(ctx, session, { measure: false }), signal);
  } catch (error) {
    return { kind: 'failed', reason: `could not read the native retention policy: ${errorMessage(error)}` };
  }
  if (!policy.known || policy.retainTokens === undefined || policy.invalidReason !== undefined) {
    const why = policy.invalidReason ?? 'the backend does not expose its resolved config';
    return { kind: 'failed', reason: `the native pressure policy did not compact, and its retained-tail policy is unavailable (${why}); continue without compacting` };
  }
  let measurement;
  try {
    measurement = ctx.tokenMeter.measure(session);
  } catch (error) {
    return { kind: 'failed', reason: `could not measure the context: ${errorMessage(error)}` };
  }
  let range;
  try {
    range = selectNativeRetentionRange(session, measurement, policy.retainTokens);
  } catch (error) {
    return { kind: 'failed', reason: `could not select a native retained-tail range: ${errorMessage(error)}` };
  }
  if (range === null) return { kind: 'empty' };
  try {
    const result = await ctx.compaction.compactRegion(range.start, range.end, agent, signal);
    return { kind: 'ok', result, mode: 'retention' };
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (isSurfaceChanged(error)) return { kind: 'retry' };
    return { kind: 'failed', reason: describeError(error), retryable: isRetryableFailure(error, signal) };
  }
}

/**
 * Run one native compaction attempt. First ask the pressure gate (the exact
 * method auto-compaction uses); if it declines, fall back to the native
 * retained-tail selection so the model can compact below the threshold.
 */
async function attemptCompaction(input: {
  ctx: Context;
  agent: Agent;
  signal: AbortSignal;
}): Promise<AttemptOutcome> {
  const { ctx, agent, signal } = input;
  try {
    const result = await ctx.compaction.compactIfNeeded(agent, 'pressure', signal);
    if (result !== null) return { kind: 'ok', result, mode: 'pressure' };
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (isSurfaceChanged(error)) return { kind: 'retry' };
    return { kind: 'failed', reason: describeError(error), retryable: isRetryableFailure(error, signal) };
  }
  return attemptNativeRetention(input);
}

/**
 * Run attempts with one surface-change retry and bounded backoff for transient
 * failures. Deterministic failures (summary too large, invalid config, busy)
 * are returned immediately.
 */
async function runAttempts(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
  config: ResolvedConfig,
): Promise<AttemptOutcome> {
  for (let retry = 0; ; retry += 1) {
    let outcome: AttemptOutcome = { kind: 'failed', reason: 'compaction did not run' };
    for (let surfaceAttempt = 0; surfaceAttempt < 2; surfaceAttempt += 1) {
      outcome = await attemptCompaction({ ctx, agent, signal });
      if (outcome.kind !== 'retry') break;
    }
    if (outcome.kind !== 'failed' || outcome.retryable !== true || retry >= config.retryAttempts) {
      return outcome;
    }
    await delay(Math.min(config.retryDelayMs * 2 ** retry, 60_000), signal);
  }
}

/**
 * Quantized occupancy for a tool result. `pressurePercent` needs a window, and
 * the token-meter measure fallback never supplies one, so this read skips that
 * O(surface) scan instead of paying for a value that can never be displayed.
 */
function contextPercentFor(ctx: Context, session: Session, step: number): number | undefined {
  return pressurePercent(readPressure(ctx, session, { measure: false }), step);
}

/** Render the compact tool's result. */
function renderCompactResult(value: CompactResult): string {
  if (value.ok !== true) {
    return typeof value.reason === 'string' ? value.reason : 'compaction did not run';
  }
  const items = value.compactedItems === 1 ? '1 older history item' : `${String(value.compactedItems)} older history items`;
  const percent = typeof value.contextPercent === 'number'
    ? ` Context use is now ~${String(value.contextPercent)}% (estimated).`
    : '';
  const via = value.mode === 'pressure'
    ? ' using the native pressure policy'
    : value.mode === 'retention'
      ? ' using the native retained-tail policy'
      : '';
  return `Compacted ${items}${via} (~${String(value.freedTokens)} estimated tokens) into one checkpoint.${percent} This was context maintenance, not a task step: continue the task from the checkpoint now.`;
}

/** Build the compact tool definition. */
function compactTool(ctx: Context, config: ResolvedConfig): ToolDefinition {
  return {
    name: COMPACT_TOOL,
    description: compactDescription(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          compactedItems: { type: 'integer' },
          freedTokens: { type: 'integer' },
          contextPercent: { type: 'integer' },
          mode: { type: 'string', enum: ['pressure', 'retention'] },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: renderCompactResult(value as CompactResult) }],
    },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<unknown> {
      const parsed = parseCompactArgs(rawArgs);
      if ('error' in parsed) return failed(parsed.error);
      const agent = exec.agent;
      if (agent === undefined || agent.session === undefined) {
        return failed('compact_context must run inside an agent turn');
      }
      if (exec.signal.aborted) exec.signal.throwIfAborted();
      const outcome = await runAttempts(ctx, agent, exec.signal, config);
      if (outcome.kind === 'retry') {
        return failed('the conversation changed while the summary was being written; try again');
      }
      if (outcome.kind === 'failed') return failed(outcome.reason);
      if (outcome.kind === 'empty') {
        const percent = contextPercentFor(ctx, agent.session, config.pressureStep);
        const detail = percent === undefined ? '' : ` Current estimated context use is ~${String(percent)}%.`;
        return failed(`neither the native pressure policy nor the native retained-tail selector produced a safe compaction: pressure may be below the threshold with no compactable history, or a single retained unit may be too large.${detail} Continue the task; automatic compaction remains governed by the deployment's compaction config.`);
      }

      const percent = contextPercentFor(ctx, agent.session, config.pressureStep);
      const result = outcome.result;
      const compactedItems = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0;
      const freedTokens = Number.isFinite(result.shadowedTokenCount) ? Math.max(0, Math.round(result.shadowedTokenCount)) : 0;
      return {
        ok: true,
        compactedItems,
        freedTokens,
        mode: outcome.mode,
        ...(percent === undefined ? {} : { contextPercent: percent }),
      } satisfies CompactResult;
    },
  } as unknown as ToolDefinition;
}

/** Build the read-only context status tool definition. */
function statusTool(ctx: Context): ToolDefinition {
  return {
    name: STATUS_TOOL,
    description: statusDescription(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_policy: {
          type: 'boolean',
          description: 'Include automatic-compaction policy when the mounted backend exposes it. Defaults to true.',
        },
        include_breakdown: {
          type: 'boolean',
          description: 'Include the heuristic system/tools/messages composition. Defaults to false.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          tokens: { type: 'integer' },
          window: { type: 'integer' },
          percent: { type: 'integer' },
          remaining: { type: 'integer' },
          source: { type: 'string', enum: ['provider', 'surface', 'unknown'] },
          policyKnown: { type: 'boolean' },
          auto: { type: 'boolean' },
          threshold: { type: 'integer' },
          thresholdPercent: { type: 'integer' },
          retain: { type: 'integer' },
          aboveThreshold: { type: 'boolean' },
          backend: { type: 'string' },
          policyReason: { type: 'string' },
          systemTokens: { type: 'integer' },
          toolsTokens: { type: 'integer' },
          messageTokens: { type: 'integer' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: renderStatus(value as ContextStatus) }],
    },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<unknown> {
      const parsed = parseStatusArgs(rawArgs);
      if ('error' in parsed) return failed(parsed.error);
      const agent = exec.agent;
      if (agent === undefined || agent.session === undefined) {
        return failed('context_status must run inside an agent turn');
      }
      if (exec.signal.aborted) exec.signal.throwIfAborted();
      try {
        return await buildStatus(ctx, agent, parsed, exec.signal);
      } catch (error) {
        if (exec.signal.aborted) exec.signal.throwIfAborted();
        return failed(`context status failed: ${errorMessage(error)}`);
      }
    },
  } as unknown as ToolDefinition;
}

/**
 * Register the optional prompt contributions and the enabled tools.
 *
 * The Web form fields are volatile, so the loader hands them over as accessors
 * and emits `loader/volatile-update` for a live write. Resolve them to plain
 * values, build one disposable layout, and rebuild that layout when a setting
 * changes so the switches apply without a profile restart.
 *
 * @param ctx plugin context
 * @param rawConfig loader-resolved row config (plain values or volatile accessors)
 */
export function apply(ctx: Context, rawConfig: Record<string, unknown> = {}): void {
  const config = resolveConfig(rawConfig);
  validateConfig(config);

  // `tools.get()` rebuilds the whole per-scope view (layers, restrictions,
  // inherited maps). Prompt callbacks run every model step, so cache the one
  // name they ask about and drop the cache whenever the registry changes.
  let compactVisibility = new WeakMap<Agent, boolean>();
  const resetVisibility = (): void => {
    compactVisibility = new WeakMap();
  };

  /** Whether this agent can actually see compact_context. */
  const compactVisible = (agent: Agent | undefined): boolean => {
    if (agent === undefined || agent === null) return true;
    const cached = compactVisibility.get(agent);
    if (cached !== undefined) return cached;
    let result: boolean;
    try {
      result = ctx.tools.get(COMPACT_TOOL, agent) !== undefined;
    } catch {
      result = true;
    }
    compactVisibility.set(agent, result);
    return result;
  };

  let layout: Array<() => void> = [];
  let restorePtc: (() => void) | undefined;

  const teardown = (): void => {
    for (const dispose of layout.splice(0).reverse()) dispose();
    restorePtc?.();
    restorePtc = undefined;
    resetVisibility();
  };

  const register = (disposer: unknown): void => {
    if (typeof disposer === 'function') layout.push(disposer as () => void);
  };

  const build = (next: ResolvedConfig): void => {
    teardown();
    restorePtc = installPtcTimeoutOverride(ctx, next);
    if (next.compactTool && next.guidance) {
      const policyText = next.guidanceText.trim() === '' ? GUIDANCE : next.guidanceText;
      register(ctx.systemPrompt.section({
        name: 'tool-compact-context:guidance',
        order: SECTION_ORDER,
        interpolate: false,
        text: (context) => (compactVisible(context.agent) ? policyText : ''),
      }));
    }
    if (next.pressureContext && next.compactTool) {
      register(ctx.systemPrompt.context({
        name: 'tool-compact-context:pressure',
        order: CONTEXT_ORDER,
        interpolate: false,
        text: (context) => {
          const agent = context.agent;
          if (agent === undefined || agent === null) return '';
          if (next.compactTool && !compactVisible(agent)) return '';
          return pressureText(readPressure(ctx, agent.session, { measure: false, cached: true }), {
            notifyAtRatio: next.notifyAtRatio,
            pressureStep: next.pressureStep,
          }, next.compactTool);
        },
      }));
    }
    if (next.compactTool) register(ctx.tools.register(compactTool(ctx, next)));
    if (next.statusTool) register(ctx.tools.register(statusTool(ctx)));
  };

  // A minimal composition may expose the registry without the event face.
  if (typeof ctx.on === 'function') {
    // `loader/volatile-update` is a loader event, not part of this package's
    // typed event surface.
    const on = ctx.on as unknown as (event: string, listener: () => void) => void;
    on('tools/change', resetVisibility);
    on('loader/volatile-update', () => {
      let next: ResolvedConfig;
      try {
        next = resolveConfig(rawConfig);
        validateConfig(next);
      } catch {
        // Keep the last accepted layout; a rejected write must not take the
        // model-facing tools offline.
        return;
      }
      build(next);
    });
  }

  build(config);

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => teardown(), 'dsh-tool-compact-context: settings layout');
  }
}
