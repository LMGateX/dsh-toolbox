/** Public migration seam. Native lifecycle is observed, never entered recursively. */
export const MODULE_IDS = ['context', 'retry', 'chime', 'goalWait'] as const;
export type ModuleId = typeof MODULE_IDS[number];
export type Values = Record<string, unknown>;
export interface Distribution { rowId: string; packageName?: string; moduleIds: readonly ModuleId[]; validateModule?: (id: ModuleId, value: Values) => void }
export interface ProfileFacts { dir: string; patchPath: string; installAnchor: string; home: string; overlays?: readonly unknown[]; name?: string }
export interface LoaderEntry { id: string; options: { id: string; name: string; config?: unknown; disabled?: unknown; group?: unknown }; disabled?: boolean; fiber?: { state?: number; inertia?: Promise<unknown>; effectiveConfig?: unknown }; parent?: unknown }
export interface NativeMigrationHost {
  profileContext: ProfileFacts;
  nativeMigration?: { resolveBundleDir(binName: string, packageName: string, installAnchor: string, profileDir: string): string; loadOverlayPatches(binName: string, file: string): unknown[]; composeEntries(layers: unknown[][], warn?: (message: string) => void): Values[] };
  loader: { entries(): Iterable<LoaderEntry> };
  get?(name: string): unknown;
  on?(event: string, listener: () => void): () => void;
  /** Native post-reconciliation acknowledgment, never inferred from missing entries. */
  handoverAcknowledged?(id: ModuleId, source: Source): boolean;
  /** Optional direct view of the running root module configuration (volatile refs unwrapped). */
  moduleConfig?(id: ModuleId): Values | undefined;
  appReady?: { onReady(listener: () => void): () => void };
  logger?: { warn(...args: unknown[]): void; debug?(...args: unknown[]): void };
  /** Fail closed if a nonstandard startup owner cannot be excluded. */
  startupOwner?: string | null;
}
export interface Source { moduleId: ModuleId; packageName: string; moduleName?: string; bundleName?: string; version?: string; rowId?: string; raw: Values; effective: Values; disabled: boolean; active: boolean; bundleSelected: boolean; problem?: string }
export interface Discovery {
  profileId: string; profile: ProfileFacts; revision: string; manifest: Values; patchText: string; manifestText: string;
  moduleProblems?: Partial<Record<ModuleId, string[]>>;
  /** Detached immutable input evidence, including absent optional files. */
  inputFiles?: { path: string; hash: string | null }[];
  environmentIdentity?: string;
  rows: Values[]; sources: Source[]; target: Distribution; explicit: Partial<Record<ModuleId, Values>>;
  peers: Partial<Record<ModuleId, string[]>>; problems: string[]; legacyMode: boolean;
}
export type Phase = 'pending' | 'fresh' | 'prepared' | 'saved' | 'applied' | 'restart-required' | 'conflict' | 'failed' | 'rolled-back';
export interface Decision { moduleId: ModuleId; phase: Phase; enabled: boolean; config?: Values; source?: Source; reason?: string }
export interface MigrationPlan { profileId: string; revision: string; target: Distribution; legacyMode: boolean; decisions: Decision[]; problems: string[] }
export interface ModuleResult { phase: Phase; ready: boolean; enabled: boolean; reason?: string }
export interface MigrationReport { browserReloadAfter?: number; schemaVersion: 1; operationId: string; profileId: string; targetRowId: string; modules: Partial<Record<ModuleId, ModuleResult>>; problems: string[] }
export interface MigrationState { modules: Partial<Record<ModuleId, ModuleResult>>; report?: MigrationReport }
export interface MigrationController {
  state(): MigrationState;
  subscribe(listener: (state: MigrationState) => void): () => void;
  settled: Promise<MigrationReport>;
  inspect(): Promise<MigrationPlan>;
  retry(): Promise<MigrationReport>;
  rollback(options: { operationId: string; modules: readonly ModuleId[] }): Promise<MigrationReport>;
  dispose(): void;
}
export interface BootstrapOptions extends Distribution { auto?: boolean; onReport?: (report: MigrationReport) => void }
