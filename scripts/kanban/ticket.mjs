#!/usr/bin/env node
// Every board change, the same way for every agent, provider, and model. Agents call this instead of
// editing board.json, BOARD.md, or handover notes by hand (protocol 6.1).
//
// Worker:
//   node scripts/kanban/ticket.mjs claim    <ID> --worker <name> --model <model-id>
//   node scripts/kanban/ticket.mjs handover <ID> --status REVIEW|PAUSED|BLOCKED|ABANDONED [--reason <text>] --body <file|-> | --text <md>
// Coordinator (--model must be listed for "large"):
//   node scripts/kanban/ticket.mjs create   <TYPE|ID> --title <text> [--parent <ID>] [--points <n>] [--description <text>] --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs groom    <ID> [--points <n>] [--file <path>]... [--symbol <name>]... [--entry-point <path>]... [--query <q>]...
//                                           [--acceptance <text>]... [--verify-cmd <cmd>] [--requires <ID>]... [--handover <ID>]... [--json <file|->]
//                                           [--body <file|-> | --text <md>] --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs edit     <ID> --set <field>=<value>... | --json <file|->  --reason <text> --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs status   <ID> --to BACKLOG|TODO|ABANDONED|DONE [--reason <text>] --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs note     <ID> --type GROOMING --agent <name> --model <model-id> --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs note     <ID> --type GROOMING --edit <n> --body <file|-> | --text <md> [--reason <text>] --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs note     <ID> --type GROOMING --delete <n> --reason <text> --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs review   <ID> --outcome DONE|REWORK --reviewer <name> --model <model-id> --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs recover  <ID> --coordinator <name> --model <model-id>
// Anyone:
//   node scripts/kanban/ticket.mjs note     <TARGET-ID> --type FLAG --from <SOURCE-ID> --agent <name> [--model <model-id>] --summary <text> --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs show     <ID>
//
// --body - and --json - read from stdin. Flags shown with "..." repeat; a repeated list replaces the old one.
// create picks the next free number for TYPE (task, story, epic, chore, bug) in the width the board uses,
// or takes a full ID and refuses one that is used. groom sets the grooming fields and the tier the standing
// rule requires, and moves a BACKLOG ticket to TODO once the Definition of Groomed passes. edit changes any
// field that is not state; --set values are JSON when they parse, else text. status covers the coordinator
// moves no other command makes. GROOMING entries are numbered 1..n in file order (show lists them); an edit
// or delete rewrites the entry and appends an AMEND entry that keeps the old text.
//
// Every write stamps the ticket: updated_at, last_actor { name, role, model, tier }, and created_at on
// create. claim, handover, and recover keep the claims history. Times come from the machine clock in
// ISO 8601 UTC. Every write runs render-board.mjs afterwards; if the board does not validate, every file this
// command changed is restored and the command fails. It records a hash of each file it wrote in
// docs/kanban/.script-writes.json, which the git pre-commit check compares with the staged files.
//
// Tier checks (protocol 1.2, 6.3.1). --model is the model ID the agent runs on, as its tool reports it.
// - claim: the model must be listed for the ticket's tier in docs/kanban/tiers.json, unless the user listed
//   the ticket in KANBAN_INLINE (comma-separated IDs), or the ticket is a 1 point chore and the model is
//   listed for "large" (the coordinator may run it itself).
// - Coordinator commands: the model must be listed for the "large" tier.
// KANBAN_DELEGATE=off (set by the user) skips the tier checks. This command never reads or writes
// "tier_override" or tiers.json: only the user changes those.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOARD_FILE, FIB, GROUPS, HANDOVER_DIR, findTicket, formatHeader, groomingProblems, loadBoard, nowIso, recordScriptWrites, stamp, tickets, toIso,
} from './board-lib.mjs';
import { TIERS_FILE, coordinatorMayRun, loadTierModels, modelFitsTier, requiredTier, tiersOfModel } from './tier-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const [cmd, id, ...rest] = process.argv.slice(2);

const fail = (msg) => {
  console.error(`ticket.mjs: ${msg}`);
  process.exit(1);
};

