#!/usr/bin/env node
// Upgrades docs/kanban/board.json in place to the schema of this version. Safe to run again: a second
// run changes nothing. The installer's "upgrade" runs it; you can also run it yourself.
//
//   node scripts/kanban/migrate.mjs                      migrate, validate, and write BOARD.md
//   node scripts/kanban/migrate.mjs --dry-run            print what would change, write nothing
//   node scripts/kanban/migrate.mjs --order-from=<field> also copy a numeric ticket field (for example "lane") to "order"
//
// What it does:
// - Schema: "$schema" and "_ticket_template" follow this version; missing top-level keys get their defaults
//   (design_sources [], adr, knowledge, decisions_pending [], size_limit_kb); legacy WIP keys are removed.
//   "adr.dir" and "knowledge.dir" are set to the folder the project already has, when one is found.
// - Tiers: provider model names become tiers; open tickets get the tier the standing rule requires.
// - Stamps (0.8): created_at, updated_at, last_actor, claims, from the dated entries of each note.
// - Velocity (0.9): started_at, done_at, done_by, done_by_model, rework_count, from the PROGRESS and REVIEW
//   entry headers of each note. A start time taken from a note is the first hand-over, not the claim, so the
//   ticket is marked "stamps_backfilled" and left out of cycle time.
// - Containers: the status and points of every epic and of every story with children are derived from the children.
// - docs/kanban/KNOWLEDGE.md: created, with one line per file in the findings folder.
// The design anchor stays off: it starts when the project declares a design source (protocol 10).
// It never touches notes, tier_override, tiers.json, or fields it does not know.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_FILE, CLOSED, GROUPS, HANDOVER_DIR, KNOWLEDGE_FILE, SIZE_LIMIT_KB, deriveContainers, liveTickets, nowIso, parseNote, recordScriptWrites, toIso } from './board-lib.mjs';
import { TIERS, loadTierModels, modelFitsTier, policyTier, requiredTier, tierProblem } from './tier-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const orderFrom = args.find((a) => a.startsWith('--order-from='))?.split('=')[1];

// Every field of a ticket, as documentation. board.json "_ticket_template" is a copy of this.
const TICKET_TEMPLATE = {
  id: 'TASK-001',
  title: 'Short imperative title',
  description: 'Why the work is needed (optional)',
  status: 'BACKLOG',
  points: 3,
  order: 10,
  parent: 'STORY-001',
  children: [],
  requires: [],
  blocks: [],
  model: 'medium',
  tier_override: null,
  assignee: null,
  claimed_at: null,
  worker_model: null,
  blocked_reason: null,
  context: {
    files: ['src/path/to/file.ts'],
    symbols: ['ClassName.method', 'functionName'],
    entry_points: ['src/index.ts'],
    codegraph_queries: ['ClassName.method functionName'],
  },
  design: { refs: ['D-001'] },
  adrs: [],
  acceptance: ['Observable result that proves the ticket is done'],
  verify_cmd: 'npm test -- path/to/test',
  handovers: ['TASK-001'],
  created_at: '2026-10-23T15:52:42Z',
  updated_at: '2026-10-23T16:10:05Z',
  last_actor: { name: 'claude-large', role: 'coordinator', model: 'claude-opus-5-5', tier: 'large' },
  claims: [{ worker: 'claude-medium', model: 'claude-sonnet-5-5', tier: 'medium', claimed_at: '2026-10-23T16:00:00Z', released_at: '2026-10-23T16:08:12Z', outcome: 'REVIEW' }],
  started_at: '2026-10-23T16:00:00Z',
  done_at: '2026-10-23T16:10:05Z',
  done_by: 'claude-medium',
  done_by_model: 'claude-sonnet-5-5',
  rework_count: 0,
};

