# Scrum Kanban & Sub-Agent Knowledge Transfer Protocol

## 1. System Overview & Standing Rules
This document defines the **Scrum Kanban Governance & Handover Protocol** for this project.
These rules are standing operating procedures for all engineering sessions, the coordinator agent, and all sub-agents.

### 1.1. Roles
| Role | Model | Job |
|---|---|---|
| **Coordinator** | Opus (main session) | Grooms tickets, writes grooming handovers, dispatches workers, reviews results, talks to the user. |
| **Worker** | Sonnet (`.claude/agents/ticket-worker.md`) | Executes one groomed ticket. Does not groom, re-scope, or start other tickets. |

The saving comes from doing the expensive exploration **once**, during grooming, and handing the result to a cheaper worker. A worker that has to rediscover the code wastes that saving. Sections 3 and 6 exist to prevent this.

---

## 2. Ticket Hierarchy & Taxonomy

Every unit of work is classified into one of five ticket types:

```text
Epic (EPIC-XXX)
  └── Story (STORY-XXX)
        └── Task (TASK-XXX)

Chore (CHORE-XXX)
Bug (BUG-XXX)
```

1. **Epic (`EPIC-XXX`)**: Major architectural milestone or subsystem.
2. **Story (`STORY-XXX`)**: Deliverable feature or vertical capability under an Epic.
3. **Task (`TASK-XXX`)**: Concrete technical step required to complete a Story.
4. **Chore (`CHORE-XXX`)**: Tooling, maintenance, dependency management, or refactoring without behavior changes.
5. **Bug (`BUG-XXX`)**: Defects, broken invariants, test failures, or regressions.

---

## 3. Estimation & Grooming Rules

1. **Fibonacci Sequence**: Estimate all work items in story points: **1, 2, 3, 5, 8, 13, 21**.
   - **1–2 pts**: Configuration tweak, small documentation update, single isolated test.
   - **3–5 pts**: One service method or endpoint, a schema migration with its repository functions.
   - **8 pts**: Cross-cutting component that touches several modules.
   - **13+ pts**: Too large. Split into smaller Stories or Tasks before `TODO`.
2. **Pre-Start Estimation Invariant**: No ticket leaves `BACKLOG` without an approved Fibonacci estimate.
3. **Grooming in Batches**: Groom tickets in clusters by parent Epic or Story.

### 3.1. Definition of Groomed
A ticket may enter `TODO` only when its `board.json` record has all of these fields and its own note has a dated `## GROOMING ·` entry. `scripts/kanban/render-board.mjs` rejects the board otherwise.

| Field | Content |
|---|---|
| `points` | Fibonacci estimate. |
| `model` | Worker model: `sonnet` by default, `haiku` for 1–2 pt mechanical work, `opus` only for design-heavy or high-risk work. |
| `context.files` | Files the worker will read or change. |
| `context.symbols` | Functions, classes, or methods involved. (`files` or `symbols` required.) |
| `context.entry_points` | Where the flow starts (route, command, handler). Optional. |
| `context.codegraph_queries` | Ready-made `codegraph_explore` queries that return the relevant source. Required. |
| `acceptance` | Observable results that prove the ticket is done. |
| `verify_cmd` | Command the worker runs to self-check (tests, typecheck, lint). |
| `handovers` | Handover note IDs the worker must read (see section 6). Must include the ticket's own ID. |

The coordinator gets `context` from the CodeGraph calls it makes during grooming. It records the queries that worked so the worker can repeat them instead of searching again.

---

## 4. Ticket Relationships & Dependencies

Every ticket defines its relational graph:
- **`parent`**: The parent Story or Epic ID. Tasks use `parent`, not `story`.
- **`children`**: Sub-tickets belonging to this ticket.
- **`requires`**: Prerequisites that **must be `DONE`** before this ticket enters `IN_PROGRESS`.
- **`blocks`**: Dependent tickets that cannot start until this ticket is `DONE`.

---

## 5. Board Statuses & WIP Limits

