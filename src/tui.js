import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { INPUT, PERMISSION, QUEUED, attention, fit, humanDuration } from './attention.js';
import { chooseOption, confirm, dismiss, readDialog } from './dialog.js';
import { phonebook } from './registry.js';
import { buildMessage, deliver, selfDescriptor } from './send.js';
import { pending } from './store.js';
import { run, tildify } from './util.js';
import { closePane, listPanes, selfAddr } from './zellij.js';

const ESC = '\u001b';
const C = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  rev: `${ESC}[7m`,
  red: `${ESC}[31m`,
  amber: `${ESC}[33m`,
  teal: `${ESC}[36m`,
  grey: `${ESC}[90m`,
};

const KIND_LABEL = {
  [PERMISSION]: `${C.red}needs permission${C.reset}`,
  [INPUT]: `${C.amber}waiting on you${C.reset}`,
  [QUEUED]: `${C.teal}queued mail${C.reset}`,
};

const write = (s) => process.stdout.write(s);
const clear = () => write(`${ESC}[2J${ESC}[H`);

function keysFor(item) {
  if (item.kind === PERMISSION) return '[a] approve  [d] deny  [g] go to it';
  if (item.kind === INPUT) return '[r] reply  [g] go to it';
  return '[w] wake  [g] go to it';
}

function render(items, cursor, note) {
  clear();
  const waiting = items.filter((i) => i.kind !== QUEUED).length;
  const head = waiting
    ? `${C.bold}${waiting} agent${waiting > 1 ? 's' : ''} waiting on you${C.reset}`
    : `${C.bold}nothing is waiting on you${C.reset}`;
  write(`  ${head}${items.length > waiting ? `${C.grey}  ·  ${items.length - waiting} with queued mail${C.reset}` : ''}\n\n`);

  if (!items.length) {
    write(`  ${C.grey}every agent is running or idle with an empty inbox.${C.reset}\n\n`);
  }

  // Pad the plain text, then wrap in colour - padEnd on a string containing escape sequences
  // counts them as width and silently breaks every column to its right.
  const HANDLE_W = 24;
  const DIR_W = 22;
  const INDENT = '       ';

  items.forEach((item, i) => {
    const on = i === cursor;
    const marker = on ? `${C.bold}▸${C.reset}` : ' ';
    const handle = fit(item.handle, HANDLE_W);
    const dir = fit(tildify(item.agent.cwd ?? ''), DIR_W);
    const waited = item.waitedMs != null ? humanDuration(item.waitedMs) : '';
    write(
      `  ${marker} ${String(i + 1).padEnd(2)} ` +
        `${on ? C.bold : ''}${handle}${on ? C.reset : ''} ` +
        `${C.grey}${dir}${C.reset} ${KIND_LABEL[item.kind]}` +
        `${waited ? `  ${C.grey}${waited}${C.reset}` : ''}\n`,
    );
    write(`${INDENT}${C.dim}${item.detail}${C.reset}\n`);
    if (on) write(`${INDENT}${C.grey}${keysFor(item)}${C.reset}\n`);
    write('\n');
  });

  if (note) write(`  ${note}\n\n`);
  write(`  ${C.grey}↑↓ select   r/a/d/w/g act   . refresh   q close${C.reset}\n`);
}

/** Read one keypress in raw mode. */
function readKey() {
  return new Promise((resolve) => {
    const onData = (buf) => {
      process.stdin.off('data', onData);
      resolve(buf.toString());
    };
    process.stdin.on('data', onData);
  });
}

