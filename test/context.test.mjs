// 0.9: context transfer. Design anchor, STATE blocks, supersedes, archive, context pack, knowledge index,
// velocity, derived containers, decisions, lane order, and the migration.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import { OPUS, SONNET, STATE, sandbox } from './helpers.mjs';

const C = ['--agent', 'claude-large', '--model', OPUS];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const ok = (r) => assert.equal(r.status, 0, r.stderr + r.stdout);
const refused = (r, re) => {
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, re);
};
const NOTE = (id) => `docs/kanban/handovers/${id}.md`;
const claim = (sb, id, extra = []) => sb.ticket(['claim', id, '--worker', 'claude-medium', '--model', SONNET, ...extra]);
// Claim, hand over, and review one task to DONE.
function finish(sb, id, { progress = 'Done.\n\n**Design check**\n- Matches.', review = 'verify ok\n\n**Design**: compared, matches.' } = {}) {
  ok(claim(sb, id));
  ok(sb.ticket(['handover', id, '--status', 'REVIEW', '--text', progress]));
  ok(sb.ticket(['review', id, '--outcome', 'DONE', '--reviewer', 'claude-large', '--model', OPUS, '--text', review]));
}
// Turns the design anchor on: one source, one element implemented by TASK-001, the rest marked "na".
function anchor(sb) {
  fs.mkdirSync(sb.file('docs/design'), { recursive: true });
  sb.write('docs/design/flow.md', '# Flow\n\nA -> B\n');
  ok(sb.ticket(['design', 'docs/design/flow.md', ...C]));
  ok(sb.ticket(['element', 'new', '--title', 'A to B relay', '--source', 'docs/design/flow.md', '--ticket', 'TASK-001', ...C]));
  for (const id of ['TASK-002', 'STORY-001']) ok(sb.ticket(['groom', id, '--design-na', 'no design element: test fixture', ...C]));
}
const adrFile = (sb, name, status) => {
  fs.mkdirSync(sb.file('docs/adr'), { recursive: true });
  sb.write(`docs/adr/${name}.md`, `# ${name}\n\n| | |\n| --- | --- |\n| Status | ${status} |\n\nText.\n`);
};

// ---------- A6: derived containers, decisions, order, one-step notes ----------

