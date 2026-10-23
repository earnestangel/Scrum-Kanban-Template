import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LUNA, OPUS, SONNET, sandbox } from './helpers.mjs';

const dispatch = (sb, model, transcript, id = 'TASK-001') => ({
  tool_name: 'Agent',
  tool_input: { subagent_type: 'ticket-worker', prompt: `Ticket: ${id}. Worker name: w.`, model },
  transcript_path: transcript,
});
const edit = (file, transcript, extra = {}) => ({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'Approach.', new_string: 'Approach!' }, transcript_path: transcript, ...extra });
const bash = (command, transcript, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, transcript_path: transcript, ...extra });

test('dispatch: the resolved model must fit the ticket tier', () => {
  const sb = sandbox();
  const opus = sb.transcript('main', OPUS);
  assert.equal(sb.hook(dispatch(sb, 'sonnet', opus)).decision, 'allow');
  assert.equal(sb.hook(dispatch(sb, 'opus', opus)).decision, 'deny');
  const remapped = sb.hook(dispatch(sb, 'sonnet', opus), { ANTHROPIC_DEFAULT_SONNET_MODEL: LUNA });
  assert.equal(remapped.decision, 'deny');
  assert.match(remapped.reason, /gpt-6-luna/);
  assert.equal(sb.hook(dispatch(sb, 'sonnet', opus), { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5' }).decision, 'deny');
});

test('dispatch: a model the user lists for the tier passes, with a worker-name note', () => {
  const sb = sandbox({ tiers: { large: ['*opus*'], medium: ['*sonnet*', '*gpt-6-luna'], small: ['*haiku*'] } });
  const r = sb.hook(dispatch(sb, 'sonnet', sb.transcript('main', OPUS)), { ANTHROPIC_DEFAULT_SONNET_MODEL: LUNA });
  assert.equal(r.decision, 'allow');
  assert.match(r.note, /gpt-6-luna-medium/);
});

test('dispatch: KANBAN_INLINE approves a mismatch for the listed ticket only', () => {
  const sb = sandbox();
  const opus = sb.transcript('main', OPUS);
  const r = sb.hook(dispatch(sb, 'opus', opus), { KANBAN_INLINE: 'TASK-001' });
  assert.equal(r.decision, 'allow');
  assert.match(r.note, /KANBAN_INLINE/);
});

test('coordinator: board and handover edits need a large-tier model from tiers.json', () => {
  const sb = sandbox();
  const groom = (model) => `node scripts/kanban/ticket.mjs groom TASK-001 --points 5 --agent c --model ${model}`;
  assert.equal(sb.hook(bash(groom(OPUS), sb.transcript('main', OPUS))).decision, 'allow');
  assert.equal(sb.hook(bash(groom(SONNET), sb.transcript('m2', SONNET))).decision, 'deny');
  assert.equal(sb.hook(bash(groom(LUNA), sb.transcript('m3', LUNA))).decision, 'deny');
  sb.write('docs/kanban/tiers.json', JSON.stringify({ tiers: { large: ['*opus*', '*gpt-6-luna'], medium: ['*sonnet*'], small: ['*haiku*'] } }));
  assert.equal(sb.hook(bash(groom(LUNA), sb.transcript('m4', LUNA))).decision, 'allow');
});

test('board files: no agent edits board.json, BOARD.md, or handovers by hand', () => {
  const sb = sandbox();
  const opus = sb.transcript('main', OPUS);
  sb.transcript('s/subagents/agent-a1', SONNET, true);
  const worker = { agent_id: 'a1', agent_type: 'ticket-worker', session_id: 's' };
  const files = ['docs/kanban/board.json', 'docs/kanban/BOARD.md', 'docs/kanban/handovers/TASK-001.md', 'docs/kanban/handovers/HANDOVERS.md', 'docs/kanban/.script-writes.json'];
  for (const rel of files) {
    for (const [who, extra, env] of [['coordinator', {}, {}], ['worker', worker, {}], ['inline', {}, { KANBAN_INLINE: 'TASK-001' }]]) {
      const r = sb.hook(edit(sb.file(rel), opus, extra), env);
      assert.equal(r.decision, 'deny', `${who} Edit ${rel}`);
      assert.match(r.reason, /by hand[\s\S]*ticket\.mjs/);
      assert.equal(sb.hook({ tool_name: 'Write', tool_input: { file_path: sb.file(rel), content: '' }, transcript_path: opus, ...extra }, env).decision, 'deny', `${who} Write ${rel}`);
    }
  }
  assert.match(sb.hook(edit(sb.file('docs/kanban/handovers/TASK-001.md'), opus)).reason, /--edit <n> \| --delete <n>/);
  for (const cmd of ['echo x >> docs/kanban/handovers/TASK-001.md', 'echo > docs/kanban/BOARD.md', 'Add-Content docs/kanban/handovers/STORY-001.md "x"']) {
    assert.equal(sb.hook(bash(cmd, opus)).decision, 'deny', cmd);
  }
  assert.equal(sb.hook(edit(sb.file('docs/kanban/protocol.md'), opus)).decision, 'allow');
});

test('coordinator commands: never from a subagent; the coordinator claims only a 1 point chore', () => {
  const sb = sandbox();
  const opus = sb.transcript('main', OPUS);
  sb.transcript('s/subagents/agent-a1', SONNET, true);
  const worker = { agent_id: 'a1', agent_type: 'ticket-worker', session_id: 's' };
  assert.equal(sb.hook(bash(`node scripts/kanban/ticket.mjs create task --title x --parent STORY-001 --agent a --model ${OPUS}`, opus, worker)).decision, 'deny');
  assert.match(sb.hook(bash(`node scripts/kanban/ticket.mjs create task --title x --agent a --model ${SONNET}`, opus)).reason, /must be the model you run on/);
  for (const cmd of ['create task --title x --parent STORY-001', 'groom TASK-001 --points 3', 'edit TASK-001 --set title=x --reason r', 'status TASK-001 --to BACKLOG', 'note TASK-001 --type GROOMING --edit 1 --text x']) {
    const [sub, id, ...args] = cmd.split(' ');
    const line = `node scripts/kanban/ticket.mjs ${sub} ${sub === 'create' ? 'TASK-009' : id} ${args.join(' ')} --agent a --model ${SONNET}`;
    assert.equal(sb.hook(bash(line, opus, worker)).decision, 'deny', cmd);
  }
  const b = sb.board();
  b.chores = [{ id: 'CHORE-001', title: 'Bump', status: 'TODO', points: 1, model: 'small', context: { files: ['package.json'] }, acceptance: ['x'], verify_cmd: 'node -e 0', handovers: ['CHORE-001'] }];
  b.chores.push({ ...b.chores[0], id: 'CHORE-002', points: 2, model: 'medium', handovers: ['CHORE-002'] });
  sb.setBoard(b);
  const claim = (id) => bash(`node scripts/kanban/ticket.mjs claim ${id} --worker claude-large --model ${OPUS}`, opus);
  assert.equal(sb.hook(claim('CHORE-001')).decision, 'allow');
  assert.equal(sb.hook(claim('CHORE-002')).decision, 'deny');
  Object.assign(b.chores[0], { status: 'IN_PROGRESS', assignee: 'claude-large', claimed_at: new Date().toISOString() });
  sb.setBoard(b);
  assert.equal(sb.hook({ tool_name: 'Write', tool_input: { file_path: sb.file('package.json'), content: '{}' }, transcript_path: opus }).decision, 'allow');
});

test('tiers.json and tier_override are user-only', () => {
  const sb = sandbox();
  const opus = sb.transcript('main', OPUS);
  assert.equal(sb.hook(edit(sb.file('docs/kanban/tiers.json'), opus)).decision, 'deny');
  assert.equal(sb.hook(bash('echo {} > docs/kanban/tiers.json', opus)).decision, 'deny');
  const b = sb.board();
  b.tasks[0].tier_override = { tier: 'large', reason: 'x' };
  const r = sb.hook({ tool_name: 'Write', tool_input: { file_path: sb.file('docs/kanban/board.json'), content: JSON.stringify(b, null, 2) }, transcript_path: opus });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /by hand/);
});

test('shell: writes to board.json are denied, reads and ticket.mjs pass', () => {
  const sb = sandbox();
  const opus = sb.transcript('main', OPUS);
  for (const cmd of ['echo {} > docs/kanban/board.json', "sed -i 's/TODO/DONE/' docs/kanban/board.json", 'cp /tmp/x.json docs/kanban/board.json', 'Set-Content docs/kanban/board.json "{}"']) {
    assert.equal(sb.hook(bash(cmd, opus)).decision, 'deny', cmd);
  }
  for (const cmd of ['cat docs/kanban/board.json | head', 'cp docs/kanban/board.json /tmp/backup.json', 'node scripts/kanban/render-board.mjs --check', 'node scripts/kanban/ticket.mjs show TASK-001']) {
    assert.equal(sb.hook(bash(cmd, opus)).decision, 'allow', cmd);
  }
});

test('claims: the coordinator never claims; a worker claims only on its tier', () => {
  const sb = sandbox();
  const opus = sb.transcript('main', OPUS);
  const claim = (model) => `node scripts/kanban/ticket.mjs claim TASK-001 --worker w --model ${model}`;
  assert.equal(sb.hook(bash(claim(OPUS), opus)).decision, 'deny');
  // Claude Code sends the parent's transcript_path; the sub-agent's own lives in <session>/subagents/.
  const sub = (agent) => ({ agent_id: agent, agent_type: 'ticket-worker', session_id: 's' });
  sb.transcript('s/subagents/agent-a1', SONNET, true);
  sb.transcript('s/subagents/agent-a2', LUNA, true);
  assert.equal(sb.hook(bash(claim(SONNET), opus, sub('a1'))).decision, 'allow');
  const lying = sb.hook(bash(claim(SONNET), opus, sub('a2')));
  assert.equal(lying.decision, 'deny');
  assert.match(lying.reason, /gpt-6-luna/);
});

test('KANBAN_INLINE: a non-large session executes the listed ticket, but never reviews', () => {
  const sb = sandbox();
  const luna = sb.transcript('main', LUNA);
  const env = { KANBAN_INLINE: 'TASK-001' };
  assert.equal(sb.hook(bash(`node scripts/kanban/ticket.mjs claim TASK-001 --worker luna-medium --model ${LUNA}`, luna), env).decision, 'allow');
  assert.equal(sb.hook(bash(`node scripts/kanban/ticket.mjs claim TASK-002 --worker luna-medium --model ${LUNA}`, luna), env).decision, 'deny');
  assert.equal(sb.hook(edit(sb.file('docs/kanban/handovers/TASK-001.md'), luna), env).decision, 'deny');
  assert.equal(sb.hook(edit(sb.file('docs/kanban/handovers/STORY-001.md'), luna), env).decision, 'deny');
  assert.equal(sb.hook(bash(`node scripts/kanban/ticket.mjs review TASK-001 --outcome DONE --reviewer l --model ${LUNA}`, luna), env).decision, 'deny');
  assert.equal(sb.hook(edit(sb.file('docs/kanban/tiers.json'), luna), env).decision, 'deny');
});

test('active ticket: project files belong to its worker unless the user set KANBAN_INLINE', () => {
  const sb = sandbox();
  const b = sb.board();
  Object.assign(b.tasks[0], { status: 'IN_PROGRESS', assignee: 'w', claimed_at: new Date().toISOString() });
  sb.setBoard(b);
  const opus = sb.transcript('main', OPUS);
  const src = { tool_name: 'Write', tool_input: { file_path: sb.file('src/a.js'), content: '' }, transcript_path: opus };
  assert.equal(sb.hook(src).decision, 'deny');
  assert.equal(sb.hook(src, { KANBAN_INLINE: 'TASK-001' }).decision, 'allow');
  assert.equal(sb.hook({ ...src, agent_id: 'a1', agent_type: 'ticket-worker' }).decision, 'allow');
});

test('KANBAN_DELEGATE=off disables the hook', () => {
  const sb = sandbox();
  assert.equal(sb.hook(edit(sb.file('docs/kanban/tiers.json'), sb.transcript('main', LUNA)), { KANBAN_DELEGATE: 'off' }).decision, 'allow');
});
