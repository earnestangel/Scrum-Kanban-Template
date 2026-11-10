#!/usr/bin/env node
// Claude Code SessionStart hook.
// - Starts a CodeGraph sync in the background, because the index only updates live while a CodeGraph daemon
//   is running. Edits made while no session was open (git pull, branch switch, editor changes) would
//   otherwise stay unindexed. It does not wait for the sync: a large repository must not delay the session.
// - Prints the session brief: the result of render-board.mjs --check (active ticket, blocked count, what
//   waits on the user, ADRs that are not accepted, containers ready to close, changed design files), the
//   blocked tickets, the tier map, and one line per open handover flag (protocol 5.3).
// Other providers get the same brief by running "node scripts/kanban/render-board.mjs --check" themselves.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isContainer, tickets as flatten } from '../kanban/board-lib.mjs';
import { TIERS, loadTierModels } from '../kanban/tier-policy.mjs';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const out = [];

if (fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))) {
  // shell: true so Windows resolves codegraph.cmd; one quoted string avoids Node's DEP0190 warning.
  try {
    spawn(`codegraph sync -q "${root}"`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    out.push('CodeGraph index sync started in the background.');
  } catch {
    out.push('CodeGraph sync could not start. Run "codegraph sync" manually.');
  }
}

const boardFile = path.join(root, 'docs', 'kanban', 'board.json');
if (fs.existsSync(boardFile)) {
  try {
    const board = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
    const tickets = flatten(board);
    const leaf = (t) => !isContainer(t, tickets);
    // Active and blocked tickets, so the coordinator can reconcile an orphaned claim (protocol 5.3).
    for (const t of tickets.filter((t) => t.status === 'IN_PROGRESS' && leaf(t))) {
      out.push(`In progress: ${t.id} by ${t.assignee ?? '(none)'} since ${t.claimed_at ?? '(unknown)'}. If this session did not claim it, ask the user whether that agent is still running (protocol 5.3).`);
    }
    const blocked = tickets.filter((t) => t.status === 'BLOCKED' && leaf(t));
    if (blocked.length) out.push(`Blocked tickets (${blocked.length}):`, ...blocked.map((t) => `  ${t.id}: ${t.blocked_reason ?? '(no reason)'}`));
    // The board check and its brief. Errors first: a board that does not validate stops every ticket.mjs command.
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'kanban', 'render-board.mjs'), '--check'], { encoding: 'utf8', timeout: 60_000 });
    const errors = (r.stderr ?? '').split(/\r?\n/).filter((l) => /^error: |BOARD\.md is out of date/.test(l));
    if (errors.length) out.push(`Board check failed (${errors.length}):`, ...errors.slice(0, 12).map((l) => `  ${l}`), ...(errors.length > 12 ? [`  and ${errors.length - 12} more: node scripts/kanban/render-board.mjs --check`] : []));
    const brief = (r.stdout ?? '').split(/\r?\n/).filter((l) => l.trim() && !/^board OK/.test(l));
    if (brief.length) out.push(...brief);
    // The tier map, so the coordinator knows which models it and its workers may run on (protocol 1.2).
    const { models, source, problem } = loadTierModels(root);
    out.push(`Model tiers (${source}${problem ? `, invalid: ${problem}; using defaults` : ''}): ${TIERS.map((k) => `${k} = ${models[k].join(' | ')}`).join('; ')}.`);
    if (process.env.KANBAN_INLINE) out.push(`KANBAN_INLINE=${process.env.KANBAN_INLINE}: the user lets this session execute those tickets itself (protocol 6.3.1).`);
  } catch {
    out.push('docs/kanban/board.json is not valid JSON. Run: node scripts/kanban/render-board.mjs');
  }
}

const flags = path.join(root, 'docs', 'kanban', 'handovers', 'HANDOVERS.md');
if (fs.existsSync(flags)) {
  const rows = fs
    .readFileSync(flags, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^\|\s*`?[A-Z]+-\d+/.test(l));
  if (rows.length) out.push(`Open handover flags (${rows.length}):`, ...rows);
}

if (out.length) process.stdout.write(out.join('\n') + '\n');
