# Setup

Requires Node.js 18+ and git. Back to the [README](../README.md).

## New project

Click **Use this template** on GitHub, or run the installer in an empty repository:

```sh
git init my-app && cd my-app
npx github:earnestangel/Scrum-Kanban-Template init
```

## Existing project

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
| `.claude/settings.json` | Adds the hooks and the `mcp__codegraph__*` permission. Your hooks and permissions stay. Hooks that run a template script (`scripts/hooks/*.mjs`) are replaced by the template's current ones. |
| `.mcp.json`, `.gemini/settings.json`, `.vscode/mcp.json`, `.codex/config.toml`, `codegraph.json` | Adds a `codegraph` MCP server entry if it is missing. |
| `.gitignore`, `.gitattributes` | Appends missing lines. |
| `docs/kanban/board.json` | Created if missing. Upgrade keeps your tickets and runs `scripts/kanban/migrate.mjs`: it replaces `$schema` and `_ticket_template`, adds missing top-level keys, and migrates older fields. |
| `docs/kanban/tiers.json` | Created with the Claude defaults if missing. After that it is yours; nothing overwrites it. |
| `docs/kanban/KNOWLEDGE.md` | Created if missing, with one line per file in your findings folder. After that, `ticket.mjs finding` maintains it. |
| `handovers/HANDOVERS.md`, `.github/workflows/kanban-board.yml` | Created only if missing. Never overwritten. |
| `docs/kanban/protocol.md`, `docs/kanban/providers.md`, `handovers/_TEMPLATE.md`, `.claude/agents/ticket-worker.md`, `scripts/` | Owned by the template. Replaced on upgrade, so do not edit them. Template files that a later version removes are deleted on upgrade. The list is saved as `owned` in `.scrum-kanban.json`. |
| `core.hooksPath` | Set to `scripts/git-hooks` only if no other hook manager (Husky, lefthook, pre-commit, or a custom `core.hooksPath`) is present. Otherwise the installer tells you which hooks to call. |

Files it cannot merge safely (for example an `opencode.jsonc` with comments) are listed as `manual` steps.

## Options

| Option | Effect |
|---|---|
| `--dry-run` | Print what would change. Write nothing. |
| `--base-branch=<name>` | Branch that PRs target. Default `develop`. Saved in `.scrum-kanban.json`. |
| `--no-codegraph` | Skip CodeGraph: no MCP configs, no CodeGraph hooks, no CodeGraph rules. |
| `--no-git-hooks` | Do not set `core.hooksPath`. |
| `--no-ci` | Do not add the GitHub Actions board check. |

Choices are saved in `.scrum-kanban.json`. Commit that file; `upgrade` reads it.

## After the install

1. Optional: install CodeGraph and index the repository ([codegraph.md](codegraph.md)).
2. Commit the new files. PRs target the base branch; create that branch if it does not exist.
3. Run `npx github:earnestangel/Scrum-Kanban-Template doctor`. It checks Node, CodeGraph, the hooks, the tier map, and the board.
4. If you use models other than Claude, list them in `docs/kanban/tiers.json` ([providers.md](kanban/providers.md)).
5. If the project has a design (a solution diagram, contract pages), turn on the design anchor ([design-anchor.md](design-anchor.md)).
6. If your ADRs or findings are not in `docs/adr` and `docs/findings`, set `adr.dir` and `knowledge.dir` in `board.json`. The installer picks an existing `docs/decisions` or `docs/adrs` by itself.

## Check and upgrade

```sh
npx github:earnestangel/Scrum-Kanban-Template upgrade   # refresh protocol, scripts, board schema, and marked blocks
npx github:earnestangel/Scrum-Kanban-Template doctor    # check Node, CodeGraph, hooks, and the board
```

`upgrade` never touches handover notes, your tickets' own fields, `tiers.json`, or your text outside the marked blocks in `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`. Notes per version: [upgrade.md](upgrade.md).
