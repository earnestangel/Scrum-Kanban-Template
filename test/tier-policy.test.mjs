import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryRe } from '../scripts/kanban/board-lib.mjs';
import { DEFAULT_TIER_MODELS, aliasForTier, modelFitsTier, resolveClaudeAlias, tierModelsProblem, tiersOfModel } from '../scripts/kanban/tier-policy.mjs';
import { LUNA } from './helpers.mjs';

test('modelFitsTier matches whole IDs, case-insensitively, with * across "/"', () => {
  const m = { large: ['*opus*'], medium: ['*sonnet*', '*gpt-6-luna'], small: ['*haiku*'] };
  assert.ok(modelFitsTier('claude-opus-5-5', 'large', m));
  assert.ok(modelFitsTier('bedrock/global.anthropic.claude-OPUS-5-5', 'large', m));
  assert.ok(modelFitsTier(LUNA, 'medium', m));
  assert.ok(!modelFitsTier(`${LUNA}-preview`, 'medium', m));
  assert.ok(!modelFitsTier(LUNA, 'large', m));
  assert.ok(!modelFitsTier(null, 'large', m));
  assert.deepEqual(tiersOfModel('claude-sonnet-5-5'), ['medium']);
  assert.ok(modelFitsTier('gpt.6', 'large', { large: ['gpt.6'] }) && !modelFitsTier('gptx6', 'large', { large: ['gpt.6'] }));
});

test('resolveClaudeAlias follows Claude Code env remaps', () => {
  assert.deepEqual(resolveClaudeAlias('sonnet', {}), { model: 'sonnet', via: null });
  assert.deepEqual(resolveClaudeAlias('sonnet', { ANTHROPIC_DEFAULT_SONNET_MODEL: LUNA }), { model: LUNA, via: 'ANTHROPIC_DEFAULT_SONNET_MODEL' });
  assert.equal(resolveClaudeAlias('opus', { CLAUDE_CODE_SUBAGENT_MODEL: 'x', ANTHROPIC_DEFAULT_OPUS_MODEL: 'y' }).model, 'x');
  assert.equal(resolveClaudeAlias(LUNA, { ANTHROPIC_DEFAULT_SONNET_MODEL: 'z' }).model, LUNA);
});

test('aliasForTier picks an alias whose resolved model fits', () => {
  assert.equal(aliasForTier('medium', DEFAULT_TIER_MODELS, {}), 'sonnet');
  const m = { large: ['*opus*'], medium: ['*gpt-6-luna'], small: ['*haiku*'] };
  assert.equal(aliasForTier('medium', m, {}), null);
  assert.equal(aliasForTier('medium', m, { ANTHROPIC_DEFAULT_SONNET_MODEL: LUNA }), 'sonnet');
  assert.equal(aliasForTier('medium', m, { ANTHROPIC_DEFAULT_HAIKU_MODEL: LUNA }), 'haiku');
});

test('tierModelsProblem rejects bad maps', () => {
  assert.equal(tierModelsProblem({ tiers: DEFAULT_TIER_MODELS }), null);
  assert.match(tierModelsProblem({}), /tiers/);
  assert.match(tierModelsProblem({ tiers: { ...DEFAULT_TIER_MODELS, huge: ['x'] } }), /unknown tier/);
  assert.match(tierModelsProblem({ tiers: { ...DEFAULT_TIER_MODELS, small: [] } }), /small/);
});

test('entryRe accepts common separators and requires a date', () => {
  for (const sep of ['·', '-', '|', '•', '–']) {
    assert.ok(entryRe('PROGRESS', 'REVIEW').test(`## PROGRESS ${sep} 2026-10-06T10:00:00Z ${sep} luna-medium ${sep} REVIEW`), sep);
  }
  assert.ok(entryRe('GROOMING').test('## GROOMING · 2026-10-06 · claude-large'));
  assert.ok(!entryRe('GROOMING').test('## GROOMING · YYYY-MM-DD · x'));
  assert.ok(!entryRe('PROGRESS', 'REVIEW').test('## PROGRESS · 2026-10-06 · w · PAUSED'));
});
