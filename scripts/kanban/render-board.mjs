#!/usr/bin/env node
// Validates docs/kanban/board.json and regenerates docs/kanban/BOARD.md from it.
//
//   node scripts/kanban/render-board.mjs          validate, then write BOARD.md
//   node scripts/kanban/render-board.mjs --check  validate only, and fail if BOARD.md is out of date
//
// board.json is the only source of truth. BOARD.md is generated; never edit it by hand.
// After the result line it prints the session brief: what waits on the user, ADRs that are not accepted,
// containers ready to close, and design files that changed (protocol 5.3).
//
// --from-ticket is passed by ticket.mjs only: a changed design file is then a warning, so a worker can still
// hand over. Without it (session start, pre-commit, CI) a changed design file is an error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARCHIVE_FILE, CLOSED, DESIGN_FILE, FIB, GROUPS, ISO_UTC, KNOWLEDGE_FILE, ROLES, SIZE_LIMIT_KB, STATUSES, derivedState, entryRe, groomingProblems,
  loadArchive, parseNote, readNote, stateProblems, tickets, velocity,
} from './board-lib.mjs';
import { ADR_STATES, DESIGN_STATES, adrConfig, adrInfo, adrsOf, anchorOn, isBuilt, loadLedger, sourceDrift, ticketsByElement } from './design-lib.mjs';
import { TIERS as MODELS, TIERS_FILE, coordinatorMayRun, loadTierModels, modelFitsTier, requiredTier, tierProblem } from './tier-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const boardPath = path.join(root, 'docs', 'kanban', 'board.json');
const mdPath = path.join(root, 'docs', 'kanban', 'BOARD.md');
const handoverDir = path.join(root, 'docs', 'kanban', 'handovers');
const checkOnly = process.argv.includes('--check');
const fromTicket = process.argv.includes('--from-ticket');
// codegraph_queries are required only when the repository has a CodeGraph index.
const hasIndex = fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'));

const LEGACY_MODELS = { haiku: 'small', sonnet: 'medium', opus: 'large' };
const DONE_ROWS = 30;

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const errors = [];
const warnings = [];
// Which models count as each tier. User-owned; see docs/kanban/providers.md.
const tierModels = loadTierModels(root);
if (tierModels.problem) errors.push(`${TIERS_FILE}: ${tierModels.problem}`);

const all = tickets(board);
const byId = new Map();
for (const t of all) {
  if (byId.has(t.id)) errors.push(`${t.id}: ID appears more than once`);
  byId.set(t.id, t);
}

// Archive (protocol 6.6): an archived ticket is a stub on the board and a full record in the archive file.
let archive = null;
try {
  archive = loadArchive(root);
} catch (e) {
  errors.push(`${ARCHIVE_FILE}: not valid JSON: ${e.message}`);
}
const archived = new Map(Object.keys(GROUPS).flatMap((g) => (archive?.[g] ?? []).map((t) => [t.id, t])));
const isStub = (t) => t.archived === true;
for (const t of all) {
  if (isStub(t) && !archived.has(t.id)) errors.push(`${t.id}: is an archive stub, but ${ARCHIVE_FILE} has no record of it`);
  if (!isStub(t) && archived.has(t.id)) errors.push(`${t.id}: ID is used by an archived ticket; IDs are never reused (protocol 9.1)`);
  if (isStub(t) && !CLOSED.includes(t.status)) errors.push(`${t.id}: an archive stub must be DONE or ABANDONED`);
}
for (const id of archived.keys()) if (!byId.has(id)) errors.push(`${ARCHIVE_FILE}: ${id} has no stub on the board`);