const firstDir = (list, fallback) => list.find((d) => fs.existsSync(path.join(root, d)) && fs.statSync(path.join(root, d)).isDirectory()) ?? fallback;
// Top-level keys in the order they are written. A key the board has is kept, except the two the template owns.
const schema = () => ({
  $schema: './protocol.md',
  wip_limit: 1,
  coordinator_paths: [],
  size_limit_kb: SIZE_LIMIT_KB,
  design_sources: [],
  adr: { dir: firstDir(['docs/adr', 'docs/adrs', 'docs/decisions', 'docs/architecture/decisions', 'doc/adr', 'adr'], 'docs/adr') },
  knowledge: { dir: firstDir(['docs/findings', 'docs/knowledge'], 'docs/findings') },
  decisions_pending: [],
  _ticket_template: TICKET_TEMPLATE,
  ...Object.fromEntries(Object.keys(GROUPS).map((g) => [g, []])),
});

const file = path.join(root, BOARD_FILE);
if (!fs.existsSync(file)) {
  console.error(`migrate.mjs: no board at ${BOARD_FILE}.`);
  process.exit(1);
}
const before = fs.readFileSync(file, 'utf8');
let board;
try {
  board = JSON.parse(before);
} catch (e) {
  console.error(`migrate.mjs: ${BOARD_FILE} is not valid JSON: ${e.message}. Fix it, then run this again.`);
  process.exit(1);
}

const log = [];
const count = {};
const bump = (k) => (count[k] = (count[k] ?? 0) + 1);
const read = (relPath) => (fs.existsSync(path.join(root, relPath)) ? fs.readFileSync(path.join(root, relPath), 'utf8') : null);
const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
const { models } = loadTierModels(root);
const tierOf = (model, want) => (modelFitsTier(model, want, models) ? want : (TIERS.find((k) => modelFitsTier(model, k, models)) ?? null));
const LEGACY = { haiku: 'small', sonnet: 'medium', opus: 'large' };

// "claude-medium (claude-sonnet-5-5) · REVIEW", "coordinator / claude-opus-5-5 · DONE", or "codex-medium": { name, model }.
function whoOf(rest) {
  const s = String(rest ?? '').replace(/\s*[·•|–—]\s*[A-Z_]+\s*$/, '').replace(/^from\s+\S+\s*[·•|–—]\s*/i, '').trim();
  const m = s.match(/^(.*?)\s*\(([^()\s]+)\)\s*$/) ?? s.match(/^(.*?)\s+\/\s+(\S+)\s*$/);
  return m ? { name: m[1].trim(), model: m[2] } : { name: s || null, model: null };
}

// ---------- schema ----------
for (const k of ['wip_limit_per_worker', 'max_parallel_workers']) {
  if (k in board) {
    delete board[k];
    log.push(`removed   "${k}" (replaced by "wip_limit": 1)`);
  }
}
const tpl = schema();
const next = {};
for (const [k, v] of Object.entries(tpl)) {
  const owned = k === '$schema' || k === '_ticket_template';
  if (!owned && !(k in board)) log.push(`added     "${k}": ${JSON.stringify(v)}`);
  next[k] = owned || !(k in board) ? v : board[k];
}
for (const [k, v] of Object.entries(board)) if (!(k in next)) next[k] = v;
board = next;

