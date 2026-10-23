// Shared board helpers for render-board.mjs, ticket.mjs, the Claude Code hooks, and the installer.
// Plain Node, no dependencies, no provider assumptions.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const GROUPS = { epics: 'epic', stories: 'story', tasks: 'task', chores: 'chore', bugs: 'bug' };
export const BOARD_FILE = 'docs/kanban/board.json';
export const BOARD_MD = 'docs/kanban/BOARD.md';
export const HANDOVER_DIR = 'docs/kanban/handovers';
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

// The dated entries of a note: [{ type, date, rest }] in file order. rest is the header after the date.
export function noteEntries(text) {
  const re = new RegExp(`^##\\s*([A-Z]+)\\s*${HEADER_SEP}\\s*(\\d{4}-\\S+)(.*)$`, 'gm');
  return [...String(text ?? '').matchAll(re)].map((m) => ({ type: m[1], date: m[2], rest: m[3].replace(new RegExp(`^\\s*${HEADER_SEP}\\s*`), '').trim() }));
}

// Definition of Groomed (protocol 3.1) for one ticket. noteText(id) returns the note text or null.
// Points are checked by render-board.mjs for every ticket that left BACKLOG.
export function groomingProblems(t, { noteText, hasIndex }) {
  const p = [];
  if (!t.model) p.push('no "model" set; grooming sets the tier the rule requires (protocol 1.2)');
  if (!t.context?.files?.length && !t.context?.symbols?.length) p.push('context.files or context.symbols is empty; grooming must record where the work is');
  if (hasIndex && !t.context?.codegraph_queries?.length) p.push('context.codegraph_queries is empty; grooming must record the queries that found the code');
  if (!t.acceptance?.length) p.push('acceptance criteria are empty');
  if (!t.verify_cmd) p.push('no verify_cmd; the worker cannot self-check');
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
export const isGuarded = (rel) => rel === BOARD_FILE || (rel.startsWith(`${HANDOVER_DIR}/`) && rel.endsWith('.md') && !rel.endsWith('/_TEMPLATE.md'));
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

// files: { "<repo-relative path>": "<content as written>" }. Paths that are not guarded are ignored.
export function recordScriptWrites(root, files) {
  const record = loadScriptWrites(root);
  for (const [rel, text] of Object.entries(files)) if (isGuarded(rel)) record[rel] = contentHash(text);
  const sorted = Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(root, SCRIPT_WRITES_FILE), JSON.stringify({ note: 'Written by scripts/kanban/ticket.mjs. Local; do not commit or edit.', files: sorted }, null, 2) + '\n');
}