const parents = new Set(all.map((t) => t.parent).filter(Boolean));
// A container is an epic or story with children: its points and status are derived (protocol 4.1).
const container = (t) => (t.type === 'epic' || t.type === 'story') && parents.has(t.id);
// What a worker executes as one unit: a task, bug, chore, or a story without children.
const workable = (t) => t.type !== 'epic' && !container(t);
const open = (t) => !CLOSED.includes(t.status);
const needsGrooming = (t) => t.type !== 'epic' && ['TODO', 'IN_PROGRESS', 'PAUSED', 'BLOCKED', 'REVIEW'].includes(t.status);
const noteText = (id) => {
  const f = path.join(handoverDir, `${id}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};
// Handover entry headers: "## <TYPE> · <ISO date> · <agent> · <STATUS>" (see _TEMPLATE.md and board-lib.mjs).
const hasEntry = (id, type, status) => entryRe(type, status).test(noteText(id) ?? '');
const STALE_CLAIM_HOURS = 24;
const iso = (v) => typeof v === 'string' && ISO_UTC.test(v);

// Design anchor (protocol 10). Off until board.json "design_sources" lists a file.
const designOn = anchorOn(board);
const ledger = loadLedger(root);
const elementsById = new Map(ledger.elements.filter((e) => e && typeof e.id === 'string').map((e) => [e.id, e]));
const design = { on: designOn, ids: new Set(elementsById.keys()) };
const adr = adrConfig(board);
if (adr.problem) errors.push(`board.json: ${adr.problem}`);
const adrCache = new Map();
const adrOf = (id) => adrCache.get(id) ?? adrCache.set(id, adrInfo(root, adr, id)).get(id);
// ADR ID -> open tickets that depend on it while it is not accepted. They cannot be claimed (protocol 10.4).
const waitingAdrs = new Map();

for (const t of all) {
  const at = `${t.id}`;
  if (!STATUSES.includes(t.status)) errors.push(`${at}: unknown status "${t.status}"`);
  if (t.parent && !byId.has(t.parent)) errors.push(`${at}: parent ${t.parent} does not exist`);
  for (const k of ['created_at', 'updated_at', 'started_at', 'done_at']) if (t[k] != null && !iso(t[k])) errors.push(`${at}: ${k} "${t[k]}" is not ISO 8601 UTC (for example 2026-10-23T15:52:42Z)`);
  if (t.rework_count != null && !(Number.isInteger(t.rework_count) && t.rework_count >= 0)) errors.push(`${at}: rework_count must be a whole number`);
  if (isStub(t)) continue;

  if (container(t)) {
    // Derived, never hand-set. Every ticket.mjs command sets both; migrate.mjs fixes an older board.
    const d = derivedState(t, all.filter((x) => x.parent === t.id));
    if (t.points !== d.points) errors.push(`${at}: points are ${t.points ?? 'not set'}, but its children add up to ${d.points}. A container's points are derived (protocol 4.1); run: node scripts/kanban/migrate.mjs`);
    if (t.status !== d.status) errors.push(`${at}: status is ${t.status}, but its children make it ${d.status}. A container's status is derived (protocol 4.1); run: node scripts/kanban/migrate.mjs`);
  } else if (t.type !== 'epic' && t.status !== 'BACKLOG' && !FIB.includes(t.points)) errors.push(`${at}: points must be one of ${FIB.join(', ')} before leaving BACKLOG`);
  // The size limit is for work a worker executes as one unit. A story split into tasks is the sum of
  // those tasks, so only the tasks are limited; a story with no tasks is executed whole and is limited.
  if (workable(t) && t.points >= 13 && t.status !== 'BACKLOG') {
    errors.push(`${at}: ${t.points} pts is too large; split it${t.type === 'story' ? ' into tasks' : ''} before TODO`);
  }
  if (t.type === 'task' && !t.parent) errors.push(`${at}: task has no parent story`);
  for (const r of [...(t.requires ?? []), ...(t.blocks ?? []), ...(t.children ?? [])]) {
    if (!byId.has(r)) errors.push(`${at}: references unknown ticket ${r}`);
  }
  if (t.order != null && !(typeof t.order === 'number' && Number.isFinite(t.order))) errors.push(`${at}: order must be a number or null`);
  if (t.model && LEGACY_MODELS[t.model]) errors.push(`${at}: model "${t.model}" is a provider model name; use the tier "${LEGACY_MODELS[t.model]}" (or run the installer's upgrade)`);
  else if (t.model && !MODELS.includes(t.model)) errors.push(`${at}: model must be one of ${MODELS.join(', ')}`);
  else if (tierProblem(t)) errors.push(`${at}: ${tierProblem(t)}`);

  if (needsGrooming(t)) for (const p of groomingProblems(t, { noteText, hasIndex, container: container(t), design })) errors.push(`${at}: ${p}`);
  for (const h of t.handovers ?? []) {
    if (readNote(root, h) === null) errors.push(`${at}: handovers lists ${h}, but handovers/${h}.md does not exist`);
  }
  // Design link and ADRs (protocol 10.3, 10.4).
  if (t.design != null && (typeof t.design !== 'object' || Array.isArray(t.design))) errors.push(`${at}: design must be { "refs": [...] } or { "na": "<reason>" }`);
  if (t.adrs != null && !(Array.isArray(t.adrs) && t.adrs.every((x) => typeof x === 'string' && x.trim()))) errors.push(`${at}: adrs must be a list of ADR IDs`);
  if (open(t)) {
    if (designOn && t.design?.pending) warnings.push(`${at}: has no design link yet; it cannot be claimed or closed until: ticket.mjs groom ${t.id} --design-ref <D-ID> | --design-na "<reason>"`);
    if (t.design?.stale) warnings.push(`${at}: design source ${t.design.stale.source ?? '?'} changed; regroom it, then run: ticket.mjs groom ${t.id} --design-reviewed "<what changed for this ticket>"`);
    for (const id of adr.problem ? [] : adrsOf(t, elementsById)) {
      const a = adrOf(id);
      if (!a.file) errors.push(`${at}: depends on ADR ${id}, but no file in ${adr.dir}/ matches it`);
      else if (!a.accepted) waitingAdrs.set(id, [...(waitingAdrs.get(id) ?? []), t.id]);
    }
  }
  // A container note has a STATE block: current scope, order, decisions, open user items (protocol 6.2.1).
  if (container(t)) {
    const state = parseNote(noteText(t.id) ?? '').state;
    if (state) for (const p of stateProblems(state.body)) errors.push(`${at}: ${p} (handovers/${t.id}.md; rewrite it with ticket.mjs state)`);
    else if (open(t)) warnings.push(`${at}: its note has no STATE block; no ticket under it can be claimed until the coordinator writes one with ticket.mjs state (protocol 6.2.1)`);
  }
  // Escalation (protocol 5): a BLOCKED ticket says why and what would unblock it.
  if (t.status === 'BLOCKED') {
    if (!t.blocked_reason) errors.push(`${at}: BLOCKED without a blocked_reason`);
    if (!hasEntry(t.id, 'PROGRESS', 'BLOCKED')) errors.push(`${at}: BLOCKED but handovers/${t.id}.md has no "## PROGRESS · … · BLOCKED" entry`);
  } else if (t.blocked_reason) warnings.push(`${at}: is ${t.status} but still has a blocked_reason; clear it`);
  // Ready for Review (protocol 3.2) and Definition of Done (protocol 3.3).
  if (t.status === 'REVIEW' && workable(t) && !hasEntry(t.id, 'PROGRESS', 'REVIEW')) errors.push(`${at}: REVIEW but handovers/${t.id}.md has no "## PROGRESS · … · REVIEW" entry`);
  if (t.status === 'DONE' && t.type !== 'epic' && !hasEntry(t.id, 'REVIEW', 'DONE')) warnings.push(`${at}: DONE without a "## REVIEW · … · DONE" entry from the coordinator`);
  if (t.status === 'DONE' && workable(t) && !t.done_at) warnings.push(`${at}: DONE without done_at; run: node scripts/kanban/migrate.mjs`);
  // Stamps and claims (protocol 6.1): ticket.mjs writes them from the machine clock, in ISO 8601 UTC.
  const a = t.last_actor;
  if (a != null && (typeof a !== 'object' || Array.isArray(a))) errors.push(`${at}: last_actor must be { name, role, model, tier }`);
  else if (a != null) {
    if (!ROLES.includes(a.role)) errors.push(`${at}: last_actor.role must be ${ROLES.join(' or ')}, not "${a.role}"`);
    if (a.tier != null && !MODELS.includes(a.tier)) errors.push(`${at}: last_actor.tier must be one of ${MODELS.join(', ')}, or null`);
  }
  if (t.claims != null && !Array.isArray(t.claims)) errors.push(`${at}: claims must be a list`);
  for (const [i, c] of (Array.isArray(t.claims) ? t.claims : []).entries()) {
    const where = `${at}: claims[${i}]`;
    if (!c || typeof c !== 'object') {
      errors.push(`${where} must be { worker, model, tier, claimed_at, released_at, outcome }`);
      continue;
    }
    if (!iso(c.claimed_at)) errors.push(`${where}.claimed_at is not ISO 8601 UTC`);
    if (c.released_at != null && !iso(c.released_at)) errors.push(`${where}.released_at is not ISO 8601 UTC`);
    if (c.tier != null && !MODELS.includes(c.tier)) errors.push(`${where}.tier must be one of ${MODELS.join(', ')}, or null`);
    if (c.outcome != null && !STATUSES.includes(c.outcome)) errors.push(`${where}.outcome must be a status`);
    const last = i === t.claims.length - 1;
    if (c.released_at == null && !(last && t.status === 'IN_PROGRESS')) errors.push(`${where} is still open, but only the last claim of an IN_PROGRESS ticket is open`);
    if (last && c.released_at != null && t.status === 'IN_PROGRESS' && workable(t)) errors.push(`${at}: IN_PROGRESS, but its last claim was released; claim it with ticket.mjs`);
  }
  if (t.status !== 'IN_PROGRESS' && t.claimed_at) warnings.push(`${at}: is ${t.status} but still has claimed_at; clear it`);
  if (workable(t) && (t.status === 'IN_PROGRESS' || t.status === 'REVIEW' || t.status === 'DONE')) {
    for (const r of t.requires ?? []) {
      if (byId.get(r) && byId.get(r).status !== 'DONE') errors.push(`${at}: is ${t.status} but prerequisite ${r} is ${byId.get(r).status}`);
    }
  }
}

