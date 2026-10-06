# Providers, Models, and Tiers

This guide covers how to run the Scrum Kanban workflow with any AI coding tool and any model, without
weakening the model-tier rule. The rule itself is in [protocol.md section 1.2](protocol.md). This guide
covers the setup for each tool.

- [1. Concepts](#1-concepts)
- [2. The tier map: `tiers.json`](#2-the-tier-map-tiersjson)
- [3. Board commands: `ticket.mjs`](#3-board-commands-ticketmjs)
- [4. Claude Code](#4-claude-code)
- [5. Claude Code with other models (LiteLLM, Bedrock, Vertex, gateways)](#5-claude-code-with-other-models-litellm-bedrock-vertex-gateways)
- [6. Codex CLI](#6-codex-cli)
- [7. Gemini CLI](#7-gemini-cli)
- [8. opencode](#8-opencode)
- [9. Any other agent (Oh My Pi, Aider, Cursor, Copilot, ...)](#9-any-other-agent-oh-my-pi-aider-cursor-copilot-)
- [10. Resuming a ticket on another model](#10-resuming-a-ticket-on-another-model)
- [11. User switches](#11-user-switches)
- [12. What is enforced where](#12-what-is-enforced-where)

## 1. Concepts

| Term | Meaning |
|---|---|
| **Tier** | `small`, `medium`, or `large`. A ticket's `model` field names a tier, never a model. The standing tier rule sets it: Story or Epic `large`, 1 pt `small`, everything else `medium`. Only the user overrides it, with `tier_override`. |
| **Tier map** | `docs/kanban/tiers.json`. It lists which concrete model IDs count as each tier in this project. Only the user edits it. |
| **Coordinator** | The main session. It grooms, dispatches, and reviews, and it must run a model listed for `large`. |
| **Worker** | A separate run that executes one ticket. It must run a model listed for the ticket's tier. |
| **Worker name** | `<provider-or-model>-<tier>`, for example `claude-medium`, `codex-small`, `gpt-6-luna-medium`. It goes into `assignee` and the `PROGRESS` header. |

The tier is the contract between grooming and execution. The tier map is how each project decides which
models meet that contract. So a team on Bedrock, a team on OpenAI, and a team on Claude all run the same
board, the same tickets, and the same protections.

## 2. The tier map: `tiers.json`

```json
{
  "tiers": {
    "large":  ["*opus*"],
    "medium": ["*sonnet*"],
    "small":  ["*haiku*"]
  }
}
```

- Each entry is a pattern for the **full model ID as your tool reports it**. Matching ignores case. `*` matches any characters, `/` included. `?` matches one character.
- A model may appear under several tiers. For example, a strong model may be listed for both `large` and `medium`.
- Without the file, the defaults above apply (Claude only).
- An invalid file fails `render-board.mjs`, and the hooks fall back to the defaults. A broken edit never widens a tier.
- Agents never edit this file. In Claude Code a hook denies the edit, and the git `pre-commit` hook rejects a staged change unless you commit with `KANBAN_ALLOW_TIER_EDIT=1`.

Examples:

```json
{
  "tiers": {
    "large":  ["*opus*", "bedrock/global.openai.gpt-6", "gpt-6", "gemini-*-pro*"],
    "medium": ["*sonnet*", "*gpt-6-luna*", "gemini-*-flash", "o*-mini"],
    "small":  ["*haiku*", "*gpt-6-nano*", "gemini-*-flash-lite"]
  }
}
```

To find the ID your tool reports:
- **Claude Code:** the `model` field of assistant lines in the session transcript (`~/.claude/projects/<project>/<session>.jsonl`). `/model` shows the alias. The transcript shows what the API answered with, including LiteLLM routing.
- **Other tools:** the model flag you pass (`-m`), or the model name the tool prints.
- **A gateway:** the model name your gateway logs.

`node scripts/kanban/ticket.mjs show <ID>` prints the ticket's tier and the models listed for it. `npx github:earnestangel/Scrum-Kanban-Template doctor` prints the whole map and checks what the Claude Code aliases resolve to.

## 3. Board commands: `ticket.mjs`

Every agent on every tool changes ticket state through one script. So the board, the headers, and the
tier checks are the same everywhere. Agents still edit the grooming fields (`context`, `acceptance`,
...) in `board.json` directly.

| Step | Command | Who |
|---|---|---|
| Claim (protocol 6.5 step 4) | `node scripts/kanban/ticket.mjs claim TASK-001 --worker codex-medium --model gpt-6-luna` | worker |
| Hand over (step 9) | `node scripts/kanban/ticket.mjs handover TASK-001 --status REVIEW --body progress.md` | worker |
| Block | `... handover TASK-001 --status BLOCKED --reason "API key missing" --body -` | worker |
| Grooming entry | `node scripts/kanban/ticket.mjs note TASK-001 --type GROOMING --agent claude-large --model claude-opus-5-5 --body groom.md` | coordinator |
| Flag another ticket | `node scripts/kanban/ticket.mjs note TASK-050 --type FLAG --from TASK-001 --agent codex-medium --summary "UserRepo.save has no transaction" --body -` | anyone |
| Review | `node scripts/kanban/ticket.mjs review TASK-001 --outcome DONE --reviewer claude-large --model claude-opus-5-5 --body review.md` | coordinator |
| Recover an orphaned claim (5.3) | `node scripts/kanban/ticket.mjs recover TASK-001 --coordinator claude-large --model claude-opus-5-5` | coordinator |
| Inspect | `node scripts/kanban/ticket.mjs show TASK-001` | anyone |

- `--body -` reads the entry body from stdin. `--text "<markdown>"` passes it inline. The body follows `handovers/_TEMPLATE.md`. The script writes the header itself, for example `## PROGRESS · 2026-10-06T14:05:00Z · codex-medium (gpt-6-luna) · REVIEW`.
- `claim` checks: status `TODO` or `PAUSED`, every `requires` ticket `DONE`, the WIP slot free, and `--model` listed for the ticket's tier. It records `worker_model` on the ticket.
- `note --type GROOMING`, `review`, and `recover` require a `--model` listed for `large`.
- Every command runs `render-board.mjs` afterwards. If the board does not validate, the command restores every file it changed and fails.
- `--model` must be the model you really run on. Claude Code checks it against the transcript. Other tools rely on the agent's honesty, with the review as a backstop (section 12).

## 4. Claude Code

Native Claude models need no setup. `init` installs the hooks, the `ticket-worker` subagent, and the default tier map.

- The coordinator runs Opus (`/model opus`). It dispatches `ticket-worker` with `model: "haiku" | "sonnet" | "opus"` for `small`, `medium`, and `large`.
- The `worker-delegation.mjs` hook resolves the alias to the real model ID and checks it against `tiers.json`. The protection list is in section 12.

## 5. Claude Code with other models (LiteLLM, Bedrock, Vertex, gateways)

Claude Code can run non-Anthropic models through a gateway such as LiteLLM. It sends the alias
(`opus`, `sonnet`, `haiku`) or a full ID, and the gateway routes it. The hooks check the model the API
**really answered with**, so the tier map must list those IDs.

**Step 1. Map aliases to your models** (shell profile, or `env` in `.claude/settings.local.json`):

```sh
export ANTHROPIC_BASE_URL=http://localhost:4000            # your LiteLLM proxy
export ANTHROPIC_DEFAULT_OPUS_MODEL=bedrock/global.anthropic.claude-opus-5-5
export ANTHROPIC_DEFAULT_SONNET_MODEL=bedrock/global.openai.gpt-6-luna
export ANTHROPIC_DEFAULT_HAIKU_MODEL=bedrock/global.openai.gpt-6-nano
```

**Step 2. List those models in `docs/kanban/tiers.json`.** You do this yourself, because agents cannot:

```json
{ "tiers": {
    "large":  ["*opus*"],
    "medium": ["*sonnet*", "*gpt-6-luna*"],
    "small":  ["*haiku*", "*gpt-6-nano*"] } }
```

**Step 3. Check:** `npx github:earnestangel/Scrum-Kanban-Template doctor` shows each tier's alias and the model it runs.

**How it behaves:**
- **Dispatch.** `ticket-worker` with `model: "sonnet"` runs `gpt-6-luna`. The hook allows it because `gpt-6-luna` is listed for `medium`, and it tells the coordinator to use the worker name `gpt-6-luna-medium`. Any alias works if it resolves to a listed model. If no alias resolves to a model listed for the ticket's tier, the dispatch is denied, and the message names what to add.
- **Coordinator on a non-Claude model.** Add that model to `large`, for example `"large": ["*opus*", "*gpt-6-luna*"]`. Then a session running `/model bedrock/global.openai.gpt-6-luna` may groom and review. Do this only if you trust that model with grooming.
- **`CLAUDE_CODE_SUBAGENT_MODEL`** forces every subagent onto one model. The hook resolves it, so workers on any tier that does not list that model are denied. `doctor` warns about it.
- **Gateway fallbacks.** If LiteLLM falls back to another model, the transcript shows it. The next `ticket.mjs` call or board edit from that worker is checked against the real model.
- **Server-side tools.** Some gateways reject Anthropic server tools such as web search. That does not affect the board scripts.

## 6. Codex CLI

Codex reads `AGENTS.md` itself. `init` adds the CodeGraph MCP server to `.codex/config.toml`. Codex has no hooks, so the coordinator dispatches workers as headless runs:

```sh
codex exec -m gpt-6-luna --sandbox workspace-write \
  "Ticket: TASK-001. Worker name: codex-medium. Model ID: gpt-6-luna.
You are the worker. Follow the Worker Procedure in docs/kanban/protocol.md section 6.5 and the Agent Invariants in section 1.3."
```

- The worker must write `docs/kanban/` and run `node`, so the default read-only sandbox is not enough. You choose the sandbox and approval flags, and the coordinator asks you before the first run (protocol 6.3.1).
- Put the model ID in the prompt, so the worker passes the right `--model` to `ticket.mjs claim`.
- If Codex is the coordinator, list its model under `large`.

## 7. Gemini CLI

`GEMINI.md` imports `AGENTS.md`. `init` adds the CodeGraph MCP server to `.gemini/settings.json`.

```sh
gemini -m gemini-3-flash -p "Ticket: TASK-001. Worker name: gemini-medium. Model ID: gemini-3-flash.
You are the worker. Follow the Worker Procedure in docs/kanban/protocol.md section 6.5 and the Agent Invariants in section 1.3."
```

List the Gemini model IDs you use in `tiers.json`, for example `"medium": ["gemini-*-flash"]`.

## 8. opencode

opencode reads `AGENTS.md`. `init` adds CodeGraph to `opencode.jsonc`. Define one subagent per tier, each pinned to a model listed for that tier, for example in `opencode.jsonc`:

```jsonc
{
  "agent": {
    "worker-medium": {
      "mode": "subagent",
      "model": "openai/gpt-6-luna",
      "prompt": "You are a ticket worker. Follow docs/kanban/protocol.md section 6.5 and section 1.3. Pass --model openai/gpt-6-luna to ticket.mjs."
    }
  }
}
```

Headless: `opencode run -m openai/gpt-6-luna "<worker prompt>"`.

## 9. Any other agent (Oh My Pi, Aider, Cursor, Copilot, ...)

The workflow needs three things from a tool:
1. **Read the rules.** It loads `AGENTS.md`, or you point it there ("Read AGENTS.md and docs/kanban/protocol.md first"). If the tool has its own instructions file, put one line in it: `Follow AGENTS.md.`
2. **Run `node`.** It needs a shell, for `ticket.mjs` and `render-board.mjs`.
3. **Read code.** CodeGraph is optional. With MCP support, add the server `codegraph serve --mcp`. Without MCP, the agent runs `codegraph explore "<query>"` in the shell.

Then pick the matching row of protocol 6.3.1:
- **Subagents with a model setting:** one subagent per tier, as in opencode.
- **Headless CLI with a model flag:** a headless run per ticket, as in Codex.
- **Neither:** hand off. The coordinator prints the worker prompt and the tier, and you run it in a new session on a model listed for that tier.

Check that the tool's model IDs are in `tiers.json`. Run `ticket.mjs show <ID>` to see what a ticket needs.

## 10. Resuming a ticket on another model

Groomed by Opus, resumed on `gpt-6-luna`? Everything a worker needs is in `board.json` and the
handover notes, so any model can resume. Only the tier decides whether it may.

1. **If the ticket is still `IN_PROGRESS`** from a dead worker, the coordinator recovers it first: `ticket.mjs recover <ID> ...` sets `PAUSED` and records the leftover edits. Recovery is coordinator work, so it needs a `large` model.
2. **If the new model is listed for the ticket's tier**, start it as a normal worker on any tool. It claims with `ticket.mjs claim <ID> --worker gpt-6-luna-medium --model <id>`, reads the last `PROGRESS` entry, and continues.
3. **If the new model is not listed for that tier**, choose one:
   - **Add it to `tiers.json`.** This counts for every ticket of that tier.
   - **Approve it for this ticket only.** Start the session with `KANBAN_INLINE=<ID>`. `ticket.mjs claim` accepts the mismatch and the Claude Code hooks allow it. The worker must record your approval in its `PROGRESS` entry, and `render-board.mjs` warns while the ticket is in progress.
   - **Change the ticket's tier.** Add `tier_override` yourself.
4. **To resume inline in a Claude Code session** on a model that is not `large`, set `KANBAN_INLINE=<ID>`. That session may then claim, edit project files for that ticket, and hand over. It still may not groom, review, close tickets, or touch `tier_override` or `tiers.json`. Review needs a `large` session.

## 11. User switches

These environment variables are for the user. Agents never set them, and the protocol forbids them from asking for them as a shortcut.

| Variable | Effect |
|---|---|
| `KANBAN_INLINE=TASK-001[,BUG-002]` | The listed tickets may be executed by the current session on any model, including the coordinator session. Tier mismatches are allowed and shown. Grooming, review, `tier_override`, and `tiers.json` stay protected. |
| `KANBAN_ALLOW_TIER_EDIT=1` | The git `pre-commit` hook accepts staged changes to `tier_override` or `tiers.json`. Set it only for a commit you made yourself. |
| `KANBAN_DELEGATE=off` | Disables the Claude Code `worker-delegation.mjs` hook and the `ticket.mjs` tier checks. Last resort. |
| `CODEGRAPH_FIRST=strict` or `off` | CodeGraph-first hook mode (Claude Code). |

## 12. What is enforced where

| Protection | Claude Code hooks | `ticket.mjs` (any tool) | git `pre-commit` (any tool) | CI | Otherwise |
|---|---|---|---|---|---|
| Board validates, `BOARD.md` current | — | yes | yes | yes | — |
| Lenient handover headers (`·`, `-`, `\|`, `•`) | — | writes canonical | yes | yes | — |
| Worker model fits the ticket tier | dispatch + real transcript model | `--model` on claim | — | warning on `worker_model` | review checks the `PROGRESS` header |
| Coordinator on `large` | real transcript model | `--model` on grooming, review, recover | — | — | review |
| Coordinator never executes | yes (unless `KANBAN_INLINE`) | — | — | — | protocol |
| `tier_override` user-only | yes | never written | yes | — | protocol |
| `tiers.json` user-only | yes | never written | yes | — | protocol |
| No shell writes to `board.json` | heuristic | — | — | — | protocol |
| One ticket in progress | yes | yes | yes | yes | — |

**Where it stops:** on tools without hooks, nothing stops an agent from passing a wrong `--model`.
The protocol forbids it. The worker name and `worker_model` make it visible, and the coordinator checks
the `PROGRESS` header at review (protocol 6.3.2). Turn on the git hooks
(`git config core.hooksPath scripts/git-hooks`, which `init` does) so every tool gets the `pre-commit`
check.
