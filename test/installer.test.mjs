import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REPO } from './helpers.mjs';

test('upgrade backfills created_at, updated_at, last_actor, and claims on a 0.7 board', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-install-'));
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  const installer = (...a) => spawnSync(process.execPath, [path.join(REPO, 'bin/scrum-kanban.mjs'), ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  assert.equal(installer('init', '--no-codegraph', '--no-ci').status, 0);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /docs\/kanban\/\.script-writes\.json/);
  assert.ok(fs.existsSync(path.join(dir, 'docs/kanban/.script-writes.json')), 'init records the board files it wrote');

  const file = path.join(dir, 'docs/kanban/board.json');
  const board = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = { requires: [], context: { files: ['a.js'] }, acceptance: ['ok'], verify_cmd: 'node -e 0', tier_override: null, blocked_reason: null };
  board.stories = [{ ...base, id: 'STORY-001', title: 'S', status: 'BACKLOG', points: 5, model: 'large', handovers: ['STORY-001'] }];
  board.tasks = [
    { ...base, id: 'TASK-001', title: 'A', status: 'IN_PROGRESS', points: 3, parent: 'STORY-001', model: 'medium', assignee: 'claude-medium', claimed_at: '2026-10-02T09:00:00Z', worker_model: 'claude-sonnet-5-5', handovers: ['TASK-001'] },
    { ...base, id: 'TASK-002', title: 'B', status: 'BACKLOG', points: 2, parent: 'STORY-001', model: null, handovers: [] },
  ];
  fs.writeFileSync(file, JSON.stringify(board, null, 2));
  const notes = path.join(dir, 'docs/kanban/handovers');
  fs.writeFileSync(path.join(notes, 'STORY-001.md'), '# STORY-001\n\n## GROOMING Commit-dated\n\nNo dated header.\n');
  fs.writeFileSync(path.join(notes, 'TASK-001.md'), '# TASK-001\n\n## GROOMING · 2026-10-01T08:00:00Z · claude-large (claude-opus-5-5)\n\nA.\n\n## FLAG · 2026-10-03T10:00:00Z · from TASK-009 · w\n\nB.\n');
  git('add', '-A');
  git('commit', '-qm', 'old board', '--no-verify');

  const r = installer('upgrade');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const [t1, t2] = after.tasks;
  assert.equal(t1.created_at, '2026-10-01T08:00:00Z');
  assert.equal(t1.updated_at, '2026-10-03T10:00:00Z');
  assert.deepEqual(t1.last_actor, { name: 'claude-large', role: 'coordinator', model: 'claude-opus-5-5', tier: 'large' });
  assert.deepEqual(t1.claims, [{ worker: 'claude-medium', model: 'claude-sonnet-5-5', tier: 'medium', claimed_at: '2026-10-02T09:00:00Z', released_at: null, outcome: null }]);
  assert.deepEqual([t2.created_at, t2.updated_at, t2.last_actor, t2.claims], [null, null, null, []]);
  // No dated entry: the dates come from the git history of the note.
  const s = after.stories[0];
  assert.match(s.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(s.created_at, s.updated_at);
  assert.ok('claims' in after._ticket_template && 'last_actor' in after._ticket_template);
  assert.equal(spawnSync(process.execPath, [path.join(dir, 'scripts/kanban/render-board.mjs'), '--check'], { encoding: 'utf8' }).status, 0);

  // A second upgrade changes nothing.
  const again = installer('upgrade');
  assert.doesNotMatch(again.stdout, /migrate/);
});
