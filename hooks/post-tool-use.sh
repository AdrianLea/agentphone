#!/bin/sh
# Fast path for the only hook that runs on every single tool call.
#
# Urgent messages are rare, so the steady-state cost of this hook must be a couple of stats and
# nothing more - node is only started when an urgent marker actually exists somewhere. The
# per-session check happens in node; testing the glob here avoids parsing stdin JSON in sh.
set -u

INBOX="${AGENTPHONE_HOME:-$HOME/.claude/agentphone}/inbox"

for marker in "$INBOX"/*/.urgent; do
  [ -e "$marker" ] || exit 0
  exec sh "$(dirname -- "$0")/run.sh" post-tool-use
done

exit 0
