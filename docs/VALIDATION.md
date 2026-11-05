# Release validation evidence — 0.1.0

**Local release acceptance: passed on 2026-11-06 (+08:00).** Target: DSH 0.2.2-alpha.3, Node 24.17.0 (minimum >=24.9.0), pnpm 11.8.0, TypeScript 5.9.3. Publication/download receipts belong to the [public Release](https://github.com/LMGateX/dsh-toolbox/releases/tag/v0.1.0); the checksums below identify the exact locally accepted artifacts.

## Specification and isolation

- Frozen specifications committed at `7e9eae8690f969c029e568fbb0b15263b93f6470` before implementation.
- Dedicated host, migration, client, native-profile and integration worktrees; independently delegated development/testing and separate Standards/Spec reviewers.
- [Amendments](AMENDMENTS.md) recorded exact per-agent native preset backend selection before implementation and the later direct user prohibition of GitHub Actions. All workflows were removed and repository Actions disabled. Final acceptance and publication use local isolated execution plus direct authenticated Git/gh, never Actions.
- Installs/host launches use explicit disposable HOME, DSH_HOME, XDG roots, caches and profiles; web binds loopback port 0, explicitly refusing the active GUI port. Child hosts receive no provider credentials.

## Final executed gates

| Gate | Executed result |
| --- | --- |
| `npm run check` | TypeScript passed; **387/387 source tests passed, zero failed/skipped**; all five distributions built. |
| `npm run pack && npm run test:artifacts` | **7/7 passed, zero failed/skipped**: five clean consumer installs plus actual packed native-web/Chromium and all-five-native-CLI composition gates. |
| Original semantic oracle | `DSH_TEST_LEGACY_ROOT=/home/dev/dev node --test test/migration/*.test.ts`: **138/138 passed**, including the untouched original config-only validators; no host or source-repository installation. |
| Native root + retained preset backends | Genuine Cordis Loader, RootInclude and ConfigEditor, two distinct native BasicCompactionEngines, isolated nested preset groups, retained versus new preset revisions, actual offline summarization/retention transactions, no wrong-root fallback, no-engine failure, canonical tool visibility and unload ownership. |
| Live ownership/lifecycle | Captured retry streams see live policy and become inert on disable. Policy-only edits preserve gate identity/holds; official native driver completes exactly the next reserved round. False→true admission is synchronous, durably registered and epoch-fenced; a controlled-observation actual-root/Cordis regression covers asynchronous sibling disposal separately from the native engine tests. |
| Migration/recovery | Input/hash/CAS safety, interruption replay, real native asynchronous old disposal, fresh-host/page chime fence, CLI-only recovery, current owner processes and peer journal PIDs, source identity/provenance, per-module mixed recovery and repeated guards immediately before recovery writes. |
| Real installed packed web | Four active modules; one product card/four sections; native served client equals the installed packed client after only native source-map/concatenation normalization. Save 3.5 seconds as 3500 ms, retry enabled=false and rest mode=true; full page reload preserves them; chime off disposes sidebar runtime but retains settings sections. **Zero console errors/page exceptions.** |
| Split artifacts | Five genuine manifests/imports/CLI/checksum/payload checks in clean consumers. Native CLI independently composes every distribution and all four distinct split peers together. Non-chime payloads omit chime audio. |

The final combined run built and packed source trees `src=3032b63856eb7726d8d95cca73e8771adafe644b`, `client=4c3220eab43db27073e14d0aad85ff0a7e131308`, `scripts=457185d1924a2b0a9ae989e3bf50a6a686802101` (implementation/test commit `faffdb4`). Subsequent evidence-only documentation does not alter these runtime trees or the accepted tarballs. [Native execution details](NATIVE_PROFILE_VALIDATION.md) distinguish the intermediate red runs from final acceptance.

## Independent review closure

Both reviewers pinned integrated `fe95692` (root await-boundary repair `18728ce` plus fresh peer-aware recovery `fe95692`), then verified `faffdb4` only repairs persistent native test fixtures. All identified Standards and Spec blockers were closed. The Spec reviewer independently replayed enable-edge/stale-async publication and sibling-disposal races using actual runtime/bootstrap/Cordis with controlled observations, inspected exact-agent/client changes, and exercised six virtual-storage recovery cases. The Standards reviewer statically inspected normal restoration and every replay-write guard. Neither reviewer claimed the parent's native filesystem/browser executions as their own.

## Exact accepted artifacts

```text
3bb8a4a9e9b3b9bae9d55133221a4893d5930fcdf2cae79443ff36c9bdc3ded2  dsh-toolbox-0.1.0.tgz
f5e28965825f0e4371d44dd7ac0a9fc3e2884c39d1a4f2fffa2727fe400c8244  dsh-toolbox-context-0.1.0.tgz
703b0c29a8761fcd787bca9c65ba7440658a57762fd9ccf7ac5eb7106336e21d  dsh-toolbox-retry-0.1.0.tgz
23b9e7a5d4194f429321aade4e07fb1bc7327dc9b1cea1d204d4b7e6e0fbc1d8  dsh-toolbox-chime-0.1.0.tgz
12bf2ee90a03978f9746e857bf3ab4edf74694dce3fe542b70655c9d9bdabe51  dsh-toolbox-goal-wait-0.1.0.tgz
```

Publication uses an annotated version-matching tag and exactly five tarballs plus SHA256SUMS. The final delivery step downloads all six assets from GitHub and verifies every SHA-256 against this acceptance set; the resulting publication receipt is appended to the Release notes without regenerating artifacts.

## Protected originals and no local installation

Original source HEADs/status still match initial observations: context `22173d1`, retry `c100ff3` and chime `88f17e3` remain clean; conventional gate `62662dc` retains its pre-existing README/untracked research/patch-check changes. No original source repository was built or installed.

The active web dependency manifest and lockfile still match their initial hashes:

```text
package.json   4eec5020679e926d320b072d95baa1fd9f92a48903892a9d0c6eba25915e8b68
pnpm-lock.yaml 4db34901144ecea0041c587b8b9579b9cc54fe16ff0c64993d8b899a2fcf07ad
```

A late read-only audit found configuration-patch drift (mtime 2026-11-06 00:38:58 +08:00): initial `2047ef0ae4094db168c61f05ad66cc4744a3c10f5e6a97c28616ad733933c22a`, current `0a791d146d1066158dba0627fd3253e7aa89474a9e36694dfc8fe39634fef118`. Its origin was not established; it was not overwritten/restored. No Toolbox row or Toolbox migration journal exists there. Thus this report does **not** assert the entire active profile remained byte-identical. No Toolbox installation targeted it, and the live GUI was never an acceptance target.

## Boundaries

Full-profile acceptance makes no external provider request; actual compaction transactions use a deterministic offline LLM adapter inside genuine native engines. Browser permission/autoplay, inaccessible disconnected legacy chime closures and conventional fresh-host/full-page handover requirements remain explicit. Unsupported/dynamic/ambiguous migration inputs and missing recovery provenance fail closed, not silently guessed. No npm publication or production-profile installation is part of this release.
