import fs from 'node:fs';
import path from 'node:path';

import { liveAgents } from './agents.js';
import { runHook } from './deliver.js';
import { readPayload, renderBlock, renderForSpawn } from './envelope.js';
import { P, config, ensureStore, inboxDir } from './paths.js';
import { allEntries, deregister, phonebook, register, selfId, sweep, updateSelf } from './registry.js';
import { chooseRoute, resolveTarget } from './resolve.js';
import { buildMessage, clearWaiting, deliver, isWaiting, markWaiting, selfDescriptor } from './send.js';
import { spawnAsk } from './spawn.js';
import {
  claim,
  pending,
  readLog,
  recordThreadMessage,
  requeue,
  threadMeta,
  waitForMessage,
  waitForReply,
} from './store.js';
import { listJson, logEvent, run, tildify } from './util.js';
import { available as zellijAvailable, insideZellij, selfAddr } from './zellij.js';

const BOOLEANS = new Set([
  'json', 'all', 'drain', 'one', 'dry-run', 'spawn', 'no-spawn', 'allow-writes', 'refused', 'help', 'quiet',
]);

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      out.flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEANS.has(body)) {
      out.flags[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.flags[body] = true;
    else {
      out.flags[body] = next;
      i += 1;
    }
  }
  return out;
}

/* -------------------------------------------------------------- printing */

function table(rows, columns) {
  if (!rows.length) return '(none)';
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => String(c.get(r) ?? '').length)),
  );
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns.map((c) => c.header)), ...rows.map((r) => line(columns.map((c) => c.get(r))))].join('\n');
}

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

function durationToSeconds(v, fallback) {
  if (v === undefined || v === true) return fallback;
  const m = String(v).match(/^(\d+)\s*([smh]?)$/);
  if (!m) return fallback;
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}

/* -------------------------------------------------------------- commands */

async function cmdWho(args) {
  const book = await phonebook({ refresh: true });
  const rows = book
    .map((a) => ({ ...a, unread: pending(a.sessionId).length }))
    .filter((a) => args.flags.all || a.kind !== 'background' || a.unread || a.registered)
    .sort((a, b) => a.handle.localeCompare(b.handle));

  if (args.flags.json) {
    out(JSON.stringify(rows, null, 2));
    return 0;
  }
  const me = selfId();
  out(
    table(rows, [
      { header: 'HANDLE', get: (r) => `${r.handle}${r.sessionId === me ? ' *' : ''}` },
      { header: 'DIR', get: (r) => tildify(r.cwd ?? '') },
      { header: 'KIND', get: (r) => r.kind },
      { header: 'STATUS', get: (r) => (r.waitingFor ? `${r.status}(${r.waitingFor})` : r.status) },
      { header: 'PANE', get: (r) => (r.zellij ? `${r.zellij.pane}${r.paneInferred ? '?' : ''}` : '-') },
      { header: 'REACH', get: (r) => r.reach },
      { header: 'UNREAD', get: (r) => r.unread || '' },
      { header: 'DOING', get: (r) => r.role ?? '' },
    ]),
  );
  if (rows.some((r) => r.paneInferred)) {
    out('\n? = pane inferred from its title (agent has not registered); verified again before any write.');
  }
  return 0;
}

async function cmdWhois(args) {
  const spec = args._[0];
  const res = await resolveTarget(spec, { refresh: true });
  if (res.kind === 'none') {
    err(res.reason);
    return 1;
  }
  if (res.kind === 'spawn') {
    out(`no live agent in ${tildify(res.cwd)}`);
    out(`ask anyway with:  ap ask ${spec} "..." --spawn`);
    return 0;
  }
  for (const a of res.agents) {
    const route = chooseRoute(a);
    const files = ['CLAUDE.md', 'AGENTS.md'].filter((f) => fs.existsSync(path.join(a.cwd, f)));
    out(`${a.handle}${a.registered ? '' : '  (unregistered)'}`);
    out(`  dir       ${tildify(a.cwd)}`);
    out(`  session   ${a.sessionId}  (${a.kind}, pid ${a.pid})`);
    out(`  status    ${a.waitingFor ? `${a.status} - ${a.waitingFor}` : a.status}`);
    out(`  zellij    ${a.zellij ? `${a.zellij.session} / ${a.zellij.pane}` : '-'}`);
    out(`  route     ${route.route} (${route.reason})`);
    out(`  name      ${a.name ?? '-'}`);
    if (a.role) out(`  doing     ${a.role}`);
    if (files.length) out(`  context   ${files.join(', ')}`);
    out(`  unread    ${pending(a.sessionId).length}`);
    out('');
  }
  return 0;
}

