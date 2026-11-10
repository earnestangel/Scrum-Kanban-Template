#!/usr/bin/env node
// Every board change, the same way for every agent, provider, and model. Agents call this instead of
// editing board.json, BOARD.md, design.json, or handover notes by hand (protocol 6.1).
//
// Worker:
//   node scripts/kanban/ticket.mjs context  <ID> [--max-chars <n>]
//   node scripts/kanban/ticket.mjs claim    <ID> --worker <name> --model <model-id> [--out-of-order <reason>]
//   node scripts/kanban/ticket.mjs handover <ID> --status REVIEW|PAUSED|BLOCKED|ABANDONED [--reason <text>] --body <file|-> | --text <md>
// Coordinator (--model must be listed for "large"):
//   node scripts/kanban/ticket.mjs create   <TYPE|ID> --title <text> [--parent <ID>] [--points <n>] [--description <text>] --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs groom    <ID> [--points <n>] [--order <n>] [--file <path>]... [--symbol <name>]... [--entry-point <path>]... [--query <q>]...
//                                           [--acceptance <text>]... [--verify-cmd <cmd>] [--requires <ID>]... [--handover <ID>]...
//                                           [--design-ref <D-ID>]... | [--design-na <reason>] [--adr <ADR-ID>]... [--design-reviewed <text>]
//                                           [--json <file|->] [--body <file|-> | --text <md>] --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs edit     <ID> --set <field>=<value>... | --json <file|->  --reason <text> --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs status   <ID> --to BACKLOG|TODO|ABANDONED [--reason <text>] --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs note     <ID> --type GROOMING [--supersedes [<NOTE-ID>#]<n>]... [--link <ID>|children]... --agent <name> --model <model-id> --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs note     <ID> --type GROOMING --edit <n> --body <file|-> | --text <md> [--reason <text>] --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs note     <ID> --type GROOMING --delete <n> --reason <text> --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs state    <EPIC|STORY> --agent <name> --model <model-id> --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs review   <ID> --outcome DONE|REWORK --reviewer <name> --model <model-id> --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs close    <EPIC|STORY> --agent <name> --model <model-id> --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs archive  <STORY|ID> --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs recover  <ID> --coordinator <name> --model <model-id>
//   node scripts/kanban/ticket.mjs decision new --question <text> --blocks <ID>... [--adr <ADR-ID>] --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs decision <DEC-ID> --resolve <the user's answer> --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs design   <path|all> [--remove] --agent <name> --model <model-id>
//   node scripts/kanban/ticket.mjs element  new|<D-ID> [--title <text>] [--source <path>] [--state planned|built|deferred|deviated] [--adr <ADR-ID>]
//                                           [--note <text>] [--ticket <ID>]... [--json <file|->] --agent <name> --model <model-id>
// Anyone:
//   node scripts/kanban/ticket.mjs note     <TARGET-ID> --type FLAG --from <SOURCE-ID> --agent <name> [--model <model-id>] --summary <text> [--link <ID>|children]... --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs finding  <file> --summary <one line> --agent <name>
//   node scripts/kanban/ticket.mjs show     <ID>
//   node scripts/kanban/ticket.mjs stats    [--days <n>] [--json]
//
// --body - and --json - read from stdin. Flags shown with "..." repeat; a repeated list replaces the old one.
// create picks the next free number for TYPE (task, story, epic, chore, bug) in the width the board uses,
// or takes a full ID and refuses one that is used, on the board or in the archive. groom sets the grooming
// fields and the tier the standing rule requires, and moves a BACKLOG ticket to TODO once the Definition of
// Groomed passes. edit changes any field that is not state; --set values are JSON when they parse, else text.
// GROOMING entries are numbered 1..n in file order for --edit/--delete; every entry is numbered 1..n for
// --supersedes (show lists both). An edit or delete appends an AMEND entry that keeps the old text; a
// superseded entry stays in the note, marked (SUPERSEDED).
//
// context prints everything a worker must read for a ticket in one bounded output: the record, what waits on
// the user, its design elements, the knowledge index, the epic and story STATE blocks, the live entries of its
// notes, and the last PROGRESS entry of each "requires" ticket. state rewrites the STATE block of an epic or
// story note, the one part of a note that is not append-only. close closes an epic or a story that has
// children, once every child is closed; their status and points are derived from the children. archive moves
// the closed children of a DONE story to docs/kanban/board-archive.json and their notes to handovers/archive/.
//
// Every write stamps the ticket: updated_at, last_actor { name, role, model, tier }, and created_at on
// create. claim, handover, review, and recover keep the claims history and the velocity fields (started_at,
// done_at, done_by, done_by_model, rework_count). Times come from the machine clock in ISO 8601 UTC. Every
// write runs render-board.mjs afterwards; if the board does not validate, every file this command changed is
// restored and the command fails. It records a hash of each file it wrote in docs/kanban/.script-writes.json,
// which the git pre-commit check compares with the staged files.
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
  ARCHIVE_FILE, ARCHIVE_NOTE_DIR, BOARD_FILE, CLOSED, DESIGN_FILE, DIGEST_MAX_LINES, FIB, GROUPS, HANDOVER_DIR, KNOWLEDGE_FILE, STUB_FIELDS, deriveContainers, digestLines,
  findTicket, formatHeader, groomingProblems, hasLabel, isContainer, labelValue, liveTickets, loadArchive, loadBoard, nowIso, parseNote, readNote, recordScriptWrites, stamp, stateProblems,
  tickets, toIso, velocity, withState,
} from './board-lib.mjs';
import { DESIGN_STATES, adrConfig, adrInfo, adrsOf, anchorOn, fileHash, isBuilt, loadLedger, refsOf, sourceDrift, ticketsByElement } from './design-lib.mjs';
import { TIERS, TIERS_FILE, coordinatorMayRun, loadTierModels, modelFitsTier, requiredTier, tiersOfModel } from './tier-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const cmd = argv[0];
// Commands that take no ID.
const NO_ID = ['stats'];
const id = NO_ID.includes(cmd) ? cmd : argv[1];
const rest = argv.slice(NO_ID.includes(cmd) ? 1 : 2);

const fail = (msg) => {
  console.error(`ticket.mjs: ${msg}`);
  process.exit(1);
};

const ACTOR = ['agent', 'model'];
const ENTRY = ['body', 'text'];
const FLAGS = {
  claim: ['worker', 'model', 'out-of-order'],
  handover: ['status', 'reason', 'worker', ...ENTRY],
  note: ['type', 'agent', 'model', 'from', 'summary', 'edit', 'delete', 'reason', 'supersedes', 'link', ...ENTRY],
  review: ['outcome', 'reviewer', 'model', ...ENTRY],
  recover: ['coordinator', 'model'],
  create: ['title', 'parent', 'points', 'description', ...ACTOR],
  groom: ['points', 'order', 'file', 'symbol', 'entry-point', 'query', 'acceptance', 'verify-cmd', 'requires', 'handover', 'design-ref', 'design-na', 'adr', 'design-reviewed', 'json', ...ENTRY, ...ACTOR],
  edit: ['set', 'json', 'reason', ...ACTOR],
  status: ['to', 'reason', ...ACTOR],
  state: [...ENTRY, ...ACTOR],
  close: [...ENTRY, ...ACTOR],
  archive: [...ACTOR],
  decision: ['question', 'blocks', 'adr', 'resolve', ...ACTOR],
  design: ['remove', ...ACTOR],
  element: ['title', 'source', 'state', 'adr', 'note', 'ticket', 'json', ...ACTOR],
  finding: ['summary', 'agent', 'model'],
  context: ['max-chars'],
  stats: ['days', 'json'],
  show: [],
};
const LISTS = new Set(['file', 'symbol', 'entry-point', 'query', 'acceptance', 'requires', 'handover', 'set', 'supersedes', 'link', 'design-ref', 'adr', 'blocks', 'ticket']);
// Flags without a value, per command.
const BOOLS = { design: ['remove'], stats: ['json'] };
// "decision ... --adr" names one ADR; "groom ... --adr" a list.
const isList = (flag) => LISTS.has(flag) && !(cmd === 'decision' && flag === 'adr') && !(cmd === 'element' && flag === 'adr');
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
  if (BOOLS[cmd]?.includes(m[1])) {
    opts[m[1]] = true;
    continue;
  }
  const value = m[2] ?? rest[++i];
  if (value === undefined) fail(`--${m[1]} needs a value`);
  if (isList(m[1])) (opts[m[1]] ??= []).push(value);
  else opts[m[1]] = value;
}
const need = (...keys) => keys.forEach((k) => opts[k] || fail(`${cmd} needs --${k}`));

