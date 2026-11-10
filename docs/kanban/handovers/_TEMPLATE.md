# Handover Notes: [TICKET-ID] <Title>

<!--
Written only by scripts/kanban/ticket.mjs. Never edit it by hand or delete entries.
STATE (epic and story notes only) is the one block that is rewritten: ticket.mjs state. Everything below it is append-only.
Entry types: GROOMING (coordinator), PROGRESS (worker), REVIEW (coordinator), FLAG (any agent, about this ticket),
AMEND (coordinator: edit, status, and grooming entry --edit/--delete, with the old text), DECISION (the user's answer).
An entry that no longer holds is marked (SUPERSEDED) by note --supersedes; it is never removed.
The sections below are the entry bodies; ticket.mjs writes the headers. See docs/kanban/protocol.md section 6.
-->

---

## STATE · YYYY-MM-DDTHH:mm:ssZ · <coordinator agent/model>

**Scope**
- What is in and out of scope now.

**Order**
- What comes next, and why in that order.

**Decisions in force**
- ADRs and user decisions that apply, by ID.

**Open for the user**
- The `decisions_pending` entries that concern this epic or story, by ID. "Nothing" when there are none.

**Digest** (story only, before its children are archived; at most 40 lines)
- What was built, which decisions were made, which traps the next person must know.

---

## GROOMING · YYYY-MM-DDTHH:mm:ssZ · <coordinator agent/model>

**Approach**
- How the work should be done, in steps.

**Relevant code** (from CodeGraph during grooming)
- `path/to/file.ts:42` `Symbol.method`: why it matters.

**Design** (when the board declares design sources)
- `D-001` in `docs/design/flow.svg`: which part of the source this ticket builds, and what it must match.

**Pitfalls**
- Non-obvious constraints, edge cases, or traps found while exploring.

**Out of scope**
- What the worker must not change.

---

## PROGRESS · YYYY-MM-DDTHH:mm:ssZ · <worker agent/model> · PAUSED | BLOCKED | REVIEW | ABANDONED

**Files changed**
- `path/to/file.ts`: what changed.

**Verification**
- `verify_cmd` result (pass/fail, with the failing test names).
- Git branch and commit hash (if any).

**Decisions & gotchas**
- Choices made and why.

**Design check** (required for REVIEW when the board declares design sources)
- `D-001`: the source file you opened, and how the result matches it. Or "not applicable: <the design.na reason>".

**New CodeGraph queries**
- Queries that helped and were not in the ticket's `context.codegraph_queries`.

**Next steps**
- What the next agent should do.

**Unblock condition** (BLOCKED only)
- What must change before work can continue, and who can change it.

---

## REVIEW · YYYY-MM-DDTHH:mm:ssZ · <coordinator agent/model> · DONE | REWORK

**verify_cmd rerun**
- Result of the coordinator's own run.

**Acceptance**
- [x] Each acceptance item, checked against the diff.

**Worker tier**
- Worker named in the PROGRESS header, and whether it matches the ticket's `model` tier.

**Design** (required for DONE when the board declares design sources)
- What you compared with which design source, and the result.

**Knowledge** (required when a story or epic closes)
- Knowledge: the findings files written for it, or "none".

**Issues** (REWORK only)
- What the next worker must fix. The ticket goes back to TODO.

---

## FLAG · YYYY-MM-DDTHH:mm:ssZ · from <SOURCE-TICKET-ID> · <agent/model>

**Finding**: what was found, with `path/to/file.ts:line`.
**Impact on this ticket**: why it matters here and what to do about it.
