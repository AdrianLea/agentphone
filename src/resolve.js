import path from 'node:path';

import { canType } from './agents.js';
import { phonebook } from './registry.js';
import { expandPath, slug } from './util.js';

const looksLikePath = (spec) =>
  spec.startsWith('/') || spec.startsWith('~') || spec.startsWith('.') || spec.includes('/');

/** Glob with `*` and `?` only - enough for `~/acme-*` without pulling in a dependency. */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/**
 * Resolve an address into live agents, or into a directory to spawn against.
 * Accepts a handle, an alias, a session-id prefix, a directory, or a directory glob.
 */
export async function resolveTarget(spec, { one = false, refresh = false } = {}) {
  const book = await phonebook({ refresh });
  const rank = (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0);
  const pick = (list) => (one && list.length > 1 ? [list.slice().sort(rank)[0]] : list);

  if (!spec) return { kind: 'none', reason: 'no target given' };

  if (looksLikePath(spec)) {
    if (/[*?]/.test(spec)) {
      const re = globToRegExp(expandPath(spec));
      const hits = book.filter((a) => re.test(a.cwd));
      if (hits.length) return { kind: 'agents', agents: pick(hits) };
      return { kind: 'none', reason: `no live agent in directories matching ${spec}` };
    }
    const dir = expandPath(spec);
    const hits = book.filter((a) => a.cwd === dir);
    if (hits.length) return { kind: 'agents', agents: pick(hits), cwd: dir };
    return { kind: 'spawn', cwd: dir };
  }

  const want = slug(spec);
  const byHandle = book.filter((a) => a.handle === spec || a.handle === want);
  if (byHandle.length) return { kind: 'agents', agents: pick(byHandle) };

  const byAlias = book.filter((a) => (a.aliases ?? []).some((x) => x === spec || slug(x) === want));
  if (byAlias.length) return { kind: 'agents', agents: pick(byAlias) };

  const bySession = book.filter((a) => a.sessionId.startsWith(spec));
  if (bySession.length) return { kind: 'agents', agents: pick(bySession) };

  const byName = book.filter((a) => a.name && slug(a.name).includes(want));
  if (byName.length) return { kind: 'agents', agents: pick(byName) };

  const byBasename = book.filter((a) => slug(path.basename(a.cwd ?? '')) === want);
  if (byBasename.length) return { kind: 'agents', agents: pick(byBasename) };

  return { kind: 'none', reason: `no agent matches "${spec}" - try \`ap who\`` };
}

/**
 * Which route a send to this agent would take, and why. Ordering matters: a pane is only
 * usable when the session is idle or busy, because typing into a session with a dialog open
 * would answer the dialog instead of sending a message.
 */
export function chooseRoute(agent) {
  const typable = canType(agent);
  if (!typable.ok) return { route: 'mailbox', reason: typable.reason };
  if (!agent.zellij) return { route: 'mailbox', reason: 'no zellij pane for this agent' };
  return { route: 'pane', reason: agent.status === 'busy' ? 'queues until turn end' : 'starts immediately' };
}
