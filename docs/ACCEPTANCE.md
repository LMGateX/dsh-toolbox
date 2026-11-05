# Release acceptance matrix

Every row is mandatory for 0.1.0 unless explicitly identified as an exceptional fail-closed scenario. Record exact commands/results and limitations in docs/VALIDATION.md before release.

| ID | Criterion |
| --- | --- |
| DOC-1 | Specification committed before implementation; source provenance and notices recorded. |
| MOD-1 | Context tools/policy/retention/PTC regression tests preserved; canonical tools unchanged. |
| MOD-2 | Stream and empty-response classification preserved, cancellation/unload safe, no extra retry loop. |
| MOD-3 | Browser chime completion/blocked/question/error, rest/DND, debounce, no child/ordinary fork misclassification and unload/audio cleanup verified. |
| MOD-4 | Gate jobs/live descendants, owned hold/release, external disarm/goal phase/unload invariants verified. |
| LIFE-1 | Module toggles register/dispose effects; unavailable dependencies isolate affected module; explicit status. |
| MIG-1 | Fresh install, partial legacy install, all four, disabled old modules, overrides/defaults, false/0/empty arrays, custom ids. |
| MIG-2 | Exact target precedence; idempotency after restart; absent capabilities off in migration mode; no secret/transient import. |
| MIG-3 | Backups+journal+profile lock; injected failure before/after each mutating stage; interrupted recovery and concurrent edit protection. |
| MIG-4 | Native persistent legacy bundle/manual-row disable, actual host and browser handover, restart-required accurately reported. |
| MIG-5 | Read-only/malformed/dynamic/multi-instance/unknown version/experimental startup cases fail closed without breaking old owner. |
| MIG-6 | Inspect/dry-run/retry/selective rollback exposed and tested, no unrelated later edits overwritten. |
| DIST-1 | Five real installable tarballs, selected feature-only payloads, one source, same version, correct exports/bundle/client metadata. |
| DIST-2 | Split peers coexist; combined/split duplicate modules never activate twice; safe diagnostic/handover on conflict. |
| UI-1 | Combined single card/sectioned settings, every setting editable with correct units, module status and migration report accessible. |
| HOST-1 | Baseline native host composition and lifecycle run in disposable HOME/profile/process; packed artifacts consumed rather than live sources alone. |
| CLIENT-1 | Actual emitted client loads in isolated browser/harness; settings persistence/toggles and no duplicate chime handover are exercised. |
| SAFE-1 | Original source repos remain unchanged; active profile hashes unchanged; no local production installation or live GUI mutation. |
| PUB-1 | Public GitHub repository, clean committed main, complete local isolated acceptance (no GitHub Actions, per direct user override in AMENDMENTS), matching annotated tag, release assets and SHA256SUMS verified remotely. |
