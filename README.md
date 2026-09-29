# dsh-peer-sessions

> Symmetric, user-granted channels between **conversations at the same level** for
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — two sessions you
> drive yourself, talking to each other. **No parent. No child.**

**[中文](README.zh.md) · English**

---

## What it is

Two long-lived sessions — say `/srv/orders-api` and `/srv/web-client` —
that both belong to you and neither of which outranks the other. When one changes an API
contract, it tells the other. When the other finishes adapting, it replies.

This is **not** `subagent`. The dividing line:

> **If one side ending means the other should stop too — that's a subagent.
> If both can live on independently — that's a peer.**

The existing `send_message` / `list_agents` pair is built on parent-owns-child
(`isOwnedBy`). Peer channels have no ownership, so they cannot reuse it.

## The hard rule

**The conversation list an agent sees must be a subset of the list a human sees in the
sidebar. An agent must never talk to a conversation the human cannot see.**

The addressable set is derived from the sidebar's own visibility rule
(`sessionVisible` in `dsh-client-ui-workspace`). The two host reads — note the
service name and the return shape, both of which the first draft of this README
got wrong:

```js
// The rule in full, including WHY each hidden session is hidden, is
// lib/addressable.js (`classify`) — that file is authoritative, this is a sketch.
const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
const { items } = await ctx.sessionController.list({}, signal)   // { items }, not an array
const addressable = items.filter(s =>
      s.origin !== 'subagent'
   && !archived.has(s.sessionId)
   && !s.blank)
```

Archived, blank placeholder, and subagent sessions are excluded. Delivery re-reads this
list every single time, so archiving a peer revokes reachability immediately — no listener,
no cache.

## Design

Full frozen specification: **[docs/design.md](docs/design.md)** — the authoritative
source for what this should do and why.

## Maintaining it

**[MAINTENANCE.md](MAINTENANCE.md)** is written for whoever picks this up next,
including a fresh agent conversation with no history: how it is wired in, the
four invariants, and fifteen traps that have already cost real time — the loader
that re-applies a plugin without re-reading its module, the skill that cannot be
symlinked, the `node_modules` link that must be a link, and the projection shapes
that are not what you would guess.

Read it before changing anything.

## Interfaces

**Commands you type**

| Command | Effect |
|---|---|
| `/peers` | List channels: peer, grant tier, remaining quota, peer visibility |
| `/peer connect <title> [once\|session]` | Open a channel; the tier choice uses a native option card |
| `/peer revoke <title>` | Close a channel |
| `/peer progress <title>` | Read a peer's projected progress |

**Tools the model calls**

| Tool | Effect |
|---|---|
| `peer_send` | Send a message; without a grant this raises the consent card |
| `peer_inbox` | Read the inbox: one summary line per item, or the full delivered text of one item by id |
| `peer_progress` | Read a peer's projection + summary |
| `peer_list` | Inspect channels and permissions |

**No client code.** Command output renders through the existing chat UI, consent cards
through the existing user-questions UI, and message provenance through the existing
`form: 'relay'` rendering. This package declares no `dsh.client`.

## Loop protection

