// Adapted from dsh-tool-compact-context; original MIT license retained in NOTICE.txt.
/** Model-facing tool name. */
export const COMPACT_TOOL = 'compact_context';

/** Model-facing read-only status tool name. */
export const STATUS_TOOL = 'context_status';

/**
 * Static policy paragraph. Its bytes never change for a given deployment, so
 * it does not churn the prompt prefix; the optional runtime pressure line is a
 * separate, off-by-default contribution.
 */
export const GUIDANCE = [
  '## Context management',
  'Your context window is finite. A `compact_context` tool asks the deployment\'s native compaction policy to condense older history when that policy is ready.',
  'Before starting work that needs more context than you expect to have left — large file reads, long tool chains, broad searches — call it, then continue the task.',
  'Do not stop, hand back, or drop required steps merely because you believe the context is nearly full: compact instead.',
  'The native policy chooses the range, threshold, and retained tail; the tool takes no range parameters.',
].join('\n');

/** Model-facing description for the compaction tool. */
export function compactDescription(): string {
  return [
    'Ask the deployment\'s native compaction machinery to run now. Above its pressure threshold it uses the native pressure policy; below it, it uses the native retained-tail selection so you can compact early. The backend config remains authoritative for retention, model routing, the tool-result pruner and retries; this tool takes no range or retention parameters.',
    'Call it when you believe a large step would exceed the remaining context, then continue the task.',
    'Do not call it for short conversations, and never use it as a substitute for doing the task.',
    'Summarization is one extra model request and can take a while; transient failures are retried with backoff, while deterministic failures such as an oversized summary are returned immediately. In PTC mode, pass a generous timeoutMs to run_code (for example 300000-600000, within the deployment limit) because the default 120s can be shorter than a slow decode and its retries.',
  ].join(' ');
}

/** Model-facing description for the read-only status tool. */
export function statusDescription(): string {
  return [
    'Read the current context occupancy and, when the mounted compaction backend exposes it, the automatic compaction threshold and retained-tail budget.',
    'This is a normal tool call: the result enters conversation history, so request it only when a decision actually depends on the remaining budget.',
    'It never compacts anything; use compact_context for that.',
  ].join(' ');
}
