import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

function repo() {
  const sb = sandbox();
  const git = (...a) => spawnSync('git', ['-C', sb.dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-qm', 'init', '--no-verify');
  const check = (env = {}) => sb.run('scripts/kanban/precommit-check.mjs', [], { env });
  return { sb, git, check };
}

test('pre-commit: a clean staged board passes', () => {
  const { sb, git, check } = repo();
  const b = sb.board();
  b.tasks[0].title = 'Renamed';
  sb.setBoard(b);
  sb.render();
  git('add', '-A');
  assert.equal(check().status, 0, check().stderr);
});

test('pre-commit: a stale staged BOARD.md fails', () => {
  const { sb, git, check } = repo();
  const b = sb.board();
  b.tasks[0].title = 'Renamed';
  sb.setBoard(b);
  git('add', '-A');
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /out of date/);
});

test('pre-commit: tier_override and tiers.json changes need the user switch', () => {
  const { sb, git, check } = repo();
  const b = sb.board();
  b.tasks[0].tier_override = { tier: 'large', reason: 'user said so' };
  b.tasks[0].model = 'large';
  sb.setBoard(b);
  sb.render();
  git('add', '-A');
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tier_override/);
  assert.equal(check({ KANBAN_ALLOW_TIER_EDIT: '1' }).status, 0);

  git('reset', '-q', '--hard');
  sb.write('docs/kanban/tiers.json', JSON.stringify({ tiers: { large: ['*'], medium: ['*'], small: ['*'] } }));
  git('add', '-A');
  assert.match(check().stderr, /tiers\.json/);
});
