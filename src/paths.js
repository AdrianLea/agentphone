import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// AGENTPHONE_HOME lets the test suite point at a throwaway store.
export const HOME = process.env.AGENTPHONE_HOME
  ? path.resolve(process.env.AGENTPHONE_HOME)
  : path.join(os.homedir(), '.claude', 'agentphone');

export const P = {
  root: HOME,
  config: path.join(HOME, 'config.json'),
  registry: path.join(HOME, 'registry'),
  inbox: path.join(HOME, 'inbox'),
  threads: path.join(HOME, 'threads'),
  payloads: path.join(HOME, 'payloads'),
  log: path.join(HOME, 'log'),
  tmp: path.join(HOME, '.tmp'),
};

export const DEFAULTS = {
  max_hops: 4,
  rate_per_min: 6,
  ask_timeout_s: 180,
  wait_timeout_s: 600,
  spawn_budget_usd: 0.5,
  expires_in_s: 4 * 3600,
  // A single typed line. Anything longer goes to payloads/ and is referenced by path,
  // because an embedded newline submits the prompt early (verified against zellij 0.44.3).
  max_body_chars: 1200,
  urgent_nudge: true,
  delivery_cap_per_turn: 10,
};

export function ensureStore() {
  for (const dir of [P.root, P.registry, P.inbox, P.threads, P.payloads, P.log, P.tmp]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // mkdir honours the mode only on creation; enforce it on an existing store too.
  try {
    fs.chmodSync(P.root, 0o700);
  } catch {}
}

let cachedConfig;
export function config() {
  if (cachedConfig) return cachedConfig;
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(P.config, 'utf8'));
  } catch {}
  cachedConfig = { ...DEFAULTS, ...onDisk };
  return cachedConfig;
}

export const inboxDir = (agentId) => path.join(P.inbox, agentId);
export const deliveredDir = (agentId) => path.join(P.inbox, agentId, 'delivered');
export const urgentMarker = (agentId) => path.join(P.inbox, agentId, '.urgent');
export const threadDir = (thread) => path.join(P.threads, thread);
