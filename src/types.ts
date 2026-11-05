/** Canonical capability identifiers, independent of a distribution's install shape. */
export const MODULE_IDS = ['context', 'retry', 'chime', 'goalWait'] as const;
export type ModuleId = typeof MODULE_IDS[number];
export interface FeaturePlugin {
  readonly name: string;
  readonly inject?: readonly string[] | Record<string, unknown>;
  readonly Config?: unknown;
  apply(ctx: any, config?: any): unknown;
}
export interface Distribution {
  readonly name: string;
  readonly moduleIds: readonly ModuleId[];
  readonly modulePlugins: Partial<Record<ModuleId, FeaturePlugin>>;
}
export interface ModuleState {
  phase: 'active' | 'disabled' | 'missing-dependency' | 'migration-pending' | 'conflict' | 'failed';
  reason?: string;
}
