import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { liveAgents } from './agents.js';
import { P, ensureStore } from './paths.js';
import { listJson, readJson, slug, writeJson } from './util.js';
import { listPanes, selfAddr } from './zellij.js';

export function selfId(env = process.env) {
  return env.CLAUDE_CODE_SESSION_ID || null;
}

const entryFile = (sessionId) => path.join(P.registry, `${sessionId}.json`);

export function getEntry(sessionId) {
  return sessionId ? readJson(entryFile(sessionId)) : null;
}

export function allEntries() {
  return listJson(P.registry).map((e) => e.value);
}

/** Pick a handle that is not already claimed by a different live session. */
function uniqueHandle(base, sessionId, taken) {
  const root = slug(base) || 'agent';
  if (!taken.has(root) || taken.get(root) === sessionId) return root;
  for (let n = 2; n < 50; n += 1) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate) || taken.get(candidate) === sessionId) return candidate;
  }
  return `${root}-${sessionId.slice(0, 6)}`;
}

/**
 * Record who and where this agent is. Idempotent - called on every SessionStart and cheap
 * enough to call again from any command that notices its own entry is missing or stale.
 */
export async function register({ as = null, role = null, env = process.env } = {}) {
  ensureStore();
  const sessionId = selfId(env);
  if (!sessionId) return { ok: false, reason: 'CLAUDE_CODE_SESSION_ID not set' };

  const agents = await liveAgents();
  const live = agents.find((a) => a.sessionId === sessionId);
  const existing = getEntry(sessionId);
  const cwd = live?.cwd ?? process.cwd();

  const taken = new Map();
  for (const e of allEntries()) {
    if (e?.handle && e.session_id !== sessionId) taken.set(e.handle, e.session_id);
  }

  const base = as ?? existing?.handle ?? live?.name ?? path.basename(cwd);
  const handle = uniqueHandle(base, sessionId, taken);

  const entry = {
    v: 1,
    session_id: sessionId,
    handle,
    aliases: existing?.aliases ?? [],
    role: role ?? existing?.role ?? null,
    cwd,
    pid: live?.pid ?? (Number(env.CLAUDE_PID) || process.ppid),
    kind: live?.kind ?? 'interactive',
    zellij: selfAddr(env) ?? existing?.zellij ?? null,
    host: os.hostname(),
    user: os.userInfo().username,
    registered_at: existing?.registered_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeJson(entryFile(sessionId), entry);
  return { ok: true, entry };
}

export function updateSelf(patch, env = process.env) {
  const sessionId = selfId(env);
  if (!sessionId) return { ok: false, reason: 'CLAUDE_CODE_SESSION_ID not set' };
  const existing = getEntry(sessionId);
  if (!existing) return { ok: false, reason: 'not registered yet - run `ap register`' };
  const entry = { ...existing, ...patch, updated_at: new Date().toISOString() };
  writeJson(entryFile(sessionId), entry);
  return { ok: true, entry };
}

export function deregister(sessionId) {
  if (!sessionId) return;
  try {
    fs.rmSync(entryFile(sessionId), { force: true });
  } catch {}
}

/** Drop registry entries whose session is no longer live. */
export async function sweep() {
  const agents = await liveAgents();
  const liveIds = new Set(agents.map((a) => a.sessionId));
  const removed = [];
  for (const e of allEntries()) {
    if (e?.session_id && !liveIds.has(e.session_id)) {
      deregister(e.session_id);
      removed.push(e.handle ?? e.session_id);
    }
  }
  return removed;
}

/**
 * The phonebook: every live session, left-joined with its registry entry and its zellij pane,
 * plus a truthful `reach` telling you what a send would actually do.
 */
export async function phonebook({ refresh = false } = {}) {
  const agents = await liveAgents({ refresh });
  const entries = new Map(allEntries().map((e) => [e.session_id, e]));

  // One list-panes call per distinct zellij session referenced by the registry.
  const sessions = new Set();
  for (const e of entries.values()) if (e?.zellij?.session) sessions.add(e.zellij.session);
  if (process.env.ZELLIJ_SESSION_NAME) sessions.add(process.env.ZELLIJ_SESSION_NAME);
  const panesBySession = new Map();
  await Promise.all(
    [...sessions].map(async (s) => panesBySession.set(s, await listPanes(s))),
  );

  return agents.map((a) => {
    const entry = entries.get(a.sessionId) ?? null;
    let zellij = entry?.zellij ?? null;
    let inferred = false;

    // Unregistered agents can still be located by matching the pane title to the session name.
    if (!zellij && a.name) {
      for (const [session, panes] of panesBySession) {
        const want = slug(a.name);
        const hit = panes.find((p) => p.type === 'terminal' && want && slug(p.title).includes(want));
        if (hit) {
          zellij = { session, pane: hit.id };
          inferred = true;
          break;
        }
      }
    }

    const panes = zellij ? (panesBySession.get(zellij.session) ?? []) : [];
    const pane = zellij ? panes.find((p) => p.id === zellij.pane) : null;
    const hasPane = Boolean(pane && pane.type === 'terminal');

    let reach;
    if (hasPane && a.status === 'idle') reach = 'instant';
    else if (hasPane && a.status === 'busy') reach = 'at-turn-end';
    else reach = 'mailbox';

    return {
      sessionId: a.sessionId,
      handle: entry?.handle ?? slug(a.name ?? path.basename(a.cwd ?? '')) ?? a.sessionId.slice(0, 8),
      aliases: entry?.aliases ?? [],
      role: entry?.role ?? null,
      cwd: a.cwd,
      kind: a.kind,
      pid: a.pid,
      status: a.status,
      waitingFor: a.waitingFor,
      name: a.name,
      startedAt: a.startedAt ?? 0,
      oncallUntil: entry?.oncall_until ?? null,
      zellij: hasPane ? zellij : null,
      paneTitle: pane?.title ?? null,
      paneInferred: inferred,
      registered: Boolean(entry),
      reach,
    };
  });
}
