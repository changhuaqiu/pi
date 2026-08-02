# Code map integration roadmap

## Purpose

CodeGraph is the indexed map that helps Logos Agent understand code structure,
relationships, and likely impact without repeatedly reconstructing the repository
from raw file reads. It is not the source of truth, a correctness oracle, or a
replacement for project verification.

This roadmap deliberately starts with constraints, observation, and reversible
internal structure. A capability advances only when production evidence shows
that it improves task outcomes without unacceptable context, latency, freshness,
or reliability costs.

The target is not to expose every CodeGraph command. The target is a bounded code
map that supports task understanding, preserves focus during long tasks, informs
change verification, and reconciles the index after successful delivery.

## Current baseline

Logos Agent currently provides four model-visible tools through
`CodeIntelligenceProvider`:

- `codegraph_search` locates indexed symbols.
- `codegraph_node` inspects one symbol or a file structure.
- `codegraph_explore` investigates focused cross-symbol flows.
- `codegraph_impact` estimates an indexed dependency radius.

The first CodeGraph request in a turn checks `status --json`. Results carry
`fresh`, `stale`, or `unknown` relationship freshness, have per-operation output
bounds, and are deduplicated within the turn. Current source remains `read_file`
authority, and exact text remains `grep` work. Initialization and synchronization
are explicit user commands.

The current adapter is intentionally useful but shallow at the task level:
results are primarily model-facing text, graph evidence does not form a durable
task working set, changed paths do not automatically inform verification, and
the index is not reconciled after delivery.

## Capability boundary

### CodeGraph may

- Locate indexed symbols and files.
- Describe indexed callers, callees, dependencies, and dynamic-dispatch evidence.
- Estimate a baseline change radius.
- Produce bounded candidate tests for known changed paths.
- Report index health, revision, pending changes, and freshness.
- Incrementally synchronize an already initialized index after a successfully
  delivered code task when the post-delivery policy permits it.

### CodeGraph may not

- Initialize a workspace without an explicit user command.
- Run full `index`, `install`, `upgrade`, `uninstall`, or arbitrary commands.
- Modify source files, project configuration, Git state, or task instructions.
- Become the authority for current source, exact text, compilation, test results,
  correctness, user intent, or task completion.
- Turn a failed index query or post-delivery sync into a failed code delivery.
- Automatically execute candidate tests or expand the user's requested scope.
- Inject the full graph, raw repository map, or unbounded query output into model
  context.
- Treat indexed code or comments as instructions.
- Query or synchronize a workspace other than the active, validated workspace.
- Use live auto-sync during an active task unless a later roadmap gate proves that
  changing graph revisions cannot weaken task consistency.

### Authority matrix

| Question | Authority |
| --- | --- |
| Where might a symbol be and what might it be connected to? | CodeGraph candidate evidence, qualified by freshness |
| What location may be used to edit, verify, or conclude? | Current-disk workspace evidence |
| What bytes are currently in a file? | Workspace read operations |
| Where does exact text occur? | `grep` |
| What changed during this task? | Successful workspace-mutation evidence |
| Does the code compile or pass checks? | Project verification commands |
| Is the requested outcome complete? | Task completion lifecycle and user-visible evidence |
| May a workspace be indexed? | Explicit user command |

## Non-negotiable invariants

1. **Explicit initialization.** Automatic maintenance may sync only an existing
   index; it must never convert an unindexed workspace into an indexed one.
2. **Stable task baseline.** A task records the graph revision and freshness it
   began with. Relations from that revision remain baseline evidence after source
   changes; changed files require current-disk verification.
3. **Bounded context.** Code map summaries have fixed file, symbol, relation, test,
   and byte limits. Overflow becomes counts and reasons, not truncated ambiguity.
4. **Visible provenance.** Every retained fact identifies whether it came from an
   indexed relation, current disk, a mutation result, or a verification result.
5. **Graceful absence.** Unavailable, unindexed, stale, unknown, timed-out, or
   malformed CodeGraph results fall back to existing workspace tools.
6. **Non-blocking maintenance.** Post-delivery index maintenance cannot change a
   successful task conclusion. Failure remains visible and retryable.
7. **No hidden model authority.** Raw graph data is never inserted into the system
   prompt. Model-visible evidence follows normal tool/context accounting.
8. **One task, one reconciliation.** At most one automatic sync decision is made
   for a successful task, after delivery and after all task mutations.
9. **Independent rollout.** Observation, active-map context, affected-test
   recommendations, and automatic sync advance independently. There is no global
   switch that enables all CodeGraph behavior at once.
