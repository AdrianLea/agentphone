# agentphone

A phonebook and a message channel for Claude Code agents running in different directories.

If you run several agents at once - one per repo, each with its own `CLAUDE.md` and its own
accumulated context - then getting agent A to act on something agent B knows normally means A
`cd`-ing into B's repo and re-reading it from scratch. That is slow, and it fills A's context
window with material B already has loaded.

agentphone gives you a channel instead. Ask the agent that already owns the context, and pay for
one short answer rather than a whole repository.

```console
$ ap who
HANDLE     DIR            KIND         STATUS   PANE          REACH        UNREAD  DOING
api        ~/acme-api     interactive  busy     terminal_22   at-turn-end          rate limiter rewrite
web        ~/acme-web     interactive  idle     terminal_19   instant       2      checkout flow
worker     ~/acme-worker  interactive  waiting  -             mailbox              queue draining

$ ap ask api "what shape does verifyToken() return?"
{ userId: string; scopes: string[] } - see src/auth/verify.ts:42

$ ap send web "auth contract changed, scopes[] is now required"
web <- pane (queues until turn end)  thread thr_0msel0kxaf
```

## What makes it work

Claude Code has no API for injecting a prompt into a running session, and an interactive session
sitting idle at its prompt fires no hooks - so it cannot be woken from outside. The way around
that is zellij:

```
zellij --session <s> action write-chars -p terminal_22 "<message>"
zellij --session <s> action send-keys   -p terminal_22 Enter
```

`--pane-id` types into a **specific pane without focusing it**, so your focus never moves and an
idle agent starts working immediately. A busy agent queues the input and picks it up at its turn
boundary. This is a documented public CLI, not an internal socket.

Everything else follows from three sources that already exist, joined at read time - agentphone
tracks no presence of its own:

| Source | Provides |
|---|---|
| `claude agents --json` | liveness, `cwd`, `status`, session name |
| `zellij action list-panes` | which pane holds which agent |
| `registry/<session>.json` | the only new state: handle, role, zellij address |

## Delivery routes

A send picks exactly one route and tells you which:

| Route | When | Effect |
|---|---|---|
| **pane** | live agent, `idle` or `busy`, known pane | typed straight in; idle starts now, busy queues to turn end |
| **mailbox** | live but not typeable - no pane, or a dialog is open | queued, drained by `SessionStart` / `UserPromptSubmit` / `Stop` hooks |
| **spawn** | nothing live in that directory, or `--spawn` | headless `claude -p` answers from that repo |

`ap who`'s `REACH` column tells you what a send *would* do before you send it: `instant`,
`at-turn-end`, `mailbox`, or `spawn-only`.

### Spawn is the interesting one

```console
$ ap ask ~/acme-worker "what is this repo for? cite a file"
A background job runner for the billing pipeline - see
cmd/worker/main.go (lines 32-133), which wires the queue, storage and retry policy.

[via spawn in ~/acme-worker, resumed 4f9c1a02, $0.0146]
```

No agent needs to be running there. It resumes that directory's most recent transcript with
`--fork-session`, so you get what that repo's agent already worked out - not a cold grep - and it
cannot mutate a session you might resume yourself. Read-only tools by default, capped by
`--max-budget-usd`.

## Install

Requires Node 20+, Claude Code, and zellij (for pane delivery; everything else works without it).

```sh
git clone https://github.com/AdrianLea/agentphone ~/agentphone
ln -sfn ~/agentphone ~/.claude/skills/agentphone   # auto-loads as agentphone@skills-dir
ln -sfn ~/agentphone/bin/ap ~/.local/bin/ap        # put `ap` on PATH
ap doctor
```

The plugin ships its own hooks, so there is nothing to hand-edit in `settings.json`. Agents
register themselves on `SessionStart`. Restart your sessions to pick it up, then `ap who`.

## Commands

```
ap who [--json] [--all]            the phonebook
ap whois <target>                  detail for one agent
ap send <target> "<msg>"           fire-and-forget  --priority urgent --type task --one --dry-run
ap ask <target> "<question>"       blocking         --timeout 180 --spawn --no-spawn --budget 0.5
ap reply <thread> "<msg>"          answer a message
ap wake <target>                   nudge an agent about queued mail
ap status "<text>"                 what you are working on, shown in everyone's `ap who`
ap inbox | ap read [--drain]       your pending messages
ap wait [--timeout 600]            block until a message arrives (be on call)
ap log [--thread T] [--refused]    every delivery decision
ap doctor                          check the install
```

A target is a handle (`acme-api`), a directory (`~/acme-api`), a directory glob (`~/acme-*`), or
a session-id prefix.

## Safety

Typed delivery is indistinguishable from you typing, which drives most of the design:

- **A session reporting `waiting` is never typed into.** A permission dialog is open; typing
  would answer the dialog instead of sending a message. Those sends go to the mailbox.
- **Every message is wrapped in provenance framing** telling the recipient this came from another
  agent, is a request to evaluate rather than an order, and does not authorise commits, pushes,
  destructive commands, or edits outside its own repo. Without it, an agent would read a peer's
  request as an instruction from its human.
- **Bodies are sanitised**: attempts to forge the `<agent-message>` wrapper are neutralised, and
  control characters are stripped so a raw ESC sequence cannot drive the receiving terminal.
- **Loop guards**: a thread is capped at `max_hops` (default 4), each target at `rate_per_min`
  (default 6), and self-sends are refused. See `ap log --refused`.
- **Messages expire** after 4h by default, so a session resumed days later is not ambushed by
  stale instructions.
- Spawns are read-only unless `--allow-writes`, and always budget-capped.

## Docs

- [`docs/protocol.md`](docs/protocol.md) - the v1 envelope, delivery rules, store layout
- [`docs/remote.md`](docs/remote.md) - how a cross-machine backend would attach (not implemented)

## Tests

```sh
node --test test/*.test.js
```

## Known limits

- **Pane delivery needs zellij.** Without it, live agents are mailbox-only, which means normal
  messages land at the recipient's next turn boundary or next prompt. Spawn is unaffected.
- **A single `Stop` block drains the whole queue** and cannot immediately block again
  (`stop_hook_active`), so mail arriving *during* that continuation waits for the next boundary.
  The injected text tells the agent to run `ap read --drain`, which closes the gap.
- **Local only.** One machine, one Unix user.

## License

MIT
