#!/usr/bin/env node
// Commit-time board check, called by scripts/git-hooks/pre-commit. It is the one local check that works
// for every provider, because every agent and every human commits through git.
//
// 1. The staged board validates and the staged BOARD.md is up to date (render-board.mjs --check, run on
//    the staged files, not the working tree). That includes the design anchor: a design source whose staged
//    content differs from its recorded hash fails the commit (protocol 10.5).
// 2. No staged change adds, changes, or removes a "tier_override", or changes docs/kanban/tiers.json,
//    unless the user commits with KANBAN_ALLOW_TIER_EDIT=1. Those are the user's decisions (protocol 1.2);
//    agents never set this variable.
// 3. Every staged board.json, board-archive.json, design.json, and handover note is what
//    scripts/kanban/ticket.mjs last wrote (a hash in docs/kanban/.script-writes.json), unless the user commits
//    with KANBAN_ALLOW_MANUAL_EDIT=1.
// 4. No staged change sets an ADR to an accepted status, unless the user commits with
//    KANBAN_ALLOW_ADR_ACCEPT=1. Accepting an ADR is the user's decision (protocol 10.4); agents never set it.
//
// The check reads only staged content, so it is safe to run from any directory inside the repository.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARCHIVE_FILE, BOARD_FILE, DELETED, DESIGN_FILE, HANDOVER_DIR, contentHash, isGuarded, loadScriptWrites, tickets } from './board-lib.mjs';
import { adrConfig, adrStatusOf, isAccepted } from './design-lib.mjs';
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

// The staged board names what the check needs besides docs/kanban/: design sources, ADRs, findings.
let stagedBoard = {};
try {
  stagedBoard = JSON.parse(staged(BOARD_FILE) ?? '{}') ?? {};
} catch {}
const adr = adrConfig(stagedBoard);
const knowledgeDir = String(stagedBoard.knowledge?.dir ?? 'docs/findings');

// 1. Validate the staged docs/kanban/ tree with the staged render-board.mjs and its modules.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-precommit-'));
try {
  const extra = [...(Array.isArray(stagedBoard.design_sources) ? stagedBoard.design_sources.map((s) => s?.path) : []), adr.dir, knowledgeDir].filter((p) => typeof p === 'string' && p.trim());
  const files = git('-C', root, 'ls-files', '--cached', '--', 'docs/kanban', 'scripts/kanban', '.codegraph/codegraph.db', ...extra).stdout.split('\n').filter(Boolean);
  // One git call writes every staged file, byte for byte (a design source may be an image). A large board
  // has hundreds of notes; one call per file would take minutes on Windows.
  const out = spawnSync('git', ['-C', root, 'checkout-index', `--prefix=${tmp.replace(/\\/g, '/')}/`, '-f', '-z', '--stdin'], { input: files.filter((f) => !f.endsWith('codegraph.db')).join('\0'), encoding: 'utf8' });
  if (out.status !== 0) problems.push(`could not read the staged files: ${out.stderr.trim()}`);
  if (files.some((f) => f.endsWith('codegraph.db'))) {
    fs.mkdirSync(path.join(tmp, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.codegraph', 'codegraph.db'), '');
  }
  // The working tree's index decides whether codegraph_queries are required, as in render-board.mjs.
  if (fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))) {
    fs.mkdirSync(path.join(tmp, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.codegraph', 'codegraph.db'), '');
  }
  const r = spawnSync(process.execPath, [path.join(tmp, 'scripts/kanban/render-board.mjs'), '--check'], { encoding: 'utf8' });
  if (r.status !== 0) problems.push(`board check failed on the staged files:\n${(r.stderr || r.stdout).trim()}\nFix it with scripts/kanban/ticket.mjs, run: node scripts/kanban/render-board.mjs, and stage BOARD.md.`);
} catch (e) {
  problems.push(`board check could not run: ${e.message}`);
}
// The staged content of a board file, from the copy made above when it is there (no git call per note).
const stagedText = (rel) => (fs.existsSync(path.join(tmp, rel)) ? fs.readFileSync(path.join(tmp, rel), 'utf8') : staged(rel));

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

// 3. Script-only board files (protocol 6.1). Every staged board file and handover note must be content that
//    ticket.mjs, migrate.mjs, or the installer wrote, as recorded in .script-writes.json, unless the user
//    commits with KANBAN_ALLOW_MANUAL_EDIT=1. Agents never set it.
if (process.env.KANBAN_ALLOW_MANUAL_EDIT !== '1') {
  const record = loadScriptWrites(root);
  const manual = [];
  for (const line of git('-C', root, 'diff', '--cached', '--name-status', '--no-renames', '--', BOARD_FILE, ARCHIVE_FILE, DESIGN_FILE, HANDOVER_DIR).stdout.split('\n')) {
    const [st, rel] = line.split('\t');
    if (!rel || !isGuarded(rel)) continue;
    // archive moves a note to handovers/archive/ and records the removal.
    if (st === 'D') {
      if (record[rel] !== DELETED) manual.push(`${rel} (deleted)`);
    } else if (record[rel] !== contentHash(stagedText(rel) ?? '')) manual.push(rel);
  }
  if (manual.length) {
    problems.push(
      `staged board files that scripts/kanban/ticket.mjs did not write, or that changed after its last write:\n  ${manual.join('\n  ')}\n` +
        'Make the change with ticket.mjs instead (protocol 6.1). If you are the user and edited them on purpose, commit with KANBAN_ALLOW_MANUAL_EDIT=1 (agents never set it).',
    );
  }
}

// 4. Only the user accepts an ADR (protocol 10.4): a staged ADR whose status is accepted and was not in HEAD.
if (process.env.KANBAN_ALLOW_ADR_ACCEPT !== '1' && !adr.problem) {
  const accepted = [];
  for (const line of git('-C', root, 'diff', '--cached', '--name-status', '--no-renames', '--', adr.dir).stdout.split('\n')) {
    const [st, rel] = line.split('\t');
    if (!rel || st === 'D' || !/\.md$/i.test(rel)) continue;
    const now = adrStatusOf(stagedText(rel) ?? '', adr);
    const was = adrStatusOf(head(rel) ?? '', adr);
    if (isAccepted(now, adr) && !isAccepted(was, adr)) accepted.push(`${rel} (${was ?? 'new'} -> ${now})`);
  }
  if (accepted.length) {
    problems.push(
      `a staged change accepts an ADR:\n  ${accepted.join('\n  ')}\n` +
        'Only the user accepts an ADR (protocol 10.4). If you are the user and accepted it yourself, commit with KANBAN_ALLOW_ADR_ACCEPT=1 (agents never set it).',
    );
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
if (problems.length) {
  console.error(`pre-commit: ${problems.join('\n\npre-commit: ')}`);
  process.exit(1);
}
