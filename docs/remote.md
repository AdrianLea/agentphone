# Going remote (design note - not implemented)

v1 is local-only. This records how a cross-machine backend would attach, so v1 does not
accidentally close the door. Nothing in v1 depends on any of it.

## Why there is no transport abstraction yet

There is one honest seam, not a speculative plugin layer: the envelope in
[`protocol.md`](./protocol.md) is versioned and carries `from.host`, `to`, and a `reply_to`
already shaped as `{ transport, addr }`. Local delivery uses `transport: "local-fs"`.

A pass-through interface wrapping a single implementation would be indirection with nothing on
the other side of it, so `src/store.js` *is* the local transport. The contract a second transport
must satisfy is written down here instead:

```
put(agentAddr, envelope)        -> queue a message for an agent
take(agentAddr, { cap, where }) -> atomically claim pending messages
peek(agentAddr)                 -> pending without claiming
recordThread(envelope)          -> append to a thread
awaitReply(thread, msgId, ms)   -> resolve when a reply lands
```

`store.js` implements exactly this over the filesystem. When a second implementation exists, the
shared shape gets extracted then - with two real callers to validate it, rather than guessed at
now with one.

## Shape of a remote backend

The natural fit is a Cloudflare Worker plus one Durable Object per phonebook ("team"):

- **Durable Object per team** - serialises all queue mutations, which is what makes `take()`
  atomic across machines without a lock protocol.
- **DO SQLite** for `registry`, `threads`, and the append-only `log`.
- **WebSocket hibernation** for push, so an idle agent costs nothing while connected. Each agent
  opens one socket; `put()` fans out to the recipient's socket if present, else the message waits
  in SQLite for the next `take()`.
- **Plain HTTP fallback** (`POST /put`, `POST /take`) so a machine behind a restrictive network
  still works by polling.

Auth is a per-team shared token in `config.json`, sent as a bearer header. Rotation is a token
swap; the DO holds the current and previous token during a rollover.

## Addressing

Handles become `handle@host` (or `handle@team`). Resolution order stays: exact handle, alias,
session-id prefix, directory, directory glob - with the host suffix narrowing before any of it.
`from.host` is already emitted, and the envelope renderer already surfaces a `host="..."`
attribute when a message crosses machines, so a recipient can see that a request came from
elsewhere.

## What does *not* survive going remote

Two routes are inherently local and must degrade explicitly rather than silently:

- **Pane delivery** needs a zellij socket on the same machine. A remote target is `mailbox` or
  `spawn` only, and `ap who` must show that in its `REACH` column rather than promising `instant`.
- **Spawn** runs `claude -p` locally. Remote spawn means asking the *remote* agentphone to spawn
  on your behalf - a request the DO forwards to that host's agent, with its own budget cap
  enforced there, not here.

## Security posture changes materially

Locally, every participant is the same Unix user, and the store is `0700`. Remotely that stops
being true, and the parts of v1 that already anticipate it become essential rather than merely
prudent:

- **Provenance framing** is the only thing distinguishing a peer's request from the user's own
  instruction. Remote messages must additionally render `host=` and should be visually marked as
  off-machine.
- **Body sanitisation** (wrapper forgery, control characters) becomes a trust boundary rather
  than hygiene, because the sender is no longer necessarily you.
- **Hop and rate limits** must be enforced *server-side* in the DO. Client-side limits stop a
  well-behaved agent from looping; they do not stop a misbehaving or compromised peer.
- `--allow-writes` on a spawn should be refusable per-team, and off by default for remote
  requesters.

None of this is built. It is written down so the v1 choices that make it possible - a versioned
envelope, host in the identity, server-enforceable guards, an explicit `REACH` that can say
"not reachable that way" - are understood as deliberate rather than incidental.
