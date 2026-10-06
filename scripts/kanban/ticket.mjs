#!/usr/bin/env node
// Board transitions and handover entries, the same way for every agent, provider, and model.
// Agents call this instead of hand-editing board.json state fields or writing entry headers.
//
//   node scripts/kanban/ticket.mjs claim    <ID> --worker <name> --model <model-id>
//   node scripts/kanban/ticket.mjs handover <ID> --status REVIEW|PAUSED|BLOCKED|ABANDONED [--reason <text>] --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs note     <ID> --type GROOMING --agent <name> --model <model-id> --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs note     <TARGET-ID> --type FLAG --from <SOURCE-ID> --agent <name> --summary <text> --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs review   <ID> --outcome DONE|REWORK --reviewer <name> --model <model-id> --body <file|-> | --text <md>
//   node scripts/kanban/ticket.mjs recover  <ID> --coordinator <name> --model <model-id>
//   node scripts/kanban/ticket.mjs show     <ID>
//
// --body - reads the entry body from stdin. Every write runs render-board.mjs afterwards; if the board does
// not validate, every file this command changed is restored and the command fails.
//
// Tier checks (protocol 1.2, 6.3.1). --model is the model ID the agent runs on, as its tool reports it.
// - claim: the model must be listed for the ticket's tier in docs/kanban/tiers.json, unless the user listed
//   the ticket in KANBAN_INLINE (comma-separated IDs) to approve a mismatch for that ticket.
// - GROOMING notes, review, recover: coordinator work; the model must be listed for the "large" tier.
// KANBAN_DELEGATE=off (set by the user) skips the tier checks. This command never reads or writes
// "tier_override" or tiers.json: only the user changes those.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_FILE, HANDOVER_DIR, findTicket, formatHeader, loadBoard, nowIso, tickets } from './board-lib.mjs';
import { TIERS_FILE, loadTierModels, modelFitsTier, requiredTier, tiersOfModel } from './tier-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const [cmd, id, ...rest] = process.argv.slice(2);

const fail = (msg) => {
  console.error(`ticket.mjs: ${msg}`);
  process.exit(1);
};

const FLAGS = {
  claim: ['worker', 'model'],
  handover: ['status', 'reason', 'body', 'text', 'worker'],
  note: ['type', 'agent', 'model', 'from', 'summary', 'body', 'text'],
  review: ['outcome', 'reviewer', 'model', 'body', 'text'],
  recover: ['coordinator', 'model'],
  show: [],
};
if (!FLAGS[cmd] || !id || id.startsWith('--')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1);
}

// --key value or --key=value.
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const m = rest[i].match(/^--([a-z-]+)(?:=(.*))?$/s);
  if (!m) fail(`unexpected argument "${rest[i]}"`);
  if (!FLAGS[cmd].includes(m[1])) fail(`${cmd} does not take --${m[1]}`);
  opts[m[1]] = m[2] ?? rest[++i];
  if (opts[m[1]] === undefined) fail(`--${m[1]} needs a value`);
}
const need = (...keys) => keys.forEach((k) => opts[k] || fail(`${cmd} needs --${k}`));

const boardPath = path.join(root, BOARD_FILE);
const noteDir = path.join(root, HANDOVER_DIR);
const notePath = (tid) => path.join(noteDir, `${tid}.md`);
const flagIndex = path.join(noteDir, 'HANDOVERS.md');

let board;
try {
  board = loadBoard(root);
} catch (e) {
  fail(`cannot read ${BOARD_FILE}: ${e.message}`);
}
const t = findTicket(board, id);
if (!t) fail(`${id} is not on the board`);
const typed = tickets(board).find((x) => x.id === id);
const tier = requiredTier(typed);
const tierModels = loadTierModels(root);
if (tierModels.problem) fail(`${TIERS_FILE}: ${tierModels.problem}. Ask the user to fix it.`);
const checksOff = process.env.KANBAN_DELEGATE === 'off';
const inline = (process.env.KANBAN_INLINE ?? '').split(',').map((s) => s.trim()).includes(id);
const listed = (want) => tierModels.models[want].join(', ');

function requireTier(model, want, role) {
  if (checksOff || modelFitsTier(model, want, tierModels.models)) return;
  const has = tiersOfModel(model, tierModels.models);
  fail(
    `${role} needs a model listed for tier "${want}" in ${tierModels.source} (${listed(want)}); "${model}" is ${has.length ? `listed for ${has.join(', ')}` : 'not listed'}. ` +
      'Only the user changes tiers.json, a ticket tier, or approves a mismatch (protocol 1.2, 6.3.1).',
  );
}

