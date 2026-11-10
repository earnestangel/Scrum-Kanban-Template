// Shared board helpers for render-board.mjs, ticket.mjs, the Claude Code hooks, and the installer.
// Plain Node, no dependencies, no provider assumptions.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const GROUPS = { epics: 'epic', stories: 'story', tasks: 'task', chores: 'chore', bugs: 'bug' };
export const BOARD_FILE = 'docs/kanban/board.json';
export const BOARD_MD = 'docs/kanban/BOARD.md';
export const HANDOVER_DIR = 'docs/kanban/handovers';
// Closed children of a closed story move here (ticket.mjs archive); a stub stays on the board.
export const ARCHIVE_FILE = 'docs/kanban/board-archive.json';
export const ARCHIVE_NOTE_DIR = 'docs/kanban/handovers/archive';
export const DESIGN_FILE = 'docs/kanban/design.json';
export const KNOWLEDGE_FILE = 'docs/kanban/KNOWLEDGE.md';
export const CLOSED = ['DONE', 'ABANDONED'];
// board.json larger than this gets a warning that names what can be archived. Override with "size_limit_kb".
export const SIZE_LIMIT_KB = 300;
export const FIB = [1, 2, 3, 5, 8, 13, 21];
export const STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'PAUSED', 'BLOCKED', 'REVIEW', 'DONE', 'ABANDONED'];
export const ROLES = ['worker', 'coordinator'];

export const loadBoard = (root) => JSON.parse(fs.readFileSync(path.join(root, BOARD_FILE), 'utf8'));

// Every ticket record with its type, taken from its board.json group unless the record sets one.
export const tickets = (board) => Object.entries(GROUPS).flatMap(([g, type]) => (board[g] ?? []).map((t) => ({ ...t, type: t.type ?? type })));

// The live record (not a copy) for an ID, so callers can change it in place.
export const findTicket = (board, id) => Object.keys(GROUPS).flatMap((g) => board[g] ?? []).find((t) => t.id === id);

// ISO 8601 UTC without milliseconds, for example 2026-09-30T14:05:00Z. Every stored time comes from the
// machine clock through this function; no agent passes a time.
export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
export const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
// Any parseable date as nowIso() would write it, or null.
export const toIso = (s) => {
  const d = Date.parse(s ?? '');
  return Number.isNaN(d) ? null : new Date(d).toISOString().replace(/\.\d+Z$/, 'Z');
};

// Who touched a ticket last, and when. ticket.mjs calls this on every write. actor: { name, role, model, tier }.
export function stamp(t, actor) {
  t.updated_at = nowIso();
  t.last_actor = { name: actor.name ?? null, role: actor.role, model: actor.model ?? null, tier: actor.tier ?? null };
}

// Handover entry headers: "## <TYPE> · <ISO date> · <agent> · <STATUS>" (see _TEMPLATE.md). Agents on
// other models often swap the middle dot for another separator, so these are accepted too.
export const HEADER_SEP = '[·•|\\-–—]';
// Without a status, only "## <TYPE> <sep> <date>" is required (GROOMING and FLAG headers end in the agent).
export const entryRe = (type, status) =>
  new RegExp(`^##\\s*${type}\\s*${HEADER_SEP}\\s*\\d{4}-${status ? `.*${HEADER_SEP}\\s*${status}\\b` : ''}`, 'mi');

// Canonical header, as ticket.mjs writes it.
export const formatHeader = (type, ...parts) => `## ${type} · ${nowIso()} · ${parts.filter(Boolean).join(' · ')}`;

