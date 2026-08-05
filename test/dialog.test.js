import assert from 'node:assert/strict';
import test from 'node:test';

import { useTempStore } from './helpers.js';

useTempStore();
const { parseDialog } = await import('../src/dialog.js');

/**
 * Captured verbatim from a real Claude Code permission prompt in a 58-column zellij pane
 * (zellij 0.44.3, Claude Code 2.1.221). The narrow width is the point: it wraps option 2's
 * label onto a continuation line, which is exactly what a naive parser truncates.
 */
const REAL_PROMPT = [
  '  Running 1 shell command…',
  '  ⎿  $ printf hello >',
  '     /Users/me/Documents/ap-perm-test.txt',
  '──────────────────────────────────────────────────────────',
  ' Bash command',
  '   printf hello >',
  '   /Users/me/Documents/ap-perm-test.txt',
  '   Write test file in working directory',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to Documents/ from this',
  '      project',
  '   3. No',
  ' Esc to cancel · Tab to amend · ctrl+e to explain',
].join('\n');

const NO_DIALOG = [
  '⏺ Replied 42 to the arithmetic question.',
  '──────────────────────────────── scratch ──',
  '❯ ',
  '──────────────────────────────────────────',
  '  Opus 5 (1M context)',
].join('\n');

test('detects a real permission prompt', () => {
  const d = parseDialog(REAL_PROMPT);
  assert.equal(d.hasDialog, true);
  assert.equal(d.title, 'Do you want to proceed?');
});

test('finds all three options and which is selected', () => {
  const d = parseDialog(REAL_PROMPT);
  assert.deepEqual(d.options.map((o) => o.n), [1, 2, 3]);
  assert.equal(d.options[0].label, 'Yes');
  assert.equal(d.options[0].selected, true);
  assert.equal(d.options[2].label, 'No');
  assert.equal(d.options.filter((o) => o.selected).length, 1);
});

test('joins a wrapped option label instead of truncating it', () => {
  // Approving from a half-read label is the failure this guards against.
  const d = parseDialog(REAL_PROMPT);
  assert.equal(d.options[1].label, 'Yes, and always allow access to Documents/ from this project');
});

test('captures what is actually being requested, not just the question', () => {
  const d = parseDialog(REAL_PROMPT);
  const body = d.body.join(' ');
  assert.match(body, /Bash command/);
  assert.match(body, /printf hello/);
  assert.match(body, /ap-perm-test\.txt/);
  assert.match(body, /Write test file in working directory/);
  // The pre-dialog scrollback above the rule must not leak into the request.
  assert.ok(!body.includes('Running 1 shell command'));
});

test('reports no dialog when the agent is just at its prompt', () => {
  const d = parseDialog(NO_DIALOG);
  assert.equal(d.hasDialog, false);
  assert.deepEqual(d.options, []);
});

test('a numbered list in ordinary output is not mistaken for a dialog', () => {
  // This is the dangerous false positive: if this read as a dialog, pressing "1" would type a
  // stray digit into the agent's prompt and send it as a message.
  const d = parseDialog(
    ['⏺ Here are the steps:', '  1. read the file', '  2. write the file', '', '❯ '].join('\n'),
  );
  assert.equal(d.hasDialog, false, 'numbered lines alone must not count as a prompt');
  assert.equal(d.title, null);
});

test('a dialog with no question line is still detected via its cancel footer', () => {
  const d = parseDialog(
    [
      '─────────────────────────────',
      ' Edit file',
      ' ❯ 1. Allow',
      '   2. Deny',
      ' Esc to cancel',
    ].join('\n'),
  );
  assert.equal(d.hasDialog, true);
});

/**
 * Also captured verbatim from a live blocked agent. The second option is prefixed with a scroll
 * arrow rather than a space, which a naive prefix class skips entirely - leaving one option
 * visible and the dialog looking unanswerable.
 */
const SCROLLED_PROMPT = [
  ' Read file',
  '  Read(/Users/me/.claude/agentphone/payloads',
  '  /msg_0msg49aut26c1f9a3de.md)',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  ' ↓ 2. Yes, allow reading from payloads/ during this session',
  ' Esc to cancel · Tab to amend',
].join('\n');

test('an option behind a scroll arrow is still parsed', () => {
  const d = parseDialog(SCROLLED_PROMPT);
  assert.equal(d.hasDialog, true);
  assert.deepEqual(d.options.map((o) => o.n), [1, 2]);
  assert.equal(d.options[1].label, 'Yes, allow reading from payloads/ during this session');
});

test('a scrolled option list is flagged as incomplete', () => {
  // Approving against a partially visible list is the mistake this flag prevents.
  assert.equal(parseDialog(SCROLLED_PROMPT).scrolled, true);
  assert.equal(parseDialog(REAL_PROMPT).scrolled, false);
});

test('a single option is not enough to act on', () => {
  const d = parseDialog(['─────', ' Do you want to proceed?', ' ❯ 1. Yes'].join('\n'));
  assert.equal(d.hasDialog, false);
});
