#!/usr/bin/env node
// Claude Code SessionStart hook. Brings the CodeGraph index up to date before the session starts,
// because the index only updates live while a CodeGraph daemon is running. Edits made while no
// session was open (git pull, branch switch, editor changes) would otherwise stay unindexed.
// Also prints one line per open handover flag so the coordinator sees them at startup.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const out = [];

if (fs.existsSync(path.join(root, '.codegraph'))) {
  // shell: true so Windows resolves codegraph.cmd; one quoted string avoids Node's DEP0190 warning.
  const r = spawnSync(`codegraph sync -q "${root}"`, { shell: true, encoding: 'utf8', timeout: 90_000 });
  out.push(r.status === 0 ? 'CodeGraph index synced.' : `CodeGraph sync failed (exit ${r.status}). Run "codegraph sync" manually.`);
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
