# Scrum Kanban Agent Workflow

A Scrum Kanban workflow for AI coding agents. A coordinator on a strong model grooms tickets once, with full context. A worker on a cheaper model tier then executes each ticket without rediscovering the code. The board lives in your repository as `docs/kanban/board.json`, validated by a zero-dependency Node script.

The workflow is provider-agnostic. Claude Code, Gemini CLI, Codex, opencode, and other agents that read `AGENTS.md` run the same steps. To make this possible, the board allows **one ticket `IN_PROGRESS` at a time** (WIP 1), in the main checkout. The flow needs no subagents, no worktrees, and no specific model family. Tickets name a model tier (`small`, `medium`, `large`), and each agent maps the tier to its own models.

Rules: [AGENTS.md](AGENTS.md) and [docs/kanban/protocol.md](docs/kanban/protocol.md).

## Install

Requires Node.js 18+ and git.

### New project

Click **Use this template** on GitHub, or run the installer in an empty repository:

```sh
git init my-app && cd my-app
npx github:earnestangel/Scrum-Kanban-Template init
```

### Existing project

Preview the changes first, then install:

```sh
npx github:earnestangel/Scrum-Kanban-Template init --dry-run
npx github:earnestangel/Scrum-Kanban-Template init --base-branch=main
```

The installer merges into your files. It does not replace them:

| File | What the installer does |
|---|---|
| `AGENTS.md` | Adds the rules between `<!-- scrum-kanban:start -->` and `<!-- scrum-kanban:end -->`. Your own text stays. |
| `CLAUDE.md`, `GEMINI.md` | Creates the file with `@AGENTS.md` if it is missing. In an existing file, adds or replaces the block between `<!-- scrum-kanban:start -->` and `<!-- scrum-kanban:end -->`. A file that already has a bare `@AGENTS.md` line and no block is left as it is. Your own text stays. |
| `.claude/settings.json` | Adds the hooks and the `mcp__codegraph__*` permission. Your hooks and permissions stay. |
| `.mcp.json`, `.gemini/settings.json`, `.vscode/mcp.json`, `.codex/config.toml`, `codegraph.json` | Adds a `codegraph` MCP server entry if it is missing. |
| `.gitignore`, `.gitattributes` | Appends missing lines. |
| `docs/kanban/board.json` | Created if missing. Upgrade keeps your tickets, replaces `$schema` and `_ticket_template`, adds missing top-level keys, and migrates legacy fields. |
| `handovers/HANDOVERS.md`, `.github/workflows/kanban-board.yml` | Created only if missing. Never overwritten. |
| `docs/kanban/protocol.md`, `handovers/_TEMPLATE.md`, `.claude/agents/ticket-worker.md`, `scripts/` | Owned by the template. Replaced on upgrade, so do not edit them. Template files that a later version removes are deleted on upgrade. The list is saved as `owned` in `.scrum-kanban.json`. |
| `core.hooksPath` | Set to `scripts/git-hooks` only if no other hook manager (Husky, lefthook, pre-commit, or a custom `core.hooksPath`) is present. Otherwise the installer tells you which hooks to call. |

Files it cannot merge safely (for example an `opencode.jsonc` with comments) are listed as `manual` steps.

### Options

| Option | Effect |
|---|---|
| `--dry-run` | Print what would change. Write nothing. |
| `--base-branch=<name>` | Branch that PRs target. Default `develop`. Saved in `.scrum-kanban.json`. |
| `--no-codegraph` | Skip CodeGraph: no MCP configs, no CodeGraph hooks, no CodeGraph rules. |
| `--no-git-hooks` | Do not set `core.hooksPath`. |
| `--no-ci` | Do not add the GitHub Actions board check. |

Choices are saved in `.scrum-kanban.json`. Commit that file; `upgrade` reads it.

### Upgrade and check

```sh
npx github:earnestangel/Scrum-Kanban-Template upgrade   # refresh protocol, scripts, board schema, and marked blocks
npx github:earnestangel/Scrum-Kanban-Template doctor    # check Node, CodeGraph, hooks, and the board
```

`upgrade` never touches handover notes, your tickets, or your text outside the marked blocks in `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`. In `board.json` it updates only the schema: `$schema`, `_ticket_template`, missing top-level keys, and legacy fields.

Upgrading from 0.1.x: `upgrade` replaces `wip_limit_per_worker` and `max_parallel_workers` with `"wip_limit": 1`. It also maps ticket `model` values `haiku`/`sonnet`/`opus` to `small`/`medium`/`large`. You can delete `.claude/worktrees/` from `.gitignore` and `codegraph.json`.

Upgrading from 0.2.x: `upgrade` sets `claimed_at` on any `IN_PROGRESS` ticket that has none. Older `DONE` tickets without a coordinator `REVIEW · … · DONE` entry produce warnings only, so CI keeps passing.

Upgrading from 0.3.x: the first `upgrade` records the template-owned files in `.scrum-kanban.json`. From the next upgrade on, files the template drops are deleted.

