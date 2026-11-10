# Upgrade

Back to the [README](../README.md). What changed in each version: [CHANGELOG.md](../CHANGELOG.md).

```sh
npx github:earnestangel/Scrum-Kanban-Template upgrade --dry-run   # print what would change
npx github:earnestangel/Scrum-Kanban-Template upgrade             # refresh protocol, scripts, board schema, and marked blocks
npx github:earnestangel/Scrum-Kanban-Template doctor              # check Node, CodeGraph, hooks, and the board
```

To upgrade from a local clone of the template (for example a branch that is not released yet), run its installer from the root of your project: `node /path/to/Scrum-Kanban-Template/bin/scrum-kanban.mjs upgrade`.

## What an upgrade touches

| Files | On upgrade |
|---|---|
| `scripts/` (all of it), `docs/kanban/protocol.md`, `docs/kanban/providers.md`, `docs/kanban/handovers/_TEMPLATE.md`, `.claude/agents/ticket-worker.md` | **Replaced.** Template-owned; do not edit them. Files a newer template dropped are deleted. |
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` | Only the block between `<!-- scrum-kanban:start -->` and `<!-- scrum-kanban:end -->` is replaced. **Your project sections stay.** The CodeGraph block (`<!-- CODEGRAPH_START -->`) is added only when it is missing; to get its new text, delete the block before you upgrade. |
| `.claude/settings.json` | Hooks that run `scripts/hooks/*.mjs` are replaced by the template's current set. **Your own hooks and permissions stay.** |
| `docs/kanban/board.json` | **Kept**, and migrated in place by `scripts/kanban/migrate.mjs`: `$schema` and `_ticket_template` follow the template, missing top-level keys are added, missing ticket fields are backfilled, and the status and points of epics and of stories with children are derived. Fields the template does not know (your own `milestone`, `lane`, ...) are kept. |
| `docs/kanban/tiers.json` | **Kept.** User-owned; nothing writes it. |
| `docs/kanban/handovers/*.md`, `HANDOVERS.md` | **Kept.** No upgrade writes a note. |
| `docs/kanban/KNOWLEDGE.md` | Created when missing; lines are added for findings that have none. Existing lines are kept. |
| `docs/kanban/BOARD.md` | Regenerated. |
| `.scrum-kanban.json` | `version` and `owned` are updated. |
| `.mcp.json`, `.gemini/settings.json`, `.vscode/mcp.json`, `.codex/config.toml`, `.gitignore`, `.gitattributes` | Missing entries are added. |

`upgrade` never touches your tickets' own fields, `tier_override`, or your text outside the marked blocks.

## The migration command

`upgrade` runs it for you. You can run it again at any time; a second run changes nothing.

```sh
node scripts/kanban/migrate.mjs --dry-run             # print what would change, write nothing
node scripts/kanban/migrate.mjs                       # migrate, validate, and write BOARD.md
node scripts/kanban/migrate.mjs --order-from=lane     # also copy a numeric ticket field of your own (here "lane") to "order"
```

It prints every schema key it added, every epic or story whose status or points it derived, how many fields it backfilled, and the tickets it could not backfill exactly. It exits non-zero when the board does not validate afterwards, and prints the errors.

## Upgrading to 0.9 from 0.7 or 0.8: exact steps

0.9 has breaking changes. Read the list in [CHANGELOG.md](../CHANGELOG.md) first.

1. **Start clean.** Commit or stash your work. No ticket may be `IN_PROGRESS`: let its worker hand over, or recover it (protocol 5.3).
2. **Preview.** `npx github:earnestangel/Scrum-Kanban-Template upgrade --dry-run`
3. **Upgrade.** `npx github:earnestangel/Scrum-Kanban-Template upgrade`. It replaces the template-owned files, refreshes the hooks, and runs the migration.
4. **Optional: keep your lane numbers.** If your tickets carry a numeric field for sequence, copy it to `order`: `node scripts/kanban/migrate.mjs --order-from=<field>`. After that you can remove the `requires` links that only meant "later" (`ticket.mjs groom <ID> --requires ...` with the real dependencies).
5. **Check.** `node scripts/kanban/render-board.mjs --check`. Errors must be zero. Read the warnings: each one is a step below.
6. **Check the folders.** `board.json` now has `"adr": { "dir": ... }` and `"knowledge": { "dir": ... }`. The migration picks `docs/decisions`, `docs/adrs`, or `docs/adr` when one exists. If your ADR status line is not one of the forms in protocol 10.4, set `adr.status_pattern`.
7. **Read the `manual` lines the upgrade printed.** One of them may say that `.claude/settings.json` has a `codegraph prompt-hook` entry under `UserPromptSubmit`. `codegraph install` added it. Remove it unless you want symbol source added to every prompt ([codegraph.md](codegraph.md)).
8. **Commit** the upgrade as one commit. The board was written by a script, so the `pre-commit` check accepts it without a switch.

Then the coordinator does the work the new rules ask for. Nothing can be claimed until step 9 is done for the story and epic of the next ticket.

9. **Write the `STATE` block** of every open epic and every open story: `node scripts/kanban/ticket.mjs state <ID> --agent <name> --model <model-id> --body state.md` (sections: Scope, Order, Decisions in force, Open for the user). `render-board.mjs` lists the ones that are missing. While you write it, supersede the old entries that no longer hold: `ticket.mjs note <ID> --type GROOMING --supersedes <n> --body now.md`.
10. **Move open user questions** from the notes into the list: `ticket.mjs decision new --question "<text>" --blocks <ID>`.
11. **Name the ADRs that tickets depend on**: `ticket.mjs groom <ID> --adr <ADR-ID>`. A ticket cannot be claimed while its ADR is not accepted. Ask the user to accept or reject each Proposed ADR; the user commits an acceptance with `KANBAN_ALLOW_ADR_ACCEPT=1`.
12. **Archive closed stories** when `render-board.mjs` warns about the board size. For each one: write its Digest (`ticket.mjs state <STORY>` with a `**Digest**` section of at most 40 lines), then `ticket.mjs archive <STORY>`.
13. **Move project facts out of provider memory** into your findings folder, and index each file: `ticket.mjs finding <file> --summary "<one line>" --agent <name>`.
14. **Turn on the design anchor** when the design is in the repository: [design-anchor.md](design-anchor.md). It stays off until you declare a source.

What changes for your tickets in 0.9:
- The status and points of every epic, and of every story with children, are now derived. An epic that said `BACKLOG` with stories `DONE` becomes `IN_PROGRESS`; a story's points become the sum of its tasks. The number it had before is kept as `estimate`.
- A story with children is no longer claimed and reviewed. When all its children are closed it shows `REVIEW`, and the coordinator closes it with `ticket.mjs close`.
- `DONE` tickets get `done_at`, `done_by`, and `rework_count` from the `PROGRESS` and `REVIEW` headers of their notes, and `started_at` from the first `PROGRESS` entry. That start is the first hand-over, not the claim, so those tickets are marked `stamps_backfilled` and left out of cycle time. New tickets are measured from the claim.

## Notes for earlier versions

Upgrading from 0.1.x: `upgrade` replaces `wip_limit_per_worker` and `max_parallel_workers` with `"wip_limit": 1`. It also maps ticket `model` values `haiku`/`sonnet`/`opus` to `small`/`medium`/`large`. You can delete `.claude/worktrees/` from `.gitignore` and `codegraph.json`.

Upgrading from 0.2.x: `upgrade` sets `claimed_at` on any `IN_PROGRESS` ticket that has none. Older `DONE` tickets without a coordinator `REVIEW · … · DONE` entry produce warnings only, so CI keeps passing.

Upgrading from 0.3.x: the first `upgrade` records the template-owned files in `.scrum-kanban.json`. From the next upgrade on, files the template drops are deleted.

Upgrading from 0.4.x: the coordinator no longer runs tickets inline. It starts a worker on the ticket's tier (protocol section 6.3.1). `upgrade` adds the `worker-delegation.mjs` hook to `.claude/settings.json`, also in `--no-codegraph` installs. In Claude Code, a `ticket-worker` dispatch must pass the tier's `model`, and the main session cannot edit files outside `docs/kanban/` while a ticket is `IN_PROGRESS`. `upgrade` also adds `"coordinator_paths": []` to `board.json`: list there any extra files the coordinator may edit while a ticket is active. To keep the old inline behavior for a session, set `KANBAN_DELEGATE=off` (for example in `.claude/settings.local.json` under `env`). Other providers get the rule through `AGENTS.md` and the review check; they have no hook.

Upgrading from 0.5.x: tiers follow a standing rule instead of grooming judgment: every Story and Epic is `large`, every 1 pt ticket is `small`, every other ticket is `medium`. `upgrade` re-tiers open tickets that break the rule and lists them; `DONE` and `ABANDONED` tickets keep their history. `render-board.mjs` rejects a ticket that breaks the rule. To give one ticket another tier, add `"tier_override": { "tier": "large", "reason": "..." }` to it yourself; the hook stops agents from writing one. In Claude Code the main session must run Opus to edit `docs/kanban/board.json` or handovers.

Upgrading from 0.6.x: these features are new:
- **`docs/kanban/tiers.json`.** The tier→model map. It is created with the Claude defaults, so nothing changes until you add models. After that it is yours.
- **`scripts/kanban/ticket.mjs`.** Board commands for every agent: claim, handover, note, review, recover, show. A claim records `worker_model`.
- **git `pre-commit` hook.** It runs the board check for every tool. It also rejects agent changes to `tier_override` or `tiers.json`; to commit your own, use `KANBAN_ALLOW_TIER_EDIT=1`. `upgrade` now sets `core.hooksPath` even with `--no-codegraph`.

The Claude Code hook changed in four ways:
- It checks dispatches and the coordinator against `tiers.json`, after resolving `ANTHROPIC_DEFAULT_*_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`.
- It checks claims against the agent's real model.
- It denies shell writes to `board.json`.
- It replaces most uses of `KANBAN_DELEGATE=off` with the narrower `KANBAN_INLINE=<ID>`.

`render-board.mjs` now accepts `-`, `|`, and `•` as handover header separators. See [providers.md](kanban/providers.md).

Upgrading from 0.7.x: every board change now goes through `scripts/kanban/ticket.mjs`, and nobody edits the board by hand.
- **New commands.** `create` (next free ID per type, in the width your board uses), `groom` (grooming fields, the rule tier, the `GROOMING` entry, and `BACKLOG` → `TODO` once groomed), `edit` (any field that is not state, with `--reason`), `status` (coordinator moves such as `ABANDONED --reason` or unblocking), and `note --type GROOMING --edit <n> | --delete <n> --reason`. Edits, deletes, and status moves append an `AMEND` entry that keeps the old text.
- **Who touched what.** Every write stamps `updated_at`, `last_actor` `{ name, role, model, tier }`, and `created_at` on create; `claim`, `handover`, and `recover` keep a `claims` history. Times come from the machine clock, stored in ISO 8601 UTC. `upgrade` backfills the fields: dates from the first and last dated entry of each note (else its git history, else `null`), `last_actor` from the latest entry header that names a model, and the open claim of an `IN_PROGRESS` ticket.
- **Views.** `BOARD.md` gets "Updated (UTC)" and "Last actor" columns; In Progress, Review, and Done list the newest change first. The web board shows the last change and actor on each card, created, updated, and the claims in the drawer, and adds a sort (last change, created, claimed, ID, points) and filters by last actor, role, model, and tier. The choices are kept in the URL.
- **Enforcement.** The Claude Code hook denies Edit, Write, and shell writes on `board.json`, `BOARD.md`, and `handovers/` for every agent, the coordinator included, and names the `ticket.mjs` command to use. `ticket.mjs` records a hash of each write in `docs/kanban/.script-writes.json` (git-ignored; `upgrade` adds the line), and the `pre-commit` hook rejects a staged board or note that differs from the last script write. For a hand edit you made on purpose (a merge conflict, a `tier_override`), commit with `KANBAN_ALLOW_MANUAL_EDIT=1`.
- **Standing rules.** Grooming checks every constant it states against the code; shared touch points go in the first Task of a Story; all times come from `ticket.mjs`; a 1 point mechanical chore may be done by a script or inline by the coordinator, recorded with `claim` and `handover` (protocol sections 3, 6.1, 6.3.1).
