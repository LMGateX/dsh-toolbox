/**
 * Public type surface of the browser half, plus the few runtime helpers tests
 * assert against. The bundle itself (`client/client.js`) is a classic script and
 * cannot import this module; tests load the bundle and `import type` from here.
 *
 * @module dsh-session-chime/client-types
 */

/** One accepted row-configuration snapshot as the settings service projects it. */
export interface ConfigFormSnapshot {
  /** `loading` before the first read, `ready` once a value is available, `unavailable` without a form. */
  readonly status: string
  /** Whether this connection may write the row. */
  readonly writable: boolean
  /** Accepted revision, used to fence a save. */
  readonly revision: number | undefined
  /** Accepted row value (plain JSON, not a live accessor). */
  readonly value: unknown
}

/** One mutation submitted to the settings service. */
export type PathOperation =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** The per-row form service shared by the page and the runtime. */
export interface ConfigForm {
  getSnapshot(): ConfigFormSnapshot
  subscribe(listener: () => void): () => void
  mutate(operations: readonly PathOperation[], revision: number | undefined): Promise<boolean>
}

/** Observable snapshot source, as the client platform publishes it. */
export interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** One session row as the client session catalog publishes it. */
export interface SessionRow {
  readonly id?: string
  /** Human-facing label the catalog projects. */
  readonly displayTitle?: string
  /** Durable title, when the host has projected one. */
  readonly title?: string
  readonly running?: boolean
  /**
   * Direct creator id. Historical ordinary forks may retain their source id;
   * presence alone does not classify the row as a subagent (dsh 0.2.2).
   */
  readonly parentId?: string
  /** Coarse classification; only `'subagent'` marks a subagent child. */
  readonly origin?: string
  readonly projectionValues?: unknown
}

/** The session catalog snapshot this plugin reads. */
export interface SessionListSnapshot {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionRow>>
}

/** One job row as the client job roster publishes it. */
export interface JobRow {
  readonly id?: string
  readonly status?: string
  readonly owner?: string
}

/** The job roster snapshot this plugin reads. */
export interface JobsSnapshot {
  readonly rows: Readonly<Record<string, readonly JobRow[]>>
}

/** The client sessions service this plugin requires. */
export interface SessionsService {
  readonly list: ObservableSnapshot<SessionListSnapshot>
}

/** The client jobs service this plugin uses when the deployment has one. */
export interface JobsService {
  readonly state: ObservableSnapshot<JobsSnapshot>
  watchRows(sessionId: string): () => void
}

/** One pending interaction the session UI is waiting on. */
export interface PendingInteraction {
  /** Opaque request identity; a replacement request carries a new key. */
  readonly key: string
  /** Domain discriminator; only `question`, `plan-review` and `approval` chime. */
  readonly kind: string
  /** Session whose UI can answer this interaction. */
  readonly sessionId: string
}

/** Independent UI facts for one session, as the session UI aggregates them. */
export interface SessionUIStatus {
  /** Latest known running state, absent until a baseline or event establishes it. */
  readonly running?: boolean
  /** Highest-precedence domain request currently awaiting user interaction. */
  readonly pendingInteraction?: PendingInteraction
}

/** The session-status snapshot the optional session UI service publishes. */
export type SessionUIStatusSnapshot = ReadonlyMap<string, SessionUIStatus>

/** The client session UI service this plugin uses when the deployment has one. */
export interface UiSessionService {
  readonly sessionStatus: ObservableSnapshot<SessionUIStatusSnapshot>
}

/**
 * The client Remote service, reduced to the one forwarded event this plugin
 * observes. The payload's user-safe message is deliberately ignored.
 */
export interface RemoteService {
  $on(event: 'api-session/error', listener: (sessionId: string, message: string) => void): () => void
}

/** One slot registration option bag. */
export interface SlotRegistration {
  readonly name: string
  readonly key?: string
  readonly id?: string
  readonly order?: number
  readonly label?: string | (() => string)
  readonly inject?: () => Record<string, unknown>
}

