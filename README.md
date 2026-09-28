# Scrum Kanban Agent Workflow

An Opus coordinator grooms tickets and hands them to Sonnet workers. Rules: [AGENTS.md](AGENTS.md) and [docs/kanban/protocol.md](docs/kanban/protocol.md).

## Setup

### 1. Install CodeGraph

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
```

Wire it into your agents, then index the code repository:

```sh
codegraph install
codegraph init -y
```

`codegraph.json` excludes `.claude/worktrees/` (parallel worker checkouts) and IDE folders from the index. Add vendored or generated folders there.

Check that the MCP server is connected: run `/mcp` in Claude Code, or see your agent's MCP help page.

### 2. Install the git hooks

These run `codegraph sync -q` after checkout, merge, and rebase, so the index stays current even when no agent session is open.

```sh
git config core.hooksPath scripts/git-hooks
```

### 3. Claude Code hooks (already configured in `.claude/settings.json`)

| Hook | Script | Purpose |
|---|---|---|
| `SessionStart` | `scripts/hooks/session-sync.mjs` | Syncs the CodeGraph index; lists open handover flags. |
| `UserPromptSubmit` | `codegraph prompt-hook` | Injects CodeGraph context for the prompt (main session only). |
| `PreToolUse` (Grep, Glob, Read, Bash, PowerShell) | `scripts/hooks/codegraph-first.mjs` | Denies the first code search per agent (Grep/Glob, whole-file Read of source, shell `grep`/`rg`/`find`/`cat`/`Select-String`) until `codegraph_explore` is used. Ranged Reads always pass. `CODEGRAPH_FIRST=strict` denies until CodeGraph is used; `off` disables. |

Requires Node.js 18+ on `PATH`.

## Daily use

| Task | How |
|---|---|
| Groom tickets | Coordinator fills the fields in `board.json` (`_ticket_template`) and writes a `GROOMING` entry in `docs/kanban/handovers/<ID>.md`. |
| Dispatch a worker | Agent tool, `subagent_type: "ticket-worker"`, `model: <ticket.model>`, prompt: ticket ID, worker name, main repo root. Add `isolation: "worktree"` for parallel workers (needs at least one commit). |
| Regenerate the board | `node scripts/kanban/render-board.mjs` |
| Validate the board (CI) | `node scripts/kanban/render-board.mjs --check` |
