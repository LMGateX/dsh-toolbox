// Adapted from dsh-goal-wait-gate; original MIT license retained in NOTICE.txt.
/**
 * dsh-goal-wait-gate: withhold automatic goal continuation while the owning
 * agent still has live background work.
 *
 * The plugin never touches the official goal packages. It toggles only the
 * process-local continuation activation of the agent's current goal, which is
 * the input the official goal-round driver reads at every idle.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-jobs'
import { Config, resolveConfig } from './config.ts'
import { GoalWaitGate } from './gate.ts'

/** Registered plugin name. */
export const name = 'toolbox-goal-wait'

/** Services this plugin cannot work without. */
export const inject = ['agents', 'goals']

export { Config, resolveConfig } from './config.ts'

/**
 * Mount the gate.
 *
 * @param ctx - the plugin context carrying the agent registry and goal service.
 * @param config - gate policy; defaults hold on every available signal.
 */
export function apply(ctx: Context, config: Config = {}): void {
  let resolved = resolveConfig(config)
  const readPolicy = () => {
    try { resolved = resolveConfig(config) } catch (error) {
      ctx.logger.warn(`goal-wait-gate: invalid live policy ignored: ${error instanceof Error ? error.message : String(error)}`)
    }
    return resolved
  }
  const gate = new GoalWaitGate(ctx, readPolicy)
  ctx.logger.info(
    `goal-wait-gate: mounted (waitForJobs=${resolved.waitForJobs}, waitForSubagents=${resolved.waitForSubagents}, maxHoldMs=${resolved.maxHoldMs})`,
  )

  // Primary checkpoint: the turn loop awaits this before the agent turns idle,
  // so the goal is already gated when the official driver's idle check runs.
  ctx.on('agent/turn-stopping', ({ agent }) => {
    gate.evaluate(agent)
  })

  // Safety net for turn shapes that end without turn-stopping.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    gate.evaluate(agent)
  }, { prepend: true })

  // A goal created, edited, or resumed while live work is already pending must
  // not start an empty round: the official driver turns `goal/changed` into a
  // drive request, so this listener runs before its own.
  ctx.on('goal/changed', ({ agent }) => {
    gate.evaluate(agent)
  }, { prepend: true })

  // A disposed agent's session may be resumed later as a fresh agent; the old
  // bookkeeping must not leak into it.
  ctx.on('agent/disposed', ({ agent }) => {
    gate.forget(agent)
  })

  // Unloading the gate restores official behavior: re-arm the goals it holds.
  ctx.effect(() => () => gate.dispose(), 'goal-wait-gate teardown')
}

/** Mountable plugin value, also usable from tests and manual compositions. */
export const goalWaitGate = { name, inject, apply, Config }
