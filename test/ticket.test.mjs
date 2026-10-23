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

// ---------- 0.8: create, groom, edit, status, grooming note edits, stamps, claims ----------

const C = ['--agent', 'claude-large', '--model', OPUS];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

test('create: next free ID per type in the width the board uses; refuses a used ID', () => {
  const sb = sandbox();
  let r = sb.ticket(['create', 'task', '--title', 'New', '--parent', 'STORY-001', '--points', '1', '--description', 'Why', ...C]);
  assert.equal(r.status, 0, r.stderr);
  const t = sb.task('TASK-003');
  assert.equal(t.status, 'BACKLOG');
  assert.equal(t.model, 'small');
  assert.equal(t.description, 'Why');
  assert.match(t.created_at, ISO);
  assert.equal(t.updated_at, t.created_at);
  assert.deepEqual(t.last_actor, { name: 'claude-large', role: 'coordinator', model: OPUS, tier: 'large' });
  assert.deepEqual(t.claims, []);
  assert.ok(sb.task('STORY-001').children.includes('TASK-003'));

  const b = sb.board();
  b.bugs = [{ id: 'BUG-0053', title: 'Old bug', status: 'BACKLOG' }];
  sb.setBoard(b);
  assert.equal(sb.ticket(['create', 'bug', '--title', 'Next bug', ...C]).status, 0);
  assert.ok(sb.task('BUG-0054'));
  assert.equal(sb.ticket(['create', 'chore', '--title', 'First chore', ...C]).status, 0);
  assert.ok(sb.task('CHORE-001'));

  r = sb.ticket(['create', 'TASK-001', '--title', 'Dup', '--parent', 'STORY-001', ...C]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already used/);
  assert.equal(sb.ticket(['create', 'TASK-2031', '--title', 'Explicit', '--parent', 'STORY-001', ...C]).status, 0);
  assert.match(sb.ticket(['create', 'task', '--title', 'Orphan', ...C]).stderr, /needs --parent/);
  assert.match(sb.ticket(['create', 'chore', '--title', 'X', '--points', '4', ...C]).stderr, /points must be one of/);
  assert.match(sb.ticket(['create', 'chore', '--title', 'X', '--agent', 'w', '--model', SONNET]).stderr, /tier "large"/);
});

