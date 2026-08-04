import { isAlive, run } from './util.js';

let cache = null;

/**
 * Live Claude Code sessions, straight from `claude agents --json`. This is the authoritative
 * liveness source - agentphone deliberately keeps no presence state of its own.
 * Shape per entry: { pid, cwd, kind, sessionId, name, status, waitingFor?, startedAt }
 */
export async function liveAgents({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  const r = await run('claude', ['agents', '--json'], { timeoutMs: 20_000 });
  if (!r.ok) {
    cache = [];
    return cache;
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    cache = [];
    return cache;
  }
  cache = (Array.isArray(parsed) ? parsed : [])
    // A crashed session can linger in the roster; kill -0 is the cheap truth.
    .filter((a) => a?.sessionId && isAlive(a.pid))
    .map((a) => ({
      pid: a.pid,
      cwd: a.cwd,
      kind: a.kind,
      sessionId: a.sessionId,
      name: a.name ?? null,
      status: a.status ?? 'unknown',
      waitingFor: a.waitingFor ?? null,
      startedAt: a.startedAt ?? 0,
    }));
  return cache;
}

/** Only `idle` and `busy` sessions may be typed into - see canType(). */
export function canType(agent) {
  if (!agent) return { ok: false, reason: 'no live session' };
  if (agent.status === 'idle' || agent.status === 'busy') return { ok: true };
  const detail = agent.waitingFor ? `${agent.status}/${agent.waitingFor}` : agent.status;
  // Typing into a session with a dialog open would answer the dialog, not send a message.
  return { ok: false, reason: `session is ${detail}` };
}

export function findBySession(agents, sessionId) {
  return agents.find((a) => a.sessionId === sessionId) ?? null;
}