const rel = (f) => path.relative(root, f).replace(/\\/g, '/');
const boardPath = path.join(root, BOARD_FILE);
const archivePath = path.join(root, ARCHIVE_FILE);
const ledgerPath = path.join(root, DESIGN_FILE);
const knowledgePath = path.join(root, KNOWLEDGE_FILE);
const noteDir = path.join(root, HANDOVER_DIR);
const notePath = (tid) => path.join(noteDir, `${tid}.md`);
const archivedNotePath = (tid) => path.join(root, ARCHIVE_NOTE_DIR, `${tid}.md`);
const flagIndex = path.join(noteDir, 'HANDOVERS.md');
// codegraph_queries are required only when the repository has a CodeGraph index (as in render-board.mjs).
const hasIndex = fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'));

let board;
let archive;
try {
  board = loadBoard(root);
  archive = loadArchive(root);
} catch (e) {
  fail(`cannot read ${BOARD_FILE} or ${ARCHIVE_FILE}: ${e.message}`);
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
const containerNow = (x) => isContainer(typedOf(x), tickets(board));
const kidsOf = (tid) => tickets(board).filter((x) => x.parent === tid);

// Design anchor and ADRs (protocol 10).
const ledger = loadLedger(root);
const elementsById = new Map(ledger.elements.filter((e) => e?.id).map((e) => [e.id, e]));
const adr = adrConfig(board);
const knowledgeDir = String(board.knowledge?.dir ?? 'docs/findings').replace(/\\/g, '/').replace(/\/$/, '');

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
let bodyText;
const body = () => {
  if (bodyText !== undefined) return bodyText;
  if (opts.text !== undefined) return (bodyText = opts.text);
  need('body');
  return (bodyText = readInput(opts.body));
};
function readJson(src, { array = false } = {}) {
  if (src === '-' && opts.body === '-') fail('--json - and --body - cannot both read stdin.');
  try {
    const obj = JSON.parse(readInput(src));
    if (!obj || typeof obj !== 'object' || (Array.isArray(obj) && !array)) throw new Error(array ? 'needs a JSON object or a list of objects' : 'needs a JSON object of fields');
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
// A null text removes the file.
const writes = new Map();
const original = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const current = (f) => (writes.has(f) ? writes.get(f) : original(f));
const eol = (text) => (/\r\n/.test(text ?? '') ? '\r\n' : '\n');
const put = (f, text) => writes.set(f, text);
const json = (obj, before) => (JSON.stringify(obj, null, 2) + '\n').replace(/\n/g, eol(before));
const saveBoard = () => {
  // A container's points and status follow its children (protocol 4.1).
  deriveContainers(board);
  put(boardPath, json(board, original(boardPath)));
};
const saveLedger = () => put(ledgerPath, json({ elements: ledger.elements }, original(ledgerPath)));

const skeleton = (tid) => `# Handover Notes: ${tid} ${findTicket(board, tid)?.title ?? ''}`.trimEnd() + '\n\n<!-- Written only by scripts/kanban/ticket.mjs. STATE is rewritable; entries are append-only. See docs/kanban/protocol.md section 6. -->\n';

function appendEntry(tid, header, text) {
  const f = notePath(tid);
  const rec = findTicket(board, tid);
  const before = current(f) ?? skeleton(tid);
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
    if (text === null) {
      fs.rmSync(f, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  const r = spawnSync(process.execPath, [path.join(here, 'render-board.mjs'), '--from-ticket'], { encoding: 'utf8' });
  if (r.status !== 0) {
    for (const [f, text] of backups) text === null ? fs.rmSync(f, { force: true }) : fs.writeFileSync(f, text);
    process.stderr.write(r.stderr || r.stdout);
    fail('the board did not validate, so nothing was changed.');
  }
  recordScriptWrites(root, Object.fromEntries([...writes].map(([f, text]) => [rel(f), text])));
  process.stderr.write(r.stderr);
  console.log(summary);
  console.log(r.stdout.trim());
}

// ---------- design gates (protocol 10) ----------
const designOn = () => anchorOn(board);
// Why a ticket cannot start or close because of an ADR, a pending decision, or a changed design file.
function userGates(t) {
  const out = [];
  // A decision that blocks a story or an epic blocks every ticket under it.
  const line = [t.id];
  for (let p = findTicket(board, t.parent ?? ''); p && !line.includes(p.id); p = findTicket(board, p.parent ?? '')) line.push(p.id);
  for (const d of board.decisions_pending ?? []) {
    const hit = line.find((x) => (d.blocks ?? []).includes(x));
    if (hit) out.push(`decision ${d.id} waits on the user${hit === t.id ? '' : ` (it blocks ${hit})`}: ${d.question}`);
  }
  if (!adr.problem) {
    for (const a of adrsOf(t, elementsById).map((x) => adrInfo(root, adr, x))) {
      if (!a.file) out.push(`ADR ${a.id} has no file in ${adr.dir}/`);
      else if (!a.accepted) out.push(`${a.file} is "${a.status ?? 'no status'}", not accepted. Only the user accepts an ADR (protocol 10.4)`);
    }
  }
  if (t.design?.pending) out.push(`it has no design link yet (the design anchor was turned on after it was groomed); the coordinator runs groom ${t.id} --design-ref <D-ID> or --design-na "<reason>"`);
  if (t.design?.stale) out.push(`design source ${t.design.stale.source} changed at ${t.design.stale.at}; the coordinator regrooms the ticket, then runs groom ${t.id} --design-reviewed "<text>"`);
  const changed = new Set(sourceDrift(root, board).map((d) => d.path));
  for (const r of refsOf(t)) if (changed.has(elementsById.get(r)?.source)) out.push(`design source ${elementsById.get(r).source} (element ${r}) changed since its hash was recorded; the coordinator runs: ticket.mjs design ${elementsById.get(r).source}`);
  return out;
}
// A review or close body needs a "Knowledge" line: the findings written, or "none" (protocol 6.7).
function knowledgeLine(text, what) {
  const value = labelValue(text, 'Knowledge');
  if (!value) fail(`${what} needs a "Knowledge:" line: the findings files written for it, or "Knowledge: none" (protocol 6.7).`);
  if (/^none\b/i.test(value.replace(/[*_`]/g, ''))) return;
  const names = value.match(/[\w./-]+\.md\b/g) ?? [];
  if (!names.length) fail(`"Knowledge: ${value}" names no finding. Name the .md files in ${knowledgeDir}/, or write "Knowledge: none".`);
  const index = current(knowledgePath) ?? '';
  for (const n of names) if (!index.includes(path.posix.basename(n))) fail(`"Knowledge" names ${n}, which is not in ${KNOWLEDGE_FILE}. Index it with: ticket.mjs finding <file> --summary "<one line>" --agent <name>`);
}
// Closing a story needs its epic's STATE block refreshed since the story before it closed (protocol 6.2.1).
function epicStateGate(t, typed) {
  const epic = typed.type === 'story' && t.parent ? typedOf(findTicket(board, t.parent) ?? {}) : null;
  if (!epic || epic.type !== 'epic') return;
  const at = toIso(parseNote(current(notePath(epic.id)) ?? '').state?.date);
  const prev = tickets(board).filter((x) => x.type === 'story' && x.parent === epic.id && x.id !== t.id && x.status === 'DONE' && x.done_at).map((x) => x.done_at).sort().at(-1);
  const how = `Rewrite it with: ticket.mjs state ${epic.id} --agent <name> --model <model-id> --body <file|->`;
  if (!at) fail(`${epic.id} has no STATE block. A story closes only after its epic's STATE says what is true now (protocol 6.2.1). ${how}`);
  if (prev && at <= prev) fail(`${epic.id} STATE is from ${at}, before the last story under it closed (${prev}). Refresh it before ${t.id} closes (protocol 6.2.1). ${how}`);
}
// Elements whose every ticket is now closed become "built".
function markBuilt() {
  if (!ledger.elements.length) return;
  const byElement = ticketsByElement(tickets(board));
  let changed = false;
  for (const e of ledger.elements) {
    if (e.state === 'planned' && isBuilt((byElement.get(e.id) ?? []).filter((x) => x.status !== 'ABANDONED'))) {
      e.state = 'built';
      changed = true;
    }
  }
  if (changed) saveLedger();
}
// Marks an entry "(SUPERSEDED)" and says what replaced it. ref: "[<NOTE-ID>#]<n>", n as show lists it.
function supersede(ref, byHeader, ownId) {
  const m = String(ref).match(/^(?:([A-Za-z]+-\d+)#)?(\d+)$/);
  if (!m) fail(`--supersedes takes <n> or <NOTE-ID>#<n>, not "${ref}". Run show <ID> to list the entries.`);
  const target = (m[1] ?? ownId).toUpperCase();
  const text = current(notePath(target));
  const e = text === null ? null : parseNote(text).entries[Number(m[2]) - 1];
  if (!e) fail(`handovers/${target}.md has no entry ${m[2]}. Run show ${target} to list the entries.`);
  if (e.mark) fail(`entry ${m[2]} of ${target} is already ${e.mark.toLowerCase()}.`);
  if (!['GROOMING', 'FLAG'].includes(e.type)) fail(`entry ${m[2]} of ${target} is a ${e.type} entry. Only GROOMING and FLAG entries are superseded; PROGRESS, REVIEW, and AMEND entries are history.`);
  const nl = eol(text);
  const header = e.header.replace(/^##\s*([A-Za-z]+)/, '## $1 (SUPERSEDED)');
  const lines = parseNote(text).lines;
  const marked = `${header}${nl}${nl}> Superseded by the entry \`${byHeader.replace(/^##\s*/, '')}\` in handovers/${ownId}.md. Kept for the record; do not act on it.${nl}`;
  put(notePath(target), [...lines.slice(0, e.start), marked, ...lines.slice(e.start + 1)].join(''));
  return `${target}#${m[2]}`;
}
// --link: lists this note in the "handovers" of other tickets, so their workers read it.
function linkNote(noteId) {
  const linked = [];
  for (const target of opts.link ?? []) {
    const list = target.toLowerCase() === 'children' ? tickets(board).filter((x) => x.parent === noteId || findTicket(board, x.parent ?? '')?.parent === noteId).map((x) => x.id) : [target];
    for (const tid of list) {
      const rec = findTicket(board, tid);
      if (!rec) fail(`--link ${tid} is not on the board.`);
      if (rec.archived || CLOSED.includes(rec.status) || (rec.handovers ?? []).includes(noteId)) continue;
      rec.handovers = [...(rec.handovers ?? []), noteId];
      linked.push(tid);
    }
  }
  return linked.length ? ` Listed in the handovers of ${linked.join(', ')}.` : '';
}

// ---------- commands without a ticket ----------
if (cmd === 'stats') {
  const all = tickets(board);
  const since = opts.days ? new Date(Date.now() - Number(opts.days) * 86_400_000).toISOString() : undefined;
  if (opts.days && !(Number(opts.days) > 0)) fail('--days needs a positive number.');
  const v = velocity(all, { since });
  if (opts.json) console.log(JSON.stringify(v, null, 2));
  else {
    const row = (name, g) => `${name.padEnd(8)}${String(g.tickets).padStart(8)}${String(g.points).padStart(8)}${String(g.points_per_day ?? '-').padStart(12)}${String(g.cycle_hours_median ?? '-').padStart(18)}${(g.rework_rate === null ? '-' : `${g.rework_rate}% (${g.reworks})`).padStart(16)}`;
    console.log(`Velocity${opts.days ? `, last ${opts.days} days` : ''} (leaf tickets that are DONE)`);
    console.log(`${'tier'.padEnd(8)}${'tickets'.padStart(8)}${'points'.padStart(8)}${'points/day'.padStart(12)}${'median cycle (h)'.padStart(18)}${'rework rate'.padStart(16)}`);
    console.log(row('all', v.all));
    for (const k of TIERS) console.log(row(k, v.by_tier[k]));
    console.log(`\nPoints per day: points done over the ${v.all.days} calendar day(s) from the first start to the last close.`);
    console.log(`Cycle time: started_at (first claim) to done_at, median, over ${v.all.cycle_measured} ticket(s) with a recorded claim. Tickets backfilled from notes have no claim time and are left out.`);
    console.log(`Rework rate: tickets sent back by review at least once; the number of REWORK reviews is in brackets.`);
  }
  process.exit(0);
}

if (cmd === 'create') {
  const actor = coordinator('Creating a ticket');
  need('title');
  const PREFIX = { epic: 'EPIC', story: 'STORY', task: 'TASK', chore: 'CHORE', bug: 'BUG' };
  // IDs are unique over the board, the archive, and both note folders (protocol 9.1).
  const ids = new Set([...tickets(board).map((x) => x.id), ...Object.keys(GROUPS).flatMap((g) => (archive[g] ?? []).map((x) => x.id))]);
  const free = (tid) => !ids.has(tid) && !fs.existsSync(notePath(tid)) && !fs.existsSync(archivedNotePath(tid));
  let type = Object.keys(PREFIX).find((k) => id.toUpperCase().startsWith(`${PREFIX[k]}-`));
  let newId = id.toUpperCase();
  if (/^[A-Z]+-\d+$/.test(newId)) {
    if (!type) fail(`unknown ID prefix in "${id}"; use ${Object.values(PREFIX).join(', ')}.`);
    if (!free(newId)) fail(`${newId} is already used${ids.has(newId) ? ' on the board or in the archive' : ` by handovers/${newId}.md`}. IDs are never reused (protocol 9.1).`);
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
  if (parent?.archived) fail(`--parent ${opts.parent} is archived.`);
  if (type === 'task' && !parent) fail('a task needs --parent <STORY-ID>.');
  const rec = {
    id: newId,
    title: opts.title,
    description: opts.description ?? null,
    status: 'BACKLOG',
    points: opts.points === undefined ? null : points(opts.points),
    order: null,
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
    design: null,
    adrs: [],
    acceptance: [],
    verify_cmd: null,
    handovers: [],
    created_at: null,
    updated_at: null,
    last_actor: null,
    claims: [],
    started_at: null,
    done_at: null,
    done_by: null,
    done_by_model: null,
    rework_count: 0,
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

// What waits on the user, in one list (protocol 5.4).
if (cmd === 'decision') {
  const actor = coordinator('Recording a decision');
  board.decisions_pending ??= [];
  if (id.toLowerCase() === 'new') {
    need('question', 'blocks');
    for (const b of opts.blocks) if (!findTicket(board, b)) fail(`--blocks ${b} is not on the board.`);
    board.decisions_seq = (board.decisions_seq ?? 0) + 1;
    const dec = { id: `DEC-${String(board.decisions_seq).padStart(3, '0')}`, question: opts.question.trim().replace(/\s+/g, ' '), blocks: opts.blocks, adr: opts.adr ?? null, raised_at: nowIso(), raised_by: actor.name };
    board.decisions_pending.push(dec);
    saveBoard();
    commit(`${dec.id} waits on the user and blocks ${dec.blocks.join(', ')}. Resolve it with: ticket.mjs decision ${dec.id} --resolve "<the user's answer>" ...`);
  } else {
    need('resolve');
    const dec = board.decisions_pending.find((d) => d.id === id.toUpperCase());
    if (!dec) fail(`${id} is not in decisions_pending.`);
    board.decisions_pending = board.decisions_pending.filter((d) => d !== dec);
    const text = [`**Question** (${dec.id}, raised ${dec.raised_at} by ${dec.raised_by ?? 'unknown'})`, dec.question, '', "**The user's answer**", opts.resolve.trim(), ...(dec.adr ? ['', `**ADR:** ${dec.adr}`] : [])].join('\n');
    for (const b of dec.blocks ?? []) {
      const rec = findTicket(board, b);
      if (!rec || rec.archived) continue;
      appendEntry(b, formatHeader('DECISION', `${actor.name} (${opts.model})`, 'RESOLVED'), text);
      stamp(rec, actor);
    }
    saveBoard();
    commit(`${dec.id} resolved; the answer is in the notes of ${(dec.blocks ?? []).join(', ')}.`);
  }
  process.exit(0);
}

// Design sources: files in the repository with a recorded hash (protocol 10.1).
if (cmd === 'design') {
  const actor = coordinator('Recording a design source');
  board.design_sources ??= [];
  const norm = (p) => path.relative(root, path.resolve(root, p)).replace(/\\/g, '/');
  const targets = id.toLowerCase() === 'all' ? board.design_sources.map((s) => s.path) : [norm(id)];
  if (!targets.length) fail('board.json lists no design sources. Add one with: ticket.mjs design <path>');
  const out = [];
  const wasOn = designOn();
  for (const p of targets) {
    const have = board.design_sources.find((s) => s.path === p);
    if (opts.remove) {
      if (!have) fail(`${p} is not a design source.`);
      const used = ledger.elements.filter((e) => e.source === p).map((e) => e.id);
      if (used.length) fail(`${p} is the source of ${used.join(', ')}. Move those elements to another source first.`);
      board.design_sources = board.design_sources.filter((s) => s !== have);
      out.push(`${p} removed.`);
      continue;
    }
    if (p.startsWith('..') || path.isAbsolute(p)) fail(`${id} is outside the repository. A design source is a file in the repository (protocol 10.1).`);
    const abs = path.join(root, p);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`${p} does not exist. Export the design into the repository first (protocol 10.1).`);
    const sha256 = fileHash(abs);
    if (!have) {
      board.design_sources.push({ path: p, sha256, recorded_at: nowIso(), recorded_by: actor.name });
      out.push(`${p} recorded (${sha256.slice(0, 12)}).`);
    } else if (have.sha256 !== sha256) {
      // Source change alarm (protocol 10.5): every open ticket that implements one of its elements is stale.
      const at = nowIso();
      const mine = new Set(ledger.elements.filter((e) => e.source === p).map((e) => e.id));
      const stale = [];
      for (const g of Object.keys(GROUPS)) {
        for (const rec of board[g] ?? []) {
          if (rec.archived || CLOSED.includes(rec.status) || !refsOf(rec).some((r) => mine.has(r))) continue;
          rec.design = { ...rec.design, stale: { source: p, at } };
          stamp(rec, actor);
          stale.push(rec.id);
        }
      }
      Object.assign(have, { sha256, recorded_at: at, recorded_by: actor.name });
      out.push(`${p} changed and was re-recorded (${sha256.slice(0, 12)}). ${stale.length ? `Regroom, then clear with groom <ID> --design-reviewed "<text>": ${stale.join(', ')}.` : 'No open ticket references it.'}`);
    } else out.push(`${p} is unchanged.`);
  }
  if (!wasOn && designOn()) {
    // The anchor turns on. Tickets groomed before it have no design link: they are marked, and cannot be
    // claimed or closed until the coordinator gives each one its link (protocol 10.3).
    const marked = [];
    for (const { rec, type } of liveTickets(board)) {
      if (rec.archived || type === 'epic' || !['TODO', 'IN_PROGRESS', 'PAUSED', 'BLOCKED', 'REVIEW'].includes(rec.status)) continue;
      if (refsOf(rec).length || rec.design?.na) continue;
      rec.design = { ...rec.design, pending: true };
      marked.push(rec.id);
    }
    out.push(`The design anchor is on (protocol 10).${marked.length ? ` These groomed tickets need a design link before they can be claimed or closed (groom <ID> --design-ref <D-ID> | --design-na "<reason>"): ${marked.join(', ')}.` : ''}`);
  }
  saveBoard();
  commit(out.join('\n'));
  process.exit(0);
}

// Design ledger: one row per design element (protocol 10.2).
if (cmd === 'element') {
  const actor = coordinator('Editing the design ledger');
  const rows = opts.json ? [readJson(opts.json, { array: true })].flat() : [{}];
  if (!opts.json) {
    for (const k of ['title', 'source', 'state', 'adr', 'note']) if (opts[k] !== undefined) rows[0][k] = opts[k];
    if (opts.ticket) rows[0].tickets = opts.ticket;
    rows[0].id = id;
  } else if (id.toLowerCase() !== 'new') fail('with --json, use "element new": each row names its own "id", or gets the next one.');
  const done = [];
  for (const row of rows) {
    const FIELDS = ['id', 'title', 'source', 'state', 'adr', 'note', 'tickets'];
    for (const k of Object.keys(row)) if (!FIELDS.includes(k)) fail(`an element has ${FIELDS.join(', ')}; "${k}" is not one of them.`);
    let e = row.id && String(row.id).toLowerCase() !== 'new' ? ledger.elements.find((x) => x.id === row.id) : null;
    if (!e) {
      let newId = row.id && String(row.id).toLowerCase() !== 'new' ? String(row.id) : null;
      if (newId && !/^[A-Za-z][\w.-]*$/.test(newId)) fail(`"${newId}" is not a usable element ID; use letters, digits, ".", "-", "_".`);
      if (!newId) {
        const top = Math.max(0, ...ledger.elements.map((x) => Number(String(x.id).match(/^D-(\d+)$/)?.[1] ?? 0)));
        newId = `D-${String(top + 1).padStart(3, '0')}`;
      }
      if (!row.title || !row.source) fail(`a new element needs a title and a source (one of the board's design_sources).`);
      e = { id: newId, title: '', source: '', state: 'planned', adr: null, note: null };
      ledger.elements.push(e);
    }
    if (row.title !== undefined) e.title = String(row.title).trim();
    if (row.source !== undefined) e.source = String(row.source).replace(/\\/g, '/');
    if (row.state !== undefined) e.state = DESIGN_STATES.includes(row.state) ? row.state : fail(`state must be one of ${DESIGN_STATES.join(', ')}, not "${row.state}".`);
    if (row.adr !== undefined) e.adr = row.adr || null;
    if (row.note !== undefined) e.note = row.note || null;
    // --ticket links the tickets that implement it, by adding the element to their design.refs.
    for (const tid of row.tickets ?? []) {
      const rec = findTicket(board, tid);
      if (!rec) fail(`--ticket ${tid} is not on the board.`);
      const refs = [...new Set([...refsOf(rec), e.id])];
      rec.design = { ...(rec.design?.stale ? { stale: rec.design.stale } : {}), refs };
      if (!rec.archived) stamp(rec, actor);
    }
    done.push(`${e.id} (${e.state})`);
  }
  saveLedger();
  saveBoard();
  commit(`Design ledger: ${done.join(', ')}.`);
  process.exit(0);
}

// Knowledge index: one line per finding (protocol 6.7).
if (cmd === 'finding') {
  need('summary', 'agent');
  const file = path.relative(root, path.resolve(root, id)).replace(/\\/g, '/');
  if (!file.startsWith(`${knowledgeDir}/`) || !/\.md$/i.test(file)) fail(`${id} is not a .md file under ${knowledgeDir}/ (board.json "knowledge.dir"). Project facts live there (protocol 6.7).`);
  if (!fs.existsSync(path.join(root, file))) fail(`${file} does not exist. Write the finding first, then index it.`);
  const before = current(knowledgePath) ?? `# Project Knowledge\n\nOne line per finding in \`${knowledgeDir}/\`. Required reading before grooming and before work (protocol 6.7).\nAdd a line with \`node scripts/kanban/ticket.mjs finding <file> --summary "<one line>" --agent <name>\`.\n\n`;
  const nl = eol(before);
  const link = path.posix.relative(path.posix.dirname(KNOWLEDGE_FILE), file);
  const line = `- [${path.posix.basename(file)}](${link}): ${opts.summary.trim().replace(/\s+/g, ' ')}`;
  const lines = before.replace(/\s*$/, '').split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes(`](${link})`));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  put(knowledgePath, lines.join(nl) + nl);
  commit(`${file} ${at >= 0 ? 'updated' : 'added'} in ${KNOWLEDGE_FILE}.`);
  process.exit(0);
}

// ---------- every other command works on an existing ticket ----------
const t = findTicket(board, id);
if (!t) fail(`${id} is not on the board`);
const typed = typedOf(t);
const tier = requiredTier(typed);
const isCont = containerNow(t);
if (t.archived && !['show', 'context'].includes(cmd)) fail(`${id} is archived: its record is in ${ARCHIVE_FILE} and its note in ${ARCHIVE_NOTE_DIR}/. An archived ticket does not change.`);
// The standing rule sets the tier from type and points; a user tier_override wins (protocol 1.2).
const retier = () => {
  if (isCont || FIB.includes(t.points)) t.model = requiredTier(typedOf(t));
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
const groomingEntries = (text) => {
  const { lines, entries } = parseNote(text);
  return entries.filter((e) => e.type === 'GROOMING').map((e) => ({ ...e, lines, deleted: e.mark === 'DELETED' }));
};
const quote = (text) => text.split(/\r?\n/).map((l) => (l ? `> ${l}` : '>')).join('\n');

switch (cmd) {
  case 'show': {
    const active = tickets(board).filter((x) => x.status === 'IN_PROGRESS' && !isContainer(x, tickets(board)));
    console.log(JSON.stringify(t.archived ? { ...Object.keys(GROUPS).flatMap((g) => archive[g] ?? []).find((x) => x.id === id), archived: true } : t, null, 2));
    console.log(`\nTier: ${tier}${t.tier_override ? ' (user tier_override)' : ''}. Models listed for it in ${tierModels.source}: ${listed(tier)}.`);
    console.log(`Coordinator (large) models: ${listed('large')}.`);
    console.log(`In progress: ${active.map((x) => `${x.id} by ${x.assignee}`).join(', ') || 'none'}.`);
    if (isCont) console.log(`Container: its status and points are derived from ${kidsOf(id).length} children (protocol 4.1). ${t.status === 'REVIEW' ? `Every child is closed; close it with: ticket.mjs close ${id}` : ''}`);
    const gates = t.archived || CLOSED.includes(t.status) ? [] : userGates(t);
    if (gates.length) console.log(`Cannot be claimed yet:\n${gates.map((g) => `  - ${g}`).join('\n')}`);
    const note = readNote(root, id);
    const parsed = parseNote(note ?? '');
    const first = (e) => (e.mark ? '' : `: ${e.body.split(/\r?\n/).find((l) => l.trim())?.slice(0, 80) ?? ''}`);
    console.log(`STATE block: ${parsed.state ? parsed.state.header.replace(/^##\s*/, '') : 'none'}`);
    const grooming = parsed.entries.filter((e) => e.type === 'GROOMING');
    console.log(`GROOMING entries (for note --edit/--delete): ${grooming.length ? '' : 'none'}`);
    grooming.forEach((e, i) => console.log(`  ${i + 1}. ${e.header.replace(/^##\s*/, '')}${first(e)}`));
    console.log(`All entries (for note --supersedes ${id}#<n>): ${parsed.entries.length ? '' : 'none'}`);
    parsed.entries.forEach((e) => console.log(`  ${e.n}. ${e.header.replace(/^##\s*/, '')}`));
    break;
  }

  // The worker's whole reading pack in one bounded output (protocol 6.3).
  case 'context': {
    const max = Number(opts['max-chars'] ?? 60_000);
    if (!(max >= 2000)) fail('--max-chars needs a number of 2000 or more.');
    const full = t.archived ? Object.keys(GROUPS).flatMap((g) => archive[g] ?? []).find((x) => x.id === id) ?? t : t;
    const chain = [];
    for (let p = findTicket(board, full.parent ?? ''); p && !chain.includes(p); p = findTicket(board, p.parent ?? '')) chain.unshift(p);
    const out = [`# Context pack: ${id} ${full.title ?? ''}`, '', `Generated by \`ticket.mjs context ${id}\`. It is the required reading for this ticket (protocol 6.3): read it top to bottom, then claim.`, ''];
    const PICK = ['id', 'title', 'description', 'status', 'points', 'model', 'order', 'parent', 'requires', 'design', 'adrs', 'context', 'acceptance', 'verify_cmd', 'handovers', 'blocked_reason', 'rework_count'];
    out.push('## Ticket', '', '```json', JSON.stringify(Object.fromEntries(PICK.filter((k) => full[k] !== undefined).map((k) => [k, full[k]])), null, 2), '```', '');
    const gates = CLOSED.includes(t.status) ? [] : userGates(full);
    if (gates.length) out.push('## Waiting on the user: do not start', '', ...gates.map((g) => `- ${g}`), '');
    if (refsOf(full).length || full.design?.na) {
      out.push('## Design', '');
      if (full.design?.na) out.push(`No design element: ${full.design.na}`, '');
      for (const r of refsOf(full)) {
        const e = elementsById.get(r);
        out.push(e ? `- \`${e.id}\` ${e.title} (${e.state}). Source: \`${e.source}\`${e.adr ? `. ADR ${e.adr}` : ''}${e.note ? `. ${e.note}` : ''}` : `- \`${r}\` is not in the design ledger.`);
      }
      if (refsOf(full).length) out.push('', 'Open each source file before you implement. Your PROGRESS entry needs a "Design check" section that says how the result matches it.', '');
    }
    const knowledge = current(knowledgePath);
    const knowledgeAt = out.length;
    if (knowledge?.trim()) out.push(`## Knowledge index (${KNOWLEDGE_FILE})`, '', ...knowledge.split(/\r?\n/).filter((l) => /^\s*[-*]\s/.test(l)), '', 'Open a finding when its line touches your work.', '');
    const knowledgeEnd = out.length;
    for (const p of chain) {
      const st = parseNote(readNote(root, p.id) ?? '').state;
      out.push(`## ${p.id} STATE: ${p.title ?? ''}`, '', st ? `*${st.header.replace(/^##\s*STATE\s*·?\s*/, '')}*\n\n${st.body}` : `*No STATE block. Tell the coordinator: ticket.mjs state ${p.id}.*`, '');
    }
    // Inherited notes give their live GROOMING, FLAG, and DECISION entries; the ticket's own note gives every live entry.
    const noteIds = [...new Set([...chain.map((p) => p.id), ...(full.handovers ?? []).filter((h) => h !== id), id])];
    const blocks = [];
    for (const nid of noteIds) {
      const parsed = parseNote(readNote(root, nid) ?? '');
      const own = nid === id;
      const live = parsed.entries.filter((e) => !e.mark && (own || ['GROOMING', 'FLAG', 'DECISION'].includes(e.type)));
      const skipped = parsed.entries.filter((e) => e.mark).length;
      if (own && parsed.state) blocks.push({ nid, own, text: `### ${nid} STATE\n\n${parsed.state.body}\n` });
      for (const e of live) blocks.push({ nid, own, text: `### ${nid} entry ${e.n}: ${e.header.replace(/^##\s*/, '')}\n\n${e.body}\n` });
      if (skipped) blocks.push({ nid, own, keep: true, text: `*${skipped} superseded or deleted entr${skipped === 1 ? 'y' : 'ies'} of ${nid} left out.*\n` });
    }
    const reqs = (full.requires ?? []).map((r) => {
      const last = parseNote(readNote(root, r) ?? '').entries.filter((e) => e.type === 'PROGRESS' && !e.mark).at(-1);
      return `### ${r} (${findTicket(board, r)?.status ?? 'unknown'}): last PROGRESS entry\n\n${last ? `*${last.header.replace(/^##\s*/, '')}*\n\n${last.body}` : '*None.*'}\n`;
    });
    const fixed = () => out.join('\n').length + reqs.join('\n').length + 200;
    // Bound the output: drop the oldest inherited entries first, then the knowledge index.
    const dropped = new Map();
    while (fixed() + blocks.reduce((n, b) => n + b.text.length + 1, 0) > max) {
      const at = blocks.findIndex((b) => !b.own && !b.keep);
      if (at < 0) break;
      dropped.set(blocks[at].nid, (dropped.get(blocks[at].nid) ?? 0) + 1);
      blocks.splice(at, 1);
    }
    if (fixed() + blocks.reduce((n, b) => n + b.text.length + 1, 0) > max && knowledgeEnd > knowledgeAt) {
      out.splice(knowledgeAt, knowledgeEnd - knowledgeAt, `## Knowledge index`, '', `Left out to fit the size limit. Read ${KNOWLEDGE_FILE}.`, '');
    }
    out.push('## Notes', '', ...blocks.map((b) => b.text));
    for (const [nid, n] of dropped) out.push(`*${n} older entr${n === 1 ? 'y' : 'ies'} of ${nid} left out to fit the size limit; read ${HANDOVER_DIR}/${nid}.md if you need them.*`, '');
    if (reqs.length) out.push('## Requires', '', ...reqs);
    let text = out.join('\n');
    if (text.length > max) text = `${text.slice(0, max)}\n\n*Cut at ${max} characters. Raise --max-chars or read ${HANDOVER_DIR}/${id}.md.*`;
    console.log(text);
    break;
  }

  case 'claim': {
    need('worker', 'model');
    if (isCont) fail(`${id} is a ${typed.type} with children: its tasks are claimed, not the ${typed.type}. When every child is closed, the coordinator closes it with: ticket.mjs close ${id} (protocol 4.1).`);
    if (!['TODO', 'PAUSED'].includes(t.status)) fail(`${id} is ${t.status}; only TODO or PAUSED tickets can be claimed (protocol 1.3, 6.5).`);
    const notDone = (t.requires ?? []).filter((r) => findTicket(board, r)?.status !== 'DONE');
    if (notDone.length) fail(`${id} requires ${notDone.join(', ')}, which are not DONE (protocol 6.5 step 2).`);
    const all = tickets(board);
    const other = all.find((x) => x.status === 'IN_PROGRESS' && !isContainer(x, all));
    if (other) fail(`${other.id} is already IN_PROGRESS (by ${other.assignee ?? 'none'}). Ask the user whether to PAUSE or ABANDON it (protocol 5.2).`);
    // Design drift gates (protocol 10.4, 10.5) and the user's open decisions (protocol 5.4).
    const gates = userGates(t);
    if (gates.length) fail(`${id} cannot be claimed yet:\n- ${gates.join('\n- ')}\nStop and report this; do not work around it.`);
    // Required reading starts with the STATE block of the story and the epic (protocol 6.2.1).
    for (let p = findTicket(board, t.parent ?? ''), n = 0; p && n < 5; p = findTicket(board, p.parent ?? ''), n++) {
      if (!parseNote(current(notePath(p.id)) ?? '').state) fail(`${p.id} has no STATE block, so ${id} has no current scope to read (protocol 6.2.1). The coordinator writes it with: ticket.mjs state ${p.id} --agent <name> --model <model-id> --body <file|->`);
    }
    // Lane order (protocol 4.2): the lowest "order" among the tickets that can start goes first.
    const ready = (x) => !isContainer(x, all) && x.type !== 'epic' && ['TODO', 'PAUSED'].includes(x.status) && (x.requires ?? []).every((r) => findTicket(board, r)?.status === 'DONE');
    const before = all.filter((x) => x.id !== id && ready(x) && typeof x.order === 'number' && (typeof t.order !== 'number' || x.order < t.order));
    if (before.length && !opts['out-of-order']) {
      fail(`${id}${typeof t.order === 'number' ? ` (order ${t.order})` : ' (no order)'} is not next in the lane: ${before.sort((a, b) => a.order - b.order).slice(0, 5).map((x) => `${x.id} (order ${x.order})`).join(', ')} can start first (protocol 4.2). Claim that one, or pass --out-of-order "<the user's reason>".`);
    }
    const fits = fitsTier(opts.model, tier);
    const own = coordinatorRuns(opts.model);
    if (!fits && !inline && !own) requireTier(opts.model, tier, `${id} (tier "${tier}")`);
    const actor = workerActor(opts.worker, opts.model);
    t.status = 'IN_PROGRESS';
    t.assignee = opts.worker;
    t.claimed_at = nowIso();
    t.worker_model = opts.model;
    t.started_at ??= t.claimed_at;
    t.claims = [...(t.claims ?? []), { worker: opts.worker, model: opts.model, tier: actor.tier, claimed_at: t.claimed_at, released_at: null, outcome: null, ...(before.length ? { out_of_order: opts['out-of-order'] } : {}) }];
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
    if (t.status !== 'IN_PROGRESS' || isCont) fail(`${id} is ${t.status}; only an IN_PROGRESS ticket is handed over.`);
    if (opts.worker && opts.worker !== t.assignee) fail(`${id} is claimed by ${t.assignee}, not ${opts.worker}.`);
    if (status === 'BLOCKED' && !opts.reason) fail('BLOCKED needs --reason (protocol 5).');
    // Design check (protocol 10.6): the worker compares the result with the design, in writing.
    if (status === 'REVIEW' && designOn() && !hasLabel(body(), 'Design check')) {
      fail(`a REVIEW handover needs a "**Design check**" section: for each design element in design.refs, how the result matches its source file, or "not applicable" with the design.na reason (protocol 10.6).`);
    }
    const who = `${t.assignee ?? 'unknown'}${t.worker_model ? ` (${t.worker_model})` : ''}`;
    appendEntry(id, formatHeader('PROGRESS', who, status), body());
    stamp(t, workerActor(t.assignee, t.worker_model));
    closeClaim(status);
    if (status === 'REVIEW') {
      // Who delivered it. These stay on the ticket after it is DONE (protocol 6.1).
      t.done_by = t.assignee ?? null;
      t.done_by_model = t.worker_model ?? null;
    }
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
        if (opts.supersedes || opts.link) fail('--supersedes and --link go with a new entry, not with --edit or --delete.');
        const deleting = opts.delete !== undefined;
        const n = Number(opts.edit ?? opts.delete);
        if (deleting && !opts.reason) fail('--delete needs --reason; the AMEND entry records why (protocol 6.2).');
        const text = current(notePath(id));
        const entries = text === null ? [] : groomingEntries(text);
        const e = entries[n - 1];
        if (!Number.isInteger(n) || !e) fail(`${id} has ${entries.length} GROOMING entr${entries.length === 1 ? 'y' : 'ies'}; --${deleting ? 'delete' : 'edit'} takes 1..${entries.length}. Run show ${id} to list them.`);
        if (e.deleted) fail(`GROOMING entry ${n} of ${id} is already deleted.`);
        if (e.mark) fail(`GROOMING entry ${n} of ${id} is superseded; it is history now.`);
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
      const header = formatHeader('GROOMING', who);
      const marked = (opts.supersedes ?? []).map((ref) => supersede(ref, header, id));
      appendEntry(id, header, body() + (marked.length ? `\n\n*Supersedes ${marked.join(', ')}.*` : ''));
      const linked = linkNote(id);
      stamp(t, actor);
      saveBoard();
      commit(`GROOMING entry added to ${HANDOVER_DIR}/${id}.md.${marked.length ? ` Superseded: ${marked.join(', ')}.` : ''}${linked}`);
    } else if (type === 'FLAG') {
      need('from', 'summary');
      if (opts.edit !== undefined || opts.delete !== undefined) fail('--edit and --delete work on GROOMING entries only.');
      if (!findTicket(board, opts.from)) fail(`--from ${opts.from} is not on the board`);
      const all = tickets(board);
      const active = all.find((x) => x.status === 'IN_PROGRESS' && !isContainer(x, all));
      const isWorker = !!active && active.assignee === opts.agent;
      const model = opts.model ?? (isWorker ? active.worker_model : null);
      // Marking another entry as superseded is the coordinator's call.
      if (opts.supersedes) coordinator('Superseding an entry');
      const header = formatHeader('FLAG', `from ${opts.from}`, `${opts.agent}${model ? ` (${model})` : ''}`);
      const marked = (opts.supersedes ?? []).map((ref) => supersede(ref, header, id));
      appendEntry(id, header, body() + (marked.length ? `\n\n*Supersedes ${marked.join(', ')}.*` : ''));
      const index = current(flagIndex) ?? '| Target | From | Summary | Note |\n|---|---|---|---|\n';
      const row = `| \`${id}\` | \`${opts.from}\` | ${opts.summary.replace(/\|/g, '\\|').replace(/\s+/g, ' ')} | [${id}.md](./${id}.md) |`;
      put(flagIndex, index.replace(/\s*$/, '') + eol(index) + row + eol(index));
      const linked = linkNote(id);
      stamp(t, { name: opts.agent, role: isWorker ? 'worker' : 'coordinator', model, tier: model ? actorTier(model, isWorker ? requiredTier(active) : 'large') : null });
      saveBoard();
      commit(`FLAG entry added to ${HANDOVER_DIR}/${id}.md and HANDOVERS.md.${linked}`);
    } else fail('--type must be GROOMING or FLAG. PROGRESS and REVIEW entries come from handover and review; STATE comes from state.');
    break;
  }

  // The STATE block of an epic or story note: what is true now (protocol 6.2.1).
  case 'state': {
    const actor = coordinator('Writing a STATE block');
    if (!['epic', 'story'].includes(typed.type)) fail(`${id} is a ${typed.type}. Only epic and story notes have a STATE block; a ${typed.type} is described by its GROOMING entry.`);
    const problems = stateProblems(body());
    const digest = digestLines(body());
    if (digest && digest.length > DIGEST_MAX_LINES) problems.push(`the Digest is ${digest.length} lines; keep it to ${DIGEST_MAX_LINES} or fewer`);
    if (problems.length) fail(`${problems.join('; ')}. A STATE block has **Scope**, **Order**, **Decisions in force**, and **Open for the user**; a story adds **Digest** before it is archived (protocol 6.2.1).`);
    put(notePath(id), withState(current(notePath(id)) ?? skeleton(id), formatHeader('STATE', `${opts.agent} (${opts.model})`), body()));
    if (!(t.handovers ?? []).includes(id)) t.handovers = [...(t.handovers ?? []), id];
    stamp(t, actor);
    saveBoard();
    commit(`STATE block of ${HANDOVER_DIR}/${id}.md written. It replaces the previous one; git keeps the history.`);
    break;
  }

  case 'review': {
    need('outcome', 'reviewer');
    const outcome = opts.outcome.toUpperCase();
    if (!['DONE', 'REWORK'].includes(outcome)) fail('--outcome must be DONE or REWORK.');
    if (isCont) fail(`${id} has children; close it with: ticket.mjs close ${id} (protocol 4.1).`);
    if (t.status !== 'REVIEW') fail(`${id} is ${t.status}; only a REVIEW ticket is reviewed.`);
    const actor = coordinator('Review', opts.reviewer);
    if (outcome === 'DONE') {
      // Design line (protocol 10.6), and for a story the Knowledge line and the epic STATE (6.7, 6.2.1).
      if (designOn() && !hasLabel(body(), 'Design')) fail('a DONE review needs a "**Design**" line: what the coordinator compared with the design sources, and the result (protocol 10.6).');
      if (t.design?.stale) fail(`design source ${t.design.stale.source} changed while ${id} was open. Check the work against it, then run: ticket.mjs groom ${id} --design-reviewed "<text>"`);
      if (t.design?.pending) fail(`${id} has no design link. Give it one before it closes: ticket.mjs groom ${id} --design-ref <D-ID> | --design-na "<reason>" (protocol 10.3).`);
      if (typed.type === 'story') {
        knowledgeLine(body(), 'a story review');
        epicStateGate(t, typed);
      }
    }
    appendEntry(id, formatHeader('REVIEW', `${opts.reviewer} (${opts.model})`, outcome), body());
    t.status = outcome === 'DONE' ? 'DONE' : 'TODO';
    if (outcome === 'DONE') {
      t.done_at = nowIso();
      dropFlagRows(id);
    } else t.rework_count = (t.rework_count ?? 0) + 1;
    stamp(t, actor);
    saveBoard();
    if (outcome === 'DONE') markBuilt();
    commit(`${id} is ${t.status}.`);
    break;
  }

  // Closes an epic or a story with children, once every child is closed (protocol 4.1, 8.2).
  case 'close': {
    const actor = coordinator('Closing a story or epic');
    if (!isCont) fail(`${id} has no children. ${typed.type === 'epic' ? 'An epic without children has nothing to close.' : `It is reviewed like a task: ticket.mjs review ${id}`}`);
    const openKids = kidsOf(id).filter((x) => !CLOSED.includes(x.status));
    if (openKids.length) fail(`${id} has children that are not DONE or ABANDONED: ${openKids.map((x) => `${x.id} (${x.status})`).join(', ')}.`);
    if (t.status === 'DONE') fail(`${id} is already DONE.`);
    if (!kidsOf(id).some((x) => x.status === 'DONE')) fail(`every child of ${id} is ABANDONED. Abandon it with: ticket.mjs status ${id} --to ABANDONED --reason "<why>"`);
    if (designOn() && !hasLabel(body(), 'Design')) fail(`closing ${id} needs a "**Design**" line: the design elements it covered, compared with their source files, and the result (protocol 10.6).`);
    if (t.design?.pending || t.design?.stale) fail(`${id} ${t.design.pending ? 'has no design link' : `was groomed against an older ${t.design.stale.source}`}. Fix it before it closes: ticket.mjs groom ${id} ${t.design.pending ? '--design-ref <D-ID> | --design-na "<reason>"' : '--design-reviewed "<text>"'} (protocol 10).`);
    knowledgeLine(body(), `closing ${id}`);
    epicStateGate(t, typed);
    appendEntry(id, formatHeader('REVIEW', `${opts.agent} (${opts.model})`, 'DONE'), body());
    t.status = 'DONE';
    t.done_at = nowIso();
    t.done_by = opts.agent;
    t.done_by_model = opts.model;
    dropFlagRows(id);
    stamp(t, actor);
    saveBoard();
    markBuilt();
    commit(`${id} is DONE. Stop and ask the user before you commit, push, or start the next ${typed.type} (protocol 8.2).${typed.type === 'story' ? ` Archive its children with: ticket.mjs archive ${id}` : ''}`);
    break;
  }

  // Moves closed tickets off the board: the record to the archive file, the note to handovers/archive/ (protocol 6.6).
  case 'archive': {
    coordinator('Archiving');
    let targets;
    if (isCont) {
      if (typed.type !== 'story') fail(`archive takes a DONE story (its closed children move), or a closed chore, bug, or story without children. ${id} is an epic.`);
      if (t.status !== 'DONE') fail(`${id} is ${t.status}; only the children of a DONE story are archived.`);
      const digest = digestLines(parseNote(current(notePath(id)) ?? '').state?.body ?? '');
      if (!digest?.length) fail(`${id} has no Digest. Before its children leave the board, its STATE block gets a "**Digest**" section of at most ${DIGEST_MAX_LINES} lines: what was built, decisions, traps (protocol 6.6). Write it with: ticket.mjs state ${id} ...`);
      if (digest.length > DIGEST_MAX_LINES) fail(`the Digest of ${id} is ${digest.length} lines; keep it to ${DIGEST_MAX_LINES} or fewer.`);
      targets = kidsOf(id).filter((x) => CLOSED.includes(x.status) && !x.archived && !isContainer(x, tickets(board)));
      if (!targets.length) fail(`${id} has no closed child left to archive.`);
    } else {
      if (!CLOSED.includes(t.status)) fail(`${id} is ${t.status}; only DONE or ABANDONED tickets are archived.`);
      if (findTicket(board, t.parent ?? '') && typedOf(findTicket(board, t.parent)).type === 'story') fail(`${id} belongs to ${t.parent}. Archive the story instead: ticket.mjs archive ${t.parent}`);
      targets = [typed];
    }
    for (const x of targets) {
      const group = Object.keys(GROUPS).find((g) => (board[g] ?? []).some((r) => r.id === x.id));
      const at = board[group].findIndex((r) => r.id === x.id);
      const rec = board[group][at];
      (archive[group] ??= []).push({ ...rec, archived_at: nowIso() });
      board[group][at] = { ...Object.fromEntries(STUB_FIELDS.filter((k) => rec[k] !== undefined).map((k) => [k, rec[k]])), archived: true };
      const note = current(notePath(x.id));
      if (note !== null) {
        put(archivedNotePath(x.id), note);
        put(notePath(x.id), null);
      }
      dropFlagRows(x.id);
    }
    put(archivePath, json(archive, original(archivePath)));
    saveBoard();
    commit(`${targets.length} ticket${targets.length === 1 ? '' : 's'} archived (${targets.map((x) => x.id).join(', ')}). Records: ${ARCHIVE_FILE}. Notes: ${ARCHIVE_NOTE_DIR}/.`);
    break;
  }

  case 'recover': {
    need('coordinator');
    if (t.status !== 'IN_PROGRESS' || isCont) fail(`${id} is ${t.status}; only an IN_PROGRESS claim is recovered.`);
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
    // After a design source changed, the coordinator confirms the ticket against it. Any open status.
    // So is giving a ticket its design link: neither changes what the worker was told to build.
    const DESIGN_ONLY = ['design-reviewed', 'design-ref', 'design-na', 'adr', 'agent', 'model'];
    const onlyDesignReview = Object.keys(opts).some((k) => k.startsWith('design-')) && Object.keys(opts).every((k) => DESIGN_ONLY.includes(k)) && !CLOSED.includes(t.status);
    if (!onlyDesignReview && !['BACKLOG', 'TODO', 'PAUSED', 'BLOCKED'].includes(t.status) && !isCont) {
      fail(`${id} is ${t.status}. Groom a BACKLOG, TODO, PAUSED, or BLOCKED ticket; an IN_PROGRESS ticket belongs to its worker, and REVIEW, DONE, and ABANDONED are history.`);
    }
    if (isCont && CLOSED.includes(t.status)) fail(`${id} is ${t.status}; it is history.`);
    const GROOM_FIELDS = ['points', 'order', 'context', 'acceptance', 'verify_cmd', 'requires', 'handovers', 'design', 'adrs'];
    const fields = opts.json ? readJson(opts.json) : {};
    for (const k of Object.keys(fields)) if (!GROOM_FIELDS.includes(k)) fail(`groom sets ${GROOM_FIELDS.join(', ')}; change "${k}" with edit.`);
    if (opts.points !== undefined) fields.points = opts.points;
    if (opts.order !== undefined) fields.order = opts.order;
    const ctx = { file: 'files', symbol: 'symbols', 'entry-point': 'entry_points', query: 'codegraph_queries' };
    for (const [flag, key] of Object.entries(ctx)) if (opts[flag]) (fields.context ??= {})[key] = opts[flag];
    if (opts.acceptance) fields.acceptance = opts.acceptance;
    if (opts['verify-cmd'] !== undefined) fields.verify_cmd = opts['verify-cmd'];
    if (opts.requires) fields.requires = opts.requires;
    if (opts.handover) fields.handovers = opts.handover;
    if (opts['design-ref'] && opts['design-na'] !== undefined) fail('use --design-ref or --design-na, not both.');
    if (opts['design-ref']) fields.design = { refs: opts['design-ref'] };
    if (opts['design-na'] !== undefined) fields.design = { na: opts['design-na'] };
    if (opts.adr) fields.adrs = opts.adr;
    if (!Object.keys(fields).length && !hasBody() && opts['design-reviewed'] === undefined) fail('groom needs at least one field flag, --json, or a GROOMING entry (--body or --text).');

    const strings = (k, v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : fail(`${k} must be a list of strings.`));
    if (fields.points !== undefined) {
      if (isCont) fail(`${id} has children, so its points are their sum (protocol 4.1). Estimate the children.`);
      t.points = points(fields.points);
    }
    if (fields.order !== undefined) {
      const n = fields.order === null || fields.order === 'none' || fields.order === '' ? null : Number(fields.order);
      if (n !== null && !Number.isFinite(n)) fail(`order must be a number, or "none" to clear it, not "${fields.order}".`);
      t.order = n;
    }
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
    if (fields.handovers !== undefined) {
      t.handovers = strings('handovers', fields.handovers);
      // A note that is listed before its first entry exists gets an empty file, so one command is enough.
      for (const h of t.handovers) {
        if (current(notePath(h)) !== null || fs.existsSync(archivedNotePath(h))) continue;
        if (!findTicket(board, h)) fail(`handovers: ${h} is not a ticket on the board, and handovers/${h}.md does not exist.`);
        put(notePath(h), skeleton(h));
      }
    }
    if (fields.design !== undefined) {
      const d = fields.design;
      if (d !== null && (typeof d !== 'object' || Array.isArray(d))) fail('design must be { "refs": [...] } or { "na": "<reason>" }.');
      if (d?.refs !== undefined) for (const r of strings('design.refs', d.refs)) if (!elementsById.has(r)) fail(`design.refs: ${r} is not in ${DESIGN_FILE}. Add it with: ticket.mjs element new --title ... --source ...`);
      if (d?.na !== undefined && !(typeof d.na === 'string' && d.na.trim())) fail('design.na needs the reason the ticket implements no design element.');
      // Setting the design link again is a regroom, but a stale mark is cleared only by --design-reviewed.
      t.design = d === null ? null : { ...(d.refs?.length ? { refs: d.refs } : {}), ...(d.na ? { na: d.na.trim() } : {}), ...(t.design?.stale ? { stale: t.design.stale } : {}) };
    }
    if (fields.adrs !== undefined) {
      t.adrs = strings('adrs', fields.adrs);
      for (const a of t.adrs) if (!adrInfo(root, adr, a).file) fail(`adrs: no file in ${adr.dir}/ matches "${a}" (board.json "adr.dir").`);
    }
    if (opts['design-reviewed'] !== undefined) {
      if (!t.design?.stale) fail(`${id} has no stale design mark to clear.`);
      const { stale, ...restDesign } = t.design;
      t.design = restDesign;
      appendEntry(id, formatHeader('AMEND', `${opts.agent} (${opts.model})`, 'EDITED'), [`Design source \`${stale.source}\` changed (re-recorded ${stale.at}). The ticket was checked against the new version.`, '', `**Result:** ${opts['design-reviewed'].trim()}`].join('\n'));
    }
    retier();
    if (hasBody()) appendEntry(id, formatHeader('GROOMING', `${opts.agent} (${opts.model})`), body());
    // The ticket's own note, once it exists, is always listed (protocol 3.1).
    if (current(notePath(id)) !== null && !(t.handovers ?? []).includes(id)) t.handovers = [id, ...(t.handovers ?? [])];
    stamp(t, actor);

    let summary = `${id} groomed (tier ${t.model ?? 'not set'}).`;
    if (t.status === 'BACKLOG' && !isCont) {
      // The same checks render-board.mjs makes for a TODO ticket. An epic needs only its estimate.
      const problems = FIB.includes(t.points) ? [] : [`points must be one of ${FIB.join(', ')}`];
      if (typed.type !== 'epic') {
        problems.push(...groomingProblems(typedOf(t), { noteText: (x) => current(notePath(x)), hasIndex, design: { on: designOn(), ids: new Set(elementsById.keys()) } }));
        if (t.points >= 13) problems.push(`${t.points} pts is too large; split it${typed.type === 'story' ? ' into tasks' : ''}`);
      }
      if (problems.length) summary += ` It stays in BACKLOG until the Definition of Groomed passes (protocol 3.1):\n- ${problems.join('\n- ')}`;
      else {
        t.status = 'TODO';
        summary = `${id} groomed and moved to TODO (tier ${t.model}).`;
      }
    } else if (isCont) summary = `${id} groomed. Its status and points follow its children (protocol 4.1).`;
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
    const velocityField = 'claim, handover, and review write it (protocol 6.1)';
    const STATE = {
      id: 'IDs never change (protocol 9.1)',
      type: 'the type follows the board.json group; create a new ticket instead',
      status: 'use claim, handover, review, close, recover, or status',
      assignee: 'claim and handover set it',
      claimed_at: 'claim and handover set it',
      worker_model: 'claim and handover set it',
      claims: 'claim, handover, and recover keep it',
      blocked_reason: 'handover --status BLOCKED --reason sets it, and status --to TODO clears it',
      created_at: 'ticket.mjs stamps it',
      updated_at: 'ticket.mjs stamps it',
      last_actor: 'ticket.mjs stamps it',
      started_at: velocityField,
      done_at: velocityField,
      done_by: velocityField,
      done_by_model: velocityField,
      rework_count: velocityField,
      stamps_backfilled: 'migrate.mjs sets it',
      archived: 'archive sets it',
      model: 'the standing tier rule sets it from type and points (protocol 1.2)',
      tier_override: 'only the user writes it (protocol 1.2)',
    };
    const getPath = (obj, keys) => keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);
    const changes = [];
    const oldParent = t.parent;
    for (const [key, value] of Object.entries(fields)) {
      const keys = key.split('.');
      if (STATE[keys[0]]) fail(`edit does not change "${keys[0]}": ${STATE[keys[0]]}.`);
      if (keys[0] === 'points' && isCont) fail(`edit does not change "points" of ${id}: it has children, so its points are their sum (protocol 4.1).`);
      if (keys[0] === 'design') fail('edit does not change "design": set the link with groom --design-ref | --design-na, and clear a stale mark with groom --design-reviewed (protocol 10).');
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
    // A container follows its children. The one hand move is ABANDONED, once every child is closed.
    const MOVES = isCont
      ? { ABANDONED: STATUSES_OPEN() }
      : typed.type === 'epic'
        ? { BACKLOG: ['TODO'], TODO: ['BACKLOG'], ABANDONED: ['BACKLOG', 'TODO'] }
        : { BACKLOG: ['TODO', 'PAUSED', 'BLOCKED'], TODO: ['BACKLOG', 'PAUSED', 'BLOCKED'], ABANDONED: ['BACKLOG', 'TODO', 'PAUSED', 'BLOCKED', 'REVIEW'] };
    const HINT = {
      IN_PROGRESS: 'a worker claims it with claim',
      REVIEW: 'the worker hands it over with handover --status REVIEW',
      PAUSED: 'the worker hands it over, or the coordinator recovers an orphaned claim with recover',
      BLOCKED: 'the worker hands it over with handover --status BLOCKED',
      DONE: isCont || typed.type === 'epic' ? `the coordinator closes it with close ${id}, once every child is closed` : 'the coordinator reviews it with review --outcome DONE',
      ...(isCont ? { BACKLOG: 'it follows its children (protocol 4.1)', TODO: 'it follows its children (protocol 4.1)' } : {}),
    };
    if (from === to) fail(`${id} is already ${to}.`);
    if (!MOVES[to]) fail(`status does not set ${to}${HINT[to] ? `: ${HINT[to]}` : ''}.`);
    if (!MOVES[to].includes(from)) {
      fail(`${id} cannot move from ${from} to ${to} with status.${from === 'IN_PROGRESS' && !isCont ? ' Its worker hands it over first, or recover the orphaned claim (protocol 5.3).' : ''}`);
    }
    if (to === 'ABANDONED' && !opts.reason) fail('ABANDONED needs --reason (protocol 5).');
    if (isCont) {
      const openKids = kidsOf(id).filter((x) => !CLOSED.includes(x.status));
      if (openKids.length) fail(`${id} has children that are not DONE or ABANDONED: ${openKids.map((x) => `${x.id} (${x.status})`).join(', ')}. Close or abandon them first.`);
    }
    t.status = to;
    t.blocked_reason = null;
    if (to === 'ABANDONED') dropFlagRows(id);
    appendEntry(id, formatHeader('AMEND', `${opts.agent} (${opts.model})`, to), [`Status ${from} → ${to}.`, '', `**Reason:** ${opts.reason?.trim() || 'not given'}`].join('\n'));
    stamp(t, actor);
    saveBoard();
    commit(`${id} is ${to}.`);
    break;
  }
}

function STATUSES_OPEN() {
  return ['BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW'];
}
