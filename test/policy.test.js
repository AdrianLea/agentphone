import assert from 'node:assert/strict';
import test from 'node:test';

import { useTempStore } from './helpers.js';

useTempStore();
const { BUILTIN, DEFAULT_POLICY, listPolicies, loadPolicy, savePolicy, toClaudeArgs } =
  await import('../src/policy.js');

test('every built-in policy leaves the agent able to talk', () => {
  // Without this an agent cannot run `ap reply`, so it cannot answer and the deadlock returns.
  // Two ways to satisfy it: an explicit allow, or a mode that auto-approves everything.
  for (const [name, p] of Object.entries(BUILTIN)) {
    const runnable = p.allow.includes('Bash(ap:*)') || p.mode === 'bypassPermissions';
    assert.ok(runnable, `${name} must leave ap runnable`);
  }
});

test('no policy denies ap, because a deny would win even in bypass mode', () => {
  // Deny rules survive bypassPermissions, so denying ap would silently mute the agent.
  for (const [name, p] of Object.entries(BUILTIN)) {
    assert.ok(!(p.deny ?? []).some((d) => /\bap\b/.test(d)), `${name} must not deny ap`);
  }
});

test('the default policy never prompts on routine work', () => {
  const p = loadPolicy(DEFAULT_POLICY);
  for (const tool of ['Bash', 'Write', 'Edit', 'Read']) {
    assert.ok(p.allow.includes(tool), `${tool} must be pre-authorised or the agent will block`);
  }
});

test('the default policy does not use bypassPermissions', () => {
  // Bypass opens a per-launch confirmation dialog with no persisted acceptance, so an agent
  // launched that way never reaches SessionStart and never registers. A broad allowlist reaches
  // the same no-prompt behaviour and keeps the deny floor.
  assert.notEqual(loadPolicy(DEFAULT_POLICY).mode, 'bypassPermissions');
  const args = toClaudeArgs(loadPolicy(DEFAULT_POLICY));
  assert.ok(!args.includes('bypassPermissions'));
});

test('the deny floor holds under every policy, including the permissive one', () => {
  for (const [name, p] of Object.entries(BUILTIN)) {
    for (const d of ['Bash(rm -rf:*)', 'Bash(sudo:*)', 'Read(~/.ssh/**)', 'Write(~/.claude/**)']) {
      assert.ok((p.deny ?? []).includes(d), `${name} must keep ${d} denied`);
    }
  }
});

test('a permissive allow cannot reach credentials or its own guardrails', () => {
  // The allowlist says Bash/Write/Edit broadly; the deny rules are what stop those reaching
  // ~/.ssh and ~/.claude, and deny survives every permission mode.
  const args = toClaudeArgs(loadPolicy(DEFAULT_POLICY));
  const denied = args.filter((a, i) => args[i - 1] === '--disallowedTools');
  assert.ok(denied.includes('Read(~/.ssh/**)'));
  assert.ok(denied.includes('Write(~/.claude/**)'));
});

test('policies map onto claude allow/deny flags', () => {
  const args = toClaudeArgs(loadPolicy('reader'));
  assert.ok(args.includes('--allowedTools'));
  assert.ok(args.includes('--disallowedTools'));
  assert.ok(args.includes('Read'));
  assert.ok(args.includes('Bash(git push:*)'));
});

test('a deny beats an allow for the same pattern', () => {
  // Silently granting something explicitly forbidden is the worse failure.
  const args = toClaudeArgs({ allow: ['Bash(rm -rf:*)', 'Read'], deny: ['Bash(rm -rf:*)'] });
  const allowed = args.filter((a, i) => args[i - 1] === '--allowedTools');
  assert.deepEqual(allowed, ['Read']);
  assert.ok(args.filter((a, i) => args[i - 1] === '--disallowedTools').includes('Bash(rm -rf:*)'));
});

test('no policy means no flags, so the agent inherits your defaults', () => {
  assert.deepEqual(toClaudeArgs(null), []);
});

test('extra --allow patterns are merged in', () => {
  const args = toClaudeArgs(loadPolicy('messenger'), { extraAllow: ['Bash(pytest:*)'] });
  assert.ok(args.includes('Bash(pytest:*)'));
});

test('a user policy overrides a built-in of the same name', () => {
  savePolicy('reader', { description: 'mine', allow: ['Bash(ap:*)'], deny: [] });
  const p = loadPolicy('reader');
  assert.equal(p.source, 'user');
  assert.equal(p.description, 'mine');
  assert.ok(listPolicies().some((x) => x.name === 'reader' && x.source === 'user'));
});

test('an unknown policy does not silently become permissive', () => {
  assert.equal(loadPolicy('does-not-exist'), null);
});
