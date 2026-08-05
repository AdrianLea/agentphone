import { run, sleep } from './util.js';

/**
 * Read whatever prompt a pane is currently showing.
 *
 * Options are parsed off the screen rather than assumed, so approving works against whatever
 * choices the dialog actually offers instead of a hardcoded "1 means yes". A dialog whose shape
 * changes between Claude Code versions degrades to "no options found", which the caller surfaces
 * instead of guessing.
 */
export async function readDialog(session, pane, { lines = 30 } = {}) {
  const args = [];
  if (session) args.push('--session', session);
  args.push('action', 'dump-screen', '-p', pane);
  const r = await run('zellij', args, { timeoutMs: 8000 });
  if (!r.ok) return { ok: false, reason: r.stderr.trim() || 'dump-screen failed' };
  return { ok: true, ...parseDialog(r.stdout, { lines }) };
}

/** Split out from readDialog so the parser can be tested against captured screens. */
export function parseDialog(screenText, { lines = 30 } = {}) {
  const all = String(screenText).split('\n').map((l) => l.replace(/\s+$/, ''));
  const tail = all.slice(-lines);

  const isOption = (l) => /^[\s>❯▶│|↓↑▾▴]*\d+[.)]\s+\S/.test(l);
  const isRule = (l) => /^[\s│|╭╰┌└]*[─═╌]{6,}/.test(l);

  const options = [];
  for (let i = 0; i < tail.length; i += 1) {
    const line = tail[i];
    // e.g. "❯ 1. Yes"  /  "  2. Yes, and don't ask again"  /  "  3. No"
    const m = line.match(/^[\s>❯▶│|↓↑▾▴]*(\d+)[.)]\s+(\S.*)$/);
    if (!m) continue;
    // A long label wraps onto following indented lines; join them or the label reads truncated,
    // which would mean approving something you only half saw.
    let label = m[2].trim();
    const indent = line.indexOf(m[1]);
    for (let j = i + 1; j < tail.length; j += 1) {
      const next = tail[j];
      if (!next.trim() || isOption(next) || isRule(next)) break;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) break;
      label += ` ${next.trim()}`;
    }
    options.push({ n: Number(m[1]), label, selected: /[>❯▶]/.test(line.slice(0, indent)) });
  }

  const firstOption = tail.findIndex(isOption);

  // Everything between the enclosing rule and the options is what you are being asked to allow -
  // the tool, its arguments, and Claude Code's own one-line description. Approving without it
  // would mean answering a question you cannot see.
  let body = [];
  let title = null;
  if (firstOption > 0) {
    let start = 0;
    for (let i = firstOption - 1; i >= 0; i -= 1) {
      if (isRule(tail[i])) {
        start = i + 1;
        break;
      }
    }
    body = tail
      .slice(start, firstOption)
      .map((l) => l.replace(/^[\s│|]+/, '').replace(/[\s│|]+$/, ''))
      .filter((l) => l.trim() && !isRule(l));
    // Only a genuine question counts as the title; otherwise there is nothing being asked.
    title = [...body].reverse().find((l) => l.trim().endsWith('?')) ?? null;
  }

  // Numbered lines alone are not a prompt - agents print numbered lists all the time, and typing
  // a digit at an ordinary prompt would send a stray message instead of answering anything. Demand
  // corroboration: several options, plus either a question or the dialog's own cancel footer.
  const hasEscFooter = tail.some((l) => /\bEsc\b.*cancel|cancel.*\bEsc\b/i.test(l));
  const hasDialog = dedupe(options).length >= 2 && (Boolean(title) || hasEscFooter);

  // A scroll arrow on an option row means the list is longer than the pane shows, so the options
  // parsed here are incomplete. Approving blind against a partial list is exactly the mistake this
  // flag exists to prevent, so callers must surface it.
  const scrolled = tail.some((l) => /^[\s│|]*[↓↑▾▴]\s*\d+[.)]\s+\S/.test(l));

  return {
    hasDialog,
    title,
    body,
    scrolled,
    options: dedupe(options),
    screen: tail.filter(Boolean).join('\n'),
  };
}

function dedupe(options) {
  const seen = new Map();
  for (const o of options) if (!seen.has(o.n)) seen.set(o.n, o);
  return [...seen.values()].sort((a, b) => a.n - b.n);
}

async function sendKeys(session, pane, ...keys) {
  const args = [];
  if (session) args.push('--session', session);
  args.push('action', 'send-keys', '-p', pane, ...keys);
  return run('zellij', args, { timeoutMs: 8000 });
}

/**
 * Answer a dialog by pressing its option number, then verify the dialog actually cleared.
 *
 * Whether the digit alone confirms or needs a following Enter is version-dependent, so rather
 * than guessing (and risking a stray empty prompt submission) this presses the digit, re-reads
 * the screen, and reports honestly whether the prompt is gone.
 */
export async function chooseOption(session, pane, n) {
  const k = await sendKeys(session, pane, String(n));
  if (!k.ok) return { ok: false, reason: k.stderr.trim() || 'send-keys failed' };
  await sleep(1500);
  const after = await readDialog(session, pane);
  if (after.ok && !after.hasDialog) return { ok: true, cleared: true };
  return { ok: true, cleared: false, still: after.ok ? after.title : null };
}

/** Press Enter, for a dialog that needs an explicit confirm after selection. */
export async function confirm(session, pane) {
  const k = await sendKeys(session, pane, 'Enter');
  if (!k.ok) return { ok: false, reason: k.stderr.trim() || 'send-keys failed' };
  await sleep(1200);
  const after = await readDialog(session, pane);
  return { ok: true, cleared: after.ok && !after.hasDialog };
}

/** Escape is the safe way to decline: it cancels rather than picking an option by index. */
export async function dismiss(session, pane) {
  const k = await sendKeys(session, pane, 'Esc');
  if (!k.ok) return { ok: false, reason: k.stderr.trim() || 'send-keys failed' };
  await sleep(1200);
  const after = await readDialog(session, pane);
  return { ok: true, cleared: after.ok && !after.hasDialog };
}