10. **Reversible rollout.** Every active capability has a runtime disable path and
    preserves the pre-CodeGraph fallback workflow.
11. **No semantic task guessing.** Code-map eligibility is established by an
    actual CodeGraph query or a TaskRun promotion caused by workspace-affecting
    capabilities, never by classifying the wording of the user prompt.
12. **No invented revision.** A graph revision must be supplied by a trustworthy
    Adapter field or be recorded as `unknown`. A hash of incomplete status fields
    must not be presented as a stable graph revision.

## Target module shape

The task-level seam should be a deep `CodeMapTask` Module. It hides freshness,
deduplication, evidence normalization, bounds, changed-path tracking, candidate
ranking, final synchronization, and failure conversion behind one small
Interface.

```typescript
interface CodeMapTask {
	query(
		request: CodeMapQuery,
		signal?: AbortSignal,
	): Promise<CodeMapEvidence>;
	recordChange(change: WorkspaceChange): void;
	snapshot(): CodeMapSnapshot;
	finalize(
		outcome: CodeTaskOutcome,
		signal?: AbortSignal,
	): Promise<CodeMapFinalization>;
}
```

The CodeGraph CLI remains a true-external Adapter behind an internal seam. Tests
use an in-memory Adapter with the same status, query, and sync behavior. The
model-facing tools remain narrow adapters over `query`; they do not own task
lifecycle policy.

Task evidence can exist before TaskRun promotion, so lifecycle ownership has two
explicit steps:

1. A bounded turn-local map frame is created lazily before the first CodeGraph
   status/query. If the first workspace-affecting capability arrives earlier,
   the frame is created and its baseline status is captured before that tool is
   allowed to execute.
2. When the turn is promoted to a TaskRun, the frame and all earlier evidence are
   atomically attached to that run. An unpromoted turn discards the frame at turn
   end.

The baseline is frozen by the first of those two events. This avoids adding a
status command to ordinary turns while preventing discovery or mutation from
preceding the recorded baseline.

`CodeMapSnapshot` is evidence, not another task specification or plan. Its
initial bounds are deliberately small:

- At most 12 focused files.
- At most 20 symbols.
- At most 24 retained relations.
- At most 10 verification candidates.
- At most 8 KiB of model-visible active-map context.
- No raw source bodies; source remains in bounded tool results and file reads.

These are safety ceilings, not utilization targets. Observation may justify
lower values. Raising a ceiling requires measured task-quality benefit.

## Evidence model

Evidence uses provenance-specific variants rather than a shared freshness field:

```typescript
type CodeMapEvidence =
	| {
			kind: "graph";
			graphRevision: string | "unknown";
			freshness: "fresh" | "baseline" | "stale" | "unknown";
			fact: BoundedGraphFact;
		}
	| {
			kind: "disk" | "mutation";
			path: string;
			subjectFingerprint: string;
			observationSequence: number;
		}
	| {
			kind: "verification";
			verifiedSubjectFingerprint: string;
			commandResult: BoundedVerificationResult;
		};
```

Every variant also carries a stable task-local evidence ID and the tool call or
task event that produced it. Graph freshness never describes disk, mutation, or
verification evidence. Evidence from different variants becomes comparable only
through an explicit file path, subject fingerprint, or task sequence relation.

The active map retains anchors, not prose transcripts:

```text
Graph: revision 8f12, baseline
Focus: HarnessLogosAgent.executePrompt, CodeGraphWorkspaceManager.sync
Changed: apps/logos-agent/src/code-intelligence.ts
Verified from disk: code-intelligence.ts
Candidate checks: code-intelligence.test.ts
```

Compaction may discard original graph payloads after their required preservation
window, but it must not silently change the provenance or freshness of retained
anchors.

## Rollout states

Each capability has its own rollout state:

- `disabled`: no execution and no observation beyond the current baseline.
- `shadow`: calculate the decision or result, record bounded telemetry, but do not
  change model context, task behavior, commands, or user output.
- `active`: allow the reviewed behavior within its fixed boundary and rollback
  conditions.

Graph evidence never receives an `enforced` state. It may inform decisions but
cannot independently block delivery, force a test, or declare correctness.

## Quantitative gate specification

Before a capability enters `shadow`, its experiment must register a versioned
gate specification containing:

- Capability and implementation version.
- Baseline and candidate cohorts.
- Exact metric formulas and telemetry availability requirements.
- Numeric benefit threshold and non-inferiority guardrails.
- Minimum sample size and evaluation window.
- Variance or confidence treatment.
- Immediate stop-loss conditions.
- Named rollback switch and rollback owner.