The board has 7 lifecycle states:
1. `BACKLOG`: Not yet groomed.
2. `TODO`: Groomed (section 3.1), estimated, ready to pick up once `requires` are `DONE`.
3. `IN_PROGRESS`: A worker is executing it.
4. `PAUSED`: Started and put on hold. The handover note explains the current state.
5. `REVIEW`: Code complete. Coordinator checks quality gates (`lint`, `typecheck`, `test`) and acceptance criteria.
6. `DONE`: Acceptance criteria verified, tests passing, merged or staged for release.
7. `ABANDONED`: Permanently closed. Effort spent and the reason are recorded.

### 5.1. WIP Invariant
- Each worker (`assignee`) holds **at most `wip_limit_per_worker` (1)** ticket in `IN_PROGRESS`.
- At most **`max_parallel_workers`** workers run at the same time (set in `board.json`).
- Two `IN_PROGRESS` tickets **must not** share a file in `context.files`. If they would, run them one after the other.
- Parallel workers run in separate git worktrees (Agent tool `isolation: "worktree"`) so their code changes do not collide. Worktrees need at least one commit in the repo.
- **Shared state stays in the main checkout.** Workers read and write `board.json` and `handovers/` under the main repo root, never the worktree copy. Otherwise WIP checks and FLAGs are invisible to other workers.
- `render-board.mjs` enforces all three rules.

### 5.2. Interruption & Task-Switching Protocol
If a worker, the coordinator, or the user wants to start a new ticket while the same worker already has one `IN_PROGRESS`:
1. **Stop.** Do not start the new ticket.
2. **Ask the user** what happens to the active ticket:
   - **`PAUSED`**: Put on hold. Write a `PROGRESS` handover note (section 6).
   - **`ABANDONED`**: Permanently retired with a recorded reason.
3. Only after that transition may the new ticket enter `IN_PROGRESS`.

---

## 6. Handover Notes & Knowledge Transfer

### 6.1. Canonical State Files
- `docs/kanban/board.json`: The only source of truth for tickets, states, estimates, dependencies, and context.
- `docs/kanban/BOARD.md`: **Generated** from `board.json`. Never edit it by hand. Run `node scripts/kanban/render-board.mjs` after every `board.json` change.
- `docs/kanban/handovers/<ID>.md`: One note file per ticket, epic, or story. Template: `docs/kanban/handovers/_TEMPLATE.md`.

### 6.2. Note Entry Types
A note file is a log. Agents **append** dated entries; they never delete earlier entries. There are three entry types:

| Entry | Written by | When | Content |
|---|---|---|---|
| `GROOMING` | Coordinator | When the ticket enters `TODO` | Approach, relevant code found, pitfalls, what is out of scope. |
| `PROGRESS` | Worker | On `PAUSED`, `REVIEW`, `DONE`, `ABANDONED` | Files changed, verification results, decisions, next steps. |
| `FLAG` | Any agent | Any time it finds something that affects **another** ticket | What was found, where (file:line), and why it matters to that ticket. |

`FLAG` entries go into the **target** ticket's note file, not the author's. Example: while working on TASK-042, a worker finds that `UserRepo.save` has no transaction and TASK-050 will depend on it. The worker appends a `FLAG` entry to `handovers/TASK-050.md` (creating it from the template if needed) and adds a line to `HANDOVERS.md`. TASK-050 already lists its own note in `handovers`, so no `board.json` change is needed. If a finding applies to a whole story or epic, append it to that story's or epic's note file instead, and add that ID to the `handovers` field of every affected unstarted ticket.

### 6.3. Required Reading Before Work
Before starting a ticket, a worker reads, in this order:
1. `handovers/<EPIC-ID>.md` (if it exists)
2. `handovers/<STORY-ID>.md` (if it exists)
3. Every note listed in the ticket's `handovers` field (its own note, with `GROOMING` and any `FLAG` entries).
4. The last `PROGRESS` entry of every ticket in `requires`.