// Definition of Groomed (protocol 3.1) for one ticket. noteText(id) returns the note text or null.
// Points are checked by render-board.mjs for every ticket that left BACKLOG.
// container: a story that has children. Its tasks carry the context, acceptance, verify_cmd, and GROOMING
// entries, and its own note is led by the STATE block that claim requires (protocol 6.2.1), so it needs only
// its design link. design: { on, ids } when the board declares design sources (protocol 10); then the ticket
// names the design elements it implements, or says why it has none.
export function groomingProblems(t, { noteText, hasIndex, container = false, design = null }) {
  const p = [];
  if (!container) {
    if (!t.model) p.push('no "model" set; grooming sets the tier the rule requires (protocol 1.2)');
    if (!t.context?.files?.length && !t.context?.symbols?.length) p.push('context.files or context.symbols is empty; grooming must record where the work is');
    if (hasIndex && !t.context?.codegraph_queries?.length) p.push('context.codegraph_queries is empty; grooming must record the queries that found the code');
    if (!t.acceptance?.length) p.push('acceptance criteria are empty');
    if (!t.verify_cmd) p.push('no verify_cmd; the worker cannot self-check');
  }
  if (design?.on) {
    const refs = Array.isArray(t.design?.refs) ? t.design.refs : [];
    const na = typeof t.design?.na === 'string' && t.design.na.trim();
    // "pending": groomed before the anchor was turned on. It cannot be claimed or closed until it has a link.
    if (!refs.length && !na && !t.design?.pending) p.push('no design link: set design.refs (design ledger IDs it implements) or design.na with the reason (protocol 10.3)');
    if (refs.length && na) p.push('design has both refs and na; keep one');
    for (const r of refs) if (!design.ids.has(r)) p.push(`design.refs names ${r}, which is not in the design ledger`);
  }
  if (container) return p;
  if (!(t.handovers ?? []).includes(t.id)) p.push(`handovers must include its own note "${t.id}"`);
  const note = noteText(t.id);
  if (note === null) p.push(`handovers/${t.id}.md is missing; grooming must write it`);
  else if (!entryRe('GROOMING').test(note)) p.push(`handovers/${t.id}.md has no dated "## GROOMING ·" entry`);
  return p;
}

// ---------- script writes (protocol 6.1) ----------
// ticket.mjs and the installer record a hash of every board file they write. The git pre-commit check
// rejects a staged board.json or note whose content no script wrote. The record is local to each checkout.
export const SCRIPT_WRITES_FILE = 'docs/kanban/.script-writes.json';
// Files only scripts may write: board.json and the notes. BOARD.md is checked by render-board.mjs --check.
export const isGuarded = (rel) => [BOARD_FILE, ARCHIVE_FILE, DESIGN_FILE].includes(rel) || (rel.startsWith(`${HANDOVER_DIR}/`) && rel.endsWith('.md') && !rel.endsWith('/_TEMPLATE.md'));
// What the record holds for a file a script removed (archive moves notes).
export const DELETED = 'deleted';
// Line endings are ignored, so git's autocrlf conversion does not count as an edit.
export const contentHash = (text) => crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');

export function loadScriptWrites(root) {
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(root, SCRIPT_WRITES_FILE), 'utf8'));
    return obj && typeof obj.files === 'object' ? obj.files : {};
  } catch {
    return {};
  }
}

// files: { "<repo-relative path>": "<content as written>", or null for a removed file }. Paths that are not guarded are ignored.
export function recordScriptWrites(root, files) {
  const record = loadScriptWrites(root);
  for (const [rel, text] of Object.entries(files)) if (isGuarded(rel)) record[rel] = text === null ? DELETED : contentHash(text);
  const sorted = Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(root, SCRIPT_WRITES_FILE), JSON.stringify({ note: 'Written by scripts/kanban/ticket.mjs. Local; do not commit or edit.', files: sorted }, null, 2) + '\n');
}