const ACTOR = ['agent', 'model'];
const ENTRY = ['body', 'text'];
const FLAGS = {
  claim: ['worker', 'model'],
  handover: ['status', 'reason', 'worker', ...ENTRY],
  note: ['type', 'agent', 'model', 'from', 'summary', 'edit', 'delete', 'reason', ...ENTRY],
  review: ['outcome', 'reviewer', 'model', ...ENTRY],
  recover: ['coordinator', 'model'],
  create: ['title', 'parent', 'points', 'description', ...ACTOR],
  groom: ['points', 'file', 'symbol', 'entry-point', 'query', 'acceptance', 'verify-cmd', 'requires', 'handover', 'json', ...ENTRY, ...ACTOR],
  edit: ['set', 'json', 'reason', ...ACTOR],
  status: ['to', 'reason', ...ACTOR],
  show: [],
};
const LISTS = new Set(['file', 'symbol', 'entry-point', 'query', 'acceptance', 'requires', 'handover', 'set']);
if (!FLAGS[cmd] || !id || id.startsWith('--')) {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).slice(1);
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1);
}

// --key value or --key=value. List flags collect every value.
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const m = rest[i].match(/^--([a-z-]+)(?:=(.*))?$/s);
  if (!m) fail(`unexpected argument "${rest[i]}"`);
  if (!FLAGS[cmd].includes(m[1])) fail(`${cmd} does not take --${m[1]}`);
  const value = m[2] ?? rest[++i];
  if (value === undefined) fail(`--${m[1]} needs a value`);
  if (LISTS.has(m[1])) (opts[m[1]] ??= []).push(value);
  else opts[m[1]] = value;
}
const need = (...keys) => keys.forEach((k) => opts[k] || fail(`${cmd} needs --${k}`));

const boardPath = path.join(root, BOARD_FILE);
const noteDir = path.join(root, HANDOVER_DIR);
const notePath = (tid) => path.join(noteDir, `${tid}.md`);
const flagIndex = path.join(noteDir, 'HANDOVERS.md');
// codegraph_queries are required only when the repository has a CodeGraph index (as in render-board.mjs).
const hasIndex = fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'));

let board;
try {
  board = loadBoard(root);
} catch (e) {
  fail(`cannot read ${BOARD_FILE}: ${e.message}`);
}
const tierModels = loadTierModels(root);
if (tierModels.problem) fail(`${TIERS_FILE}: ${tierModels.problem}. Ask the user to fix it.`);
const checksOff = process.env.KANBAN_DELEGATE === 'off';
const inline = (process.env.KANBAN_INLINE ?? '').split(',').map((s) => s.trim()).includes(id);
const listed = (want) => tierModels.models[want].join(', ');
const fitsTier = (model, want) => modelFitsTier(model, want, tierModels.models);
// The tier an actor works on: the one it acts for when its model is listed there, else the first it is listed for.
const actorTier = (model, want) => (fitsTier(model, want) ? want : (tiersOfModel(model, tierModels.models)[0] ?? null));
const typedOf = (x) => tickets(board).find((y) => y.id === x.id);

function requireTier(model, want, role) {
  if (checksOff || fitsTier(model, want)) return;
  const has = tiersOfModel(model, tierModels.models);
  fail(
    `${role} needs a model listed for tier "${want}" in ${tierModels.source} (${listed(want)}); "${model}" is ${has.length ? `listed for ${has.join(', ')}` : 'not listed'}. ` +
      'Only the user changes tiers.json, a ticket tier, or approves a mismatch (protocol 1.2, 6.3.1).',
  );
}
// Coordinator commands: --agent and --model, on a model listed for "large". Returns the actor for stamp().
function coordinator(what, name = opts.agent) {
  need('model');
  if (!name) fail(`${cmd} needs --agent`);
  requireTier(opts.model, 'large', what);
  return { name, role: 'coordinator', model: opts.model, tier: actorTier(opts.model, 'large') };
}

const hasBody = () => opts.text !== undefined || opts.body !== undefined;
const readInput = (src) => (src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(src), 'utf8'));
const body = () => {
  if (opts.text !== undefined) return opts.text;
  need('body');
  return readInput(opts.body);
};
function readJson(src) {
  if (src === '-' && opts.body === '-') fail('--json - and --body - cannot both read stdin.');
  try {
    const obj = JSON.parse(readInput(src));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('needs a JSON object of fields');
    return obj;
  } catch (e) {
    fail(`--json ${src}: ${e.message}`);
  }
}
const points = (v) => {
  const n = Number(v);
  if (!FIB.includes(n)) fail(`points must be one of ${FIB.join(', ')}, not "${v}".`);
  return n;
};

// Writes are collected, applied together, then validated by render-board.mjs; on failure they are undone.
const writes = new Map();
const original = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const current = (f) => (writes.has(f) ? writes.get(f) : original(f));
const eol = (text) => (/\r\n/.test(text ?? '') ? '\r\n' : '\n');
const put = (f, text) => writes.set(f, text);
const saveBoard = () => {
  const before = original(boardPath);
  put(boardPath, (JSON.stringify(board, null, 2) + '\n').replace(/\n/g, eol(before)));
};