Two conversations answering each other can go on indefinitely, so there are three
ceilings and one timeout notice. All of them are decided BEFORE a delivery happens — a
refused delivery spends no quota and does not advance the chain. Every number below is a
**config field** (see [Configuration](#configuration)); these are the defaults.

| Guard | Limit | Meaning |
|---|---|---|
| Rate per pair | 30 / 60s | Fixed window, held on the channel |
| Total per pair | 200 | Lifetime deliveries on one channel (`once` buys 1) |
| Hop count | 3 | Depth of a causal chain being RELAYED across conversations; two peers chatting normally are not affected |
| Request timeout | `replyWithin` | Announces once on the asking side, and **never resends** |

`replyWithin` on a `request` (e.g. `"15m"`, `"4h"`) is a real deadline: when it passes, the
asking side sees an `Overdue` notice on its next tool call, the receiving side sees
`[timed out · …]` in its listing, and fetching that body adds a `deadline: OVERDUE` line.

### Waiting, and how not to

Delivery is idle-first in **both** directions, and the second one is what catches people:

- your message queues behind the peer's current turn — it never interrupts them;
- their reply queues behind **your** current turn, opening a *new* turn rather than
  interrupting the one you are in. A blocking call is atomic, so a reply arriving during a
  long command waits behind it.

So an agent should never sleep, poll, or hold `wait_agent` open for a peer. It either ends
the turn and is woken by the reply, or — if it must keep working — **pulls** with
`peer_inbox`, which reads the plugin's own inbox: an already-delivered reply is readable
immediately, even though its relay message only enters the transcript on the next turn.

While a turn is running, an inbound peer message appears in the **queue strip above the
composer**, printed with its full provenance header — text in that box which is not yours
says whose it is. Each item offers edit / delete / **steer into the running turn**, and
`Cmd`/`Ctrl`+`Enter` interjects every queued message. That is the human's escape hatch when a
long step is holding a reply.

## Configuration

The thresholds are yours to tune, from the plugin's composition row:

```yaml
- id: dsh-peer-sessions
  name: dsh-peer-sessions
  config:
    hopLimit: 5
    rateLimit: 60
    rateWindowMs: 60000
    channelBudget: 500
    inboxLimit: 100
    requestMemory: 1000
    pendingGraceMs: 86400000
    hopMemoryMs: 900000
    maxCandidates: 8
    recentTurns: 3
    previewMaxChars: 200
```

| Field | Default | What it bounds |
|---|---|---|
| `hopLimit` | `3` | How far a chain may be relayed across conversations before it is refused |
| `rateLimit` / `rateWindowMs` | `30` / `60000` | Deliveries one pair may make inside a fixed window |
| `channelBudget` | `200` | Lifetime deliveries on one channel |
| `hopMemoryMs` | `900000` | How long an inbound message keeps counting as "the one being answered" |
| `inboxLimit` | `50` | Inbox items retained per conversation |
| `requestMemory` | `500` | How many request issuers are remembered for the reply-direction check |
| `pendingGraceMs` | `86400000` | How long an unanswered request keeps being reported |
| `maxCandidates` | `8` | Conversations listed before an ambiguous-title refusal summarises |
| `recentTurns` | `3` | Trailing turns `peer_progress` summarises |
| `previewMaxChars` | `200` | Cap on one preview line in `peer_progress` |

Two things worth knowing before you edit it:

- **A row's `config` replaces the whole object — it is not merged.** Naming one field is
  fine (the rest come from the schema's declared defaults, and a test pins that), but when
  *layers* override the same row, the later `config` object wins **entirely**. If you set
  these from two places, list every field you want to keep in the later one.
- **Every field has a default.** A field without one would make an omitted `config` a
  validation failure, and a plugin that fails validation is a **warning** at startup, not
  an error: the profile boots with this plugin silently missing. The defaults are the
  values in the table above, so omitting `config` entirely is always safe.

## Data and boundaries

Everything this plugin owns is **in process memory**. Nothing is written to disk, and
nothing is written into a session log:

- Channels, grants, the inbox, pending deadlines — all of it is a map keyed by session id,
  and **a restart clears it**. Grants die with the process; that is the documented scope of
  "for this conversation", not an oversight.
- Because nothing is a session event, this state **cannot be replayed or recovered from a
  transcript**. `peer_inbox(id)`'s promise ("the body stays readable") is bounded by the
  life of the host process.
- Why not persist it: a custom session-event `type` is refused by the persistence reader
  unless it carries `ignorable: true`, which a live `Session.append()` cannot set — the
  session would then be unopenable. See `docs/design.md` H2 and `MAINTENANCE.md` §2.1.
- Two consequences worth stating plainly: a **plugin re-apply** (the loader reloading after
  a file change) keeps the channels, while **disabling and re-enabling the row** also keeps
  them — they are not cleared on unload, only by the process ending.

## Uninstall

```sh
./uninstall.sh
```

It undoes the four install steps, in this order:

| Step | What it removes |
|---|---|
| 1 | the deployed skill `~/.dsh/skills/peer-session/` |
| 2 | the hand-written `insert` row in the profile's `cordis.patch.yml` (backed up first) |
| 3 | the profile dependency (`dsh plugin remove dsh-peer-sessions`) |
| 4 | this package's `node_modules` symlink |

**Restart the profile** afterwards — the plugin stays loaded until the process restarts.
Route-A installs (through the plugin manager) are removed in the manager instead; run this
script only for the route you actually used, and check afterwards:

```sh
grep -c dsh-peer-sessions ~/.dsh/profiles/web/cordis.patch.yml   # → 0
```


## Installation

**Two routes exist; use one.** Both activate the same plugin id. Nothing rejects the
duplication — the composer lists the row twice and the loader mounts that id **once, last
one wins, with no warning** (measured on 0.2.0-rc.2; see `MAINTENANCE.md` §十一之四). So
the cost is not a crash but a **silently shadowed row**: whichever copy comes later decides
the row's `config`, which is the kind of thing you discover after an afternoon of
wondering why a setting did nothing.

### Route A — as a bundle (desktop "Manage plugins" / repository URL)

This package declares `dsh.bundle`, so dsh **0.2.0+**'s plugin manager treats it
as a **composition layer**: installing it takes effect by itself, with **no
profile file edited by hand**.

- Desktop: "Manage plugins" → paste the repository URL (or the npm name).
- CLI (except the `desktop` profile — the official CLI refuses plugin management
  for it, so the desktop app must use its own UI):

```sh
dsh plugin --profile <profile> add <repository-url-or-package-name>
```

> **A hard requirement in 0.2.0**: the manager's `inspectionOf()` accepts a
> package only when `dsh.bundle` is an object; otherwise it refuses with
> `not-a-bundle` and rolls the profile back. Declared here since v1.0.3.

The desktop installs from a **git snapshot**, not your working copy, so each
release needs an update in the manager.

### Route B — local clone + `./install.sh`

```sh
./install.sh
```

It does four things: links this package's `node_modules` to the profile's (so
`@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools` resolve, on the **same module
instances** the harness already loaded), adds the profile dependency, appends the
composition row, and copies the skill. `link:` installs are live — edit and
restart.

> `./install.sh` **skips** appending that row when it finds this package is
> already an active bundle of the profile (i.e. installed via Route A), because a
> duplicate row silently shadows the other one (see above).

By hand instead:

```sh
cd ~/.dsh/profiles/web
dsh plugin --profile web add link:/path/to/dsh-peer-sessions
```

Then append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-peer-sessions
      name: dsh-peer-sessions
```

Copy the skill — a **copy**, not a symlink, because the skill provider lists
skill roots with `lstat` semantics and a symlinked directory is never discovered:

```sh
mkdir -p ~/.dsh/skills && cp -r skill/peer-session ~/.dsh/skills/
```

Restart the web profile, then check with `/peers`.

## Development

```sh
npm run link     # once per machine: links node_modules to the running harness
npm test         # the whole suite; no harness process required
```

The tests exercise the real `@deepseek-ai/dsh-llm` message construction, and the
real `@deepseek-ai/dsh-session-format-v3-to-v4` admission check as an oracle, plus
a fake host context — so every invariant is covered without a running process.

The link is a **prerequisite, not a convenience**: a bare `@deepseek-ai/*`
specifier resolves against the importing file's real path, so on a machine that
never ran `scripts/link-deps.sh` the suite fails at import. The current test count
is whatever `npm test` prints on its last line.

## Status

**Live.** The design is frozen in [docs/design.md](docs/design.md) (§12 records
what was verified on a real host, §13 the milestone breakdown).
