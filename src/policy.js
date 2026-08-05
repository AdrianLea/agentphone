import fs from 'node:fs';
import path from 'node:path';

import { P, ensureStore } from './paths.js';
import { listJson, readJson, writeJson } from './util.js';

/**
 * Launch-time permission policies.
 *
 * The point is to stop generating prompts rather than to manage them. An agent launched with no
 * policy inherits your default and blocks on routine work, and a blocked agent is precisely the
 * state agentphone refuses to type into - so it sits there with your message queued behind a
 * dialog. Pre-authorising the work an agent is actually for removes that failure mode.
 *
 * `allow` and `deny` map onto Claude Code's own --allowedTools / --disallowedTools. Anything in
 * neither list falls through to a normal prompt, which is what `ask` documents.
 */

/** Every policy must permit `ap`, or the agent cannot reply and the deadlock returns by the back door. */
const TALK = ['Bash(ap:*)'];
const READ = ['Read', 'Grep', 'Glob'];

/**
 * Denied everywhere unless a policy explicitly overrides.
 *
 * Deny rules are the one thing that survives every permission mode - Claude Code auto-approves
 * "every tool call (except explicit deny rules)" - so this list is the real floor. It is worth
 * more than an allowlist, because an allowlist only shapes what an agent is asked about.
 *
 * The path-scoped entries matter as much as the command ones: an agent that can read ~/.ssh or
 * write ~/.claude can hand itself credentials or rewrite its own guardrails.
 */
const BASELINE_DENY = [
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(rm -rf:*)',
  'Bash(sudo:*)',
  'Bash(npm publish:*)',
  'Read(~/.ssh/**)',
  'Write(~/.ssh/**)',
  'Edit(~/.ssh/**)',
  'Write(~/.claude/**)',
  'Edit(~/.claude/**)',
];

/** Broad enough that routine work never prompts. */
const ACT = ['Bash', 'Write', 'Edit'];

export const BUILTIN = {
  /**
   * Never prompts in practice. Requested explicitly, with the risk accepted.
   *
   * Deliberately NOT `--permission-mode bypassPermissions`, which would be the literal reading of
   * "skip permissions". Two measured reasons:
   *
   *  1. Bypass mode opens a confirmation dialog on *every* launch ("should only be used in a
   *     sandboxed container/VM ... that can easily be restored if damaged"), and no acceptance is
   *     persisted anywhere. An agent launched that way never reaches its SessionStart hook, so it
   *     never registers and is unreachable - verified, twice.
   *  2. Bypass discards the allowlist entirely. A broad allowlist plus deny rules reaches the same
   *     no-prompt behaviour while keeping a real floor under it - verified: an agent under this
   *     policy ran a shell write with no prompt and never entered `waiting`.
   *
   * What this still cannot protect against: an agent acting on a peer's message can do anything
   * outside the deny list with no human in the loop, and agentphone exists to let agents instruct
   * each other. The provenance framing and the hop and rate guards are what stand between a
   * confused or injected message and real action.
   */
  autonomous: {
    description: 'never prompts on routine work; hard denies still hold. Accepts real risk',
    allow: [...TALK, ...READ, ...ACT],
    ask: ['nothing that matters in practice'],
    deny: [...BASELINE_DENY],
  },
  messenger: {
    description: 'can only talk on the phone - no reading, no writing',
    allow: [...TALK],
    ask: ['everything else'],
    deny: [...BASELINE_DENY],
  },
  reader: {
    description: 'read and answer questions about its repo; asks before changing anything',
    allow: [...TALK, ...READ],
    ask: ['Write', 'Edit', 'Bash'],
    deny: [...BASELINE_DENY],
  },
  supervisor: {
    description: 'triage the phonebook: poll, group, answer peers, nudge - never authorises anything',
    // Deliberately no Write, no Edit, and no Bash beyond `ap`. A supervisor's job is to reduce
    // what reaches you, not to act on the fleet, and it must never be able to approve another
    // agent's permission prompt - that stays human. `ap attention --tui` refuses without a TTY,
    // which an agent's Bash tool never has, so the boundary holds even if it tries.
    allow: [...TALK, ...READ],
    ask: ['Write', 'Edit', 'Bash (anything but ap)'],
    deny: [...BASELINE_DENY, 'Bash(claude:*)'],
  },
  worker: {
    description: 'read, edit, and run the usual build and test commands; asks before anything else',
    allow: [
      ...TALK,
      ...READ,
      'Write',
      'Edit',
      'Bash(npm test:*)',
      'Bash(npm run:*)',
      'Bash(node:*)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
    ],
    ask: ['Bash (anything else)'],
    deny: [...BASELINE_DENY],
  },
};

/** `ap peer` defaults here, by explicit request: agent-launched sessions never prompt. */
export const DEFAULT_POLICY = 'autonomous';

/** The deny floor, exported so spawned runs apply the same one. */
export const HARD_DENY = [...BASELINE_DENY];

const policyDir = () => path.join(P.root, 'policies');
const policyFile = (name) => path.join(policyDir(), `${name}.json`);

/** Built-ins, overridable by a same-named file in the store. */
export function listPolicies() {
  const out = new Map();
  for (const [name, body] of Object.entries(BUILTIN)) out.set(name, { name, source: 'builtin', ...body });
  for (const { file, value } of listJson(policyDir())) {
    const name = path.basename(file, '.json');
    out.set(name, { name, source: 'user', ...value });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadPolicy(name) {
  if (!name) return null;
  const user = readJson(policyFile(name));
  if (user) return { name, source: 'user', ...user };
  if (BUILTIN[name]) return { name, source: 'builtin', ...BUILTIN[name] };
  return null;
}

export function savePolicy(name, policy) {
  ensureStore();
  fs.mkdirSync(policyDir(), { recursive: true, mode: 0o700 });
  writeJson(policyFile(name), policy);
  return { ok: true, file: policyFile(name) };
}

/**
 * Turn a policy into `claude` arguments.
 *
 * A deny always wins over an allow: if a pattern appears in both, dropping it from the allow list
 * is the safe reading, since the alternative is silently granting something explicitly forbidden.
 */
export function toClaudeArgs(policy, { extraAllow = [] } = {}) {
  if (!policy) return extraAllow.flatMap((p) => ['--allowedTools', p]);

  const deny = [...new Set(policy.deny ?? [])];
  const allow = [...new Set([...(policy.allow ?? []), ...extraAllow])].filter((a) => !deny.includes(a));

  const args = [];
  for (const pattern of allow) args.push('--allowedTools', pattern);
  for (const pattern of deny) args.push('--disallowedTools', pattern);
  if (policy.mode) args.push('--permission-mode', policy.mode);
  return args;
}
