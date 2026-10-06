// Standing model-tier rule (protocol.md section 1.2). A ticket's tier follows from its type and points;
// grooming does not choose it:
//   story or epic  → large  (Claude: Opus)
//   1 point        → small  (Claude: Haiku)
//   anything else  → medium (Claude: Sonnet)
// Only the user may set another tier, recorded on the ticket as "tier_override": { "tier", "reason" }.
//
// Which concrete models count as each tier is project data in docs/kanban/tiers.json, also user-owned.
// It lets a project run any provider or model (LiteLLM, Bedrock, OpenAI, Gemini, ...) under the same rule.
// render-board.mjs, ticket.mjs, the Claude Code hooks, and the installer share this module.

import fs from 'node:fs';
import path from 'node:path';

export const TIERS = ['small', 'medium', 'large'];
// Default Claude Code alias per tier, for the Agent tool's `model` and for messages.
export const CLAUDE_MODEL = { small: 'haiku', medium: 'sonnet', large: 'opus' };

// t.type is the ticket type ("story", "task", ...), derived from its board.json group.
export const policyTier = (t) => (t.type === 'story' || t.type === 'epic' ? 'large' : t.points === 1 ? 'small' : 'medium');

export const requiredTier = (t) => t.tier_override?.tier ?? policyTier(t);

// Returns why the ticket breaks the tier rule, or null. Closed tickets are history and are not checked.
export function tierProblem(t) {
  if (['DONE', 'ABANDONED'].includes(t.status)) return null;
  const o = t.tier_override;
  if (o != null && (!TIERS.includes(o.tier) || typeof o.reason !== 'string' || !o.reason.trim())) {
    return `tier_override needs "tier" (${TIERS.join(', ')}) and a "reason" that records the user's approval`;
  }
  const want = requiredTier(t);
  if (!t.model || t.model === want) return null;
  const rule = o ? 'its user-approved tier_override' : t.type === 'story' || t.type === 'epic' ? `the rule for a ${t.type}` : t.points === 1 ? 'the rule for 1 pt' : 'the rule for 2+ pts';
  return `model is "${t.model}", but ${rule} requires "${want}". Only the user may change it, with "tier_override": { "tier", "reason" } (protocol 1.2)`;
}

// ---------- tier → model map (docs/kanban/tiers.json) ----------

export const TIERS_FILE = 'docs/kanban/tiers.json';
// Used when the project has no tiers.json, or an invalid one: Claude models only, as before 0.7.
export const DEFAULT_TIER_MODELS = { large: ['*opus*'], medium: ['*sonnet*'], small: ['*haiku*'] };

// Returns why a parsed tiers.json is invalid, or null.
export function tierModelsProblem(obj) {
  const t = obj?.tiers;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'needs a "tiers" object: { "large": [...], "medium": [...], "small": [...] }';
  for (const k of Object.keys(t)) if (!TIERS.includes(k)) return `unknown tier "${k}"; use ${TIERS.join(', ')}`;
  for (const k of TIERS) {
    if (!Array.isArray(t[k]) || !t[k].length || !t[k].every((g) => typeof g === 'string' && g.trim())) {
      return `"tiers.${k}" must be a non-empty array of model ID patterns`;
    }
  }
  return null;
}

// { models, source, problem }. source is the file path or "default". An invalid file falls back to the
// defaults, so a broken edit never widens what counts as a tier; render-board.mjs reports the problem.
export function loadTierModels(root) {
  const file = path.join(root, TIERS_FILE);
  if (!fs.existsSync(file)) return { models: DEFAULT_TIER_MODELS, source: 'default', problem: null };
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { models: DEFAULT_TIER_MODELS, source: TIERS_FILE, problem: `not valid JSON: ${e.message}` };
  }
  const problem = tierModelsProblem(obj);
  return { models: problem ? DEFAULT_TIER_MODELS : obj.tiers, source: TIERS_FILE, problem };
}

// Patterns match the whole model ID, case-insensitively. "*" matches any run of characters, "/" included,
// and "?" one character. Example: "*gpt-6-luna" matches "bedrock/global.openai.gpt-6-luna".
const patternRe = (g) => new RegExp(`^${g.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

export const modelFitsTier = (model, tier, models = DEFAULT_TIER_MODELS) => !!model && (models[tier] ?? []).some((g) => patternRe(g).test(model));

export const tiersOfModel = (model, models = DEFAULT_TIER_MODELS) => TIERS.filter((tier) => modelFitsTier(model, tier, models));

// The model Claude Code really runs for an Agent dispatch. CLAUDE_CODE_SUBAGENT_MODEL wins over the
// per-call model; an alias (opus, sonnet, haiku, ...) follows ANTHROPIC_DEFAULT_<ALIAS>_MODEL when set.
// Returns { model, via }, where via names the env var that remapped it, or null.
export function resolveClaudeAlias(model, env = process.env) {
  if (env.CLAUDE_CODE_SUBAGENT_MODEL) return { model: env.CLAUDE_CODE_SUBAGENT_MODEL, via: 'CLAUDE_CODE_SUBAGENT_MODEL' };
  const key = /^[a-z]+$/i.test(model ?? '') && `ANTHROPIC_DEFAULT_${model.toUpperCase()}_MODEL`;
  if (key && env[key]) return { model: env[key], via: key };
  return { model, via: null };
}

// The first Claude Code alias whose resolved model fits the tier, the tier's default alias first; or null.
export function aliasForTier(tier, models = DEFAULT_TIER_MODELS, env = process.env) {
  const order = [CLAUDE_MODEL[tier], ...Object.values(CLAUDE_MODEL).filter((a) => a !== CLAUDE_MODEL[tier])];
  return order.find((a) => modelFitsTier(resolveClaudeAlias(a, env).model, tier, models)) ?? null;
}
