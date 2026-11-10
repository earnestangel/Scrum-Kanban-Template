<!-- scrum-kanban:start -->
## Scrum Kanban Governance & Standing Operating Rules
All agents and subagents follow the **Scrum Kanban Protocol** in [docs/kanban/protocol.md](docs/kanban/protocol.md). Summary:

### 1.1. Agent Invariants
These are hard lines for every agent, on every provider (protocol section 1.3).

**Every agent MUST NOT:**
- Start a ticket that is not a groomed `TODO` with every `requires` ticket `DONE`, or one that `ticket.mjs claim` refuses.
- Let a second ticket be `IN_PROGRESS`.
- Read code, edit files, or run commands for a ticket before claiming it on the board.
- Edit `board.json`, `board-archive.json`, `design.json`, `BOARD.md`, or a handover note by hand, or delete handover entries. Every board change goes through `node scripts/kanban/ticket.mjs`, which stamps the time, agent, role, model, and tier (protocol section 6.1). All times come from it; no agent passes or writes a time.
- Weaken, skip, or delete tests to make `verify_cmd` pass.
- Search code before running the ticket's `context.codegraph_queries`, when `.codegraph/` exists.
- Commit, push, or open PRs without the user's confirmation. Workers never do.
- Execute a ticket on a model tier other than the ticket's `model`, unless the user approved it for that ticket.
- Pick a tier by judgment. The standing tier rule decides it: Story or Epic `large`, 1 pt `small`, every other ticket `medium` (protocol section 1.2). Only the user may write a `tier_override` or edit `docs/kanban/tiers.json`.
- Groom, review, or update the board as coordinator on a model not listed for `large` in `docs/kanban/tiers.json`.
- Pass `ticket.mjs` a `--model` other than the model it really runs on, or set the user switches `KANBAN_INLINE`, `KANBAN_ALLOW_TIER_EDIT`, `KANBAN_ALLOW_MANUAL_EDIT`, `KANBAN_ALLOW_ADR_ACCEPT`, `KANBAN_DELEGATE`.
- Set the status or points of an epic, or of a story that has children. They are derived from the children (protocol section 4.1).
- Build something other than the design, or leave part of it out, without an ADR the user accepted. Only the user accepts an ADR (protocol section 10.4).
- Keep a project fact only in a provider's private memory. Project facts go into the findings folder, indexed in `docs/kanban/KNOWLEDGE.md` with `ticket.mjs finding`. Provider memory holds the user's preferences only (protocol section 6.7).

**The coordinator MUST NOT:**
- Execute a ticket itself. It dispatches a worker on the ticket's tier (protocol section 6.3.1), whatever its own model is. Exception: a 1 point mechanical chore may be done by a script or inline by the coordinator, recorded with `ticket.mjs claim` and `handover`.
- Edit files outside `docs/kanban/` and the `coordinator_paths` globs in `board.json` while a ticket is `IN_PROGRESS`.

**The coordinator MUST:**
- Keep `board.json` authoritative and `BOARD.md` rendered.
- Groom a ticket before it enters `TODO`.
- Reconcile orphaned `IN_PROGRESS` claims at session start (protocol section 5.3).
- Resolve or escalate every `BLOCKED` ticket.
- Check the Definition of Done (protocol section 3.3) before it sets `DONE`.
- Keep the `STATE` block of every open epic and story true with `ticket.mjs state`, and refresh the epic's before each story under it closes (protocol section 6.2.1).
- Record everything that waits on the user with `ticket.mjs decision` (protocol section 5.4).
- Check each ticket against the design sources at grooming and at review, once the board declares them (protocol section 10).
- Stop and ask the user when an Epic or Story completes.

### 1.2. Roles
The workflow is provider-agnostic. Claude Code, Gemini CLI, Codex, opencode, and any other agent that reads `AGENTS.md` run the same steps.

