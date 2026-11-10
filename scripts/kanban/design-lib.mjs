// Design anchor (protocol section 10): the design files a project builds against, the ledger of design
// elements, and the ADRs that record deviations. Shared by render-board.mjs, ticket.mjs, the pre-commit
// check, and migrate.mjs. Plain Node, no dependencies.
//
// The anchor is opt-in per board: it is on once board.json "design_sources" lists a file. From then on every
// rule here is a hard error. ADR checks (a ticket's "adrs") work with or without the anchor.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLOSED, DESIGN_FILE } from './board-lib.mjs';

export const DESIGN_STATES = ['planned', 'built', 'deferred', 'deviated'];
// States that leave the design unbuilt or changed. Each needs an ADR the user accepted.
export const ADR_STATES = ['deferred', 'deviated'];

export const anchorOn = (board) => Array.isArray(board.design_sources) && board.design_sources.length > 0;

// sha256 of a design file. Text files are hashed with LF line endings, so git's autocrlf conversion does not
// count as a design change; a file with a NUL byte in its first 8 KB is binary and hashed as it is.
export function fileHash(abs) {
  const buf = fs.readFileSync(abs);
  const binary = buf.subarray(0, 8192).includes(0);
  return crypto.createHash('sha256').update(binary ? buf : buf.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
}

// Design sources whose file is missing or differs from the recorded hash: [{ path, missing, changed }].
export function sourceDrift(root, board) {
  return (Array.isArray(board.design_sources) ? board.design_sources : []).flatMap((s) => {
    const abs = path.join(root, String(s?.path ?? ''));
    if (!s?.path || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return [{ path: s?.path ?? '(no path)', missing: true, changed: false }];
    return fileHash(abs) === s.sha256 ? [] : [{ path: s.path, missing: false, changed: true }];
  });
}

// ---------- ledger: docs/kanban/design.json ----------
// { "elements": [ { "id": "D-001", "title", "source": "<a design_sources path>", "state", "adr", "note" } ] }
// The tickets of an element are not stored in it: they are the tickets whose "design.refs" name it.
export function loadLedger(root) {
  const f = path.join(root, DESIGN_FILE);
  if (!fs.existsSync(f)) return { elements: [], exists: false, problem: null };
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(obj?.elements)) return { elements: [], exists: true, problem: 'needs an "elements" array' };
    return { elements: obj.elements, exists: true, problem: null };
  } catch (e) {
    return { elements: [], exists: true, problem: `not valid JSON: ${e.message}` };
  }
}
export const refsOf = (t) => (Array.isArray(t.design?.refs) ? t.design.refs : []);
// Tickets that name an element, by element ID. all: tickets(board), stubs included.
export function ticketsByElement(all) {
  const map = new Map();
  for (const t of all) for (const r of refsOf(t)) map.set(r, [...(map.get(r) ?? []), t]);
  return map;
}
// "built" once every ticket of the element is closed and at least one is DONE.
export const isBuilt = (list) => list.length > 0 && list.every((t) => CLOSED.includes(t.status)) && list.some((t) => t.status === 'DONE');

// ---------- ADRs ----------
// board.json "adr": { "dir": "docs/adr", "status_pattern": "<regex, one capture group>", "accepted": ["Accepted"] }.
// The default pattern reads the first word of the status in these forms:
//   | Status | Accepted |        Status: Accepted        **Status:** Accepted        ## Status <newline> Accepted
export const ADR_DEFAULTS = { dir: 'docs/adr', status_pattern: null, accepted: ['Accepted'] };
const DEFAULT_STATUS = '^(?:\\|\\s*\\**status\\**\\s*\\||[-*]?\\s*\\**status\\**\\s*:\\**|#{1,6}\\s*status\\s*\\n+)\\s*\\**\\s*([A-Za-z]+)';

export function adrConfig(board) {
  const c = { ...ADR_DEFAULTS, ...(board.adr && typeof board.adr === 'object' ? board.adr : {}) };
  let re = null;
  let problem = null;
  try {
    re = new RegExp(c.status_pattern || DEFAULT_STATUS, 'im');
  } catch (e) {
    problem = `"adr.status_pattern" is not a valid regular expression: ${e.message}`;
  }
  if (typeof c.dir !== 'string' || !c.dir.trim()) problem = '"adr.dir" must be a directory path';
  if (!Array.isArray(c.accepted) || !c.accepted.length || !c.accepted.every((x) => typeof x === 'string' && x.trim())) problem = '"adr.accepted" must be a non-empty list of status words';
  return { dir: String(c.dir ?? '').replace(/\\/g, '/').replace(/\/$/, ''), re, accepted: (Array.isArray(c.accepted) ? c.accepted : []).map((x) => String(x).toLowerCase()), problem };
}

// "ADR-0016", "adr 16", "0016", and "0016-lambda-relays.md" all name the same ADR.
const adrKey = (s) => {
  const base = String(s).replace(/\.md$/i, '').replace(/^adr[-_ ]?/i, '');
  const num = base.match(/^\d+/)?.[0];
  return num ? String(Number(num)) : base.toLowerCase();
};
export function adrFiles(root, cfg) {
  const dir = path.join(root, cfg.dir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)).sort();
}
// The status word of an ADR text by the configured pattern, or null.
export const adrStatusOf = (text, cfg) => (cfg.re ? String(text).replace(/\r\n/g, '\n').match(cfg.re)?.[1] ?? null : null);
export const isAccepted = (status, cfg) => !!status && cfg.accepted.includes(String(status).toLowerCase());
// { id, file, status, accepted }. file is null when no ADR file matches the ID.
export function adrInfo(root, cfg, id) {
  const file = adrFiles(root, cfg).find((f) => adrKey(f) === adrKey(id)) ?? null;
  if (!file) return { id, file: null, status: null, accepted: false };
  const status = adrStatusOf(fs.readFileSync(path.join(root, cfg.dir, file), 'utf8'), cfg);
  return { id, file: `${cfg.dir}/${file}`, status, accepted: isAccepted(status, cfg) };
}
// Every ADR a ticket depends on: its own "adrs", and the ADR of each design element it implements.
export function adrsOf(t, elementsById) {
  const ids = [...(Array.isArray(t.adrs) ? t.adrs : []), ...refsOf(t).map((r) => elementsById.get(r)?.adr).filter(Boolean)];
  const seen = new Set();
  return ids.filter((id) => !seen.has(adrKey(id)) && seen.add(adrKey(id)));
}