test('groom: sets fields and the rule tier; BACKLOG moves to TODO only when groomed', () => {
  const sb = sandbox();
  sb.ticket(['create', 'chore', '--title', 'Bump', ...C]);
  let r = sb.ticket(['groom', 'CHORE-001', '--points', '2', '--file', 'package.json', ...C]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stays in BACKLOG/);
  assert.match(r.stdout, /acceptance criteria are empty/);
  assert.equal(sb.task('CHORE-001').status, 'BACKLOG');

  r = sb.ticket(['groom', 'CHORE-001', '--acceptance', 'version is 0.8.0', '--acceptance', 'tests pass', '--verify-cmd', 'npm test', '--text', 'Approach: bump.', ...C]);
  assert.equal(r.status, 0, r.stderr);
  let t = sb.task('CHORE-001');
  assert.equal(t.status, 'TODO');
  assert.equal(t.model, 'medium');
  assert.deepEqual(t.acceptance, ['version is 0.8.0', 'tests pass']);
  assert.deepEqual(t.handovers, ['CHORE-001']);
  assert.match(sb.read('docs/kanban/handovers/CHORE-001.md'), /^## GROOMING · \S+ · claude-large \(claude-opus-5-5\)$/m);

  sb.write('groom.json', JSON.stringify({ points: 1, context: { symbols: ['version'] } }));
  assert.equal(sb.ticket(['groom', 'CHORE-001', '--json', 'groom.json', ...C]).status, 0);
  t = sb.task('CHORE-001');
  assert.equal(t.model, 'small');
  assert.deepEqual(t.context, { files: ['package.json'], symbols: ['version'], entry_points: [], codegraph_queries: [] });

  sb.write('bad.json', JSON.stringify({ status: 'DONE' }));
  assert.match(sb.ticket(['groom', 'CHORE-001', '--json', 'bad.json', ...C]).stderr, /change "status" with edit/);
  assert.match(sb.ticket(['groom', 'CHORE-001', '--requires', 'TASK-404', ...C]).stderr, /not on the board/);
  assert.equal(sb.ticket(['groom', 'CHORE-001', '--points', '2', '--agent', 'w', '--model', SONNET]).status, 1);
  sb.ticket(['claim', 'TASK-001', '--worker', 'w', '--model', SONNET]);
  assert.match(sb.ticket(['groom', 'TASK-001', '--points', '5', ...C]).stderr, /belongs to its worker/);
});

test('edit: any non-state field, with --reason, logged in an AMEND entry', () => {
  const sb = sandbox();
  assert.match(sb.ticket(['edit', 'TASK-001', '--set', 'title=Renamed', ...C]).stderr, /needs --reason/);
  const r = sb.ticket(['edit', 'TASK-001', '--set', 'title=Renamed task', '--set', 'points=1', '--set', 'context.files=["src/b.js"]', '--reason', 'user asked', ...C]);
  assert.equal(r.status, 0, r.stderr);
  const t = sb.task('TASK-001');
  assert.equal(t.title, 'Renamed task');
  assert.equal(t.points, 1);
  assert.equal(t.model, 'small');
  assert.deepEqual(t.context.files, ['src/b.js']);
  const note = sb.read('docs/kanban/handovers/TASK-001.md');
  assert.match(note, /^## AMEND · \S+ · claude-large \(claude-opus-5-5\) · EDITED$/m);
  assert.match(note, /`title`: "Medium task" → "Renamed task"/);
  assert.match(note, /\*\*Reason:\*\* user asked/);
  for (const set of ['status=DONE', 'model=large', 'tier_override={"tier":"large","reason":"x"}', 'updated_at=2020-01-01T00:00:00Z', 'assignee=me', 'claims=[]']) {
    assert.match(sb.ticket(['edit', 'TASK-001', '--set', set, '--reason', 'x', ...C]).stderr, /edit does not change/, set);
  }
});

test('status: coordinator moves; ABANDONED needs --reason; other moves name their command', () => {
  const sb = sandbox();
  assert.match(sb.ticket(['status', 'TASK-002', '--to', 'ABANDONED', ...C]).stderr, /needs --reason/);
  const r = sb.ticket(['status', 'TASK-002', '--to', 'ABANDONED', '--reason', 'not needed', ...C]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sb.task('TASK-002').status, 'ABANDONED');
  assert.match(sb.read('docs/kanban/handovers/TASK-002.md'), /^## AMEND · \S+ · claude-large \(claude-opus-5-5\) · ABANDONED$/m);
  assert.match(sb.ticket(['status', 'TASK-001', '--to', 'DONE', ...C]).stderr, /review --outcome DONE/);
  assert.match(sb.ticket(['status', 'TASK-001', '--to', 'IN_PROGRESS', ...C]).stderr, /claim/);
  assert.equal(sb.ticket(['status', 'TASK-001', '--to', 'BACKLOG', ...C]).status, 0);
  assert.equal(sb.ticket(['status', 'TASK-001', '--to', 'TODO', ...C]).status, 0);

  sb.ticket(['claim', 'TASK-001', '--worker', 'w', '--model', SONNET]);
  assert.match(sb.ticket(['status', 'TASK-001', '--to', 'TODO', ...C]).stderr, /hands it over first/);
  sb.ticket(['handover', 'TASK-001', '--status', 'BLOCKED', '--reason', 'no key', '--text', 'x']);
  assert.equal(sb.ticket(['status', 'TASK-001', '--to', 'TODO', '--reason', 'key added', ...C]).status, 0);
  assert.equal(sb.task('TASK-001').blocked_reason, null);

  const b = sb.board();
  b.epics = [{ id: 'EPIC-001', title: 'Epic', status: 'TODO', points: 8, children: ['STORY-001'], handovers: [] }];
  b.stories[0].parent = 'EPIC-001';
  sb.setBoard(b);
  assert.match(sb.ticket(['status', 'EPIC-001', '--to', 'DONE', ...C]).stderr, /STORY-001 \(TODO\)/);
});

test('note --edit/--delete rewrite a GROOMING entry and keep the old text in an AMEND entry', () => {
  const sb = sandbox();
  sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', ...C, '--text', 'Second approach.']);
  let r = sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--edit', '1', '--text', 'Approach, fixed.', ...C]);
  assert.equal(r.status, 0, r.stderr);
  let note = sb.read('docs/kanban/handovers/TASK-001.md');
  assert.match(note, /^## GROOMING · 2026-10-01T00:00:00Z · claude-large \(claude-opus-5-5\)\n\nApproach, fixed\.\n/m);
  assert.match(note, /^## AMEND · \S+ · claude-large \(claude-opus-5-5\) · EDITED\n\nGROOMING entry 1 [^\n]*was edited\.[\s\S]*^> Approach\.$/m);

  assert.match(sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--delete', '2', ...C]).stderr, /--delete needs --reason/);
  r = sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--delete', '2', '--reason', 'duplicate', ...C]);
  assert.equal(r.status, 0, r.stderr);
  note = sb.read('docs/kanban/handovers/TASK-001.md');
  assert.match(note, /^## GROOMING \(DELETED\) · \S+ · claude-large \(claude-opus-5-5\)\n\n\*Removed: duplicate\./m);
  assert.match(note, /· DELETED\n\nGROOMING entry 2 [^\n]*was deleted\.\n\n\*\*Reason:\*\* duplicate[\s\S]*^> Second approach\.$/m);
  assert.doesNotMatch(note.split('(DELETED)')[1].split('## AMEND')[0], /Second approach/);
  assert.match(sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--edit', '2', '--text', 'x', ...C]).stderr, /already deleted/);
  assert.match(sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--edit', '3', '--text', 'x', ...C]).stderr, /takes 1\.\.2/);
  assert.match(sb.ticket(['show', 'TASK-001']).stdout, /1\. GROOMING · 2026-10-01T00:00:00Z[^\n]*Approach, fixed\.\n\s+2\. GROOMING \(DELETED\)/);

  // The only live GROOMING entry of a TODO ticket cannot go: the board would not validate.
  const before = sb.read('docs/kanban/handovers/TASK-001.md');
  r = sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--delete', '1', '--reason', 'x', ...C]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing was changed/);
  assert.equal(sb.read('docs/kanban/handovers/TASK-001.md'), before);
});

test('every write stamps the ticket; claim, handover, and recover keep the claims history', () => {
  const sb = sandbox();
  sb.ticket(['claim', 'TASK-001', '--worker', 'claude-medium', '--model', SONNET]);
  let t = sb.task('TASK-001');
  assert.deepEqual(t.last_actor, { name: 'claude-medium', role: 'worker', model: SONNET, tier: 'medium' });
  assert.match(t.updated_at, ISO);
  assert.deepEqual(t.claims, [{ worker: 'claude-medium', model: SONNET, tier: 'medium', claimed_at: t.claimed_at, released_at: null, outcome: null }]);

  sb.ticket(['note', 'STORY-001', '--type', 'FLAG', '--from', 'TASK-001', '--agent', 'claude-medium', '--summary', 's', '--text', 'f']);
  assert.deepEqual(sb.task('STORY-001').last_actor, { name: 'claude-medium', role: 'worker', model: SONNET, tier: 'medium' });

  sb.ticket(['handover', 'TASK-001', '--status', 'PAUSED', '--text', 'later']);
  t = sb.task('TASK-001');
  assert.equal(t.claims[0].outcome, 'PAUSED');
  assert.match(t.claims[0].released_at, ISO);

  sb.ticket(['claim', 'TASK-001', '--worker', 'w2', '--model', SONNET]);
  assert.equal(sb.ticket(['recover', 'TASK-001', '--coordinator', 'claude-large', '--model', OPUS]).status, 0);
  t = sb.task('TASK-001');
  assert.equal(t.claims.length, 2);
  assert.equal(t.claims[1].outcome, 'PAUSED');
  assert.deepEqual(t.last_actor, { name: 'claude-large', role: 'coordinator', model: OPUS, tier: 'large' });
  assert.match(sb.read('docs/kanban/BOARD.md'), /\| Updated \(UTC\) \| Last actor \|/);
  assert.match(sb.read('docs/kanban/BOARD.md'), /claude-large \(coordinator, large, claude-opus-5-5\)/);
});

test('render-board rejects malformed stamps and claims', () => {
  const sb = sandbox();
  const base = sb.board();
  const bad = [
    { updated_at: '23.10.2026' },
    { created_at: '2026-10-23T15:52:42+02:00' },
    { last_actor: { name: 'x', role: 'boss', model: 'm', tier: null } },
    { last_actor: { name: 'x', role: 'worker', model: 'm', tier: 'huge' } },
    { claims: [{ worker: 'w', model: 'm', tier: 'medium', claimed_at: '2026-10-23T00:00:00Z', released_at: null, outcome: null }] },
    { claims: [{ worker: 'w', model: 'm', tier: 'medium', claimed_at: 'yesterday', released_at: '2026-10-23T00:00:00Z', outcome: 'PAUSED' }] },
  ];
  for (const patch of bad) {
    const b = structuredClone(base);
    Object.assign(b.tasks[0], patch);
    sb.setBoard(b);
    assert.equal(sb.render(['--check']).status, 1, JSON.stringify(patch));
  }
});

test('the coordinator may claim a 1 point chore itself, and only that', () => {
  const sb = sandbox();
  for (const pts of ['1', '2']) sb.ticket(['create', 'chore', '--title', `Chore ${pts}`, '--points', pts, ...C]);
  for (const id of ['CHORE-001', 'CHORE-002']) {
    const r = sb.ticket(['groom', id, '--file', 'package.json', '--acceptance', 'done', '--verify-cmd', 'node -e 0', '--text', 'Run the script.', ...C]);
    assert.equal(sb.task(id).status, 'TODO', r.stdout + r.stderr);
  }
  assert.match(sb.ticket(['claim', 'CHORE-002', '--worker', 'claude-large', '--model', OPUS]).stderr, /listed for large/);
  const r = sb.ticket(['claim', 'CHORE-001', '--worker', 'claude-large', '--model', OPUS]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /runs this 1 point chore itself/);
  assert.doesNotMatch(r.stderr, /not listed/);
  const t = sb.task('CHORE-001');
  assert.equal(t.last_actor.role, 'coordinator');
  assert.equal(t.claims[0].tier, 'large');
});