- **Coordinator** (main session, strongest available model): grooms tickets, writes `GROOMING` handovers, dispatches the worker, reviews, talks to the user. It never executes a ticket.
- **Worker**: executes one groomed ticket with the **Worker Procedure** (protocol section 6.5), on a model listed for the ticket's tier in `docs/kanban/tiers.json`, one at a time, in the main checkout with no worktree. How to start it on each provider: protocol section 6.3.1 and [docs/kanban/providers.md](docs/kanban/providers.md).
  - Claude Code: Agent tool, `subagent_type: "ticket-worker"`, `model` = an alias that resolves to a model listed for the tier (default `haiku` small, `sonnet` medium, `opus` large). A hook denies other dispatches.
  - Gemini CLI, Codex, opencode, others: a subagent or a headless run of the CLI on a model listed for the tier, with the worker prompt from protocol section 6.3.1.
  - No way to change the model: stop and ask the user to run the worker prompt in a new session on a listed model. Run it inline only when the user sets `KANBAN_INLINE=<ID>`.
- **Board commands**: change the board only with `node scripts/kanban/ticket.mjs`. Coordinator: `create`, `groom`, `edit`, `status`, `note --type GROOMING` (`--edit <n>` / `--delete <n> --reason` / `--supersedes <n>`), `state`, `review`, `close`, `archive`, `recover`, `decision`, `design`, `element`. Worker: `context`, `claim`, `handover`, `note --type FLAG`, `finding`. Anyone: `show`, `stats`. It writes canonical handover headers, stamps `updated_at`, `last_actor`, and `claims`, and checks the tier. A hook denies hand edits of the board files, and the git `pre-commit` check rejects a board file that `ticket.mjs` did not write.

### 1.3. WIP Limit & Escalation
- At most **one** ticket is `IN_PROGRESS` on the whole board (`wip_limit` in `board.json`). The work is serial by design, so every AI provider can run it in one checkout.
- To start a ticket while another is active: **stop and ask the user** whether to `PAUSE` or `ABANDON` the active one.
- A worker that cannot go on (missing dependency, failure outside its files, unclear or conflicting acceptance, ticket too large) sets `BLOCKED` with a `blocked_reason` and a `PROGRESS · … · BLOCKED` entry, then stops. `BLOCKED` frees the WIP slot. The coordinator resolves it or asks the user.
- At session start, if a ticket is `IN_PROGRESS` and this session did not claim it, ask the user whether its agent is still running. If not, record the leftover edits and set it to `PAUSED` (protocol section 5.3).
- Every session starts with `node scripts/kanban/render-board.mjs --check`. It prints the session brief: what waits on the user (`decisions_pending`), ADRs that are not accepted, stories and epics ready to close, and design files that changed. Tell the user what waits on them before new work (protocol sections 5.3, 5.4).

### 1.4. Grooming, Review, Done
- Fibonacci points (1, 2, 3, 5, 8, 13, 21) for every ticket a worker executes. 13+ must be split. Nothing leaves `BACKLOG` without an estimate. An epic, and a story with children, is not estimated: its points are the sum of its children and its status follows them (protocol section 4.1).
- `order` says which ticket goes first. Do not add a `requires` link only to say "later" (protocol section 4.2).
- Grooming checks every constant or default it states against the code. Shared touch points (registries, lists in tests) go into the first Task of a Story; later Tasks list disjoint files (protocol section 3).
- `model` is a provider-neutral tier set by the standing tier rule, not chosen: Story or Epic `large` (Claude Opus), 1 pt `small` (Claude Haiku), every other ticket `medium` (Claude Sonnet). `docs/kanban/tiers.json` lists which model IDs count as each tier in this project. Only the user changes a tier (`tier_override`) or the map (`tiers.json`).
- A ticket enters `TODO` only when it has `model`, `context` (files, symbols, and codegraph_queries when CodeGraph is installed), `acceptance`, `verify_cmd`, a `GROOMING` handover entry, and, once the board declares design sources, a design link: `design.refs` or `design.na` with the reason (protocol sections 3.1, 10.3).
- A ticket enters `REVIEW` only when `verify_cmd` passes, every `acceptance` item is met, every `FLAG` on it is addressed in a `PROGRESS · … · REVIEW` entry, and that entry has a **Design check** section when the board declares design sources (protocol sections 3.2, 10.6).
- A ticket enters `DONE` only after the coordinator reruns `verify_cmd`, checks acceptance against the diff, writes a `REVIEW · … · DONE` entry (with a **Design** line when the board declares design sources), and removes its `HANDOVERS.md` rows (protocol section 3.3).
- A story or epic with children closes with `ticket.mjs close`, when every child is closed. The entry needs a **Knowledge** line: the findings written, or `none` (protocol sections 4.1, 6.7).

