#!/usr/bin/env node
// Installs the Scrum Kanban agent workflow into a new or existing repository.
//
//   npx github:earnestangel/Scrum-Kanban-Template init     [options]   first install
//   npx github:earnestangel/Scrum-Kanban-Template upgrade  [options]   refresh protocol, scripts, and agent files
//   npx github:earnestangel/Scrum-Kanban-Template doctor               check the install
//
// Options:
//   --dry-run              print what would change, write nothing
//   --base-branch=<name>   integration branch that PRs target (default: develop, or the value saved at init)
//   --no-codegraph         skip CodeGraph MCP configs and codegraph.json
//   --no-git-hooks         do not set core.hooksPath
//   --no-ci                do not add the GitHub Actions board check
//
// Never overwrites project data: board.json, handover notes, and your own text in AGENTS.md stay as they are.
// The one exception: legacy board.json fields are migrated in place (see migrateBoard).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
const CONFIG_FILE = '.scrum-kanban.json';
const BLOCK_START = '<!-- scrum-kanban:start -->';
const BLOCK_END = '<!-- scrum-kanban:end -->';
const CG_START = '<!-- CODEGRAPH_START -->';
const CG_END = '<!-- CODEGRAPH_END -->';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const opt = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const dryRun = flag('dry-run');

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
const top = git('rev-parse', '--show-toplevel');
const DEST = top.status === 0 ? path.resolve(top.stdout.trim()) : process.cwd();
const self = DEST === SRC;

const src = (p) => path.join(SRC, p);
const dest = (p) => path.join(DEST, p);
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const log = [];
const manual = [];

function write(rel, content, action) {
  const before = read(dest(rel));
  if (before !== null && before.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')) return;
  log.push(`${action.padEnd(8)} ${rel}`);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(dest(rel)), { recursive: true });
  fs.writeFileSync(dest(rel), content);
}

// Files the template owns. Replaced on every init and upgrade.
function copyOwned(rel, transform = (s) => s) {
  if (self) return;
  const had = fs.existsSync(dest(rel));
  write(rel, transform(read(src(rel))), had ? 'update' : 'create');
  if (!dryRun && rel.startsWith('scripts/git-hooks/')) fs.chmodSync(dest(rel), 0o755);
}

// Project data. Created once, never touched again.
function copyOnce(rel, transform = (s) => s) {
  if (self || fs.existsSync(dest(rel))) return;
  write(rel, transform(read(src(rel))), 'create');
}

function mergeJson(rel, merge) {
  const text = read(dest(rel));
  let obj = {};
  if (text !== null) {
    try {
      obj = JSON.parse(text);
    } catch {
      manual.push(`${rel} is not plain JSON (comments?). Merge the entries from the template by hand.`);
      return;
    }
  }
  merge(obj);
  write(rel, JSON.stringify(obj, null, 2) + '\n', text === null ? 'create' : 'merge');
}

function appendLines(rel, lines) {
  const text = read(dest(rel)) ?? '';
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const add = lines.filter((l) => !have.has(l));
  if (!add.length) return;
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  write(rel, text + sep + add.join('\n') + '\n', text ? 'append' : 'create');
}

// Replace the text between two markers, or append the block when the markers are missing.
function upsertBlock(rel, start, end, body, { onlyIfMissing = false } = {}) {
  const text = read(dest(rel)) ?? '';
  const block = `${start}\n${body.trim()}\n${end}`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  let next;
  if (i >= 0 && j > i) {
    if (onlyIfMissing) return;
    next = text.slice(0, i) + block + text.slice(j + end.length);
  } else {
    next = (text ? text.replace(/\s*$/, '\n\n') : '') + block + '\n';
  }
  write(rel, next, text ? 'merge' : 'create');
}

// Migrates older boards. From 0.1.x: Claude model names become provider-neutral tiers, and the
// per-worker/parallel WIP keys become one board-wide wip_limit. From 0.2.x: IN_PROGRESS tickets
// get a claimed_at, which the validator now requires. Writes only if something changed.
function migrateBoard() {
  const rel = 'docs/kanban/board.json';
  const text = read(dest(rel));
  if (text === null) return;
  let board;
  try {
    board = JSON.parse(text);
  } catch {
    manual.push(`${rel} is not valid JSON. Fix it, then run upgrade again.`);
    return;
  }
  const tiers = { haiku: 'small', sonnet: 'medium', opus: 'large' };
  let changed = false;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  for (const t of [board._ticket_template, ...['epics', 'stories', 'tasks', 'chores', 'bugs'].flatMap((g) => board[g] ?? [])]) {
    if (t && tiers[t.model]) {
      t.model = tiers[t.model];
      changed = true;
    }
    if (t?.status === 'IN_PROGRESS' && !t.claimed_at) {
      t.claimed_at = now;
      changed = true;
    }
  }
  const legacy = ['wip_limit_per_worker', 'max_parallel_workers'];
  if (legacy.some((k) => k in board)) {
    // Rebuild so wip_limit sits near the top, where the old keys were.
    const { $schema, wip_limit = 1, ...rest } = board;
    for (const k of legacy) delete rest[k];
    board = { ...($schema ? { $schema } : {}), wip_limit, ...rest };
    changed = true;
  }
  if (changed) write(rel, JSON.stringify(board, null, 2) + '\n', 'migrate');
}