### 6.3.1. Dispatching a Worker
Agent tool, `subagent_type: "ticket-worker"`, `model: <ticket.model>` (the agent file defaults to Sonnet; pass the ticket's model so `haiku`/`opus` grooming takes effect). Prompt: ticket ID, worker name, main repo root. Add `isolation: "worktree"` only when workers run in parallel.

### 6.3.2. Review
At `REVIEW` the coordinator reads the worker's `PROGRESS` entry and `git diff` of `context.files`, reruns `verify_cmd`, and checks each `acceptance` item. It does not re-explore the code.

### 6.4. Handover Index
`docs/kanban/handovers/HANDOVERS.md` lists every `FLAG` entry that is still open, one line each: target ID, source ID, one-line summary. The coordinator removes a line when the target ticket is `DONE` or `ABANDONED`.

---

## 7. Code Exploration: CodeGraph First

Agents use CodeGraph before Grep, Glob, or reading whole files, when the repository has a `.codegraph/` index.

1. **Start from the ticket.** Run the `context.codegraph_queries` from the ticket first. They were checked during grooming.
2. **Then explore.** Call `codegraph_explore` with `projectPath` set to the repository root, naming the symbols or files from `context`.
3. **Grep, Glob, and shell search are a fallback.** Use them only for non-code text (config values, string literals, log messages) or when CodeGraph returns nothing. A `PreToolUse` hook denies the first code search per agent (Grep, Glob, whole-file Read of source, `grep`/`rg`/`find`/`cat`/`Select-String`/`Get-Content` in Bash or PowerShell) until CodeGraph is used.
4. **Ranged Read before Edit.** Edit needs a prior Read. Read only the lines you change, using the line numbers CodeGraph returned.
5. **Freshness.** A daemon file watcher re-indexes saved files within about 1 second while a session is open (it stops after 5 idle minutes). `SessionStart` and git hooks run `codegraph sync -q` to cover pulls, branch switches, and offline edits. `codegraph.json` excludes `.claude/worktrees/`, so worker edits never leak into the shared index. If results look stale, run `codegraph sync` and retry.
6. **Record new queries.** If a worker needed a query that grooming did not provide, add it to the `PROGRESS` entry so later tickets can reuse it.

If there is no `.codegraph/` directory, use the built-in tools. Indexing is the user's decision.

---

## 8. Git Operations & Pull Request (PR) Governance

### 8.1. Branching Strategy
- **Base Integration Branch**: `develop`
- **Feature Branches**:
  - Epics / Stories: `feature/<TICKET-ID>-<slug>` (e.g. `feature/EPIC-001-monorepo-foundation`)
  - Bugs: `fix/<TICKET-ID>-<slug>` (e.g. `fix/BUG-004-null-session`)
  - Chores: `chore/<TICKET-ID>-<slug>` (e.g. `chore/CHORE-002-upgrade-deps`)
- **Target Branch**: PRs **always** target `develop`. Never open PRs against `main` or `master` during the redevelopment phase.

### 8.2. Anti-Runaway Session Boundary
- Sessions must **never** silently complete multiple epics without user checkpoints.
- Group commits and PRs by **Epic** or **Story**.
- When an Epic or Story reaches `REVIEW` / `DONE`, **stop and ask the user**:
  > *"Epic [EPIC-XXX: Title] is complete with all tests passing. Would you like me to commit, push the branch, and create a Pull Request to `develop` before we proceed to the next Epic?"*
- Wait for explicit confirmation before starting the next Epic.
- Workers never commit, push, or open PRs. The coordinator does this after user confirmation.

---

## 9. Board Rules & Ticket IDs

### 9.1. Ticket IDs Are Unique
- Before assigning a new ID, search `board.json` for it. IDs are never reused, including IDs of `ABANDONED` tickets.
- `board.json` holds one record per ID. When a ticket is regroomed, edit its record instead of appending a new one.
- Handover notes are named after the ticket ID, so a reused ID would overwrite another ticket's note.

### 9.2. Verifying the Board
Before committing board changes, run:
```bash
node scripts/kanban/render-board.mjs          # validate and regenerate BOARD.md
node scripts/kanban/render-board.mjs --check  # validate only; fails if BOARD.md is stale
```
The script checks: duplicate IDs, unknown references, Fibonacci points, the Definition of Groomed (3.1, including `codegraph_queries`, `verify_cmd`, and the `GROOMING` entry), missing handover files, prerequisites, WIP limits and file overlap (5.1), and story points against the sum of task points.
