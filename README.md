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
(`sessionVisible` in `dsh-client-ui-workspace`):

```js
const archived = new Set(ctx.workspace.archivedSessionIds)
const summaries = await ctx.sessionController.list()   // same source as the sidebar
const addressable = summaries.filter(s =>
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
four invariants, and thirteen traps that have already cost real time — the loader
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
refused delivery spends no quota and does not advance the chain.

| Guard | Limit | Meaning |
|---|---|---|
| Rate per pair | 30 / 60s | Fixed window, held on the channel |
| Total per pair | 200 | Lifetime deliveries on one channel (`once` buys 1) |
| Hop count | 3 | Depth of a causal chain being RELAYED across conversations; two peers chatting normally are not affected |
| Request timeout | `replyWithin` | Announces once on the asking side, and **never resends** |

`replyWithin` on a `request` (e.g. `"15m"`, `"4h"`) is a real deadline: when it passes, the
asking side sees an `Overdue` notice on its next tool call, the receiving side sees
`[timed out · …]` in its listing, and fetching that body adds a `deadline: OVERDUE` line.

## Installation

**Two routes exist; use one.** Both activate the same plugin id, and using both
installs the plugin twice.

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
> already an active bundle of the profile (i.e. installed via Route A). Both
> routes in place would activate the plugin twice.

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
node --test      # 25 tests, no harness required
```

The tests exercise the real `@deepseek-ai/dsh-llm` message construction and a fake
host context, so every invariant is covered without a running process.

## Status

**M1 implemented**, awaiting a real two-conversation run. See
[docs/design.md §13](docs/design.md) for the milestone breakdown and the
acceptance walkthrough, and §12 for the runtime facts established while
implementing — two of which corrected the draft design.
