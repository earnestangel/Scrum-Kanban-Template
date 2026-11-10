# Web board (`scripts/kanban/board-server.mjs`)

Back to the [README](../README.md).

A Jira-style view of `board.json`: one column per status, cards with type, epic, points, model tier, the worker, and the last change and actor, and an epic strip with progress bars. Click a card to see every field of the ticket, its created and updated times, its claims history, and its context. Sort the cards in each column by last change, created, claimed, ID, or points, and filter by epic, type, worker, last actor, role, model, or tier. Times show in your local time zone. The filters, the sort, and the open ticket live in the URL, so you can share a link.

```sh
node scripts/kanban/board-server.mjs --open   # http://127.0.0.1:4477
```

The server has no dependencies, listens on `127.0.0.1` only, and is read-only: it never writes `board.json`. The page reloads by itself when `board.json` or a handover note changes. Options: `--port=<n>` (or `PORT`), `--root=<dir>` to view another project's board.

## Who worked on a card

Each card shows a worker's icon and name at the bottom right.

- While a ticket is `IN_PROGRESS`, it is the assignee.
- After the handover the claim fields are cleared, so the card shows who **delivered** it: `done_by`, the worker of the last `REVIEW` handover. The icon has a light ring, and its tooltip says "Delivered it" with the model. It stays on the card in `REVIEW`, in `DONE`, and after the ticket is archived.
- A ticket that was never claimed shows `?`.

The "Any worker" filter uses the same name, so you can list everything a worker delivered.

## Context tab

The **Context** tab of a ticket shows what a worker reads for it, in reading order. The **Show** dropdown separates it:

| Choice | Shows |
|---|---|
| All context | Everything below. |
| This ticket | The ticket's own note. |
| Inherited | The epic's note, the story's note, every note the ticket's `handovers` field lists, and the last `PROGRESS` entry of each `requires` ticket. Each note says why it is there. |

- A **STATE** block is shown first in its note, in a blue box: it is what is true now.
- A **superseded** or deleted entry is folded and struck through, with a `SUPERSEDED` badge. Click it to read the old text.
- Notes of archived tickets are read from `handovers/archive/`.

The choice is kept in the URL (`ctx=own` or `ctx=inherited`).

## Other marks on a card

| Mark | Meaning |
|---|---|
| `waits on <ID>` | A `requires` ticket is not `DONE`. |
| `waits on the user` | A `decisions_pending` entry blocks it. The header shows the count. |
| `design` | Its design source changed, or it has no design link yet. |
| `n reworks` | Review sent it back n times. |
| `archived` | Its record is in `board-archive.json`. The drawer still shows every field. |
| `n flags`, `stale claim` | Open `FLAG` entries; a claim older than 24 hours. |

The WIP counter and the points at the top of a column count leaf tickets only. A story with tasks is `IN_PROGRESS` while its tasks are worked, but it does not hold the WIP slot, and its points are the sum of its tasks.
