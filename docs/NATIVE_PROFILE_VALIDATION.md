# Native packed-profile acceptance

The executable gate is [the native profile test](../test/artifacts/native-profile.test.ts). It uses the public dev dependency `@deepseek-ai/dsh` at 0.2.2-alpha.3, resolves its declared CLI entry, and installs release tarballs through the real `dsh plugin --profile … add` command. It never imports Toolbox runtime sources or rebuilds a client wrapper.

## Scope and isolation

- Each run creates a disposable `.sandbox-native-*` directory and sets explicit `HOME`, `DSH_HOME`, XDG config/data/cache roots and npm cache. The child receives no inherited provider credentials.
- A custom profile is copied from the shipped native web template using `--from-default-profile web`. Package installation automatically selects the native bundle.
- The actual native web application starts with `--host 127.0.0.1 --port 0 --no-open`. Port 3080 is rejected. Chromium follows the process-authenticated URL without printing its token.
- Teardown closes Chromium, terminates the owned native process group with a bounded escalation, and only then removes the sandbox. No real profile or original repository is an installation target.
- An optional `DSH_TOOLBOX_NATIVE_SEED` may name a retained test sandbox in the same checkout. Only its disposable package cache/store is copied into the fresh sandbox; pnpm then installs the current tarball with `--offline`. This handles registry outages without using a developer cache or bypassing the native installer.

## Executed assertions

1. All five tarballs install into independently initialized native profiles and each inserts exactly one correctly identified row. Their installed manifests expose singular `dsh.client.platform: web` and the native bundle patch. Four different split peers also compose together without the combined row.
2. The combined packed client appears in the actual `__DSH_BOOT__.entries` graph. Its native-served script hashes identically to the installed `lib/client.js` after removing only the native source-map trailer and standalone concatenation separator. Native transport rewrites these two items; executable plugin code is not rebuilt by the test.
3. Native Plugins shows a single installed Toolbox card; opening the real component Configure view renders four settings sections.
4. Native form edits save a 3.5-second retry base delay as 3500 milliseconds, save retry enabled=false, and save rest mode=true through the sidebar. A full page reload preserves all three values; the native profile patch independently contains them.
5. Saving the original chime master checkbox off removes its sidebar runtime control while all four settings sections remain available.
6. The owner-authenticated status endpoint returns the selected module statuses. Both uncaught page exceptions and console errors fail the browser gate.

No conversation, model-provider request, or synthetic host service is used. The full-profile test proves native installation, composition, client loading, native configuration persistence and runtime UI disposal; it does not by itself prove a model compaction request or an actual legacy-to-new migration.

## Execution record and discovered blockers

Initial native runs successfully installed the combined package and booted the full web application, then passed configuration persistence and all-five-manifest/split-peer composition checks. Subsequent runs strengthened the gate from page exceptions alone to console errors too, revealing a real package-page fallback crash: native configForms methods require their receiver, but the fallback passed getSnapshot/subscribe detached to React. Native slot error boundaries caught the exception, so pageerror alone was insufficient. A focused receiver-sensitive form regression first reproduced this failure. Stable WeakMap-cached wrappers now preserve both native method receivers; the same unit test passes and the rebuilt packed native browser gate passes with zero console errors or page exceptions.

Native stock web also initially reported context as missing-dependency for compaction while the other three modules were active. Primary host sources explain why: the web layer disables global compaction and native agent presets mount isolated compaction backends. This is an integration contract defect requiring an agent-scoped adapter, not a missing API key. The receiver-corrected native gate passed with this condition reported truthfully; it does not treat context as active. This intermediate limitation was subsequently corrected and the final integration tarballs rerun successfully; see the final receipt below.

The registry intermittently returned ECONNRESET for yaml and schemastery after earlier fresh native installs succeeded. Later exploratory runs copied only an earlier disposable cache/store and still installed new profiles through the real CLI offline. This environmental retry is separate from the two product defects above.

## Receiver-corrected native run

On 2026-11-06, the receiver-corrected worktree built all five distributions, packed them with an explicitly isolated npm HOME/cache, and passed both native tests (26.5 seconds). The complete source browser suite passed 87/87 and strict standalone client/native-test TypeScript checking passed. The combined native application bound the isolated OS-selected port 44161; no active GUI was used. This is an intermediate native client/configuration acceptance result, not a context-agent bridge result.

The tested intermediate tarball checksums were:

```text
e086782d729a33a07ee6646ba30907650d37c36c152d886d3f7726c15963a289  dsh-toolbox-0.1.0.tgz
e377730b77f78f096de28e8c5e9afaa85c18f2403600c8601505a9c00980629d  dsh-toolbox-context-0.1.0.tgz
6aac4d997fc24647b5638ed924488565ed2ba2750d1e632aaf02ea47c14fe63f  dsh-toolbox-retry-0.1.0.tgz
d6bd188c5824153cc18e7bd0a254191c29771678b178369e705e8d56149aa971  dsh-toolbox-chime-0.1.0.tgz
d358d3072a076433d093fa4ee7fd40e4a3ca46cb079af1a06ad1806c02efc399  dsh-toolbox-goal-wait-0.1.0.tgz
```

## Reproduce

After dependencies, pnpm and Chromium are available:

```sh
npm run check
npm run pack
node --test test/artifacts/native-profile.test.ts
```

Optional environment overrides are `DSH_TOOLBOX_ARTIFACT_DIR` (built tarball directory), `DSH_TOOLBOX_CHROMIUM` (an installed compatible Chromium executable), `DSH_TOOLBOX_NATIVE_SEED` (retained disposable cache seed) and `DSH_TOOLBOX_KEEP_NATIVE=1` (retain an explicitly disposable diagnostic sandbox). None is embedded in emitted runtime code.

## Final integrated acceptance — 2026-11-06

After the exact retained-preset adapter and migration safety repairs, the parent executed the complete local `npm run check && npm run pack && npm run test:artifacts` sequence: **387/387 source tests and 7/7 packed tests passed, zero failures/skips**, plus strict TypeScript and five builds. The fresh stock web profile bound isolated loopback port 44137 and reported **context, retry, chime and goalWait all active**. The test explicitly asserts context activation without any global compaction engine. All native edits/full reload, chime disposal, installed-client SHA and zero console/page-error assertions passed. The other packed gates cover five clean consumers, all five native CLI compositions and four distinct split peers together. No seed bypass or synthetic client wrapper was used.

The accepted final checksums are recorded in [release validation](VALIDATION.md); earlier checksums above are historical intermediate runs, not the release assets. Per-agent real native compaction transactions and retained preset revisions are separately verified by [scoped context integration](../test/integration/scoped-context.test.ts). All final verification was local; GitHub Actions is prohibited, disabled and absent from the repository.
