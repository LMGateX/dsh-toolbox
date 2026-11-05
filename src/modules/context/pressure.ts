// Adapted from dsh-tool-compact-context; original MIT license retained in NOTICE.txt.
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-token-meter';
import type { Session } from '@deepseek-ai/dsh-session';

/** Where an occupancy figure came from. */
export type PressureSource = 'provider' | 'surface' | 'unknown';

/** The newest next-request occupancy reading. */
export interface PressureReading {
  readonly tokens?: number;
  readonly window?: number;
  readonly source: PressureSource;
}

/** Heuristic composition of the next request. */
export interface BreakdownReading {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly messageTokens: number;
}

/** The projection service face this plugin reads; optional in a composition. */
interface ProjectionReader {
  snapshot(session: Session, keys?: readonly string[]): {
    readonly values?: {
      readonly contextPressure?: {
        readonly projectedTokens?: number;
        readonly pressureTokens?: number;
        readonly contextWindow?: number;
      };
      readonly contextBreakdown?: {
        readonly systemTokens?: number;
        readonly toolsTokens?: number;
        readonly messageTokens?: number;
      };
    };
  };
  cachedSnapshot?(session: Session, keys?: readonly string[]): {
    readonly asOfSeq: number;
    readonly values?: {
      readonly contextPressure?: {
        readonly projectedTokens?: number;
        readonly pressureTokens?: number;
        readonly contextWindow?: number;
      };
    };
  } | undefined;
}

/**
 * Read the newest next-request prompt estimate and route capacity.
 * Prefers the token meter's projection (O(1), provider-anchored), falls back
 * to a full measurement when projections are unavailable, and degrades to an
 * empty reading rather than breaking prompt assembly. The optional pressure
 * line passes `measure: false` so a hidden line never pays an O(surface) scan
 * on every prompt assembly.
 *
 * With `cached`, prefer the registry's already-driven client view when it has
 * consumed the whole log, and materialize history only when the cell is absent
 * or trailing. Prompt assembly uses it because that line is a hint; exact tool
 * readings keep the snapshot path. The registry drives cells synchronously
 * from `session/event`, so a current cell costs a few map reads instead of a
 * full materialization pass over every projection unit.
 */
export function readPressure(
  ctx: Context,
  session: Session,
  options: { readonly measure?: boolean; readonly cached?: boolean } = {},
): PressureReading {
  const projections = ctx.get('sessionProjections') as ProjectionReader | undefined;
  if (projections !== undefined && projections !== null) {
    try {
      const cached = options.cached === true && typeof projections.cachedSnapshot === 'function'
        ? projections.cachedSnapshot(session, ['contextPressure'])
        : undefined;
      // The cursor before the next event: a current cell has consumed it.
      const snapshot = cached !== undefined && cached.asOfSeq === session.seq - 1
        ? cached
        : projections.snapshot(session, ['contextPressure']);
      const value = snapshot?.values?.contextPressure;
      const tokens = value?.projectedTokens ?? value?.pressureTokens;
      const window = value?.contextWindow;
      if (typeof tokens === 'number' && tokens >= 0 && typeof window === 'number' && window > 0) {
        return { tokens, window, source: 'provider' };
      }
      if (typeof tokens === 'number' && tokens >= 0) {
        return { tokens, source: 'provider' };
      }
    } catch {
      // The projection may not be registered or materialized yet; measure instead.
    }
  }
  if (options.measure === false) return { source: 'unknown' };
  try {
    const measured = ctx.tokenMeter.measure(session);
    const tokens = typeof measured?.surfaceTokens === 'number' ? measured.surfaceTokens : measured?.totalTokens;
    if (typeof tokens === 'number' && tokens >= 0) return { tokens, source: 'surface' };
  } catch {
    // A measurement failure must not make prompt assembly fail.
  }
  return { source: 'unknown' };
}

/**
 * Read the heuristic system/tools/messages composition, when the composition
 * registers that projection. This is an estimate, not a billing record.
 */
export function readBreakdown(ctx: Context, session: Session): BreakdownReading | undefined {
  const projections = ctx.get('sessionProjections') as ProjectionReader | undefined;
  if (projections === undefined || projections === null) return undefined;
  try {
    const snapshot = projections.snapshot(session, ['contextBreakdown']);
    const value = snapshot?.values?.contextBreakdown;
    if (value === undefined) return undefined;
    return {
      systemTokens: typeof value.systemTokens === 'number' ? value.systemTokens : 0,
      toolsTokens: typeof value.toolsTokens === 'number' ? value.toolsTokens : 0,
      messageTokens: typeof value.messageTokens === 'number' ? value.messageTokens : 0,
    };
  } catch {
    return undefined;
  }
}

/** Quantized percentage of the window in use, or undefined when unknown. */
export function pressurePercent(pressure: PressureReading, step: number): number | undefined {
  if (typeof pressure.tokens !== 'number' || typeof pressure.window !== 'number' || pressure.window <= 0) {
    return undefined;
  }
  const raw = Math.round((pressure.tokens / pressure.window) * 100 / step) * step;
  return Math.max(0, Math.min(100, raw));
}

/**
 * The optional runtime-context line. It is deliberately quantized: runtime
 * context snapshots are appended when their text changes, so a per-step
 * percentage would append a message every step.
 */
export function pressureText(
  pressure: PressureReading,
  config: { notifyAtRatio: number; pressureStep: number },
  toolAvailable = true,
): string {
  const percent = pressurePercent(pressure, config.pressureStep);
  if (percent === undefined) return '';
  if (typeof pressure.tokens === 'number' && typeof pressure.window === 'number') {
    if (pressure.tokens / pressure.window < config.notifyAtRatio) return '';
  }
  const advice = toolAvailable
    ? ' A compact_context tool can condense older history if the remaining work needs more room.'
    : '';
  return `Estimated context use: ~${String(percent)}% of the window.${advice}`;
}
