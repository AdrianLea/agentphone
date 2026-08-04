import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { useTempStore } from './helpers.js';

const STORE = useTempStore();
const { create } = await import('../src/envelope.js');
const { urgentMarker } = await import('../src/paths.js');
const store = await import('../src/store.js');

const base = {
  from: { handle: 'caller', agent_id: 'sess-caller', cwd: '/tmp/caller' },
  to: { handle: 'target', agent_id: 'sess-target', cwd: '/tmp/target' },
};
const msg = (body, extra = {}) => create({ ...base, body, ...extra });

test('enqueue then claim delivers once and only once', () => {
  const agent = 'agent-claim';
  store.enqueue(agent, msg('one'));
  store.enqueue(agent, msg('two'));
  assert.equal(store.pending(agent).length, 2);

  const first = store.claim(agent);
  assert.equal(first.length, 2);
  // Claiming moves messages out of the inbox before anything is emitted, so a repeated
  // hook invocation cannot redeliver them.
  assert.equal(store.pending(agent).length, 0);
  assert.equal(store.claim(agent).length, 0);
});

test('claim honours the per-turn cap and preserves order', () => {
  const agent = 'agent-cap';
  for (const b of ['a', 'b', 'c', 'd']) store.enqueue(agent, msg(b));
  const got = store.claim(agent, { cap: 2 });
  assert.deepEqual(got.map((m) => m.body), ['a', 'b']);
  assert.equal(store.pending(agent).length, 2);
});

test('a selective claim leaves unrelated messages queued', () => {
  // Regression: a positional cap would claim whatever was queued first and then discard it,
  // silently destroying a normal message that sat ahead of an urgent one.
  const agent = 'agent-selective';
  store.enqueue(agent, msg('normal first'));
  store.enqueue(agent, msg('urgent second', { priority: 'urgent' }));

  const got = store.claim(agent, { where: (m) => m.priority === 'urgent' });
  assert.deepEqual(got.map((m) => m.body), ['urgent second']);
  assert.deepEqual(store.pending(agent).map((m) => m.body), ['normal first']);
});

test('expired messages are retired rather than delivered', () => {
  const agent = 'agent-expiry';
  store.enqueue(agent, msg('stale', { expiresInS: -10 }));
  store.enqueue(agent, msg('fresh'));
  const got = store.pending(agent);
  assert.deepEqual(got.map((m) => m.body), ['fresh']);
});

test('the urgent marker tracks urgent mail only', () => {
  const agent = 'agent-urgent';
  const marker = urgentMarker(agent);
  store.enqueue(agent, msg('normal'));
  assert.ok(!fs.existsSync(marker), 'normal mail must not set the fast-path marker');

  store.enqueue(agent, msg('urgent one', { priority: 'urgent' }));
  assert.ok(fs.existsSync(marker));

  store.claim(agent);
  assert.ok(!fs.existsSync(marker), 'marker must clear once urgent mail is drained');
});

test('requeue puts a delivered message back', () => {
  const agent = 'agent-requeue';
  const m = msg('again');
  store.enqueue(agent, m);
  store.claim(agent);
  assert.equal(store.pending(agent).length, 0);
  assert.ok(store.requeue(agent, m.id).ok);
  assert.equal(store.pending(agent).length, 1);
  assert.ok(!store.requeue(agent, 'msg_nonexistent').ok);
});

test('hop limit stops a ping-pong thread', () => {
  const m = msg('bounce');
  assert.ok(store.checkHops(m.thread, 1).ok);
  assert.ok(!store.checkHops(m.thread, 99).ok);

  // Walk a thread up to the configured ceiling, as two agents replying would.
  for (let hop = 1; hop <= 4; hop += 1) {
    store.recordThreadMessage({ ...m, id: `msg_h${hop}`, hop });
  }
  const blocked = store.checkHops(m.thread, 5);
  assert.ok(!blocked.ok);
  assert.match(blocked.reason, /hop limit|already at hop limit/);
});

test('rate limit trips after the configured burst', () => {
  const target = 'agent-rate';
  for (let i = 0; i < 6; i += 1) {
    assert.ok(store.checkRate(target).ok, `send ${i + 1} should be allowed`);
    store.noteSend(target);
  }
  const blocked = store.checkRate(target);
  assert.ok(!blocked.ok);
  assert.match(blocked.reason, /rate limit/);
});

test('threads record participants and a reply is findable', () => {
  const request = msg('question', { type: 'ask' });
  store.recordThreadMessage(request);
  const reply = create({
    ...base,
    body: 'answer',
    type: 'reply',
    thread: request.thread,
    inReplyTo: request.id,
    hop: 2,
  });
  store.recordThreadMessage(reply);

  const found = store.latestReply(request.thread, request.id);
  assert.equal(found.body, 'answer');
  assert.equal(store.threadMeta(request.thread).hops, 2);
});

test('waitForReply resolves as soon as a reply is recorded', async () => {
  const request = msg('slow question', { type: 'ask' });
  store.recordThreadMessage(request);
  setTimeout(() => {
    store.recordThreadMessage(
      create({ ...base, body: 'eventual', type: 'reply', thread: request.thread, inReplyTo: request.id, hop: 2 }),
    );
  }, 500);
  const reply = await store.waitForReply(request.thread, request.id, 5000);
  assert.equal(reply?.body, 'eventual');
});

test('waitForReply gives up at the timeout', async () => {
  const request = msg('unanswered', { type: 'ask' });
  store.recordThreadMessage(request);
  assert.equal(await store.waitForReply(request.thread, request.id, 600), null);
});

test('the store is created with 0700 permissions', () => {
  assert.equal(fs.statSync(STORE).mode & 0o777, 0o700);
});
