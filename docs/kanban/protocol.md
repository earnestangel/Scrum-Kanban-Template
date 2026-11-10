# Scrum Kanban & Sub-Agent Knowledge Transfer Protocol

## 1. System Overview & Standing Rules
This document defines the **Scrum Kanban Governance & Handover Protocol** for this project.
These rules are standing operating procedures for all engineering sessions, the coordinator agent, and all sub-agents.

The protocol is **provider-agnostic**. Claude Code, Gemini CLI, Codex, opencode, and any other agent that reads `AGENTS.md` follow the same steps. Nothing in the core flow needs worktrees or a specific model family. Each provider runs the worker on the ticket's tier with the mechanism it has (section 6.3.1). Provider-specific extras, such as Claude Code hooks, enforce the rules where the provider allows it.

### 1.1. Roles
| Role | Tier | Job |
|---|---|---|
| **Coordinator** | `large` (main session) | Grooms tickets, writes grooming handovers, dispatches the worker, reviews results, talks to the user. Never executes a ticket itself (section 6.3.1). |
| **Worker** | `ticket.model` | Executes one groomed ticket with the Worker Procedure (section 6.5). Does not groom, re-scope, or start other tickets. |

The saving comes from doing the expensive exploration **once**, during grooming, and handing the result to the worker. The worker can run on a cheaper tier. A worker that has to rediscover the code wastes that saving. Sections 3 and 6 exist to prevent this.

### 1.2. Model Tiers
Tickets name a tier, not a model. Model names change often, so the tier is the contract. The model columns below are a guide. **`docs/kanban/tiers.json`** is the project's binding map: it lists the model IDs that count as each tier (patterns, for example `"medium": ["*sonnet*", "*gpt-6-luna*"]`). Without the file, Claude models only: `*opus*`, `*sonnet*`, `*haiku*`. **Only the user** edits `tiers.json`. Setup per tool and gateway (LiteLLM, Bedrock, Codex, Gemini, opencode, others): [providers.md](providers.md).

**Standing tier rule.** The tier follows from the ticket. Grooming does not choose it, and no agent may negotiate it, for any provider:

| Tier | Ticket | Claude | Gemini | OpenAI / Codex |
|---|---|---|---|---|
| `large` | Every Story and Epic (grooming them, and executing a Story that has no Tasks). Also the coordinator. | Opus | Pro | top reasoning models |
| `medium` | Every Task, Bug, and Chore of 2 or more points | Sonnet | Pro or Flash | standard models |
| `small` | Every Task, Bug, and Chore of 1 point | Haiku | Flash / Flash-Lite | mini models |

Design risk, security impact, or difficulty never raise a ticket's tier. If a Task feels too hard for its tier, split it or groom it with more context. **Only the user** may set another tier, for one ticket, by adding `"tier_override": { "tier": "<tier>", "reason": "<the user's words>" }` to its record. An agent may propose an override in chat, but never writes one. `scripts/kanban/tier-policy.mjs` holds the rule; `render-board.mjs` rejects a ticket whose `model` breaks it.

The worker runs on the ticket's tier, not on the coordinator's model. A `large` coordinator that executes a `small` ticket spends the most expensive tokens on the cheapest work, and fills its own context with code it does not need for review. Section 6.3.1 lists how each provider runs a worker on the right tier.

### 1.3. Agent Invariants
These are hard lines. `AGENTS.md` repeats them, so every provider loads them.