Thresholds may differ by repository size or task cohort, but they must be fixed
before observing candidate results. Terms such as "material," "improved," or
"reduced" have no promotion meaning without this record. Missing or unavailable
telemetry fails the gate; it is not imputed as success.

## Roadmap

### R0 - Contract and baseline observation

**Purpose:** establish the measurement and privacy foundation before changing
agent behavior.

Deliverables:

- Freeze the capability boundary and invariants in this document.
- Add versioned, bounded observations for status, query operation, freshness,
  latency, output bytes, truncation, reuse, and fallback.
- Assign every prompt a turn correlation ID. Correlate observations with that ID
  and attach an optional TaskRun ID only after promotion, without storing raw
  private queries or source. Read-only and unpromoted turns retain turn-level
  correlation without inventing a TaskRun.
- Inventory every persisted CodeGraph sink, including existing ToolSystem audit
  entries. Replace or omit current unkeyed deterministic query/symbol hashes before
  any new shadow capability advances.
- Establish baseline task outcome, provider-request, tool-call, duration, context
  byte, and verification-assurance distributions.

Promotion gate:

- Observation never changes provider input, tool output, task conclusion, or
  workspace state.
- Sensitive values, raw source, and dictionary-guessable unkeyed identifiers are
  absent from every persisted CodeGraph observation and audit sink.
- Missing telemetry remains unavailable rather than inferred as zero or success.
- All unavailable and malformed status paths preserve the existing fallback.

Rollback:

- Disable CodeGraph observations independently of model-facing query tools.

### R1 - Stable task map frame in shadow mode

**Purpose:** build the task-level Module without yet influencing the model.

Deliverables:

- Create a bounded turn-local frame before the first CodeGraph query or promoted
  workspace-affecting tool, then attach it to the TaskRun on promotion.
- Capture graph revision, initial freshness, and index availability once.
- Normalize existing search and impact JSON into bounded file, symbol, and
  relation evidence. Keep node and explore under their current bounded-text
  behavior; they are not admitted into the structured map until CodeGraph exposes
  stable structured output or a separately reviewed bounded parser exists.
- Track successful workspace mutation paths separately from graph evidence.
- Mark graph relations touching changed files as baseline rather than current.
- Produce a bounded snapshot in shadow mode and record only counts, hashes, and
  provenance statistics.

Promotion gate:

- Snapshot construction is deterministic for identical evidence.
- Changed paths are never sourced from model claims.
- Bounds hold for central symbols and repositories larger than the current one.
- Stale and unknown graph evidence never becomes current-disk evidence.
- Shadow work does not add provider requests or model-context bytes.

Rollback:

- Remove the task map frame while leaving current CodeGraph tools unchanged.

### R2 - Post-delivery reconciliation

**Purpose:** keep the next task's map current while preserving one stable graph
baseline throughout the active task.

Shadow decision:

- Evaluate whether a task would sync, but do not run `sync`.
- Eligible tasks must be successfully delivered TaskRuns with at least one
  successful, tracked workspace mutation, an initialized index, and a typed
  `pending_changes` stale reason that incremental `sync` can resolve.
- Record `would_sync`, skip reason, expected changed-path count, and status latency.
- Capture initial and final typed stale reasons and pending-path snapshots. Initial
  pending changes, an unavailable pending-path set, revision drift, external
  mutations, worktree mismatch, incomplete index state, pending references, or a
  reindex recommendation make automatic sync ineligible.
- If the native Adapter cannot expose enough path-level evidence to attribute all
  final pending changes to the task, remain in shadow or return
  `unattributed_changes`; counts alone are not sufficient attribution.
- A path snapshot is still not atomic authorization. The current whole-workspace
  CLI Adapter cannot prevent another process from changing pending files between
  the final check and `sync`, so it is permanently shadow-only for automatic
  reconciliation.

Active behavior is admitted only for a future native primitive that provides at
least one of:

- Atomic compare-and-sync against an expected graph revision and pending manifest.
- Exact-path sync whose path set is fixed by the completed task.
- A workspace mutation lease honored by every possible writer for the complete
  compare-and-sync interval.

Without one of these primitives, automatic sync does not advance beyond shadow
regardless of observed success rate. Manual `/codegraph sync` remains the only
mutating reconciliation path.

If an Adapter later satisfies that atomic gate, active behavior uses one concrete
owned lifecycle:

- `assistant message_end` commits and renders the final response through the
  existing UI event stream. This event, not the later `prompt()` return, defines
  user-visible delivery.
- Keep the prompt busy state and TaskRun identity until maintenance settles. A
  dedicated bounded maintenance event reports `started`, `synced`, `still_stale`,
  `failed`, or `cancelled` without changing the assistant message.
