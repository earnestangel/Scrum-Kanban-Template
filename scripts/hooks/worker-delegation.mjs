#!/usr/bin/env node
// Claude Code PreToolUse hook: tier and role rules for the coordinator and its workers (protocol.md
// sections 1.2, 1.3, 6.3.1). Works with any model Claude Code runs, including LiteLLM, Bedrock, Vertex,
// or other gateways: docs/kanban/tiers.json (user-owned) says which model IDs count as each tier.
//
// - Agent (or legacy Task) dispatch of "ticket-worker": the prompt names a groomed, startable ticket whose
//   tier follows the standing tier rule (scripts/kanban/tier-policy.mjs), no worktree, and the model the
//   dispatch really runs on fits the ticket's tier. The Agent `model` alias is resolved through
//   CLAUDE_CODE_SUBAGENT_MODEL and ANTHROPIC_DEFAULT_<ALIAS>_MODEL before the check.
// - board.json, BOARD.md, handovers/, .script-writes.json: no agent edits them by hand, whatever its
//   model or role (Edit/Write/MultiEdit/NotebookEdit, and shell writes). Every change goes through
//   scripts/kanban/ticket.mjs, which stamps it (protocol 6.1). tiers.json: only the user edits it.
// - ticket.mjs calls: --model must be the model the calling agent really runs on; coordinator commands
//   (create, groom, edit, status, GROOMING notes, review, recover) need a main session on the large tier;
//   the coordinator claims only a 1 point chore (protocol 6.3.1).
// - While a ticket is IN_PROGRESS, project files belong to its worker. The main session may edit
//   docs/kanban/, the board.json "coordinator_paths" globs, and files outside the repository.
//
// The user's switches (agents never set them):
//   KANBAN_INLINE=TASK-001[,BUG-002]  this session may execute the listed tickets itself: claim, edit, hand
//                                     over, on any model. A tier mismatch is allowed and shown. It does not
//                                     allow grooming, review, tier_override, or tiers.json changes.
//   KANBAN_DELEGATE=off               disables this hook.

import path from 'node:path';
import { BOARD_FILE, BOARD_MD, HANDOVER_DIR, SCRIPT_WRITES_FILE, loadBoard, tickets as flatten } from '../kanban/board-lib.mjs';
import { TIERS_FILE, aliasForTier, coordinatorMayRun, loadTierModels, modelFitsTier, requiredTier, resolveClaudeAlias, tierProblem, tiersOfModel } from '../kanban/tier-policy.mjs';
import { agentTranscript, allowWithNote, deny, lastModel, readEvent } from './hook-lib.mjs';

if (process.env.KANBAN_DELEGATE === 'off') process.exit(0);
const event = await readEvent();
if (!event) process.exit(0);

