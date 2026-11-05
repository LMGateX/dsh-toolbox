// Adapted from dsh-tool-compact-context; original MIT license retained in NOTICE.txt.
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { BreakdownReading, PressureReading } from './pressure.ts';
import { readBreakdown, readPressure } from './pressure.ts';
import { readPolicy } from './policy.ts';
import type { PolicyReading } from './policy.ts';

/** A read-only snapshot returned by the context_status tool. */
export interface ContextStatus {
  readonly ok: boolean;
  readonly reason?: string;
  readonly tokens?: number;
  readonly window?: number;
  readonly percent?: number;
  readonly remaining?: number;
  readonly source?: string;
  readonly policyKnown?: boolean;
  readonly auto?: boolean;
  readonly threshold?: number;
  readonly thresholdPercent?: number;
  readonly retain?: number;
  readonly aboveThreshold?: boolean;
  readonly backend?: string;
  readonly policyReason?: string;
  readonly systemTokens?: number;
  readonly toolsTokens?: number;
  readonly messageTokens?: number;
}

/** Options parsed from the status tool arguments. */
export interface StatusOptions {
  readonly includePolicy: boolean;
  readonly includeBreakdown: boolean;
}

/** Thousands separators without depending on the ambient locale. */
function formatCount(value: number): string {
  const rounded = Math.round(value);
  const digits = String(Math.abs(rounded));
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return `${rounded < 0 ? '-' : ''}${groups.join(',')}`;
}

/**
 * Build one status reading. Every expensive or optional fact is best-effort:
 * a missing projection, adapter capability, or backend config produces an
 * explicit unknown rather than an error.
 */
export async function buildStatus(
  ctx: Context,
  agent: Agent,
  options: StatusOptions,
  signal: AbortSignal,
): Promise<ContextStatus> {
  const session = agent.session;
  const pressure: PressureReading = readPressure(ctx, session);
  const status: {
    ok: true;
    tokens?: number;
    window?: number;
    percent?: number;
    remaining?: number;
    source?: string;
    policyKnown?: boolean;
    auto?: boolean;
    threshold?: number;
    thresholdPercent?: number;
    retain?: number;
    aboveThreshold?: boolean;
    backend?: string;
    policyReason?: string;
    systemTokens?: number;
    toolsTokens?: number;
    messageTokens?: number;
  } = { ok: true, source: pressure.source };

  if (typeof pressure.tokens === 'number') status.tokens = pressure.tokens;
  if (typeof pressure.window === 'number') {
    status.window = pressure.window;
    if (typeof pressure.tokens === 'number' && pressure.window > 0) {
      status.percent = Math.max(0, Math.min(100, Math.round((pressure.tokens / pressure.window) * 100)));
      status.remaining = Math.max(0, pressure.window - pressure.tokens);
    }
  }

  if (options.includePolicy) {
    const policy: PolicyReading = await readPolicy(ctx, session, agent, pressure, signal);
    status.policyKnown = policy.known;
    status.backend = policy.backend;
    if (policy.auto !== undefined) status.auto = policy.auto;
    if (policy.thresholdTokens !== undefined) {
      status.threshold = policy.thresholdTokens;
      if (status.window !== undefined && status.window > 0) {
        status.thresholdPercent = Math.round((policy.thresholdTokens / status.window) * 100);
      }
      if (typeof pressure.tokens === 'number') status.aboveThreshold = pressure.tokens >= policy.thresholdTokens;
    }
    if (policy.retainTokens !== undefined) status.retain = policy.retainTokens;
    if (policy.invalidReason !== undefined) status.policyReason = policy.invalidReason;
    else if (!policy.known) status.policyReason = 'the mounted backend does not expose its resolved config';
  }

  if (options.includeBreakdown) {
    const breakdown: BreakdownReading | undefined = readBreakdown(ctx, session);
    if (breakdown !== undefined) {
      status.systemTokens = breakdown.systemTokens;
      status.toolsTokens = breakdown.toolsTokens;
      status.messageTokens = breakdown.messageTokens;
    }
  }

  return status;
}

/**
 * Render a status reading as compact model-facing text. The result is a normal
 * tool result: it enters history only because the model asked for it.
 */
export function renderStatus(value: ContextStatus): string {
  if (value.ok !== true) return value.reason ?? 'context status is unavailable';
  const parts: string[] = [];
  if (typeof value.tokens === 'number' && typeof value.window === 'number' && typeof value.percent === 'number') {
    parts.push(`Context: ~${String(value.percent)}% (${formatCount(value.tokens)} / ${formatCount(value.window)} projected next request).`);
    if (typeof value.remaining === 'number') parts.push(`~${formatCount(value.remaining)} left.`);
  } else if (typeof value.tokens === 'number') {
    parts.push(`Context: ~${formatCount(value.tokens)} estimated tokens (window unknown).`);
  } else {
    parts.push('Context: unavailable (no measurement or provider usage yet).');
  }
  if (value.policyKnown === true) {
    if (value.auto !== undefined) parts.push(`Auto-compaction: ${value.auto ? 'on' : 'off'}.`);
    if (typeof value.threshold === 'number') {
      const percent = typeof value.thresholdPercent === 'number' ? ` (${String(value.thresholdPercent)}%)` : '';
      parts.push(`threshold ~${formatCount(value.threshold)}${percent}.`);
    }
    if (typeof value.retain === 'number') parts.push(`retained tail ~${formatCount(value.retain)}.`);
    if (value.aboveThreshold !== undefined) parts.push(`above threshold: ${value.aboveThreshold ? 'yes' : 'no'}.`);
  } else if (value.policyKnown === false) {
    parts.push('Auto-compaction policy: unknown.');
  }
  if (value.policyReason !== undefined) parts.push(`(${value.policyReason})`);
  if (typeof value.systemTokens === 'number' && typeof value.toolsTokens === 'number' && typeof value.messageTokens === 'number') {
    parts.push(`Breakdown (heuristic): system ${formatCount(value.systemTokens)}, tools ${formatCount(value.toolsTokens)}, messages ${formatCount(value.messageTokens)}.`);
  }
  return parts.join(' ');
}