function appendEntry(tid, header, text) {
  const f = notePath(tid);
  const rec = findTicket(board, tid);
  const before = current(f) ?? `# Handover Notes: ${tid} ${rec?.title ?? ''}`.trimEnd() + '\n\n<!-- Append-only log. See docs/kanban/protocol.md section 6. -->\n';
  const nl = eol(before);
  const entry = `${header}\n\n${text.trim()}\n`.replace(/\r?\n/g, nl);
  put(f, before.replace(/\s*$/, '') + `${nl}${nl}---${nl}${nl}` + entry);
  if (rec && !(rec.handovers ?? []).includes(tid)) rec.handovers = [...(rec.handovers ?? []), tid];
}

function dropFlagRows(tid) {
  if (current(flagIndex) === null) return;
  const rowRe = new RegExp(`^\\|\\s*\`?${tid}\`?\\s*\\|`);
  const text = current(flagIndex);
  const next = text.split(/(?<=\n)/).filter((l) => !rowRe.test(l)).join('');
  if (next !== text) put(flagIndex, next);
}

function commit(summary) {
  const backups = new Map([...writes.keys()].map((f) => [f, original(f)]));
  for (const [f, text] of writes) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  const r = spawnSync(process.execPath, [path.join(here, 'render-board.mjs')], { encoding: 'utf8' });
  if (r.status !== 0) {
    for (const [f, text] of backups) text === null ? fs.rmSync(f, { force: true }) : fs.writeFileSync(f, text);
    process.stderr.write(r.stderr || r.stdout);
    fail('the board did not validate, so nothing was changed.');
  }
  recordScriptWrites(root, Object.fromEntries([...writes].map(([f, text]) => [path.relative(root, f).replace(/\\/g, '/'), text])));
  process.stderr.write(r.stderr);
  console.log(summary);
  console.log(r.stdout.trim());
}

// ---------- create: the one command without an existing ticket ----------
if (cmd === 'create') {
  const actor = coordinator('Creating a ticket');
  need('title');
  const PREFIX = { epic: 'EPIC', story: 'STORY', task: 'TASK', chore: 'CHORE', bug: 'BUG' };
  const ids = new Set(tickets(board).map((x) => x.id));
  const free = (tid) => !ids.has(tid) && !fs.existsSync(notePath(tid));
  let type = Object.keys(PREFIX).find((k) => id.toUpperCase().startsWith(`${PREFIX[k]}-`));
  let newId = id.toUpperCase();
  if (/^[A-Z]+-\d+$/.test(newId)) {
    if (!type) fail(`unknown ID prefix in "${id}"; use ${Object.values(PREFIX).join(', ')}.`);
    if (!free(newId)) fail(`${newId} is already used${ids.has(newId) ? ' on the board' : ` by handovers/${newId}.md`}. IDs are never reused (protocol 9.1).`);
  } else {
    type = id.toLowerCase();
    if (!PREFIX[type]) fail(`unknown type "${id}"; use ${Object.keys(PREFIX).join(', ')}, or a full ID such as TASK-007.`);
    const used = [...ids].map((x) => x.match(new RegExp(`^${PREFIX[type]}-(\\d+)$`))?.[1]).filter(Boolean);
    const top = used.sort((a, b) => Number(a) - Number(b)).at(-1);
    let n = top ? Number(top) + 1 : 1;
    const width = top ? top.length : 3;
    while (!free(`${PREFIX[type]}-${String(n).padStart(width, '0')}`)) n++;
    newId = `${PREFIX[type]}-${String(n).padStart(width, '0')}`;
  }
  const parent = opts.parent ? findTicket(board, opts.parent) : null;
  if (opts.parent && !parent) fail(`--parent ${opts.parent} is not on the board.`);
  if (type === 'task' && !parent) fail('a task needs --parent <STORY-ID>.');
  const rec = {
    id: newId,
    title: opts.title,
    description: opts.description ?? null,
    status: 'BACKLOG',
    points: opts.points === undefined ? null : points(opts.points),
    parent: parent?.id ?? null,
    children: [],
    requires: [],
    blocks: [],
    model: null,
    tier_override: null,
    assignee: null,
    claimed_at: null,
    worker_model: null,
    blocked_reason: null,
    context: { files: [], symbols: [], entry_points: [], codegraph_queries: [] },
    acceptance: [],
    verify_cmd: null,
    handovers: [],
    created_at: null,
    updated_at: null,
    last_actor: null,
    claims: [],
  };
  (board[Object.keys(GROUPS).find((g) => GROUPS[g] === type)] ??= []).push(rec);
  if (rec.points !== null) rec.model = requiredTier(typedOf(rec));
  stamp(rec, actor);
  rec.created_at = rec.updated_at;
  if (parent) {
    parent.children = [...new Set([...(parent.children ?? []), newId])];
    stamp(parent, actor);
  }
  saveBoard();
  commit(`${newId} created in BACKLOG${parent ? ` under ${parent.id}` : ''}. Groom it with: node scripts/kanban/ticket.mjs groom ${newId} ...`);
  process.exit(0);
}

