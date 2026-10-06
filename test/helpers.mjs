// Test sandbox: a temp project with a copy of scripts/ and docs/kanban/ and a small groomed board.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ticket = (o) => ({
  tier_override: null,
  assignee: null,
  claimed_at: null,
  blocked_reason: null,
  requires: [],
  context: { files: ['src/a.js'] },
  acceptance: ['works'],
  verify_cmd: 'node -e 0',
  handovers: [o.id],
  ...o,
});

export function sandbox({ tiers } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
  fs.cpSync(path.join(REPO, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'docs', 'kanban'), path.join(dir, 'docs', 'kanban'), { recursive: true });
  for (const f of fs.readdirSync(path.join(dir, 'docs/kanban/handovers'))) {
    if (!['_TEMPLATE.md', 'HANDOVERS.md'].includes(f)) fs.rmSync(path.join(dir, 'docs/kanban/handovers', f));
  }
  const board = JSON.parse(fs.readFileSync(path.join(dir, 'docs/kanban/board.json'), 'utf8'));
  board.stories = [ticket({ id: 'STORY-001', title: 'Story', status: 'TODO', points: 5, model: 'large', children: ['TASK-001', 'TASK-002'] })];
  board.tasks = [
    ticket({ id: 'TASK-001', title: 'Medium task', status: 'TODO', points: 3, parent: 'STORY-001', model: 'medium' }),
    ticket({ id: 'TASK-002', title: 'Small task', status: 'TODO', points: 2, parent: 'STORY-001', model: 'medium', requires: ['TASK-001'] }),
  ];
  const sb = {
    dir,
    file: (rel) => path.join(dir, rel),
    read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'),
    write: (rel, text) => fs.writeFileSync(path.join(dir, rel), text),
    board: () => JSON.parse(fs.readFileSync(path.join(dir, 'docs/kanban/board.json'), 'utf8')),
    task: (id) => sb.board().tasks.find((t) => t.id === id) ?? sb.board().stories.find((t) => t.id === id),
    setBoard: (b) => fs.writeFileSync(path.join(dir, 'docs/kanban/board.json'), JSON.stringify(b, null, 2) + '\n'),
    // A transcript whose latest assistant reply came from `model`.
    transcript: (name, model, sidechain = false) => {
      const f = path.join(dir, `${name}.jsonl`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ type: 'assistant', isSidechain: sidechain, message: { model } }) + '\n');
      return f;
    },
    run: (script, args = [], { env = {}, input } = {}) =>
      spawnSync(process.execPath, [path.join(dir, script), ...args], { cwd: dir, encoding: 'utf8', input, env: { ...cleanEnv(), ...env } }),
    ticket: (args, opts) => sb.run('scripts/kanban/ticket.mjs', args, opts),
    render: (args = []) => sb.run('scripts/kanban/render-board.mjs', args),
    // Runs worker-delegation.mjs with a PreToolUse event; returns { decision, reason, note }.
    hook: (event, env = {}) => {
      const r = sb.run('scripts/hooks/worker-delegation.mjs', [], { env: { CLAUDE_PROJECT_DIR: dir, ...env }, input: JSON.stringify({ cwd: dir, ...event }) });
      const out = r.stdout.trim() ? JSON.parse(r.stdout) : {};
      return { decision: out.hookSpecificOutput?.permissionDecision ?? 'allow', reason: out.hookSpecificOutput?.permissionDecisionReason ?? '', note: out.systemMessage ?? '', stderr: r.stderr };
    },
  };
  sb.setBoard(board);
  for (const id of ['STORY-001', 'TASK-001', 'TASK-002']) sb.write(`docs/kanban/handovers/${id}.md`, `# ${id}\n\n## GROOMING · 2026-10-01T00:00:00Z · claude-large (claude-opus-5-5)\n\nApproach.\n`);
  if (tiers) sb.write('docs/kanban/tiers.json', JSON.stringify({ tiers }, null, 2));
  const r = sb.render();
  if (r.status !== 0) throw new Error(`sandbox board invalid:\n${r.stderr}`);
  return sb;
}

// The test process may run inside Claude Code; keep its switches out of the scripts under test.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(KANBAN_|CLAUDE_CODE_SUBAGENT_MODEL|ANTHROPIC_DEFAULT_|CLAUDE_PROJECT_DIR)/.test(k)) delete env[k];
  return env;
}

export const LUNA = 'bedrock/global.openai.gpt-6-luna';
export const OPUS = 'claude-opus-5-5';
export const SONNET = 'claude-sonnet-5-5';
