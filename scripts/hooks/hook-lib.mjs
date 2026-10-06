// Helpers shared by the Claude Code hooks: hook input, decisions, and transcript lookups.

import fs from 'node:fs';
import path from 'node:path';

export async function readEvent() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
}

// Lets the call run and shows a note to the user and the model.
export function allowWithNote(note) {
  process.stdout.write(JSON.stringify({ systemMessage: note, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } }));
  process.exit(0);
}

// The transcript of the agent that made the call. Sub-agents share the parent's session_id, and their
// transcript lives next to the parent's; never use the parent's transcript for a sub-agent.
export function agentTranscript(event) {
  if (!event.agent_id || /[\\/]subagents[\\/]/.test(event.transcript_path ?? '')) return event.transcript_path;
  return path.join(path.dirname(event.transcript_path ?? ''), event.session_id ?? '', 'subagents', `agent-${event.agent_id}.jsonl`);
}

// The model of the latest assistant reply in a transcript (JSONL), read from its last 512 KB. Main-session
// transcripts skip sidechain lines; a sub-agent transcript has only those. This is the model the API
// really answered with, so it shows LiteLLM routing, alias remaps, and fallbacks. Null when unknown.
export function lastModel(transcript, { sidechain = false } = {}) {
  try {
    const fd = fs.openSync(transcript, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8').split('\n').reverse()) {
      if (!line.includes('"assistant"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'assistant' && !!e.isSidechain === sidechain && e.message?.model && e.message.model !== '<synthetic>') return e.message.model;
      } catch {}
    }
  } catch {}
  return null;
}
