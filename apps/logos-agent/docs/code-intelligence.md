# Code intelligence

The constrained task-level integration plan is documented in
[Code map integration roadmap](./code-map-roadmap.md). That roadmap defines the
capability boundary, rollout states, observation gates, and explicitly deferred
behaviors. This document describes the currently implemented runtime behavior.

Logos Agent exposes four model-facing tools through a replaceable
`CodeIntelligenceProvider`: `codegraph_search`, `codegraph_node`,
`codegraph_explore`, and `codegraph_impact`. The initial adapter maps these
directly to the corresponding local CodeGraph CLI semantics.
It does not install CodeGraph, modify another agent's configuration, or let the
model initialize or update indexes.

## Windows setup

Use the official self-contained CodeGraph bundle. npm and standalone `.cmd`
launchers are intentionally not executed because Logos Agent never enables a
command shell. On Windows, point Logos Agent at the bundle's `node.exe`; it
validates and invokes the fixed adjacent `lib/dist/bin/codegraph.js` entry point.

Logos Agent automatically discovers the official default installation under
`%LOCALAPPDATA%\codegraph\current`. For a custom installation, set the trusted
executable explicitly before starting Logos Agent:

```powershell
$env:LOGOS_AGENT_CODEGRAPH_PATH="$env:LOCALAPPDATA\codegraph\current\node.exe"
```

The resolved executable must be an absolute file outside the active workspace.
If the environment variable is absent, Logos Agent checks the official
`%LOCALAPPDATA%` location before searching absolute `PATH` entries for
`codegraph.exe`. It resolves the result once and rejects a binary found inside
the workspace.

Initialize the intended project explicitly from that project's root with the
official launcher:

```powershell
codegraph init
codegraph status --json
```

Logos Agent also exposes workspace-bound TUI commands:

```text
/codegraph status
/codegraph init
/codegraph sync
```

On startup, an uninitialized workspace gets a prompt to run `/codegraph init`.
Initialization is never automatic: the user command is the authorization to
scan that workspace. The global CodeGraph installation is reused, while every
project keeps its own `.codegraph/` index.

Review the files included by CodeGraph before indexing a private repository.
Only an explicit user TUI command may run `init`. After a successful controlled
edit, Logos Agent schedules a single-flight `sync` and coalesces concurrent edits
into one trailing sync. Manual `/codegraph sync` remains available. Logos Agent
never runs `index`, `install`, `upgrade`, or `uninstall`.

## Runtime boundary

- The first CodeGraph request in each turn runs `status --json`; later requests
  reuse that status snapshot for the same turn.
- Pending changes, worktree mismatch, incomplete index state, unresolved
  references, and recommended reindexing mark the result stale.
- Missing health fields produce `unknown`, never a false `fresh` result.
- Missing executables and indexes return a normal fallback instruction to use
  `list_files`, `grep`, and `read_file`.
- The child process uses `shell: false`, a fixed absolute executable, bounded
  output, and a deadline covering executable resolution and execution.
- Provider API keys are not inherited. Telemetry and update checks are disabled
  with `CODEGRAPH_TELEMETRY=0`, `DO_NOT_TRACK=1`, and
  `CODEGRAPH_NO_UPDATE_CHECK=1`.

## Model tools and context

The index is never injected into the system prompt or hidden behind the user
message. Every CodeGraph payload now follows a model-visible tool decision:

- `codegraph_search` locates symbol definitions without source.
- `codegraph_node` inspects one known symbol or a file's structural map.
- `codegraph_explore` handles focused multi-symbol flows, dynamic dispatch, and
  cross-module relationships. Its native `maxFiles` parameter defaults to 3 and
  is bounded to 6.
- `codegraph_impact` returns an indexed dependency radius before refactoring.

Exact strings and regular expressions remain `grep` work. Current source remains
`read_file` authority. `scope` is not exposed because CodeGraph `explore` has no
native scope parameter; the previous implementation only appended scope text to
the natural-language query.

Search and impact output are capped at 16 KiB, node and explore output at 24 KiB.
All four tools declare their history policy through ToolSystem. Search, node,
and impact join the normal bounded compaction pool. Explore remains complete for
the first provider request that consumes it, then becomes a short summary on
later provider requests. Identical normalized requests in one turn execute
CodeGraph once; a duplicate returns a small reference to the earlier result
rather than repeating the payload.

Audit records store query or symbol byte counts and hashes, not raw private
queries. Tool details expose operation, availability, relationship freshness,
truncation, same-turn reuse, and a stable result key.

Graph relationships and symbol locations are derived index evidence. Node and
explore may include source re-read from the current disk, but a stale index can
still produce old relationships around that source. Before an edit, the Agent is
instructed to verify locations and current code through `grep` and `read_file`.
