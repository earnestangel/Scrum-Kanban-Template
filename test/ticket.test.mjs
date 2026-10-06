import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LUNA, OPUS, SONNET, sandbox } from './helpers.mjs';

test('claim → handover → review, with canonical headers', () => {
  const sb = sandbox();
  let r = sb.ticket(['claim', 'TASK-001', '--worker', 'claude-medium', '--model', SONNET]);
  assert.equal(r.status, 0, r.stderr);
  const t = sb.task('TASK-001');
  assert.equal(t.status, 'IN_PROGRESS');
  assert.equal(t.worker_model, SONNET);
  assert.match(t.claimed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(sb.read('docs/kanban/BOARD.md'), /medium \(claude-sonnet-5-5\)/);

  r = sb.ticket(['handover', 'TASK-001', '--status', 'REVIEW', '--body', '-'], { input: '**Files changed**\n- src/a.js\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(sb.read('docs/kanban/handovers/TASK-001.md'), /^## PROGRESS · \S+ · claude-medium \(claude-sonnet-5-5\) · REVIEW$/m);
  assert.equal(sb.task('TASK-001').assignee, null);
  assert.equal(sb.task('TASK-001').worker_model, undefined);

  r = sb.ticket(['review', 'TASK-001', '--outcome', 'DONE', '--reviewer', 'claude-large', '--model', OPUS, '--text', 'verify ok']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sb.task('TASK-001').status, 'DONE');
});

test('claim refuses a model not listed for the tier, unless KANBAN_INLINE names the ticket', () => {
  const sb = sandbox();
  let r = sb.ticket(['claim', 'TASK-001', '--worker', 'luna-medium', '--model', LUNA]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not listed/);
  assert.equal(sb.task('TASK-001').status, 'TODO');
  r = sb.ticket(['claim', 'TASK-001', '--worker', 'luna-medium', '--model', LUNA], { env: { KANBAN_INLINE: 'TASK-002' } });
  assert.equal(r.status, 1);
  r = sb.ticket(['claim', 'TASK-001', '--worker', 'luna-medium', '--model', LUNA], { env: { KANBAN_INLINE: 'TASK-001' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not listed for tier "medium"/);
});

test('claim accepts any model the user lists in tiers.json', () => {
  const sb = sandbox({ tiers: { large: ['*opus*'], medium: ['*sonnet*', '*gpt-6-luna'], small: ['*haiku*'] } });
  assert.equal(sb.ticket(['claim', 'TASK-001', '--worker', 'luna-medium', '--model', LUNA]).status, 0);
});

test('claim checks WIP and prerequisites', () => {
  const sb = sandbox();
  assert.equal(sb.ticket(['claim', 'TASK-002', '--worker', 'w', '--model', SONNET]).status, 1);
  assert.equal(sb.ticket(['claim', 'TASK-001', '--worker', 'w', '--model', SONNET]).status, 0);
  const r = sb.ticket(['claim', 'STORY-001', '--worker', 'w', '--model', OPUS]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already IN_PROGRESS/);
});

test('grooming, review, and recover need a large-tier model', () => {
  const sb = sandbox();
  assert.equal(sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--agent', 'x', '--model', SONNET, '--text', 'a']).status, 1);
  assert.equal(sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--agent', 'x', '--model', OPUS, '--text', 'a']).status, 0);
  sb.ticket(['claim', 'TASK-001', '--worker', 'w', '--model', SONNET]);
  assert.equal(sb.ticket(['recover', 'TASK-001', '--coordinator', 'c', '--model', LUNA]).status, 1);
  const r = sb.ticket(['recover', 'TASK-001', '--coordinator', 'c', '--model', OPUS]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sb.task('TASK-001').status, 'PAUSED');
  assert.match(sb.read('docs/kanban/handovers/TASK-001.md'), /Recovered from orphaned claim by `w` on claude-sonnet-5-5/);
});

test('BLOCKED needs a reason; FLAG writes the index row; review DONE removes it', () => {
  const sb = sandbox();
  sb.ticket(['claim', 'TASK-001', '--worker', 'w', '--model', SONNET]);
  assert.equal(sb.ticket(['handover', 'TASK-001', '--status', 'BLOCKED', '--text', 'x']).status, 1);
  assert.equal(sb.ticket(['note', 'STORY-001', '--type', 'FLAG', '--from', 'TASK-001', '--agent', 'w', '--summary', 'a | b', '--text', 'found']).status, 0);
  assert.match(sb.read('docs/kanban/handovers/HANDOVERS.md'), /\| `STORY-001` \| `TASK-001` \| a \\\| b \|/);
  assert.equal(sb.ticket(['handover', 'TASK-001', '--status', 'BLOCKED', '--reason', 'no key', '--text', 'x']).status, 0);
  assert.equal(sb.task('TASK-001').blocked_reason, 'no key');
  assert.match(sb.read('docs/kanban/handovers/TASK-001.md'), /^## PROGRESS · \S+ · w \(claude-sonnet-5-5\) · BLOCKED$/m);

  // The story's flag row goes when the story is closed by review.
  const b = sb.board();
  Object.assign(b.tasks[0], { status: 'DONE', blocked_reason: null });
  Object.assign(b.tasks[1], { status: 'DONE' });
  b.stories[0].status = 'REVIEW';
  sb.setBoard(b);
  for (const id of ['TASK-001', 'TASK-002']) sb.write(`docs/kanban/handovers/${id}.md`, `${sb.read(`docs/kanban/handovers/${id}.md`)}\n## REVIEW · 2026-10-06T00:00:00Z · c · DONE\n`);
  sb.write('docs/kanban/handovers/STORY-001.md', `${sb.read('docs/kanban/handovers/STORY-001.md')}\n## PROGRESS · 2026-10-06T00:00:00Z · w · REVIEW\n`);
  assert.equal(sb.render().status, 0, sb.render().stderr);
  const r = sb.ticket(['review', 'STORY-001', '--outcome', 'DONE', '--reviewer', 'c', '--model', OPUS, '--text', 'ok']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(sb.read('docs/kanban/handovers/HANDOVERS.md'), /STORY-001/);
});

test('a failed render restores every file', () => {
  const sb = sandbox();
  sb.ticket(['claim', 'TASK-001', '--worker', 'w', '--model', SONNET]);
  // Break the board outside this ticket after the last render: the story's note loses its GROOMING entry.
  sb.write('docs/kanban/handovers/STORY-001.md', '# STORY-001\n');
  const files = ['docs/kanban/board.json', 'docs/kanban/BOARD.md', 'docs/kanban/handovers/TASK-001.md'];
  const before = files.map((f) => sb.read(f));
  const r = sb.ticket(['handover', 'TASK-001', '--status', 'REVIEW', '--text', 'done']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing was changed/);
  assert.deepEqual(files.map((f) => sb.read(f)), before);
});

test('ticket.mjs never touches tier_override', () => {
  const sb = sandbox();
  const b = sb.board();
  b.tasks[0].tier_override = { tier: 'small', reason: 'user: tiny change' };
  b.tasks[0].model = 'small';
  sb.setBoard(b);
  sb.render();
  assert.equal(sb.ticket(['claim', 'TASK-001', '--worker', 'w', '--model', SONNET]).status, 1);
  assert.equal(sb.ticket(['claim', 'TASK-001', '--worker', 'claude-small', '--model', 'claude-haiku-4-5']).status, 0);
  assert.deepEqual(sb.task('TASK-001').tier_override, { tier: 'small', reason: 'user: tiny change' });
});
