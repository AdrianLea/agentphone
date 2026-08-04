import { execFile as execFileCb } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { P } from './paths.js';

const execFile = promisify(execFileCb);

/**
 * Run a command with an argv array - never a shell string, so message bodies can
 * never be interpolated into a command line.
 */
export async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFile(cmd, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 30_000,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (err) {
    return {
      ok: false,
      code: err.code ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err.message ?? err),
    };
  }
}

/** Sortable, collision-resistant id: <prefix>_<base36 millis><random>. */
export function id(prefix) {
  const ts = Date.now().toString(36).padStart(9, '0');
  return `${prefix}_${ts}${crypto.randomBytes(5).toString('hex')}`;
}

/** Write via temp file + rename in the same directory, so readers never see a partial file. */
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function listJson(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
    .sort()
    .map((n) => ({ file: path.join(dir, n), value: readJson(path.join(dir, n)) }))
    .filter((e) => e.value);
}

/** Append one JSON line to today's log. Best-effort: logging must never break a send. */
export function logEvent(event) {
  try {
    fs.mkdirSync(P.log, { recursive: true, mode: 0o700 });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(
      path.join(P.log, `${day}.jsonl`),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      { mode: 0o600 },
    );
  } catch {}
}

export function expandPath(p) {
  if (!p) return p;
  let out = p;
  if (out === '~') out = os.homedir();
  else if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));
  return path.resolve(out);
}

export function tildify(p) {
  if (!p) return p;
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export function slug(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collapse to a single line - a newline in a typed payload submits the prompt early. */
export function oneLine(s) {
  return String(s ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
