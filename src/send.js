import fs from 'node:fs';
import path from 'node:path';

import { create, renderLine } from './envelope.js';
import { threadDir } from './paths.js';
import { selfId } from './registry.js';
import { chooseRoute } from './resolve.js';
import {
  checkHops,
  checkRate,
  enqueue,
  noteSend,
  recordThreadMessage,
} from './store.js';
import { logEvent, readJson, writeJson } from './util.js';
import { deliverLine, verifyPane } from './zellij.js';

/** Marker telling `ap reply` that the asker is blocked polling the thread, not free to be typed at. */
const waitingFile = (thread, msgId) => path.join(threadDir(thread), `waiting-${msgId}.json`);

export function markWaiting(msg) {
  writeJson(waitingFile(msg.thread, msg.id), { msg: msg.id, agent: msg.from.agent_id, since: Date.now() });
}

export function clearWaiting(msg) {
  try {
    fs.rmSync(waitingFile(msg.thread, msg.id), { force: true });
  } catch {}
}

export function isWaiting(thread, msgId) {
  return Boolean(readJson(waitingFile(thread, msgId)));
}

export function selfDescriptor(book, env = process.env) {
  const me = book.find((a) => a.sessionId === selfId(env));
  return me ?? null;
}

export function buildMessage({ me, target, body, subject, type, priority, thread, inReplyTo, hop, expiresInS }) {
  return create({
    from: {
      handle: me?.handle ?? 'unknown',
      agent_id: me?.sessionId ?? null,
      cwd: me?.cwd ?? process.cwd(),
      zellij: me?.zellij ?? null,
      host: me?.host ?? undefined,
      user: process.env.USER,
    },
    to: {
      handle: target?.handle ?? null,
      agent_id: target?.sessionId ?? null,
      cwd: target?.cwd ?? null,
    },
    body,
    subject,
    type,
    priority,
    thread,
    inReplyTo,
    hop,
    expiresInS,
  });
}

/**
 * Which title, if any, a pane must still show before we write into it.
 *
 * Only *inferred* addresses need a title check - there the title is the identifying evidence.
 * A registered agent reported its own pane id from inside that pane, and closing a pane kills
 * the agent hosting it (which drops it from the live roster), so for a live registered agent
 * existence alone is proof. Requiring a title match there rejects legitimate deliveries,
 * because titles are set by whichever of zellij or the running program wrote last.
 */
export function expectedTitleFor(target) {
  if (!target?.paneInferred) return null;
  return target.name ?? target.paneTitle ?? null;
}

/**
 * Deliver one message to one live agent, choosing the pane route when it is safe and falling
 * back to the mailbox otherwise. Returns the route actually used so callers can report it.
 */
export async function deliver(target, msg, { dryRun = false } = {}) {
  if (target.sessionId === msg.from.agent_id) {
    return { ok: false, route: 'refused', reason: 'refusing to send to yourself' };
  }

  const hops = checkHops(msg.thread, msg.hop);
  if (!hops.ok) {
    logEvent({ event: 'refused', why: hops.reason, msg: msg.id, thread: msg.thread, to: target.handle });
    return { ok: false, route: 'refused', reason: hops.reason };
  }
  const rate = checkRate(target.sessionId);
  if (!rate.ok) {
    logEvent({ event: 'refused', why: rate.reason, msg: msg.id, thread: msg.thread, to: target.handle });
    return { ok: false, route: 'refused', reason: rate.reason };
  }

  const decision = chooseRoute(target);
  if (dryRun) return { ok: true, route: decision.route, reason: decision.reason, dryRun: true };

  recordThreadMessage(msg);

  if (decision.route === 'pane') {
    // Re-verify immediately before writing, because pane ids are reused after a pane closes.
    const check = await verifyPane(target.zellij.session, target.zellij.pane, expectedTitleFor(target));
    if (check.ok) {
      const line = renderLine(msg);
      const res = await deliverLine(target.zellij.session, target.zellij.pane, line);
      if (res.ok) {
        noteSend(target.sessionId);
        logEvent({
          event: 'delivered',
          via: 'pane',
          msg: msg.id,
          thread: msg.thread,
          to: target.handle,
          pane: target.zellij.pane,
          from: msg.from.handle,
        });
        return { ok: true, route: 'pane', reason: decision.reason };
      }
      logEvent({ event: 'pane-failed', why: res.reason, msg: msg.id, to: target.handle });
    } else {
      logEvent({ event: 'pane-rejected', why: check.reason, msg: msg.id, to: target.handle, pane: target.zellij.pane });
    }
  }

  enqueue(target.sessionId, { ...msg, delivered_via: 'mailbox' });
  noteSend(target.sessionId);
  logEvent({
    event: 'queued',
    via: 'mailbox',
    why: decision.route === 'pane' ? 'pane unusable' : decision.reason,
    msg: msg.id,
    thread: msg.thread,
    to: target.handle,
    from: msg.from.handle,
  });
  return {
    ok: true,
    route: 'mailbox',
    reason: decision.route === 'pane' ? 'pane unusable, queued instead' : decision.reason,
  };
}