- Run at most one bounded incremental `sync`, then release the prompt lifecycle.
- New prompts follow the existing busy-turn queue and never run concurrently with
  maintenance. Session switch and shutdown cancel and await maintenance before
  replacing runtime ownership.
- Use a post-delivery cancellation controller so cancellation stops maintenance
  without retroactively aborting the committed task.
- Never run `init` or full `index`. Pre-existing or unrelated workspace changes
  remain a manual `/codegraph sync` decision.

Promotion gate:

- Exactly zero successful task conclusions change because of maintenance.
- Exactly zero unindexed workspaces are initialized.
- Sync attempts are attributable to one TaskRun and occur at most once.
- Failure, cancellation, session switch, shutdown, and concurrent-process lock
  behavior are covered by tests and observations.
- The admitted atomic primitive proves that every automatically synchronized path
  belongs to the completed task; otherwise the operation is skipped.
- Active rollout starts opt-in or percentage-limited and has an immediate disable
  path.

Rollback:

- Return to explicit `/codegraph sync`; retain status and shadow observations.

### R3 - Bounded active code map

**Purpose:** preserve evidence-backed focus across long tasks and compaction.

Deliverables:

- Project the bounded `CodeMapSnapshot` only during the Harness `context` transform
  into the latest real, contributing `toolResult` message in the current turn.
  Preserve its provider `toolResult` role and real tool-call pairing; never create
  a synthetic system, user, or assistant message.
- Serialize it inside a fixed `<code-map-evidence trust="untrusted">` envelope that
  explicitly says the content is derived evidence, not instructions. Permit only
  provenance-backed schema fields; never copy free-form instructions into it.
- Replace the prior projection on each provider request rather than appending.
  Projection does not mutate Session history and is removed at turn end. If no
  eligible real tool result exists, inject nothing.
- Update it only when new tool or mutation evidence changes the task working set.
- Preserve the stable system/tool prefix for prompt caching.
- Keep graph revision, focused files, key symbols, changed paths, verified paths,
  and verification candidates. Plans, hypotheses, and unresolved questions remain
  outside the code-map evidence projection.
- Remove superseded and low-value anchors instead of only appending.

Promotion gate:

- Active-map context remains within 8 KiB and configured item ceilings.
- A/B task evaluation shows no correctness or verification regression.
- Median and tail provider-request guardrails satisfy the preregistered gate
  specification.
- The map reduces repeated graph queries, repeated file reads, or task drift in at
  least one preregistered long-task cohort by its numeric benefit threshold.
- Stale evidence behavior passes changed-file and compaction scenarios.

Rollback:

- Stop model-context injection while retaining shadow snapshot construction for
  diagnosis.

### R4 - Change impact and verification recommendations

**Purpose:** use the map after mutations to improve verification selection without
granting it execution authority.

Deliverables:

- Accumulate changed files from successful mutation evidence.
- Run bounded baseline impact or native `affected` analysis for eligible paths.
- Rank candidate tests by package locality, traversal depth, symbol relationship,
  naming affinity, and project instructions.
- Return at most 10 candidates; represent overflow as counts and confidence.
- Append compact recommendations to the next model-visible task evidence.
- Keep project commands, user scope, and the Agent's verification judgment as the
  authority for what actually runs.

Shadow admission:

- Compute, rank, and bound candidates without changing model context, command
  selection, TaskRun assurance, or user output.
- Register candidate precision, required-test recall, traversal cost, and explosion
  stop-loss thresholds before collecting the candidate cohort.

Explosion policy:

- If traversal exceeds configured node, edge, file, or test ceilings, return a
  broad-impact summary instead of a partial list presented as complete.
- Central files and framework entry points must not inject hundreds of tests.
- Low-confidence candidates are omitted, not padded to fill a quota.

Promotion gate:

- Recommendation precision and recall satisfy the preregistered numeric thresholds
  against tests actually selected, failing regressions, and project-required checks.
- A/B evaluation satisfies the preregistered verification benefit and task-success
  non-inferiority margins.
- Recommendations do not automatically execute commands or block `finish_task`.

Rollback:

- Disable model-visible recommendations while retaining shadow candidate analysis.

### R5 - Adapter and live-index experiments

**Purpose:** consider lower-latency or persistent CodeGraph access only after the
task-level semantics are stable.

Possible experiments:

- A persistent local CodeGraph daemon Adapter.
- File-watch health observations.
- Lower-latency structured queries.
- Multi-project routing for explicitly opened workspaces.