test('containers: status and points follow the children; nobody sets them by hand', () => {
  const sb = sandbox();
  ok(sb.ticket(['create', 'task', '--title', 'Third', '--parent', 'STORY-001', '--points', '8', ...C]));
  // 3 + 2 + 8: a story's points are a sum, not a Fibonacci value.
  assert.equal(sb.task('STORY-001').points, 13);
  assert.equal(sb.render(['--check']).status, 0);
  ok(claim(sb, 'TASK-001'));
  assert.equal(sb.task('STORY-001').status, 'IN_PROGRESS');
  refused(sb.ticket(['groom', 'STORY-001', '--points', '21', ...C]), /its points are their sum/);
  refused(sb.ticket(['edit', 'STORY-001', '--set', 'points=21', '--reason', 'x', ...C]), /points are their sum/);
  refused(sb.ticket(['status', 'STORY-001', '--to', 'TODO', ...C]), /follows its children/);

  // A hand edit of a derived value does not validate.
  const b = sb.board();
  b.stories[0].points = 21;
  sb.setBoard(b);
  const r = sb.render(['--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /STORY-001: points are 21, but its children add up to 13/);
  b.stories[0].points = 13;
  b.stories[0].status = 'DONE';
  sb.setBoard(b);
  assert.match(sb.render(['--check']).stderr, /STORY-001: status is DONE, but its children make it IN_PROGRESS/);
});

test('close: a story closes only when every child is closed, with a Knowledge line', () => {
  const sb = sandbox();
  refused(sb.ticket(['close', 'STORY-001', '--text', 'Knowledge: none', ...C]), /TASK-001 \(TODO\)/);
  finish(sb, 'TASK-001');
  finish(sb, 'TASK-002');
  // Every child closed: the story is ready to close, and the brief says so.
  assert.equal(sb.task('STORY-001').status, 'REVIEW');
  assert.match(sb.render(['--check']).stdout, /Ready to close, after asking the user[^\n]*STORY-001/);
  assert.match(sb.read('docs/kanban/BOARD.md'), /Waiting on the user[\s\S]*`STORY-001` \| Every child is closed/);
  refused(sb.ticket(['close', 'STORY-001', '--text', 'All good.', ...C]), /needs a "Knowledge:" line/);
  refused(sb.ticket(['close', 'STORY-001', '--text', 'Knowledge: wrote gotchas.md', ...C]), /not in docs\/kanban\/KNOWLEDGE\.md/);
  refused(sb.ticket(['review', 'STORY-001', '--outcome', 'DONE', '--reviewer', 'c', '--model', OPUS, '--text', 'x']), /close it with/);
  ok(sb.ticket(['close', 'STORY-001', '--text', 'verify ok\n\n**Knowledge:** none', ...C]));
  const s = sb.task('STORY-001');
  assert.equal(s.status, 'DONE');
  assert.match(s.done_at, ISO);
  assert.equal(s.done_by, 'claude-large');
  assert.match(sb.read(NOTE('STORY-001')), /^## REVIEW · \S+ · claude-large \(claude-opus-5-5\) · DONE$/m);

  // A new open child reopens it.
  ok(sb.ticket(['create', 'task', '--title', 'Late', '--parent', 'STORY-001', '--points', '1', ...C]));
  assert.equal(sb.task('STORY-001').status, 'IN_PROGRESS');
  assert.equal(sb.task('STORY-001').done_at, null);
});

test('decisions_pending: one list of what waits on the user; it blocks the claim', () => {
  const sb = sandbox();
  refused(sb.ticket(['decision', 'new', '--question', 'Which queue?', ...C]), /needs --blocks/);
  refused(sb.ticket(['decision', 'new', '--question', 'Which queue?', '--blocks', 'TASK-404', ...C]), /not on the board/);
  ok(sb.ticket(['decision', 'new', '--question', 'Which queue: SQS or SNS?', '--blocks', 'TASK-001', ...C]));
  assert.deepEqual(sb.board().decisions_pending.map((d) => [d.id, d.blocks]), [['DEC-001', ['TASK-001']]]);
  assert.match(sb.read('docs/kanban/BOARD.md'), /## 🧑 Waiting on the user\n\| Item[^\n]*\n[^\n]*\n\| `DEC-001` \| Which queue: SQS or SNS\? \| TASK-001 \|/);
  assert.match(sb.render(['--check']).stdout, /Waiting on the user \(1\):\n\s+DEC-001: Which queue/);
  refused(claim(sb, 'TASK-001'), /decision DEC-001 waits on the user/);
  ok(sb.ticket(['decision', 'DEC-001', '--resolve', 'SQS, says the user.', ...C]));
  assert.deepEqual(sb.board().decisions_pending, []);
  assert.match(sb.read(NOTE('TASK-001')), /^## DECISION · \S+ · claude-large \(claude-opus-5-5\) · RESOLVED\n\n\*\*Question\*\* \(DEC-001[\s\S]*SQS, says the user\./m);
  ok(claim(sb, 'TASK-001'));

  // A hand-written entry without the ticket it blocks does not validate.
  const b = sb.board();
  b.decisions_pending = [{ id: 'DEC-009', question: 'x', blocks: [] }];
  sb.setBoard(b);
  assert.match(sb.render(['--check']).stderr, /DEC-009: needs "blocks"/);
});

test('order: the lowest order that can start goes first, without fake requires links', () => {
  const sb = sandbox();
  const b = sb.board();
  b.tasks[1].requires = [];
  sb.setBoard(b);
  ok(sb.ticket(['groom', 'TASK-001', '--order', '20', ...C]));
  ok(sb.ticket(['groom', 'TASK-002', '--order', '10', ...C]));
  assert.match(sb.read('docs/kanban/BOARD.md'), /## 🎯 To Do\n[^\n]*\| Order \|[^\n]*\n[^\n]*\n\| `TASK-002`[^\n]*\n\| `TASK-001`/);
  refused(claim(sb, 'TASK-001'), /is not next in the lane: TASK-002 \(order 10\)/);
  ok(claim(sb, 'TASK-001', ['--out-of-order', 'user: TASK-002 waits for a key']));
  assert.equal(sb.task('TASK-001').claims[0].out_of_order, 'user: TASK-002 waits for a key');
  refused(sb.ticket(['groom', 'TASK-002', '--order', 'soon', ...C]), /order must be a number/);
  const bad = sb.board();
  bad.tasks[1].order = 'first';
  sb.setBoard(bad);
  assert.match(sb.render(['--check']).stderr, /TASK-002: order must be a number or null/);
});

test('notes in one step: first GROOMING note of a new ticket, and a story note listed by other tickets', () => {
  const sb = sandbox();
  ok(sb.ticket(['create', 'story', '--title', 'New story', ...C]));
  // The new story has no note yet; a task can list it, and the first entry can link itself to tickets.
  ok(sb.ticket(['groom', 'TASK-002', '--handover', 'TASK-002', '--handover', 'STORY-002', ...C]));
  assert.ok(fs.existsSync(sb.file(NOTE('STORY-002'))));
  const r = sb.ticket(['note', 'STORY-002', '--type', 'GROOMING', '--text', 'Applies to both tasks.', '--link', 'TASK-001', '--link', 'TASK-002', ...C]);
  ok(r);
  assert.match(r.stdout, /Listed in the handovers of TASK-001\./);
  assert.deepEqual(sb.task('TASK-001').handovers, ['TASK-001', 'STORY-002']);
  assert.deepEqual(sb.task('STORY-002').handovers, ['STORY-002']);
  // "children" links every open ticket under the note's ticket.
  ok(sb.ticket(['note', 'STORY-001', '--type', 'FLAG', '--from', 'TASK-001', '--agent', 'w', '--summary', 's', '--text', 'f', '--link', 'children']));
  assert.ok(sb.task('TASK-002').handovers.includes('STORY-001'));
  refused(sb.ticket(['groom', 'TASK-001', '--handover', 'NOPE-001', ...C]), /not a ticket on the board/);
});

// ---------- A2: STATE and supersedes ----------

test('state: the one rewritable block; claim needs it; a story closes only after the epic STATE was refreshed', () => {
  const sb = sandbox();
  ok(sb.ticket(['create', 'epic', '--title', 'Epic', ...C]));
  ok(sb.ticket(['edit', 'STORY-001', '--set', 'parent=EPIC-001', '--reason', 'belongs there', ...C]));
  assert.equal(sb.task('EPIC-001').points, 5);
  assert.match(sb.render(['--check']).stderr, /warning: EPIC-001: its note has no STATE block/);
  refused(claim(sb, 'TASK-001'), /EPIC-001 has no STATE block/);

  refused(sb.ticket(['state', 'TASK-001', '--text', STATE, ...C]), /Only epic and story notes have a STATE block/);
  refused(sb.ticket(['state', 'EPIC-001', '--text', '**Scope**\n- x', ...C]), /needs a "\*\*Order\*\*" section/);
  refused(sb.ticket(['state', 'EPIC-001', '--text', STATE, '--agent', 'w', '--model', SONNET]), /tier "large"/);
  ok(sb.ticket(['state', 'EPIC-001', '--text', STATE, ...C]));
  ok(sb.ticket(['note', 'EPIC-001', '--type', 'GROOMING', '--text', 'History.', ...C]));
  ok(sb.ticket(['state', 'EPIC-001', '--text', STATE.replace('All of it.', 'Now with SNS.'), ...C]));
  const note = sb.read(NOTE('EPIC-001'));
  assert.equal(note.match(/^## STATE/gm).length, 1, 'the block is replaced, not appended');
  assert.ok(note.indexOf('## STATE') < note.indexOf('## GROOMING'), 'STATE stays on top');
  assert.match(note, /Now with SNS\./);
  assert.doesNotMatch(note, /All of it\./);
  assert.match(note, /History\./);

  finish(sb, 'TASK-001');
  finish(sb, 'TASK-002');
  ok(sb.ticket(['close', 'STORY-001', '--text', 'Knowledge: none', ...C]));
  // The next story under the epic needs a STATE newer than that close.
  ok(sb.ticket(['create', 'story', '--title', 'Second', '--parent', 'EPIC-001', '--points', '3', ...C]));
  ok(sb.ticket(['groom', 'STORY-002', '--file', 'a.js', '--acceptance', 'ok', '--verify-cmd', 'node -e 0', '--text', 'Plan.', ...C]));
  ok(sb.ticket(['claim', 'STORY-002', '--worker', 'claude-large', '--model', OPUS]));
  ok(sb.ticket(['handover', 'STORY-002', '--status', 'REVIEW', '--text', 'Done.']));
  const review = ['review', 'STORY-002', '--outcome', 'DONE', '--reviewer', 'claude-large', '--model', OPUS, '--text', 'ok\n\nKnowledge: none'];
  refused(sb.ticket(review), /EPIC-001 STATE is from \S+, before the last story under it closed/);
  // The clock has one-second resolution: wait so the refreshed STATE is later than the close.
  spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1100)']);
  ok(sb.ticket(['state', 'EPIC-001', '--text', STATE, ...C]));
  ok(sb.ticket(review));
});

test('note --supersedes marks the old entry and keeps it; context skips it', () => {
  const sb = sandbox();
  ok(sb.ticket(['note', 'STORY-001', '--type', 'GROOMING', '--text', 'SNS is out of scope.', ...C]));
  assert.match(sb.ticket(['show', 'STORY-001']).stdout, /All entries \(for note --supersedes STORY-001#<n>\):\s*\n\s+1\. GROOMING[^\n]*\n\s+2\. GROOMING/);
  refused(sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--text', 'x', '--supersedes', 'STORY-001#9', ...C]), /has no entry 9/);
  // Written in the task's note, it supersedes an entry of the story's note.
  ok(sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--text', 'ADR 3: SNS is in scope.', '--supersedes', 'STORY-001#2', ...C]));
  const story = sb.read(NOTE('STORY-001'));
  assert.match(story, /^## GROOMING \(SUPERSEDED\) · \S+ · claude-large \(claude-opus-5-5\)\n\n> Superseded by the entry `GROOMING · [^`]+` in handovers\/TASK-001\.md\./m);
  assert.match(story, /SNS is out of scope\./, 'nothing is deleted');
  assert.match(sb.read(NOTE('TASK-001')), /\*Supersedes STORY-001#2\.\*/);
  refused(sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--text', 'x', '--supersedes', 'STORY-001#2', ...C]), /already superseded/);
  ok(claim(sb, 'TASK-001'));
  ok(sb.ticket(['handover', 'TASK-001', '--status', 'PAUSED', '--text', 'later']));
  refused(sb.ticket(['note', 'TASK-001', '--type', 'GROOMING', '--text', 'x', '--supersedes', '3', ...C]), /Only GROOMING and FLAG entries are superseded/);

  const pack = sb.ticket(['context', 'TASK-001']).stdout;
  assert.doesNotMatch(pack, /SNS is out of scope/);
  assert.match(pack, /1 superseded or deleted entry of STORY-001 left out/);
  assert.match(pack, /ADR 3: SNS is in scope\./);
});

// ---------- A3: context pack, archive, size ----------

test('context: the whole reading pack in one bounded output', () => {
  const sb = sandbox();
  finish(sb, 'TASK-001', { progress: 'Wrote the relay. Port is 4477.' });
  ok(sb.ticket(['note', 'TASK-002', '--type', 'FLAG', '--from', 'TASK-001', '--agent', 'w', '--summary', 's', '--text', 'The relay has no retry.']));
  const pack = sb.ticket(['context', 'TASK-002']).stdout;
  const order = ['# Context pack: TASK-002', '## Ticket', '"verify_cmd": "node -e 0"', '## STORY-001 STATE', '**Decisions in force**', '## Notes', 'Approach.', 'The relay has no retry.', '## Requires', 'TASK-001 (DONE): last PROGRESS entry', 'Port is 4477.'];
  let at = -1;
  for (const part of order) {
    const next = pack.indexOf(part, at + 1);
    assert.ok(next > at, `"${part}" is missing or out of order`);
    at = next;
  }
  // Bounded: the oldest inherited entries go first, and the pack says so.
  for (let i = 0; i < 6; i++) ok(sb.ticket(['note', 'STORY-001', '--type', 'GROOMING', '--text', `Entry ${i}. ${'x'.repeat(900)}`, ...C]));
  const small = sb.ticket(['context', 'TASK-002', '--max-chars', '4000']).stdout;
  assert.ok(small.length < 4400, `${small.length} characters`);
  assert.match(small, /older entr(y|ies) of STORY-001 left out to fit the size limit/);
  assert.match(small, /The relay has no retry\./, 'the ticket\'s own entries stay');
});

test('archive: closed children of a DONE story move to the archive; a stub stays; IDs stay taken', () => {
  const sb = sandbox();
  ok(sb.ticket(['create', 'task', '--title', 'Later', '--parent', 'STORY-001', '--points', '1', ...C]));
  finish(sb, 'TASK-001');
  finish(sb, 'TASK-002');
  refused(sb.ticket(['archive', 'STORY-001', ...C]), /only the children of a DONE story are archived/);
  ok(sb.ticket(['status', 'TASK-003', '--to', 'ABANDONED', '--reason', 'not needed', ...C]));
  ok(sb.ticket(['close', 'STORY-001', '--text', 'Knowledge: none', ...C]));
  refused(sb.ticket(['archive', 'STORY-001', ...C]), /has no Digest/);
  const digest = (n) => `${STATE}\n\n**Digest**\n${Array.from({ length: n }, (_, i) => `- Fact ${i}.`).join('\n')}`;
  refused(sb.ticket(['state', 'STORY-001', '--text', digest(41), ...C]), /Digest is 41 lines; keep it to 40/);
  ok(sb.ticket(['state', 'STORY-001', '--text', digest(3), ...C]));
  const before = fs.statSync(sb.file('docs/kanban/board.json')).size;
  const r = sb.ticket(['archive', 'STORY-001', ...C]);
  ok(r);
  assert.match(r.stdout, /3 tickets archived \(TASK-001, TASK-002, TASK-003\)/);
  assert.ok(fs.statSync(sb.file('docs/kanban/board.json')).size < before);

  const stub = sb.task('TASK-001');
  assert.deepEqual([stub.archived, stub.status, stub.points, stub.parent, stub.title], [true, 'DONE', 3, 'STORY-001', 'Medium task']);
  assert.match(stub.done_at, ISO);
  assert.equal(stub.context, undefined);
  const archive = JSON.parse(sb.read('docs/kanban/board-archive.json'));
  assert.deepEqual(archive.tasks.map((t) => t.id), ['TASK-001', 'TASK-002', 'TASK-003']);
  assert.deepEqual(archive.tasks[0].acceptance, ['works']);
  assert.ok(!fs.existsSync(sb.file(NOTE('TASK-001'))));
  assert.match(sb.read('docs/kanban/handovers/archive/TASK-001.md'), /## REVIEW · \S+ · claude-large/);
  assert.equal(sb.render(['--check']).status, 0);
  assert.equal(sb.task('STORY-001').points, 5, 'the story still sums its archived children');

  // IDs span the archive; an archived ticket does not change; show and context still read it.
  refused(sb.ticket(['create', 'TASK-001', '--title', 'Again', '--parent', 'STORY-001', ...C]), /already used on the board or in the archive/);
  ok(sb.ticket(['create', 'task', '--title', 'Next', '--parent', 'STORY-001', ...C]));
  assert.ok(sb.task('TASK-004'));
  refused(sb.ticket(['edit', 'TASK-001', '--set', 'title=x', '--reason', 'r', ...C]), /is archived/);
  assert.match(sb.ticket(['show', 'TASK-001']).stdout, /"acceptance": \[\s+"works"/);
  assert.match(sb.ticket(['context', 'TASK-002']).stdout, /TASK-001 \(DONE\): last PROGRESS entry\n\n[^\n]+\n\nDone\./);

  // A stub without its archive record, or an archive record without a stub, does not validate.
  const b = sb.board();
  b.tasks = b.tasks.filter((t) => t.id !== 'TASK-002');
  sb.setBoard(b);
  assert.match(sb.render(['--check']).stderr, /board-archive\.json: TASK-002 has no stub on the board/);
});

test('size: a board past the limit gets a warning that names what to archive', () => {
  const sb = sandbox();
  finish(sb, 'TASK-001');
  finish(sb, 'TASK-002');
  ok(sb.ticket(['close', 'STORY-001', '--text', 'Knowledge: none', ...C]));
  const b = sb.board();
  b.size_limit_kb = 1;
  sb.setBoard(b);
  assert.match(sb.render().stderr, /warning: board\.json is \d+ KB \(limit 1 KB\)\. Archive closed stories with ticket\.mjs archive <STORY>: STORY-001/);
});

// ---------- A4: knowledge ----------

test('knowledge: every finding has a line in KNOWLEDGE.md; a story review names findings or "none"', () => {
  const sb = sandbox();
  fs.mkdirSync(sb.file('docs/findings'), { recursive: true });
  sb.write('docs/findings/2026-11-01-apply-paths.md', '# Apply paths\n\nUse SSO.\n');
  const r = sb.render(['--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /KNOWLEDGE\.md: docs\/findings\/2026-11-01-apply-paths\.md has no line/);
  refused(sb.ticket(['finding', 'README.md', '--summary', 'x', '--agent', 'w']), /not a \.md file under docs\/findings\//);
  refused(sb.ticket(['finding', 'docs/findings/nope.md', '--summary', 'x', '--agent', 'w']), /does not exist/);
  ok(sb.ticket(['finding', 'docs/findings/2026-11-01-apply-paths.md', '--summary', 'Infra applies run from a laptop over SSO', '--agent', 'claude-medium']));
  assert.match(sb.read('docs/kanban/KNOWLEDGE.md'), /^- \[2026-11-01-apply-paths\.md\]\(\.\.\/findings\/2026-11-01-apply-paths\.md\): Infra applies run from a laptop over SSO$/m);
  // The index is part of the context pack.
  assert.match(sb.ticket(['context', 'TASK-001']).stdout, /## Knowledge index[\s\S]*Infra applies run from a laptop over SSO/);
  // Indexing it again replaces the line.
  ok(sb.ticket(['finding', 'docs/findings/2026-11-01-apply-paths.md', '--summary', 'New summary', '--agent', 'w']));
  assert.equal(sb.read('docs/kanban/KNOWLEDGE.md').match(/apply-paths\.md\]/g).length, 1);

  finish(sb, 'TASK-001');
  finish(sb, 'TASK-002');
  ok(sb.ticket(['close', 'STORY-001', '--text', 'Knowledge: 2026-11-01-apply-paths.md', ...C]));
  // A dead link in the index does not validate.
  fs.rmSync(sb.file('docs/findings/2026-11-01-apply-paths.md'));
  assert.match(sb.render(['--check']).stderr, /KNOWLEDGE\.md: links \.\.\/findings\/2026-11-01-apply-paths\.md, which does not exist/);
});

// ---------- A5: velocity ----------

test('velocity: started_at, done_at, done_by, rework_count persist; stats and BOARD.md report them', () => {
  const sb = sandbox();
  ok(claim(sb, 'TASK-001'));
  const started = sb.task('TASK-001').started_at;
  assert.match(started, ISO);
  ok(sb.ticket(['handover', 'TASK-001', '--status', 'REVIEW', '--text', 'Done.']));
  let t = sb.task('TASK-001');
  // The claim fields are cleared; who delivered it stays.
  assert.deepEqual([t.assignee, t.claimed_at, t.done_by, t.done_by_model], [null, null, 'claude-medium', SONNET]);
  ok(sb.ticket(['review', 'TASK-001', '--outcome', 'REWORK', '--reviewer', 'claude-large', '--model', OPUS, '--text', 'Fix x.']));
  assert.equal(sb.task('TASK-001').rework_count, 1);
  ok(sb.ticket(['claim', 'TASK-001', '--worker', 'claude-medium-2', '--model', SONNET]));
  ok(sb.ticket(['handover', 'TASK-001', '--status', 'REVIEW', '--text', 'Fixed.']));
  ok(sb.ticket(['review', 'TASK-001', '--outcome', 'DONE', '--reviewer', 'claude-large', '--model', OPUS, '--text', 'ok']));
  t = sb.task('TASK-001');
  assert.equal(t.started_at, started, 'the first claim stays the start');
  assert.match(t.done_at, ISO);
  assert.deepEqual([t.done_by, t.rework_count], ['claude-medium-2', 1]);
  for (const set of ['done_at=2020-01-01T00:00:00Z', 'started_at=null', 'done_by=me', 'rework_count=0']) {
    assert.match(sb.ticket(['edit', 'TASK-001', '--set', set, '--reason', 'x', ...C]).stderr, /edit does not change/, set);
  }

  const stats = JSON.parse(sb.ticket(['stats', '--json']).stdout);
  assert.deepEqual([stats.all.tickets, stats.all.points, stats.all.reworked, stats.all.rework_rate, stats.all.cycle_measured], [1, 3, 1, 100, 1]);
  assert.equal(stats.by_tier.medium.points, 3);
  assert.equal(stats.by_tier.small.tickets, 0);
  assert.equal(typeof stats.all.cycle_hours_median, 'number');
  assert.match(sb.ticket(['stats']).stdout, /tier\s+tickets\s+points\s+points\/day\s+median cycle \(h\)\s+rework rate\nall\s+1\s+3\s/);
  assert.match(sb.read('docs/kanban/BOARD.md'), /## 📈 Velocity\n\| Tier \| Tickets done \| Points \|[^\n]*\n[^\n]*\n\| all \| 1 \| 3 \|/);
  assert.match(sb.read('docs/kanban/BOARD.md'), /## ✅ Done\n[^\n]*Delivered by[^\n]*\n[^\n]*\n\| `TASK-001`[^\n]*claude-medium-2 \(claude-sonnet-5-5\)/);
  const b = sb.board();
  b.tasks[0].done_at = 'yesterday';
  sb.setBoard(b);
  assert.match(sb.render(['--check']).stderr, /TASK-001: done_at "yesterday" is not ISO 8601 UTC/);
});

// ---------- A1: design anchor ----------

test('design anchor is off until a source is declared; then tickets need a design link', () => {
  const sb = sandbox();
  assert.match(sb.read('docs/kanban/BOARD.md'), /## 🧭 Design coverage\n\*Off\./);
  // Off: no Design check section is asked for.
  finish(sb, 'TASK-001', { progress: 'Done.', review: 'ok' });

  refused(sb.ticket(['design', 'docs/design/flow.md', ...C]), /does not exist\. Export the design into the repository/);
  refused(sb.ticket(['design', '../outside.md', ...C]), /outside the repository/);
  fs.mkdirSync(sb.file('docs/design'), { recursive: true });
  sb.write('docs/design/flow.md', '# Flow\n\nA -> B\n');
  const r = sb.ticket(['design', 'docs/design/flow.md', ...C]);
  ok(r);
  // Turning it on marks the tickets groomed before it. They do not break the board, but they cannot start.
  assert.match(r.stdout, /The design anchor is on[^\n]*TASK-002/);
  assert.match(sb.board().design_sources[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(sb.task('TASK-002').design.pending, true);
  refused(claim(sb, 'TASK-002'), /it has no design link yet/);

  // A new ticket cannot enter TODO without a design link.
  ok(sb.ticket(['create', 'chore', '--title', 'Bump', '--points', '2', ...C]));
  const groom = ['groom', 'CHORE-001', '--file', 'package.json', '--acceptance', 'ok', '--verify-cmd', 'node -e 0', '--text', 'Plan.', ...C];
  assert.match(sb.ticket(groom).stdout, /stays in BACKLOG[\s\S]*no design link: set design\.refs/);
  refused(sb.ticket(['groom', 'CHORE-001', '--design-ref', 'D-404', ...C]), /D-404 is not in docs\/kanban\/design\.json/);
  refused(sb.ticket(['groom', 'CHORE-001', '--design-na', ' ', ...C]), /needs the reason/);
  ok(sb.ticket(['groom', 'CHORE-001', '--design-na', 'tooling only', ...C]));
  assert.equal(sb.task('CHORE-001').status, 'TODO');
  // A hand-made TODO ticket without the link does not validate.
  const b = sb.board();
  delete b.chores[0].design;
  sb.setBoard(b);
  assert.match(sb.render(['--check']).stderr, /CHORE-001: no design link/);
});

test('design ledger: a row needs a ticket or an accepted ADR; BOARD.md shows coverage', () => {
  const sb = sandbox();
  anchor(sb);
  assert.deepEqual(sb.task('TASK-001').design, { refs: ['D-001'] });
  assert.match(sb.read('docs/kanban/BOARD.md'), /1 elements from 1 source: 1 planned, 0 built, 0 deferred, 0 deviated\.\n\n\| Element[^\n]*\n[^\n]*\n\| `D-001` \| A to B relay \| planned \| docs\/design\/flow\.md \| TASK-001 \| — \|/);

  refused(sb.ticket(['element', 'new', '--title', 'Orphan', '--source', 'docs/design/flow.md', ...C]), /D-002: is planned with no ticket and no ADR/);
  refused(sb.ticket(['element', 'new', '--title', 'Elsewhere', '--source', 'docs/other.md', '--ticket', 'TASK-002', ...C]), /source "docs\/other\.md" is not in board\.json "design_sources"/);
  // Deviation gate: deferred or deviated needs an ADR whose status is Accepted.
  refused(sb.ticket(['element', 'new', '--title', 'Watchdog', '--source', 'docs/design/flow.md', '--state', 'deferred', ...C]), /is deferred without an ADR/);
  adrFile(sb, '0001-defer-watchdog', 'Proposed');
  refused(sb.ticket(['element', 'new', '--title', 'Watchdog', '--source', 'docs/design/flow.md', '--state', 'deferred', '--adr', '0001', ...C]), /ADR 0001 is "Proposed", not accepted/);
  adrFile(sb, '0001-defer-watchdog', 'Accepted for Phase 0');
  ok(sb.ticket(['element', 'new', '--title', 'Watchdog', '--source', 'docs/design/flow.md', '--state', 'deferred', '--adr', 'ADR-0001', ...C]));

  // The element becomes built when its tickets are done; the worker and the reviewer both check the design.
  ok(claim(sb, 'TASK-001'));
  refused(sb.ticket(['handover', 'TASK-001', '--status', 'REVIEW', '--text', 'Done.']), /needs a "\*\*Design check\*\*" section/);
  ok(sb.ticket(['handover', 'TASK-001', '--status', 'PAUSED', '--text', 'No section needed to pause.']));
  ok(claim(sb, 'TASK-001'));
  ok(sb.ticket(['handover', 'TASK-001', '--status', 'REVIEW', '--text', 'Done.\n\n**Design check**\n- D-001: relay goes A to B, as drawn.']));
  const review = (text) => sb.ticket(['review', 'TASK-001', '--outcome', 'DONE', '--reviewer', 'claude-large', '--model', OPUS, '--text', text]);
  refused(review('verify ok'), /needs a "\*\*Design\*\*" line/);
  ok(review('verify ok\n\n**Design**: D-001 compared with docs/design/flow.md, matches.'));
  assert.equal(JSON.parse(sb.read('docs/kanban/design.json')).elements[0].state, 'built');
  assert.match(sb.read('docs/kanban/BOARD.md'), /0 planned, 1 built, 1 deferred, 0 deviated/);

  // By hand: "built" with an open ticket does not validate.
  ok(sb.ticket(['element', 'new', '--title', 'B side', '--source', 'docs/design/flow.md', '--ticket', 'TASK-002', ...C]));
  const ledger = JSON.parse(sb.read('docs/kanban/design.json'));
  ledger.elements[2].state = 'built';
  sb.write('docs/kanban/design.json', JSON.stringify(ledger));
  assert.match(sb.render(['--check']).stderr, /D-003: is built, but TASK-002 \(TODO\) is not closed/);
});

test('ADR gate: a ticket that depends on an ADR is claimed only after the user accepted it', () => {
  const sb = sandbox();
  adrFile(sb, '0007-console-first', 'Proposed');
  refused(sb.ticket(['groom', 'TASK-001', '--adr', '0099', ...C]), /no file in docs\/adr\/ matches "0099"/);
  ok(sb.ticket(['groom', 'TASK-001', '--adr', '0007', ...C]));
  refused(claim(sb, 'TASK-001'), /docs\/adr\/0007-console-first\.md is "Proposed", not accepted\. Only the user accepts an ADR/);
  assert.match(sb.render(['--check']).stdout, /ADRs not accepted[^\n]*\n\s+docs\/adr\/0007-console-first\.md \(Proposed\): TASK-001/);
  assert.match(sb.read('docs/kanban/BOARD.md'), /\| ADR 0007 \| Accept or reject docs\/adr\/0007-console-first\.md \(status: Proposed\) \| TASK-001 \|/);
  adrFile(sb, '0007-console-first', 'Accepted');
  ok(claim(sb, 'TASK-001'));

  // The folder and the status line are configurable.
  const sb2 = sandbox();
  const b = sb2.board();
  b.adr = { dir: 'decisions', status_pattern: '^State=(\\w+)', accepted: ['approved'] };
  sb2.setBoard(b);
  fs.mkdirSync(sb2.file('decisions'));
  sb2.write('decisions/ADR-12-queues.md', '# Queues\nState=Draft\n');
  ok(sb2.ticket(['groom', 'TASK-001', '--adr', 'ADR-12', ...C]));
  refused(claim(sb2, 'TASK-001'), /decisions\/ADR-12-queues\.md is "Draft"/);
  sb2.write('decisions/ADR-12-queues.md', '# Queues\nState=Approved\n');
  ok(claim(sb2, 'TASK-001'));
});

test('source change alarm: a changed design file lists the tickets to regroom; a command re-records the hash', () => {
  const sb = sandbox();
  anchor(sb);
  sb.write('docs/design/flow.md', '# Flow\n\nA -> B -> C\n');
  // Session start, pre-commit, and CI fail and name the tickets.
  const r = sb.render(['--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: design source docs\/design\/flow\.md changed since its hash was recorded\. Open tickets that reference it need regrooming: TASK-001\./);
  // The board still works for a worker (a warning), but the ticket that implements the changed design cannot start.
  refused(claim(sb, 'TASK-001'), /design source docs\/design\/flow\.md \(element D-001\) changed since its hash was recorded/);
  ok(sb.ticket(['note', 'TASK-002', '--type', 'GROOMING', '--text', 'Still works while the design is being re-recorded.', ...C]));

  const rec = sb.ticket(['design', 'all', ...C]);
  ok(rec);
  assert.match(rec.stdout, /changed and was re-recorded[^\n]*TASK-001/);
  assert.equal(sb.render(['--check']).status, 0);
  assert.equal(sb.task('TASK-001').design.stale.source, 'docs/design/flow.md');
  refused(claim(sb, 'TASK-001'), /design source docs\/design\/flow\.md changed at/);
  refused(sb.ticket(['edit', 'TASK-001', '--set', 'design.stale=null', '--reason', 'x', ...C]), /edit does not change "design"/);
  ok(sb.ticket(['groom', 'TASK-001', '--design-reviewed', 'C is a new hop; acceptance updated.', ...C]));
  assert.equal(sb.task('TASK-001').design.stale, undefined);
  assert.match(sb.read(NOTE('TASK-001')), /Design source `docs\/design\/flow\.md` changed[\s\S]*\*\*Result:\*\* C is a new hop/);
  ok(claim(sb, 'TASK-001'));

  // A missing design file does not validate, and a source in use cannot be removed.
  refused(sb.ticket(['design', 'docs/design/flow.md', '--remove', ...C]), /is the source of D-001/);
  fs.rmSync(sb.file('docs/design/flow.md'));
  assert.match(sb.render(['--check']).stderr, /design_sources: docs\/design\/flow\.md does not exist/);
});

// ---------- A7: migration ----------

test('migrate: a 0.8 board gets velocity fields from its notes, derived containers, and the new keys; rerun changes nothing', () => {
  const sb = sandbox();
  const b = sb.board();
  for (const k of ['design_sources', 'adr', 'knowledge', 'decisions_pending', 'size_limit_kb']) delete b[k];
  b.epics = [{ id: 'EPIC-001', title: 'Epic', status: 'BACKLOG', points: 55, children: ['STORY-001'], handovers: [] }];
  Object.assign(b.stories[0], { parent: null, status: 'TODO', points: 8, lane: 5 });
  Object.assign(b.tasks[0], { status: 'DONE', lane: 1 });
  b.tasks[1].lane = 2;
  sb.setBoard(b);
  fs.rmSync(sb.file('docs/kanban/KNOWLEDGE.md'), { force: true });
  fs.mkdirSync(sb.file('docs/findings'), { recursive: true });
  sb.write('docs/findings/traps.md', '# 27 verified traps\n');
  sb.write(NOTE('TASK-001'), `# TASK-001\n\n## GROOMING · 2026-10-01T00:00:00Z · coordinator / claude-opus-5-5\n\nA.\n\n## PROGRESS · 2026-10-02T10:00:00Z · claude-medium (claude-sonnet-5-5) · REVIEW\n\nB.\n\n## REVIEW · 2026-10-02T11:00:00Z · coordinator / claude-opus-5-5 · REWORK\n\nC.\n\n## PROGRESS · 2026-10-03T10:00:00Z · worker-2 / claude-sonnet-5-5 · REVIEW\n\nD.\n\n## REVIEW · 2026-10-03T12:00:00Z · coordinator / claude-opus-5-5 · DONE\n\nE.\n`);

  const dry = sb.run('scripts/kanban/migrate.mjs', ['--dry-run', '--order-from=lane']);
  ok(dry);
  assert.equal(sb.task('TASK-001').done_at, undefined, 'a dry run writes nothing');
  const r = sb.run('scripts/kanban/migrate.mjs', ['--order-from=lane']);
  ok(r);
  const t = sb.task('TASK-001');
  assert.deepEqual([t.started_at, t.done_at, t.done_by, t.done_by_model, t.rework_count, t.stamps_backfilled, t.order], ['2026-10-02T10:00:00Z', '2026-10-03T12:00:00Z', 'worker-2', SONNET, 1, true, 1]);
  // The story got its parent from the epic's children list, and both are derived.
  assert.deepEqual([sb.task('STORY-001').parent, sb.task('STORY-001').status, sb.task('STORY-001').points, sb.task('STORY-001').estimate], ['EPIC-001', 'IN_PROGRESS', 5, 8]);
  assert.deepEqual([sb.task('EPIC-001').status, sb.task('EPIC-001').points, sb.task('EPIC-001').estimate], ['IN_PROGRESS', 5, 55]);
  const after = sb.board();
  assert.deepEqual([after.design_sources, after.decisions_pending, after.knowledge.dir, after.adr.dir], [[], [], 'docs/findings', 'docs/adr']);
  assert.ok('done_at' in after._ticket_template && 'design' in after._ticket_template);
  assert.match(sb.read('docs/kanban/KNOWLEDGE.md'), /- \[traps\.md\]\(\.\.\/findings\/traps\.md\): 27 verified traps/);
  assert.match(r.stdout, /Design anchor: off/);
  assert.equal(sb.render(['--check']).status, 0);
  // Backfilled starts are the first hand-over, not the claim: they are left out of cycle time.
  const stats = JSON.parse(sb.ticket(['stats', '--json']).stdout);
  assert.deepEqual([stats.all.points, stats.all.cycle_measured, stats.all.reworks], [3, 0, 1]);

  const text = sb.read('docs/kanban/board.json');
  const again = sb.run('scripts/kanban/migrate.mjs', ['--order-from=lane']);
  ok(again);
  assert.match(again.stdout, /nothing to change/);
  assert.equal(sb.read('docs/kanban/board.json'), text);
});