// ---------- tickets ----------
const live = liveTickets(board).filter((x) => !x.rec.archived);
const unbackfilled = [];
for (const { rec: t, type } of live) {
  const typed = { ...t, type };
  if (LEGACY[t.model]) {
    t.model = LEGACY[t.model];
    bump('model names mapped to tiers');
  }
  if (!t.tier_override && tierProblem({ ...t, type })) {
    log.push(`retier    ${t.id}: ${t.model} -> ${policyTier(typed)}`);
    t.model = policyTier(typed);
  }
  if (t.status === 'IN_PROGRESS' && !t.claimed_at && t.assignee) {
    t.claimed_at = nowIso();
    bump('claimed_at set on an in-progress ticket');
  }
  const note = read(`${HANDOVER_DIR}/${t.id}.md`);
  const entries = parseNote(note ?? '').entries.filter((e) => e.date && !e.mark).map((e) => ({ ...e, at: toIso(e.date) })).filter((e) => e.at);
  const byTime = [...entries].sort((a, b) => a.at.localeCompare(b.at));

  // 0.8 stamps. Dates come from the first and last dated entry, else from the git history of the note.
  let dates = byTime.map((e) => e.at);
  if (!dates.length && !('created_at' in t && 'updated_at' in t) && note !== null) {
    dates = git('log', '--format=%cI', '--', `${HANDOVER_DIR}/${t.id}.md`).stdout.split('\n').map(toIso).filter(Boolean).sort();
  }
  if (!('created_at' in t)) (t.created_at = dates[0] ?? null), bump('created_at');
  if (!('updated_at' in t)) (t.updated_at = dates.at(-1) ?? null), bump('updated_at');
  if (!('last_actor' in t)) {
    const named = byTime.map((e) => ({ e, who: whoOf(e.rest) })).filter((x) => x.who.model).at(-1);
    const role = named?.e.type === 'PROGRESS' ? 'worker' : 'coordinator';
    t.last_actor = named ? { name: named.who.name, role, model: named.who.model, tier: tierOf(named.who.model, role === 'worker' ? requiredTier(typed) : 'large') } : null;
    bump('last_actor');
  }
  if (!('claims' in t)) {
    const open = t.status === 'IN_PROGRESS' && t.assignee;
    t.claims = open ? [{ worker: t.assignee, model: t.worker_model ?? null, tier: t.worker_model ? tierOf(t.worker_model, requiredTier(typed)) : null, claimed_at: toIso(t.claimed_at) ?? nowIso(), released_at: null, outcome: null }] : [];
  }

  // 0.9 velocity fields. A value the ticket has is kept.
  const progress = byTime.filter((e) => e.type === 'PROGRESS');
  if (t.started_at == null) {
    const claimed = (Array.isArray(t.claims) ? t.claims : []).map((c) => c?.claimed_at).filter(Boolean).sort()[0];
    if (claimed) t.started_at = claimed;
    else if (progress.length) {
      t.started_at = progress[0].at;
      t.stamps_backfilled = true;
    }
    if (t.started_at) bump('started_at');
  }
  const delivered = progress.filter((e) => e.status === 'REVIEW').at(-1);
  if (t.done_by == null && ['REVIEW', 'DONE'].includes(t.status) && delivered) {
    const who = whoOf(delivered.rest);
    if (who.name) (t.done_by = who.name), bump('done_by');
    if (who.model) t.done_by_model = who.model;
  }
  if (t.status === 'DONE' && t.done_at == null) {
    const closed = byTime.filter((e) => e.type === 'REVIEW' && e.status === 'DONE').at(-1) ?? delivered ?? byTime.at(-1);
    t.done_at = closed?.at ?? t.updated_at ?? null;
    if (t.done_at) {
      bump('done_at');
      // A close taken from anything but a REVIEW DONE entry is an estimate.
      if (closed?.type !== 'REVIEW' || closed?.status !== 'DONE') (t.stamps_backfilled = true), unbackfilled.push(`${t.id}: no "REVIEW · … · DONE" entry; done_at taken from ${closed ? `its last ${closed.type} entry` : 'updated_at'}`);
    } else unbackfilled.push(`${t.id}: DONE, but its note has no dated entry; done_at stays empty`);
    if (t.done_by == null && closed && !delivered) {
      // Closed by the coordinator without a worker hand-over (a story, a human chore).
      const who = whoOf(closed.rest);
      if (who.name) (t.done_by = who.name), (t.done_by_model = who.model ?? undefined);
    }
  }
  if (t.rework_count == null) {
    const n = byTime.filter((e) => e.type === 'REVIEW' && e.status === 'REWORK').length;
    if (n) (t.rework_count = n), bump('rework_count');
  }
  if (orderFrom && t.order == null && typeof t[orderFrom] === 'number') (t.order = t[orderFrom]), bump(`order copied from "${orderFrom}"`);
}

