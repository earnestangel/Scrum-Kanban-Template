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
  const note = sb.file('docs/kanban/handovers/STORY-001.md');
  assert.equal(sb.hook(edit(note, sb.transcript('main', OPUS))).decision, 'allow');
  assert.equal(sb.hook(edit(note, sb.transcript('m2', SONNET))).decision, 'deny');
  assert.equal(sb.hook(edit(note, sb.transcript('m3', LUNA))).decision, 'deny');
  sb.write('docs/kanban/tiers.json', JSON.stringify({ tiers: { large: ['*opus*', '*gpt-6-luna'], medium: ['*sonnet*'], small: ['*haiku*'] } }));
  assert.equal(sb.hook(edit(note, sb.transcript('m4', LUNA))).decision, 'allow');
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
  assert.match(r.reason, /tier_override/);
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
  assert.equal(sb.hook(edit(sb.file('docs/kanban/handovers/TASK-001.md'), luna), env).decision, 'allow');
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