Upgrading from 0.4.x: the coordinator no longer runs tickets inline. It starts a worker on the ticket's tier (protocol section 6.3.1). `upgrade` adds the `worker-delegation.mjs` hook to `.claude/settings.json`, also in `--no-codegraph` installs. In Claude Code, a `ticket-worker` dispatch must pass the tier's `model`, and the main session cannot edit files outside `docs/kanban/` while a ticket is `IN_PROGRESS`. Your board needs no change. To keep the old inline behavior for a session, set `KANBAN_DELEGATE=off` (for example in `.claude/settings.local.json` under `env`). Other providers get the rule through `AGENTS.md` and the review check; they have no hook.

## CodeGraph (optional, recommended)

[CodeGraph](https://github.com/colbymchenry/codegraph) indexes your code so the coordinator can record exact queries during grooming and workers can load the code in one call. Without it, everything still works: hooks turn themselves off and `codegraph_queries` becomes optional in `board.json`.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
```

Wire it into your agents, then index the repository:

```sh
codegraph install
codegraph init -y
```

Add vendored or generated folders to `exclude` in `codegraph.json`. Check the MCP server with `/mcp` in Claude Code.

## What gets installed

### Claude Code hooks (`.claude/settings.json`)

| Hook | Script | Purpose |
|---|---|---|
| `SessionStart` | `scripts/hooks/session-sync.mjs` | Syncs the CodeGraph index; lists open handover flags. |
| `UserPromptSubmit` | `scripts/hooks/prompt-context.mjs` | Injects CodeGraph context for the prompt (main session only). Does nothing without an index. |
| `PreToolUse` (Agent, Edit, Write, NotebookEdit) | `scripts/hooks/worker-delegation.mjs` | Enforces worker tiers. Denies a `ticket-worker` dispatch whose `model` does not match the ticket's tier (`small`→`haiku`, `medium`→`sonnet`, `large`→`opus`), or that uses a worktree. While a ticket is `IN_PROGRESS`, denies main-session edits outside `docs/kanban/`, so the coordinator cannot do the worker's job. Installed with or without CodeGraph. `KANBAN_DELEGATE=off` disables it. |
| `PreToolUse` (Grep, Glob, Read, Bash, PowerShell) | `scripts/hooks/codegraph-first.mjs` | Denies the first code search per agent (Grep/Glob, whole-file Read of source, shell `grep`/`rg`/`find`/`cat`/`Select-String`) until `codegraph_explore` is used. Ranged Reads always pass. `CODEGRAPH_FIRST=strict` denies until CodeGraph is used; `off` disables. |

### Git hooks (`scripts/git-hooks/`)

`post-checkout`, `post-merge`, and `post-rewrite` run `codegraph sync -q` in the background, so the index stays current even when no agent session is open. They exit at once if CodeGraph or the index is missing.

If you use Husky or another hook manager, call them from your own hooks, for example in `.husky/post-merge`:

```sh
sh scripts/git-hooks/post-merge "$@"
```

### Web board (`scripts/kanban/board-server.mjs`)

A Jira-style view of `board.json`: one column per status, cards with type, epic, points, model tier, and assignee, and an epic strip with progress bars. Click a card to see every field of the ticket and its rendered handover notes. Filters and the open ticket live in the URL, so you can share a link.

```sh
node scripts/kanban/board-server.mjs --open   # http://127.0.0.1:4477
```

The server has no dependencies, listens on `127.0.0.1` only, and is read-only: it never writes `board.json`. The page reloads by itself when `board.json` or a handover note changes. Options: `--port=<n>` (or `PORT`), `--root=<dir>` to view another project's board.

### CI (`.github/workflows/kanban-board.yml`)

Runs `node scripts/kanban/render-board.mjs --check` on changes under `docs/kanban/`. It fails when `board.json` is invalid or `BOARD.md` is out of date.

## Daily use

| Task | How |
|---|---|
| Groom tickets | Coordinator fills the fields in `board.json` (`_ticket_template`) and writes a `GROOMING` entry in `docs/kanban/handovers/<ID>.md`. |
| Run a ticket | The coordinator starts a worker on the ticket's tier (protocol section 6.3.1): in Claude Code the `ticket-worker` subagent with `model` mapped from the tier; elsewhere a subagent or headless CLI run on the tier's model, or a hand-off to a new session. The coordinator never executes a ticket itself. Only one ticket runs at a time. |
| Handle a blocker | Worker sets `BLOCKED` with a `blocked_reason` and a `PROGRESS · … · BLOCKED` entry, then stops. That frees the WIP slot. Coordinator resolves it or asks you. |
| Recover a dead worker | At session start the coordinator checks for an `IN_PROGRESS` claim it did not make, asks you, then records leftover edits and sets `PAUSED` (protocol section 5.3). |
| Review and close | Coordinator reruns `verify_cmd`, checks acceptance, writes a `REVIEW · … · DONE` or `REWORK` entry (protocol sections 3.2–3.3). |
| Regenerate the board | `node scripts/kanban/render-board.mjs` |
| Validate the board (CI) | `node scripts/kanban/render-board.mjs --check` |
| Open the web board | `node scripts/kanban/board-server.mjs --open` |

## Contributing

Run the installer against a scratch repository to test changes:

```sh
git init /tmp/try && cd /tmp/try
node /path/to/Scrum-Kanban-Template/bin/scrum-kanban.mjs init --dry-run
```

Bump `version` in `package.json` when the protocol, scripts, or agent files change, so `doctor` shows which version a project has.
