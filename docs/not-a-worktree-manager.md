# claude-hub is the index, not the runner

**Decision, 2026-08-17 (measured — do not re-litigate without new numbers):**
claude-hub will not grow a worktree dashboard, an in-app diff viewer, or
merge/PR-from-the-dashboard. It is deliberately not competing with the
parallel-agent managers.

This is written down because the gap is conspicuous. Every adjacent tool has
these three features, and a glance at the competitive set reads as "claude-hub
is missing the table stakes." It isn't. The features serve a workflow that the
evidence on this machine says is not the workflow being run.

## The competitive set

The real peers are the parallel-agent managers: **Conductor** (macOS, agents in
isolated worktrees, review/merge PRs from one dashboard), **Crystal** and
**Nimbalyst** (same shape, open source), **Vibe Kanban** (a task board over
agents), **Claude Squad** (terminal session manager). All five are built around
the same three things: worktree isolation, in-app diff review, and merge/PR
from the dashboard.

claude-hub has none of them. `git diff` appears nowhere in the codebase — the
only git verbs it runs are `rev-parse`, `ls-files`, `log` and `init`. Worktrees
exist purely as *labels*: a `worktreeBranch` chip in `SubagentsPanel`, a
`worktree` tag in workflow composition. There is no worktree inventory and no
merge-base check.

## The measurement

An audit of every subagent meta on disk, **735 runs spanning 2026-07-02 →
2026-08-17**:

| measure | value |
|---|---|
| total subagent runs | 735 (132 in the last 7d, 538 in 7–30d) |
| **worktree-isolated** | **16 — 2.2%** |
| dominant modes | `general-purpose` 263 · `workflow-subagent` 246 · `baseline-runner` 85 · `Explore` 44 |
| live worktrees at audit time | 0 (the Agent tool removes unchanged ones) |
| leftover agent branches | 0 |

**97.8% of agent runs are in-process fan-out inside a session, not parallel
isolated checkouts.** A worktree dashboard and a diff viewer would serve 2.2%
of runs — and diff review is already one click away in VS Code, which the app
can already launch. Conductor and Crystal need those features because they *are*
the runner and have nowhere else to send you. claude-hub is the index.

Same evidence-of-use discipline that settled the recall experiment: a feature
earns its place from measured usage, not from a competitor's feature list.

A methodology note, because it nearly produced the opposite answer: the first
pass of this probe reported **0** worktree agents. That was a `head -400`
sampling artefact, corrected by a full walk before any conclusion was drawn. A
suspiciously clean zero is a reason to re-run the measurement, not to publish it.

## What to do instead

The same audit found the gap actually worth closing, and it is the opposite of
catch-up: those 735 subagent transcripts were indexed and rendered (`d44f0d3`)
but **invisible to search**, sitting behind a box labelled "Search across all
session history". Two causes in `electron/session-search.ts` —
`findSessionFiles()` only enumerated top-level `*.jsonl`, so
`<sessionId>/subagents/**` was never opened, and every `isSidechain` line was
skipped, which is every line a subagent writes.

That has since shipped: subagent sidechains are searchable, and
`SessionSearchResults` reports how many hits in a session came from subagents.
The forensic index is claude-hub's actual identity, and no competitor does it.

## If this should be revisited

Re-run the subagent-meta audit. If worktree-isolated runs climb out of the low
single digits as a share of total runs, the premise has changed and this
decision is open again. Until then, it is closed.
