# DSH Toolbox contributor contract

Read [the release specification](docs/SPEC.md) before implementation. Read [architecture and shared contracts](docs/ARCHITECTURE.md) before changing host/client integration or packaging. Read [migration rules](docs/MIGRATION.md) before changing import, ownership, enablement, backups, or recovery. Use [acceptance criteria](docs/ACCEPTANCE.md) as the delivery gate.

- Work in a dedicated Git worktree; commit a scoped change and report its hash, commands, and remaining risks.
- Preserve original plugin behavior through its module interface. Keep one source per feature across combined and split artifacts.
- Keep original source repositories and the real DSH home/profile untouched. Execute installs/hosts only with explicit disposable HOME/DSH_HOME/profile paths and temporary ports; never target the live GUI.
- Use native configuration and plugin-management interfaces where available; migration writes are profile-scoped, recoverable, and fail closed.
- Run focused tests while implementing; verify packed artifacts, not only source imports. Never report native integration or browser coverage unless actually executed.
- Secrets, personal profiles, node_modules, local archives, and sandbox state do not belong in Git or release assets.
- Record an evidence-based spec amendment before implementing a necessary contract change. Do not silently narrow an acceptance criterion.
