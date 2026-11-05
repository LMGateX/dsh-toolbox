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

Initial native runs successfully installed the combined package and booted the full web application, then passed configuration persistence and all-five-manifest/split-peer composition checks. Subsequent runs strengthened the gate from page exceptions alone to console errors too, revealing a real package-page fallback crash: native configForms methods require their receiver, but the fallback passed getSnapshot/subscribe detached to React. Native slot error boundaries caught the exception, so pageerror alone was insufficient. The strengthened test is deliberately red until rebuilt artifacts contain the binding correction.

Native stock web also initially reported context as missing-dependency for compaction while the other three modules were active. Primary host sources explain why: the web layer disables global compaction and native agent presets mount isolated compaction backends. This is an integration contract defect requiring an agent-scoped adapter, not a missing API key. Publication remains blocked until the integration correction and final packed rerun are recorded here.

The registry intermittently returned ECONNRESET for yaml and schemastery after earlier fresh native installs succeeded. Later exploratory runs copied only an earlier disposable cache/store and still installed new profiles through the real CLI offline. This environmental retry is separate from the two product defects above.

## Reproduce

After dependencies, pnpm and Chromium are available:

```sh
npm run pack
node --test test/artifacts/native-profile.test.ts
```

Optional environment overrides are `DSH_TOOLBOX_ARTIFACT_DIR` (built tarball directory), `DSH_TOOLBOX_CHROMIUM` (an installed compatible Chromium executable), `DSH_TOOLBOX_NATIVE_SEED` (retained disposable cache seed) and `DSH_TOOLBOX_KEEP_NATIVE=1` (retain an explicitly disposable diagnostic sandbox). None is embedded in emitted runtime code.
