#!/bin/sh
# Shared hook entrypoint. Hooks may run with a minimal PATH, so resolve node explicitly and
# stay silent if it cannot be found - a broken hook must never break the user's session.
set -u

NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" /usr/bin/node; do
    if [ -x "$candidate" ]; then
      NODE="$candidate"
      break
    fi
  done
fi
[ -n "$NODE" ] || exit 0

if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  ROOT="$CLAUDE_PLUGIN_ROOT"
else
  ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
fi

exec "$NODE" "$ROOT/bin/ap" hook "$1"