const root = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? event.cwd ?? process.cwd());
let board, tickets;
try {
  board = loadBoard(root);
  tickets = flatten(board);
} catch {
  process.exit(0); // No board, or a broken one: render-board.mjs reports that.
}
const { models: tierModels, source: tierSource } = loadTierModels(root);
const fits = (model, tier) => modelFitsTier(model, tier, tierModels);
const listed = (tier) => tierModels[tier].join(', ');
const inline = new Set((process.env.KANBAN_INLINE ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const tool = event.tool_name;
const ti = event.tool_input ?? {};
const byId = new Map(tickets.map((t) => [t.id, t]));
const active = tickets.filter((t) => t.status === 'IN_PROGRESS');
const isSub = !!event.agent_id;
// Older Claude Code versions send no agent_type; trust them as workers.
const isWorker = isSub && (event.agent_type ?? 'ticket-worker') === 'ticket-worker';
// The model the calling agent really runs on, from its transcript. Null when unknown; checks that need it pass.
const actorModel = isSub ? lastModel(agentTranscript(event), { sidechain: true }) : lastModel(event.transcript_path);
const isCoordinator = !isSub && (actorModel === null || fits(actorModel, 'large'));
const largeAlias = aliasForTier('large', tierModels) ?? 'a model listed for "large"';
const whoAmI = isSub ? `the ${event.agent_type ?? 'ticket-worker'} subagent (${actorModel ?? 'model unknown'})` : `this session (${actorModel})`;
const notCoordinator = () =>
  `Coordinator work (grooming, board updates, reviews) needs the large tier: a model listed for "large" in ${tierSource} (${listed('large')}). ` +
  `${whoAmI} is not. Ask the user to switch with /model ${largeAlias}, or to add this model to "large" in ${TIERS_FILE} (protocol 1.1, 1.2).`;
// Board files no agent edits by hand: [shell pattern, repository path, the ticket.mjs commands to use].
const BOARD_PATHS = [
  ['board\\.json', BOARD_FILE, 'create, groom, and edit for fields, status for coordinator moves, claim and handover for workers'],
  ['BOARD\\.md', BOARD_MD, 'every command renders it; render-board.mjs regenerates it'],
  // _TEMPLATE.md is template-owned text, not board data.
  ['handovers[\\\\/](?!_TEMPLATE\\.md)', `${HANDOVER_DIR}/`,'note --type GROOMING or FLAG, handover, review; fix a grooming entry with note --type GROOMING --edit <n> | --delete <n> --reason <text>'],
  ['\\.script-writes\\.json', SCRIPT_WRITES_FILE, 'ticket.mjs records it'],
];
const handEdit = (rel) =>
  `Nobody edits ${rel} by hand (protocol 6.1). Use node scripts/kanban/ticket.mjs: ${BOARD_PATHS.find(([, r]) => r === rel)[2]}. ` +
  'It stamps every change with the time, agent, role, model, and tier. Run it without arguments for the usage.';

// ---------- worker dispatch ----------
if (tool === 'Agent' || tool === 'Task') {
  if (ti.subagent_type !== 'ticket-worker') process.exit(0);
  const id = (String(ti.prompt ?? '').match(/\b[A-Z]+-\d+\b/g) ?? []).find((m) => byId.has(m));
  if (!id) deny('Name the ticket in the ticket-worker prompt, for example "Ticket: TASK-001. Worker name: claude-small." (protocol 6.3.1).');
  const t = byId.get(id);
  if (!tierModels[t.model]) deny(`${id} has no valid model tier, so it is not groomed. Groom it before dispatch (protocol 3.1).`);
  const problem = tierProblem(t);
  if (problem) deny(`${id}: ${problem}. Fix board.json and render it before dispatch.`);
  if (!['TODO', 'PAUSED', 'IN_PROGRESS'].includes(t.status)) deny(`${id} is ${t.status}. Only TODO or PAUSED tickets can be dispatched (protocol 1.3).`);
  const other = active.find((x) => x.id !== id);
  if (other) deny(`${other.id} is already IN_PROGRESS. Ask the user whether to PAUSE or ABANDON it first (protocol 5.2).`);
  if (ti.isolation === 'worktree') deny('Workers run in the main checkout. Dispatch ticket-worker without isolation: "worktree" (protocol 5.1).');
  const tier = requiredTier(t);
  const suggest = aliasForTier(tier, tierModels);
  const { model, via } = resolveClaudeAlias(ti.model ?? '');
  if (!model) deny(`Dispatch ticket-worker with an explicit model${suggest ? `: "${suggest}"` : ''}. ${id} is tier "${tier}" (protocol 6.3.1).`);
  const shown = via ? `"${ti.model ?? ''}" (runs ${model} via ${via})` : `"${model}"`;
  if (!fits(model, tier)) {
    const has = tiersOfModel(model, tierModels);
    const msg =
      `${id} is tier "${tier}", but model ${shown} is ${has.length ? `listed for ${has.join(', ')}` : 'not listed for any tier'} in ${tierSource} ` +
      `("${tier}": ${listed(tier)}). ${suggest ? `Dispatch with model: "${suggest}". ` : `No Claude Code alias resolves to a "${tier}" model here. `}` +
      `The tier rule is not negotiable; only the user may change a ticket's tier or ${TIERS_FILE} (protocol 1.2, 6.3.1).`;
    if (!inline.has(id)) deny(msg);
    allowWithNote(`${msg} Allowed because the user listed ${id} in KANBAN_INLINE; the PROGRESS entry must record it.`);
  }
  if (via) {
    const short = model.split('/').pop().split('.').pop().replace(/[^\w-]/g, '');
    allowWithNote(`${id}: the worker runs ${model} (${via}), listed for "${tier}". Use worker name "${short}-${tier}" and --model "${model}" with ticket.mjs claim.`);
  }
  process.exit(0);
}

// ---------- shell: board writes and ticket.mjs calls ----------
if (tool === 'Bash' || tool === 'PowerShell') {
  const cmd = String(ti.command ?? '');
  // Heuristic: a shell command that writes into a board file or tiers.json. Reads, and copies that only
  // read them (cp board.json /tmp/x), pass. ticket.mjs and render-board.mjs pass.
  const target = (p) => `["']?[^\\s"']*docs[\\\\/]kanban[\\\\/]${p}`;
  const writesInto = (p) =>
    new RegExp(
      `>{1,2}\\s*${target(p)}` +
        `|\\b(tee|sponge|set-content|add-content|out-file|writefilesync|writefile|appendfilesync|rm|del|remove-item|truncate)\\b.*${target(p)}` +
        `|\\b(sed|perl)\\b.*\\s-[a-z]*i.*${target(p)}` +
        `|\\b(cp|mv|copy|move|copy-item|move-item|rename-item)\\b.*${target(p)}["']?\\s*$`,
      'i',
    );
  const VIA_SCRIPTS = /^\s*node\s+["']?(\.\/)?scripts[\\/]kanban[\\/](ticket|render-board)\.mjs\b/i;
  for (const seg of cmd.split(/&&|\|\|?|;|\n/)) {
    if (VIA_SCRIPTS.test(seg)) continue;
    if (writesInto('tiers\\.json').test(seg)) deny(`Only the user edits ${TIERS_FILE} (protocol 1.2). Tell the user which model you propose for which tier, and why.`);
    for (const [p, rel] of BOARD_PATHS) if (writesInto(p).test(seg)) deny(handEdit(rel));
  }
  // Model IDs differ by prefix between tools and gateways ("bedrock/global.openai.gpt-6-luna" vs "gpt-6-luna").
  const same = (a, b) => {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    return x.includes(y) || y.includes(x);
  };
  // The second word is a ticket ID, or the type for "create <type>".
  for (const m of cmd.matchAll(/ticket\.mjs["']?\s+(\w+)\s+([A-Za-z]+(?:-\d+)?)([^;&|\n]*)/g)) {
    const [, sub, id, args] = m;
    const given = args.match(/--model[=\s]+["']?([^"'\s]+)/)?.[1];
    if (given && actorModel && !same(given, actorModel)) {
      deny(`ticket.mjs --model must be the model you run on. The transcript shows ${actorModel}, not ${given}. Run it again with --model "${actorModel}".`);
    }
    const coordinatorOnly = ['create', 'groom', 'edit', 'status', 'review', 'recover'].includes(sub) || (sub === 'note' && /--type[=\s]+["']?grooming/i.test(args));
    if (coordinatorOnly && (isSub || !isCoordinator)) deny(isSub ? `${sub} is coordinator work; a subagent never runs it (protocol 1.1, 6.5).` : notCoordinator());
    // Standing exception: the coordinator may run a 1 point chore itself (protocol 6.3.1).
    const ownChore = byId.has(id) && coordinatorMayRun(byId.get(id)) && isCoordinator;
    if (sub === 'claim' && !isSub && !inline.has(id) && !ownChore) {
      deny(`The coordinator never executes a ticket. Dispatch ticket-worker for ${id} (protocol 6.3.1). To run it in this session, the user sets KANBAN_INLINE=${id}.`);
    }
    if (sub === 'handover' && !isSub && !isCoordinator && !inline.has(id)) deny(notCoordinator());
  }
  process.exit(0);
}

// ---------- file edits ----------
if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) process.exit(0);
const file = ti.file_path ?? ti.notebook_path;
if (!file) process.exit(0);
const rel = path.relative(root, path.resolve(root, file)).replace(/\\/g, '/');
if (rel.startsWith('../') || path.isAbsolute(rel)) process.exit(0);
const caseFold = process.platform === 'win32' ? 'i' : '';
const is = (re) => new RegExp(re, caseFold).test(rel);

if (is(`^${TIERS_FILE.replace(/\./g, '\\.')}$`)) {
  deny(`Only the user edits ${TIERS_FILE} (protocol 1.2). Tell the user which model you propose for which tier, and why.`);
}

const boardFile = BOARD_PATHS.find(([, r]) => is(`^${r.replace(/\./g, '\\.')}${r.endsWith('/') ? '(?!_TEMPLATE\\.md$)' : '$'}`));
if (boardFile) deny(handEdit(boardFile[1]));

if (!active.length) process.exit(0);
if (isWorker) process.exit(0);
const t = active[0];
if (!isSub && inline.has(t.id)) process.exit(0);
if (!isSub && isCoordinator && coordinatorMayRun(t)) process.exit(0);

// Coordinator paths: docs/kanban/ plus the project's "coordinator_paths" globs. "**" spans directories,
// "*" and "?" stay inside one, and a pattern ending in "/" covers everything below that directory.
const SEGMENT = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' };
const globRe = (g) =>
  new RegExp(
    '^' +
      g
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '')
        .replace(/[.+^${}()|[\]]/g, '\\$&')
        .replace(/\*\*\/|\*\*|\*|\?/g, (m) => SEGMENT[m]) +
      (g.endsWith('/') ? '' : '$'),
    caseFold,
  );
const extra = Array.isArray(board.coordinator_paths) ? board.coordinator_paths : [];
const allowed = ['docs/kanban/', ...extra].filter((g) => typeof g === 'string' && g.trim());
if (allowed.some((g) => globRe(g).test(rel))) process.exit(0);

const alias = aliasForTier(requiredTier(t), tierModels);
deny(
  `${t.id} is IN_PROGRESS (assignee ${t.assignee ?? 'none'}). Ticket work belongs to its worker on the ticket's tier, not to ${isSub ? `the ${event.agent_type} subagent` : 'the coordinator'}. ` +
    `Dispatch ticket-worker${alias ? ` with model: "${alias}"` : ''} and let it finish, or, if its worker died, recover the claim (protocol 5.3, 6.3.1). ` +
    'While a ticket is active the coordinator edits only docs/kanban/ and the "coordinator_paths" globs in board.json; ' +
    `add a path there only with the user's agreement. To work the ticket in this session, the user sets KANBAN_INLINE=${t.id}.`,
);