// ---------- every other command works on an existing ticket ----------
const t = findTicket(board, id);
if (!t) fail(`${id} is not on the board`);
const typed = typedOf(t);
const tier = requiredTier(typed);
// The standing rule sets the tier from type and points; a user tier_override wins (protocol 1.2).
const retier = () => {
  if (FIB.includes(t.points)) t.model = requiredTier(typedOf(t));
};
// A 1 point chore claimed on a large-tier model that is not listed for the chore's tier: the coordinator runs it.
const coordinatorRuns = (model) => !fitsTier(model, tier) && coordinatorMayRun(typed) && fitsTier(model, 'large');
const workerActor = (name, model) => ({ name, role: coordinatorRuns(model) ? 'coordinator' : 'worker', model: model ?? null, tier: model ? actorTier(model, coordinatorRuns(model) ? 'large' : tier) : null });

const clearClaim = () => {
  t.assignee = null;
  t.claimed_at = null;
  delete t.worker_model;
};
// Closes the open claim, or records one for a claim made before claims were kept.
function closeClaim(outcome) {
  t.claims ??= [];
  let c = t.claims.at(-1);
  if (!c || c.released_at) {
    c = { worker: t.assignee ?? null, model: t.worker_model ?? null, tier: t.worker_model ? actorTier(t.worker_model, tier) : null, claimed_at: toIso(t.claimed_at), released_at: null, outcome: null };
    t.claims.push(c);
  }
  c.released_at = nowIso();
  c.outcome = outcome;
}

