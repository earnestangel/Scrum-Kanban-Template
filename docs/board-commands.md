# Board commands and daily use

Back to the [README](../README.md). The rules behind each step: [protocol.md](kanban/protocol.md). One example per command, and which tool enforces what: [providers.md section 3](kanban/providers.md#3-board-commands-ticketmjs).

## Board commands (`scripts/kanban/ticket.mjs`) and tier map (`docs/kanban/tiers.json`)

Every board change goes through `node scripts/kanban/ticket.mjs <command> <ID> ...`. Run it without arguments for the usage.

| Who | Commands |
|---|---|
| Coordinator | `create`, `groom`, `edit`, `status`, `note --type GROOMING` (`--edit`, `--delete`, `--supersedes`, `--link`), `state`, `review`, `close`, `archive`, `recover`, `decision`, `design`, `element` |
| Worker | `context`, `claim`, `note --type FLAG`, `finding`, `handover` |
| Anyone | `show`, `stats` |

Each command:
- writes the canonical handover header, and an `AMEND` entry for edits, status moves, and grooming entry fixes;
- stamps the ticket with `updated_at`, `last_actor` (name, role, model, tier), `created_at`, the `claims` history, and the velocity fields (`started_at`, `done_at`, `done_by`, `done_by_model`, `rework_count`), from the machine clock in UTC;
- derives the status and points of every epic and of every story with children;
- checks the agent's model against `tiers.json`;
- renders the board, and restores every file it changed if the board does not validate;
- records a hash of each board file it wrote for the `pre-commit` check.

`tiers.json` lists which model IDs count as `small`, `medium`, and `large`. Only you edit it. Setup per tool and gateway: [providers.md](kanban/providers.md).

## Daily use

| Task | How |
|---|---|
| Start a session | `node scripts/kanban/render-board.mjs --check`. It validates the board and prints the brief: what waits on you, ADRs that are not accepted, stories and epics ready to close, design files that changed. In Claude Code the `SessionStart` hook prints it. |
| Create and groom tickets | Coordinator runs `ticket.mjs create <type> --title ...`, then `ticket.mjs groom <ID> --file ... --acceptance ... --verify-cmd ... --body groom.md`. With the design anchor on, add `--design-ref <D-ID>` or `--design-na "<reason>"`. The ticket moves to `TODO` once the Definition of Groomed passes (protocol section 3.1). |
| Set the sequence | `ticket.mjs groom <ID> --order <n>`. The lowest `order` that can start goes first. No `requires` link is needed to say "later" (protocol section 4.2). |
| Say what is true now for an epic or story | `ticket.mjs state <ID> --body state.md` rewrites its `STATE` block: Scope, Order, Decisions in force, Open for the user (protocol section 6.2.1). Required before the first claim under it. |
| Fix a ticket or a grooming entry | `ticket.mjs edit <ID> --set <field>=<value> --reason ...`, or `ticket.mjs note <ID> --type GROOMING --edit <n> \| --delete <n> --reason ...`. Both keep the old text in an `AMEND` entry. |
| Replace an entry that no longer holds | `ticket.mjs note <ID> --type GROOMING --supersedes <n> --body new.md`. The old entry stays, marked `(SUPERSEDED)`; workers no longer get it. |
| Tell several tickets to read a story note | `ticket.mjs note <STORY> --type GROOMING --body x.md --link <ID> --link <ID>`, or `--link children`. |
| Ask the user something | `ticket.mjs decision new --question "..." --blocks <ID>`. It shows at the top of `BOARD.md` and in the session brief. Record the answer with `ticket.mjs decision <DEC-ID> --resolve "..."` (protocol section 5.4). |
| Abandon or unblock a ticket | `ticket.mjs status <ID> --to ABANDONED --reason ...` or `--to TODO`. |
| Run a ticket | The coordinator starts a worker on a model listed for the ticket's tier (protocol section 6.3.1): in Claude Code the `ticket-worker` subagent; elsewhere a subagent or headless CLI run, or a hand-off to a new session. The worker runs `ticket.mjs context <ID>`, reads the pack, and claims with `ticket.mjs claim`. The coordinator never executes a ticket itself. Only one ticket runs at a time. |
| Use another model or tool | List its model IDs in `docs/kanban/tiers.json` (you edit it; agents cannot). See [providers.md](kanban/providers.md). |
| Resume a ticket on another model | `ticket.mjs claim` on any model listed for the tier. For a one-off mismatch, start the session with `KANBAN_INLINE=<ID>` (providers.md section 10). |
| Handle a blocker | Worker runs `ticket.mjs handover <ID> --status BLOCKED --reason ...`, then stops. That frees the WIP slot. Coordinator resolves it or asks you, then runs `ticket.mjs status <ID> --to TODO`. |
| Recover a dead worker | At session start the coordinator checks for an `IN_PROGRESS` claim it did not make, asks you, then runs `ticket.mjs recover` (protocol section 5.3). |
| Review and close a ticket | Coordinator reruns `verify_cmd`, checks acceptance, runs `ticket.mjs review <ID> --outcome DONE\|REWORK` (protocol sections 3.2–3.3). With the design anchor on, the body needs a **Design** line. |
| Close a story or epic | When every child is closed it shows `REVIEW`. The coordinator asks you, refreshes the epic's `STATE`, then runs `ticket.mjs close <ID> --body close.md`; the body needs a **Knowledge** line (protocol sections 4.1, 8.2). |
| Keep a project fact | Write it in the findings folder, then `ticket.mjs finding <file> --summary "<one line>" --agent <name>` (protocol section 6.7). |
| Shrink the board | Write the story's Digest with `ticket.mjs state <STORY>`, then `ticket.mjs archive <STORY>` (protocol section 6.6). |
| Measure | `ticket.mjs stats`, `ticket.mjs stats --days 14`, `ticket.mjs stats --json`. `BOARD.md` has a short table. |
| Regenerate the board | `node scripts/kanban/render-board.mjs` |
| Validate the board (CI) | `node scripts/kanban/render-board.mjs --check` |
| Open the web board | `node scripts/kanban/board-server.mjs --open` ([web-board.md](web-board.md)) |

## Velocity

`ticket.mjs stats` reads only fields that `ticket.mjs` wrote:

| Number | From |
|---|---|
| Points per day | Points of `DONE` leaf tickets, over the calendar days from the first `started_at` to the last `done_at`. |
| Median cycle time | `started_at` (the first claim) to `done_at`, in hours. Tickets migrated from an older board have no claim time and are left out; the output says how many tickets were measured. |
| Rework rate | Share of `DONE` tickets that review sent back at least once, and the number of `REWORK` reviews. |
| By tier | The same three numbers for `small`, `medium`, and `large` tickets. |

Epics and stories with children are not counted: they are the sum of their children.
