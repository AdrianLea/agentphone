import { renderBlock } from './envelope.js';
import { deregister, register } from './registry.js';
import { claim, pending } from './store.js';
import { logEvent } from './util.js';

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    const done = () => resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    // A hook must never hang a session waiting on stdin.
    setTimeout(done, 2000).unref?.();
  });
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function contextOutput(hookEventName, additionalContext) {
  emit({ hookSpecificOutput: { hookEventName, additionalContext }, suppressOutput: true });
}

/**
 * Hook entrypoints. Two jobs only: register the agent, and drain messages that could not be
 * typed into a pane. Pane delivery is the primary path and does not involve hooks at all.
 *
 * Every branch is defensive - a throwing hook must not break the user's session, so failures
 * emit an empty object and exit 0.
 */
export async function runHook(event, args) {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch {}

  // stdin is authoritative for identity; the env var is the fallback.
  const sessionId = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || null;
  const env = sessionId ? { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } : process.env;

  try {
    switch (event) {
      case 'session-start': {
        await register({ env });
        const msgs = sessionId ? claim(sessionId) : [];
        if (msgs.length) contextOutput('SessionStart', renderBlock(msgs));
        else emit({});
        return 0;
      }

      case 'session-end': {
        if (sessionId) deregister(sessionId);
        emit({});
        return 0;
      }

      case 'user-prompt-submit': {
        const msgs = sessionId ? claim(sessionId) : [];
        if (msgs.length) contextOutput('UserPromptSubmit', renderBlock(msgs));
        else emit({});
        return 0;
      }

      case 'stop': {
        // Claude Code suppresses a second consecutive block, so drain everything at once.
        if (input.stop_hook_active) {
          emit({});
          return 0;
        }
        const msgs = sessionId ? claim(sessionId) : [];
        if (!msgs.length) {
          emit({});
          return 0;
        }
        const more = pending(sessionId).length;
        const tail = more ? `\n\n${more} further message(s) arrived - run \`ap read --drain\` to collect them.` : '';
        logEvent({ event: 'stop-block', to: sessionId, count: msgs.length });
        emit({ decision: 'block', reason: `${renderBlock(msgs)}${tail}` });
        return 0;
      }

      case 'post-tool-use': {
        // Only urgent mail interrupts mid-task; everything else waits for a turn boundary.
        if (!sessionId) {
          emit({});
          return 0;
        }
        const claimed = claim(sessionId, { where: (m) => m.priority === 'urgent' });
        if (claimed.length) contextOutput('PostToolUse', renderBlock(claimed));
        else emit({});
        return 0;
      }

      default:
        emit({});
        return 0;
    }
  } catch (error) {
    logEvent({ event: 'hook-error', hook: event, why: String(error?.message ?? error) });
    emit({});
    return 0;
  }
}
