# Contributing to the template

Back to the [README](../README.md).

Run the tests (Node's built-in runner, no dependencies): `npm test`. They are not shipped to installed projects. They start many `node` and `git` processes; on Windows the full run takes a few minutes.

| File | Covers |
|---|---|
| `test/ticket.test.mjs` | Board commands, tiers, stamps, claims. |
| `test/context.test.mjs` | Derived containers, `close`, decisions, order, `STATE`, supersedes, `context`, archive, knowledge, velocity, the design anchor, and `migrate.mjs`. |
| `test/precommit.test.mjs` | The git `pre-commit` check. |
| `test/worker-delegation.test.mjs`, `test/hooks.test.mjs` | The Claude Code hooks, and the installer's hook refresh. |
| `test/installer.test.mjs`, `test/tier-policy.test.mjs` | The installer and the tier rule. |

Run the installer against a scratch repository to test changes:

```sh
git init /tmp/try && cd /tmp/try
node /path/to/Scrum-Kanban-Template/bin/scrum-kanban.mjs init --dry-run
```

Rules for a change:
- A new rule is a field or a command that `render-board.mjs` or `ticket.mjs` rejects when it is missing. A sentence in `protocol.md` alone is not a rule. Add a test for it.
- Keep it provider-agnostic. A Claude Code hook may back a rule up; it is never the only enforcement.
- The template's own `docs/kanban/board.json` is written by `node scripts/kanban/migrate.mjs`, which owns `$schema` and `_ticket_template`. To add a ticket field, add it to `TICKET_TEMPLATE` in `scripts/kanban/migrate.mjs` and run the script. Do not edit `board.json` by hand; the hook and the `pre-commit` check refuse it.
- A board that the previous version wrote must still load. Put the change of an older board into `scripts/kanban/migrate.mjs`, keep it safe to run twice, and describe it in [upgrade.md](upgrade.md).
- Bump `version` in `package.json` when the protocol, scripts, or agent files change, so `doctor` shows which version a project has. Add the version to [CHANGELOG.md](../CHANGELOG.md) and mark breaking changes.
