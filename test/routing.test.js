import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeAgent, useTempStore } from './helpers.js';

useTempStore();
const { canType } = await import('../src/agents.js');
const { chooseRoute } = await import('../src/resolve.js');
const { expectedTitleFor } = await import('../src/send.js');
const { projectDirFor } = await import('../src/spawn.js');
const { normalizePane } = await import('../src/zellij.js');

test('idle and busy sessions may be typed into', () => {
  assert.ok(canType({ status: 'idle' }).ok);
  assert.ok(canType({ status: 'busy' }).ok);
});

test('a session with a dialog open must never be typed into', () => {
  // Typing here would answer the permission dialog instead of sending a message.
  const res = canType({ status: 'waiting', waitingFor: 'dialog open' });
  assert.ok(!res.ok);
  assert.match(res.reason, /waiting\/dialog open/);
});

test('unknown status is refused rather than assumed safe', () => {
  assert.ok(!canType({ status: 'unknown' }).ok);
  assert.ok(!canType(null).ok);
});

test('route is pane for a reachable idle agent', () => {
  const r = chooseRoute(fakeAgent({ status: 'idle' }));
  assert.equal(r.route, 'pane');
  assert.match(r.reason, /immediately/);
});

test('route is pane but queued-at-turn-end for a busy agent', () => {
  const r = chooseRoute(fakeAgent({ status: 'busy' }));
  assert.equal(r.route, 'pane');
  assert.match(r.reason, /turn end/);
});

test('route falls back to mailbox when a dialog is open', () => {
  const r = chooseRoute(fakeAgent({ status: 'waiting', waitingFor: 'dialog open' }));
  assert.equal(r.route, 'mailbox');
  assert.match(r.reason, /dialog open/);
});

test('route falls back to mailbox with no pane', () => {
  const r = chooseRoute(fakeAgent({ zellij: null }));
  assert.equal(r.route, 'mailbox');
  assert.match(r.reason, /no zellij pane/);
});

test('a registered pane address is not title-checked', () => {
  // Regression: requiring a title match here rejected a legitimate delivery, because zellij's
  // pane name ("ap-peer") and the Claude session name ("ap-test-peer") differ. A registered id
  // came from inside that pane, and a closed pane kills its agent, so existence is proof enough.
  const target = fakeAgent({ paneInferred: false, name: 'ap-test-peer', paneTitle: 'ap-peer' });
  assert.equal(expectedTitleFor(target), null);
});

test('an inferred pane address is title-checked', () => {
  const target = fakeAgent({ paneInferred: true, name: 'checkout-flow-rework' });
  assert.equal(expectedTitleFor(target), 'checkout-flow-rework');
});

test('bare pane numbers are normalised to zellij form', () => {
  assert.equal(normalizePane('32'), 'terminal_32');
  assert.equal(normalizePane('terminal_32'), 'terminal_32');
  assert.equal(normalizePane('plugin_2'), 'plugin_2');
  assert.equal(normalizePane(undefined), null);
});

test('transcript directory matches Claude Code cwd escaping', () => {
  // Verified against the real layout: every non-alphanumeric character becomes a dash.
  assert.ok(projectDirFor('/Users/me/acme-api').endsWith('/-Users-me-acme-api'));
  // A leading dot collapses to a dash too, producing a doubled dash.
  assert.ok(projectDirFor('/Users/me/.config/ws').endsWith('/-Users-me--config-ws'));
  assert.ok(projectDirFor('/').endsWith('/-'));
});