**Every agent MUST NOT:**
- Start a ticket that is not a groomed `TODO` (section 3.1) with every `requires` ticket `DONE`, or one that `ticket.mjs claim` refuses (an ADR that is not accepted, an open user decision, a changed design file, a missing `STATE` block, a lower `order` that can start).
- Let a second ticket be `IN_PROGRESS` (section 5.1).
- Read code, edit files, or run commands for a ticket before claiming it on the board (section 6.1).
- Delete handover entries (section 6.2).
- Weaken, skip, or delete tests to make `verify_cmd` pass.
- Search code before running the ticket's `context.codegraph_queries`, when `.codegraph/` exists (section 7).
- Commit, push, or open PRs without the user's confirmation. Workers never do.
- Execute a ticket on a model tier other than the ticket's `model`, unless the user approved it for that ticket (section 6.3.1).
- Set a ticket's `model` to a tier other than the standing tier rule requires, write a `tier_override`, or edit `docs/kanban/tiers.json` (section 1.2). Only the user does.
- Pass a `--model` to `ticket.mjs` other than the model it really runs on, or set the user switches `KANBAN_INLINE`, `KANBAN_ALLOW_TIER_EDIT`, `KANBAN_ALLOW_MANUAL_EDIT`, or `KANBAN_DELEGATE` ([providers.md section 11](providers.md#11-user-switches)).
- Edit `board.json`, `board-archive.json`, `design.json`, `BOARD.md`, or a handover note by hand, with any tool or shell command. Every board change goes through `scripts/kanban/ticket.mjs`, which stamps it with the time, agent, role, model, and tier (section 6.1).
- Write a time into the board or a note. All times come from `ticket.mjs`, which reads the machine clock (section 6.1).
- Groom, review, or update the board as coordinator on a model not listed for `large` in `tiers.json` (section 1.1).
- Set the status or the points of an epic, or of a story that has children. They are derived (section 4.1).
- Build something other than the design, or leave part of it out, without an ADR the user accepted (section 10.4). Set an ADR to accepted, or set `KANBAN_ALLOW_ADR_ACCEPT`. Only the user accepts an ADR.
- Keep a project fact only in a provider's private memory. Project facts go into the findings folder and `KNOWLEDGE.md` (section 6.7). Provider memory holds the user's preferences only.

**The coordinator MUST NOT:**
- Execute a ticket itself. It dispatches a worker on the ticket's tier (section 6.3.1). The one exception is a 1 point mechanical chore (section 6.3.1).
- Edit files outside `docs/kanban/` and `coordinator_paths` (section 6.1) while a ticket is `IN_PROGRESS`. That ticket's worker owns the checkout.

**The coordinator MUST:**
- Keep `board.json` authoritative and `BOARD.md` rendered.
- Groom a ticket before it enters `TODO`.
- Reconcile orphaned claims at session start (section 5.3).
- Resolve or escalate every `BLOCKED` ticket.
- Check the Definition of Done (section 3.3) before it sets `DONE`.
- Keep the `STATE` block of every open epic and story true (section 6.2.1), and refresh the epic's `STATE` before each story under it closes.
- Record everything that waits on the user with `ticket.mjs decision` (section 5.4), not in a note.
- Check every ticket against the design sources when it grooms and when it reviews (section 10), once the project has declared them.
- Stop and ask the user when an Epic or Story completes (section 8.2).

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

1. **Fibonacci Sequence**: Estimate every ticket a worker executes (Task, Chore, Bug, and a Story without children) in story points: **1, 2, 3, 5, 8, 13, 21**. An Epic, and a Story that has children, is not estimated: its points are the sum of its children (section 4.1).
   - **1–2 pts**: Configuration tweak, small documentation update, single isolated test.
   - **3–5 pts**: One service method or endpoint, a schema migration with its repository functions.
   - **8 pts**: Cross-cutting component that touches several modules.
   - **13+ pts**: Too large for one unit of work. Split it before `TODO`. The limit applies to each Task, Chore, Bug, and to a Story that has no Tasks. A Story split into Tasks is their sum, whatever that number is.
2. **Pre-Start Estimation Invariant**: No ticket leaves `BACKLOG` without an approved Fibonacci estimate.
3. **Grooming in Batches**: Groom tickets in clusters by parent Epic or Story.
4. **Check every constant against the code.** Every constant, default, limit, path, or name that a grooming entry or an `acceptance` item states is checked against the code before the ticket enters `TODO`, with the file and line it came from. A worker that finds a stated value wrong stops and sets `BLOCKED`; it does not guess.
5. **Shared touch points go in the first task.** When the Tasks of a Story touch the same shared file (a registry, an index, a list in a test, a config map), the first Task makes that change for all of them. Later Tasks list disjoint `context.files`, so a rework of one Task never collides with another.

The coordinator creates and grooms tickets with `ticket.mjs` (section 6.1): `create` adds a `BACKLOG` ticket with the next free ID, and `groom` sets the fields below and the tier the rule requires, writes the `GROOMING` entry, and moves the ticket to `TODO` once the Definition of Groomed passes. Until then it stays in `BACKLOG` and the command lists what is missing.

### 3.1. Definition of Groomed
A ticket may enter `TODO` only when its `board.json` record has all of these fields and its own note has a dated `## GROOMING ·` entry. `scripts/kanban/render-board.mjs` rejects the board otherwise.

| Field | Content |
|---|---|
| `points` | Fibonacci estimate. |
| `model` | Worker tier from the standing tier rule (section 1.2): `large` for a Story, `small` for 1 pt, `medium` otherwise. Only a user-written `tier_override` changes it. |
| `context.files` | Files the worker will read or change. |
| `context.symbols` | Functions, classes, or methods involved. (`files` or `symbols` required.) |
| `context.entry_points` | Where the flow starts (route, command, handler). Optional. |
| `context.codegraph_queries` | Ready-made `codegraph_explore` queries that return the relevant source. Required when the repository has a CodeGraph index. |
| `acceptance` | Observable results that prove the ticket is done. |
| `verify_cmd` | Command the worker runs to self-check (tests, typecheck, lint). |
| `handovers` | Handover note IDs the worker must read (see section 6). Must include the ticket's own ID. |
| `design` | `{ "refs": ["D-001"] }`: the design ledger elements the ticket implements, or `{ "na": "<reason>" }` when it implements none. Required once the board declares design sources (section 10.3). A Story with children needs it too. |
| `adrs` | ADR IDs the ticket depends on. Optional. The ticket cannot be claimed until the user accepted each one (section 10.4). |
| `order` | Position in the lane, a number. Optional. The lowest `order` that can start goes first (section 4.2). |

The coordinator gets `context` from the CodeGraph calls it makes during grooming. It records the queries that worked so the worker can repeat them instead of searching again.

### 3.2. Ready for Review
The worker sets `REVIEW` only when all of these are true:
- `verify_cmd` passes. The `PROGRESS` entry summarizes the output.
- Every `acceptance` item is met. The `PROGRESS` entry says how.
- Changes stay inside `context.files`, or each extra file is added to `context.files` and explained.
- Every `FLAG` entry that targets **this** ticket is addressed in the `PROGRESS` entry.
- When the board declares design sources: the `PROGRESS` entry has a **Design check** section (section 10.6). `ticket.mjs handover --status REVIEW` refuses a body without it.
- A `## PROGRESS · <date> · <worker> · REVIEW` entry is written and `BOARD.md` is rendered.

If any item cannot be met, the ticket is `BLOCKED` (section 5), not `REVIEW`. `render-board.mjs` rejects a `REVIEW` ticket without the `PROGRESS · … · REVIEW` entry.

### 3.3. Definition of Done
The coordinator sets `DONE` only when all of these are true:
- It re-ran `verify_cmd` itself, and the command passes.
- It checked each `acceptance` item against the diff.
- When the board declares design sources: it compared the result with the design sources of the ticket's `design.refs`, and its `REVIEW` entry has a **Design** line that says what it compared and the result (section 10.6). `ticket.mjs review` refuses a `DONE` body without it.
- For a Story, and when it closes a Story or an Epic with `ticket.mjs close`: the entry has a **Knowledge** line that names the findings written for it, or says `none` (section 6.7), and the epic's `STATE` block was refreshed since the last Story under it closed (section 6.2.1).
- It appended a `## REVIEW · <date> · <coordinator> · DONE` entry (section 6.2).
- It removed this ticket's rows from `HANDOVERS.md`.
- `BOARD.md` is rendered.

If review fails, the coordinator appends a `REVIEW · … · REWORK` entry that lists the issues, and sets the ticket back to `TODO`. `render-board.mjs` warns about a `DONE` ticket without a `REVIEW · … · DONE` entry, and about `HANDOVERS.md` rows that target closed tickets. `review` stamps `done_at`; a `REWORK` adds 1 to `rework_count` (section 6.1).

---

## 4. Ticket Relationships & Dependencies

Every ticket defines its relational graph:
- **`parent`**: The parent Story or Epic ID. Tasks use `parent`, not `story`.
- **`children`**: Sub-tickets belonging to this ticket.
- **`requires`**: Prerequisites that **must be `DONE`** before this ticket enters `IN_PROGRESS`.
- **`blocks`**: Dependent tickets that cannot start until this ticket is `DONE`.

### 4.1. Containers: derived status and points
An Epic that has children, and a Story that has children, is a **container**. Nobody sets its status or its points. `ticket.mjs` derives both from the children on every write, and `render-board.mjs` rejects a board where they differ.

| Field | Rule |
|---|---|
| `points` | The sum of the points of its children that are not `ABANDONED`. It is a sum, so it need not be a Fibonacci number. |
| `status` | `BACKLOG` while no child is groomed. `TODO` when a child is `TODO` and none has started. `IN_PROGRESS` once any child has started (`IN_PROGRESS`, `PAUSED`, `BLOCKED`, `REVIEW`, or `DONE`). `REVIEW` when every child is `DONE` or `ABANDONED`: it is ready to close. |
| `DONE` | Only the coordinator sets it, with `ticket.mjs close <ID>`, when the status is `REVIEW` (section 8.2). A new open child reopens the container. |
| `ABANDONED` | `ticket.mjs status <ID> --to ABANDONED --reason`, when every child is closed. |

- A container is never claimed and never holds the WIP slot. Its Tasks are claimed.
- A container needs no `context`, `acceptance`, or `verify_cmd`: its children carry them. Its note starts with a `STATE` block (section 6.2.1).
- A Story without children is a normal ticket: it has a Fibonacci estimate, a worker executes it, and `review` closes it.
- `estimate` is an optional number on a container: the estimate it had before it was split. It is information only.

### 4.2. Order
`order` is a number on a ticket. It says where the ticket stands in the lane. Use it to say "do these later". Do not add a `requires` link for that: `requires` is for a real dependency.

- Among the tickets that can start (`TODO` or `PAUSED`, every `requires` ticket `DONE`), the one with the lowest `order` goes first. Tickets without an `order` come after every ticket that has one.
- `ticket.mjs claim` refuses a ticket when another one with a lower `order` can start. The user may approve an exception: `claim --out-of-order "<the user's reason>"` records the reason in the claim.
- The coordinator sets it with `groom <ID> --order <n>` (`--order none` clears it). `BOARD.md` lists To Do in this order.

---

## 5. Board Statuses & WIP Limits

The board has 8 lifecycle states:
1. `BACKLOG`: Not yet groomed.
2. `TODO`: Groomed (section 3.1), estimated, ready to pick up once `requires` are `DONE`.
3. `IN_PROGRESS`: A worker is executing it. `assignee` and `claimed_at` are set. (A container is `IN_PROGRESS` while its children are worked; it has no assignee. See section 4.1.)
4. `PAUSED`: On hold by choice (section 5.2) or recovered from an orphaned claim (section 5.3). It can resume at any time. The handover note explains the current state.
5. `BLOCKED`: The worker cannot go on until something outside the ticket changes (see below).
6. `REVIEW`: Ready for Review (section 3.2). The coordinator reviews it. (A container is `REVIEW` when every child is closed: the coordinator asks the user, then closes it.)
7. `DONE`: Definition of Done met (section 3.3).
8. `ABANDONED`: Permanently closed. Effort spent and the reason are recorded.

**When a ticket is `BLOCKED`.** A worker sets `BLOCKED` instead of guessing or pushing on when:
- a dependency (service, library, credential, another ticket's output) is missing or broken;
- `verify_cmd` fails for a reason outside `context.files`;
- the acceptance criteria are unclear or conflict with each other or with the code;
- the ticket is wrong or too large (for example, 13+ points of work) and needs regrooming.

The worker appends a `PROGRESS · … · BLOCKED` entry with the unblock condition, sets `status: BLOCKED` and a one-line `blocked_reason`, clears `assignee` and `claimed_at`, renders the board, and stops. A `BLOCKED` ticket no longer counts against the WIP limit, so the board keeps moving.

The coordinator owns every `BLOCKED` ticket. It resolves the cause or asks the user. Then it moves the ticket with `ticket.mjs status <ID> --to TODO` (regroomed with `groom` if needed) or `--to ABANDONED --reason "<why>"`. Both clear `blocked_reason` and append an `AMEND` entry.

### 5.1. WIP Invariant
- **At most `wip_limit` (1) ticket is `IN_PROGRESS` on the whole board**, whichever agent holds it. Containers do not count (section 4.1). `assignee` names that agent (for example `claude`, `gemini`, `codex`).
- All work happens in the main checkout. There are no parallel workers and no worktrees.
- WIP 1 is not about speed. Serial work in one checkout is the one model that every AI provider supports: no subagents, no worktree isolation, and no file-locking between agents. It also lets different providers take turns on the same board.
- `render-board.mjs` enforces the limit and requires `assignee` and `claimed_at` on the active ticket.

### 5.2. Interruption & Task-Switching Protocol
If a worker, the coordinator, or the user wants to start a new ticket while another ticket is `IN_PROGRESS`:
1. **Stop.** Do not start the new ticket.
2. **Ask the user** what happens to the active ticket:
   - **`PAUSED`**: Put on hold. Write a `PROGRESS` handover note (section 6).
   - **`ABANDONED`**: Permanently retired with a recorded reason.
3. Only after that transition may the new ticket enter `IN_PROGRESS`.

### 5.3. Session Start & Recovery
A worker can die while it holds the only `IN_PROGRESS` slot: a crash, a closed terminal, a context reset, or a subagent that never returns. Under WIP 1 this stops the whole board. So at the start of every session, before it claims anything, the coordinator:
1. Runs `node scripts/kanban/render-board.mjs --check`. Its output names the active ticket, its `assignee` and `claimed_at`, and the count of `BLOCKED` tickets. It warns when a claim is more than 24 hours old. Then it prints the **session brief**: every entry of `decisions_pending` (section 5.4), every ADR that is not accepted and the tickets that wait for it (section 10.4), the containers that are ready to close, and every design source that changed (section 10.5). A changed design source is an error here: fix it before any other work.
2. If a ticket is `IN_PROGRESS` and this session did not claim it, **asks the user** whether that agent is still running. It does not decide from the timestamp alone.
3. If the claim is orphaned:
   - Runs `git status` and `git diff --stat` to see what the dead worker left.
   - Runs `node scripts/kanban/ticket.mjs recover <ID> --coordinator <name> --model <model-id>`. It appends a `## PROGRESS · <date> · <coordinator> · PAUSED` entry that starts with "Recovered from orphaned claim by `<assignee>`" and lists the uncommitted edits under **Files changed**, sets `status: PAUSED`, clears `assignee`, `claimed_at`, and `worker_model`, and renders the board.
   - Never discards or reverts the dead worker's edits. The next worker resumes from them and the `PROGRESS` entry.
4. Reviews `BLOCKED` tickets (section 5) before it starts new work.
5. Tells the user what the brief lists as waiting on them, before it starts new work.

### 5.4. What waits on the user
`decisions_pending` in `board.json` is the one list of open questions for the user. A question in a handover note is not on the list, so nobody finds it later.

- The coordinator adds an entry with `ticket.mjs decision new --question "<text>" --blocks <ID>... [--adr <ADR-ID>]`. Every entry names at least one ticket it blocks.
- `ticket.mjs claim` refuses a ticket that an entry blocks. An entry that blocks a Story or an Epic blocks every ticket under it.
- When the user answers, the coordinator runs `ticket.mjs decision <DEC-ID> --resolve "<the user's answer>"`. The entry leaves the list, and a `DECISION · … · RESOLVED` entry with the question and the answer goes into the note of each blocked ticket.
- `BOARD.md` shows the list at the top, under **Waiting on the user**, together with the ADRs that are not accepted and the containers that are ready to close. The session brief prints it (section 5.3).

---

## 6. Handover Notes & Knowledge Transfer

### 6.1. Canonical State Files
- `docs/kanban/board.json`: The only source of truth for tickets, states, estimates, dependencies, and context.
- `docs/kanban/board-archive.json` and `docs/kanban/handovers/archive/`: the full records and the notes of archived tickets (section 6.6). Written by `ticket.mjs archive` only.
- `docs/kanban/design.json`: the design ledger (section 10.2). Written by `ticket.mjs element` only.
- `docs/kanban/KNOWLEDGE.md`: one line per finding in the project's findings folder (section 6.7).
- `design_sources`, `adr`, `knowledge`, `decisions_pending`, and `size_limit_kb` in `board.json`: the design files and their hashes (section 10.1), where ADRs are and how their status line reads (section 10.4), where findings are (section 6.7), what waits on the user (section 5.4), and the size at which the board asks to be archived (section 6.6).
- `coordinator_paths` in `board.json`: path globs the coordinator may edit while a ticket is `IN_PROGRESS`, in addition to `docs/kanban/`. Example: `["CHANGELOG.md", "docs/adr/**", "notes/"]`. `**` spans directories, `*` and `?` stay inside one directory, and a trailing `/` covers a whole directory. Default `[]`. Add a path only with the user's agreement, and never a path that tickets change. The Claude Code hook reads this list; other providers follow it as a rule.
- `docs/kanban/BOARD.md`: **Generated** from `board.json`. Never edit it by hand. Every `ticket.mjs` command renders it; `node scripts/kanban/render-board.mjs` regenerates it.
- `scripts/kanban/board-server.mjs`: Read-only web view of `board.json` and the handover notes, for humans. It never changes the board.
- `scripts/kanban/ticket.mjs`: **the only way to change the board**, for every agent on every provider, and for humans too. Workers use `context`, `claim`, `handover`, `note --type FLAG`, and `finding`. The coordinator uses `create`, `groom`, `edit` (any field that is not state, with `--reason`), `status` (moves no other command makes, such as `ABANDONED` with `--reason`), `note --type GROOMING` (with `--edit <n>` or `--delete <n> --reason` to fix an entry, and `--supersedes` to mark an entry that no longer holds), `state`, `review`, `close`, `archive`, `recover`, `decision`, `design`, and `element`. `show` prints a ticket and `stats` prints the velocity. The commands change ticket state, write canonical entry headers, check the tier against `tiers.json`, and render the board, or change nothing if the board does not validate. Nobody edits `board.json`, `BOARD.md`, or a note by hand, or with a shell redirect. Commands: [providers.md section 3](providers.md#3-board-commands-ticketmjs).
- **Who touched what.** Every `ticket.mjs` write stamps the ticket: `updated_at`, `last_actor` `{ name, role: worker|coordinator, model, tier }`, and `created_at` on `create`. `claim` appends `{ worker, model, tier, claimed_at }` to `claims`; `handover` and `recover` close it with `released_at` and `outcome` (the new status). `render-board.mjs` validates these fields. The web board sorts and filters by them.
- **Velocity fields.** They stay on the ticket after it is `DONE`, and only `ticket.mjs` writes them: `started_at` (the first claim), `done_by` and `done_by_model` (the worker whose handover delivered it to `REVIEW`; for a container, the coordinator that closed it), `done_at` (the `DONE` review or the close), and `rework_count` (the number of `REWORK` reviews). `ticket.mjs stats [--days <n>] [--json]` reports points per day, median cycle time, and rework rate, in total and by tier; `BOARD.md` has a short table. Only leaf tickets count. A ticket migrated from an older board has `stamps_backfilled`: its start came from a note, not a claim, so it is left out of cycle time.
- **All times come from `ticket.mjs`.** It reads the machine clock and stores ISO 8601 UTC (`2026-10-23T15:52:42Z`), so times sort and compare. No agent passes a time or writes one by hand. The web board shows local time; `BOARD.md` shows UTC, so it renders the same on every machine.
- **Script writes are checked.** `ticket.mjs` records a hash of each board file it writes in `docs/kanban/.script-writes.json` (local, git-ignored). The git `pre-commit` hook fails on a staged `board.json` or note that differs from the last script write, unless the user commits with `KANBAN_ALLOW_MANUAL_EDIT=1`. Agents never set it.
- `docs/kanban/tiers.json`: which model IDs count as each tier (section 1.2). User-owned.
- **Board first, work second.** Every agent and subagent claims its ticket (`status: IN_PROGRESS`, `assignee` and `claimed_at` set) and regenerates `BOARD.md` **before** it reads code, edits files, or runs commands for that ticket. `BOARD.md` must show what agents are working on while the work happens, not after it finishes. Every later status change (`PAUSED`, `BLOCKED`, `REVIEW`, `DONE`, `ABANDONED`) is rendered the moment it happens.
- `docs/kanban/handovers/<ID>.md`: One note file per ticket, epic, or story. Template: `docs/kanban/handovers/_TEMPLATE.md`.

### 6.2. Note Entry Types
A note file is a log under one rewritable `STATE` block (section 6.2.1). Agents **append** dated entries with `ticket.mjs`; they never delete earlier entries. One correction is `note --type GROOMING --edit <n> | --delete <n> --reason "<why>"`: it rewrites grooming entry `n` (numbered 1..n in file order; `show` lists them) and appends an `AMEND` entry that keeps the old text. An entry that no longer holds is not deleted and not edited: a newer entry supersedes it (below). There are six entry types:

| Entry | Written by | When | Content |
|---|---|---|---|
| `GROOMING` | Coordinator | When the ticket enters `TODO` | Approach, relevant code found, pitfalls, what is out of scope. |
| `PROGRESS` | Worker (coordinator on recovery) | On `PAUSED`, `BLOCKED`, `REVIEW`, `ABANDONED` | Files changed, verification results, decisions, next steps. `BLOCKED` adds the unblock condition. |
| `REVIEW` | Coordinator | When it reviews a `REVIEW` ticket | `verify_cmd` rerun result, acceptance checklist, and the outcome `DONE` or `REWORK` with issues. |
| `FLAG` | Any agent | Any time it finds something that affects **another** ticket | What was found, where (file:line), and why it matters to that ticket. |
| `AMEND` | Coordinator, through `ticket.mjs` | On `edit`, `status`, and a grooming entry `--edit` or `--delete` | What changed (old and new values, or the old entry text), and the reason. The header ends in `EDITED`, `DELETED`, or the new status. |
| `DECISION` | Coordinator, through `ticket.mjs decision --resolve` | When the user answers an entry of `decisions_pending` | The question and the user's answer. The header ends in `RESOLVED`. |

**Superseding an entry.** When a later decision makes a `GROOMING` or `FLAG` entry wrong (for example an ADR brings into scope what the epic's first entry put out of scope), the coordinator writes the new entry with `ticket.mjs note <ID> --type GROOMING --supersedes [<NOTE-ID>#]<n>`. `<n>` is the entry's number in its note (`show <ID>` lists them); `<NOTE-ID>#` names another note. The old entry keeps its text; its header becomes `## GROOMING (SUPERSEDED) · …` and a line under it names the entry that replaced it. `PROGRESS`, `REVIEW`, and `AMEND` entries are history and are never superseded.

`FLAG` entries go into the **target** ticket's note file, not the author's. Example: while working on TASK-042, a worker finds that `UserRepo.save` has no transaction and TASK-050 will depend on it. The worker appends a `FLAG` entry to `handovers/TASK-050.md` (creating it from the template if needed) and adds a line to `HANDOVERS.md`. TASK-050 already lists its own note in `handovers`, so no `board.json` change is needed. If a finding applies to a whole story or epic, append it to that story's or epic's note file instead, and add that ID to the `handovers` field of every affected unstarted ticket. `--link <ID>` (repeatable) or `--link children` on the `note` command does that in the same step. `groom --handover <ID>` may name a ticket whose note does not exist yet; the command creates the empty note.

### 6.2.1. The STATE block
An append-only log goes stale: its first entry may say the opposite of its last. So the note of every Epic and Story starts with one `## STATE · <date> · <agent>` block. It says what is true **now**. It is the only part of a note that is rewritten.

- The coordinator writes it with `ticket.mjs state <EPIC|STORY> --body <file|->`. The command replaces the whole block; git keeps the earlier versions.
- It has four sections, and the command refuses a body without them: **Scope** (what is in and out now), **Order** (what comes next and why), **Decisions in force** (ADRs and user decisions that apply, by ID), **Open for the user** (a pointer to the `decisions_pending` entries; nothing else waits here).
- A Story adds a **Digest** section before its children are archived (section 6.6).
- `ticket.mjs claim` refuses a ticket while its Story or its Epic has no `STATE` block. `render-board.mjs` warns about every open container without one.
- A Story is closed (`review` for a Story without children, `close` for one with children) only when its Epic's `STATE` block is newer than the last Story that closed under that Epic. So the coordinator rereads and rewrites the Epic's `STATE` once per Story, while it still knows what changed.

### 6.3. Required Reading Before Work
Before starting a ticket, a worker runs `node scripts/kanban/ticket.mjs context <ID>` and reads its output from top to bottom. It is the whole reading pack in one bounded output (`--max-chars`, default 60000), in this order:
1. The ticket record.
2. What waits on the user for this ticket (section 5.4, 10.4). If this part is there, the ticket cannot be claimed.
3. The design elements in `design.refs`, with the path of each design source (section 10). The worker opens those files.
4. The knowledge index, `KNOWLEDGE.md` (section 6.7). The worker opens a finding when its line touches the work.
5. The `STATE` block of the Epic, then of the Story (section 6.2.1).
6. The entries that are not superseded or deleted: `GROOMING`, `FLAG`, and `DECISION` entries of the Epic's note, the Story's note, and every note in the ticket's `handovers` field, then every entry of the ticket's own note.
7. The last `PROGRESS` entry of every ticket in `requires`.

`STATE` comes before the entries, and superseded entries are left out, so a worker never has to work out which of two entries still holds. When the pack is over the size limit, the oldest inherited entries are left out first, and the pack says which note to open for them. Archived notes are read from `handovers/archive/`.

### 6.3.1. Running the Worker
The coordinator never runs the Worker Procedure (section 6.5) itself. It starts a separate worker on the model that the ticket's `model` tier maps to (section 1.2), one at a time, in the main checkout. This holds for every tier, `large` included: the worker gets a fresh context, and the coordinator keeps its context for grooming and review.

**Worker prompt.** Every provider uses the same prompt, so workers behave the same:

```text
Ticket: <TICKET-ID>. Worker name: <provider>-<tier>. Model ID: <model-id>.
You are the worker. Follow the Worker Procedure in docs/kanban/protocol.md section 6.5 and the Agent Invariants in section 1.3.
Change the board only with node scripts/kanban/ticket.mjs: context, claim, note --type FLAG, finding, handover. Never edit board.json, BOARD.md, or a note by hand.
```

The worker name (for example `claude-small`, `gemini-medium`, `codex-large`) goes into `assignee` and the `PROGRESS` entry header, so the review can check the tier.

**How to start the worker**, in order of preference:

| Provider | Mechanism |
|---|---|
| Claude Code | Agent tool, `subagent_type: "ticket-worker"`, `model` = an alias that resolves to a model listed for the tier (by default `small`→`haiku`, `medium`→`sonnet`, `large`→`opus`; with LiteLLM or another gateway, see [providers.md section 5](providers.md#5-claude-code-with-other-models-litellm-bedrock-vertex-gateways)). Never `isolation: "worktree"`. **Required.** A `PreToolUse` hook (`scripts/hooks/worker-delegation.mjs`) resolves the alias through `ANTHROPIC_DEFAULT_*_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`, and denies a dispatch whose model is not listed for the ticket's tier. It also denies: a claim from an agent whose real model (from its transcript) is not listed for the tier; coordinator commands (`create`, `groom`, `edit`, `status`, grooming notes, `review`, `recover`) from a subagent or from a main session whose model is not listed for `large`; a claim by the coordinator, except of a 1 point chore; any agent edit of `tiers.json`; hand edits and shell writes to `board.json`, `BOARD.md`, and the notes, for every agent; and coordinator edits outside `docs/kanban/` and `coordinator_paths` while a ticket is `IN_PROGRESS`. |
| Provider with subagents that take a model (for example opencode agents with `mode: "subagent"`) | Dispatch a subagent on the tier's model with the worker prompt. |
| Provider with a headless CLI (for example `gemini -m <model> -p "<prompt>"`, `codex exec -m <model> "<prompt>"`, `opencode run -m <provider/model> "<prompt>"`) | Run the CLI in the repository root on the tier's model with the worker prompt. The user decides which approval or sandbox flags the worker gets; ask before the first run. |
| Any other provider | **Hand off.** Stop. Tell the user the tier's model and the worker prompt, and ask them to run it in a new session on that model. Resume at review when they report back. |

**Inline execution** on the coordinator's model, or on any model not listed for the ticket's tier, is allowed only when the user approves it for that ticket, after being told the tier mismatch. The user grants it by starting the session with `KANBAN_INLINE=<TICKET-ID>`; `ticket.mjs claim` and the Claude Code hooks then accept the mismatch for that ticket only. Record the approval in the `PROGRESS` entry. Grooming, review, `tier_override`, and `tiers.json` stay protected. Resuming a ticket on another model: [providers.md section 10](providers.md#10-resuming-a-ticket-on-another-model).

**1 point mechanical chores** are the standing exception. A 1 point Chore whose work is mechanical (a version bump, a regenerated file, a rename, running a script) may be done by a script, or inline by the coordinator on its `large` model, without a worker. It is still recorded with `ticket.mjs`: the coordinator claims it (`claim <ID> --worker <its name> --model <its model>`; `claim` accepts a `large` model for a 1 point chore), does the work, and hands it over with a `PROGRESS` entry. The claim and `last_actor` record the role `coordinator`. Anything that needs judgment is not mechanical and goes to a worker.

### 6.3.2. Review
At `REVIEW` the coordinator reads the worker's `PROGRESS` entry and `git diff` of `context.files`, reruns `verify_cmd`, and checks each `acceptance` item. It checks that the `PROGRESS` entry header names a worker and model listed for the ticket's tier in `tiers.json`. A mismatch without recorded user approval goes into the `REVIEW` entry under **Worker tier**. It does not re-explore the code. It records the result in a `REVIEW` entry: `DONE` when the Definition of Done (section 3.3) is met, otherwise `REWORK` and the ticket goes back to `TODO`.

### 6.4. Handover Index
`docs/kanban/handovers/HANDOVERS.md` lists every `FLAG` entry that is still open, one line each: target ID, source ID, one-line summary. The coordinator removes a line when the target ticket is `DONE` or `ABANDONED`.

### 6.5. Worker Procedure
Any agent that executes a ticket follows these steps, whatever its provider. The coordinator already explored the code during grooming and wrote down what it found. The worker uses that work and does not repeat it.

1. **Load the ticket.** Run `node scripts/kanban/ticket.mjs context <ID>`. If `context`, `acceptance`, or `model` is missing in the record, stop and report "ticket is not groomed". Do not groom it.
2. **Check prerequisites.** Every ID in `requires` must be `DONE`. If not, stop and report which ones are not.
3. **Read the context pack** from step 1, top to bottom (section 6.3). Follow `FLAG` entries: they are warnings from other agents about this ticket. Open each design source the pack names (section 10.6). If the pack says the ticket waits on the user, stop and report it.
4. **Claim the ticket.** Run `node scripts/kanban/ticket.mjs claim <ID> --worker <worker name> --model <the model ID you run on>`. It sets `status` to `IN_PROGRESS`, `assignee`, `claimed_at` (ISO 8601 UTC), and `worker_model`, appends your claim to `claims`, stamps `last_actor`, and renders the board. It refuses when the WIP slot is taken, a `requires` ticket is not `DONE`, your model is not listed for the ticket's tier, an ADR it depends on is not accepted, a user decision blocks it, its design source changed, its Story or Epic has no `STATE` block, or a ticket with a lower `order` can start. On a refusal, stop and report it; do not work around it.
5. **Load the code with CodeGraph first** (section 7). Run **all** queries in `context.codegraph_queries` before any other code search, with the `codegraph_explore` MCP tool, or with `codegraph explore "<query>"` in the shell when MCP is not available. Treat the returned source as already read. Before an edit, read only the line range you change. If there is no `.codegraph/` directory, start from `context.files`.
6. **Implement.** Change only what the acceptance criteria need. Stay inside `context.files` where possible. If you must change a file that is not listed, add it to `context.files` and say why in the `PROGRESS` entry.
7. **Verify.** Run `verify_cmd`. Check every item in `acceptance`. Fix failures inside the ticket's scope. Do not weaken or skip tests. If a failure is outside the ticket's scope, the ticket is `BLOCKED` (step 9).
   When the ticket has `design.refs`, compare the result with each design source and write the **Design check** section (section 10.6). If the design cannot be built as drawn, the ticket is `BLOCKED`: do not build something else.
8. **Flag other tickets.** If you find something that affects a different ticket, story, or epic, run `node scripts/kanban/ticket.mjs note <TARGET-ID> --type FLAG --from <ID> --agent <worker name> --model <model ID> --summary "<one line>" --body <file|->`. It appends the `FLAG` entry to that note file (section 6.2) and the line to `HANDOVERS.md`. Do not work on the other ticket. If you learn a fact about the project that later tickets need (a trap, a path, a setup step), write it as a finding and index it: `node scripts/kanban/ticket.mjs finding <file> --summary "<one line>" --agent <worker name>` (section 6.7). Do not keep it in your provider's memory.
9. **Hand over.** Write the `PROGRESS` entry body from `_TEMPLATE.md` (no header line; the script writes it) and run `node scripts/kanban/ticket.mjs handover <ID> --status <STATUS> --body <file|->` (add `--reason "<text>"` for `BLOCKED`). Include any new CodeGraph queries that helped. Pick the status:
   - `REVIEW` when every Ready for Review item (section 3.2) is true;
   - `BLOCKED` when a blocker from section 5 stops you. Set `blocked_reason` and write the unblock condition;
   - `PAUSED` when you must stop for another reason and the work can resume as is.

   The command clears `assignee`, `claimed_at`, and `worker_model`, closes your claim, records you as `done_by` on a `REVIEW` handover, and renders the board.
10. **Report** to the coordinator or the user in 10 lines or fewer: status, files changed, `verify_cmd` result, flags raised, open questions.

The Agent Invariants (section 1.3) apply throughout. In addition: work on one ticket only, never groom or re-estimate another ticket, and never edit `board.json`, `BOARD.md`, or a note by hand; `context`, `claim`, `handover`, `note --type FLAG`, `finding`, and `show` are the worker's commands. If the ticket is wrong or too large, set it to `BLOCKED` and stop.

### 6.6. Archive
A board that keeps every closed ticket grows until agents cannot read it. `render-board.mjs` warns when `board.json` is larger than `size_limit_kb` (default 300) and names the Stories whose children can be archived.

1. The Story is `DONE` (closed with `close`).
2. The coordinator writes the **Digest** into the Story's `STATE` block with `ticket.mjs state <STORY>`: at most 40 lines that say what was built, which decisions were made, and which traps the next person must know. `archive` refuses a Story without it. The Digest is what stays in everyone's reading; the children's notes are still there, but nobody reads them by default.
3. `node scripts/kanban/ticket.mjs archive <STORY>` moves every `DONE` or `ABANDONED` child: the full record to `docs/kanban/board-archive.json`, the note to `docs/kanban/handovers/archive/`. A **stub** stays on the board with `"archived": true`: ID, title, status, points, parent, tier, order, design link, and the dates and velocity fields. So the Story still sums its children, `requires` links still resolve, and `stats` still counts them.
4. A closed Chore, Bug, or Story without children that is not under a Story is archived by its own ID.

An archived ticket does not change. `show`, `context`, and the web board still read it. Its ID stays taken (section 9.1).

### 6.7. Project knowledge
A fact about the project that the next ticket needs (how changes are applied, how identity is set up, a trap in the pipeline, a rule from the user about the design) lives in the repository, where every provider's agent reads it. It does not live in one provider's private memory on one machine. Provider memory holds the user's preferences only.

- Findings are Markdown files in the project's findings folder (`knowledge.dir` in `board.json`, default `docs/findings`), one topic per file.
- `docs/kanban/KNOWLEDGE.md` is the index: one line per finding, with a one-line summary. Any agent adds or replaces a line with `node scripts/kanban/ticket.mjs finding <file> --summary "<one line>" --agent <name>`.
- `render-board.mjs` rejects the board when a finding has no line in the index, or the index links a file that does not exist.
- The index is part of the required reading: `ticket.mjs context` prints it (section 6.3). The coordinator reads it before it grooms.
- The `REVIEW` entry that closes a Story or an Epic has a **Knowledge** line: the findings files written for it, or `Knowledge: none`. `ticket.mjs` refuses the entry without it, and refuses a file name that is not in the index.

---

## 7. Code Exploration: CodeGraph First

Agents use CodeGraph before Grep, Glob, or reading whole files, when the repository has a `.codegraph/` index.

1. **Start from the ticket.** Run **all** of the ticket's `context.codegraph_queries` before any other code search. They were checked during grooming. This rule applies on every provider. The Claude Code hook in step 3 is only a safety net.
2. **Then explore.** Call `codegraph_explore` with `projectPath` set to the repository root, naming the symbols or files from `context`.
3. **Grep, Glob, and shell search are a fallback for code.** Use them on code only when CodeGraph returns nothing. Text that is not code (Markdown, ADRs, handover notes, JSON, YAML, logs, anything under `docs/`) is read directly: CodeGraph indexes symbols and has nothing to say about it. In Claude Code, a `PreToolUse` hook denies the first **code** search per agent (Grep or Glob over code, whole-file Read of source, `grep`/`rg`/`find`/`cat`/`Select-String`/`Get-Content` on code in Bash or PowerShell) until CodeGraph is used. It does not fire on text that is not code.
4. **Ranged Read before Edit.** Edit needs a prior Read. Read only the lines you change, using the line numbers CodeGraph returned.
5. **Freshness.** A daemon file watcher re-indexes saved files within about 1 second while a session is open (it stops after 5 idle minutes). The Claude Code `SessionStart` hook and the git hooks start `codegraph sync -q` in the background to cover pulls, branch switches, and offline edits. If results look stale, run `codegraph sync` and retry.
6. **Record new queries.** If a worker needed a query that grooming did not provide, add it to the `PROGRESS` entry so later tickets can reuse it.
7. **No prompt injection.** The template installs no `UserPromptSubmit` hook. Code context reaches a worker through the ticket's `codegraph_queries`, which grooming checked, not through a guess from the prompt text.

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
- When an Epic or Story reaches `REVIEW` (every child is closed, section 4.1; `BOARD.md` and the session brief list it as ready to close), **stop and ask the user**:
  > *"Epic [EPIC-XXX: Title] is complete with all tests passing. Would you like me to commit, push the branch, and create a Pull Request to `develop` before we proceed to the next Epic?"*
- Wait for explicit confirmation before starting the next Epic.
- Close it with `node scripts/kanban/ticket.mjs close <ID> --body <file|->`. The body is a `REVIEW` entry: the rerun of the Story's checks, a **Design** line when the board declares design sources (section 10.6), and a **Knowledge** line (section 6.7). For a Story under an Epic, refresh the Epic's `STATE` block first (section 6.2.1).
- Workers never commit, push, or open PRs. The coordinator does this after user confirmation.

---

## 9. Board Rules & Ticket IDs

### 9.1. Ticket IDs Are Unique
- `ticket.mjs create <type>` picks the next free number for the type, in the width the board already uses (`TASK-007`, `BUG-0054`). `create <ID>` takes a full ID for projects with their own scheme (for example tasks numbered after their story) and refuses an ID that is on the board, in the archive, or has a note in `handovers/` or `handovers/archive/`. IDs are never reused, including IDs of `ABANDONED` tickets.
- `board.json` holds one record per ID. When a ticket is regroomed, change its record with `groom` or `edit` instead of creating a new one.
- Handover notes are named after the ticket ID, so a reused ID would overwrite another ticket's note.

### 9.2. Verifying the Board
Every `ticket.mjs` command validates and renders the board. To check it yourself, run:
```bash
node scripts/kanban/render-board.mjs          # validate and regenerate BOARD.md
node scripts/kanban/render-board.mjs --check  # validate only; fails if BOARD.md is stale
```
The script checks: duplicate IDs, unknown references, Fibonacci points, the Definition of Groomed (3.1, including `codegraph_queries`, `verify_cmd`, and the `GROOMING` entry), missing handover files, prerequisites, model tiers and `tiers.json` (1.2), the WIP limit and `claimed_at` (5.1, 5.3), `BLOCKED` reasons and entries (5), the Ready for Review entry (3.2), the stamps and claims (6.1: ISO 8601 UTC times, `last_actor` role and tier, one open claim only on an `IN_PROGRESS` ticket), the derived status and points of every container (4.1), `order` (4.2), `decisions_pending` (5.4), the `STATE` block sections (6.2.1), archive stubs against the archive file (6.6), the knowledge index against the findings folder (6.7), and, once design sources are declared, the design anchor (10): source files and hashes, the ledger, each ticket's design link, and the ADRs that tickets and ledger rows name. It warns about a board over its size limit (6.6), open containers without a `STATE` block, tickets whose design link is missing or stale, a ticket claimed out of order, stale claims, an in-progress `worker_model` not listed for the ticket's tier, `DONE` tickets without a `REVIEW · … · DONE` entry (3.3), and `HANDOVERS.md` rows that target closed tickets. Entry headers may use `·`, `-`, `|`, or `•` as separators; `ticket.mjs` writes `·`.

The git `pre-commit` hook (`scripts/git-hooks/pre-commit`, enabled with `git config core.hooksPath scripts/git-hooks`) runs the same check on the staged files for every provider. It runs on every commit, because a design file or an ADR outside `docs/kanban/` can break the board too. It also rejects a staged change to a `tier_override` or to `tiers.json` unless the user commits with `KANBAN_ALLOW_TIER_EDIT=1`; a staged `board.json`, `board-archive.json`, `design.json`, or note that `ticket.mjs` did not write (section 6.1) unless the user commits with `KANBAN_ALLOW_MANUAL_EDIT=1`; and a staged change that sets an ADR to an accepted status unless the user commits with `KANBAN_ALLOW_ADR_ACCEPT=1` (section 10.4).

---

## 10. Design Anchor

A ticket can pass its own acceptance criteria and still build the wrong thing, when it was groomed from a plan and nobody opened the design. The ticket-to-ticket checks do not see this, because every step agrees with the step before it. The design anchor ties each ticket to the design itself, and makes every way of leaving the design visible and approved.

The anchor is **opt-in per board**. It is off until `design_sources` in `board.json` lists a file. A project without a design yet works as before. Once a source is declared, every rule in this section is a hard error in `render-board.mjs` or a refusal in `ticket.mjs`. Setup guide: the template's `docs/design-anchor.md`.

### 10.1. Design sources
- A design source is a **file in the repository**: an export of the solution diagram, a contract page, an API description. A design that lives only in a drawing tool or a wiki cannot be checked, so export it and commit the export.
- The coordinator declares it, on the user's word, with `node scripts/kanban/ticket.mjs design <path>`. The command records the file's sha256 in `design_sources`. `render-board.mjs` rejects a source whose file is missing.
- Text files are hashed with LF line endings, so a line-ending conversion is not a design change.

### 10.2. Design ledger
`docs/kanban/design.json` has one row per design element: a component, a flow, a contract, a rule that the design shows. `ticket.mjs element new --title "<text>" --source <path> [--ticket <ID>]...` adds a row; `element <D-ID> --state ... --adr ...` changes one; `element new --json <file>` adds many.

| State | Meaning | What the validator needs |
|---|---|---|
| `planned` | A ticket will build it. | At least one ticket whose `design.refs` names it. |
| `built` | It is built. | Every ticket that names it is closed, and at least one is `DONE`. `ticket.mjs` sets this state itself when the last ticket is reviewed. |
| `deferred` | It will not be built now. | An ADR whose status is accepted (`adr` on the row). |
| `deviated` | Something else is built in its place. | An ADR whose status is accepted. |

- `render-board.mjs` rejects a row with no ticket and no ADR. So every element of the design is planned, built, or left out on purpose with the user's agreement.
- The tickets of a row are not stored in the row: they are the tickets whose `design.refs` name it. `element --ticket <ID>` adds the reference to the ticket.
- `BOARD.md` shows the coverage: the count per state, and every row that is not `built`.

### 10.3. Design link on the ticket
- Part of the Definition of Groomed (section 3.1): `design.refs` (ledger IDs the ticket implements; `groom --design-ref <D-ID>`) or `design.na` with the reason (`groom --design-na "<reason>"`), for example tooling or a test-only change.
- Grooming reads the design source, not only the plan. The `GROOMING` entry says which part of the source the ticket builds.
- When the anchor is turned on for a board that has groomed tickets, they are marked `design.pending`. They do not break the board, but `claim`, `review`, and `close` refuse them until the coordinator gives each one its link.

### 10.4. Deviation gate and ADRs
- Not building the design as drawn needs an **ADR** (architecture decision record) whose status is accepted. **Only the user accepts an ADR.** An agent writes it with the status Proposed and adds an entry to `decisions_pending` (section 5.4).
- While the ADR is Proposed, the ledger row stays `planned`. `render-board.mjs` rejects a `deferred` or `deviated` row whose ADR is not accepted.
- A ticket depends on an ADR when its `adrs` field names it (`groom --adr <ADR-ID>`) or a ledger row in its `design.refs` names it. `ticket.mjs claim` refuses the ticket until every such ADR is accepted. This check works with or without declared design sources.
- `board.json` says where ADRs are and how to read them: `"adr": { "dir": "docs/adr", "status_pattern": "<regular expression with one capture group>", "accepted": ["Accepted"] }`. Without `status_pattern`, the first word of these forms is read: `| Status | Accepted |`, `Status: Accepted`, `**Status:** Accepted`, and a `## Status` heading with the word on the next line. An ADR ID is the number or name at the start of the file name: `0016`, `ADR-0016`, and `16` all name `0016-lambda-relays.md`.
- The git `pre-commit` check rejects a staged change that sets an ADR to an accepted status, unless the user commits with `KANBAN_ALLOW_ADR_ACCEPT=1`. Agents never set it.
- The session brief and `BOARD.md` list every ADR that is not accepted and the tickets that wait for it.

### 10.5. Source change alarm
- When a design file changes, its hash no longer matches. `render-board.mjs --check` (session start, `pre-commit`, CI) fails and lists every open ticket that references the file through the ledger. Inside a `ticket.mjs` command the same finding is a warning, so a worker can still hand over; but `claim` refuses a ticket that references the changed file.
- The coordinator reads what changed, then runs `node scripts/kanban/ticket.mjs design <path>` (or `design all`). It records the new hash and marks every open ticket that references the file `design.stale`.
- A stale ticket cannot be claimed, reviewed `DONE`, or closed. The coordinator regrooms it against the new version, then clears the mark with `ticket.mjs groom <ID> --design-reviewed "<what changed for this ticket, or why nothing did>"`. The text goes into an `AMEND` entry.

### 10.6. Design check at handover and review
- **Worker.** The `PROGRESS · … · REVIEW` body has a **Design check** section: for each element in `design.refs`, the source file it opened and how the result matches it; or "not applicable" with the `design.na` reason. `ticket.mjs handover --status REVIEW` refuses a body without the section.
- **Coordinator.** The `REVIEW · … · DONE` body, and the body of `close`, has a **Design** line: what it compared with which source, and the result. `ticket.mjs review` and `close` refuse a body without it.
- A mismatch is not accepted in review. It is `REWORK`, or a Proposed ADR and an entry in `decisions_pending`.
