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

/** Denied everywhere unless a policy explicitly overrides: nothing an agent should do unattended. */
const BASELINE_DENY = [
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(rm -rf:*)',
  'Bash(sudo:*)',
];

export const BUILTIN = {
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

/** `ap peer` defaults here: reading and replying never prompt, changes still do. */
export const DEFAULT_POLICY = 'reader';

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