// ---------- containers ----------
// A ticket that a container lists as a child, but that names no parent, gets that parent.
const byId = new Map(live.map((x) => [x.rec.id, x.rec]));
for (const { rec: c } of live) {
  for (const kid of c.children ?? []) {
    const k = byId.get(kid);
    if (!k) continue;
    if (k.parent == null) (k.parent = c.id), log.push(`parent    ${kid}: set to ${c.id}, which lists it as a child`);
    else if (k.parent !== c.id) log.push(`note      ${c.id} lists ${kid} as a child, but its parent is ${k.parent}; left as it is`);
  }
}
for (const { rec: c } of live) {
  const kids = live.filter((x) => x.rec.parent === c.id).map((x) => x.rec.id);
  const merged = [...new Set([...(c.children ?? []), ...kids])];
  if (merged.length !== (c.children ?? []).length) c.children = merged;
}
for (const ch of deriveContainers(board)) {
  log.push(`derived   ${ch.id}: ${ch.field} ${JSON.stringify(ch.from)} -> ${JSON.stringify(ch.to)}`);
  // The hand-set estimate of a container is kept for the record; "points" is now the sum of its children.
  if (ch.field === 'points' && typeof ch.from === 'number' && byId.get(ch.id).estimate == null) byId.get(ch.id).estimate = ch.from;
}

// ---------- knowledge index ----------
const knowledgeDir = String(board.knowledge?.dir ?? 'docs/findings').replace(/\\/g, '/').replace(/\/$/, '');
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.md$/i.test(e.name) ? [path.join(dir, e.name)] : [])) : []);
const findings = walk(path.join(root, knowledgeDir)).map((f) => path.relative(root, f).replace(/\\/g, '/')).sort();
const index = read(KNOWLEDGE_FILE);
let indexNext = index ?? `# Project Knowledge\n\nOne line per finding in \`${knowledgeDir}/\`. Required reading before grooming and before work (protocol 6.7).\nAdd a line with \`node scripts/kanban/ticket.mjs finding <file> --summary "<one line>" --agent <name>\`.\n\n`;
for (const f of findings) {
  const link = path.posix.relative(path.posix.dirname(KNOWLEDGE_FILE), f);
  if (indexNext.includes(`](${link})`)) continue;
  const title = (read(f) ?? '').match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.posix.basename(f, '.md');
  indexNext = `${indexNext.replace(/\s*$/, '')}\n- [${path.posix.basename(f)}](${link}): ${title.replace(/\s+/g, ' ')}\n`;
  bump(`${KNOWLEDGE_FILE} lines added`);
}

// ---------- write ----------
const eol = /\r\n/.test(before) ? '\r\n' : '\n';
const after = (JSON.stringify(board, null, 2) + '\n').replace(/\n/g, eol);
const boardChanged = JSON.stringify(JSON.parse(before)) !== JSON.stringify(board);
const indexChanged = indexNext !== index;
for (const [k, n] of Object.entries(count)) log.push(`backfill  ${k}: ${n}`);
console.log(`${dryRun ? '[dry run] ' : ''}migrate ${BOARD_FILE}: ${liveTickets(board).length} tickets`);
console.log(boardChanged || indexChanged ? log.map((l) => `  ${l}`).join('\n') || '  schema refreshed' : '  nothing to change');
if (unbackfilled.length) console.log(`Could not backfill exactly (${unbackfilled.length}):\n${unbackfilled.map((l) => `  ${l}`).join('\n')}`);
const open = live.filter((x) => !CLOSED.includes(x.rec.status)).length;
console.log(`Open tickets: ${open}. Design anchor: ${board.design_sources.length ? 'on' : 'off (declare a source with ticket.mjs design <path> to turn it on)'}.`);
if (dryRun) process.exit(0);
if (boardChanged) {
  fs.writeFileSync(file, after);
  recordScriptWrites(root, { [BOARD_FILE]: after });
}
if (indexChanged) fs.writeFileSync(path.join(root, KNOWLEDGE_FILE), indexNext);
const r = spawnSync(process.execPath, [path.join(here, 'render-board.mjs')], { encoding: 'utf8' });
process.stderr.write(r.stderr);
process.stdout.write(r.stdout);
process.exit(r.status ?? 1);
