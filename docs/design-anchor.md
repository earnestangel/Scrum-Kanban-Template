# Design anchor and context transfer

Back to the [README](../README.md). The rules: [protocol.md](kanban/protocol.md) sections 4.1, 5.4, 6.2.1, 6.6, 6.7, and 10.

## Why

Handover from one ticket to the next works well with a groomed board: the worker gets exact facts, and review reruns the checks. What fails on a long project is different:

- A story is groomed from the implementation plan, and nobody opens the solution diagram. Every ticket passes its own acceptance. Weeks later the user sees that the wrong thing was built.
- The first entry of an epic note says a feature is out of scope. A later ADR says the opposite. Every worker has to read both and work out which one holds.
- A fact that every ticket needs (how changes are applied, how identity is set up) sits in one tool's memory on one laptop.

Each rule below is a field or a command that `render-board.mjs` or `ticket.mjs` rejects when it is missing. None of them is only a sentence in a document.

## Turn on the design anchor

It is off until you declare a design source. A project without a design yet works as before.

**1. Put the design in the repository.** Export the solution diagram (SVG, PNG, PDF, Mermaid), and copy contract pages as Markdown. A design that lives only in a drawing tool cannot be checked.

**2. Declare the sources.** The coordinator runs, on your word:

```sh
node scripts/kanban/ticket.mjs design docs/diagrams/lifecycle.svg --agent claude-large --model <model-id>
node scripts/kanban/ticket.mjs design docs/pages/contracts.md --agent claude-large --model <model-id>
```

Each command records the file's sha256 in `board.json` under `design_sources`. The first one turns the anchor on. Tickets that were groomed before are marked `design.pending`: the board still validates, but they cannot be claimed or closed until each has its design link.

**3. Fill the ledger.** One row per design element: a component, a flow, a contract, a rule the design shows. Each row names the tickets that build it:

```sh
node scripts/kanban/ticket.mjs element new --title "Apply relay Lambda" --source docs/diagrams/lifecycle.svg --ticket TASK-212 --ticket TASK-213 --agent claude-large --model <model-id>
```

For many rows, write a JSON list and run `element new --json rows.json`:

```json
[
  { "title": "Approval gate", "source": "docs/diagrams/lifecycle.svg", "tickets": ["TASK-063"] },
  { "title": "Watchdog", "source": "docs/diagrams/lifecycle.svg", "state": "deferred", "adr": "0012" }
]
```

The validator rejects a row with no ticket and no accepted ADR. So this step is the gap analysis: for every element of the design you find the ticket that builds it, or create one (a `BACKLOG` ticket counts), or you write an ADR that says it is left out or changed, and the user accepts it.

**4. Link the remaining tickets.** `ticket.mjs groom <ID> --design-ref <D-ID>` or `--design-na "<reason>"` for each ticket that `render-board.mjs` lists as having no design link.

**5. Check.** `node scripts/kanban/render-board.mjs`. `BOARD.md` now has a **Design coverage** section: the count per state, and every row that is not built.

## What happens from then on

| Moment | Rule |
|---|---|
| Grooming | A ticket enters `TODO` only with `design.refs` or `design.na`. The coordinator reads the design source, not only the plan. |
| Claim | Refused when an ADR the ticket depends on is not accepted, when a `decisions_pending` entry blocks it, when its design source changed, or when it has no design link. |
| Handover to review | The worker's entry needs a **Design check** section: the source it opened and how the result matches. |
| Review, close | The coordinator's entry needs a **Design** line: what it compared and the result. When the last ticket of a row is done, the row becomes `built`. |
| A design file changes | `render-board.mjs --check`, the `pre-commit` check, and CI fail and list the open tickets that reference the file. The coordinator reads the change, runs `ticket.mjs design <path>` to record the new hash, regrooms each listed ticket, and clears it with `ticket.mjs groom <ID> --design-reviewed "<what changed for this ticket>"`. |
| Something cannot be built as drawn | The worker hands over as `BLOCKED`. The coordinator writes an ADR with status Proposed and runs `ticket.mjs decision new --question "Accept ADR 0018?" --blocks <ID> --adr 0018`. The row stays `planned` until the user accepts the ADR. |

## ADRs

Only the user accepts an ADR. `board.json` says where they are and how their status line reads:

```json
"adr": { "dir": "docs/decisions", "status_pattern": null, "accepted": ["Accepted"] }
```

- Without `status_pattern`, the first word of the status is read from `| Status | Accepted |`, `Status: Accepted`, `**Status:** Accepted`, or a `## Status` heading with the word on the next line. "Accepted for the Phase 0 POC" counts as accepted; "Proposed" and "Superseded by ..." do not.
- For another format, set `status_pattern` to a regular expression with one capture group, and `accepted` to the words that count.
- An ADR ID is the start of its file name: `0016`, `ADR-0016`, and `16` all name `0016-lambda-relays.md`.
- A ticket names the ADRs it depends on with `ticket.mjs groom <ID> --adr 0016`. This works without the design anchor too.
- You accept an ADR by editing its status and committing with `KANBAN_ALLOW_ADR_ACCEPT=1 git commit ...`. The `pre-commit` check rejects the same change from an agent.

## Notes that do not go stale

- **STATE.** The note of every epic and story starts with a `## STATE` block: Scope, Order, Decisions in force, Open for the user. `ticket.mjs state <ID>` rewrites it. It is read first. A ticket cannot be claimed while its story or epic has none, and a story cannot close until the epic's block is newer than the last story that closed under it.
- **Supersedes.** `ticket.mjs note <ID> --type GROOMING --supersedes <n>` writes the new entry and marks entry `n` `(SUPERSEDED)`. `--supersedes STORY-002#3` names another note. Nothing is deleted; workers no longer get the old entry.
- **Context pack.** `ticket.mjs context <ID>` prints everything a worker reads, in one bounded output. Superseded entries are left out.

## Size

- `render-board.mjs` warns when `board.json` is over `size_limit_kb` (default 300) and names the stories to archive.
- Before a story's children leave the board, its `STATE` block gets a **Digest** of at most 40 lines: what was built, decisions, traps.
- `ticket.mjs archive <STORY>` moves the closed children to `docs/kanban/board-archive.json` and their notes to `docs/kanban/handovers/archive/`. A stub stays on the board.

## Facts in the repository

- Project facts are findings: Markdown files in `knowledge.dir` (default `docs/findings`).
- `docs/kanban/KNOWLEDGE.md` has one line per finding. `ticket.mjs finding <file> --summary "<one line>" --agent <name>` adds it; the validator rejects a finding without a line.
- The entry that closes a story or epic needs a **Knowledge** line: the findings written, or `none`.
- Provider memory (Claude memory, Codex memories, and the like) holds your preferences only. `AGENTS.md` says so for every agent.
