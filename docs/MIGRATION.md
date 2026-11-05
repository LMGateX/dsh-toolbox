# Automatic migration and recovery contract

## Discovery

Current profile only. Known predecessors: dsh-tool-compact-context (usual row dsh-tool-compact-context), dsh-stream-retry (stream-retry), dsh-session-chime (dsh-session-chime), dsh-goal-wait-gate (goal-wait-gate). Match verified module/package identity, not row id alone; support explicit ids and old manual insertions when unambiguous. Include disabled rows and bundle configuration, not just live forms. Use source effective defaults for known versions and safe raw inherited/override data. Expressions and unknown historical defaults are not guessed.

New Toolbox split distributions are peers, not legacy sources. Detect selected/active duplicate module owners before activation and settle one owner or keep the new owner inactive with a clear conflict. Distinct split capabilities coexist.

## Precedence and state

Explicit target Toolbox fields > migrated old effective values > known legacy defaults. Preserve enabled/disabled state, false, zero, empty strings/arrays, durations in original units and replacement array semantics. With any legacy migration context, absent capabilities remain off. Never copy transient holds, timers, playback queues, credentials or a live gate's continuation authority. Do not execute dynamic expressions to import them.

## Protocol

1. Acquire a profile-scoped exclusive migration lock. Re-read inputs and compare revision/hash to the plan.
2. Validate every candidate against the target module schema before any ownership change. Per-module ambiguity keeps old owner and new inactive.
3. Persist permission-restricted backup plus a journal containing schema version, operation id, profile identity, input hashes, import decisions and phases. Do not log raw user text/secrets.
4. Persist target settings while corresponding new modules remain inactive. Revalidate concurrent changes; never overwrite a newer edit.
5. Persistently disable matching old bundle selection and manual plugin rows using native management semantics; preserve package files and original configuration. Observe the host application result and ensure old feature hooks/client ownership are no longer active. Busy/unsupported transitions may require restart.
6. Activate the new owner only after handover safety checks. Record applied, saved/restart-required, conflict or failed status separately for each module.
7. Re-read persisted state and publish a user-visible report. Completion marker is per profile/module/source, not merely a package version.

The host may recompose during configuration writes; the process must be restartable without losing the plan. No claim of multi-file atomicity. Disable failure leaves new module off; import failure leaves old owner intact. Chime client must not produce duplicate sounds during a saved-but-not-applied transition.

## Idempotency and recovery

Repeated starts do not reimport or override later Toolbox changes. Resume an interrupted journal only after validating profile identity and current hashes. Provide inspect/dry-run, retry and selective rollback/recovery. Rollback reverses only owned changes whose current values still match the migration's recorded writes; preserve unrelated later edits and refuse conflicting restoration. Turning Toolbox off does not silently reactivate legacy plugins. Explicit recovery is the path back.

Every false→true runtime enablement first withdraws cached readiness synchronously, then persists the current per-module host process registration before re-admission. A stale asynchronous scan and a pre-await sibling-disposal snapshot cannot authorize activation. Policy-only enabled→enabled edits retain existing feature fibers and held authority.

Recovery first disables the new module, then waits for every recorded owning process to stop. A CLI-created journal with no later runtime owner can recover after its CLI exits. Before each legacy restoration and each interrupted-recovery write, fresh discovery rechecks overlapping selected/live/durably recorded peer owners, source identity and hashes, overlays, expressions and ambiguity. Conflicted capabilities remain disabled while independently valid requested capabilities may restore. Only owned deltas are replayed; unrelated later peer edits are preserved. Journals missing required provenance fail closed rather than guessing.

## Boundaries

Never scan every profile, uninstall dependencies, edit package stores, force a restart, rearm externally disarmed goals, silently replace experimental startup owners, or report a mere file save as an active handover. Permission errors, dynamic overlays, multiple conflicting instances and malformed files produce actionable reports. Release only after interruption/concurrency/unload/native-integration acceptance tests pass.