const body = () => {
  if (opts.text !== undefined) return opts.text;
  need('body');
  return opts.body === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(opts.body), 'utf8');
};

// Writes are collected, applied together, then validated by render-board.mjs; on failure they are undone.
const writes = new Map();
const original = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const current = (f) => (writes.has(f) ? writes.get(f) : original(f));
const eol = (text) => (/\r\n/.test(text ?? '') ? '\r\n' : '\n');
const put = (f, text) => writes.set(f, text);
const saveBoard = () => {
  const before = original(boardPath);
  put(boardPath, (JSON.stringify(board, null, 2) + '\n').replace(/\n/g, eol(before)));
};

function appendEntry(tid, header, text) {
  const f = notePath(tid);
  const typedT = tickets(board).find((x) => x.id === tid);
  const before = current(f) ?? `# Handover Notes: ${tid} ${typedT?.title ?? ''}`.trimEnd() + '\n\n<!-- Append-only log. See docs/kanban/protocol.md section 6. -->\n';
  const nl = eol(before);
  const entry = `${header}\n\n${text.trim()}\n`.replace(/\r?\n/g, nl);
  put(f, before.replace(/\s*$/, '') + `${nl}${nl}---${nl}${nl}` + entry);
  if (!(t.handovers ?? []).includes(t.id) && tid === t.id) t.handovers = [...(t.handovers ?? []), t.id];
}

function commit(summary) {
  const backups = new Map([...writes.keys()].map((f) => [f, original(f)]));
  for (const [f, text] of writes) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  const r = spawnSync(process.execPath, [path.join(here, 'render-board.mjs')], { encoding: 'utf8' });
  if (r.status !== 0) {
    for (const [f, text] of backups) text === null ? fs.rmSync(f, { force: true }) : fs.writeFileSync(f, text);
    process.stderr.write(r.stderr || r.stdout);
    fail('the board did not validate, so nothing was changed.');
  }
  process.stderr.write(r.stderr);
  console.log(summary);
  console.log(r.stdout.trim());
}

const clearClaim = () => {
  t.assignee = null;
  t.claimed_at = null;
  delete t.worker_model;
};

