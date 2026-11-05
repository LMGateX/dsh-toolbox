// Adapted from dsh-tool-compact-context; original MIT license retained in NOTICE.txt.
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { PressureReading } from './pressure.ts';

/**
 * Structural view of the mounted compaction backend's resolved config.
 * Reading this field is a best-effort probe: only the shipped basic backend
 * exposes it, and the seam itself does not require it.
 */
export interface BackendConfigLike {
  readonly thresholdRatio?: number;
  readonly headroomTokens?: number;
  readonly retainRatio?: number;
  readonly retainTokens?: number;
  readonly auto?: boolean;
  readonly modelPolicies?: readonly ModelPolicyLike[];
}

/** One exact provider/model override inside the backend config. */
export interface ModelPolicyLike extends BackendConfigLike {
  readonly provider: string;
  readonly model: string;
}

/** What the status tool can say about current compaction policy. */
export interface PolicyReading {
  readonly known: boolean;
  readonly backend: string;
  readonly auto?: boolean;
  readonly thresholdTokens?: number;
  readonly thresholdRatio?: number;
  readonly retainTokens?: number;
  readonly invalidReason?: string;
}

/** The routed model pair, from the latest header or the agent options. */
function routeOf(session: Session, agent: Agent): { provider: string; model: string } | undefined {
  const header = typeof session.requestHeader === 'function' ? session.requestHeader()?.config : undefined;
  if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
    return { provider: header.provider, model: header.model };
  }
  const provider = agent.options.provider;
  const model = agent.options.model;
  if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
    return { provider, model };
  }
  return undefined;
}

/**
 * Report the effective automatic-compaction policy for the current route.
 *
 * The canonical policy still lives in the backend: this only reproduces the
 * basic backend's documented `floor(min(W * ratio, W - O - headroom))`
 * formula so a model that asks for a reading does not have to guess. Any
 * missing fact produces `known: false` or an `invalidReason`, never an
 * invented number.
 */
export async function readPolicy(
  ctx: Context,
  session: Session,
  agent: Agent,
  pressure: PressureReading,
  signal: AbortSignal,
): Promise<PolicyReading> {
  const engine = ctx.compaction as unknown as {
    readonly config?: BackendConfigLike;
    readonly constructor?: { readonly name?: string };
  };
  if (engine === undefined || engine === null) {
    return { known: false, backend: 'unavailable', invalidReason: 'no compaction backend is available for this agent' };
  }
  const backend = engine.constructor?.name ?? 'compaction';
  const raw = engine.config;
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return { known: false, backend };
  }
  if (typeof raw.thresholdRatio !== 'number'
    || typeof raw.headroomTokens !== 'number'
    || (typeof raw.retainRatio !== 'number' && typeof raw.retainTokens !== 'number')) {
    return {
      known: false,
      backend,
      invalidReason: 'the mounted backend config does not expose the basic policy fields',
    };
  }
  const route = routeOf(session, agent);
  if (route === undefined) {
    return { known: false, backend, invalidReason: 'no routed provider/model is available yet' };
  }
  const override = raw.modelPolicies?.find((entry) => entry.provider === route.provider && entry.model === route.model);

  const headerMax = typeof session.requestHeader === 'function' ? session.requestHeader()?.config.maxTokens : undefined;
  let window = pressure.window;
  let adapterDefault: number | undefined;
  if (window === undefined || headerMax === undefined) {
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
      window ??= info.context?.contextWindow;
      adapterDefault = info.defaultMaxTokens;
    } catch {
      // A status read must not fail because capability lookup failed.
    }
  }
  if (window === undefined) {
    return { known: true, backend, auto: raw.auto !== false, invalidReason: 'context window is unknown for this route' };
  }

  const ratio = override?.thresholdRatio ?? raw.thresholdRatio;
  const headroom = override?.headroomTokens ?? raw.headroomTokens;
  const outputReservation = typeof headerMax === 'number' ? headerMax : adapterDefault ?? 0;
  const auto = raw.auto !== false;
  const available = window - outputReservation - headroom;
  if (available <= 0) {
    return {
      known: true,
      backend,
      auto,
      thresholdRatio: ratio,
      invalidReason: 'the output reservation plus headroom exhausts the context window',
    };
  }
  const thresholdTokens = Math.floor(Math.min(window * ratio, available));
  // Match resolveTargetPolicy's precedence: a model override's retainTokens or
  // retainRatio replaces the global retention entirely; otherwise inherit it.
  const retainTokens = override !== undefined && typeof override.retainTokens === 'number'
    ? override.retainTokens
    : override !== undefined && typeof override.retainRatio === 'number'
      ? Math.floor(override.retainRatio * (window - outputReservation))
      : typeof raw.retainTokens === 'number'
        ? raw.retainTokens
        : Math.floor((raw.retainRatio ?? 0.16) * (window - outputReservation));
  if (retainTokens >= thresholdTokens) {
    return {
      known: true,
      backend,
      auto,
      thresholdTokens,
      thresholdRatio: ratio,
      retainTokens,
      invalidReason: 'the retained tail is not smaller than the threshold; the backend would reject this policy',
    };
  }
  return {
    known: true,
    backend,
    auto,
    thresholdTokens,
    thresholdRatio: ratio,
    retainTokens,
  };
}
