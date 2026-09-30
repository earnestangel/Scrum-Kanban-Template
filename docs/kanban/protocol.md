# Scrum Kanban & Sub-Agent Knowledge Transfer Protocol

## 1. System Overview & Standing Rules
This document defines the **Scrum Kanban Governance & Handover Protocol** for this project.
These rules are standing operating procedures for all engineering sessions, the coordinator agent, and all sub-agents.

The protocol is **provider-agnostic**. Claude Code, Gemini CLI, Codex, opencode, and any other agent that reads `AGENTS.md` follow the same steps. Nothing in the core flow needs subagents, worktrees, or a specific model family. Provider-specific extras (Claude Code hooks, the Claude `ticket-worker` subagent) are optional helpers.

### 1.1. Roles
| Role | Tier | Job |
|---|---|---|
| **Coordinator** | `large` (main session) | Grooms tickets, writes grooming handovers, runs or dispatches the worker, reviews results, talks to the user. |
| **Worker** | `ticket.model` | Executes one groomed ticket with the Worker Procedure (section 6.5). Does not groom, re-scope, or start other tickets. |

The saving comes from doing the expensive exploration **once**, during grooming, and handing the result to the worker. The worker can run on a cheaper tier. A worker that has to rediscover the code wastes that saving. Sections 3 and 6 exist to prevent this.

### 1.2. Model Tiers
Tickets name a tier, not a model. Each agent maps the tier to the models its provider offers. Model names change often, so the tier is the contract. The examples below are a guide.

| Tier | Use for | Claude | Gemini | OpenAI / Codex |
|---|---|---|---|---|
| `small` | 1–2 pt mechanical work | Haiku | Flash / Flash-Lite | mini models |
| `medium` | Default | Sonnet | Pro or Flash | standard models |
| `large` | Design-heavy or high-risk work, coordination | Opus | Pro | top reasoning models |

If a provider cannot switch models inside one session, the worker runs on the session's model. The tier then records the intended effort for review.

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
| `model` | Worker tier (section 1.2): `medium` by default, `small` for 1–2 pt mechanical work, `large` only for design-heavy or high-risk work. |
| `context.files` | Files the worker will read or change. |
| `context.symbols` | Functions, classes, or methods involved. (`files` or `symbols` required.) |
| `context.entry_points` | Where the flow starts (route, command, handler). Optional. |
| `context.codegraph_queries` | Ready-made `codegraph_explore` queries that return the relevant source. Required when the repository has a CodeGraph index. |
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
- **At most `wip_limit` (1) ticket is `IN_PROGRESS` on the whole board**, whichever agent holds it. `assignee` names that agent (for example `claude`, `gemini`, `codex`).
- All work happens in the main checkout. There are no parallel workers and no worktrees.
- WIP 1 is not about speed. Serial work in one checkout is the one model that every AI provider supports: no subagents, no worktree isolation, and no file-locking between agents. It also lets different providers take turns on the same board.
- `render-board.mjs` enforces the limit and requires an `assignee` on the active ticket.

### 5.2. Interruption & Task-Switching Protocol
If a worker, the coordinator, or the user wants to start a new ticket while another ticket is `IN_PROGRESS`:
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
- **Board first, work second.** Every agent and subagent claims its ticket (`status: IN_PROGRESS`, `assignee` set) and regenerates `BOARD.md` **before** it reads code, edits files, or runs commands for that ticket. `BOARD.md` must show what agents are working on while the work happens, not after it finishes. Every later status change (`PAUSED`, `REVIEW`, `DONE`, `ABANDONED`) is rendered the moment it happens.
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

### 6.3.1. Running the Worker
- **Any provider:** the coordinator runs the Worker Procedure (section 6.5) itself, in the same session. If the provider can switch models, it switches to the ticket's tier first.
- **Claude Code (optional):** dispatch the Agent tool with `subagent_type: "ticket-worker"` and `model` mapped from the tier (`small`→`haiku`, `medium`→`sonnet`, `large`→`opus`). Prompt: ticket ID and worker name. Dispatch one worker at a time. Never use `isolation: "worktree"`.

### 6.3.2. Review
At `REVIEW` the coordinator reads the worker's `PROGRESS` entry and `git diff` of `context.files`, reruns `verify_cmd`, and checks each `acceptance` item. It does not re-explore the code.

