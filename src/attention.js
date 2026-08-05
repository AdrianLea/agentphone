import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { phonebook } from './registry.js';
import { pending } from './store.js';

export const PERMISSION = 'permission';
export const INPUT = 'input';
export const QUEUED = 'queued';

const RANK = { [PERMISSION]: 0, [INPUT]: 1, [QUEUED]: 2 };

/**
 * `claude agents --json` reports status but not when it changed. The per-pid session file it
 * reads from does carry statusUpdatedAt, so read it directly to show how long an agent has been
 * blocked. Missing or unreadable is fine - the duration is presentation only.
 */
function statusSince(pid) {
  if (!pid) return null;
  try {
    const file = path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number(parsed.statusUpdatedAt) || null;
  } catch {
    return null;
  }
}

/**
 * Two different kinds of "waiting" need two different affordances: a permission prompt needs a
 * keystroke (a message would just queue behind it), whereas an agent waiting on input needs an
 * actual answer. Everything else that needs you is queued mail, which needs a nudge.
 */
export function classify(agent) {
  if (agent.status !== 'waiting') return null;
  const reason = String(agent.waitingFor ?? '').toLowerCase();
  return /dialog|permission|approv|trust|confirm/.test(reason) ? PERMISSION : INPUT;
}

export async function attention({ refresh = true } = {}) {
  const book = await phonebook({ refresh });
  const items = [];

  for (const agent of book) {
    const kind = classify(agent);
    if (kind) {
      const since = statusSince(agent.pid);
      items.push({
        kind,
        handle: agent.handle,
        agent,
        detail: agent.waitingFor ?? 'waiting',
        since,
        waitedMs: since ? Math.max(0, Date.now() - since) : null,
      });
      continue;
    }
    const queued = pending(agent.sessionId);
    if (queued.length) {
      items.push({
        kind: QUEUED,
        handle: agent.handle,
        agent,
        detail: `${queued.length} queued message${queued.length > 1 ? 's' : ''}`,
        count: queued.length,
        messages: queued,
        since: null,
        waitedMs: null,
      });
    }
  }

  return items.sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || (b.waitedMs ?? 0) - (a.waitedMs ?? 0),
  );
}

export function humanDuration(ms) {
  if (ms == null) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  // A session left at a dialog for weeks is real; "359h34m" is just unreadable.
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

/** Fixed-width cell, so one long handle cannot shift every column after it. */
export function fit(text, width) {
  const s = String(text ?? '');
  return (s.length > width ? `${s.slice(0, width - 1)}…` : s).padEnd(width);
}

/** Which single-key actions make sense for an item, in the order the floater shows them. */
export function actionsFor(item) {
  if (item.kind === PERMISSION) return ['approve', 'deny', 'jump'];
  if (item.kind === INPUT) return ['reply', 'jump'];
  return ['wake', 'jump'];
}