async function cmdRegister(args) {
  const res = await register({
    as: typeof args.flags.as === 'string' ? args.flags.as : null,
    role: typeof args.flags.role === 'string' ? args.flags.role : null,
  });
  if (!res.ok) {
    err(res.reason);
    return 1;
  }
  if (!args.flags.quiet) {
    const z = res.entry.zellij;
    out(`registered as "${res.entry.handle}" in ${tildify(res.entry.cwd)}${z ? ` (${z.session}/${z.pane})` : ' (no zellij pane)'}`);
  }
  return 0;
}

async function cmdStatus(args) {
  const text = args._.join(' ').trim();
  if (!text) {
    err('usage: ap status "<what you are working on>"');
    return 1;
  }
  let res = updateSelf({ role: text });
  if (!res.ok) {
    await register({});
    res = updateSelf({ role: text });
  }
  if (!res.ok) {
    err(res.reason);
    return 1;
  }
  out(`status set: ${text}`);
  return 0;
}

async function cmdSend(args) {
  const [spec, ...rest] = args._;
  const body = rest.join(' ').trim();
  if (!spec || !body) {
    err('usage: ap send <target> "<message>"');
    return 1;
  }
  const res = await resolveTarget(spec, { one: Boolean(args.flags.one), refresh: true });
  if (res.kind === 'none') {
    err(res.reason);
    return 1;
  }
  if (res.kind === 'spawn') {
    err(`no live agent in ${tildify(res.cwd)} - nothing to send to.`);
    err(`to get an answer from that directory anyway:  ap ask ${spec} "${body.slice(0, 40)}..." --spawn`);
    return 1;
  }

  const book = await phonebook();
  const me = selfDescriptor(book);
  let failures = 0;
  for (const target of res.agents) {
    const msg = buildMessage({
      me,
      target,
      body,
      subject: typeof args.flags.subject === 'string' ? args.flags.subject : null,
      type: typeof args.flags.type === 'string' ? args.flags.type : 'note',
      priority: typeof args.flags.priority === 'string' ? args.flags.priority : 'normal',
      expiresInS: durationToSeconds(args.flags.expires, undefined),
    });
    const r = await deliver(target, msg, { dryRun: Boolean(args.flags['dry-run']) });
    if (r.ok) {
      out(`${r.dryRun ? '[dry-run] ' : ''}${target.handle} <- ${r.route} (${r.reason})  thread ${msg.thread}`);
    } else {
      err(`${target.handle}: ${r.reason}`);
      failures += 1;
    }
  }
  return failures ? 1 : 0;
}

