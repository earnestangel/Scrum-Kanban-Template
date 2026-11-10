#!/usr/bin/env node
// Claude Code PreToolUse hook: CodeGraph before grep, for code only.
//
// It covers a lookup whose target is source code: Grep and Glob over code, a whole-file Read of a source
// file, and Bash/PowerShell commands that search code (grep, rg, find, Select-String, ...) or dump whole
// source files (cat, Get-Content, ...). When the project has a .codegraph/ index and the agent has not
// called CodeGraph yet, the first such call per agent is denied with a reminder. Later calls pass, so agents
// can still fall back when CodeGraph returns nothing.
//
// It never fires on text that is not code: Markdown, ADRs, handover notes, JSON, YAML, logs, and anything
// under docs/, .github/, or .claude/. CodeGraph indexes symbols, so it has nothing to say about those, and
// a deny there only costs a tool call. A ranged Read (offset/limit) always passes: Edit needs a prior Read,
// and a ranged one is the cheap way to satisfy it.
//
// This hook is a safety net. The rule itself is in the Worker Procedure (protocol 6.5 step 5) and holds on
// every provider: run the ticket's context.codegraph_queries before any other code search.
//
// CODEGRAPH_FIRST=strict denies every such call until CodeGraph has been used; =off disables the hook.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentTranscript } from './hook-lib.mjs';

const mode = process.env.CODEGRAPH_FIRST ?? 'remind';
if (mode === 'off') process.exit(0);

let input = '';
for await (const chunk of process.stdin) input += chunk;
let event;
try {
  event = JSON.parse(input);
} catch {
  process.exit(0);
}

const CODE_EXT = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|cs|c|cc|cpp|h|hpp|php|rb|swift|scala|vue|svelte)(?![\w-])/i;
// Text CodeGraph does not index.
const DOC_EXT = /\.(mdx?|markdown|txt|rst|adoc|json[c5]?|ya?ml|toml|ini|env|csv|tsv|log|lock|svg|html?|xml|sql)(?![\w-])/i;
const DOC_DIR = /(^|[\s"'=(\\/])(docs?|\.github|\.claude|\.codegraph|node_modules)[\\/]/i;
const DOC_TYPE = /^(md|markdown|json|yaml|yml|toml|txt|html|xml|csv|sql|log)$/i;
const SEARCH_CMD = /(^|[\s;&|(])(grep|egrep|rg|ag|ack|find|findstr|select-string|sls|git\s+grep)(\s|$)|get-childitem\b[^|;]*-recurse|\b(gci|dir|ls)\s+-r/i;
const DUMP_CMD = /(^|[\s;&|(])(cat|head|tail|less|more|type|get-content|gc)\s/i;
// A target is "not code" when it names a docs folder or a text extension, and no source extension.
const notCode = (s) => !!s && !CODE_EXT.test(s) && (DOC_EXT.test(s) || DOC_DIR.test(s));

const tool = event.tool_name;
const ti = event.tool_input ?? {};
const isCodeLookup = () => {
  if (tool === 'Grep') return !(DOC_TYPE.test(ti.type ?? '') || notCode(ti.glob) || notCode(ti.path));
  if (tool === 'Glob') return !(notCode(ti.pattern) || notCode(ti.path));
  if (tool === 'Read') return CODE_EXT.test(ti.file_path ?? '') && !DOC_DIR.test(ti.file_path ?? '') && ti.offset == null && ti.limit == null;
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = ti.command ?? '';
    if (DUMP_CMD.test(cmd) && CODE_EXT.test(cmd)) return true;
    return SEARCH_CMD.test(cmd) && !notCode(cmd);
  }
  return false;
};
if (!isCodeLookup()) process.exit(0);

const cwd = event.cwd ?? process.cwd();
const findIndex = (dir) => {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.codegraph', 'codegraph.db'))) return d;
    if (path.dirname(d) === d) return null;
  }
};
const indexRoot = findIndex(cwd);
if (!indexRoot) process.exit(0);

// Sub-agents share the parent's session_id, so key the marker on agent_id too: each worker gets its
// own reminder. agentTranscript never returns the parent's transcript for a sub-agent, or a
// coordinator's codegraph call would exempt every worker.
const who = `${event.session_id ?? 'nosession'}-${event.agent_id ?? 'main'}`.replace(/[^\w.-]/g, '_');
const tmp = os.tmpdir();
const marker = path.join(tmp, `codegraph-first-${who}`);
const transcript = agentTranscript(event);
// Match an actual tool call (MCP or CLI), not a mention of the tool name in loaded instructions.
const usedCodegraph = () => {
  try {
    const t = fs.readFileSync(transcript ?? '', 'utf8');
    return /"name"\s*:\s*"mcp__codegraph__codegraph_\w+"/.test(t) || /"command"\s*:\s*"codegraph (explore|node|query|context)\b/.test(t);
  } catch {
    return false;
  }
};

if (usedCodegraph()) process.exit(0);
if (mode !== 'strict' && fs.existsSync(marker)) process.exit(0);
try {
  fs.writeFileSync(marker, '');
  // Drop markers older than a day so tmp does not fill up.
  const dayAgo = Date.now() - 86_400_000;
  for (const f of fs.readdirSync(tmp)) {
    if (!f.startsWith('codegraph-first-')) continue;
    const p = path.join(tmp, f);
    if (fs.statSync(p).mtimeMs < dayAgo) fs.rmSync(p, { force: true });
  }
} catch {}

const reason =
  `This project has a CodeGraph index (${path.join(indexRoot, '.codegraph')}). ` +
  `To locate or understand code, call codegraph_explore with projectPath="${indexRoot}" first ` +
  `(or run: codegraph explore "<symbols or question>"); it returns the verbatim source and call paths in one call. ` +
  `If the ticket has context.codegraph_queries, run those. Before an Edit, Read only the line range you need. ` +
  `Docs, ADRs, notes, JSON, and config are not code: read those directly, this hook does not stop that. ` +
  `Use ${tool} on code only when CodeGraph returned nothing` +
  (mode === 'strict' ? '.' : '; retrying this call will be allowed.');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }),
);
