// Adapted from dsh-goal-wait-gate; original MIT license retained in NOTICE.txt.
/**
 * The gate's decision: hold continuation while the agent owns live background
 * work, release it once the work is consumed.
 *
 * Gating is expressed only through the goal service's process-local activation
 * seam (`disarm` when holding, `resume` when releasing). The durable phase is
 * never touched, and every official continuation mechanism stays in charge.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import type { ResolvedConfig } from './config.ts'
import { hasLiveJobs, hasLiveSubagents } from './live-work.ts'

/** Gate one live agent's goal continuation. */
export class GoalWaitGate {
  readonly #ctx: Context
  readonly #config: () => ResolvedConfig
  /** Goal ids this gate disarmed and still owns, per exact live agent. */
  readonly #heldGoals = new Map<Agent, string>()
  /** Goal ids this gate conceded to an explicit human re-arm, per exact live agent. */
  readonly #yieldedGoals = new Map<Agent, string>()
  readonly #expiryTimers = new Map<Agent, ReturnType<typeof setTimeout>>()
  #stopping = false

  constructor(ctx: Context, config: ResolvedConfig | (() => ResolvedConfig)) {
    this.#ctx = ctx
    this.#config = typeof config === 'function' ? config : () => config
  }

  /**
   * Evaluate one exact live agent: hold continuation while it owns live work,
   * release a hold this gate owns once the work is gone.
   *
   * @param agent - the live agent whose goal should be evaluated.
   */
  evaluate(agent: Agent): void {
    if (this.#stopping) return
    try {
      const goal = this.#ctx.goals.get(agent)
      if (this.#hasLiveWork(agent)) this.#hold(agent, goal)
      else this.#release(agent, goal)
    } catch (error) {
      this.#ctx.logger.warn(
        `goal-wait-gate: evaluation failed for agent "${agent.id}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Drop all bookkeeping for one agent that is no longer live. */
  forget(agent: Agent): void {
    this.#heldGoals.delete(agent)
    this.#yieldedGoals.delete(agent)
    this.#clearExpiry(agent)
  }

  /** Managed ownership closes without restoring automatic continuation. */
  closeWithoutRearm(): void {
    this.#stopping = true
    for (const agent of [...this.#expiryTimers.keys()]) this.#clearExpiry(agent)
    this.#heldGoals.clear()
    this.#yieldedGoals.clear()
  }

  /**
   * Legacy unload re-arms owned holds, restoring official continuation.
   * Managed startup uses closeWithoutRearm instead. Failures are contained.
   */
  dispose(): void {
    this.#stopping = true
    for (const agent of [...this.#expiryTimers.keys()]) this.#clearExpiry(agent)
    for (const [agent, heldGoal] of [...this.#heldGoals]) {
      try {
        const goal = this.#ctx.goals.get(agent)
        if (goal !== undefined && goal.id === heldGoal && goal.phase === 'active' && goal.activation === 'disarmed') {
          this.#ctx.goals.resume(agent, goalRef(goal))
          this.#logRelease(agent, goal, 'plugin unloading')
        }
      } catch (error) {
        this.#ctx.logger.warn(
          `goal-wait-gate: could not re-arm agent "${agent.id}" on unload: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      this.#heldGoals.delete(agent)
    }
    this.#yieldedGoals.clear()
  }

  /** Whether any configured signal reports live owned work. */
  #hasLiveWork(agent: Agent): boolean {
    const config = this.#config()
    if (config.waitForJobs && hasLiveJobs(this.#ctx, agent)) return true
    if (config.waitForSubagents && hasLiveSubagents(this.#ctx, agent)) return true
    return false
  }

  /**
   * One holding evaluation: reconcile any recorded hold, then disarm an
   * active armed goal and record it.
   *
   * @param agent - the live agent being evaluated.
   * @param goal - the goal read for this evaluation.
   */
  #hold(agent: Agent, goal: GoalView | undefined): void {
    if (this.#reconcile(agent, goal)) return
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    this.#ctx.goals.disarm(agent)
    this.#heldGoals.set(agent, goal.id)
    this.#ctx.logger.info(
      `goal-wait-gate: held agent "${agent.id}" goal ${goal.id} rev ${goal.revision}: live background work pending`,
    )
    this.#scheduleExpiry(agent)
  }

  /**
   * Reconcile the recorded hold against the current goal before deciding.
   *
   * A goal re-armed while this gate holds it was re-armed by someone else: the
   * explicit action wins, so the hold is dropped and the goal is yielded for
   * the rest of this wait. A hold whose goal was replaced, cleared, or left
   * `active` is stale and is forgotten.
   *
   * @param agent - the live agent being evaluated.
   * @param goal - the goal read for this evaluation.
   * @returns whether this wait is yielded, so no continuation may be withheld.
   */
  #reconcile(agent: Agent, goal: GoalView | undefined): boolean {
    const yieldedGoal = this.#yieldedGoals.get(agent)
    if (yieldedGoal !== undefined && yieldedGoal !== goal?.id) this.#yieldedGoals.delete(agent)

    const heldGoal = this.#heldGoals.get(agent)
    if (heldGoal !== undefined) {
      const stillHeld = goal !== undefined && goal.id === heldGoal && goal.phase === 'active'
      if (!stillHeld) {
        this.#heldGoals.delete(agent)
      } else if (goal.activation === 'armed') {
        this.#heldGoals.delete(agent)
        this.#yieldedGoals.set(agent, goal.id)
        this.#ctx.logger.info(
          `goal-wait-gate: human re-arm wins for agent "${agent.id}" goal ${goal.id}; leaving this wait ungated`,
        )
        return true
      }
    }
    return goal !== undefined && this.#yieldedGoals.get(agent) === goal.id
  }

  /**
   * Re-arm the goal this gate holds once no live work remains.
   *
   * Only a hold this gate recorded is released, and only while the goal is
   * still the same identity, still active, and still disarmed. Resuming reads
   * the current revision, so an official edit while held does not strand the
   * goal.
   *
   * @param agent - the live agent being evaluated.
   * @param goal - the goal read for this evaluation.
   */
  #release(agent: Agent, goal: GoalView | undefined): void {
    // The wait is over: the next live-work episode is gated from scratch.
    this.#yieldedGoals.delete(agent)
    this.#clearExpiry(agent)
    const heldGoal = this.#heldGoals.get(agent)
    if (heldGoal === undefined) return
    this.#heldGoals.delete(agent)
    if (goal === undefined || goal.id !== heldGoal || goal.phase !== 'active' || goal.activation !== 'disarmed') return
    this.#ctx.goals.resume(agent, goalRef(goal))
    this.#logRelease(agent, goal, 'no live background work')
  }

  /** One release line naming the agent, goal, and reason. */
  #logRelease(agent: Agent, goal: GoalView, reason: string): void {
    this.#ctx.logger.info(
      `goal-wait-gate: released agent "${agent.id}" goal ${goal.id} rev ${goal.revision}: ${reason}`,
    )
  }

  /** Arm this hold's escape hatch, when a maximum hold time is configured. */
  #scheduleExpiry(agent: Agent): void {
    this.#clearExpiry(agent)
    const { maxHoldMs } = this.#config()
    if (maxHoldMs <= 0) return
    const timer = setTimeout(() => {
      this.#expiryTimers.delete(agent)
      this.#expire(agent, maxHoldMs)
    }, maxHoldMs)
    timer.unref()
    this.#expiryTimers.set(agent, timer)
  }

  /** Cancel the escape hatch for one agent. */
  #clearExpiry(agent: Agent): void {
    const timer = this.#expiryTimers.get(agent)
    if (timer === undefined) return
    clearTimeout(timer)
    this.#expiryTimers.delete(agent)
  }

  /**
   * Release one hold that outlived the configured maximum, so a stuck job
   * cannot freeze the goal forever, and leave the rest of this wait ungated:
   * the release must not be undone by the gate's own `goal/changed`
   * evaluation. A later wait gets its own escape hatch. Logs one warning per
   * hold.
   */
  #expire(agent: Agent, maxHoldMs: number): void {
    if (this.#stopping) return
    const heldGoal = this.#heldGoals.get(agent)
    if (heldGoal === undefined) return
    this.#heldGoals.delete(agent)
    this.#yieldedGoals.set(agent, heldGoal)
    try {
      const goal = this.#ctx.goals.get(agent)
      if (goal !== undefined && goal.id === heldGoal && goal.phase === 'active' && goal.activation === 'disarmed') {
        this.#ctx.goals.resume(agent, goalRef(goal))
        this.#ctx.logger.warn(
          `goal-wait-gate: released agent "${agent.id}" goal ${goal.id} rev ${goal.revision}: hold expired after ${maxHoldMs}ms`,
        )
      }
    } catch (error) {
      this.#ctx.logger.warn(
        `goal-wait-gate: could not release expired hold for agent "${agent.id}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/** Compare-and-set ref for one goal view. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}
