# Specification amendments

Changes must cite the observed host/source constraint, explain the trade-off, and state the changed acceptance evidence. Scope cannot be silently reduced.

No amendments at specification freeze.

## 2026-11-06 — Context backend follows the selected native agent scope

**Evidence.** Executing the packed combined plugin in a disposable, stock DSH 0.2.2-alpha.3 web profile exposed a native composition difference: the web bundle explicitly disables the host-plane compaction backend, and its shipped standard/cordis/PTC presets mount isolated compaction backends within each agent scope. The original standalone context plugin required a root-plane compaction service, so a direct root port remained permanently unavailable in that otherwise supported composition. Native Agent exposes its scoped context publicly; this is not a reason to mount a second engine or rewrite presets.

**Contract clarification.** Keep one Toolbox configuration/card and canonical tools. The context adapter registers once in the owning host, resolves the exact target agent’s native backend and policy for each invocation/render, and retains the original root backend path for non-preset compositions. Backend absence is reported for that target; it never selects another agent’s backend or invents a global fallback engine. All native retention, pressure, transaction and PTC authority remain native. Other modules and legacy ownership rules are unchanged.

**Acceptance addition (not a reduction).** Exercise actual native Agent scope composition with two isolated backend/policy instances, canonical tool visibility, per-agent dispatch, status/pressure, live settings and unload. Re-run the full native stock-web packed-client/configuration acceptance against the corrected adapter. No automatic preset/profile edits are introduced.


## 2026-11-06 — Direct user prohibition of GitHub Actions

The user explicitly instructed “禁止使用 github action”. This supersedes the original release-gate reference to CI. Repository Actions are disabled, existing in-progress runs are cancelled if any, and all GitHub workflow definitions are removed. No further GitHub Actions execution, dispatch, or release workflow is permitted.

The replacement release evidence is the complete locally executed isolated source/type/native/browser/packed-artifact suite, independent review rechecks, unchanged production-profile/source integrity, an annotated matching tag and direct authenticated `gh` publication/download/checksum verification. Public Git storage and GitHub Releases remain authorized; no npm publication or production-profile installation is added.
