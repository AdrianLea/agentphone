import { liveAgents } from './agents.js';
import { phonebook } from './registry.js';
import { run, sleep } from './util.js';

export const DEFAULT_LAB_SESSION = 'aplab';

/**
 * Environment that must be cleared before launching a nested `claude`.
 *
 * A `claude` started from inside another Claude Code session inherits CLAUDE_CODE_CHILD_SESSION,
 * which puts it in child-session mode: transcript saving is off ("Transcript saving is off -
 * inherited from parent"), it never writes ~/.claude/sessions/<pid>.json, and so it is invisible
 * to `claude agents --json` - which means invisible to the phonebook, and not resumable by
 * `ap ask --spawn`. The session id and entrypoint are cleared too so the new agent gets its own.
 */
const INHERITED_VARS = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT'];

async function allSessions() {
  const r = await run('zellij', ['list-sessions', '--no-formatting'], { timeoutMs: 8000 });
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => ({
      name: line.split(/\s+/)[0],
      exited: /EXITED/.test(line),
    }))
    .filter((s) => s.name);
}

/** Create the lab zellij session if it is not already running. Detached: nothing appears here. */
export async function ensureLabSession(name) {
  const existing = (await allSessions()).find((s) => s.name === name);
  if (existing && !existing.exited) return { ok: true, created: false };

  const args = ['attach', '-b', name];
  // A previously exited session would otherwise be resurrected along with its dead panes.
  if (existing?.exited) args.push('--forget');
  const r = await run('zellij', args, { timeoutMs: 20_000 });
  if (!r.ok && !(await allSessions()).some((s) => s.name === name && !s.exited)) {
    return { ok: false, reason: r.stderr.trim() || 'could not create zellij session' };
  }
  return { ok: true, created: true };
}

/**
 * Launch a Claude Code agent in a pane of the lab session, isolated from whatever zellij session
 * the caller is sitting in. Returns once the agent is visible in the phonebook.
 */
export async function launchPeer({
  cwd,
  session = DEFAULT_LAB_SESSION,
  name = null,
  allow = [],
  model = null,
  waitS = 90,
}) {
  const lab = await ensureLabSession(session);
  if (!lab.ok) return lab;

  const claudeArgs = [];
  if (name) claudeArgs.push('--name', name);
  if (model) claudeArgs.push('--model', model);
  for (const pattern of allow) claudeArgs.push('--allowedTools', pattern);

  const paneArgs = [
    '--session',
    session,
    'action',
    'new-pane',
    '--cwd',
    cwd,
    '--',
    'env',
    ...INHERITED_VARS.flatMap((v) => ['-u', v]),
    'claude',
    ...claudeArgs,
  ];
  const spawned = await run('zellij', paneArgs, { timeoutMs: 20_000 });
  if (!spawned.ok) return { ok: false, reason: spawned.stderr.trim() || 'new-pane failed' };
  const pane = spawned.stdout.trim().split('\n').pop();

  // Wait for it to boot, register via its SessionStart hook, and announce itself.
  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    const book = await phonebook({ refresh: true });
    const found = book.find(
      (a) => a.cwd === cwd && (name ? a.name === name || a.handle === name : true) && a.zellij?.pane === pane,
    );
    if (found) return { ok: true, agent: found, pane, session, labCreated: lab.created };
    if (Date.now() >= deadline) {
      const seen = (await liveAgents({ refresh: true })).some((a) => a.cwd === cwd);
      return {
        ok: false,
        reason: seen
          ? `agent started in ${session}/${pane} but did not register within ${waitS}s`
          : `agent did not become visible within ${waitS}s - attach with \`zellij attach ${session}\` to see why`,
        pane,
        session,
      };
    }
    await sleep(2000);
  }
}
