# Release validation evidence

Status: **acceptance in progress; not yet a published-release receipt**. Target is DSH 0.2.2-alpha.3, Node 24.17.0 (minimum >=24.9.0). All host launches and package-consumer installs use disposable explicit HOME/DSH_HOME/profile paths and temporary ports. Original plugin repositories and the active DSH profile are not installation targets.

## Specification and isolation

- Frozen specifications committed at `7e9eae8690f969c029e568fbb0b15263b93f6470`, before implementation.
- Implementation ran in dedicated host, migration, client, native-profile and integration Git worktrees with independently delegated development/testing.
- Evidence-driven scope clarification was recorded in [AMENDMENTS](<AMENDMENTS.md>) before implementing native per-agent compaction adaptation. It adds native preset coverage rather than narrowing scope.

## Executed checkpoints

| Checkpoint | Executed evidence |
| --- | --- |
| First whole source/native/browser pass | `DSH_TOOLBOX_CHROMIUM=/path/to/chromium npm run check`: 273 tests passed, zero failed/skipped; TypeScript and all five builds passed. This precedes later review fixes and is not the final release result. |
| First five packed consumers | `npm run pack && npm run test:artifacts`: five tarballs installed in clean npm consumers; checksum, selected payloads, actual ESM imports and CLI help passed, 5/5. |
| Native root integration | `npm run typecheck && node --test test/integration/*.test.ts`: 15/15 passed, zero skipped after raw Cordis fiber identity and current module enablement fixes. Includes actual Loader volatile updates, captured retry streams, preserved/released owned goal holds and completed native next round, service isolation, asynchronous disposer joining, SettingsForms describe/update, authenticated cookie/Host/Origin admission and conflict diagnostics. SettingsForms unit integration uses an explicitly named Loader-backed ConfigEditor adapter; full disk persistence belongs to the separate packed-web gate. |
| GitHub Actions prohibition | Direct user instruction supersedes the former CI requirement. Actions are disabled and workflow files removed; final evidence is local isolated acceptance plus direct `gh` release verification, never another Actions run. |

## Review and regression gates

Two independent, fresh-context read-only reviews compared the frozen-document baseline with the implementation: Standards and Spec. They found stale-journal discovery replay, rollback owner-process fencing, incomplete public CLI semantic preflight, absent-module adoption/auto-disabled readiness, consumer HOME isolation and missing packed-browser proof. Fixes and reproducing regression tests are required before release; final recheck receipts will be added below. Native lifecycle experiments also caught the Cordis thenable-fiber identity bug, initial-disabled live enablement and preset-local compaction placement.

## Preserved-source and active-profile integrity

Read-only verification after implementation confirms original source HEADs and working-tree status match their initial observations. Context `22173d1`, retry `c100ff3`, chime `88f17e3` remain clean. Conventional gate `62662dc` retains only its pre-existing README/untracked research/patch-check changes. No source repository was built or installed.

Active web profile SHA-256 values remain unchanged:

```text
package.json       4eec5020679e926d320b072d95baa1fd9f92a48903892a9d0c6eba25915e8b68
pnpm-lock.yaml     4db34901144ecea0041c587b8b9579b9cc54fe16ff0c64993d8b899a2fcf07ad
cordis.patch.yml   2047ef0ae4094db168c61f05ad66cc4744a3c10f5e6a97c28616ad733933c22a
```

The live GUI was not a test target. Nothing was installed into the production profile. Final source-suite, native packed-web, review recheck, tag and remotely downloaded release checksum evidence is pending below.
