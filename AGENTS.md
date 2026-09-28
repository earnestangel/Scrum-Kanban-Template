## Scrum Kanban Governance & Standing Operating Rules
All agents and subagents follow the **Scrum Kanban Protocol** in [docs/kanban/protocol.md](docs/kanban/protocol.md). Summary:

### 1.1. Roles
- **Coordinator** (Opus, main session): grooms tickets, writes `GROOMING` handovers, dispatches workers, reviews, talks to the user.
- **Worker** (Sonnet, `.claude/agents/ticket-worker.md`): executes one groomed ticket. Dispatch with the Agent tool, `subagent_type: "ticket-worker"`; pass `model: <ticket.model>`; use `isolation: "worktree"` when workers run in parallel. Workers write `board.json` and `handovers/` in the main checkout, never the worktree copy.

### 1.2. WIP Limits
- Each worker holds at most **one** ticket in `IN_PROGRESS`. At most `max_parallel_workers` (in `board.json`) workers run at once.
- Two `IN_PROGRESS` tickets must never share a file in `context.files`.
- To start a ticket while the same worker has one active: **stop and ask the user** whether to `PAUSE` or `ABANDON` the active one.

### 1.3. Grooming
- Fibonacci points (1, 2, 3, 5, 8, 13, 21). 13+ must be split. Nothing leaves `BACKLOG` without an estimate.
- A ticket enters `TODO` only when it has `model`, `context` (files, symbols, codegraph_queries), `acceptance`, `verify_cmd`, and a `GROOMING` handover entry (protocol section 3.1).

### 1.4. Handover Notes
- `docs/kanban/handovers/<ID>.md` is an append-only log per ticket, story, or epic. Template: `_TEMPLATE.md`.
- Entry types: `GROOMING` (coordinator), `PROGRESS` (worker, on PAUSED/REVIEW/DONE/ABANDONED), `FLAG` (any agent, written into the **target** ticket's note, and indexed in `HANDOVERS.md`).
- Before starting work, read the epic note, the story note, every note in the ticket's `handovers` field, then the last `PROGRESS` entry of each `requires` ticket.

### 1.5. Board Files
- `docs/kanban/board.json` is the only source of truth.
- `docs/kanban/BOARD.md` is generated. After every `board.json` change, run `node scripts/kanban/render-board.mjs`. Never edit `BOARD.md` by hand.

### 1.6. Git & PRs
- Branches `feature/|fix/|chore/<TICKET-ID>-<slug>`, PRs target `develop`.
- When an Epic or Story completes, **stop and ask the user** before committing, pushing, or opening a PR. Workers never commit or push.

---

## 2. Documentation Catalog
- docs/kanban/protocol.md — Full governance & knowledge transfer protocol.
- docs/kanban/board.json — Ticket registry (source of truth). `_ticket_template` shows every field.
- docs/kanban/BOARD.md — Generated human-readable board.
- docs/kanban/handovers/ — Handover notes, `_TEMPLATE.md`, and `HANDOVERS.md` (open flags).
- README.md — Setup: CodeGraph install, hooks, git hooks.

<!-- CODEGRAPH_START -->
## 3. CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. Pass `projectPath` = repository root. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.
- On a ticket, run its `context.codegraph_queries` first. Use Grep/Glob/shell search only for non-code text or when CodeGraph returns nothing. A hook denies the first code search per agent until CodeGraph is used.
- Before Edit, Read only the needed line range (`offset`/`limit`), not the whole file.
- The index re-syncs on save while a daemon runs; hooks sync at session start and after git checkout/merge/rebase. If results look stale, run `codegraph sync` and retry.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
