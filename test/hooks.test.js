import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { useTempStore } from './helpers.js';

const STORE = useTempStore();
const { create } = await import('../src/envelope.js');
const store = await import('../src/store.js');

const AP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ap');

const base = {
  from: { handle: 'caller', agent_id: 'sess-caller', cwd: '/tmp/caller' },
  to: { handle: 'target', agent_id: 'sess-target', cwd: '/tmp/target' },
};

/** Invoke a hook exactly as Claude Code does: JSON on stdin, JSON on stdout. */
function hook(event, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AP, 'hook', event], {
      env: { ...process.env, AGENTPHONE_HOME: STORE },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout.trim() || '{}'));
      } catch {
        reject(new Error(`hook ${event} emitted non-JSON: ${stdout}\n${stderr}`));
      }
    });
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

test('stop hook blocks and injects when mail is waiting', async () => {
  const session = 'sess-stop-a';
  store.enqueue(session, create({ ...base, body: 'the auth contract changed' }));

  const res = await hook('stop', { session_id: session, stop_hook_active: false });
  assert.equal(res.decision, 'block');
  assert.match(res.reason, /the auth contract changed/);
  assert.match(res.reason, /not from your user/);
});

test('stop hook honours stop_hook_active and refuses to block again', async () => {
  const session = 'sess-stop-b';
  store.enqueue(session, create({ ...base, body: 'should not be delivered now' }));

  const res = await hook('stop', { session_id: session, stop_hook_active: true });
  assert.deepEqual(res, {}, 'a second consecutive block would loop the agent');
  // The message must stay queued rather than being silently consumed.
  assert.equal(store.pending(session).length, 1);
});

test('stop hook emits nothing when the inbox is empty', async () => {
  const res = await hook('stop', { session_id: 'sess-stop-empty', stop_hook_active: false });
  assert.deepEqual(res, {});
});

test('stop hook batches all queued mail into a single block', async () => {
  const session = 'sess-stop-batch';
  for (const body of ['first thing', 'second thing', 'third thing']) {
    store.enqueue(session, create({ ...base, body }));
  }
  const res = await hook('stop', { session_id: session, stop_hook_active: false });
  assert.equal(res.decision, 'block');
  assert.match(res.reason, /You have 3 messages/);
  assert.match(res.reason, /first thing/);
  assert.match(res.reason, /third thing/);
  assert.equal(store.pending(session).length, 0);
});

test('user-prompt-submit injects via additionalContext, not a block', async () => {
  const session = 'sess-prompt';
  store.enqueue(session, create({ ...base, body: 'fyi the build is red' }));

  const res = await hook('user-prompt-submit', { session_id: session, prompt: 'hello' });
  assert.equal(res.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(res.hookSpecificOutput.additionalContext, /fyi the build is red/);
  assert.ok(!res.decision, 'a user prompt must not be blocked');
});

test('post-tool-use surfaces urgent mail only', async () => {
  const session = 'sess-ptu';
  store.enqueue(session, create({ ...base, body: 'can wait', priority: 'normal' }));
  store.enqueue(session, create({ ...base, body: 'CI is red on main', priority: 'urgent' }));

  const res = await hook('post-tool-use', { session_id: session, tool_name: 'Read' });
  assert.match(res.hookSpecificOutput.additionalContext, /CI is red on main/);
  assert.ok(!/can wait/.test(res.hookSpecificOutput.additionalContext), 'normal mail must wait for a turn boundary');
  assert.equal(store.pending(session).length, 1);
});

test('post-tool-use stays silent with no urgent mail', async () => {
  const session = 'sess-ptu-quiet';
  store.enqueue(session, create({ ...base, body: 'normal only' }));
  const res = await hook('post-tool-use', { session_id: session, tool_name: 'Read' });
  assert.deepEqual(res, {});
});

test('a malformed hook payload never breaks the session', async () => {
  assert.deepEqual(await hook('stop', 'this is not json'), {});
});