### 6.4. Handover Index
`docs/kanban/handovers/HANDOVERS.md` lists every `FLAG` entry that is still open, one line each: target ID, source ID, one-line summary. The coordinator removes a line when the target ticket is `DONE` or `ABANDONED`.

### 6.5. Worker Procedure
Any agent that executes a ticket follows these steps, whatever its provider. The coordinator already explored the code during grooming and wrote down what it found. The worker uses that work and does not repeat it.

1. **Load the ticket.** Read its record in `board.json`. If `context`, `acceptance`, or `model` is missing, stop and report "ticket is not groomed". Do not groom it.
2. **Check prerequisites.** Every ID in `requires` must be `DONE`. If not, stop and report which ones are not.
3. **Read handovers** in the order of section 6.3. Skip files that do not exist. Follow `FLAG` entries: they are warnings from other agents about this ticket.
4. **Claim the ticket.** In `board.json`, set `status` to `IN_PROGRESS` and `assignee` to the worker name. Run `node scripts/kanban/render-board.mjs`. If it fails with a WIP error, undo the change and stop.
5. **Load the code with CodeGraph first** (section 7). Run each query in `context.codegraph_queries` with the `codegraph_explore` MCP tool, or with `codegraph explore "<query>"` in the shell when MCP is not available. Treat the returned source as already read. Before an edit, read only the line range you change. If there is no `.codegraph/` directory, start from `context.files`.
6. **Implement.** Change only what the acceptance criteria need. Stay inside `context.files` where possible. If you must change a file that is not listed, add it to `context.files` and say why in the `PROGRESS` entry.
7. **Verify.** Run `verify_cmd`. Check every item in `acceptance`. Fix failures. Do not weaken or skip tests.
8. **Flag other tickets.** If you find something that affects a different ticket, story, or epic, append a `FLAG` entry to that note file (section 6.2) and add one line to `HANDOVERS.md`. Do not work on the other ticket.
9. **Hand over.** Append a `PROGRESS` entry to `handovers/<TICKET-ID>.md` using `_TEMPLATE.md`. Include any new CodeGraph queries that helped. Set `status` to `REVIEW`, or to `PAUSED` if you could not finish. Clear `assignee`. Run `render-board.mjs`.
10. **Report** to the coordinator or the user in 10 lines or fewer: status, files changed, `verify_cmd` result, flags raised, open questions.

Hard rules:
- One ticket only. Never start, groom, or re-estimate another ticket.
- Never commit, push, or open PRs. The coordinator does that after the user confirms.
- Never edit `BOARD.md` by hand. It is generated.
- Board first, work second (section 6.1). Claim the ticket (step 4) before you load code, edit files, or run commands.
- Never delete handover entries. Only append.
- If the ticket is wrong or too large (for example, it needs 13+ points of work), set it to `PAUSED`, explain in `PROGRESS`, and stop.

---

## 7. Code Exploration: CodeGraph First

Agents use CodeGraph before Grep, Glob, or reading whole files, when the repository has a `.codegraph/` index.

1. **Start from the ticket.** Run the `context.codegraph_queries` from the ticket first. They were checked during grooming.
2. **Then explore.** Call `codegraph_explore` with `projectPath` set to the repository root, naming the symbols or files from `context`.
3. **Grep, Glob, and shell search are a fallback.** Use them only for non-code text (config values, string literals, log messages) or when CodeGraph returns nothing. In Claude Code, a `PreToolUse` hook denies the first code search per agent (Grep, Glob, whole-file Read of source, `grep`/`rg`/`find`/`cat`/`Select-String`/`Get-Content` in Bash or PowerShell) until CodeGraph is used.
4. **Ranged Read before Edit.** Edit needs a prior Read. Read only the lines you change, using the line numbers CodeGraph returned.
5. **Freshness.** A daemon file watcher re-indexes saved files within about 1 second while a session is open (it stops after 5 idle minutes). `SessionStart` and git hooks run `codegraph sync -q` to cover pulls, branch switches, and offline edits. If results look stale, run `codegraph sync` and retry.
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
- **Target Branch**: PRs **always** target `develop`. Never open PRs against any other branch.

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
The script checks: duplicate IDs, unknown references, Fibonacci points, the Definition of Groomed (3.1, including `codegraph_queries`, `verify_cmd`, and the `GROOMING` entry), missing handover files, prerequisites, model tiers (1.2), the WIP limit (5.1), and story points against the sum of task points.