async function cmdAsk(args) {
  const [spec, ...rest] = args._;
  const question = rest.join(' ').trim();
  if (!spec || !question) {
    err('usage: ap ask <target> "<question>"');
    return 1;
  }
  const cfg = config();
  const timeoutS = durationToSeconds(args.flags.timeout, cfg.ask_timeout_s);
  const wantSpawn = Boolean(args.flags.spawn);
  const noSpawn = Boolean(args.flags['no-spawn']);

  const res = await resolveTarget(spec, { one: true, refresh: true });
  const book = await phonebook();
  const me = selfDescriptor(book);

  const doSpawn = async (cwd) => {
    const msg = buildMessage({ me, target: { cwd }, body: question, type: 'ask' });
    const r = await spawnAsk({
      cwd,
      prompt: renderForSpawn(msg),
      budget: args.flags.budget ? Number(args.flags.budget) : null,
      allowWrites: Boolean(args.flags['allow-writes']),
    });
    if (!r.ok) {
      err(`spawn failed: ${r.reason}`);
      return 1;
    }
    out(r.answer || '(empty answer)');
    err(
      `\n[via spawn in ${tildify(cwd)}${r.resumed ? `, resumed ${r.resumed.slice(0, 8)}` : ', fresh session'}${
        r.cost != null ? `, $${r.cost.toFixed(4)}` : ''
      }]`,
    );
    return 0;
  };

  if (res.kind === 'spawn') {
    if (noSpawn) {
      err(`no live agent in ${tildify(res.cwd)} and --no-spawn was given`);
      return 1;
    }
    return doSpawn(res.cwd);
  }
  if (res.kind === 'none') {
    err(res.reason);
    return 1;
  }
  const target = res.agents[0];
  if (wantSpawn) return doSpawn(target.cwd);

  const msg = buildMessage({ me, target, body: question, type: 'ask', priority: 'normal' });
  markWaiting(msg);
  try {
    const sent = await deliver(target, msg);
    if (!sent.ok) {
      err(sent.reason);
      return 1;
    }
    err(`[asked ${target.handle} via ${sent.route}; waiting up to ${timeoutS}s for a reply - thread ${msg.thread}]`);
    const reply = await waitForReply(msg.thread, msg.id, timeoutS * 1000);
    if (reply) {
      out(reply.body);
      const full = readPayload(reply);
      if (full) out(`\n[full text: ${reply.payload_path}]`);
      return 0;
    }
    err(`no reply from ${target.handle} within ${timeoutS}s`);
    if (!noSpawn) {
      err('falling back to a spawned read-only answer...');
      return doSpawn(target.cwd);
    }
    return 1;
  } finally {
    clearWaiting(msg);
  }
}

