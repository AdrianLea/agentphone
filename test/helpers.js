import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every test runs against a throwaway store. AGENTPHONE_HOME must be set before any module
 * that reads it is imported, so tests import modules dynamically after calling this.
 */
export function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentphone-test-'));
  process.env.AGENTPHONE_HOME = dir;
  return dir;
}

export function fakeAgent(overrides = {}) {
  return {
    sessionId: 'sess-target',
    handle: 'target',
    cwd: '/tmp/target',
    kind: 'interactive',
    pid: process.pid,
    status: 'idle',
    waitingFor: null,
    name: 'target-session',
    zellij: { session: 'testsess', pane: 'terminal_9' },
    paneTitle: 'target-session',
    paneInferred: false,
    registered: true,
    reach: 'instant',
    startedAt: 1,
    ...overrides,
  };
}

export function fakeMe(overrides = {}) {
  return {
    handle: 'caller',
    sessionId: 'sess-caller',
    cwd: '/tmp/caller',
    zellij: { session: 'testsess', pane: 'terminal_1' },
    ...overrides,
  };
}