switch (cmd) {
  case 'show': {
    const active = tickets(board).filter((x) => x.status === 'IN_PROGRESS');
    console.log(JSON.stringify(t, null, 2));
    console.log(`\nTier: ${tier}${t.tier_override ? ' (user tier_override)' : ''}. Models listed for it in ${tierModels.source}: ${listed(tier)}.`);
    console.log(`Coordinator (large) models: ${listed('large')}.`);
    console.log(`In progress: ${active.map((x) => `${x.id} by ${x.assignee}`).join(', ') || 'none'}.`);
    break;
  }

  case 'claim': {
    need('worker', 'model');
    if (!['TODO', 'PAUSED'].includes(t.status)) fail(`${id} is ${t.status}; only TODO or PAUSED tickets can be claimed (protocol 1.3, 6.5).`);
    const notDone = (t.requires ?? []).filter((r) => findTicket(board, r)?.status !== 'DONE');
    if (notDone.length) fail(`${id} requires ${notDone.join(', ')}, which are not DONE (protocol 6.5 step 2).`);
    const other = tickets(board).find((x) => x.status === 'IN_PROGRESS');
    if (other) fail(`${other.id} is already IN_PROGRESS (by ${other.assignee ?? 'none'}). Ask the user whether to PAUSE or ABANDON it (protocol 5.2).`);
    const fits = modelFitsTier(opts.model, tier, tierModels.models);
    if (!fits && !inline) requireTier(opts.model, tier, `${id} (tier "${tier}")`);
    t.status = 'IN_PROGRESS';
    t.assignee = opts.worker;
    t.claimed_at = nowIso();
    t.worker_model = opts.model;
    saveBoard();
    commit(`${id} claimed by ${opts.worker} on ${opts.model} (tier ${tier}).`);
    if (!fits) console.log(`Note: ${opts.model} is not listed for tier "${tier}". The user approved it with KANBAN_INLINE; record that approval in the PROGRESS entry.`);
    break;
  }

  case 'handover': {
    need('status');
    const status = opts.status.toUpperCase();
    if (!['REVIEW', 'PAUSED', 'BLOCKED', 'ABANDONED'].includes(status)) fail('--status must be REVIEW, PAUSED, BLOCKED, or ABANDONED.');
    if (t.status !== 'IN_PROGRESS') fail(`${id} is ${t.status}; only an IN_PROGRESS ticket is handed over.`);
    if (opts.worker && opts.worker !== t.assignee) fail(`${id} is claimed by ${t.assignee}, not ${opts.worker}.`);
    if (status === 'BLOCKED' && !opts.reason) fail('BLOCKED needs --reason (protocol 5).');
    const who = `${t.assignee ?? 'unknown'}${t.worker_model ? ` (${t.worker_model})` : ''}`;
    appendEntry(id, formatHeader('PROGRESS', who, status), body());
    t.status = status;
    t.blocked_reason = status === 'BLOCKED' ? opts.reason : null;
    clearClaim();
    saveBoard();
    commit(`${id} is ${status}.`);
    break;
  }

  case 'note': {
    need('type', 'agent');
    const type = opts.type.toUpperCase();
    if (type === 'GROOMING') {
      need('model');
      requireTier(opts.model, 'large', 'Grooming');
      appendEntry(id, formatHeader('GROOMING', `${opts.agent} (${opts.model})`), body());
      saveBoard();
      commit(`GROOMING entry added to ${HANDOVER_DIR}/${id}.md.`);
    } else if (type === 'FLAG') {
      need('from', 'summary');
      if (!findTicket(board, opts.from)) fail(`--from ${opts.from} is not on the board`);
      appendEntry(id, formatHeader('FLAG', `from ${opts.from}`, opts.agent), body());
      const index = current(flagIndex) ?? '| Target | From | Summary | Note |\n|---|---|---|---|\n';
      const row = `| \`${id}\` | \`${opts.from}\` | ${opts.summary.replace(/\|/g, '\\|').replace(/\s+/g, ' ')} | [${id}.md](./${id}.md) |`;
      put(flagIndex, index.replace(/\s*$/, '') + eol(index) + row + eol(index));
      saveBoard();
      commit(`FLAG entry added to ${HANDOVER_DIR}/${id}.md and HANDOVERS.md.`);
    } else fail('--type must be GROOMING or FLAG. PROGRESS and REVIEW entries come from handover and review.');
    break;
  }

  case 'review': {
    need('outcome', 'reviewer', 'model');
    const outcome = opts.outcome.toUpperCase();
    if (!['DONE', 'REWORK'].includes(outcome)) fail('--outcome must be DONE or REWORK.');
    if (t.status !== 'REVIEW') fail(`${id} is ${t.status}; only a REVIEW ticket is reviewed.`);
    requireTier(opts.model, 'large', 'Review');
    appendEntry(id, formatHeader('REVIEW', `${opts.reviewer} (${opts.model})`, outcome), body());
    t.status = outcome === 'DONE' ? 'DONE' : 'TODO';
    if (outcome === 'DONE' && original(flagIndex) !== null) {
      const text = current(flagIndex);
      const rowRe = new RegExp(`^\\|\\s*\`?${id}\`?\\s*\\|`);
      put(flagIndex, text.split(/(?<=\n)/).filter((l) => !rowRe.test(l)).join(''));
    }
    saveBoard();
    commit(`${id} is ${t.status}.`);
    break;
  }

  case 'recover': {
    need('coordinator', 'model');
    if (t.status !== 'IN_PROGRESS') fail(`${id} is ${t.status}; only an IN_PROGRESS claim is recovered.`);
    requireTier(opts.model, 'large', 'Recovery');
    const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' }).stdout?.trim() || '(none)';
    const text = [
      `Recovered from orphaned claim by \`${t.assignee ?? 'unknown'}\`${t.worker_model ? ` on ${t.worker_model}` : ''}, claimed at ${t.claimed_at ?? 'unknown'}. The edits were kept; the next worker resumes from them.`,
      '',
      '**Files changed** (uncommitted, from `git status --short`)',
      '```',
      git('status', '--short'),
      '```',
      '',
      '**Diff stat**',
      '```',
      git('diff', '--stat'),
      '```',
    ].join('\n');
    appendEntry(id, formatHeader('PROGRESS', `${opts.coordinator} (${opts.model})`, 'PAUSED'), text);
    t.status = 'PAUSED';
    clearClaim();
    saveBoard();
    commit(`${id} recovered and PAUSED.`);
    break;
  }
}
