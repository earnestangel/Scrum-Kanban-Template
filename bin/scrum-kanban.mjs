#!/usr/bin/env node
// Installs the Scrum Kanban agent workflow into a new or existing repository.
//
//   npx github:earnestangel/Scrum-Kanban-Template init     [options]   first install
//   npx github:earnestangel/Scrum-Kanban-Template upgrade  [options]   refresh protocol, scripts, board schema, and marked blocks
//   npx github:earnestangel/Scrum-Kanban-Template doctor               check the install
//
// Options:
//   --dry-run              print what would change, write nothing
//   --base-branch=<name>   integration branch that PRs target (default: develop, or the value saved at init)
//   --no-codegraph         skip CodeGraph MCP configs and codegraph.json
//   --no-git-hooks         do not set core.hooksPath (pre-commit board check, CodeGraph sync)
//   --no-ci                do not add the GitHub Actions board check
//
// Never overwrites project data: tickets, handover notes, and your own text outside the marked blocks in
// AGENTS.md, CLAUDE.md, and GEMINI.md stay as they are. board.json gets schema updates in place (scripts/kanban/migrate.mjs).
// docs/kanban/tiers.json (which models count as each tier) is created once and then belongs to the user.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRIPT_WRITES_FILE, isGuarded, recordScriptWrites } from '../scripts/kanban/board-lib.mjs';
import { TIERS, aliasForTier, loadTierModels, modelFitsTier, resolveClaudeAlias } from '../scripts/kanban/tier-policy.mjs';

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
// Board files the installer wrote, recorded like ticket.mjs writes so the pre-commit check accepts them.
const scriptWrites = {};

