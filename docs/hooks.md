# Hooks and checks

Back to the [README](../README.md). What is enforced where, for every tool: [providers.md section 12](kanban/providers.md#12-what-is-enforced-where).

The rules do not depend on Claude Code hooks. Every rule that can be checked is checked by `scripts/kanban/ticket.mjs` (when an agent changes the board) and by `scripts/kanban/render-board.mjs` (at session start, at commit, in CI). The Claude Code hooks stop a mistake earlier, in the tool; they are a safety net.

## Claude Code hooks (`.claude/settings.json`)

| Hook | Script | Purpose |
|---|---|---|
| `SessionStart` | `scripts/hooks/session-sync.mjs` | Starts a CodeGraph sync in the background. Prints the session brief: the active ticket, blocked tickets, the result of `render-board.mjs --check` (what waits on the user, ADRs that are not accepted, stories and epics ready to close, design files that changed, board errors), the tier map, and open handover flags. |
| `PreToolUse` (Agent, Edit, Write, NotebookEdit, Bash, PowerShell) | `scripts/hooks/worker-delegation.mjs` | Enforces the standing tier rule (Story `large`, 1 pt `small`, else `medium`) against `docs/kanban/tiers.json`. Works with any model Claude Code runs, including LiteLLM and Bedrock. It denies: a `ticket-worker` dispatch whose model, after resolving `ANTHROPIC_DEFAULT_*_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`, is not listed for the ticket's tier; a ticket whose tier breaks the rule; a worktree; a claim from an agent whose real model (from its transcript) is not listed for the tier; coordinator commands (`create`, `groom`, `edit`, `status`, grooming notes, `note --supersedes`, `state`, `review`, `close`, `archive`, `recover`, `decision`, `design`, `element`) from a subagent or a main session whose model is not listed for `large`; agent edits of `tiers.json`; and Edit, Write, or shell writes on `board.json`, `board-archive.json`, `design.json`, `BOARD.md`, and `handovers/` from any agent, the coordinator included (it names the `ticket.mjs` command to use). While a ticket is `IN_PROGRESS`, it denies main-session edits outside `docs/kanban/`, the findings folder, the ADR folder, and the `coordinator_paths` globs in `board.json` (for example `["CHANGELOG.md", "notes/"]`). A story or epic that is `IN_PROGRESS` because its children are worked does not count. Installed with or without CodeGraph. `KANBAN_INLINE=<ID>` lets you approve inline work for one ticket; `KANBAN_DELEGATE=off` disables the hook. |
| `PreToolUse` (Grep, Glob, Read, Bash, PowerShell) | `scripts/hooks/codegraph-first.mjs` | Denies the first **code** search per agent (Grep or Glob over code, whole-file Read of source, shell `grep`/`rg`/`find`/`cat`/`Select-String` on code) until `codegraph_explore` is used. It does not fire on Markdown, ADRs, notes, JSON, YAML, or anything under `docs/`. Ranged Reads always pass. `CODEGRAPH_FIRST=strict` denies until CodeGraph is used; `off` disables. Reasons: [codegraph.md](codegraph.md). |

There is no `UserPromptSubmit` hook since 0.9 ([codegraph.md](codegraph.md)).

The hook matches the text of a shell command. A command that only mentions `ticket.mjs <command>` or a board file path, for example inside a here-document, can be denied by mistake. Put such text in a file and run the file.

## Git hooks (`scripts/git-hooks/`)

`pre-commit` runs `scripts/kanban/precommit-check.mjs` on every commit of a repository that has a board. It reads only staged content. It:
- validates the staged board and checks that the staged `BOARD.md` is up to date. With the design anchor on, a design source whose staged content differs from its recorded hash fails the commit, and so does a ledger row with no ticket and no accepted ADR;
- rejects agent changes to `tier_override` or `tiers.json`;
- rejects a staged `board.json`, `board-archive.json`, `design.json`, or note that `ticket.mjs` did not write (it compares a hash that `ticket.mjs` records in the git-ignored `docs/kanban/.script-writes.json`);
- rejects a staged change that sets an ADR to an accepted status.

It is the one local check that every tool gets, because every tool commits through git. The user's switches, for a commit the user makes:

| You did this yourself | Commit with |
|---|---|
| Changed a `tier_override` or `tiers.json` | `KANBAN_ALLOW_TIER_EDIT=1 git commit ...` |
| Edited a board file by hand on purpose, such as a resolved merge conflict | `KANBAN_ALLOW_MANUAL_EDIT=1 git commit ...` |
| Accepted an ADR | `KANBAN_ALLOW_ADR_ACCEPT=1 git commit ...` |

Agents never set them.

`post-checkout`, `post-merge`, and `post-rewrite` run `codegraph sync -q` in the background, so the index stays current even when no agent session is open. They exit at once if CodeGraph or the index is missing.

If you use Husky or another hook manager, call them from your own hooks, for example in `.husky/pre-commit` and `.husky/post-merge`:

```sh
sh scripts/git-hooks/pre-commit
sh scripts/git-hooks/post-merge "$@"
```

## CI (`.github/workflows/kanban-board.yml`)

Runs `node scripts/kanban/render-board.mjs --check` on changes under `docs/kanban/`. It fails when `board.json` is invalid or `BOARD.md` is out of date. If you turn on the design anchor, add the paths of your design sources and your ADR folder to the workflow's `paths`, so a change to a design file runs the check too. The file is yours after the install; `upgrade` does not overwrite it.
