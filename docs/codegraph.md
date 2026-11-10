# CodeGraph (optional, recommended)

Back to the [README](../README.md).

[CodeGraph](https://github.com/colbymchenry/codegraph) indexes your code so the coordinator can record exact queries during grooming and workers can load the code in one call. Without it, everything still works: the hooks turn themselves off and `codegraph_queries` becomes optional in `board.json`. A repository without a `.codegraph/` directory is not affected by anything on this page.

## Install

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

After `codegraph install`, open `.claude/settings.json`. If it added a `UserPromptSubmit` hook that runs `codegraph prompt-hook`, remove that entry unless you want it (see "No prompt hook" below). `doctor` and `upgrade` tell you when it is there.

## How the template uses it

| Where | What happens | Enforced by |
|---|---|---|
| Grooming | The coordinator explores with `codegraph_explore` and records the queries that found the code in `context.codegraph_queries`. Required when the repository has an index. | `render-board.mjs`, `ticket.mjs groom` |
| Worker Procedure, step 5 | The worker runs **all** of the ticket's `codegraph_queries` before any other code search, with the MCP tool or `codegraph explore "<query>"` in the shell. This is the rule, on every provider. | protocol 6.5, 7; `AGENTS.md` |
| Claude Code `PreToolUse` | The first **code** search per agent is denied once, with a reminder, until CodeGraph is used. A safety net for the rule above. | `scripts/hooks/codegraph-first.mjs` |
| Session start, git checkout, merge, rebase | `codegraph sync -q` runs in the background, so the index covers edits made while no daemon was running. | `scripts/hooks/session-sync.mjs`, `scripts/git-hooks/post-*` |
| MCP configs | `init` adds a `codegraph` server to `.mcp.json`, `.gemini/settings.json`, `.vscode/mcp.json`, `.codex/config.toml`, and `opencode.jsonc`. | installer |

## Decisions in 0.9, and why

**"CodeGraph first for code" stays the ticket-level rule.** It is where CodeGraph pays: grooming already found the code, so the worker repeats a checked query instead of searching again on a cheaper model. The rule is in the Worker Procedure for every provider; the hook only backs it up in Claude Code.

**The `PreToolUse` hook now fires on code only.** Before 0.9 it treated every Grep, Glob, `grep`, and `find` as a code search. A coordinator that read ADRs, handover notes, or the board got a deny, and lost a tool call each time, for text CodeGraph does not index. Now a lookup is skipped when its target is not code: a Markdown, JSON, YAML, TOML, text, or log file, or anything under `docs/`, `.github/`, or `.claude/`. Examples that pass: `Grep` with `glob: "*.md"`, `Glob` for `docs/**/*.md`, `grep -n Status docs/decisions/*.md`, `cat docs/kanban/handovers/EPIC-001.md`. Examples that still get the one reminder: `Grep` with no file filter, `Glob` for `src/**/*.ts`, a whole-file `Read` of a source file, `grep -rn login src/`. A ranged `Read` always passes. The deny-once behavior is kept, because one refused call with a clear message is cheaper than a worker that greps its way through the code.

**No prompt hook.** Before 0.9 the template installed a `UserPromptSubmit` hook (`scripts/hooks/prompt-context.mjs`) that ran `codegraph prompt-hook` on every prompt. It is removed, for three reasons:
- It guesses from the prompt text. A prompt that was not about code (a project review, a question about the board) still got about 16 KB of symbol source that had nothing to do with it. That cost is paid on every turn of a long coordinator session.
- `codegraph install` registers its own `codegraph prompt-hook` entry. A project that ran both had the injection twice.
- The workflow does not need it. A worker gets its code through `codegraph_queries`, which grooming checked. The coordinator calls `codegraph_explore` when it wants code.

`upgrade` deletes the template's hook and its script. It does not delete the entry `codegraph install` made, because that one is yours; it prints a `manual` line so you can decide.

**Session-start sync runs in the background.** Before 0.9 the `SessionStart` hook waited for `codegraph sync`, up to 90 seconds on a large repository. Now it starts the sync and returns. The first query of a session may see an index that is a few seconds old; "If results look stale, run `codegraph sync` and retry" still covers that.

**Without an index, nothing runs.** Every hook checks for `.codegraph/codegraph.db` first and exits when it is missing. `codegraph_queries` is then optional. Indexing is your decision; agents do not run `codegraph init`.

## Switches

| Variable | Effect |
|---|---|
| `CODEGRAPH_FIRST=strict` | Deny every code search until CodeGraph has been used, not only the first. |
| `CODEGRAPH_FIRST=off` | Disable the `PreToolUse` hook. |

`--no-codegraph` on `init` skips all of it: no MCP configs, no CodeGraph hook, no CodeGraph rules in `AGENTS.md`.
