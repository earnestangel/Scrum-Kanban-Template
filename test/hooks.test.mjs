// 0.9: the CodeGraph-first hook fires on code only; the delegation hook knows the new commands and files;
// the installer replaces template-owned hooks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OPUS, REPO, SONNET, sandbox } from './helpers.mjs';

// Runs codegraph-first.mjs as a fresh agent; returns "deny" or "allow".
let n = 0;
function codegraphFirst(sb, tool_name, tool_input, env = {}) {
  const r = sb.run('scripts/hooks/codegraph-first.mjs', [], { env, input: JSON.stringify({ tool_name, tool_input, cwd: sb.dir, session_id: `s${process.pid}-${Date.now()}-${n++}` }) });
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow';
}

test('codegraph-first: denies the first code search, never a read of docs, notes, ADRs, or config', () => {
  const sb = sandbox();
  // No index: the hook does nothing.
  assert.equal(codegraphFirst(sb, 'Grep', { pattern: 'login' }), 'allow');
  fs.mkdirSync(sb.file('.codegraph'));
  sb.write('.codegraph/codegraph.db', '');

  const code = [
    ['Grep', { pattern: 'login' }],
    ['Grep', { pattern: 'login', glob: '**/*.ts' }],
    ['Glob', { pattern: 'src/**/*.ts' }],
    ['Read', { file_path: 'src/auth.ts' }],
    ['Bash', { command: 'grep -rn "login" src/' }],
    ['Bash', { command: 'cat src/auth.ts' }],
    ['PowerShell', { command: 'Get-ChildItem -Recurse src | Select-String login' }],
  ];
  for (const [tool, input] of code) assert.equal(codegraphFirst(sb, tool, input), 'deny', `${tool} ${JSON.stringify(input)}`);

  const notCode = [
    ['Grep', { pattern: 'Status', glob: '*.md' }],
    ['Grep', { pattern: 'Status', path: 'docs/decisions' }],
    ['Grep', { pattern: 'wip_limit', type: 'json' }],
    ['Glob', { pattern: 'docs/**/*.md' }],
    ['Glob', { pattern: '**/*.yml' }],
    ['Read', { file_path: 'docs/adr/0001-relay.md' }],
    ['Read', { file_path: 'README.md' }],
    ['Read', { file_path: 'src/auth.ts', offset: 10, limit: 20 }],
    ['Bash', { command: 'grep -n "^| Status" docs/decisions/*.md' }],
    ['Bash', { command: 'cat docs/kanban/handovers/EPIC-001.md | head -40' }],
    ['Bash', { command: 'find docs -name "*.md"' }],
    ['Bash', { command: 'rg -n Accepted --glob "*.md"' }],
    ['PowerShell', { command: 'Select-String -Path docs\\findings\\*.md -Pattern trap' }],
    ['Bash', { command: 'node scripts/kanban/ticket.mjs context TASK-001' }],
  ];
  for (const [tool, input] of notCode) assert.equal(codegraphFirst(sb, tool, input), 'allow', `${tool} ${JSON.stringify(input)}`);

  assert.equal(codegraphFirst(sb, 'Grep', { pattern: 'login' }, { CODEGRAPH_FIRST: 'off' }), 'allow');
});

test('codegraph-first: the reminder is given once per agent, and not after CodeGraph was used', () => {
  const sb = sandbox();
  fs.mkdirSync(sb.file('.codegraph'));
  sb.write('.codegraph/codegraph.db', '');
  const event = { tool_name: 'Grep', tool_input: { pattern: 'login' }, cwd: sb.dir, session_id: `once-${process.pid}-${Date.now()}` };
  const run = (extra = {}, env = {}) => sb.run('scripts/hooks/codegraph-first.mjs', [], { env, input: JSON.stringify({ ...event, ...extra }) }).stdout.trim();
  assert.match(run(), /"deny"/);
  assert.equal(run(), '', 'the retry passes');
  assert.match(run({}, { CODEGRAPH_FIRST: 'strict' }), /"deny"/);
  const used = path.join(sb.dir, 'used.jsonl');
  fs.writeFileSync(used, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__codegraph__codegraph_explore' }] } }) + '\n');
  assert.equal(run({ transcript_path: used, session_id: `used-${Date.now()}` }, { CODEGRAPH_FIRST: 'strict' }), '');
});

test('the template ships no UserPromptSubmit hook', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit, undefined);
  assert.ok(!fs.existsSync(path.join(REPO, 'scripts/hooks/prompt-context.mjs')));
});