// ---------- note structure (protocol 6.2) ----------
// A note is: a preamble (title, comment), an optional "## STATE · <date> · <agent>" block, then entries.
// The STATE block is the one rewritable part (ticket.mjs state). Entries are append-only; an entry that
// no longer holds is marked "## <TYPE> (SUPERSEDED) · ..." by ticket.mjs note --supersedes, never removed.
// Returns { lines, state, entries }. Every "## " line starts a section; entries are numbered 1..n in file
// order (n), the STATE block is not numbered. start/end are line indexes; rawEnd includes the separator.
export function parseNote(text) {
  const lines = String(text ?? '').split(/(?<=\n)/);
  const heads = lines.flatMap((l, i) => (/^##\s/.test(l) ? [i] : []));
  const headRe = new RegExp(`^##\\s*([A-Za-z]+)\\s*(?:\\((DELETED|SUPERSEDED)\\))?\\s*(?:${HEADER_SEP}\\s*(\\d{4}-\\S+))?(.*)$`);
  const lead = new RegExp(`^\\s*${HEADER_SEP}\\s*`);
  const tailStatus = new RegExp(`(?:^|${HEADER_SEP})\\s*([A-Z_]+)\\s*$`);
  let state = null;
  const entries = [];
  heads.forEach((start, i) => {
    const rawEnd = heads[i + 1] ?? lines.length;
    let end = rawEnd;
    while (end > start + 1 && /^\s*(-{3,})?\s*$/.test(lines[end - 1])) end--;
    const header = lines[start].trim();
    const m = header.match(headRe) ?? [];
    const rest = (m[4] ?? '').replace(lead, '').trim();
    const sec = {
      type: (m[1] ?? '').toUpperCase(), mark: m[2] ?? null, date: m[3] ?? null, rest, header, start, end, rawEnd,
      status: rest.match(tailStatus)?.[1] ?? null,
      body: lines.slice(start + 1, end).join('').trim(),
    };
    if (sec.type === 'STATE' && !state) state = sec;
    else entries.push({ ...sec, n: entries.length + 1 });
  });
  return { lines, state, entries };
}

// The dated entries of a note: [{ type, date, rest }] in file order. rest is the header after the date.
// The STATE block and entries marked (DELETED) or (SUPERSEDED) are not included.
export function noteEntries(text) {
  return parseNote(text).entries.filter((e) => e.date && !e.mark).map((e) => ({ type: e.type, date: e.date, rest: e.rest }));
}

// The note text with its STATE block replaced by (or, when it has none, given) header + body.
export function withState(text, header, body) {
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const { lines, state } = parseNote(text);
  const kept = state ? [...lines.slice(0, state.start), ...lines.slice(state.rawEnd)] : lines;
  let first = kept.findIndex((l) => /^##\s/.test(l));
  if (first < 0) first = kept.length;
  let preEnd = first;
  while (preEnd > 0 && /^\s*(-{3,})?\s*$/.test(kept[preEnd - 1])) preEnd--;
  const pre = kept.slice(0, preEnd).join('').replace(/\s*$/, '');
  const tail = kept.slice(first).join('').replace(/\s*$/, '');
  const block = `${header}\n\n${body.trim()}\n`.replace(/\r?\n/g, nl);
  return `${pre}${nl}${nl}---${nl}${nl}${block}${tail ? `${nl}---${nl}${nl}${tail}${nl}` : ''}`;
}

// The sections every STATE block has, and the one a story needs before it is archived (protocol 6.2.1).
export const STATE_SECTIONS = ['Scope', 'Order', 'Decisions in force', 'Open for the user'];
export const DIGEST_MAX_LINES = 40;
const labelRe = (label) => new RegExp(`^\\s*(?:#{3,6}\\s*|\\*\\*)${label}\\b`, 'mi');
export const stateProblems = (body) => STATE_SECTIONS.filter((s) => !labelRe(s).test(body)).map((s) => `the STATE body needs a "**${s}**" section`);
// The lines under "**Digest**" up to the next section label, without blank lines; null when there is none.
export function digestLines(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const at = lines.findIndex((l) => labelRe('Digest').test(l));
  if (at < 0) return null;
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\s*(?:#{3,6}\s*|\*\*)[A-Z]/.test(l)) break;
    if (l.trim()) out.push(l);
  }
  return out;
}
// Whether a handover or review body has a labelled line or section, for example "**Design check**" or "Knowledge: none".
export const hasLabel = (body, label) => new RegExp(`^\\s*(?:[-*]\\s+)?(?:#{2,6}\\s*|\\*\\*|__)?${label}\\b`, 'mi').test(String(body ?? ''));
// The text after "<label>:" on its line (bold or not), or null.
export const labelValue = (body, label) => String(body ?? '').match(new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*|__)?${label}(?:\\*\\*|__)?\\s*:(?:\\*\\*|__)?\\s*(.*)$`, 'mi'))?.[1]?.trim() ?? null;

// ---------- containers (protocol 4.1) ----------
// An epic, and a story that has children, is a container. Its points and status are derived from its
// children, never hand-set: points are the sum of the children that are not ABANDONED; the status follows
// the children until every child is closed, then it is REVIEW ("ready to close") until the coordinator
// closes it with ticket.mjs close. A closed container reopens by itself when a child is open again.
export const liveTickets = (board) => Object.entries(GROUPS).flatMap(([g, type]) => (board[g] ?? []).map((rec) => ({ rec, type: rec.type ?? type })));
export const isContainer = (t, all) => (t.type === 'epic' || t.type === 'story') && all.some((x) => x.parent === t.id);
export function derivedState(t, kids) {
  const points = kids.filter((k) => k.status !== 'ABANDONED').reduce((n, k) => n + (Number(k.points) || 0), 0);
  let status;
  if (kids.every((k) => CLOSED.includes(k.status))) status = CLOSED.includes(t.status) ? t.status : 'REVIEW';
  else if (kids.some((k) => ['IN_PROGRESS', 'REVIEW', 'DONE', 'PAUSED', 'BLOCKED'].includes(k.status))) status = 'IN_PROGRESS';
  else if (kids.some((k) => k.status === 'TODO')) status = 'TODO';
  else status = 'BACKLOG';
  return { points, status };
}
// Sets points and status on every container, children first. Returns [{ id, field, from, to }].
export function deriveContainers(board) {
  const live = liveTickets(board);
  const kidsOf = new Map();
  for (const x of live) if (x.rec.parent) kidsOf.set(x.rec.parent, [...(kidsOf.get(x.rec.parent) ?? []), x]);
  const seen = new Set();
  const changes = [];
  const visit = (x) => {
    if (seen.has(x.rec.id)) return;
    seen.add(x.rec.id);
    const kids = kidsOf.get(x.rec.id) ?? [];
    kids.forEach(visit);
    if (!kids.length || !['epic', 'story'].includes(x.type)) return;
    const d = derivedState(x.rec, kids.map((k) => k.rec));
    for (const field of ['points', 'status']) {
      if (x.rec[field] === d[field]) continue;
      changes.push({ id: x.rec.id, field, from: x.rec[field] ?? null, to: d[field] });
      x.rec[field] = d[field];
    }
    if (x.rec.status !== 'DONE' && x.rec.done_at) x.rec.done_at = null;
  };
  live.forEach(visit);
  return changes;
}

// ---------- archive (protocol 6.6) ----------
export function loadArchive(root) {
  const f = path.join(root, ARCHIVE_FILE);
  if (!fs.existsSync(f)) return Object.fromEntries(Object.keys(GROUPS).map((g) => [g, []]));
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
// The fields a stub keeps on the board. Everything else lives in the archive file.
export const STUB_FIELDS = ['id', 'title', 'status', 'points', 'parent', 'model', 'order', 'design', 'created_at', 'updated_at', 'started_at', 'done_at', 'done_by', 'done_by_model', 'rework_count', 'stamps_backfilled'];
// A note by ID: the live one, else the archived one. Returns the text or null.
export function readNote(root, id) {
  for (const dir of [HANDOVER_DIR, ARCHIVE_NOTE_DIR]) {
    const f = path.join(root, dir, `${id}.md`);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return null;
}

// ---------- velocity (protocol 6.1) ----------
// From the fields ticket.mjs writes: started_at (first claim), done_at (review DONE), rework_count. Only
// leaf tickets count; a container is the sum of its children. The result depends on the board alone, never on
// the clock, so BOARD.md renders the same everywhere. all: tickets(board). since: ISO time, optional.
export function velocity(all, { since } = {}) {
  const leaves = all.filter((t) => !isContainer(t, all) && t.status === 'DONE' && t.done_at && (!since || t.done_at >= since));
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
  const group = (list) => {
    const points = list.reduce((n, t) => n + (Number(t.points) || 0), 0);
    const times = list.flatMap((t) => [t.started_at, t.done_at]).map((s) => Date.parse(s ?? '')).filter((n) => !Number.isNaN(n));
    const days = times.length ? Math.max(1, Math.ceil((Math.max(...times) - Math.min(...times)) / 86_400_000)) : 0;
    // A cycle time needs a real claim time; a board migrated from notes has none for its old tickets.
    const measured = list.filter((t) => t.started_at && !t.stamps_backfilled);
    const cycle = median(measured.map((t) => (Date.parse(t.done_at) - Date.parse(t.started_at)) / 3_600_000).filter((h) => h >= 0));
    const reworked = list.filter((t) => (t.rework_count ?? 0) > 0);
    return {
      tickets: list.length, points, days, points_per_day: days ? Math.round((points / days) * 10) / 10 : null,
      cycle_hours_median: cycle === null ? null : Math.round(cycle * 10) / 10, cycle_measured: measured.length,
      reworked: reworked.length, reworks: list.reduce((n, t) => n + (t.rework_count ?? 0), 0),
      rework_rate: list.length ? Math.round((reworked.length / list.length) * 100) : null,
    };
  };
  return { all: group(leaves), by_tier: Object.fromEntries(['small', 'medium', 'large'].map((k) => [k, group(leaves.filter((t) => t.model === k))])) };
}
