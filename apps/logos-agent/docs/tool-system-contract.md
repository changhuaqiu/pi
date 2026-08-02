# Logos Agent tool-system rule

This is a small implementation rule, not a target framework.

## Reference finding

The inspected Claude Code tree is a reverse-engineered reconstruction, so it is implementation evidence rather than an authoritative specification. Its useful pattern is simple:

1. A tool owns the facts that differ by tool: schema, validation, permission check, result mapping, result-size limit, and rendering helpers.
2. One executor owns the lifecycle shared by every tool: validate, authorize, execute, map the result, bound large output, audit, and convert failures into tool results.
3. Large output is not repeatedly copied into provider context. It is persisted and replaced with a stable preview when necessary.

## Rule for this project

Keep `ToolSystem` as the registry and policy boundary. Do not add another base class or a parallel `ToolContract` hierarchy.

Each `ManagedToolDescriptor` declares only behavior that the shared system cannot infer:

- `capabilities` and `defaultPermission` for authorization;
- optional `authorization` for a prepared operation or approval subject;
- optional `audit.summarizeInput` for sensitive or high-volume input;
- optional `context.maxBytes` and `context.project` for model-facing result governance;
- `context.history` when a result is either safe to compact or must be preserved.

`context.history` has two values:

- `compact`: old results may be replaced in provider context after the recent working set and byte budget are satisfied;
- `preserve`: the result is excluded from automatic history projection because it carries state such as an edit proposal.

The descriptor registry is the only source for that decision. `model-context.ts` must not maintain a second list of tool names.

## Result semantics

A resolved tool promise does not necessarily mean the operation succeeded. Tools that return process status must project non-zero exit codes, timeout, or forced stop to `isError: true` at the shared result boundary. The TUI and observability consume that value; they must not infer success by parsing display text.

## Deliberately deferred

This change does not introduce a universal outcome taxonomy, recovery-action schema, presentation DSL, permission profile framework, or a second execution runtime. Add one of those only after a concrete repeated failure demonstrates that the current seam cannot express the required behavior.

Large-result persistence is also deferred. The next implementation should copy the proven shape: retain the governed full output outside provider messages and put a stable preview/reference into provider context. It should not silently discard output or duplicate full output in both `content` and `details`.