const bash = (command, transcript, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, transcript_path: transcript, ...extra });
const edit = (file, transcript, extra = {}) => ({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' }, transcript_path: transcript, ...extra });

test('delegation hook: the new coordinator commands need the large tier; workers keep context, finding, and FLAG', () => {
  const sb = sandbox();
  const opus = sb.transcript('main', OPUS);
  const sonnet = sb.transcript('m2', SONNET);
  sb.transcript('s/subagents/agent-a1', SONNET, true);
  const worker = { agent_id: 'a1', agent_type: 'ticket-worker', session_id: 's' };
  const t = (args) => `node scripts/kanban/ticket.mjs ${args}`;
  const coordinatorOnly = [
    'state STORY-001 --agent c --model M --text x',
    'close STORY-001 --agent c --model M --text x',
    'archive STORY-001 --agent c --model M',
    'decision new --question q --blocks TASK-001 --agent c --model M',
    'design docs/design/flow.md --agent c --model M',
    'element new --title t --source docs/design/flow.md --agent c --model M',
    'note TASK-001 --type FLAG --from TASK-002 --agent c --summary s --supersedes 1 --text x',
  ];
  for (const args of coordinatorOnly) {
    assert.equal(sb.hook(bash(t(args.replace('M', OPUS)), opus)).decision, 'allow', `coordinator: ${args}`);
    assert.equal(sb.hook(bash(t(args.replace('M', SONNET)), sonnet)).decision, 'deny', `non-large session: ${args}`);
    assert.equal(sb.hook(bash(t(args.replace('M', SONNET)), opus, worker)).decision, 'deny', `worker: ${args}`);
  }
  for (const args of ['context TASK-001', 'finding docs/findings/x.md --summary s --agent w', 'stats', 'note TASK-002 --type FLAG --from TASK-001 --agent w --summary s --text x']) {
    assert.equal(sb.hook(bash(t(args), opus, worker)).decision, 'allow', `worker: ${args}`);
  }
});

test('delegation hook: the ledger and the archive are script-only; a story in progress does not lock the checkout', () => {
  const sb = sandbox();
  const opus = sb.transcript('main', OPUS);
  for (const rel of ['docs/kanban/design.json', 'docs/kanban/board-archive.json', 'docs/kanban/handovers/archive/TASK-001.md']) {
    const r = sb.hook(edit(sb.file(rel), opus));
    assert.equal(r.decision, 'deny', rel);
    assert.match(r.reason, /by hand[\s\S]*ticket\.mjs/);
  }
  assert.equal(sb.hook(bash('echo "{}" > docs/kanban/design.json', opus)).decision, 'deny');
  assert.equal(sb.hook(bash('node scripts/kanban/migrate.mjs --dry-run', opus)).decision, 'allow');
  // KNOWLEDGE.md is an index anyone may fix; the validator checks it.
  assert.equal(sb.hook(edit(sb.file('docs/kanban/KNOWLEDGE.md'), opus)).decision, 'allow');

  // One task done: the story is IN_PROGRESS (derived), but no ticket holds the WIP slot.
  const b = sb.board();
  Object.assign(b.tasks[0], { status: 'DONE' });
  b.stories[0].status = 'IN_PROGRESS';
  sb.setBoard(b);
  assert.equal(sb.hook(edit(sb.file('src/a.js'), opus)).decision, 'allow');
  // A task in progress: project files belong to its worker, but findings and ADRs stay open to the coordinator.
  Object.assign(b.tasks[1], { status: 'IN_PROGRESS', assignee: 'w', claimed_at: '2026-10-02T00:00:00Z' });
  sb.setBoard(b);
  assert.equal(sb.hook(edit(sb.file('src/a.js'), opus)).decision, 'deny');
  assert.equal(sb.hook(edit(sb.file('docs/findings/2026-11-01-trap.md'), opus)).decision, 'allow');
  assert.equal(sb.hook(edit(sb.file('docs/adr/0003-queue.md'), opus)).decision, 'allow');
});

test('installer: upgrade replaces template-owned hooks, keeps the project\'s own, and migrates the board', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-hooks-'));
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  const installer = (...a) => spawnSync(process.execPath, [path.join(REPO, 'bin/scrum-kanban.mjs'), ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  assert.equal(installer('init', '--no-ci').status, 0);
  // A 0.7 install: the dropped prompt hook, an old matcher, the hook "codegraph install" adds, and a project hook.
  const file = path.join(dir, '.claude/settings.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hook = (command) => ({ hooks: [{ type: 'command', command }] });
  s.hooks.UserPromptSubmit = [hook('node "$CLAUDE_PROJECT_DIR/scripts/hooks/prompt-context.mjs"'), hook('codegraph.cmd prompt-hook')];
  s.hooks.PreToolUse = [{ matcher: 'Agent|Task|Edit|Write', ...hook('node "$CLAUDE_PROJECT_DIR/scripts/hooks/worker-delegation.mjs"') }, { matcher: 'Bash', ...hook('node tools/my-own-hook.mjs') }];
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  fs.mkdirSync(path.join(dir, 'scripts/hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts/hooks/prompt-context.mjs'), '// old\n');
  const cfgFile = path.join(dir, '.scrum-kanban.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, version: '0.7.0', owned: [...cfg.owned, 'scripts/hooks/prompt-context.mjs'] }, null, 2));

  const r = installer('upgrade');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const commands = (event) => (after.hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => `${g.matcher ?? ''} ${h.command}`));
  assert.deepEqual(commands('UserPromptSubmit'), [' codegraph.cmd prompt-hook'], 'the template hook is gone; the CodeGraph one is the user\'s to remove');
  assert.match(r.stdout, /manual\s+\.claude\/settings\.json has a "codegraph prompt-hook" UserPromptSubmit hook/);
  assert.ok(commands('PreToolUse').some((c) => /^Bash node tools\/my-own-hook\.mjs$/.test(c)), 'the project hook stays');
  const delegation = commands('PreToolUse').filter((c) => c.includes('worker-delegation.mjs'));
  assert.equal(delegation.length, 1);
  assert.match(delegation[0], /Bash\|PowerShell/, 'the matcher follows the template');
  assert.equal(commands('PreToolUse').filter((c) => c.includes('codegraph-first.mjs')).length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'scripts/hooks/prompt-context.mjs')), 'a dropped template file is deleted');
  assert.ok(fs.existsSync(path.join(dir, 'scripts/kanban/migrate.mjs')));
  assert.ok(fs.existsSync(path.join(dir, 'docs/kanban/KNOWLEDGE.md')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'docs/kanban/board.json'), 'utf8')).design_sources, []);
  // A second upgrade changes nothing.
  assert.match(installer('upgrade').stdout, /nothing to change/);
});
