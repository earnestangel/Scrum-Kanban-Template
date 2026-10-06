// Shared board helpers for render-board.mjs, ticket.mjs, the Claude Code hooks, and the installer.
// Plain Node, no dependencies, no provider assumptions.

import fs from 'node:fs';
import path from 'node:path';

export const GROUPS = { epics: 'epic', stories: 'story', tasks: 'task', chores: 'chore', bugs: 'bug' };
export const BOARD_FILE = 'docs/kanban/board.json';
export const HANDOVER_DIR = 'docs/kanban/handovers';

export const loadBoard = (root) => JSON.parse(fs.readFileSync(path.join(root, BOARD_FILE), 'utf8'));

// Every ticket record with its type, taken from its board.json group unless the record sets one.
export const tickets = (board) => Object.entries(GROUPS).flatMap(([g, type]) => (board[g] ?? []).map((t) => ({ ...t, type: t.type ?? type })));

// The live record (not a copy) for an ID, so callers can change it in place.
export const findTicket = (board, id) => Object.keys(GROUPS).flatMap((g) => board[g] ?? []).find((t) => t.id === id);

// ISO 8601 UTC without milliseconds, for example 2026-09-30T14:05:00Z.
export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// Handover entry headers: "## <TYPE> · <ISO date> · <agent> · <STATUS>" (see _TEMPLATE.md). Agents on
// other models often swap the middle dot for another separator, so these are accepted too.
export const HEADER_SEP = '[·•|\\-–—]';
// Without a status, only "## <TYPE> <sep> <date>" is required (GROOMING and FLAG headers end in the agent).
export const entryRe = (type, status) =>
  new RegExp(`^##\\s*${type}\\s*${HEADER_SEP}\\s*\\d{4}-${status ? `.*${HEADER_SEP}\\s*${status}\\b` : ''}`, 'mi');

// Canonical header, as ticket.mjs writes it.
export const formatHeader = (type, ...parts) => `## ${type} · ${nowIso()} · ${parts.filter(Boolean).join(' · ')}`;