// WIP: at most wip_limit tickets IN_PROGRESS on the whole board. Serial work in one checkout
// is what lets any AI provider run the workflow; see protocol.md section 5.1.
const wip = board.wip_limit ?? 1;
// Extra paths the coordinator may edit while a ticket is IN_PROGRESS (read by worker-delegation.mjs).
const cp = board.coordinator_paths;
if (cp !== undefined && !(Array.isArray(cp) && cp.every((g) => typeof g === 'string' && g.trim()))) {
  errors.push('board.json: "coordinator_paths" must be an array of non-empty path globs');
}
for (const k of ['wip_limit_per_worker', 'max_parallel_workers']) {
  if (k in board) warnings.push(`board.json: "${k}" is no longer used; replace it with "wip_limit": 1`);
}
const active = all.filter((t) => t.status === 'IN_PROGRESS' && workable(t));
// Lane order (protocol 4.2): the lowest "order" among the tickets that can start goes first.
const ready = (t) => workable(t) && ['TODO', 'PAUSED'].includes(t.status) && (t.requires ?? []).every((r) => byId.get(r)?.status === 'DONE');
for (const t of active) {
  if (!t.assignee) errors.push(`${t.id}: IN_PROGRESS without an assignee`);
  // Recovery (protocol 5.3): every claim is timestamped so an orphaned one can be spotted.
  const since = Date.parse(t.claimed_at ?? '');
  if (Number.isNaN(since)) errors.push(`${t.id}: IN_PROGRESS without a valid claimed_at (ISO 8601 UTC)`);
  else if (Date.now() - since > STALE_CLAIM_HOURS * 3600_000) warnings.push(`${t.id}: claimed by ${t.assignee ?? '(none)'} at ${t.claimed_at}, over ${STALE_CLAIM_HOURS}h ago; possible orphaned claim (protocol 5.3)`);
  // A warning, not an error: CI cannot see a user's per-ticket approval (KANBAN_INLINE, protocol 6.3.1).
  const coordinatorRuns = coordinatorMayRun(t) && modelFitsTier(t.worker_model, 'large', tierModels.models);
  if (t.worker_model && !coordinatorRuns && !modelFitsTier(t.worker_model, requiredTier(t), tierModels.models)) {
    warnings.push(`${t.id}: worker model "${t.worker_model}" is not listed for tier "${requiredTier(t)}" in ${TIERS_FILE}; its PROGRESS entry must record the user's approval`);
  }
  const before = all.filter((x) => ready(x) && typeof x.order === 'number' && (typeof t.order !== 'number' || x.order < t.order));
  if (before.length && !t.claims?.at(-1)?.out_of_order) warnings.push(`${t.id}: claimed out of order; ${before.map((x) => `${x.id} (order ${x.order})`).join(', ')} come first (protocol 4.2)`);
}
if (active.length > wip) errors.push(`WIP: ${active.length} tickets in progress (${active.map((t) => t.id).join(', ')}); wip_limit is ${wip}`);