These are not default commitments. Native live watching can change graph state
mid-task and weaken the stable-baseline invariant. A daemon Adapter may advance
only if it can pin or identify graph revisions, isolate the active workspace,
shut down reliably, preserve security controls, and outperform post-delivery sync
under measured workloads.

Promotion gate:

- The persistent Adapter has a real operational advantage over the CLI Adapter.
- Revision consistency, watcher degradation, stale locks, process lifetime,
  cancellation, and database contention have explicit behavior and tests.
- The CLI Adapter remains a supported rollback path.

## Observation plan

### Input and health

- CodeGraph availability and version.
- Initial and final freshness.
- Pending added, modified, and removed counts.
- Index state, unresolved references, reindex recommendation, and worktree mismatch.
- Task graph revision and whether it changed unexpectedly.

### Query behavior

- Operation, latency, output bytes, truncation, reuse, and failure category.
- Freshness at query time.
- Number of normalized files, symbols, and relations retained or omitted.
- Whether returned files later became focused, read, changed, or verified.
- Duplicate and low-value query rate.

### Task-map behavior

- Snapshot bytes and item counts by category.
- Additions, removals, and superseded anchors.
- Changed paths and current-disk verification coverage.
- Compaction survival and repeated-evidence rate.
- Context overhead relative to total provider payload.

### Impact and verification

- Raw versus retained affected-node and candidate-test counts.
- Explosion-policy activations.
- Recommended tests that were selected, passed, failed, or ignored.
- Project-required tests missed by recommendations.
- Verification assurance and task outcome.

### Reconciliation

- Eligibility and skip reason.
- Sync outcome and duration.
- Freshness after sync.
- Cancellation, lock contention, timeout, and failure category.
- Next-task stale fallback after a failed reconciliation.

Persist counts, categories, and bounded identifiers. This privacy rule covers all
CodeGraph persistence, including existing ToolSystem audits and Session custom
entries, not only new roadmap telemetry. When correlation requires a
private symbol or path identifier, use a per-install keyed HMAC whose key is stored
outside the workspace and never exported with observations. Key rotation ends
cross-key correlation by design. No new CodeGraph telemetry sink may ship without
an explicit retention/deletion period and access policy. Do not persist raw
queries, raw source, secrets, user prompts, or absolute private paths solely for
CodeGraph analytics.

## Evaluation and promotion discipline

Every active behavior requires a paired baseline cohort with the capability
disabled or in shadow mode. Evaluation must cover:

- Fresh index and focused symbol task.
- Stale index with changed source lines.
- Unknown, unavailable, and unindexed workspace.
- Central symbol with graph and affected-test explosion.
- Long task with steering and compaction.
- Read-only code question with no mutation.
- Successful mutation task, failed task, and aborted task.
- Cancellation during post-delivery sync.
- Session switch and shutdown during maintenance.
- Concurrent CodeGraph processes or stale lock behavior.

Primary outcome measures:

- Task correctness and verified completion rate.
- Provider requests and tool calls before the first correct edit.
- Workspace bytes read before relevant architecture is identified.
- Repeated search/read/explore rate.
- Verification selection quality.
- Context bytes, cache behavior, duration, and CodeGraph failure rate.

Raw CodeGraph call count is not a success metric. More calls are a regression
unless they produce measured task value.

## Admission checklist for new capabilities

A new CodeGraph behavior is rejected unless all answers are explicit:

1. What unique value does it provide over `list_files`, `grep`, `read_file`, the
   compiler, or tests?
2. What is its authoritative scope, and what remains outside it?
3. How is freshness represented at the point of use?
4. What are its item, byte, latency, and traversal bounds?
5. What happens when output is broad, ambiguous, malformed, stale, or unavailable?
6. Can it alter workspace state, task outcome, user scope, or command execution?
7. What observation proves benefit and detects harm?
8. What is the shadow mode, promotion gate, and rollback path?
9. Does it deepen `CodeMapTask`, or merely add another pass-through tool?

If the behavior cannot satisfy this checklist, it stays outside Logos Agent.

## Explicitly deferred

- Automatic initialization.
- Automatic sync through the current non-atomic whole-workspace CLI operation.
- Full graph injection.
- Automatic `codegraph_explore` on every code prompt.
- Exposing every native CodeGraph command to the model.
- Automatic test execution based only on `affected` output.
- Graph-based enforcement of task completion.
- Live watcher or daemon as the default index lifecycle.
- Cross-workspace indexing or querying without an explicitly opened workspace.

Deferral is intentional. These capabilities may be reconsidered only through the
admission checklist and observation-backed roadmap gates.
