import fs from 'node:fs';
import path from 'node:path';

import { isExpired } from './envelope.js';
import { P, config, deliveredDir, ensureStore, inboxDir, threadDir, urgentMarker } from './paths.js';
import { atomicWrite, listJson, logEvent, readJson, sleep, writeJson } from './util.js';

// Inbox filenames must sort lexicographically into arrival order. Timestamp alone is not enough:
// messages enqueued in the same millisecond would then be ordered by the random part of their id.
let seqCounter = 0;
const seqFor = (msg) =>
  [
    Date.now().toString(36).padStart(9, '0'),
    (seqCounter++).toString(36).padStart(6, '0'),
    msg.id,
  ].join('-');

/* ---------------------------------------------------------------- mailbox */

export function enqueue(agentId, msg) {
  ensureStore();
  const dir = inboxDir(agentId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson(path.join(dir, `${seqFor(msg)}.json`), msg);
  refreshUrgentMarker(agentId);
  return { ok: true };
}

/** Presence-only marker so the PostToolUse shell fast path can skip spawning Node. */
export function refreshUrgentMarker(agentId) {
  const marker = urgentMarker(agentId);
  const anyUrgent = pending(agentId).some((m) => m.priority === 'urgent');
  try {
    if (anyUrgent) atomicWrite(marker, '1');
    else fs.rmSync(marker, { force: true });
  } catch {}
}

/** Pending messages, oldest first. Expired ones are retired as a side effect. */
export function pending(agentId) {
  const dir = inboxDir(agentId);
  const out = [];
  for (const { file, value } of listJson(dir)) {
    if (isExpired(value)) {
      retire(agentId, file, value, 'expired');
      continue;
    }
    out.push({ ...value, _file: file });
  }
  return out;
}

function retire(agentId, file, msg, why) {
  const dest = path.join(deliveredDir(agentId), path.basename(file));
  try {
    fs.mkdirSync(deliveredDir(agentId), { recursive: true, mode: 0o700 });
    fs.renameSync(file, dest);
  } catch {
    return;
  }
  logEvent({ event: why, msg: msg.id, thread: msg.thread, to: agentId, from: msg.from?.handle });
}

/**
 * Claim pending messages. Claiming moves them out of the inbox before the caller emits
 * anything, so a repeated hook invocation cannot deliver the same message twice.
 *
 * `where` selects which messages to claim. It must be applied *before* the cap, otherwise a
 * selective claim (the urgent-only mid-task path) would consume unrelated messages that happened
 * to be queued ahead of its targets and then discard them.
 */
export function claim(agentId, { cap = config().delivery_cap_per_turn, where = null } = {}) {
  const items = pending(agentId)
    .filter((m) => (where ? where(m) : true))
    .slice(0, cap);
  const claimed = [];
  for (const msg of items) {
    const file = msg._file;
    delete msg._file;
    const dest = path.join(deliveredDir(agentId), path.basename(file));
    try {
      fs.mkdirSync(deliveredDir(agentId), { recursive: true, mode: 0o700 });
      fs.renameSync(file, dest);
    } catch {
      continue;
    }
    claimed.push(msg);
    logEvent({
      event: 'delivered',
      via: 'mailbox',
      msg: msg.id,
      thread: msg.thread,
      to: agentId,
      from: msg.from?.handle,
    });
  }
  refreshUrgentMarker(agentId);
  return claimed;
}

export function requeue(agentId, msgId) {
  const dir = deliveredDir(agentId);
  for (const { file, value } of listJson(dir)) {
    if (value.id === msgId) {
      const dest = path.join(inboxDir(agentId), path.basename(file));
      fs.renameSync(file, dest);
      refreshUrgentMarker(agentId);
      logEvent({ event: 'requeued', msg: msgId, to: agentId });
      return { ok: true };
    }
  }
  return { ok: false, reason: `no delivered message ${msgId} for this agent` };
}

/** Block until a message lands, or the timeout expires. */
export async function waitForMessage(agentId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const items = pending(agentId);
    if (items.length) return items;
    if (Date.now() >= deadline) return [];
    await sleep(300);
  }
}

/* ---------------------------------------------------------------- threads */

export function threadMeta(thread) {
  return readJson(path.join(threadDir(thread), 'meta.json'), { thread, hops: 0, messages: [] });
}

export function recordThreadMessage(msg) {
  ensureStore();
  const dir = threadDir(msg.thread);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const meta = threadMeta(msg.thread);
  meta.hops = Math.max(meta.hops, msg.hop);
  meta.messages = [
    ...(meta.messages ?? []),
    { id: msg.id, hop: msg.hop, type: msg.type, from: msg.from?.handle, to: msg.to?.handle, at: msg.created_at },
  ].slice(-50);
  writeJson(path.join(dir, 'meta.json'), meta);
  writeJson(path.join(dir, `${msg.type === 'reply' ? 'reply' : 'request'}-${msg.id}.json`), msg);
}

export function latestReply(thread, afterMsgId = null) {
  const dir = threadDir(thread);
  const replies = listJson(dir)
    .filter(({ file }) => path.basename(file).startsWith('reply-'))
    .map((e) => e.value)
    .filter((m) => !afterMsgId || m.in_reply_to === afterMsgId);
  return replies.length ? replies[replies.length - 1] : null;
}

export async function waitForReply(thread, msgId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reply = latestReply(thread, msgId) ?? latestReply(thread);
    if (reply) return reply;
    if (Date.now() >= deadline) return null;
    await sleep(400);
  }
}

/* ------------------------------------------------------------ guardrails */

/**
 * Ping-pong guard. Instant, idle-capable delivery makes A->B->A loops possible, so a thread
 * is capped at max_hops and each target has a per-minute ceiling.
 */
export function checkHops(thread, hop) {
  const cfg = config();
  if (hop > cfg.max_hops) {
    return { ok: false, reason: `hop limit reached (${hop} > max_hops ${cfg.max_hops})` };
  }
  const meta = threadMeta(thread);
  if (meta.hops >= cfg.max_hops) {
    return { ok: false, reason: `thread ${thread} already at hop limit (${meta.hops})` };
  }
  return { ok: true };
}

const rateFile = (targetId) => path.join(P.root, 'rate', `${targetId}.json`);

export function checkRate(targetId) {
  const cfg = config();
  const now = Date.now();
  const recent = (readJson(rateFile(targetId), []) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= cfg.rate_per_min) {
    return { ok: false, reason: `rate limit: ${recent.length} messages to this agent in the last minute (max ${cfg.rate_per_min})` };
  }
  return { ok: true, recent };
}

export function noteSend(targetId) {
  const now = Date.now();
  const recent = (readJson(rateFile(targetId), []) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  writeJson(rateFile(targetId), recent);
}

/* ------------------------------------------------------------------ log */

export function readLog({ days = 3 } = {}) {
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const file = path.join(P.log, `${day}.jsonl`);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
