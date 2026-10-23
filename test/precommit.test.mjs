import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
