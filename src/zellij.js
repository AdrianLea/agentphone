import { run } from './util.js';

/** Turn a bare pane number into zellij's canonical `terminal_<n>` form. */
export function normalizePane(pane) {
  if (pane == null || pane === '') return null;
  const s = String(pane);
  return /^\d+$/.test(s) ? `terminal_${s}` : s;
}

/** This agent's own zellij address, from the environment zellij exports into each pane. */
export function selfAddr(env = process.env) {
  const session = env.ZELLIJ_SESSION_NAME || null;
  const pane = normalizePane(env.ZELLIJ_PANE_ID);
  return session && pane ? { session, pane } : null;
}

export function insideZellij(env = process.env) {
  return Boolean(env.ZELLIJ_SESSION_NAME);
}

function sessionArgs(session) {
  return session ? ['--session', session] : [];
}

export async function available() {
  const r = await run('zellij', ['--version'], { timeoutMs: 5000 });
  return r.ok;
}

export async function listSessions() {
  const r = await run('zellij', ['list-sessions', '--no-formatting'], { timeoutMs: 8000 });
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const name = line.split(/\s+/)[0];
      return { name, exited: /EXITED/.test(line), current: /\(current\)/.test(line) };
    })
    .filter((s) => s.name && !s.exited);
}

/**
 * Panes in a session: [{ id, type, title }].
 * Output is `PANE_ID  TYPE  TITLE` with a header row; titles contain spaces and status glyphs.
 */
export async function listPanes(session) {
  const r = await run('zellij', [...sessionArgs(session), 'action', 'list-panes'], {
    timeoutMs: 8000,
  });
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.startsWith('PANE_ID'))
    .map((line) => {
      const m = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
      if (!m) return null;
      return { id: m[1], type: m[2], title: m[3].trim() };
    })
    .filter(Boolean);
}

export async function paneExists(session, pane) {
  const panes = await listPanes(session);
  return panes.some((p) => p.id === pane);
}

/**
 * Re-verify a pane immediately before writing to it, since pane ids are reused after a pane
 * closes and a stale id would deliver into an unrelated shell.
 *
 * Pass `expectTitle` only for an address that was *inferred* from a pane title - there the title
 * is the identifying evidence. For a registered address leave it null: the id came from inside
 * that pane, and a closed pane kills its agent, so existence alone is sufficient proof.
 * Matching is loose because zellij truncates titles and decorates them with status glyphs.
 */
export async function verifyPane(session, pane, expectTitle = null) {
  const panes = await listPanes(session);
  const found = panes.find((p) => p.id === pane);
  if (!found) return { ok: false, reason: 'pane no longer exists' };
  if (found.type !== 'terminal') return { ok: false, reason: `pane is a ${found.type}` };
  if (expectTitle) {
    const norm = (s) => String(s).replace(/[^a-z0-9]+/gi, '').toLowerCase();
    const a = norm(found.title);
    const b = norm(expectTitle);
    if (a && b && !a.includes(b.slice(0, 24)) && !b.includes(a.slice(0, 24))) {
      return { ok: false, reason: `pane title changed (now "${found.title}")`, pane: found };
    }
  }
  return { ok: true, pane: found };
}

export async function writeChars(session, pane, text) {
  if (/\n/.test(text)) throw new Error('writeChars: text must be a single line');
  return run('zellij', [...sessionArgs(session), 'action', 'write-chars', '-p', pane, text], {
    timeoutMs: 8000,
  });
}

export async function sendKeys(session, pane, ...keys) {
  return run('zellij', [...sessionArgs(session), 'action', 'send-keys', '-p', pane, ...keys], {
    timeoutMs: 8000,
  });
}

export async function closePane(session, pane) {
  return run('zellij', [...sessionArgs(session), 'action', 'close-pane', '-p', pane], {
    timeoutMs: 8000,
  });
}

/** Type a single line into a pane and submit it. */
export async function deliverLine(session, pane, line) {
  const w = await writeChars(session, pane, line);
  if (!w.ok) return { ok: false, reason: `write-chars failed: ${w.stderr.trim()}` };
  const k = await sendKeys(session, pane, 'Enter');
  if (!k.ok) return { ok: false, reason: `send-keys failed: ${k.stderr.trim()}` };
  return { ok: true };
}
