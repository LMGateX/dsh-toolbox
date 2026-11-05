# DSH Toolbox

One install, independent enhancements. **一体安装，功能独立开关。**

Context compaction, native retry classification, browser session chimes and goal waiting behind one plugin card. Four genuinely independent single-feature packages are built from the same source, not maintained as forks.

**Target:** DSH `0.2.2-alpha.3`, Node `>=24.9.0`. No unverified broad compatibility claim. Not published to npm: install a GitHub Release tarball.

## Distributions

| Package | Capabilities |
| --- | --- |
| dsh-toolbox | All four, independently selectable |
| dsh-toolbox-context | Native-policy compaction, optional status/guidance/pressure, PTC timeout options |
| dsh-toolbox-retry | Stream-error and empty-response classification; official DSH retry owns execution |
| dsh-toolbox-chime | Completion/blocked/question/error sounds, quiet hours, rest mode, sidebar and banners |
| dsh-toolbox-goal-wait | Wait for live jobs and subagent descendants; official goal driver stays mounted |

Choose the combined package **or** any subset of distinct splits. Two distributions claiming the same capability produce a fail-closed ownership conflict, not duplicate hooks/audio. Splits do not require the combined package and omit unrelated feature implementation and audio.

## Install

Choose the intended profile explicitly. Example for an existing web profile:

```sh
dsh plugin --profile web add https://github.com/LMGateX/dsh-toolbox/releases/download/v0.1.0/dsh-toolbox-0.1.0.tgz
```

For one capability replace the asset name, e.g. `dsh-toolbox-retry-0.1.0.tgz`. Verify downloads against release SHA256SUMS. The matching DSH runtime must already exist; packages do not install a second host runtime.

Open **Plugins → DSH Toolbox → Configure**. Combined settings have context, retry, chime and goalWait sections. Each module and every original option is independently editable. Status distinguishes active, disabled, missing dependency, migration-pending, conflict and failed. Module changes dispose old effects before mounting updates.

Fresh installs use preserved source defaults. When any legacy plugin is discovered, absent capabilities remain disabled. Explicit Toolbox values win over imports. Missing optional services affect only the corresponding module.

## Automatic legacy migration / 自动迁移

First active load inspects **only the owning profile**, validates effective configuration, records protected backups/journal and persistently disables old bundle/row owners after preparation. Old packages and configuration are retained. No postinstall effects, profile sweep, forced restart or uninstall.

Known predecessors: dsh-tool-compact-context, dsh-stream-retry, dsh-session-chime and conventional dsh-goal-wait-gate. Unknown versions, dynamic expressions, ambiguous instances, overlays, read-only profiles and experimental startup/replacement owners fail closed: old ownership remains, the affected new module is gated, and the report explains the problem.

**Saved is not active.** If native reconciliation cannot safely finish, restart DSH yourself after finishing ongoing work. Migrating legacy chime requires a fresh host process and **full page reload** because old timers and in-flight decode cannot be reliably cancelled. Toolbox checks fresh host-index evidence, not browser wall-clock time; it stays silent when proof/status is unavailable.

Read the migration report in Toolbox settings. Profile `.dsh-toolbox/` holds permission-restricted journal/backups; these can contain original feature text, so do not publish them. Repeated starts do not reimport over later Toolbox edits.

### Inspection and selective recovery

Every distribution exports `./migration` and the `dsh-toolbox-migrate` CLI. Explicit profile/home/install anchor are mandatory; nothing scans all profiles:

```sh
dsh-toolbox-migrate inspect --profile-dir /absolute/profile --dsh-home /absolute/dsh-home --install-anchor /absolute/host-package
dsh-toolbox-migrate dry-run --profile-dir /absolute/profile --dsh-home /absolute/dsh-home --install-anchor /absolute/host-package
dsh-toolbox-migrate retry --profile-dir /absolute/profile --dsh-home /absolute/dsh-home --install-anchor /absolute/host-package
dsh-toolbox-migrate rollback --operation OPERATION_UUID --modules retry,chime --profile-dir /absolute/profile --dsh-home /absolute/dsh-home --install-anchor /absolute/host-package
```

For splits add `--distribution dsh-toolbox-retry` (or the selected split). Rollback restores only migration-owned values that still match its writes and refuses conflicting later edits. Handover back is staged: first gate Toolbox, shut down/restart the original host when instructed, then repeat explicit rollback to restore old selection. Simply disabling Toolbox never silently re-enables legacy plugins. Offline CLI-only journals without observed host identity cannot prove shutdown and fail closed on automatic legacy restoration.

## Configuration shape

```yaml
modules:
  context:
    enabled: true
    compactTool: true
    statusTool: false
  retry:
    enabled: true
    errorCodes: [upstream_stream_read_error, stream_timeout, stream error]
    providers: []
    retryEmptyResponse: true
  chime:
    enabled: true
    restMode: false
  goalWait:
    enabled: true
    waitForJobs: true
    waitForSubagents: true
    maxHoldMs: 0
migration:
  auto: true
```

Splits use this same envelope but expose only their module. `maxHoldMs: 0` means no forced expiry. Context status/guidance/pressure extras remain opt-in. Native retention, provider routing and retry budgets stay native. Goal waiting changes process-local activation only, never durable phase.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run pack
npm run test:artifacts
```

Tests resolve the local baseline DSH dev dependency. `DSH_RUNTIME_ROOT` can explicitly select an installed baseline. Native HOME/profile/processes are disposable; no developer live profile is used. Repository docs/SPEC.md and docs/ACCEPTANCE.md define the frozen release gate; docs/VALIDATION.md records executed evidence and limitations.

## Safety boundaries

- No automatic restart, hidden legacy reactivation or experimental startup-driver migration.
- Do not delete running journals or copy them into another profile.
- Audio obeys normal browser gesture/autoplay rules; unlock it in settings. Chime is browser-only.
- Native management concurrency is not advertised as universally atomic: conflicts fail boundedly and require inspection/retry.
- This development/release task does **not** install Toolbox into the author's active local profile.

MIT. Selected source notices are included in each distribution; chime includes unchanged CC0 sounds and third-party attribution.