// Open flags whose target is closed should have been removed (protocol 6.4).
const flagIndex = path.join(handoverDir, 'HANDOVERS.md');
if (fs.existsSync(flagIndex)) {
  for (const line of fs.readFileSync(flagIndex, 'utf8').split(/\r?\n/)) {
    const id = line.match(/^\|\s*`?([A-Z]+-\d+)/)?.[1];
    const st = id && byId.get(id)?.status;
    if (st === 'DONE' || st === 'ABANDONED') warnings.push(`HANDOVERS.md: open flag targets ${id}, which is ${st}; remove the line`);
  }
}
const blocked = all.filter((t) => t.status === 'BLOCKED' && workable(t));

// ---------- what waits on the user (protocol 5.4) ----------
const pending = board.decisions_pending ?? [];
if (!Array.isArray(pending)) errors.push('board.json: "decisions_pending" must be a list');
const seenDec = new Set();
for (const d of Array.isArray(pending) ? pending : []) {
  const at = `decisions_pending ${d?.id ?? '(no id)'}`;
  if (!d || typeof d !== 'object' || !/^DEC-\d+$/.test(d.id ?? '')) {
    errors.push(`${at}: needs an "id" such as DEC-001`);
    continue;
  }
  if (seenDec.has(d.id)) errors.push(`${at}: ID appears more than once`);
  seenDec.add(d.id);
  if (typeof d.question !== 'string' || !d.question.trim()) errors.push(`${at}: needs a "question"`);
  if (!Array.isArray(d.blocks) || !d.blocks.length) errors.push(`${at}: needs "blocks", the tickets that wait on it`);
  for (const b of Array.isArray(d.blocks) ? d.blocks : []) if (!byId.has(b)) errors.push(`${at}: blocks unknown ticket ${b}`);
  if (d.raised_at != null && !iso(d.raised_at)) errors.push(`${at}: raised_at is not ISO 8601 UTC`);
}
const decisions = Array.isArray(pending) ? pending.filter((d) => d && typeof d === 'object') : [];
const toClose = all.filter((t) => container(t) && t.status === 'REVIEW');

// ---------- design anchor (protocol 10) ----------
const sources = Array.isArray(board.design_sources) ? board.design_sources : [];
if (board.design_sources !== undefined && !Array.isArray(board.design_sources)) errors.push('board.json: "design_sources" must be a list of { path, sha256 }');
const sourcePaths = new Set();
for (const s of sources) {
  if (!s || typeof s.path !== 'string' || !/^[0-9a-f]{64}$/.test(s.sha256 ?? '')) errors.push(`design_sources: ${JSON.stringify(s?.path ?? s)} needs "path" and a recorded "sha256"; record it with: ticket.mjs design <path>`);
  else if (sourcePaths.has(s.path)) errors.push(`design_sources: ${s.path} is listed twice`);
  if (s?.path) sourcePaths.add(s.path);
}
const byElement = ticketsByElement(all);
const drift = sourceDrift(root, board);
const driftLines = [];
for (const d of drift) {
  if (d.missing) {
    errors.push(`design_sources: ${d.path} does not exist. A design source is a file in the repository (protocol 10.1)`);
    continue;
  }
  const hit = ledger.elements.filter((e) => e?.source === d.path).flatMap((e) => byElement.get(e.id) ?? []).filter(open);
  const ids = [...new Set(hit.map((t) => t.id))];
  const msg = `design source ${d.path} changed since its hash was recorded. Open tickets that reference it need regrooming: ${ids.join(', ') || 'none'}. Then run: node scripts/kanban/ticket.mjs design ${d.path} --agent <name> --model <model-id>`;
  driftLines.push(msg);
  (fromTicket ? warnings : errors).push(msg);
}
if (ledger.problem) errors.push(`${DESIGN_FILE}: ${ledger.problem}`);
if (!designOn && ledger.elements.length) warnings.push(`${DESIGN_FILE} has elements, but board.json "design_sources" is empty, so the design anchor is off`);
const coverage = Object.fromEntries(DESIGN_STATES.map((s) => [s, 0]));
if (designOn) {
  const seen = new Set();
  for (const e of ledger.elements) {
    const at = `${DESIGN_FILE} ${e?.id ?? '(no id)'}`;
    if (!e || typeof e.id !== 'string' || !e.id.trim()) {
      errors.push(`${at}: every element needs an "id"`);
      continue;
    }
    if (seen.has(e.id)) errors.push(`${at}: ID appears more than once`);
    seen.add(e.id);
    if (typeof e.title !== 'string' || !e.title.trim()) errors.push(`${at}: needs a "title"`);
    if (!sourcePaths.has(e.source)) errors.push(`${at}: source "${e.source ?? ''}" is not in board.json "design_sources"`);
    if (!DESIGN_STATES.includes(e.state)) {
      errors.push(`${at}: state must be one of ${DESIGN_STATES.join(', ')}`);
      continue;
    }
    coverage[e.state]++;
    const mine = (byElement.get(e.id) ?? []).filter((t) => t.status !== 'ABANDONED');
    const info = e.adr && !adr.problem ? adrOf(e.adr) : null;
    if (e.adr && info && !info.file) errors.push(`${at}: names ADR ${e.adr}, but no file in ${adr.dir}/ matches it`);
    if (ADR_STATES.includes(e.state)) {
      // Deviation gate (protocol 10.4): the design is left unbuilt or changed only with an accepted ADR.
      if (!e.adr) errors.push(`${at}: is ${e.state} without an ADR. Not building the design as drawn needs an ADR the user accepted`);
      else if (info?.file && !info.accepted) errors.push(`${at}: is ${e.state}, but ADR ${e.adr} is "${info.status ?? 'no status'}", not accepted. Keep the element planned until the user accepts the ADR`);
    } else if (!mine.length) {
      errors.push(`${at}: is ${e.state} with no ticket and no ADR. Create a ticket whose design.refs names it, or defer or deviate it with an accepted ADR`);
    } else if (e.state === 'built' && !isBuilt(mine)) {
      errors.push(`${at}: is built, but ${mine.filter(open).map((t) => `${t.id} (${t.status})`).join(', ') || 'none of its tickets'} ${mine.some(open) ? 'is not closed' : 'is DONE'}`);
    } else if (e.state === 'planned' && isBuilt(mine)) {
      warnings.push(`${at}: every ticket is closed; set it built with: ticket.mjs element ${e.id} --state built`);
    }
  }
}

// ---------- knowledge index (protocol 6.7) ----------
const knowledgeDir = String(board.knowledge?.dir ?? 'docs/findings').replace(/\\/g, '/').replace(/\/$/, '');
const walkMd = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkMd(path.join(dir, e.name)) : /\.md$/i.test(e.name) ? [path.join(dir, e.name)] : [])) : []);
const findings = walkMd(path.join(root, knowledgeDir)).map((f) => path.relative(root, f).replace(/\\/g, '/'));
const indexPath = path.join(root, KNOWLEDGE_FILE);
const indexText = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : null;
if (indexText === null && findings.length) errors.push(`${KNOWLEDGE_FILE} is missing, but ${knowledgeDir}/ has ${findings.length} finding(s). Index them with: ticket.mjs finding <file> --summary "<one line>" --agent <name>`);
if (indexText !== null) {
  const linked = new Set();
  for (const m of indexText.matchAll(/\]\(([^)\s]+\.md)\)/gi)) {
    if (/^[a-z]+:/i.test(m[1])) continue;
    const rel = path.relative(root, path.resolve(path.dirname(indexPath), m[1])).replace(/\\/g, '/');
    linked.add(rel);
    if (!fs.existsSync(path.join(root, rel))) errors.push(`${KNOWLEDGE_FILE}: links ${m[1]}, which does not exist`);
  }
  for (const f of findings) if (!linked.has(f)) errors.push(`${KNOWLEDGE_FILE}: ${f} has no line. Index it with: ticket.mjs finding ${f} --summary "<one line>" --agent <name>`);
}

// ---------- size (protocol 6.6) ----------
const limitKb = Number(board.size_limit_kb ?? SIZE_LIMIT_KB);
const sizeKb = Math.round(fs.statSync(boardPath).size / 1024);
if (limitKb > 0 && sizeKb > limitKb) {
  const stories = all.filter((s) => s.type === 'story' && s.status === 'DONE' && all.some((x) => x.parent === s.id && !isStub(x) && CLOSED.includes(x.status)));
  warnings.push(`board.json is ${sizeKb} KB (limit ${limitKb} KB). ${stories.length ? `Archive closed stories with ticket.mjs archive <STORY>: ${stories.slice(0, 12).map((s) => s.id).join(', ')}${stories.length > 12 ? `, and ${stories.length - 12} more` : ''}` : 'Nothing can be archived yet'} (protocol 6.6)`);
}

// ---------- render ----------
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ');
const link = (id) => (fs.existsSync(path.join(handoverDir, `${id}.md`)) ? `[${id}.md](./handovers/${id}.md)` : fs.existsSync(path.join(handoverDir, 'archive', `${id}.md`)) ? `[${id}.md](./handovers/archive/${id}.md)` : '—');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const table = (rows, cols) => {
  if (!rows.length) return '*None.*\n';
  const head = `| ${cols.map((c) => c[0]).join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n`;
  return head + rows.map((t) => `| ${cols.map((c) => esc(c[1](t))).join(' | ')} |`).join('\n') + '\n';
};
const sumPts = (list) => list.reduce((n, t) => n + (Number(t.points) || 0), 0);
// Leaf tickets under a container, through child containers.
const leavesUnder = (t) => all.filter((x) => x.parent === t.id).flatMap((x) => (container(x) ? leavesUnder(x) : [x]));
const progressOf = (t) => {
  const leaves = leavesUnder(t).filter((x) => x.status !== 'ABANDONED');
  return `${sumPts(leaves.filter((x) => x.status === 'DONE'))}/${sumPts(leaves)} pts, ${leaves.filter((x) => x.status === 'DONE').length}/${leaves.length} tickets`;
};
const cols = {
  id: ['ID', (t) => `\`${t.id}\``],
  type: ['Type', (t) => cap(t.type)],
  title: ['Title', (t) => t.title],
  pts: ['Pts', (t) => t.points ?? '?'],
  parent: ['Parent', (t) => t.parent ?? '—'],
  requires: ['Requires', (t) => (t.requires ?? []).join(', ') || '—'],
  model: ['Model', (t) => (t.model ?? '—') + (t.worker_model ? ` (${t.worker_model})` : '')],
  assignee: ['Worker', (t) => t.assignee ?? '—'],
  since: ['Claimed', (t) => t.claimed_at ?? '—'],
  reason: ['Reason', (t) => t.blocked_reason ?? '—'],
  note: ['Handover', (t) => link(t.id)],
  order: ['Order', (t) => t.order ?? '—'],
  status: ['Status', (t) => t.status],
  progress: ['Done', (t) => progressOf(t)],
  by: ['Delivered by', (t) => (t.done_by ? `${t.done_by}${t.done_by_model ? ` (${t.done_by_model})` : ''}` : '—')],
  // UTC, as stored: BOARD.md must not depend on the machine's time zone, so --check passes everywhere.
  updated: ['Updated (UTC)', (t) => (t.updated_at ? t.updated_at.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, '') : '—')],
  actor: ['Last actor', (t) => (t.last_actor ? `${t.last_actor.name ?? '?'} (${[t.last_actor.role, t.last_actor.tier, t.last_actor.model].filter(Boolean).join(', ')})` : '—')],
  ready: ['Ready', (t) => ((t.requires ?? []).every((r) => byId.get(r)?.status === 'DONE') ? (waitsOnUser(t) ? 'waits on the user' : 'yes') : 'blocked')],
};
const waitsOnUser = (t) => decisions.some((d) => (d.blocks ?? []).includes(t.id)) || [...waitingAdrs.values()].some((ids) => ids.includes(t.id)) || !!t.design?.stale;
const inStatus = (s, pred = workable) => all.filter((t) => t.status === s && pred(t));
// Newest change first; tickets without a stamp last.
const newest = (rows) => [...rows].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
// Lowest order first; tickets without an order keep the board order, after the ordered ones.
const laned = (rows) => [...rows].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
const stamped = (list) => [...list, cols.updated, cols.actor];
const done = newest(inStatus('DONE'));

const waiting = [
  ...decisions.map((d) => `| \`${esc(d.id)}\` | ${esc(d.question)} | ${esc((d.blocks ?? []).join(', '))} | ${esc(d.raised_at?.slice(0, 10) ?? '—')} |`),
  ...[...waitingAdrs].map(([id, ids]) => `| ADR ${esc(id)} | Accept or reject ${esc(adrOf(id).file)} (status: ${esc(adrOf(id).status ?? 'none')}) | ${esc([...new Set(ids)].join(', '))} | — |`),
  ...toClose.map((t) => `| \`${t.id}\` | Every child is closed. Confirm closing it (commit, push, PR: protocol 8.2) | ${t.id} | — |`),
];
const v = velocity(all);
const vRow = (name, g) => `| ${name} | ${g.tickets} | ${g.points} | ${g.points_per_day ?? '—'} | ${g.cycle_hours_median ?? '—'} | ${g.rework_rate === null ? '—' : `${g.rework_rate}% (${g.reworks})`} |`;
const designMd = !designOn
  ? '*Off. Declare design sources with `ticket.mjs design <path>` to turn it on (protocol 10).*\n'
  : `${ledger.elements.length} elements from ${sources.length} source${sources.length === 1 ? '' : 's'}: ${DESIGN_STATES.map((s) => `${coverage[s]} ${s}`).join(', ')}.${drift.length ? ` **${drift.length} source${drift.length === 1 ? '' : 's'} changed or missing.**` : ''}\n\n` +
    table(ledger.elements.filter((e) => e && e.state !== 'built'), [
      ['Element', (e) => `\`${e.id}\``], ['Title', (e) => e.title], ['State', (e) => e.state], ['Source', (e) => e.source],
      ['Tickets', (e) => (byElement.get(e.id) ?? []).map((t) => t.id).join(', ') || '—'], ['ADR', (e) => e.adr ?? '—'],
    ]).replace('*None.*', '*Every element is built.*');

let md = `# Live Scrum Kanban Board

<!-- GENERATED from board.json by scripts/kanban/render-board.mjs. Do not edit by hand. -->

> **WIP rule**: at most ${wip} ticket in \`IN_PROGRESS\` on the whole board. Any agent (Claude, Gemini, Codex, or another) may hold it.
> Every change goes through \`node scripts/kanban/ticket.mjs\`. Times are UTC; the web board (\`npm run board:web\`) shows local time.

## 🧑 Waiting on the user
${waiting.length ? `| Item | What is needed | Blocks | Raised |\n|---|---|---|---|\n${waiting.join('\n')}\n` : '*Nothing.*\n'}
## ⚡ In Progress
${table(newest(active), stamped([cols.id, cols.type, cols.title, cols.pts, cols.parent, cols.assignee, cols.since, cols.model, cols.note]))}
## 🚧 Blocked
${table(blocked, stamped([cols.id, cols.type, cols.title, cols.pts, cols.parent, cols.reason, cols.note]))}
## ⏸️ Paused
${table(inStatus('PAUSED'), stamped([cols.id, cols.type, cols.title, cols.pts, cols.parent, cols.note]))}
## 🎯 To Do
${table(laned(inStatus('TODO')), stamped([cols.id, cols.type, cols.title, cols.pts, cols.parent, cols.order, cols.requires, cols.ready, cols.model]))}
## 🔍 Review
${table(newest(inStatus('REVIEW')), stamped([cols.id, cols.type, cols.title, cols.pts, cols.parent, cols.by, cols.note]))}
## ✅ Done${done.length > DONE_ROWS ? ` (newest ${DONE_ROWS} of ${done.length})` : ''}
${table(done.slice(0, DONE_ROWS), stamped([cols.id, cols.type, cols.title, cols.pts, cols.parent, cols.by, cols.note]))}
## ❌ Abandoned
${table(inStatus('ABANDONED'), stamped([cols.id, cols.type, cols.title, cols.pts, cols.note]))}
## 📋 Backlog
${table(laned(inStatus('BACKLOG')), stamped([cols.id, cols.type, cols.title, cols.pts, cols.parent, cols.order]))}
## 📚 Stories
${table(all.filter((t) => t.type === 'story' && container(t)), [cols.id, cols.title, cols.status, cols.pts, cols.progress, cols.parent, cols.note])}
## 🗺️ Epics
${table(all.filter((t) => t.type === 'epic'), [cols.id, cols.title, cols.status, cols.pts, ['Done', (t) => (container(t) ? progressOf(t) : '—')], cols.note])}
## 🧭 Design coverage
${designMd}
## 📈 Velocity
${v.all.tickets ? `| Tier | Tickets done | Points | Points per day | Median cycle (h) | Rework rate (reworks) |\n|---|---|---|---|---|---|\n${vRow('all', v.all)}\n${MODELS.map((k) => vRow(k, v.by_tier[k])).join('\n')}\n\nOver ${v.all.days} day${v.all.days === 1 ? '' : 's'} from the first start to the last close. Cycle time counts ${v.all.cycle_measured} ticket${v.all.cycle_measured === 1 ? '' : 's'} with a recorded claim. Details: \`node scripts/kanban/ticket.mjs stats\`.\n` : '*No ticket is done yet.*\n'}`;

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
if (errors.length) {
  console.error(`\n${errors.length} error(s). BOARD.md not written.`);
  process.exit(1);
}

const current = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
const summary = `${all.length} tickets, ${active.length} in progress${active.map((t) => ` (${t.id} by ${t.assignee ?? '(none)'} since ${t.claimed_at ?? '?'})`).join('')}, ${blocked.length} blocked`;
// Session brief (protocol 5.3): the same for every provider, because every session starts with --check.
const brief = [
  ...(decisions.length ? [`Waiting on the user (${decisions.length}):`, ...decisions.map((d) => `  ${d.id}: ${d.question} (blocks ${(d.blocks ?? []).join(', ')})`)] : []),
  ...(waitingAdrs.size ? ['ADRs not accepted; the tickets that depend on them cannot be claimed (only the user accepts an ADR):', ...[...waitingAdrs].map(([id, ids]) => `  ${adrOf(id).file} (${adrOf(id).status ?? 'no status'}): ${[...new Set(ids)].join(', ')}`)] : []),
  ...(toClose.length ? [`Ready to close, after asking the user (protocol 8.2): ${toClose.map((t) => t.id).join(', ')}`] : []),
  ...(fromTicket ? [] : driftLines),
];
if (checkOnly) {
  if (current.replace(/\r\n/g, '\n') !== md) {
    console.error('BOARD.md is out of date. Run: node scripts/kanban/render-board.mjs');
    process.exit(1);
  }
  console.log(`board OK: ${summary}`);
} else {
  fs.writeFileSync(mdPath, md);
  console.log(`BOARD.md written: ${summary}`);
}
if (brief.length) console.log(brief.join('\n'));