/** Drop out of raw mode to ask a full-line question, then go back. */
async function prompt(question) {
  process.stdin.setRawMode(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return answer.trim();
}

/**
 * Take me to that agent.
 *
 * Three cases, and the point is that all three do something rather than explaining why they
 * cannot. zellij can neither focus a pane in another session nor move a pane between sessions, so
 * a cross-session agent gets a new tab that attaches to its session - nested, but it puts the
 * agent in front of you, which is what was asked for.
 */
async function doJump(item) {
  const z = item.agent.zellij;
  const here = process.env.ZELLIJ_SESSION_NAME;

  if (z && z.session === here) {
    await run('zellij', ['action', 'focus-pane-id', z.pane], { timeoutMs: 8000 });
    // Name the tab after the agent so it is identifiable once you are there.
    const info = await run('zellij', ['action', 'current-tab-info'], { timeoutMs: 8000 });
    const id = info.stdout.match(/id:\s*(\d+)/)?.[1];
    if (id) await run('zellij', ['action', 'rename-tab-by-id', id, item.handle], { timeoutMs: 8000 });
    return null; // focus moved; the floater is done
  }

  if (z && z.session !== here) {
    // Open the tab from a layout that runs the attach directly. Creating a bare tab and then
    // hunting for "the new pane" is unreliable - pane titles like "Pane #1" are not unique across
    // tabs, so a search can find someone else's pane and type into it.
    const layout = path.join(os.tmpdir(), `agentphone-attach-${z.session}.kdl`);
    fs.writeFileSync(
      layout,
      `layout {\n    pane command="zellij" {\n        args "attach" "${z.session}"\n    }\n}\n`,
      { mode: 0o600 },
    );
    const r = await run(
      'zellij',
      ['action', 'new-tab', '--layout', layout, '--name', `${item.handle}@${z.session}`],
      { timeoutMs: 12_000 },
    );
    if (!r.ok) return `${C.red}could not open a tab: ${r.stderr.trim()}${C.reset}`;
    return null;
  }

  // No pane at all: the agent is live but not running inside zellij, so there is nothing to show.
  return (
    `${C.amber}${item.handle} is not running in a zellij pane, so there is nothing to open.${C.reset}\n` +
    `  ${C.grey}it is reachable by mailbox, and you can query its directory with:` +
    ` ap ask ${item.handle} "..." --spawn${C.reset}`
  );
}

async function doPermission(item, action) {
  const z = item.agent.zellij;
  if (!z) return `${C.red}${item.handle} has no pane, so its dialog cannot be read${C.reset}`;

  const dlg = await readDialog(z.session, z.pane);
  if (!dlg.ok) return `${C.red}${dlg.reason}${C.reset}`;
  if (!dlg.hasDialog) {
    return `${C.amber}no prompt visible on ${item.handle} right now - it may have already cleared${C.reset}`;
  }

  clear();
  write(`  ${C.bold}${item.handle}${C.reset} ${C.grey}${tildify(item.agent.cwd ?? '')}${C.reset}\n\n`);
  // Show what is actually being requested, verbatim from the agent's own dialog, before offering
  // to answer it. Approving from a summary would be approving something you did not read.
  for (const line of dlg.body ?? []) {
    write(line.trim().endsWith('?') ? `  ${C.bold}${line}${C.reset}\n` : `  ${C.dim}${line}${C.reset}\n`);
  }
  write('\n');
  for (const o of dlg.options) {
    write(`    ${o.selected ? `${C.bold}▸${C.reset}` : ' '} ${o.n}. ${o.label}\n`);
  }
  if (dlg.scrolled) {
    write(
      `\n  ${C.amber}This dialog has more options than fit the pane, so the list above is` +
        ` incomplete.${C.reset}\n  ${C.grey}Press [g] to open it directly if you need to see them all.${C.reset}\n`,
    );
  }
  write('\n');

  if (action === 'deny') {
    write(`  ${C.grey}pressing Esc to cancel...${C.reset}\n`);
    const r = await dismiss(z.session, z.pane);
    return r.cleared
      ? `${C.teal}declined on ${item.handle}${C.reset}`
      : `${C.amber}sent Esc to ${item.handle} but a prompt is still showing${C.reset}`;
  }

  const choice = await prompt(`  approve which option? (number, or blank to cancel) `);
  if (!choice) return `${C.grey}left ${item.handle} untouched${C.reset}`;
  const n = Number(choice);
  if (!dlg.options.some((o) => o.n === n)) return `${C.red}no option ${choice} in that dialog${C.reset}`;

  const r = await chooseOption(z.session, z.pane, n);
  if (!r.ok) return `${C.red}${r.reason}${C.reset}`;
  if (r.cleared) return `${C.teal}answered ${item.handle} with option ${n}${C.reset}`;

  const also = await prompt(`  prompt still showing - press Enter to confirm on ${item.handle}? [y/N] `);
  if (!/^y/i.test(also)) return `${C.amber}left ${item.handle} mid-dialog${C.reset}`;
  const c = await confirm(z.session, z.pane);
  return c.cleared
    ? `${C.teal}answered ${item.handle} with option ${n}${C.reset}`
    : `${C.amber}${item.handle} still shows a prompt - go look with [g]${C.reset}`;
}

async function doReply(item) {
  const text = await prompt(`  message to ${item.handle}: `);
  if (!text) return `${C.grey}nothing sent${C.reset}`;
  const book = await phonebook({ refresh: true });
  const me = selfDescriptor(book);
  const target = book.find((a) => a.sessionId === item.agent.sessionId);
  if (!target) return `${C.red}${item.handle} is no longer live${C.reset}`;
  const msg = buildMessage({ me, target, body: text, type: 'note' });
  const r = await deliver(target, msg);
  return r.ok
    ? `${C.teal}${item.handle} <- ${r.route} (${r.reason})${C.reset}`
    : `${C.red}${r.reason}${C.reset}`;
}

async function doWake(item) {
  const book = await phonebook({ refresh: true });
  const me = selfDescriptor(book);
  const target = book.find((a) => a.sessionId === item.agent.sessionId);
  if (!target) return `${C.red}${item.handle} is no longer live${C.reset}`;
  const queued = pending(target.sessionId).length;
  const msg = buildMessage({
    me,
    target,
    body: `You have ${queued} queued agentphone message(s). Run: ap read --drain`,
    type: 'note',
    priority: 'urgent',
  });
  const r = await deliver(target, msg);
  return r.ok ? `${C.teal}nudged ${item.handle} via ${r.route}${C.reset}` : `${C.red}${r.reason}${C.reset}`;
}

/**
 * The floater. Interactive only: it is opened by a zellij keybinding, and refuses to run without
 * a TTY. That is what keeps it out of reach of agents - approving another agent's permission
 * prompt must stay a human action, or the message channel becomes a privilege-escalation channel.
 */
export const FLOATER_PANE_NAME = 'ap-attention';

/**
 * Retire any older instance so running this twice cannot stack views.
 *
 * A second instance replaces the first rather than stacking, so running it again just gives you
 * one current view. Dismiss with q or Esc.
 *
 * The name is matched exactly. A loose match would be dangerous: it would also close any pane
 * whose title merely contains the name, including a live Claude session.
 */
async function retireOlderFloaters() {
  const self = selfAddr();
  if (!self) return;
  const panes = await listPanes(self.session);
  for (const pane of panes) {
    if (pane.id !== self.pane && pane.type === 'terminal' && pane.title.trim() === FLOATER_PANE_NAME) {
      await closePane(self.session, pane.id);
    }
  }
}

export async function runTui() {
  await retireOlderFloaters();

  if (!process.stdin.isTTY) {
    process.stderr.write(
      'ap attention --tui is interactive and must be run from a terminal.\n' +
        'Agents cannot use it by design - approving permissions stays a human action.\n' +
        'For scripted use: ap attention --json\n',
    );
    return 1;
  }

  let items = await attention();
  let cursor = 0;
  let note = null;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    for (;;) {
      cursor = Math.min(cursor, Math.max(0, items.length - 1));
      render(items, cursor, note);
      note = null;
      const key = await readKey();
      const item = items[cursor];

      if (key === 'q' || key === ESC || key === '\u0003') return 0;
      if (key === `${ESC}[A` || key === 'k') cursor = Math.max(0, cursor - 1);
      else if (key === `${ESC}[B` || key === 'j') cursor = Math.min(items.length - 1, cursor + 1);
      else if (/^[1-9]$/.test(key)) cursor = Math.min(items.length - 1, Number(key) - 1);
      else if (key === '.') {
        items = await attention();
        note = `${C.grey}refreshed${C.reset}`;
      } else if (item && (key === 'a' || key === 'd') && item.kind === PERMISSION) {
        note = await doPermission(item, key === 'a' ? 'approve' : 'deny');
        items = await attention();
      } else if (item && key === 'r' && item.kind === INPUT) {
        note = await doReply(item);
        items = await attention();
      } else if (item && key === 'w' && item.kind === QUEUED) {
        note = await doWake(item);
        items = await attention();
      } else if (item && key === 'g') {
        const problem = await doJump(item);
        if (!problem) return 0;
        note = problem;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    write(C.reset);
  }
}