### 1.5. Handover Notes
- `docs/kanban/handovers/<ID>.md` is an append-only log per ticket, story, or epic. Template: `_TEMPLATE.md`. Epic and story notes start with a `STATE` block: what is true now. It is the only part that is rewritten (`ticket.mjs state`).
- An entry that no longer holds is superseded, not deleted: `ticket.mjs note <ID> --type GROOMING --supersedes <n>` marks it `(SUPERSEDED)`.
- Entry types: `GROOMING` (coordinator), `PROGRESS` (worker, on PAUSED/BLOCKED/REVIEW/ABANDONED), `REVIEW` (coordinator, DONE or REWORK), `FLAG` (any agent, written into the **target** ticket's note, and indexed in `HANDOVERS.md`).
- Before starting work, run `node scripts/kanban/ticket.mjs context <ID>` and read its output: the ticket, what waits on the user, its design elements, the knowledge index, the epic and story `STATE`, the live entries of its notes, and the last `PROGRESS` entry of each `requires` ticket (protocol section 6.3).

### 1.6. Board Files
- `docs/kanban/board.json` is the only source of truth.
- `docs/kanban/BOARD.md` is generated. Every `ticket.mjs` command renders it. Never edit `BOARD.md` by hand.
- `docs/kanban/board-archive.json` and `handovers/archive/` hold closed tickets that `ticket.mjs archive` moved off the board. `docs/kanban/design.json` is the design ledger. `docs/kanban/KNOWLEDGE.md` indexes the project's findings.
- **Board first, work second.** Every agent and subagent claims its ticket with `node scripts/kanban/ticket.mjs claim <ID> --worker <name> --model <model-id>` (sets `IN_PROGRESS`, `assignee`, `claimed_at`, `worker_model`, and regenerates `BOARD.md`) **before** it reads code, edits files, or runs commands for that ticket. Humans must see what agents are working on while the work happens, not after. Every later status change is rendered the moment it happens.

### 1.7. Git & PRs
- Branches `feature/|fix/|chore/<TICKET-ID>-<slug>`, PRs target `develop`.
- When an Epic or Story completes, **stop and ask the user** before committing, pushing, or opening a PR. Workers never commit or push.

---

## 2. Documentation Catalog
- docs/kanban/protocol.md — Full governance & knowledge transfer protocol.
- docs/kanban/providers.md — Running the workflow on any tool or model (Claude Code with LiteLLM/Bedrock, Codex, Gemini, opencode, others), `ticket.mjs` commands, user switches.
- docs/kanban/tiers.json — Which model IDs count as each tier. User-owned.
- docs/kanban/board.json — Ticket registry (source of truth). `_ticket_template` shows every field.
- docs/kanban/KNOWLEDGE.md — One line per project finding. Required reading.
- docs/kanban/design.json — Design ledger: one row per design element (when the board declares design sources).
- docs/kanban/BOARD.md — Generated human-readable board.
- docs/kanban/handovers/ — Handover notes, `_TEMPLATE.md`, and `HANDOVERS.md` (open flags).
- [Scrum-Kanban-Template README](https://github.com/earnestangel/Scrum-Kanban-Template#readme) — Setup, upgrade, CodeGraph install, hooks.

<!-- scrum-kanban:end -->

<!-- CODEGRAPH_START -->
## 3. CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. Pass `projectPath` = repository root. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.
- On a ticket, run **all** of its `context.codegraph_queries` before any other code search. This applies on every provider. Use Grep/Glob/shell search on code only when CodeGraph returns nothing. In Claude Code, a hook also denies the first code search per agent until CodeGraph is used, as a safety net.
- Text that is not code (Markdown, ADRs, handover notes, JSON, YAML, anything under `docs/`) is read directly. CodeGraph indexes symbols; it does not help there, and the hook does not fire on it.
- Before Edit, Read only the needed line range (`offset`/`limit`), not the whole file.
- The index re-syncs on save while a daemon runs; hooks sync at session start and after git checkout/merge/rebase. If results look stale, run `codegraph sync` and retry.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
