# Scrum Kanban Agent Workflow

A Scrum Kanban workflow for AI coding agents. An Opus coordinator grooms tickets once, with full context. Cheaper Sonnet workers then execute them without rediscovering the code. The board lives in your repository as `docs/kanban/board.json`, validated by a zero-dependency Node script.

Works with Claude Code out of the box. The rules in `AGENTS.md` also load in Codex, Gemini CLI, opencode, and other agents that read `AGENTS.md`.

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
| `CLAUDE.md`, `GEMINI.md` | Appends `@AGENTS.md` if it is missing. |
| `.claude/settings.json` | Adds the hooks and the `mcp__codegraph__*` permission. Your hooks and permissions stay. |
| `.mcp.json`, `.gemini/settings.json`, `.vscode/mcp.json`, `.codex/config.toml`, `codegraph.json` | Adds a `codegraph` MCP server entry if it is missing. |
| `.gitignore`, `.gitattributes` | Appends missing lines. |
| `docs/kanban/board.json`, `handovers/HANDOVERS.md`, `.github/workflows/kanban-board.yml` | Created only if missing. Never overwritten. |
| `docs/kanban/protocol.md`, `.claude/agents/ticket-worker.md`, `scripts/` | Owned by the template. Replaced on upgrade, so do not edit them. |
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
npx github:earnestangel/Scrum-Kanban-Template upgrade   # refresh protocol, scripts, and agent files
npx github:earnestangel/Scrum-Kanban-Template doctor    # check Node, CodeGraph, hooks, and the board
```

`upgrade` never touches `board.json`, handover notes, or your text outside the marked block in `AGENTS.md`.

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

`codegraph.json` excludes `.claude/worktrees/` (parallel worker checkouts). Add vendored or generated folders there. Check the MCP server with `/mcp` in Claude Code.

## What gets installed

### Claude Code hooks (`.claude/settings.json`)

| Hook | Script | Purpose |
|---|---|---|
| `SessionStart` | `scripts/hooks/session-sync.mjs` | Syncs the CodeGraph index; lists open handover flags. |
| `UserPromptSubmit` | `scripts/hooks/prompt-context.mjs` | Injects CodeGraph context for the prompt (main session only). Does nothing without an index. |
| `PreToolUse` (Grep, Glob, Read, Bash, PowerShell) | `scripts/hooks/codegraph-first.mjs` | Denies the first code search per agent (Grep/Glob, whole-file Read of source, shell `grep`/`rg`/`find`/`cat`/`Select-String`) until `codegraph_explore` is used. Ranged Reads always pass. `CODEGRAPH_FIRST=strict` denies until CodeGraph is used; `off` disables. |

### Git hooks (`scripts/git-hooks/`)

`post-checkout`, `post-merge`, and `post-rewrite` run `codegraph sync -q` in the background, so the index stays current even when no agent session is open. They exit at once if CodeGraph or the index is missing.

If you use Husky or another hook manager, call them from your own hooks, for example in `.husky/post-merge`:

```sh
sh scripts/git-hooks/post-merge "$@"
```

### CI (`.github/workflows/kanban-board.yml`)

Runs `node scripts/kanban/render-board.mjs --check` on changes under `docs/kanban/`. It fails when `board.json` is invalid or `BOARD.md` is out of date.

## Daily use

| Task | How |
|---|---|
| Groom tickets | Coordinator fills the fields in `board.json` (`_ticket_template`) and writes a `GROOMING` entry in `docs/kanban/handovers/<ID>.md`. |
| Dispatch a worker | Agent tool, `subagent_type: "ticket-worker"`, `model: <ticket.model>`, prompt: ticket ID, worker name, main repo root. Add `isolation: "worktree"` for parallel workers (needs at least one commit). |
| Regenerate the board | `node scripts/kanban/render-board.mjs` |
| Validate the board (CI) | `node scripts/kanban/render-board.mjs --check` |

## Contributing

Run the installer against a scratch repository to test changes:

```sh
git init /tmp/try && cd /tmp/try
node /path/to/Scrum-Kanban-Template/bin/scrum-kanban.mjs init --dry-run
```

Bump `version` in `package.json` when the protocol, scripts, or agent files change, so `doctor` shows which version a project has.
