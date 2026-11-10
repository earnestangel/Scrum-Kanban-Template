import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import { OPUS, sandbox } from './helpers.mjs';

function repo() {
  const sb = sandbox();
  const git = (...a) => spawnSync('git', ['-C', sb.dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  sb.write('.gitignore', 'docs/kanban/.script-writes.json\n');
  git('add', '-A');
  git('commit', '-qm', 'init', '--no-verify');
  const check = (env = {}) => sb.run('scripts/kanban/precommit-check.mjs', [], { env });
  return { sb, git, check };
}
const C = ['--agent', 'claude-large', '--model', OPUS];

test('pre-commit: a board changed by ticket.mjs passes', () => {
  const { sb, git, check } = repo();
  assert.equal(sb.ticket(['edit', 'TASK-001', '--set', 'title=Renamed', '--reason', 'r', ...C]).status, 0);
  assert.equal(sb.ticket(['create', 'chore', '--title', 'New', ...C]).status, 0);
  git('add', '-A');
  const r = check();
  assert.equal(r.status, 0, r.stderr);
});

test('pre-commit: a stale staged BOARD.md fails', () => {
  const { sb, git, check } = repo();
  const b = sb.board();
  b.tasks[0].title = 'Renamed';
  sb.setBoard(b);
  git('add', '-A');
  const r = check({ KANBAN_ALLOW_MANUAL_EDIT: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /out of date/);
});

test('pre-commit: a hand-edited board or note fails unless the user sets KANBAN_ALLOW_MANUAL_EDIT=1', () => {
  const { sb, git, check } = repo();
  const b = sb.board();
  b.tasks[0].title = 'Renamed by hand';
  sb.setBoard(b);
  sb.render();
  git('add', '-A');
  let r = check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not write[\s\S]*docs\/kanban\/board\.json[\s\S]*KANBAN_ALLOW_MANUAL_EDIT=1/);
  assert.equal(check({ KANBAN_ALLOW_MANUAL_EDIT: '1' }).status, 0);

  // A script write, then a hand edit on top of it.
  git('reset', '-q', '--hard');
  assert.equal(sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--text', 'More.', ...C]).status, 0);
  git('add', '-A');
  assert.equal(check().status, 0, check().stderr);
  sb.write('docs/kanban/handovers/TASK-001.md', `${sb.read('docs/kanban/handovers/TASK-001.md')}\nSneaked in.\n`);
  git('add', '-A');
  r = check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /handovers\/TASK-001\.md/);
  assert.doesNotMatch(r.stderr, /board\.json\n/);

  // Deleting a note by hand.
  git('reset', '-q', '--hard');
  git('rm', '-q', 'docs/kanban/handovers/TASK-002.md');
  assert.match(check({}).stderr, /TASK-002\.md \(deleted\)/);
});

test('pre-commit: tier_override and tiers.json changes need the user switch', () => {
  const { sb, git, check } = repo();
  const b = sb.board();
  b.tasks[0].tier_override = { tier: 'large', reason: 'user said so' };
  b.tasks[0].model = 'large';
  sb.setBoard(b);
  sb.render();
  git('add', '-A');
  const manual = { KANBAN_ALLOW_MANUAL_EDIT: '1' };
  const r = check(manual);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tier_override/);
  assert.equal(check({ ...manual, KANBAN_ALLOW_TIER_EDIT: '1' }).status, 0);

  git('reset', '-q', '--hard');
  sb.write('docs/kanban/tiers.json', JSON.stringify({ tiers: { large: ['*'], medium: ['*'], small: ['*'] } }));
  git('add', '-A');
  assert.match(check().stderr, /tiers\.json/);
});

// ---------- 0.9 ----------

test('pre-commit: only the user accepts an ADR', () => {
  const { sb, git, check } = repo();
  fs.mkdirSync(sb.file('docs/adr'), { recursive: true });
  sb.write('docs/adr/0001-relay.md', '# Relay\n\nStatus: Proposed\n');
  git('add', '-A');
  assert.equal(check().status, 0, check().stderr);
  git('commit', '-qm', 'adr', '--no-verify');
  sb.write('docs/adr/0001-relay.md', '# Relay\n\nStatus: Accepted\n');
  sb.write('docs/adr/0002-new.md', '# New\n\n| Status | Accepted |\n');
  git('add', '-A');
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /accepts an ADR:\n\s+docs\/adr\/0001-relay\.md \(Proposed -> Accepted\)\n\s+docs\/adr\/0002-new\.md \(new -> Accepted\)[\s\S]*KANBAN_ALLOW_ADR_ACCEPT=1/);
  assert.equal(check({ KANBAN_ALLOW_ADR_ACCEPT: '1' }).status, 0);
});

test('pre-commit: a design source that changed after its hash was recorded fails; archive moves pass', () => {
  const { sb, git, check } = repo();
  fs.mkdirSync(sb.file('docs/design'), { recursive: true });
  // A binary source: the staged bytes are hashed, not a text reading of them.
  fs.writeFileSync(sb.file('docs/design/flow.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff, 0xfe]));
  assert.equal(sb.ticket(['design', 'docs/design/flow.png', ...C]).status, 0);
  assert.equal(sb.ticket(['element', 'new', '--title', 'Relay', '--source', 'docs/design/flow.png', '--ticket', 'TASK-001', ...C]).status, 0);
  git('add', '-A');
  assert.equal(check().status, 0, check().stderr);
  git('commit', '-qm', 'anchor', '--no-verify');
  fs.writeFileSync(sb.file('docs/design/flow.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
  git('add', '-A');
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /design source docs\/design\/flow\.png changed since its hash was recorded[^\n]*TASK-001/);
  assert.equal(sb.ticket(['design', 'docs/design/flow.png', ...C]).status, 0);
  git('add', '-A');
  assert.equal(check().status, 0, check().stderr);

  // A hand edit of the ledger fails like a hand edit of the board.
  sb.write('docs/kanban/design.json', sb.read('docs/kanban/design.json').replace('Relay', 'Relay!'));
  git('add', '-A');
  assert.match(check().stderr, /did not write[\s\S]*docs\/kanban\/design\.json/);
});

test('pre-commit: notes moved by archive are script writes', () => {
  const { sb, git, check } = repo();
  const b = sb.board();
  b.chores = [{ id: 'CHORE-001', title: 'Old chore', status: 'DONE', points: 1, model: 'small', handovers: ['CHORE-001'], done_at: '2026-10-02T00:00:00Z' }];
  sb.setBoard(b);
  sb.write('docs/kanban/handovers/CHORE-001.md', '# CHORE-001\n\n## REVIEW · 2026-10-02T00:00:00Z · c · DONE\n');
  sb.render();
  git('add', '-A');
  git('commit', '-qm', 'chore', '--no-verify');
  const r = sb.ticket(['archive', 'CHORE-001', ...C]);
  assert.equal(r.status, 0, r.stderr);
  git('add', '-A');
  assert.equal(check().status, 0, check().stderr);
});
