# DSH Toolbox

A collection of independently selectable DSH enhancements delivered together or separately.

## Language

**Toolbox**: The enhancement suite as a product, independently of its installation shape.
_Avoid_: Monolithic feature

**Module**: One independently enabled Toolbox capability: context, retry, chime, or goalWait.
_Avoid_: Separate implementation

**Distribution**: An installable combined or single-module edition of the same Toolbox release.
_Avoid_: Fork

**Legacy plugin**: One of the four predecessor packages from which Toolbox can import settings and take over a capability.
_Avoid_: Split distribution (new Toolbox splits are not legacy plugins)

**Handover**: A capability's transition from a previous running owner to a new running owner.
_Avoid_: Import (configuration import alone does not complete a handover)

**Migration**: A profile-scoped, recorded transfer of legacy configuration and ownership into Toolbox.
_Avoid_: Uninstall

**Recovery**: Continuation or selective reversal of an interrupted migration without overwriting unrelated later edits.
_Avoid_: Full-profile reset