async function cmdReply(args) {
  const [thread, ...rest] = args._;
  const body = rest.join(' ').trim();
  if (!thread || !body) {
    err('usage: ap reply <thread> "<message>"');
    return 1;
  }
  const meta = threadMeta(thread);
  if (!meta.messages?.length) {
    err(`unknown thread ${thread}`);
    return 1;
  }
  const book = await phonebook({ refresh: true });
  const me = selfDescriptor(book);
  const myId = selfId();

  // Reply to the most recent message in this thread that did not come from us.
  const inbound = [...listJson(path.join(P.threads, thread))]
    .map((e) => e.value)
    .filter((m) => m?.id && m.from?.agent_id !== myId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const original = inbound[inbound.length - 1];
  if (!original) {
    err(`no inbound message in thread ${thread} to reply to`);
    return 1;
  }

  const reply = buildMessage({
    me,
    target: { handle: original.from.handle, sessionId: original.from.agent_id, cwd: original.from.cwd },
    body,
    type: 'reply',
    thread,
    inReplyTo: original.id,
    hop: (original.hop ?? 1) + 1,
  });

  // If the asker is blocked in `ap ask`, it is polling the thread. Typing into its pane would
  // land a stray prompt in a session that is busy waiting, so only record the reply.
  if (isWaiting(thread, original.id)) {
    recordThreadMessage(reply);
    logEvent({ event: 'replied', via: 'thread', msg: reply.id, thread, to: original.from.handle });
    out(`replied to ${original.from.handle} (they are waiting on this thread)`);
    return 0;
  }

  const target = book.find((a) => a.sessionId === original.from.agent_id);
  if (!target) {
    recordThreadMessage(reply);
    out(`recorded reply in thread ${thread} (${original.from.handle} is no longer live)`);
    return 0;
  }
  const r = await deliver(target, reply);
  if (!r.ok) {
    err(r.reason);
    return 1;
  }
  out(`${target.handle} <- ${r.route} (${r.reason})`);
  return 0;
}

async function cmdWake(args) {
  const spec = args._[0];
  if (!spec) {
    err('usage: ap wake <target>');
    return 1;
  }
  const res = await resolveTarget(spec, { one: Boolean(args.flags.one), refresh: true });
  if (res.kind !== 'agents') {
    err(res.kind === 'spawn' ? `no live agent in ${tildify(res.cwd)}` : res.reason);
    return 1;
  }
  const book = await phonebook();
  const me = selfDescriptor(book);
  for (const target of res.agents) {
    const queued = pending(target.sessionId).length;
    const route = chooseRoute(target);
    if (!queued) {
      out(`${target.handle}: nothing queued; a send would go via ${route.route} (${route.reason})`);
      continue;
    }
    const msg = buildMessage({
      me,
      target,
      body: `You have ${queued} queued agentphone message(s). Run: ap read --drain`,
      type: 'note',
      priority: 'urgent',
    });
    const r = await deliver(target, msg);
    out(r.ok ? `${target.handle} <- ${r.route}: nudged about ${queued} queued message(s)` : `${target.handle}: ${r.reason}`);
  }
  return 0;
}

function printMessages(msgs, { json }) {
  if (json) {
    out(JSON.stringify(msgs, null, 2));
    return;
  }
  out(renderBlock(msgs));
}

async function cmdInbox(args) {
  const id = selfId();
  if (!id) {
    err('CLAUDE_CODE_SESSION_ID not set - run this from inside a Claude Code session');
    return 1;
  }
  const msgs = pending(id);
  if (!msgs.length) {
    out('inbox empty');
    return 0;
  }
  if (args.flags.json) {
    out(JSON.stringify(msgs, null, 2));
    return 0;
  }
  out(
    table(msgs, [
      { header: 'FROM', get: (m) => m.from?.handle },
      { header: 'TYPE', get: (m) => m.type },
      { header: 'PRI', get: (m) => m.priority },
      { header: 'THREAD', get: (m) => m.thread },
      { header: 'BODY', get: (m) => m.body.slice(0, 60) },
    ]),
  );
  return 0;
}

async function cmdRead(args) {
  const id = selfId();
  if (!id) {
    err('CLAUDE_CODE_SESSION_ID not set');
    return 1;
  }
  const msgs = args.flags.drain ? claim(id) : pending(id);
  if (!msgs.length) {
    out('inbox empty');
    return 0;
  }
  printMessages(msgs, { json: Boolean(args.flags.json) });
  if (!args.flags.drain) err('\n[not drained - re-run with --drain to mark these delivered]');
  return 0;
}

async function cmdWait(args) {
  const id = selfId();
  if (!id) {
    err('CLAUDE_CODE_SESSION_ID not set');
    return 1;
  }
  const cfg = config();
  const timeoutS = durationToSeconds(args.flags.timeout, cfg.wait_timeout_s);
  updateSelf({ oncall_until: new Date(Date.now() + timeoutS * 1000).toISOString() });
  try {
    const found = await waitForMessage(id, timeoutS * 1000);
    if (!found.length) {
      out(`no messages within ${timeoutS}s`);
      return 2;
    }
    printMessages(claim(id), { json: Boolean(args.flags.json) });
    return 0;
  } finally {
    updateSelf({ oncall_until: null });
  }
}

async function cmdLog(args) {
  const events = readLog({ days: Number(args.flags.days ?? 3) }).filter((e) => {
    if (args.flags.refused && e.event !== 'refused' && e.event !== 'pane-rejected' && e.event !== 'pane-failed') return false;
    if (typeof args.flags.thread === 'string' && e.thread !== args.flags.thread) return false;
    return true;
  });
  if (args.flags.json) {
    out(JSON.stringify(events, null, 2));
    return 0;
  }
  out(
    table(events, [
      { header: 'AT', get: (e) => String(e.at).slice(11, 19) },
      { header: 'EVENT', get: (e) => e.event },
      { header: 'VIA', get: (e) => e.via ?? '' },
      { header: 'FROM', get: (e) => e.from ?? '' },
      { header: 'TO', get: (e) => e.to ?? '' },
      { header: 'THREAD', get: (e) => e.thread ?? '' },
      { header: 'DETAIL', get: (e) => e.why ?? e.pane ?? '' },
    ]),
  );
  return 0;
}

async function cmdRequeue(args) {
  const id = selfId();
  const msgId = args._[0];
  if (!msgId) {
    err('usage: ap requeue <msg-id>');
    return 1;
  }
  const r = requeue(id, msgId);
  if (!r.ok) {
    err(r.reason);
    return 1;
  }
  out(`requeued ${msgId}`);
  return 0;
}

async function cmdDoctor() {
  ensureStore();
  let problems = 0;
  const say = (ok, label, detail) => {
    out(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  - ${detail}` : ''}`);
    if (!ok) problems += 1;
  };

  const st = fs.statSync(P.root);
  say((st.mode & 0o777) === 0o700, 'store permissions are 0700', `mode ${(st.mode & 0o777).toString(8)}`);
  say(Boolean(selfId()), 'CLAUDE_CODE_SESSION_ID is set', selfId() ?? 'not in a Claude Code session');
  say(await zellijAvailable(), 'zellij CLI reachable');
  say(insideZellij(), 'running inside a zellij pane', selfAddr() ? `${selfAddr().session}/${selfAddr().pane}` : 'no pane - pane wake unavailable for this agent');

  const agents = await liveAgents({ refresh: true });
  say(agents.length > 0, 'claude agents --json returned live sessions', `${agents.length} live`);

  const me = allEntries().find((e) => e.session_id === selfId());
  say(Boolean(me), 'this agent is registered', me ? `handle "${me.handle}"` : 'run `ap register`');

  const removed = await sweep();
  say(true, 'registry swept', removed.length ? `removed ${removed.join(', ')}` : 'no stale entries');

  const book = await phonebook({ refresh: true });
  const reachable = book.filter((a) => a.reach !== 'mailbox').length;
  say(true, 'phonebook built', `${book.length} agents, ${reachable} pane-reachable`);

  // A skills-dir plugin auto-loads from ~/.claude/skills/<name> and never appears in
  // enabledPlugins, so check for either installation shape.
  const skillsDir = path.join(process.env.HOME, '.claude', 'skills', 'agentphone');
  let enabledInSettings = false;
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME, '.claude', 'settings.json'), 'utf8'),
    );
    enabledInSettings = Object.keys(settings.enabledPlugins ?? {}).some((k) => k.startsWith('agentphone'));
  } catch {}
  const installedAsSkillsDir = fs.existsSync(skillsDir);
  say(
    installedAsSkillsDir || enabledInSettings,
    'plugin installed',
    installedAsSkillsDir ? `${skillsDir} (skills-dir)` : enabledInSettings ? 'enabled in settings.json' : 'not installed - hooks will not run',
  );

  const onPath = await run('sh', ['-c', 'command -v ap']);
  say(onPath.ok, '`ap` is on PATH', onPath.ok ? onPath.stdout.trim() : 'symlink bin/ap into ~/.local/bin');

  return problems ? 1 : 0;
}

