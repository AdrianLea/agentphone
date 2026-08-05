import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from './paths.js';
import { HARD_DENY } from './policy.js';
import { logEvent, run } from './util.js';

/** Claude Code stores transcripts under a cwd-derived directory name: every non-alnum -> '-'. */
export function projectDirFor(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** The most recently modified transcript for a directory, so a spawn inherits real context. */
export function newestTranscript(cwd) {
  const dir = projectDirFor(cwd);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const scored = names
    .map((n) => {
      const file = path.join(dir, n);
      try {
        return { file, sessionId: n.replace(/\.jsonl$/, ''), mtime: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return scored[0] ?? null;
}

/**
 * Answer a question by running a headless Claude in the target directory.
 *
 * `--resume` is what makes this real context transfer rather than a cold read of the repo: it
 * inherits what that directory's agent already worked out. `--fork-session` guarantees the run
 * cannot mutate a transcript the user might resume themselves. Tools default to read-only.
 */
export async function spawnAsk({
  cwd,
  prompt,
  budget = null,
  allowWrites = false,
  timeoutMs = 300_000,
}) {
  const cfg = config();
  if (!fs.existsSync(cwd)) return { ok: false, reason: `directory does not exist: ${cwd}` };

  const transcript = newestTranscript(cwd);
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--max-budget-usd',
    String(budget ?? cfg.spawn_budget_usd),
  ];
  // Explicitly allow the tools this run is given, so nothing prompts. bypassPermissions is avoided
  // here for the same reason as in the policies: it opens a per-launch confirmation dialog that a
  // headless run has no way to answer.
  if (allowWrites) {
    for (const t of ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash']) args.push('--allowedTools', t);
  } else {
    args.push('--tools', 'Read,Grep,Glob');
    for (const t of ['Read', 'Grep', 'Glob']) args.push('--allowedTools', t);
  }
  for (const pattern of HARD_DENY) args.push('--disallowedTools', pattern);
  if (transcript) args.push('--resume', transcript.sessionId, '--fork-session');

  logEvent({
    event: 'spawned',
    cwd,
    resumed: transcript?.sessionId ?? null,
    allowWrites,
    budget: budget ?? cfg.spawn_budget_usd,
  });

  const r = await run('claude', args, { cwd, timeoutMs });
  if (!r.ok && !r.stdout.trim()) {
    return { ok: false, reason: r.stderr.trim() || `claude exited ${r.code}`, resumed: transcript?.sessionId ?? null };
  }

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    // Fall back to raw text rather than losing an answer to a format change.
    return { ok: true, answer: r.stdout.trim(), cost: null, resumed: transcript?.sessionId ?? null };
  }
  if (parsed?.is_error) {
    return { ok: false, reason: parsed.result ?? 'claude reported an error', resumed: transcript?.sessionId ?? null };
  }
  return {
    ok: true,
    answer: String(parsed?.result ?? '').trim(),
    cost: parsed?.total_cost_usd ?? null,
    resumed: transcript?.sessionId ?? null,
  };
}
