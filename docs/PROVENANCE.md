# Source provenance and development safety

Feature sources are MIT licensed local predecessor repositories. Preserve their notices and original authors in the final distribution. Chime includes CC0 Kenney Interface Sounds; preserve its THIRD_PARTY_NOTICES and required asset metadata.

Initial source commits (read-only):
- dsh-tool-compact-context 0.4.7: 22173d10f128bcee986cf45eb9ea36b623f664f2
- dsh-stream-retry 0.1.9: c100ff32b6228a81a69778f10e9a3d1f172160d6
- dsh-session-chime 0.6.0: 88f17e3945063e35d77964812ffa201e4bcbb948
- dsh-goal-wait-gate 0.3.0: 62662dc2b92f415f451f1c362535617e23f445d7

The gate source checkout already had local README/research/untracked changes. They are outside this task and must remain untouched. Only tracked feature source needed by the conventional gate is ported.

Audited development host package: @deepseek-ai/dsh 0.2.2-alpha.3, read-only. It is not modified or used to install Toolbox into the active profile.

Private validation baseline (paths are development-only and not embedded in runtime artifacts): active web profile package manifest SHA-256 4eec5020679e926d320b072d95baa1fd9f92a48903892a9d0c6eba25915e8b68; lock SHA-256 4db34901144ecea0041c587b8b9579b9cc54fe16ff0c64993d8b899a2fcf07ad; patch SHA-256 2047ef0ae4094db168c61f05ad66cc4744a3c10f5e6a97c28616ad733933c22a. These are integrity markers only, not profile contents.