/* ------------------------------------------------------------------ main */

const HELP = `agentphone - message other Claude Code agents by handle or directory

  ap who [--json] [--all]            the phonebook: who is live, where, and how reachable
  ap whois <target>                  detail for one agent
  ap register [--as H] [--role R]    record this agent (SessionStart does this for you)
  ap status "<text>"                 say what you are working on
  ap send <target> "<msg>"           fire-and-forget. --priority urgent --type task --one --dry-run
  ap ask <target> "<question>"       blocking question. --timeout 180 --spawn --no-spawn --budget 0.5
  ap reply <thread> "<msg>"          answer a message
  ap wake <target>                   nudge an agent about queued mail; prints the route
  ap inbox | ap read [--drain]       your pending messages
  ap wait [--timeout 600]            block until a message arrives (be on call)
  ap log [--thread T] [--refused]    audit trail of every delivery decision
  ap requeue <msg-id>                put a delivered message back in the inbox
  ap doctor                          check the install

target is a handle, a directory (~/acme-api), a directory glob (~/acme-*), or a session-id prefix.`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.flags.help) {
    out(HELP);
    return 0;
  }
  ensureStore();

  switch (cmd) {
    case 'who':
      return cmdWho(args);
    case 'whois':
      return cmdWhois(args);
    case 'register':
      return cmdRegister(args);
    case 'status':
      return cmdStatus(args);
    case 'send':
      return cmdSend(args);
    case 'ask':
      return cmdAsk(args);
    case 'reply':
      return cmdReply(args);
    case 'wake':
      return cmdWake(args);
    case 'inbox':
      return cmdInbox(args);
    case 'read':
      return cmdRead(args);
    case 'wait':
      return cmdWait(args);
    case 'log':
      return cmdLog(args);
    case 'requeue':
      return cmdRequeue(args);
    case 'doctor':
      return cmdDoctor(args);
    case 'hook':
      return runHook(args._[0], args);
    case 'deregister':
      deregister(selfId());
      return 0;
    default:
      err(`unknown command: ${cmd}`);
      out(HELP);
      return 1;
  }
}
