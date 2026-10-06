#!/usr/bin/env node
// Commit-time board check, called by scripts/git-hooks/pre-commit. It is the one local check that works
// for every provider, because every agent and every human commits through git.
//
// 1. The staged board validates and the staged BOARD.md is up to date (render-board.mjs --check, run on
//    the staged files, not the working tree).
// 2. No staged change adds, changes, or removes a "tier_override", or changes docs/kanban/tiers.json,
//    unless the user commits with KANBAN_ALLOW_TIER_EDIT=1. Those are the user's decisions (protocol 1.2);
//    agents never set this variable.
//
// The check reads only staged content, so it is safe to run from any directory inside the repository.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOARD_FILE, tickets } from './board-lib.mjs';
import { TIERS_FILE } from './tier-policy.mjs';

const git = (...args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const root = git('rev-parse', '--show-toplevel').stdout.trim();
const staged = (rel) => {
  const r = git('-C', root, 'show', `:${rel}`);
  return r.status === 0 ? r.stdout : null;
};
const head = (rel) => {
  const r = git('-C', root, 'show', `HEAD:${rel}`);
  return r.status === 0 ? r.stdout : null;
};
const problems = [];

// 1. Validate the staged docs/kanban/ tree with the staged render-board.mjs and its modules.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-precommit-'));
try {
  const files = git('-C', root, 'ls-files', '--cached', '--', 'docs/kanban', 'scripts/kanban', '.codegraph/codegraph.db').stdout.split('\n').filter(Boolean);
  for (const rel of files) {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (rel.endsWith('codegraph.db')) fs.writeFileSync(dest, '');
    else fs.writeFileSync(dest, git('-C', root, 'show', `:${rel}`).stdout);
  }
  // The working tree's index decides whether codegraph_queries are required, as in render-board.mjs.
  if (fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))) {
    fs.mkdirSync(path.join(tmp, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.codegraph', 'codegraph.db'), '');
  }
  const r = spawnSync(process.execPath, [path.join(tmp, 'scripts/kanban/render-board.mjs'), '--check'], { encoding: 'utf8' });
  if (r.status !== 0) problems.push(`board check failed on the staged files:\n${(r.stderr || r.stdout).trim()}\nFix board.json, run: node scripts/kanban/render-board.mjs, and stage BOARD.md.`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 2. User-owned tier decisions.
if (process.env.KANBAN_ALLOW_TIER_EDIT !== '1') {
  const overrides = (text) => {
    try {
      return JSON.stringify(Object.fromEntries(tickets(JSON.parse(text)).filter((t) => t.tier_override != null).map((t) => [t.id, t.tier_override])));
    } catch {
      return null;
    }
  };
  const tierProblems = [];
  const [before, after] = [head(BOARD_FILE), staged(BOARD_FILE)];
  if (after !== null && overrides(before ?? '{}') !== overrides(after)) {
    tierProblems.push(`a staged change to ${BOARD_FILE} adds, changes, or removes a "tier_override". Only the user decides tiers (protocol 1.2).`);
  }
  // A new tiers.json (first install) is fine; changing a committed one is the user's call.
  const norm = (s) => (s ?? '').replace(/\r\n/g, '\n');
  if (head(TIERS_FILE) !== null && norm(head(TIERS_FILE)) !== norm(staged(TIERS_FILE))) {
    tierProblems.push(`a staged change to ${TIERS_FILE}. Only the user changes which models count as each tier (protocol 1.2).`);
  }
  if (tierProblems.length) {
    problems.push(...tierProblems, 'If you are the user and made this change yourself, commit with KANBAN_ALLOW_TIER_EDIT=1 (agents never set it).');
  }
}

if (problems.length) {
  console.error(`pre-commit: ${problems.join('\n\npre-commit: ')}`);
  process.exit(1);
}
