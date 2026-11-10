# Scrum Kanban Agent Workflow

A Scrum Kanban workflow for AI coding agents. A coordinator on a strong model grooms tickets once, with full context. A worker on a cheaper model tier then executes each ticket without rediscovering the code. The board lives in your repository as `docs/kanban/board.json`, validated by a zero-dependency Node script.

The workflow is provider-agnostic. Claude Code, Gemini CLI, Codex, opencode, and other agents that read `AGENTS.md` run the same steps. To make this possible, the board allows **one ticket `IN_PROGRESS` at a time** (WIP 1), in the main checkout. The flow needs no subagents, no worktrees, and no specific model family. Tickets name a model tier (`small`, `medium`, `large`). The project's `docs/kanban/tiers.json`, which you own, lists the model IDs that count as each tier.

What keeps a long project on course:

| Problem on a long project | What the template does |
|---|---|
| Work drifts from the design, and nobody notices | **Design anchor**: design files with recorded hashes, a ledger of design elements, a design link on every ticket, and an ADR the user accepted for every deviation. |
| Append-only notes go stale | A rewritable **STATE** block on epic and story notes, and `--supersedes` for entries that no longer hold. |
| The board and the notes grow without limit | `ticket.mjs archive`, a story digest, and `ticket.mjs context`: one bounded reading pack per ticket. |
| Project facts live in one tool's memory | Findings in the repository, indexed in `docs/kanban/KNOWLEDGE.md`. |
| Nothing can be measured | `started_at`, `done_at`, `done_by`, `rework_count`, and `ticket.mjs stats`. |
| Status goes stale | Epic and story status and points are derived from their children; one `decisions_pending` list says what waits on you. |

## Quick start

Requires Node.js 18+ and git.

```sh
# New project
git init my-app && cd my-app
npx github:earnestangel/Scrum-Kanban-Template init

# Existing project: preview, then install
npx github:earnestangel/Scrum-Kanban-Template init --dry-run
npx github:earnestangel/Scrum-Kanban-Template init --base-branch=main

# Later
npx github:earnestangel/Scrum-Kanban-Template upgrade   # refresh protocol, scripts, board schema, and marked blocks
npx github:earnestangel/Scrum-Kanban-Template doctor    # check Node, CodeGraph, hooks, and the board
```

Or click **Use this template** on GitHub. Then tell your agent: "Read AGENTS.md. Create and groom the first tickets."

```sh
node scripts/kanban/render-board.mjs --check   # validate the board; prints what waits on you
node scripts/kanban/ticket.mjs                 # every board command
node scripts/kanban/board-server.mjs --open    # web board, http://127.0.0.1:4477
```

## Where to read

| You want to | Read |
|---|---|
| Install into a new or existing project; what the installer changes; options | [docs/setup.md](docs/setup.md) |
| Upgrade an installed project, with the notes for each version | [docs/upgrade.md](docs/upgrade.md) |
| See what changed in a version, and what breaks | [CHANGELOG.md](CHANGELOG.md) |
| Run the daily flow: create, groom, run, review, close, archive | [docs/board-commands.md](docs/board-commands.md) |
| Stop design drift: design sources, ledger, ADR gate, STATE, knowledge | [docs/design-anchor.md](docs/design-anchor.md) |
| Install CodeGraph, and know why the hooks do what they do | [docs/codegraph.md](docs/codegraph.md) |
| Know what each Claude Code hook, git hook, and CI check enforces | [docs/hooks.md](docs/hooks.md) |
| Use the web board | [docs/web-board.md](docs/web-board.md) |
| Use another tool or model (LiteLLM, Bedrock, Codex, Gemini, opencode); user switches | [docs/kanban/providers.md](docs/kanban/providers.md) |
| Read the rules agents follow | [AGENTS.md](AGENTS.md), [docs/kanban/protocol.md](docs/kanban/protocol.md) |
| Change the template itself | [docs/contributing.md](docs/contributing.md) |

## Install

Short form above; everything else is in [docs/setup.md](docs/setup.md). Upgrades: [docs/upgrade.md](docs/upgrade.md).

## CodeGraph (optional, recommended)

[CodeGraph](https://github.com/colbymchenry/codegraph) indexes your code so the coordinator can record exact queries during grooming and workers can load the code in one call. Without it, everything still works. Install and wiring: [docs/codegraph.md](docs/codegraph.md).

## Hooks

Claude Code hooks, git hooks, and the CI check: [docs/hooks.md](docs/hooks.md). The git `pre-commit` check is the one check every tool gets.