/** The slice of the client Cordis context this bundle touches. */
export interface ClientContext {
  readonly configForms: {
    get(rowId: string): ConfigForm
    /** Run the registration only while the settings page serves this row. */
    whileServed(rows: readonly string[], register: () => unknown): unknown
  }
  readonly slots: {
    inject(name: string, register: () => unknown): unknown
    register(options: SlotRegistration, component: unknown): unknown
  }
  effect(callback: () => unknown, label: string): unknown
  /**
   * Run a nested registration as soon as every named service is available.
   *
   * The callback's context carries the services as properties, and cordis runs it
   * again if a service is replaced. This is the ONLY correct way to read an
   * optional sibling service: the client boot mounts the API controllers one at a
   * time, so a service that exists in the finished page may not exist yet when
   * this bundle activates.
   */
  inject(services: readonly string[], register: (scope: ClientContext) => unknown): unknown
  readonly sessions: SessionsService
  /** Background-job rosters; absent when the deployment mounts no job controller. */
  readonly jobs?: JobsService
  /** Session UI status (pending questions/approvals); absent without the session UI bundle. */
  readonly uiSession?: UiSessionService
  /** Forwarded Remote events (failed turns); absent without the Remote assembly. */
  readonly remote?: RemoteService
  get?(name: string): unknown
}

/** The platform React runtime the shell hands every bundle. */
export interface ReactRuntime {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: () => T): [T, (value: T) => void]
  useEffect(callback: () => void | (() => void), deps?: readonly unknown[]): void
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, read: () => T, readServer: () => T): T
}

/** Why a chime played. */
export type ChimeReason = 'done' | 'blocked' | 'question' | 'error'

/** What a quiet period does with a chime. */
export type QuietStyle = 'short' | 'silent'

/** Resolved chime settings, as the browser half applies them. */
export interface ChimeSettings {
  readonly enabled: boolean
  readonly soundDone: string
  readonly soundBlocked: string
  readonly soundQuestion: string
  readonly soundError: string
  /** Whether a question, plan review or approval may ring its own chime. */
  readonly chimeQuestion: boolean
  /** Whether a failed top-level turn may ring the error chime. */
  readonly chimeError: boolean
  readonly volume: number
  readonly durationMs: number
  readonly debounceMs: number
  readonly quietStyle: QuietStyle
  readonly quietShortMs: number
  readonly dndStart: string
  readonly dndEnd: string
  readonly restMode: boolean
  /** Shortest ring before pointer or key activity may stop it. */
  readonly minRingMs: number
  /** Whether a ring shows the stop banner. */
  readonly banner: boolean
  /** Where the stop banner sits; `modal` adds a mask only the button clears. */
  readonly bannerPlacement: BannerPlacement
}

/** Every banner placement the settings page offers, in display order. */
export type BannerPlacement =
  | 'bottom-center'
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left'
  | 'center'
  | 'modal'

/** Every banner placement, mirroring src/config.ts. */
export const BANNER_PLACEMENTS: readonly BannerPlacement[] = [
  'bottom-center', 'bottom-right', 'bottom-left', 'top-right', 'top-left', 'center', 'modal',
]

/** What the banner shows about the ring it belongs to. */
export interface RingInfo {
  /** Monotonic per-page id, so a replaced ring cannot clear its successor's banner. */
  readonly seq: number
  /** Why the chime played. */
  readonly reason: ChimeReason
  /** Session that settled. */
  readonly sessionId: string
  /** Human-facing session label. */
  readonly title: string
  /** Page wall-clock ms when the ring started. */
  readonly startedAt: number
  /** The sound being played. */
  readonly soundId: string
  /** Playback window in milliseconds. */
  readonly windowMs: number
}

/** Shipped chime ids, mirrored by src/config.ts and asserted by npm run check:bundle. */
export const SOUND_IDS: readonly string[] = ['chime-soft', 'bell-bright', 'marimba', 'alert-low', 'alert-sharp', 'blip']

/** Upper bound for every duration field, mirroring src/config.ts. */
export const MAX_DURATION_MS = 6 * 60 * 60 * 1000

/** Default settings, mirroring the host schema defaults. */
export const DEFAULT_SETTINGS: ChimeSettings = {
  enabled: true,
  soundDone: 'chime-soft',
  soundBlocked: 'alert-low',
  soundQuestion: 'bell-bright',
  soundError: 'alert-sharp',
  chimeQuestion: true,
  chimeError: true,
  volume: 0.8,
  durationMs: 0,
  debounceMs: 1500,
  quietStyle: 'short',
  quietShortMs: 600,
  dndStart: '',
  dndEnd: '',
  restMode: false,
  minRingMs: 3000,
  banner: true,
  bannerPlacement: 'bottom-center',
}
