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
four invariants, and twelve traps that have already cost real time — the loader
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
| `peer_inbox` | Read the inbox |
| `peer_progress` | Read a peer's projection + summary |
| `peer_list` | Inspect channels and permissions |

**No client code.** Command output renders through the existing chat UI, consent cards
through the existing user-questions UI, and message provenance through the existing
`form: 'relay'` rendering. This package declares no `dsh.client`.

## Installation

```sh
./install.sh
```

It does four things: links this package's `node_modules` to the profile's (so
`@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools` resolve, on the **same module
instances** the harness already loaded), adds the profile dependency, appends the
composition row, and copies the skill.

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
