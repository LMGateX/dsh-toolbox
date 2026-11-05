import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';

/** Public native preset service face; no dependency on private Loader trees. */
interface PresetServices {
  composedPreset(ctx: Context): string | undefined;
  serviceFor(agent: Agent, name: 'compaction'): Context['compaction'] | undefined;
}

/**
 * Bind one operation to the exact Agent's public context and retained preset.
 * Native presets isolate compaction in a descendant group, so ordinary context
 * inheritance alone cannot find it. The native registry owns that lookup.
 * A preset without an engine must not accidentally dispatch to a host engine.
 */
export function contextForAgent(host: Context, agent: Agent): Context {
  const scope = agent.ctx;
  // Legacy minimal compositions/tests predate Agent.ctx. Real native Agents always
  // provide it; never fall back to the host merely because their engine is absent.
  if (scope === undefined) return host;
  const presets = scope.get('agentPresets') as PresetServices | undefined;
  const compaction = presets?.composedPreset(scope) === undefined
    ? scope.get('compaction') : presets.serviceFor(agent, 'compaction');
  const resolved = Object.create(scope) as Context;
  // Dynamic public get() is intentional: Agent.ctx has its own injection list,
  // whereas this capability adapter owns these optional per-operation reads.
  for (const [name, value] of Object.entries({ compaction, tokenMeter: scope.get('tokenMeter'), llm: scope.get('llm') })) {
    Object.defineProperty(resolved, name, { value, enumerable: true });
  }
  return resolved;
}