function write(rel, content, action) {
  const before = read(dest(rel));
  if (before !== null && before.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')) return;
  log.push(`${action.padEnd(8)} ${rel}`);
  if (isGuarded(rel)) scriptWrites[rel] = content;
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

// Every file under a template directory, as sorted forward-slash paths relative to the repo root.
function walk(relDir) {
  return fs
    .readdirSync(src(relDir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${relDir}/${e.name}`) : e.isFile() ? [`${relDir}/${e.name}`] : []))
    .sort();
}

function remove(rel) {
  if (!fs.existsSync(dest(rel))) return;
  log.push(`${'delete'.padEnd(8)} ${rel}`);
  if (!dryRun) fs.rmSync(dest(rel));
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

// Runs the installed scripts/kanban/migrate.mjs: schema keys, legacy fields, stamps, velocity fields, derived
// containers, and KNOWLEDGE.md (see that file). It is safe to run again. Returns its output; with --dry-run
// the scripts are not installed yet, so the template's copy cannot run against this project and nothing runs.
function migrateBoard() {
  if (dryRun) return fs.existsSync(dest('docs/kanban/board.json')) ? '  migrate  docs/kanban/board.json would be migrated by scripts/kanban/migrate.mjs (run it with --dry-run after the install to preview)' : '';
  const r = spawnSync(process.execPath, [dest('scripts/kanban/migrate.mjs')], { encoding: 'utf8' });
  const text = `${r.stdout}${r.stderr}`;
  if (r.status !== 0) manual.push('The board does not validate after the migration. Read the errors below, fix them with scripts/kanban/ticket.mjs, then run: node scripts/kanban/migrate.mjs');
  // Quiet when there was nothing to migrate.
  return /^\s+nothing to change$/m.test(text) && r.status === 0 ? text.split('\n').filter((l) => /^BOARD\.md written|^warning|^Waiting|^ADRs|^Ready/.test(l)).join('\n') : text;
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

  // Template-owned files: everything under scripts/ plus the protocol and agent files. Files the
  // previous install owned that the template no longer ships are deleted.
  const owned = ['docs/kanban/protocol.md', 'docs/kanban/providers.md', 'docs/kanban/handovers/_TEMPLATE.md', '.claude/agents/ticket-worker.md', ...walk('scripts')];
  for (const rel of owned) copyOwned(rel, rel.endsWith('protocol.md') ? branch : undefined);
  if (!self) for (const rel of saved.owned ?? []) if (!owned.includes(rel)) remove(rel);
  cfg.owned = owned;

  // Project data.
  copyOnce('docs/kanban/board.json');
  copyOnce('docs/kanban/tiers.json');
  copyOnce('docs/kanban/handovers/HANDOVERS.md');
  if (cfg.ci) copyOnce('.github/workflows/kanban-board.yml');

  // Agent instructions: one marked block in AGENTS.md; CLAUDE.md and GEMINI.md import it.
  // A new CLAUDE.md/GEMINI.md is just "@AGENTS.md". An existing one keeps its own text: its marked
  // block is replaced, or added when the file does not import AGENTS.md yet.
  const agents = read(src('AGENTS.md'));
  if (!self) {
    upsertBlock('AGENTS.md', BLOCK_START, BLOCK_END, branch(between(agents, BLOCK_START, BLOCK_END)));
    if (cfg.codegraph) upsertBlock('AGENTS.md', CG_START, CG_END, between(agents, CG_START, CG_END), { onlyIfMissing: true });
    for (const rel of ['CLAUDE.md', 'GEMINI.md']) {
      const text = read(dest(rel));
      const tpl = read(src(rel)) ?? '';
      const body = tpl.includes(BLOCK_START) ? between(tpl, BLOCK_START, BLOCK_END) : '@AGENTS.md';
      if (text === null) write(rel, '@AGENTS.md\n', 'create');
      else if (text.includes(BLOCK_START) || !/^@AGENTS\.md\s*$/m.test(text)) upsertBlock(rel, BLOCK_START, BLOCK_END, body);
    }
  }

  // Claude Code hooks and permissions. The project's own entries are kept. Entries that run a template
  // script (scripts/hooks/*.mjs) are template-owned: they are replaced by this version's, so a changed
  // matcher arrives and a hook the template dropped goes away. CodeGraph-only hooks are skipped with
  // --no-codegraph; the board hooks (session start, worker delegation) are not.
  const tpl = JSON.parse(read(src('.claude/settings.json')));
  const codegraphOnly = /codegraph-first/;
  const ours = (h) => /scripts[\/]hooks[\/][\w-]+\.mjs/.test(h?.command ?? '');
  mergeJson('.claude/settings.json', (s) => {
    s.permissions ??= {};
    s.permissions.allow = [...new Set([...(s.permissions.allow ?? []), ...(cfg.codegraph ? tpl.permissions.allow : [])])];
    s.hooks ??= {};
    for (const event of Object.keys(s.hooks)) {
      s.hooks[event] = (s.hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
      if (!s.hooks[event].length) delete s.hooks[event];
    }
    for (const [event, groups] of Object.entries(tpl.hooks)) {
      for (const g of groups) {
        if (!cfg.codegraph && g.hooks.some((h) => codegraphOnly.test(h.command))) continue;
        (s.hooks[event] ??= []).push(g);
      }
    }
    // "codegraph install" adds its own UserPromptSubmit hook. It injects symbol source into every prompt,
    // also prompts that are not about code. The template no longer ships one (docs/codegraph.md).
    const promptHook = (s.hooks.UserPromptSubmit ?? []).some((g) => (g.hooks ?? []).some((h) => /codegraph(\.cmd)?["']?\s+prompt-hook/.test(h.command ?? '')));
    if (promptHook) manual.push('.claude/settings.json has a "codegraph prompt-hook" UserPromptSubmit hook (added by "codegraph install"). It adds symbol source to every prompt, also prompts that are not about code. Remove it unless you want that; see docs/codegraph.md in the template.');
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

  appendLines('.gitignore', ['.claude/settings.local.json', SCRIPT_WRITES_FILE]);
  appendLines('.gitattributes', ['scripts/git-hooks/* text eol=lf']);

  // Git hooks: only take over core.hooksPath when nothing else owns it. pre-commit checks the board for
  // every provider; the post-* hooks sync CodeGraph and do nothing without it.
  if (!flag('no-git-hooks')) {
    const hp = git('-C', DEST, 'config', '--get', 'core.hooksPath').stdout.trim();
    const other = ['.husky', 'lefthook.yml', '.pre-commit-config.yaml'].find((f) => fs.existsSync(dest(f)));
    if (hp === 'scripts/git-hooks') {
      // already set
    } else if (hp || other) {
      manual.push(`Git hooks are managed by ${hp ? `core.hooksPath=${hp}` : other}. Call scripts/git-hooks/pre-commit and post-{checkout,merge,rewrite} from your own hooks.`);
    } else if (top.status === 0) {
      log.push('git      config core.hooksPath scripts/git-hooks');
      if (!dryRun) git('-C', DEST, 'config', 'core.hooksPath', 'scripts/git-hooks');
    }
  }

  write(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', saved.version ? 'update' : 'create');
  if (!dryRun && Object.keys(scriptWrites).length) recordScriptWrites(DEST, scriptWrites);

  // Board data: scripts/kanban/migrate.mjs brings board.json to this version's schema, in place, and renders it.
  const migrated = self ? null : migrateBoard();

  console.log(`${dryRun ? '[dry run] ' : ''}Scrum Kanban ${PKG.version} ${isUpgrade ? 'upgrade' : 'install'} into ${DEST}`);
  console.log(log.length ? log.map((l) => '  ' + l).join('\n') : '  nothing to change');
  for (const m of manual) console.log(`  manual   ${m}`);
  if (migrated?.trim()) console.log(migrated.trimEnd());
  if (!isUpgrade && !dryRun) {
    console.log('\nNext steps:');
    if (cfg.codegraph) console.log('  1. Install CodeGraph, then run: codegraph install && codegraph init -y   (optional; see docs/codegraph.md in the template)');
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
  }
  // "codegraph install" adds its own prompt hook; the template ships none since 0.9 (docs/codegraph.md).
  const settings = read(dest('.claude/settings.json')) ?? '';
  ok(!/codegraph(.cmd)?[\\"']*s+prompt-hook/.test(settings), '.claude/settings.json has no "codegraph prompt-hook" UserPromptSubmit hook', 'Optional. It adds symbol source to every prompt, also prompts that are not about code. Remove the entry unless you want that.');
  const hp = git('-C', DEST, 'config', '--get', 'core.hooksPath').stdout.trim();
  ok(hp === 'scripts/git-hooks', `core.hooksPath = ${hp || '(unset)'}`, 'Recommended: the pre-commit board check works for every provider. Run: git config core.hooksPath scripts/git-hooks');
  // Which models count as each tier, and what the Claude Code aliases resolve to in this shell.
  const tiers = loadTierModels(DEST);
  ok(!tiers.problem, `tier map (${tiers.source}): ${TIERS.map((k) => `${k} = ${tiers.models[k].join(' | ')}`).join('; ')}`, `Fix docs/kanban/tiers.json: ${tiers.problem}`);
  for (const tier of TIERS) {
    const alias = aliasForTier(tier, tiers.models);
    const { model, via } = resolveClaudeAlias(alias ?? '');
    ok(!!alias, `Claude Code tier ${tier}: ${alias ? `model "${alias}"${via ? ` runs ${model} (${via})` : ''}` : 'no alias resolves to a listed model'}`,
      'Optional, for Claude Code workers. List the model your alias runs in docs/kanban/tiers.json, or set ANTHROPIC_DEFAULT_<ALIAS>_MODEL. See docs/kanban/providers.md.');
  }
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    const m = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    ok(TIERS.every((k) => modelFitsTier(m, k, tiers.models)), `CLAUDE_CODE_SUBAGENT_MODEL=${m} forces every worker onto one model`, 'Workers on other tiers will be denied. Unset it, or see docs/kanban/providers.md.');
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