// GROOMING entries of a note, numbered 1..n in file order. Deleted ones ("## GROOMING (DELETED) ·") keep their number.
function groomingEntries(text) {
  const lines = text.split(/(?<=\n)/);
  const heads = lines.flatMap((l, i) => (/^##\s/.test(l) ? [i] : []));
  return heads
    .filter((i) => /^##\s*GROOMING\b/.test(lines[i]))
    .map((i) => {
      let end = heads.find((j) => j > i) ?? lines.length;
      while (end > i + 1 && /^\s*(-{3,})?\s*$/.test(lines[end - 1])) end--;
      return { lines, start: i, end, header: lines[i].trim(), body: lines.slice(i + 1, end).join('').trim(), deleted: /^##\s*GROOMING\s*\(DELETED\)/.test(lines[i]) };
    });
}
const quote = (text) => text.split(/\r?\n/).map((l) => (l ? `> ${l}` : '>')).join('\n');

switch (cmd) {
  case 'show': {
    const active = tickets(board).filter((x) => x.status === 'IN_PROGRESS');
    console.log(JSON.stringify(t, null, 2));
    console.log(`\nTier: ${tier}${t.tier_override ? ' (user tier_override)' : ''}. Models listed for it in ${tierModels.source}: ${listed(tier)}.`);
    console.log(`Coordinator (large) models: ${listed('large')}.`);
    console.log(`In progress: ${active.map((x) => `${x.id} by ${x.assignee}`).join(', ') || 'none'}.`);
    const note = original(notePath(id));
    const entries = note === null ? [] : groomingEntries(note);
    console.log(`GROOMING entries (for note --edit/--delete): ${entries.length ? '' : 'none'}`);
    entries.forEach((e, i) => console.log(`  ${i + 1}. ${e.header.replace(/^##\s*/, '')}${e.deleted ? '' : `: ${e.body.split(/\r?\n/).find((l) => l.trim())?.slice(0, 80) ?? ''}`}`));
    break;
  }

  case 'claim': {
    need('worker', 'model');
    if (!['TODO', 'PAUSED'].includes(t.status)) fail(`${id} is ${t.status}; only TODO or PAUSED tickets can be claimed (protocol 1.3, 6.5).`);
    const notDone = (t.requires ?? []).filter((r) => findTicket(board, r)?.status !== 'DONE');
    if (notDone.length) fail(`${id} requires ${notDone.join(', ')}, which are not DONE (protocol 6.5 step 2).`);
    const other = tickets(board).find((x) => x.status === 'IN_PROGRESS');
    if (other) fail(`${other.id} is already IN_PROGRESS (by ${other.assignee ?? 'none'}). Ask the user whether to PAUSE or ABANDON it (protocol 5.2).`);
    const fits = fitsTier(opts.model, tier);
    const own = coordinatorRuns(opts.model);
    if (!fits && !inline && !own) requireTier(opts.model, tier, `${id} (tier "${tier}")`);
    const actor = workerActor(opts.worker, opts.model);
    t.status = 'IN_PROGRESS';
    t.assignee = opts.worker;
    t.claimed_at = nowIso();
    t.worker_model = opts.model;
    t.claims = [...(t.claims ?? []), { worker: opts.worker, model: opts.model, tier: actor.tier, claimed_at: t.claimed_at, released_at: null, outcome: null }];
    stamp(t, actor);
    saveBoard();
    commit(`${id} claimed by ${opts.worker} on ${opts.model} (tier ${tier}).`);
    if (own) console.log(`Note: the coordinator runs this 1 point chore itself (protocol 6.3.1). Hand it over with ticket.mjs handover when done.`);
    else if (!fits) console.log(`Note: ${opts.model} is not listed for tier "${tier}". The user approved it with KANBAN_INLINE; record that approval in the PROGRESS entry.`);
    break;
  }

  case 'handover': {
    need('status');
    const status = opts.status.toUpperCase();
    if (!['REVIEW', 'PAUSED', 'BLOCKED', 'ABANDONED'].includes(status)) fail('--status must be REVIEW, PAUSED, BLOCKED, or ABANDONED.');
    if (t.status !== 'IN_PROGRESS') fail(`${id} is ${t.status}; only an IN_PROGRESS ticket is handed over.`);
    if (opts.worker && opts.worker !== t.assignee) fail(`${id} is claimed by ${t.assignee}, not ${opts.worker}.`);
    if (status === 'BLOCKED' && !opts.reason) fail('BLOCKED needs --reason (protocol 5).');
    const who = `${t.assignee ?? 'unknown'}${t.worker_model ? ` (${t.worker_model})` : ''}`;
    appendEntry(id, formatHeader('PROGRESS', who, status), body());
    stamp(t, workerActor(t.assignee, t.worker_model));
    closeClaim(status);
    t.status = status;
    t.blocked_reason = status === 'BLOCKED' ? opts.reason : null;
    clearClaim();
    if (status === 'ABANDONED') dropFlagRows(id);
    saveBoard();
    commit(`${id} is ${status}.`);
    break;
  }

  case 'note': {
    need('type', 'agent');
    const type = opts.type.toUpperCase();
    if (type === 'GROOMING') {
      const actor = coordinator('Grooming');
      const who = `${opts.agent} (${opts.model})`;
      if (opts.edit !== undefined || opts.delete !== undefined) {
        if (opts.edit !== undefined && opts.delete !== undefined) fail('use --edit or --delete, not both.');
        const deleting = opts.delete !== undefined;
        const n = Number(opts.edit ?? opts.delete);
        if (deleting && !opts.reason) fail('--delete needs --reason; the AMEND entry records why (protocol 6.2).');
        const text = current(notePath(id));
        const entries = text === null ? [] : groomingEntries(text);
        const e = entries[n - 1];
        if (!Number.isInteger(n) || !e) fail(`${id} has ${entries.length} GROOMING entr${entries.length === 1 ? 'y' : 'ies'}; --${deleting ? 'delete' : 'edit'} takes 1..${entries.length}. Run show ${id} to list them.`);
        if (e.deleted) fail(`GROOMING entry ${n} of ${id} is already deleted.`);
        const nl = eol(text);
        const at = nowIso();
        const header = deleting ? e.header.replace(/^##\s*GROOMING/, '## GROOMING (DELETED)') : e.header;
        const replacement = deleting ? `*Removed: ${opts.reason.trim()}. The previous text is in the AMEND entry of ${at}.*` : body().trim();
        put(notePath(id), [...e.lines.slice(0, e.start), `${header}${nl}${nl}${replacement}${nl}`.replace(/\r?\n/g, nl), ...e.lines.slice(e.end)].join(''));
        const verb = deleting ? 'DELETED' : 'EDITED';
        appendEntry(
          id,
          formatHeader('AMEND', who, verb),
          [`GROOMING entry ${n} (\`${e.header.replace(/^##\s*/, '')}\`) was ${verb.toLowerCase()}.`, '', `**Reason:** ${opts.reason?.trim() || 'not given'}`, '', '**Previous text**', '', quote(e.body)].join('\n'),
        );
        stamp(t, actor);
        saveBoard();
        commit(`GROOMING entry ${n} of ${HANDOVER_DIR}/${id}.md ${verb.toLowerCase()}; AMEND entry added.`);
        break;
      }
      appendEntry(id, formatHeader('GROOMING', who), body());
      stamp(t, actor);
      saveBoard();
      commit(`GROOMING entry added to ${HANDOVER_DIR}/${id}.md.`);
    } else if (type === 'FLAG') {
      need('from', 'summary');
      if (opts.edit !== undefined || opts.delete !== undefined) fail('--edit and --delete work on GROOMING entries only.');
      if (!findTicket(board, opts.from)) fail(`--from ${opts.from} is not on the board`);
      const active = tickets(board).find((x) => x.status === 'IN_PROGRESS');
      const isWorker = !!active && active.assignee === opts.agent;
      const model = opts.model ?? (isWorker ? active.worker_model : null);
      appendEntry(id, formatHeader('FLAG', `from ${opts.from}`, `${opts.agent}${model ? ` (${model})` : ''}`), body());
      const index = current(flagIndex) ?? '| Target | From | Summary | Note |\n|---|---|---|---|\n';
      const row = `| \`${id}\` | \`${opts.from}\` | ${opts.summary.replace(/\|/g, '\\|').replace(/\s+/g, ' ')} | [${id}.md](./${id}.md) |`;
      put(flagIndex, index.replace(/\s*$/, '') + eol(index) + row + eol(index));
      stamp(t, { name: opts.agent, role: isWorker ? 'worker' : 'coordinator', model, tier: model ? actorTier(model, isWorker ? requiredTier(active) : 'large') : null });
      saveBoard();
      commit(`FLAG entry added to ${HANDOVER_DIR}/${id}.md and HANDOVERS.md.`);
    } else fail('--type must be GROOMING or FLAG. PROGRESS and REVIEW entries come from handover and review.');
    break;
  }

  case 'review': {
    need('outcome', 'reviewer');
    const outcome = opts.outcome.toUpperCase();
    if (!['DONE', 'REWORK'].includes(outcome)) fail('--outcome must be DONE or REWORK.');
    if (t.status !== 'REVIEW') fail(`${id} is ${t.status}; only a REVIEW ticket is reviewed.`);
    const actor = coordinator('Review', opts.reviewer);
    appendEntry(id, formatHeader('REVIEW', `${opts.reviewer} (${opts.model})`, outcome), body());
    t.status = outcome === 'DONE' ? 'DONE' : 'TODO';
    if (outcome === 'DONE') dropFlagRows(id);
    stamp(t, actor);
    saveBoard();
    commit(`${id} is ${t.status}.`);
    break;
  }

  case 'recover': {
    need('coordinator');
    if (t.status !== 'IN_PROGRESS') fail(`${id} is ${t.status}; only an IN_PROGRESS claim is recovered.`);
    const actor = coordinator('Recovery', opts.coordinator);
    const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' }).stdout?.trim() || '(none)';
    const text = [
      `Recovered from orphaned claim by \`${t.assignee ?? 'unknown'}\`${t.worker_model ? ` on ${t.worker_model}` : ''}, claimed at ${t.claimed_at ?? 'unknown'}. The edits were kept; the next worker resumes from them.`,
      '',
      '**Files changed** (uncommitted, from `git status --short`)',
      '```',
      git('status', '--short'),
      '```',
      '',
      '**Diff stat**',
      '```',
      git('diff', '--stat'),
      '```',
    ].join('\n');
    appendEntry(id, formatHeader('PROGRESS', `${opts.coordinator} (${opts.model})`, 'PAUSED'), text);
    closeClaim('PAUSED');
    t.status = 'PAUSED';
    clearClaim();
    stamp(t, actor);
    saveBoard();
    commit(`${id} recovered and PAUSED.`);
    break;
  }

  case 'groom': {
    const actor = coordinator('Grooming');
    if (!['BACKLOG', 'TODO', 'PAUSED', 'BLOCKED'].includes(t.status)) {
      fail(`${id} is ${t.status}. Groom a BACKLOG, TODO, PAUSED, or BLOCKED ticket; an IN_PROGRESS ticket belongs to its worker, and REVIEW, DONE, and ABANDONED are history.`);
    }
    const GROOM_FIELDS = ['points', 'context', 'acceptance', 'verify_cmd', 'requires', 'handovers'];
    const fields = opts.json ? readJson(opts.json) : {};
    for (const k of Object.keys(fields)) if (!GROOM_FIELDS.includes(k)) fail(`groom sets ${GROOM_FIELDS.join(', ')}; change "${k}" with edit.`);
    if (opts.points !== undefined) fields.points = opts.points;
    const ctx = { file: 'files', symbol: 'symbols', 'entry-point': 'entry_points', query: 'codegraph_queries' };
    for (const [flag, key] of Object.entries(ctx)) if (opts[flag]) (fields.context ??= {})[key] = opts[flag];
    if (opts.acceptance) fields.acceptance = opts.acceptance;
    if (opts['verify-cmd'] !== undefined) fields.verify_cmd = opts['verify-cmd'];
    if (opts.requires) fields.requires = opts.requires;
    if (opts.handover) fields.handovers = opts.handover;
    if (!Object.keys(fields).length && !hasBody()) fail('groom needs at least one field flag, --json, or a GROOMING entry (--body or --text).');

    const strings = (k, v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : fail(`${k} must be a list of strings.`));
    if (fields.points !== undefined) t.points = points(fields.points);
    if (fields.context !== undefined) {
      if (!fields.context || typeof fields.context !== 'object' || Array.isArray(fields.context)) fail('context must be an object.');
      t.context = { ...(t.context ?? {}) };
      for (const [k, v] of Object.entries(fields.context)) t.context[k] = strings(`context.${k}`, v);
    }
    if (fields.acceptance !== undefined) t.acceptance = strings('acceptance', fields.acceptance);
    if (fields.verify_cmd !== undefined) t.verify_cmd = String(fields.verify_cmd);
    if (fields.requires !== undefined) {
      t.requires = strings('requires', fields.requires);
      for (const r of t.requires) if (r === id || !findTicket(board, r)) fail(`requires: ${r} ${r === id ? 'is this ticket' : 'is not on the board'}.`);
    }
    if (fields.handovers !== undefined) t.handovers = strings('handovers', fields.handovers);
    retier();
    if (hasBody()) appendEntry(id, formatHeader('GROOMING', `${opts.agent} (${opts.model})`), body());
    // The ticket's own note, once it exists, is always listed (protocol 3.1).
    if (current(notePath(id)) !== null && !(t.handovers ?? []).includes(id)) t.handovers = [id, ...(t.handovers ?? [])];
    stamp(t, actor);

    let summary = `${id} groomed (tier ${t.model ?? 'not set'}).`;
    if (t.status === 'BACKLOG') {
      // The same checks render-board.mjs makes for a TODO ticket. An epic needs only its estimate.
      const problems = FIB.includes(t.points) ? [] : [`points must be one of ${FIB.join(', ')}`];
      if (typed.type !== 'epic') {
        problems.push(...groomingProblems(typedOf(t), { noteText: (x) => current(notePath(x)), hasIndex }));
        const split = typed.type === 'story' && tickets(board).some((x) => x.type === 'task' && x.parent === id);
        if (!split && t.points >= 13) problems.push(`${t.points} pts is too large; split it${typed.type === 'story' ? ' into tasks' : ''}`);
      }
      if (problems.length) summary += ` It stays in BACKLOG until the Definition of Groomed passes (protocol 3.1):\n- ${problems.join('\n- ')}`;
      else {
        t.status = 'TODO';
        summary = `${id} groomed and moved to TODO (tier ${t.model}).`;
      }
    }
    saveBoard();
    commit(summary);
    break;
  }

  case 'edit': {
    const actor = coordinator('Editing a ticket');
    need('reason');
    const fields = opts.json ? readJson(opts.json) : {};
    for (const s of opts.set ?? []) {
      const m = s.match(/^([A-Za-z_][\w.]*)=(.*)$/s);
      if (!m) fail(`--set needs <field>=<value>, not "${s}".`);
      let value = m[2];
      try {
        value = JSON.parse(m[2]);
      } catch {}
      fields[m[1]] = value;
    }
    if (!Object.keys(fields).length) fail('edit needs --set <field>=<value> or --json <file|->.');
    const STATE = {
      id: 'IDs never change (protocol 9.1)',
      type: 'the type follows the board.json group; create a new ticket instead',
      status: 'use claim, handover, review, recover, or status',
      assignee: 'claim and handover set it',
      claimed_at: 'claim and handover set it',
      worker_model: 'claim and handover set it',
      claims: 'claim, handover, and recover keep it',
      blocked_reason: 'handover --status BLOCKED --reason sets it, and status --to TODO clears it',
      created_at: 'ticket.mjs stamps it',
      updated_at: 'ticket.mjs stamps it',
      last_actor: 'ticket.mjs stamps it',
      model: 'the standing tier rule sets it from type and points (protocol 1.2)',
      tier_override: 'only the user writes it (protocol 1.2)',
    };
    const getPath = (obj, keys) => keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);
    const changes = [];
    const oldParent = t.parent;
    for (const [key, value] of Object.entries(fields)) {
      const keys = key.split('.');
      if (STATE[keys[0]]) fail(`edit does not change "${keys[0]}": ${STATE[keys[0]]}.`);
      const before = getPath(t, keys);
      let o = t;
      for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
      o[keys.at(-1)] = value;
      changes.push(`- \`${key}\`: ${JSON.stringify(before ?? null)} → ${JSON.stringify(value)}`);
    }
    if (t.points !== null && t.points !== undefined && fields.points !== undefined) t.points = points(t.points);
    if (t.parent !== oldParent) {
      const from = oldParent && findTicket(board, oldParent);
      const to = t.parent && findTicket(board, t.parent);
      if (t.parent && !to) fail(`parent ${t.parent} is not on the board.`);
      if (from) from.children = (from.children ?? []).filter((c) => c !== id);
      if (to) to.children = [...new Set([...(to.children ?? []), id])];
      for (const p of [from, to]) if (p) stamp(p, actor);
    }
    retier();
    appendEntry(id, formatHeader('AMEND', `${opts.agent} (${opts.model})`, 'EDITED'), ['**Fields changed**', ...changes, '', `**Reason:** ${opts.reason.trim()}`].join('\n'));
    stamp(t, actor);
    saveBoard();
    commit(`${id} edited: ${Object.keys(fields).join(', ')}.`);
    break;
  }

  case 'status': {
    const actor = coordinator('A status change');
    need('to');
    const to = opts.to.toUpperCase();
    const from = t.status;
    const epic = typed.type === 'epic';
    const MOVES = epic
      ? { BACKLOG: ['TODO'], TODO: ['BACKLOG'], DONE: ['BACKLOG', 'TODO', 'IN_PROGRESS', 'PAUSED', 'BLOCKED', 'REVIEW'], ABANDONED: ['BACKLOG', 'TODO', 'IN_PROGRESS', 'PAUSED', 'BLOCKED', 'REVIEW'] }
      : { BACKLOG: ['TODO', 'PAUSED', 'BLOCKED'], TODO: ['BACKLOG', 'PAUSED', 'BLOCKED'], ABANDONED: ['BACKLOG', 'TODO', 'PAUSED', 'BLOCKED', 'REVIEW'] };
    const HINT = {
      IN_PROGRESS: 'a worker claims it with claim',
      REVIEW: 'the worker hands it over with handover --status REVIEW',
      PAUSED: 'the worker hands it over, or the coordinator recovers an orphaned claim with recover',
      BLOCKED: 'the worker hands it over with handover --status BLOCKED',
      DONE: 'the coordinator reviews it with review --outcome DONE',
    };
    if (from === to) fail(`${id} is already ${to}.`);
    if (!MOVES[to]) fail(`status does not set ${to}${HINT[to] ? `: ${HINT[to]}` : ''}.`);
    if (!MOVES[to].includes(from)) {
      fail(`${id} cannot move from ${from} to ${to} with status.${from === 'IN_PROGRESS' ? ' Its worker hands it over first, or recover the orphaned claim (protocol 5.3).' : ''}`);
    }
    if (to === 'ABANDONED' && !opts.reason) fail('ABANDONED needs --reason (protocol 5).');
    if (epic && to === 'DONE') {
      const open = tickets(board).filter((x) => (x.parent === id || (t.children ?? []).includes(x.id)) && !['DONE', 'ABANDONED'].includes(x.status));
      if (open.length) fail(`${id} has children that are not DONE or ABANDONED: ${open.map((x) => `${x.id} (${x.status})`).join(', ')}.`);
    }
    t.status = to;
    t.blocked_reason = null;
    if (from === 'IN_PROGRESS') {
      closeClaim(to);
      clearClaim();
    }
    if (to === 'DONE' || to === 'ABANDONED') dropFlagRows(id);
    appendEntry(id, formatHeader('AMEND', `${opts.agent} (${opts.model})`, to), [`Status ${from} → ${to}.`, '', `**Reason:** ${opts.reason?.trim() || 'not given'}`].join('\n'));
    stamp(t, actor);
    saveBoard();
    commit(`${id} is ${to}.`);
    break;
  }
}