const between = (text, start, end) => text.slice(text.indexOf(start) + start.length, text.indexOf(end));
const withBranch = (branch) => (s) => s.replaceAll('`develop`', `\`${branch}\``);

function install(isUpgrade) {
  const saved = JSON.parse(read(dest(CONFIG_FILE)) ?? '{}');
  if (isUpgrade && !saved.version) {
    console.error(`No ${CONFIG_FILE} found. Run "init" first.`);
    process.exit(1);
  }
  const cfg = {
    version: PKG.version,
    base_branch: opt('base-branch') ?? saved.base_branch ?? 'develop',
    codegraph: flag('no-codegraph') ? false : (saved.codegraph ?? true),
    ci: flag('no-ci') ? false : (saved.ci ?? true),
  };
  const branch = withBranch(cfg.base_branch);

  // Template-owned files.
  for (const rel of [
    'docs/kanban/protocol.md',
    'docs/kanban/handovers/_TEMPLATE.md',
    '.claude/agents/ticket-worker.md',
    'scripts/kanban/render-board.mjs',
    'scripts/hooks/session-sync.mjs',
    'scripts/hooks/prompt-context.mjs',
    'scripts/hooks/codegraph-first.mjs',
    'scripts/git-hooks/post-checkout',
    'scripts/git-hooks/post-merge',
    'scripts/git-hooks/post-rewrite',
  ]) copyOwned(rel, rel.endsWith('protocol.md') ? branch : undefined);

  // Project data.
  copyOnce('docs/kanban/board.json');
  if (!self) migrateBoard();
  copyOnce('docs/kanban/handovers/HANDOVERS.md');
  if (cfg.ci) copyOnce('.github/workflows/kanban-board.yml');

  // Agent instructions: one marked block in AGENTS.md; CLAUDE.md and GEMINI.md import it.
  const agents = read(src('AGENTS.md'));
  if (!self) {
    upsertBlock('AGENTS.md', BLOCK_START, BLOCK_END, branch(between(agents, BLOCK_START, BLOCK_END)));
    if (cfg.codegraph) upsertBlock('AGENTS.md', CG_START, CG_END, between(agents, CG_START, CG_END), { onlyIfMissing: true });
    for (const rel of ['CLAUDE.md', 'GEMINI.md']) {
      if (!/^@AGENTS\.md\s*$/m.test(read(dest(rel)) ?? '')) appendLines(rel, ['@AGENTS.md']);
    }
  }

  // Claude Code hooks and permissions. Existing entries are kept; ours are added once.
  const tpl = JSON.parse(read(src('.claude/settings.json')));
  mergeJson('.claude/settings.json', (s) => {
    s.permissions ??= {};
    s.permissions.allow = [...new Set([...(s.permissions.allow ?? []), ...(cfg.codegraph ? tpl.permissions.allow : [])])];
    s.hooks ??= {};
    for (const [event, groups] of Object.entries(tpl.hooks)) {
      if (!cfg.codegraph && event !== 'SessionStart') continue;
      s.hooks[event] ??= [];
      const have = JSON.stringify(s.hooks[event]);
      for (const g of groups) if (!g.hooks.every((h) => have.includes(h.command.replace(/"/g, '\\"')))) s.hooks[event].push(g);
    }
  });

  if (cfg.codegraph) {
    const server = { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] };
    mergeJson('.mcp.json', (o) => ((o.mcpServers ??= {}).codegraph ??= server));
    mergeJson('.gemini/settings.json', (o) => ((o.mcpServers ??= {}).codegraph ??= server));
    mergeJson('.vscode/mcp.json', (o) => ((o.servers ??= {}).codegraph ??= { ...server, args: [...server.args, '--path', '${workspaceFolder}'] }));
    const codex = read(dest('.codex/config.toml')) ?? '';
    if (!codex.includes('[mcp_servers.codegraph]')) appendLines('.codex/config.toml', read(src('.codex/config.toml')).trim().split(/\r?\n/));
    const oc = read(dest('opencode.jsonc'));
    if (oc === null) copyOnce('opencode.jsonc');
    else if (!oc.includes('codegraph')) manual.push('opencode.jsonc exists: add the "mcp.codegraph" entry from the template by hand.');
  }

  appendLines('.gitignore', ['.claude/settings.local.json']);
  appendLines('.gitattributes', ['scripts/git-hooks/* text eol=lf']);

  // Git hooks: only take over core.hooksPath when nothing else owns it.
  if (!flag('no-git-hooks') && cfg.codegraph) {
    const hp = git('-C', DEST, 'config', '--get', 'core.hooksPath').stdout.trim();
    const other = ['.husky', 'lefthook.yml', '.pre-commit-config.yaml'].find((f) => fs.existsSync(dest(f)));
    if (hp === 'scripts/git-hooks') {
      // already set
    } else if (hp || other) {
      manual.push(`Git hooks are managed by ${hp ? `core.hooksPath=${hp}` : other}. Call scripts/git-hooks/post-{checkout,merge,rewrite} from your own hooks.`);
    } else if (top.status === 0) {
      log.push('git      config core.hooksPath scripts/git-hooks');
      if (!dryRun) git('-C', DEST, 'config', 'core.hooksPath', 'scripts/git-hooks');
    }
  }

  write(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', saved.version ? 'update' : 'create');

  if (!dryRun && !self) spawnSync(process.execPath, [dest('scripts/kanban/render-board.mjs')], { stdio: 'inherit' });

  console.log(`${dryRun ? '[dry run] ' : ''}Scrum Kanban ${PKG.version} ${isUpgrade ? 'upgrade' : 'install'} into ${DEST}`);
  console.log(log.length ? log.map((l) => '  ' + l).join('\n') : '  nothing to change');
  for (const m of manual) console.log(`  manual   ${m}`);
  if (!isUpgrade && !dryRun) {
    console.log('\nNext steps:');
    if (cfg.codegraph) console.log('  1. Install CodeGraph, then run: codegraph install && codegraph init -y   (optional; see README)');
    console.log(`  ${cfg.codegraph ? 2 : 1}. Commit the new files. PRs target \`${cfg.base_branch}\`; create that branch if it does not exist.`);
    console.log(`  ${cfg.codegraph ? 3 : 2}. Run: npx github:earnestangel/Scrum-Kanban-Template doctor`);
  }
}

function doctor() {
  const checks = [];
  const ok = (pass, msg, hint) => checks.push([pass, msg, hint]);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 18, `Node.js ${process.versions.node}`, 'Node.js 18+ is required.');
  const cfg = JSON.parse(read(dest(CONFIG_FILE)) ?? 'null');
  ok(!!cfg || self, `${CONFIG_FILE} ${cfg ? `(v${cfg.version}, base branch ${cfg.base_branch})` : self ? '(template source)' : 'missing'}`, 'Run init.');
  ok(/scrum-kanban:start/.test(read(dest('AGENTS.md')) ?? '') || self, 'AGENTS.md has the Scrum Kanban block', 'Run init.');
  const cg = spawnSync('codegraph --version', { shell: true, encoding: 'utf8' });
  const wantCg = cfg?.codegraph !== false;
  if (wantCg) {
    ok(cg.status === 0, `codegraph CLI ${cg.status === 0 ? cg.stdout.trim() : 'not found'}`, 'Optional. Install it for cheaper workers; see README.');
    ok(fs.existsSync(dest('.codegraph/codegraph.db')), 'CodeGraph index', 'Optional. Run: codegraph init -y');
    const hp = git('-C', DEST, 'config', '--get', 'core.hooksPath').stdout.trim();
    ok(hp === 'scripts/git-hooks', `core.hooksPath = ${hp || '(unset)'}`, 'Optional. Run: git config core.hooksPath scripts/git-hooks');
  }
  const r = spawnSync(process.execPath, [dest('scripts/kanban/render-board.mjs'), '--check'], { encoding: 'utf8' });
  ok(r.status === 0, `board check: ${(r.stdout || r.stderr).trim().split('\n').pop()}`, 'Fix the errors above, then run: node scripts/kanban/render-board.mjs');
  for (const [pass, msg, hint] of checks) console.log(`${pass ? 'ok  ' : 'WARN'}  ${msg}${pass ? '' : `\n      ${hint}`}`);
  process.exit(checks.some(([p], i) => !p && i < 3) || r.status !== 0 ? 1 : 0);
}

if (cmd === 'init') install(false);
else if (cmd === 'upgrade') install(true);
else if (cmd === 'doctor') doctor();
else {
  console.log(read(fileURLToPath(import.meta.url)).split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
