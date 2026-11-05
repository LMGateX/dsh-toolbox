// Adapted from dsh-goal-wait-gate; original MIT license retained in NOTICE.txt.
/**
 * Live work owned by one session: the background the agent started and has not
 * finished consuming. Only live work holds goal continuation; durable records
 * of settled work must not.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'

/**
 * Whether the session owns any live subagent descendant at any depth.
 *
 * Liveness is the live agent registry, not the durable child catalog: a
 * settled child is no longer registered, and a child that merely exists as a
 * session record must not hold continuation. Only sessions whose header names
 * a parent and carries the subagent origin are descendants; a fork shares the
 * lineage field without that origin and is an independent conversation.
 *
 * Every registered descendant counts, including one between turns. The
 * official archive-admission walk traverses the same lineage but collects only
 * `status === "running"` children, because a session may be archived once its
 * idle children are cancelled. For this gate the unit is the live activation
 * epoch, not the child's current turn: a resident child has not settled, so
 * its settlement notice has not reached the parent, and releasing early would
 * let the official driver inject a round before that notice is consumed.
 */
export function hasLiveSubagents(ctx: Context, agent: Agent): boolean {
  const childrenByParent = new Map<string, Agent[]>()
  for (const candidate of ctx.agents.list()) {
    const { parentSession, origin } = candidate.session.header
    if (parentSession === undefined || origin !== 'subagent') continue
    const siblings = childrenByParent.get(parentSession)
    if (siblings === undefined) childrenByParent.set(parentSession, [candidate])
    else siblings.push(candidate)
  }

  const visited = new Set<string>()
  const pending = [String(agent.session.id)]
  while (pending.length > 0) {
    const parentId = pending.pop()
    if (parentId === undefined) continue
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      pending.push(String(child.session.id))
    }
  }
  return visited.size > 0
}

/** Whether the session owns a background job that has not settled. */
export function hasLiveJobs(ctx: Context, agent: Agent): boolean {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return false
  return jobs
    .list(agent.session.id)
    .some((job) => job.owner === agent.session.id && (job.status === 'running' || job.status === 'stopping'))
}
