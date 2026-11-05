# DSH Toolbox first-release specification

Status: implementation contract fixed before development. Date: 2026-11-05. Target: 0.1.0. Repository: LMGateX/dsh-toolbox, public. Audited host baseline: DSH 0.2.2-alpha.3; Node >=24.9. Later versions require validation before broad compatibility claims.

## Required deliverables

1. One combined installable distribution, dsh-toolbox, one plugin card and unified settings grouped into four independently enabled modules.
2. Four real single-module distributions from the identical feature source: dsh-toolbox-context, dsh-toolbox-retry, dsh-toolbox-chime, dsh-toolbox-goal-wait. Each installs without requiring the combined package. Every release has five .tgz assets, checksums, source and provenance. No npm publication is required.
3. Preserve context compaction/tools/policy/PTC options; stream and empty-response classification using official retry; browser-only chimes including completion, blocked, questions, failures, DND/rest mode, sidebar and banners; conventional activation-based goal wait for jobs and descendants. Keep canonical model tool names unchanged.
4. Automatic first-load migration of any subset of the four legacy plugins in the current profile, including preserved disabled state and explicit values. Disable old owners after safe import; retain old packages/configuration. Provide persistent report, dry-run/inspect and selective recovery. Combined/split conflicts must not run duplicate functionality.
5. Lifecycle correctness: a disabled module has no active feature hooks/tools/audio. Missing optional module dependencies are reported locally rather than taking down unrelated modules. Changes accurately distinguish active from saved/restart-required.
6. Native-host integration and packaged client tests in disposable environments, automated unit/regression/fault tests, independent review, CI, installation and migration docs, license notices.
7. Public GitHub repository, pushed history, annotated release tag, published release with five verified artifacts. Do not install into the developer's live DSH profile.

## Behavior

Fresh combined installations enable the four known modules with their preserved source defaults. Fresh split installations enable only their selected module. In legacy migration mode, absent legacy capabilities begin disabled; explicitly disabled legacy capabilities remain disabled. Existing explicit Toolbox settings win field by field. Later genuinely new modules begin disabled.

No feature policy rewrite: the host owns compaction retention/model routing and request-retry execution; chime remains browser-only; waiting toggles only owned process-local activation and never changes durable goal phase. Experimental pinned startup-driver replacement is not automatically migrated or selected; preserve its detection and report unsupported ownership instead of replacing it silently.

No dual ownership: one running owner per capability/profile. Installing combined with new splits or legacy packages is supported only through safe handover or conflict reporting. New split distributions do not compete with one another when their module ids differ. Never automatically resume a completed, blocked, paused or externally disarmed goal.

## Scope of automation

Migrate current profile only. Do not touch other profiles, arbitrary files, or package-manager stores; no postinstall side effects. First-load orchestration may defer work until the host is settled. Automatically prepare migration and apply safely where native lifecycle permits; report a required restart/page reload rather than restart a working host or claim early success. Ambiguous instances/dynamic config, higher-priority overlays, read-only profiles, unsupported legacy versions and active experimental startup ownership fail closed per module with precise diagnostics.

## Completion

All mandatory acceptance rows in ACCEPTANCE.md have executable evidence or an explicitly stated environmental limitation that does not erase the criterion. A failing safety gate blocks publication, not merely documentation. Amendments need rationale and test implications in docs/AMENDMENTS.md.
