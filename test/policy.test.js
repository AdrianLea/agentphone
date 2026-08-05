import assert from 'node:assert/strict';
import test from 'node:test';

import { useTempStore } from './helpers.js';

useTempStore();
const { BUILTIN, DEFAULT_POLICY, listPolicies, loadPolicy, savePolicy, toClaudeArgs } =
  await import('../src/policy.js');

test('every built-in policy allows the agent to talk', () => {
  // Without this an agent cannot run `ap reply`, so it cannot answer and the deadlock returns.
  for (const [name, p] of Object.entries(BUILTIN)) {
    assert.ok(p.allow.includes('Bash(ap:*)'), `${name} must allow ap`);
  }
});

test('the default policy lets an agent read and reply without prompting', () => {
  const p = loadPolicy(DEFAULT_POLICY);
  for (const tool of ['Read', 'Grep', 'Glob', 'Bash(ap:*)']) assert.ok(p.allow.includes(tool));
  assert.ok(!p.allow.includes('Write'), 'the default must still ask before changing files');
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
