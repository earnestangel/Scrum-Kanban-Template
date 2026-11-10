# Changelog

Upgrade steps for each version: [docs/upgrade.md](docs/upgrade.md).

## 0.9.0

Context transfer over a long project. A review of a project that ran this template for six weeks (340 tickets, 317 handover notes) found that ticket-to-ticket handover worked, and long-horizon context did not: design drift went unnoticed, append-only notes went stale, the board grew to 925 KB, project facts sat in one tool's memory, nothing could be measured, and epic status was wrong. Every fix below is a field or a command that `render-board.mjs` or `ticket.mjs` rejects when it is missing.

### Breaking changes

- **Epic and story status and points are derived.** An epic with children, and a story with children, gets its points (the sum of its children) and its status from the children on every `ticket.mjs` write. `render-board.mjs` rejects a board where they differ. `groom --points`, `edit --set points=`, and `status --to BACKLOG|TODO` refuse a container. The old warning "story is N pts but its tasks add up to M" is gone, and a story's points no longer have to be a Fibonacci number. The migration derives both and keeps the old number as `estimate`.
- **A story with children is closed with `close`, not claimed and reviewed.** `claim` and `review` refuse it. When every child is closed it shows `REVIEW`; the coordinator runs `ticket.mjs close <ID>`. `status <EPIC> --to DONE` is replaced by `close <EPIC>`.
- **A ticket cannot be claimed while its story or epic has no `STATE` block.** After the upgrade the coordinator writes one for each open epic and story (`ticket.mjs state`).
- **A story's closing entry needs a `Knowledge:` line**, and a story under an epic closes only after the epic's `STATE` block was refreshed since the previous story closed.
- **`claim` respects `order`.** When a ticket with a lower `order` can start, `claim` refuses the other one unless `--out-of-order "<reason>"` is given. Boards without `order` values are not affected.
- **The `UserPromptSubmit` hook is removed** (`scripts/hooks/prompt-context.mjs`). `upgrade` deletes it and its settings entry.
- **Template-owned hooks in `.claude/settings.json` are replaced on upgrade**, not only added. If you changed the matcher of a hook that runs `scripts/hooks/*.mjs`, the change is lost; your own hooks are kept.
- **The git `pre-commit` hook runs on every commit** of a repository with a board, not only when `docs/kanban/` is staged, and it rejects a staged change that accepts an ADR unless the user sets `KANBAN_ALLOW_ADR_ACCEPT=1`.
- **Every finding needs a line in `docs/kanban/KNOWLEDGE.md`.** `render-board.mjs` rejects a file in the findings folder (`knowledge.dir`, default `docs/findings`) without one. The migration writes the lines for existing files.
- `BOARD.md` has new sections and lists only the newest 30 `DONE` tickets. The `SessionStart` hook no longer waits for the CodeGraph sync.

### Added: design anchor (off until a source is declared)

- `design_sources` in `board.json`: design files in the repository with a recorded sha256 (`ticket.mjs design <path>`). A missing file is an error.
- `docs/kanban/design.json`, the design ledger: one row per design element, `planned`, `built`, `deferred`, or `deviated` (`ticket.mjs element`). A row with no ticket and no accepted ADR is an error. `BOARD.md` shows the coverage.
- Ticket field `design.refs` or `design.na` with a reason, part of the Definition of Groomed. Ticket field `adrs`.
- Deviation gate: `deferred` and `deviated` need an ADR whose status is accepted. `claim` refuses a ticket that depends on an ADR that is not accepted. Only the user accepts an ADR; the `pre-commit` check enforces it. ADR folder and status-line format are set in `board.json` (`adr.dir`, `adr.status_pattern`, `adr.accepted`).
- Source change alarm: when a design file's hash changes, `render-board.mjs --check` fails and lists the open tickets that reference it. `ticket.mjs design <path>` records the new hash and marks those tickets stale; `groom --design-reviewed` clears a ticket.
- `handover --status REVIEW` refuses a body without a **Design check** section; `review` and `close` refuse one without a **Design** line.

### Added: notes, size, knowledge

- `ticket.mjs state <EPIC|STORY>`: the rewritable `STATE` block at the top of a note (Scope, Order, Decisions in force, Open for the user).
- `ticket.mjs note --supersedes [<NOTE-ID>#]<n>` marks an older entry `(SUPERSEDED)`; nothing is deleted.
- `ticket.mjs context <ID>`: the worker's whole reading pack in one bounded output. The Worker Procedure uses it.
- `ticket.mjs archive <STORY>`: moves closed children to `docs/kanban/board-archive.json` and their notes to `handovers/archive/`, after a story Digest of at most 40 lines. A stub stays on the board; IDs stay unique across the archive.
- `render-board.mjs` warns when `board.json` is over `size_limit_kb` (default 300).
- `docs/kanban/KNOWLEDGE.md` and `ticket.mjs finding`. `AGENTS.md` rule: project facts go to findings; provider memory holds user preferences only.

### Added: velocity and status

- `started_at`, `done_at`, `done_by`, `done_by_model`, `rework_count`, written only by `ticket.mjs`, kept after `DONE`. `ticket.mjs stats` and a table in `BOARD.md`.
- `decisions_pending` in `board.json` (`ticket.mjs decision`), shown at the top of `BOARD.md` and printed by `render-board.mjs --check` and the session-start hook.
- `order` on a ticket (`groom --order`), so sequence needs no fake `requires` link.
- `note --link <ID>|children` and `groom --handover <ID>` for a note that does not exist yet: a story note can be written and listed by other tickets in one step.
- `scripts/kanban/migrate.mjs`: upgrades a board in place, safe to run again. The installer's `upgrade` runs it. `--order-from=<field>` copies an existing numeric field to `order`.

### Changed: CodeGraph

- The `PreToolUse` hook fires on code only. It no longer denies a search or read of Markdown, ADRs, notes, JSON, YAML, or anything under `docs/`.
- The session-start sync runs in the background.
- Reasons: [docs/codegraph.md](docs/codegraph.md).

### Changed: web board

- A card keeps the worker's icon and name after delivery (`REVIEW`, `DONE`, archived), from `done_by`.
- The Handover tab is now **Context**, with a dropdown: All context, This ticket, Inherited. `STATE` blocks are shown first; superseded entries are folded and marked.
- Archived tickets open with their full record and note. New card marks: waits on the user, design, reworks, archived.
- WIP and column points count leaf tickets only.

### Changed: documentation

- `README.md` is a summary with a table of pointers. The detail moved to `docs/setup.md`, `docs/upgrade.md`, `docs/board-commands.md`, `docs/design-anchor.md`, `docs/codegraph.md`, `docs/hooks.md`, `docs/web-board.md`, and `docs/contributing.md`.
- The pre-commit check copies the staged files with one git call. On a board with 300 notes it takes seconds, not minutes.

## 0.8.0

Every board change through `scripts/kanban/ticket.mjs`: `create`, `groom`, `edit`, `status`, grooming entry `--edit` and `--delete`; stamps (`updated_at`, `last_actor`, `created_at`) and the `claims` history; script-write hashes checked by `pre-commit`; web board sort and actor filters.

## 0.7.0

`docs/kanban/tiers.json` (user-owned tier→model map), `ticket.mjs` (claim, handover, note, review, recover, show), the git `pre-commit` board check, tier checks against the real model.

## 0.6.0 and earlier

Standing tier rule (0.6), worker delegation (0.5), template-owned file list (0.4), `claimed_at` and recovery (0.3), provider-neutral tiers and WIP 1 (0.2). Notes: [docs/upgrade.md](docs/upgrade.md#notes-for-earlier-versions).
