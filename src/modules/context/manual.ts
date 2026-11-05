// Adapted from dsh-tool-compact-context; original MIT license retained in NOTICE.txt.
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';

/** The priced surface shape needed by the native-retention selector. */
export interface NativeSurfaceMeasurement {
  readonly nodes: readonly {
    readonly seq: SessionSeq;
    readonly tokens: number;
    readonly heuristicTokens: number;
  }[];
}

/** One inclusive surface range. */
export interface NativeRange {
  readonly start: SessionSeq;
  readonly end: SessionSeq;
}

/** Tool-call balance delta of one surface event. */
function eventDelta(event: unknown): number {
  if (event === null || typeof event !== 'object') return 0;
  const typed = event as { type?: string; data?: { message?: { content?: unknown } } };
  if (typed.type === 'assistant/message') {
    const content = typed.data?.message?.content;
    if (!Array.isArray(content)) return 0;
    let calls = 0;
    for (const block of content) {
      if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'tool-call') calls += 1;
    }
    return calls;
  }
  if (typed.type === 'tool/result') return -1;
  return 0;
}

/**
 * Find the greatest tool-pairing-balanced cut at or before index `cut`.
 * One forward pass records the last zero-open position, so choosing a cut near
 * many parallel tool results does not rescan the prefix for every candidate.
 */
function balancedCutAtOrBefore(session: Session, cut: number): number {
  const surface = session.surface.nodes;
  let open = 0;
  let lastBalanced = 0;
  for (let index = 0; index < cut; index += 1) {
    const event = session.eventAt(surface[index]);
    if (event === undefined) throw new Error('tool-pairing balance: surface event is missing');
    open += eventDelta(event);
    if (open < 0) throw new Error('tool-pairing balance: tool result has no preceding open call');
    if (open === 0) lastBalanced = index + 1;
  }
  return lastBalanced;
}

/**
 * Select a range exactly like compaction-basic's private
 * `selectCompactableRange(session, measurement, retainTokens)`:
 * accumulate from the tail until the native retain budget is met, move the cut
 * back to a tool-pairing-balanced position, and start after the system node.
 *
 * This is a compatibility shim for the missing public "manual compaction"
 * trigger. The retention value comes from the backend config; the plugin adds
 * no keep-turns/min-free knobs of its own.
 */
export function selectNativeRetentionRange(
  session: Session,
  measurement: NativeSurfaceMeasurement,
  retainTokens: number,
): NativeRange | null {
  const priced = measurement.nodes;
  if (priced.length === 0) return null;
  const surface = session.surface.nodes;
  if (surface.length !== priced.length || surface.some((seq, index) => seq !== priced[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface');
  }
  const first = session.eventAt(surface[0])?.type === 'system/message' ? 1 : 0;
  let accumulated = 0;
  let keepFrom = priced.length;
  for (let index = priced.length - 1; index >= 0; index -= 1) {
    accumulated += priced[index]?.tokens ?? 0;
    keepFrom = index;
    if (accumulated >= retainTokens) break;
  }
  if (keepFrom <= first) return null;
  keepFrom = balancedCutAtOrBefore(session, keepFrom);
  if (keepFrom <= first) return null;
  return { start: surface[first], end: surface[keepFrom - 1] };
}
