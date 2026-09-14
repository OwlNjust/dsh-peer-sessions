/**
 * Unit and integration tests for the peer-session plugin.
 *
 * These run against the real `@deepseek-ai/dsh-llm` (through the package's
 * `node_modules` link to the deployment) so message construction is exercised
 * for real, and against a fake host context so the invariants can be tested
 * without a running harness.
 *
 * Run with:  node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { classify, listAddressable, resolveTarget, labelOf, stripInvisible, displayToken } from '../lib/addressable.js'
import {
  PeerStore,
  pairKey,
  CHANNEL_BUDGET,
  HOP_LIMIT,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  readMarker,
  stateLabel,
  parseDuration,
} from '../lib/store.js'
import { buildPeerMessage, buildDeliveryNotice, PEER_KIND } from '../lib/messages.js'
import { translator, resolveLocale, normalizeLocale, DEFAULT_LOCALE } from '../lib/i18n.js'
import { isRuntimeRoot } from '../lib/consent.js'
import { PeerCore, PeerRefusal } from '../lib/core.js'
import { registerTools } from '../lib/tools.js'
import { registerCommands } from '../lib/commands.js'

// ---------------------------------------------------------------- test doubles

/** The plugin entry, imported once: it holds module-scoped state by design. */
const pluginEntry = (await import('../lib/index.js')).default

const SELF = 'session-self'
const PEER = 'session-peer'

/** One SessionSummary-shaped row. */
function summary(sessionId, extra = {}) {
  return {
    sessionId,
    updatedAt: 1_700_000_000_000,
    running: true,
    blank: false,
    cwd: `/work/${sessionId}`,
    projections: {},
    ...extra,
  }
}

/** One session summary carrying a real title projection. */
function titled(sessionId, title) {
  return summary(sessionId, { projections: { asOfSeq: 0, values: { title } } })
}

/**
 * Register the commands against a capturing fake and return their handlers, so
 * a test can drive exactly what a typed command line produces.
 * @param core - the peer core to register against.
 * @returns handlers keyed by command name.
 */
function captureCommands(core) {
  const handlers = {}
  registerCommands(
    {
      register(definition) {
        handlers[definition.name] = definition.handler
        return () => {}
      },
    },
    core,
  )
  return handlers
}

/** A fake agent that records what was delivered to it. */
function fakeAgent(id, received, deliveredTo) {
  const note = (via) => (message) => {
    received.push({ via, message, to: id })
    if (deliveredTo === undefined) return
    const list = deliveredTo.get(id) ?? []
    list.push({ via, message })
    deliveredTo.set(id, list)
  }
  return {
    id,
    status: 'idle',
    followup: note('followup'),
    steer() {
      throw new Error('steer() must never be used: it would interrupt the peer')
    },
    inject: note('inject'),
  }
}

/**
 * A minimal host context: exactly the surface the plugin touches.
 *
 * `grant` is the OPTION INDEX the fake human picks (or null for "no answerer").
 * It is an index rather than a label because a real UI echoes back the label it
 * was shown, whatever language that was — a fake returning a hard-coded English
 * string would silently stop matching once the plugin asked in another language,
 * which is precisely how this was found. There is exactly one question now, so
 * a test that counts `asked` catches any regression to two cards.
 *
 * `locale` seeds the Host settings document the plugin reads its language from.
 */
function fakeCtx({
  items,
  archived = [],
  agentIds = [],
  grant = null,
  locale,
  revive = false,
  resolved = undefined,
}) {
  const received = []
  /**
   * What each agent received, keyed by that agent's id.
   *
   * `received` above is one flat list, kept because most tests only ever deliver
   * in one direction. This per-agent view is what lets a test compare a delivered
   * message against the copy the recipient's inbox archived — and the inbox is
   * per-recipient, so a flat list cannot answer that.
   */
  const deliveredTo = new Map()
  const agents = new Map(agentIds.map((id) => [id, fakeAgent(id, received, deliveredTo)]))
  const asked = []
  const listeners = new Map()
  return {
    received,
    deliveredTo,
    asked,
    /** Make a live agent cold again, the way an idle conversation becomes cold. */
    drop: (id) => agents.delete(id),
    agents: {
      get: (id) => agents.get(id),
      roots: () => [...agents.values()],
    },
    sessions: { get: () => undefined },
    sessionTitle: { get: () => undefined },
    workspaceRegistry: { archivedSessionIds: archived },
    settings: { get: (ns) => (ns === 'locale' ? locale : undefined) },
    get(name) {
      if (name === 'settings') return this.settings
      return undefined
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    sessionController: {
      list: async () => ({ items }),
      resolveAgent: async (id) => {
        if (resolved !== undefined) return resolved
        const existing = agents.get(id)
        if (existing !== undefined) return { agent: existing }
        // `revive` models a cold conversation the controller can resume: it is
        // absent from the live registry until resolved, which is exactly the
        // case that decides `willWake`.
        if (!revive) return { error: { code: 'session/not-found' } }
        const created = fakeAgent(id, received, deliveredTo)
        agents.set(id, created)
        return { agent: created }
      },
    },
    userQuestions: {
      ask: async (request) => {
        asked.push(request)
        const question = request.questions[0]
        if (grant === null) throw new Error('no answerer')
        const index = grant
        const option = question.options[index]
        assert.ok(option, `question "${question.id}" has no option ${index}`)
        // Echo the offered label, exactly as a UI does.
        return { answers: [{ id: question.id, selected: [option.label] }] }
      },
    },
  }
}

// ------------------------------------------------------------------- H1: list

test('classify excludes subagent, archived, and blank rows', () => {
  const archived = new Set(['session-archived'])
  assert.equal(classify(summary('a'), archived).addressable, true)
  assert.match(classify(summary('a', { origin: 'subagent' }), archived).reason, /subagent/)
  assert.match(classify(summary('session-archived'), archived).reason, /archived/)
  assert.match(classify(summary('a', { blank: true }), archived).reason, /blank/)
})

test('listAddressable returns a strict subset of the sidebar set', async () => {
  const sidebar = [
    summary(SELF),
    summary(PEER),
    summary('session-archived'),
    summary('session-sub', { origin: 'subagent' }),
    summary('session-blank', { blank: true }),
  ]
  const ctx = fakeCtx({ items: sidebar, archived: ['session-archived'] })
  const entries = await listAddressable(ctx)
  assert.deepEqual(
    entries.map((entry) => entry.sessionId),
    [SELF, PEER],
  )
})

test('a cold session stays addressable', async () => {
  const ctx = fakeCtx({ items: [summary(SELF), summary(PEER, { running: false })] })
  const entries = await listAddressable(ctx)
  assert.equal(entries.length, 2)
  assert.equal(entries[1].running, false)
})

test('label falls back to the workspace basename when no title is known', () => {
  const ctx = fakeCtx({ items: [] })
  assert.equal(labelOf(ctx, summary('x', { cwd: '/work/proj' })), 'proj')
})

// A projection value is JsonValue, so `null` is legal. Checking only for
// `undefined` before reading a property crashes on it — which is what a real
// session with an unset title projection supplies. Found on the first live run.
test('a null projection value is not treated as an object', () => {
  const ctx = fakeCtx({ items: [] })
  const nullTitle = summary('x', { cwd: '/work/proj', projections: { asOfSeq: 0, values: { title: null } } })
  assert.doesNotThrow(() => labelOf(ctx, nullTitle))
  assert.equal(labelOf(ctx, nullTitle), 'proj')
})

// The three shapes the title projection actually takes in the wild, all
// confirmed against the on-disk projection cache.
test('every real title projection shape resolves to the title text', () => {
  const ctx = fakeCtx({ items: [] })
  const cases = [
    ['bare string', 'Paper pipeline'],
    ['cached record', { ver: 1, seq: 53, val: 'Paper pipeline' }],
    ['title snapshot', { title: 'Paper pipeline', source: 'model', eventSeq: 53, updatedAt: 1 }],
  ]
  for (const [name, value] of cases) {
    const row = summary('x', { projections: { asOfSeq: 0, values: { title: value } } })
    assert.equal(labelOf(ctx, row), 'Paper pipeline', `${name} should resolve`)
  }
  // A present-but-empty title must still fall back rather than show "".
  const empty = summary('x', { cwd: '/work/proj', projections: { asOfSeq: 0, values: { title: { ver: 1, seq: 2, val: null } } } })
  assert.equal(labelOf(ctx, empty), 'proj')
})

test('listAddressable survives null, string, and array projection values', async () => {
  const ctx = fakeCtx({
    items: [
      summary(SELF, { projections: { asOfSeq: 0, values: { title: null } } }),
      summary(PEER, { projections: { asOfSeq: 0, values: { title: 'Peer', goal: null, todo: 'nonsense', inbox: [] } } }),
    ],
  })
  const entries = await listAddressable(ctx)
  assert.deepEqual(
    entries.map((entry) => entry.label),
    ['session-self', 'Peer'],
  )
  const core = new PeerCore(ctx)
  assert.doesNotThrow(() => core.progress(entries[1]))
})

// --------------------------------------------------------------- resolveTarget

test('resolveTarget matches an exact id, an exact title, and a partial title', () => {
  const entries = [
    { sessionId: 'session-1', title: 'Backend', label: 'Backend' },
    { sessionId: 'session-2', title: 'Frontend', label: 'Frontend' },
  ]
  assert.equal(resolveTarget(entries, 'session-1', 'self').entry.sessionId, 'session-1')
  assert.equal(resolveTarget(entries, 'backend', 'self').entry.sessionId, 'session-1')
  assert.equal(resolveTarget(entries, 'front', 'self').entry.sessionId, 'session-2')
})

test('resolveTarget never guesses when several titles match', () => {
  const entries = [
    { sessionId: 'a', title: 'paper 2027', label: 'paper 2027' },
    { sessionId: 'b', title: 'paper 2026', label: 'paper 2026' },
  ]
  const found = resolveTarget(entries, 'paper', 'self')
  assert.equal(found.kind, 'many')
  assert.equal(found.candidates.length, 2)
})

test('resolveTarget excludes the asking session itself', () => {
  const entries = [{ sessionId: 'self', title: 'me', label: 'me' }]
  assert.equal(resolveTarget(entries, 'me', 'self').kind, 'none')
})

// The first live run of this path answered a request for a just-archived
// conversation with the entire fifteen-line list. The reason was available all
// along: the session sits in the hidden set, with a code that says why.
test('an archived target is refused by name, not with the whole list', async () => {
  const ctx = fakeCtx({
    items: [titled(SELF, 'Me'), titled('session-gone', 'Peer')],
    archived: ['session-gone'],
  })
  const core = new PeerCore(ctx, undefined, translator('zh'))
  await assert.rejects(
    () => core.resolveOrRefuse('Peer', SELF, undefined),
    (error) => {
      assert.match(error.message, /「Peer」已归档/)
      assert.doesNotMatch(error.message, /当前可见的会话/, 'a named reason beats a wall of candidates')
      return true
    },
  )
})

test('a subagent session is refused with its own reason', async () => {
  const ctx = fakeCtx({
    items: [
      titled(SELF, 'Me'),
      summary('session-sub', { origin: 'subagent', projections: { asOfSeq: 0, values: { title: 'helper' } } }),
    ],
  })
  const core = new PeerCore(ctx, undefined, translator('zh'))
  await assert.rejects(
    () => core.resolveOrRefuse('helper', SELF, undefined),
    (error) => {
      assert.match(error.message, /「helper」是子代理会话/)
      return true
    },
  )
})

test('a refusal with many candidates lists a bounded number of them', async () => {
  const many = Array.from({ length: 12 }, (_unused, index) => titled(`session-${index}`, `topic ${index}`))
  const ctx = fakeCtx({ items: [titled(SELF, 'Me'), ...many] })
  const core = new PeerCore(ctx, undefined, translator('zh'))
  await assert.rejects(
    () => core.resolveOrRefuse('nothing-like-this', SELF, undefined),
    (error) => {
      assert.match(error.message, /当前可见的会话/)
      assert.match(error.message, /另有 4 个/, 'twelve candidates minus the eight shown')
      assert.doesNotMatch(error.message, /topic 11/, 'the ninth onward is summarised, not listed')
      return true
    },
  )
})

// ------------------------------------------------------------ input hygiene

// Pasted text carries zero-width characters that are invisible and not matched
// by `\s`. Observed live: a pasted `/peer connect …` answered
// `unknown subcommand "connect"` while listing `connect` as available.
test('stripInvisible removes zero-width and bidi-control characters', () => {
  assert.equal(stripInvisible('con\u200Bnect'), 'connect')
  assert.equal(stripInvisible('a\uFEFFb'), 'ab')
  assert.equal(stripInvisible('\u202Eabc'), 'abc')
  assert.equal(stripInvisible('connect'), 'connect')
  assert.equal(stripInvisible(' 连接 '), ' 连接 ')
  assert.equal(stripInvisible(null), '')
})

test('displayToken shows code points only when a reader could be misled', () => {
  assert.equal(displayToken('connect'), 'connect')
  assert.equal(displayToken(''), '(empty)')
  // A Cyrillic homoglyph looks like "connect" but is not.
  assert.match(displayToken('c\u043Ennect'), /U\+043E/)
  assert.match(displayToken('con\u200Bnect'), /U\+200B/)
})

test('resolveTarget matches a title pasted with a zero-width character', () => {
  const entries = [{ sessionId: PEER, title: 'Peer', label: 'Peer' }]
  assert.equal(resolveTarget(entries, 'Pe\u200Ber', SELF).entry.sessionId, PEER)
})

test('a pasted subcommand carrying a zero-width character still parses', async () => {
  const ctx = fakeCtx({ items: [titled(SELF, 'Me'), titled(PEER, 'Peer')], agentIds: [SELF, PEER] })
  const core = new PeerCore(ctx, undefined, translator('zh'))
  const handlers = captureCommands(core)
  // Exactly what the live failure looked like: the space after `connect` had
  // been pasted as text containing an invisible character.
  const result = await handlers.peer({
    agent: ctx.agents.get(SELF),
    rawInput: ' connect\u200B Peer session',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.equal(core.store.between(SELF, PEER).tier, 'session')
})

test('a genuinely unrecognizable subcommand is reported with its code points', async () => {
  const ctx = fakeCtx({ items: [titled(SELF, 'Me'), titled(PEER, 'Peer')], agentIds: [SELF, PEER] })
  const core = new PeerCore(ctx, undefined, translator('zh'))
  const handlers = captureCommands(core)
  // Cyrillic "о": a homoglyph that renders as `connect`.
  const result = await handlers.peer({
    agent: ctx.agents.get(SELF),
    rawInput: ' c\u043Ennect Peer session',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /U\+043E/)
})

// --------------------------------------------------------------------- store

test('a session-tier channel carries a budget; a once-tier channel carries one delivery', () => {
  const store = new PeerStore()
  const session = store.open({ a: 'a', b: 'b', tier: 'session', by: 'a' })
  assert.equal(session.remaining, CHANNEL_BUDGET)
  const once = store.open({ a: 'c', b: 'd', tier: 'once', by: 'c' })
  assert.equal(once.remaining, 1)
  assert.equal(store.spend(once), true)
  assert.equal(store.spend(once), false)
})

test('channels are symmetric: either end finds the same channel', () => {
  const store = new PeerStore()
  store.open({ a: 'a', b: 'b', tier: 'session', by: 'a' })
  assert.equal(store.between('a', 'b'), store.between('b', 'a'))
  assert.equal(pairKey('a', 'b'), pairKey('b', 'a'))
})

// A state whose label is missing falls through to a bare, markerless line. That
// happened for real when the state names were reworded and the label table was
// not: the very first listing of an incoming request came out with no marker.
// This asserts every state the store can produce has a label of its own.
test('every inbox status has its own label, not the fallback', () => {
  const states = ['unread', 'unread-unanswered', 'read-unanswered', 'replied']
  assert.equal(readMarker('unread-unanswered'), 'unread', 'a fresh request must be marked unread')
  assert.equal(readMarker('read-unanswered'), 'read · never answered')
  assert.equal(readMarker('replied'), '', 'a settled request carries no marker')
  assert.equal(stateLabel('unread-unanswered'), 'unread · never opened')
  assert.equal(stateLabel('read-unanswered'), 'read · never answered')
  for (const status of states) {
    // The fallback returns the raw status, which is an identifier leaking into
    // the listing — the failure mode this test exists to catch.
    assert.notEqual(readMarker(status), undefined)
    if (status !== 'replied') assert.notEqual(stateLabel(status), status)
  }
})

// ------------------------------------------------------------- loop protection

// `replyWithin` was prose until loop protection needed it: it was printed into
// the delivered body and never interpreted, so a request could not time out and
// B5 had nothing to fire on.
test('parseDuration reads the units the tool description promises', () => {
  assert.equal(parseDuration('15m'), 15 * 60_000)
  assert.equal(parseDuration('4h'), 4 * 3_600_000)
  assert.equal(parseDuration('90s'), 90_000)
  assert.equal(parseDuration(' 2 h '), 2 * 3_600_000)
  assert.equal(parseDuration('250ms'), 250)
  // Unparseable input must NOT become a deadline: a request with no real
  // deadline is honest, one with a made-up deadline is not.
  assert.equal(parseDuration('soon'), undefined)
  assert.equal(parseDuration(''), undefined)
  assert.equal(parseDuration('0m'), undefined)
  assert.equal(parseDuration(undefined), undefined)
  assert.equal(parseDuration(42), undefined)
})

test('a hop chain deepens as peers answer each other, and stops at the limit', () => {
  const store = new PeerStore()
  // A fresh chain, sent on the user's own initiative.
  assert.equal(store.nextHop('a'), 1)

  // b is answering a message that carried hop 1, so its reply carries 2.
  store.noteInboundHop('b', 1)
  assert.equal(store.nextHop('b'), 2)
  store.noteInboundHop('a', 2)
  assert.equal(store.nextHop('a'), 3)
  store.noteInboundHop('b', 3)
  assert.equal(store.nextHop('b'), HOP_LIMIT + 1, 'the next hop is what the guard refuses')

  // A stale mark is not an answer: past the memory window this is a new chain,
  // not a continuation of something from twenty minutes ago.
  store.noteInboundHop('c', HOP_LIMIT)
  store.inboundHops.set('c', { hop: HOP_LIMIT, at: Date.now() - 16 * 60_000 })
  assert.equal(store.nextHop('c'), 1)
})

test('the rate limit is a fixed window, and it resets', () => {
  const store = new PeerStore()
  const channel = store.open({ a: 'a', b: 'b', tier: 'session', by: 'a' })
  const start = 1_000_000
  for (let i = 0; i < RATE_LIMIT; i += 1) {
    assert.equal(store.withinRate(channel, start), true, `delivery ${i + 1} is within the limit`)
  }
  assert.equal(store.withinRate(channel, start), false, 'one past the limit is refused')
  assert.equal(store.withinRate(channel, start + RATE_WINDOW_MS - 1), false, 'still inside the window')
  assert.equal(store.withinRate(channel, start + RATE_WINDOW_MS), true, 'a new window starts over')
})

test('an overdue request is reported once, and a deadline-less one never', () => {
  const store = new PeerStore()
  const now = 5_000_000
  store.notePending({ requestId: 'req-due', from: 'a', to: 'b', dueAt: now - 1 })
  store.notePending({ requestId: 'req-later', from: 'a', to: 'b', dueAt: now + 60_000 })
  store.notePending({ requestId: 'req-forever', from: 'a', to: 'b', dueAt: Number.POSITIVE_INFINITY })

  assert.equal(store.isOverdue('req-due', now), true)
  assert.equal(store.isOverdue('req-later', now), false)

  const first = store.overdueRequests('a', now)
  assert.deepEqual(first.map((r) => r.requestId), ['req-due'])
  assert.deepEqual(store.overdueRequests('a', now), [], 'reported once, not on every call')
  assert.deepEqual(store.overdueRequests('b', now), [], 'only the waiting side is told')

  assert.deepEqual(store.pendingFor('a').map((r) => r.requestId), ['req-due', 'req-later', 'req-forever'])
  assert.equal(store.clearPending('req-due'), true)
  assert.equal(store.isOverdue('req-due', now), false, 'an answer retires the deadline')
})

test('revoke removes the channel and replies mark an inbound request answered', () => {
  const store = new PeerStore()
  const channel = store.open({ a: 'a', b: 'b', tier: 'session', by: 'a' })
  store.record({ id: 'm1', to: 'b', requestId: 'req-1', status: 'unread-unanswered', kind: 'request' })
  assert.equal(store.markReplied('b', 'req-1'), true)
  assert.equal(store.inboxFor('b')[0].status, 'replied')
  store.revoke(channel)
  assert.equal(store.between('a', 'b'), undefined)
})

// ------------------------------------------------------------------ messages

test('a peer message carries relay provenance and an attributable sender', () => {
  const message = buildPeerMessage({
    senderId: SELF,
    senderLabel: 'Backend',
    tier: 'session',
    channelId: 'pc-1',
    kind: 'notice',
    summary: 'the orders contract changed',
  })
  assert.equal(message.source.kind, PEER_KIND)
  assert.equal(message.source.form, 'relay')
  assert.equal(message.source.senderSessionId, SELF)
  assert.match(message.content[0].text, /NOT a user instruction/)
  assert.notEqual(message.source.kind, 'user')
})

// The delivered body must not describe the grant differently from the card the
// human approved. This drifted once: `once` was redefined as one EXCHANGE while
// the body still said "single delivery".
test('the delivered body agrees with the consent card about the tier', () => {
  const once = buildPeerMessage({
    senderId: SELF,
    senderLabel: 'Backend',
    tier: 'once',
    channelId: 'pc-1',
    kind: 'request',
    summary: 'x',
  })
  const onceText = once.content[0].text
  assert.match(onceText, /one exchange/)
  assert.doesNotMatch(onceText, /single delivery/)
  assert.doesNotMatch(onceText, /one delivery/)

  const session = buildPeerMessage({
    senderId: SELF,
    senderLabel: 'Backend',
    tier: 'session',
    channelId: 'pc-1',
    kind: 'notice',
    summary: 'x',
  })
  assert.match(session.content[0].text, /this conversation/)
})

test('building a peer message without a sender throws rather than degrading', () => {
  assert.throws(
    () => buildPeerMessage({ senderId: '', senderLabel: 'x', tier: 'once', channelId: 'c', kind: 'notice', summary: 's' }),
    /without a sender session id/,
  )
})

test('the sender-side audit is a plugin-sourced notice', () => {
  const notice = buildDeliveryNotice('Delivered a notice to "X".', '  detail')
  assert.equal(notice.source.kind, 'plugin')
  assert.equal(notice.source.plugin, 'dsh-peer-sessions')
  assert.equal(notice.source.form, 'notice')
})

// -------------------------------------------------------------------- consent

test('isRuntimeRoot is false for an unregistered or absent agent', () => {
  const ctx = fakeCtx({ items: [] })
  assert.equal(isRuntimeRoot(ctx, undefined), false)
  assert.equal(isRuntimeRoot(ctx, { id: 'ghost' }), false)
})

test('isRuntimeRoot is false for an agent that is live but owned by another', () => {
  const ctx = fakeCtx({ items: [], agentIds: [PEER] })
  const live = ctx.agents.get(PEER)
  // Registered, but not among the registry's roots.
  ctx.agents.roots = () => []
  assert.equal(isRuntimeRoot(ctx, live), false)
})

// ------------------------------------------------------------------- deliver

test('deliver refuses to send when the peer fell out of the sidebar', async () => {
  const ctx = fakeCtx({ items: [summary(SELF)], agentIds: [SELF, PEER] })
  const core = new PeerCore(ctx)
  await assert.rejects(
    () =>
      core.deliver({
        selfAgent: ctx.agents.get(SELF),
        selfLabel: 'Me',
        peerEntry: { sessionId: PEER, label: 'Peer', running: true, projections: {} },
        payload: { kind: 'notice', summary: 'hi' },
      }),
    PeerRefusal,
  )
  assert.equal(ctx.received.length, 0)
})

test('deliver sends nothing when the human declines', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER)],
    agentIds: [SELF, PEER],
    grant: 2,
  })
  const core = new PeerCore(ctx)
  const result = await core.deliver({
    selfAgent: ctx.agents.get(SELF),
    selfLabel: 'Me',
    peerEntry: { sessionId: PEER, label: 'Peer', running: true, projections: {} },
    payload: { kind: 'notice', summary: 'hi' },
  })
  assert.equal(result.outcome, 'declined')
  assert.equal(ctx.received.length, 0)
  assert.equal(core.store.between(SELF, PEER), undefined)
})

test('deliver queues through followup (never steer) once the human consents', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER)],
    agentIds: [SELF, PEER],
    grant: 1,
  })
  const core = new PeerCore(ctx)
  const result = await core.deliver({
    selfAgent: ctx.agents.get(SELF),
    selfLabel: 'Me',
    peerEntry: { sessionId: PEER, label: 'Peer', running: true, projections: {} },
    payload: { kind: 'request', summary: 'please adapt', requestId: 'req-1' },
  })
  assert.equal(result.outcome, 'delivered')
  assert.equal(result.channel.tier, 'session')
  const delivered = ctx.received.find((entry) => entry.via === 'followup')
  assert.ok(delivered, 'expected the message to be delivered with followup()')
  assert.equal(delivered.message.source.form, 'relay')
  assert.equal(delivered.message.source.senderSessionId, SELF)
})

test('a silent delivery uses inject so the peer is not woken', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER)],
    agentIds: [SELF, PEER],
    grant: 0,
  })
  const core = new PeerCore(ctx)
  const result = await core.deliver({
    selfAgent: ctx.agents.get(SELF),
    selfLabel: 'Me',
    peerEntry: { sessionId: PEER, label: 'Peer', running: true, projections: {} },
    payload: { kind: 'notice', summary: 'fyi' },
    silent: true,
  })
  assert.equal(result.outcome, 'delivered')
  assert.equal(ctx.received[0].via, 'inject')
})

test('a second delivery reuses the granted channel without asking again', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER)],
    agentIds: [SELF, PEER],
    grant: 1,
  })
  const core = new PeerCore(ctx)
  const peerEntry = { sessionId: PEER, label: 'Peer', running: true, projections: {} }
  const selfAgent = ctx.agents.get(SELF)
  await core.deliver({ selfAgent, selfLabel: 'Me', peerEntry, payload: { kind: 'notice', summary: 'one' } })
  await core.deliver({ selfAgent, selfLabel: 'Me', peerEntry, payload: { kind: 'notice', summary: 'two' } })
  assert.equal(ctx.asked.length, 1, 'the human is asked once per channel, not once per message')
  assert.equal(ctx.received.length, 2)
})

// `once` means one EXCHANGE, not one message. The answer to a request the same
// grant carried must ride along; otherwise the card would be raised again in the
// PEER's conversation, reading as "didn't I just approve this?".
test('a once grant buys one exchange: the answer rides the same approval', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER)],
    agentIds: [SELF, PEER],
    grant: 0,
  })
  const core = new PeerCore(ctx)
  const selfAgent = ctx.agents.get(SELF)
  const peerAgent = ctx.agents.get(PEER)

  const asked = await core.deliver({
    selfAgent,
    selfLabel: 'Me',
    peerEntry: { sessionId: PEER, label: 'Peer', running: true, projections: {} },
    payload: { kind: 'request', summary: 'please adapt', requestId: 'req-1' },
  })
  assert.equal(asked.outcome, 'delivered')
  assert.equal(asked.channel.remaining, 0, 'the request spends the single delivery')
  assert.equal(ctx.asked.length, 1)

  const answered = await core.deliver({
    selfAgent: peerAgent,
    selfLabel: 'Peer',
    peerEntry: { sessionId: SELF, label: 'Me', running: true, projections: {} },
    payload: { kind: 'reply', summary: 'adapted', replyTo: 'req-1' },
  })
  assert.equal(answered.outcome, 'delivered')
  assert.equal(answered.ridesExistingGrant, true)
  assert.equal(ctx.asked.length, 1, 'the answer must not raise a second card')
  assert.equal(core.store.between(SELF, PEER), undefined, 'the exchange is complete')

  // Here SELF started the exchange by sending the request, so the
  // `awaiting-reply` item is in PEER's inbox — measured, not inferred: a probe
  // over both inboxes showed exactly that. PEER answering it must therefore mark
  // its OWN inbox. The mirror case (a session answering a request it received)
  // puts the request at the other end, which is why `markReplied` looks at both.
  assert.equal(
    core.noteReply(PEER, 'req-1', answered.channel),
    true,
    'the marker must reach whichever end holds the request',
  )
  assert.equal(core.store.inboxFor(PEER)[0].status, 'replied')
})

test('a once grant does not carry an unrelated second message', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER)],
    agentIds: [SELF, PEER],
    grant: 0,
  })
  const core = new PeerCore(ctx)
  const peerEntry = { sessionId: PEER, label: 'Peer', running: true, projections: {} }
  const selfAgent = ctx.agents.get(SELF)
  await core.deliver({ selfAgent, selfLabel: 'Me', peerEntry, payload: { kind: 'notice', summary: 'one' } })
  await core.deliver({ selfAgent, selfLabel: 'Me', peerEntry, payload: { kind: 'notice', summary: 'two' } })
  assert.equal(ctx.asked.length, 2, 'a spent once grant must not carry a second message')
})

test('an unknown replyTo does not unlock a spent once grant', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER)],
    agentIds: [SELF, PEER],
    grant: 0,
  })
  const core = new PeerCore(ctx)
  const selfAgent = ctx.agents.get(SELF)
  const peerAgent = ctx.agents.get(PEER)
  await core.deliver({
    selfAgent,
    selfLabel: 'Me',
    peerEntry: { sessionId: PEER, label: 'Peer', running: true, projections: {} },
    payload: { kind: 'request', summary: 'please adapt', requestId: 'req-1' },
  })
  await core.deliver({
    selfAgent: peerAgent,
    selfLabel: 'Peer',
    peerEntry: { sessionId: SELF, label: 'Me', running: true, projections: {} },
    payload: { kind: 'reply', summary: 'unsolicited', replyTo: 'req-does-not-exist' },
  })
  assert.equal(ctx.asked.length, 2)
})

// The unlock is directional: naming a request that the REPLIER itself issued
// (rather than the peer) must not spend the other side's budget.
test('a reply cannot unlock the grant by naming its own request', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER)],
    agentIds: [SELF, PEER],
    grant: 0,
  })
  const core = new PeerCore(ctx)
  const selfAgent = ctx.agents.get(SELF)
  const peerEntry = { sessionId: PEER, label: 'Peer', running: true, projections: {} }
  await core.deliver({
    selfAgent,
    selfLabel: 'Me',
    peerEntry,
    payload: { kind: 'request', summary: 'mine', requestId: 'req-1' },
  })
  // SELF now claims to be replying to its own request.
  await core.deliver({
    selfAgent,
    selfLabel: 'Me',
    peerEntry,
    payload: { kind: 'reply', summary: 'to myself', replyTo: 'req-1' },
  })
  assert.equal(ctx.asked.length, 2)
})

// One card covers the whole decision. Idle conversations are cold in this
// deployment, so a separate "wake it?" prompt after every grant was friction
// against a fact, not safety: the grant states the wake and covers it.
test('a cold peer raises exactly ONE card, and that card states the wake', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER, { running: false })],
    agentIds: [SELF], // PEER is cold; the controller can still resume it
    revive: true,
    grant: 1,
  })
  const core = new PeerCore(ctx, undefined, translator('en'))
  const result = await core.deliver({
    selfAgent: ctx.agents.get(SELF),
    selfLabel: 'Me',
    peerEntry: { sessionId: PEER, label: 'Peer', running: false, projections: {} },
    payload: { kind: 'notice', summary: 'hi' },
  })
  assert.equal(result.outcome, 'delivered')
  assert.equal(ctx.asked.length, 1, 'a cold peer must not raise a second card')
  assert.match(ctx.asked[0].questions[0].detail, /is not running right now/)
  assert.match(ctx.asked[0].questions[0].detail, /wakes it/)
  assert.equal(ctx.received[0].via, 'followup')
})

test('a running peer raises a card that stays silent about waking', async () => {
  const ctx = fakeCtx({ items: [summary(SELF), summary(PEER)], agentIds: [SELF, PEER], grant: 1 })
  const core = new PeerCore(ctx, undefined, translator('en'))
  await core.deliver({
    selfAgent: ctx.agents.get(SELF),
    selfLabel: 'Me',
    peerEntry: { sessionId: PEER, label: 'Peer', running: true, projections: {} },
    payload: { kind: 'notice', summary: 'hi' },
  })
  assert.equal(ctx.asked.length, 1)
  assert.doesNotMatch(ctx.asked[0].questions[0].detail, /wakes it/)
})

test('a later delivery on an open channel wakes the peer with no card at all', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER, { running: false })],
    agentIds: [SELF],
    revive: true,
    grant: 1,
  })
  const core = new PeerCore(ctx, undefined, translator('en'))
  const selfAgent = ctx.agents.get(SELF)
  const peerEntry = { sessionId: PEER, label: 'Peer', running: false, projections: {} }
  await core.deliver({ selfAgent, selfLabel: 'Me', peerEntry, payload: { kind: 'notice', summary: 'one' } })
  assert.equal(ctx.agents.get(PEER) !== undefined, true, 'the first delivery woke it')
  // The peer goes cold again between deliveries, as an idle conversation does.
  // `deliver` reads `agents.get`, so this is the state that decides `willWake`.
  ctx.drop(PEER)
  const before = ctx.asked.length
  const second = await core.deliver({
    selfAgent,
    selfLabel: 'Me',
    peerEntry,
    payload: { kind: 'notice', summary: 'two' },
  })
  assert.equal(second.outcome, 'delivered')
  assert.equal(ctx.asked.length, before, 'the channel grant covers waking, so no second card')
  assert.equal(ctx.received.length, 2)
})

test('a silent delivery to a cold peer is refused rather than waking it', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER, { running: false })],
    agentIds: [SELF], // cold
    revive: true, // and resumable — the refusal must come from the rule, not from a failure
    grant: 1,
  })
  const core = new PeerCore(ctx, undefined, translator('en'))
  const result = await core.deliver({
    selfAgent: ctx.agents.get(SELF),
    selfLabel: 'Me',
    peerEntry: { sessionId: PEER, label: 'Peer', running: false, projections: {} },
    payload: { kind: 'notice', summary: 'hi' },
    silent: true,
  })
  assert.equal(result.outcome, 'silent-needs-running')
  assert.equal(ctx.asked.length, 0, 'it must not even ask: the request is self-contradictory')
  assert.equal(ctx.received.length, 0)
})

// --------------------------------------------------------- progress boundaries

// Fixtures below use the ACTUAL projection shapes, read from their declaring
// packages. The first live run failed precisely because fixtures were faithful
// to the types and unfaithful to the data.
test('progress renders the real goal, todos, and turn outline shapes', () => {
  const ctx = fakeCtx({ items: [] })
  const core = new PeerCore(ctx, undefined, translator('en'))
  const lines = core.progress({
    sessionId: PEER,
    label: 'Peer',
    running: true,
    cwd: '/work/peer',
    updatedAt: 1_700_000_000_000,
    projections: {
      // dsh-goal: goal: GoalProjection | null, snapshot nested one level down
      goal: { goal: { objective: 'ship the API', phase: 'active' }, roundsStarted: 3, createdAt: 1, updatedAt: 2 },
      // dsh-tool-todo: todos: TodoItem[] | null — an ARRAY, not { items }
      todos: [
        { content: 'write the route', status: 'completed' },
        { content: 'update the client', status: 'in_progress' },
        { content: 'ship it', status: 'pending' },
      ],
      // dsh-session-turn-outline: turnOutline: TurnOutlineEntry[]
      turnOutline: [
        { turn: 1, seq: 1, prompt: 'first prompt', response: 'first answer' },
        { turn: 2, seq: 9, prompt: 'second prompt', response: '' },
      ],
      permissions: { currentValue: 'workspace-write' },
      inbox: { 'next-turn': [{ id: 'm1' }], 'next-step': [] },
    },
  })
  const text = lines.join('\n')
  assert.match(text, /goal: ship the API \[active\] · round 3/)
  assert.match(text, /todos: 1 of 3 complete · now: update the client/)
  assert.match(text, /turns so far: 2/)
  assert.match(text, /turn 1: first prompt → first answer/)
  assert.match(text, /turn 2: second prompt/)
  assert.match(text, /permissions: workspace-write/)
  assert.match(text, /queued input: 1 for the next turn, 0 for the next step/)
})

test('progress treats null and wrong-shaped projections as absent', () => {
  const ctx = fakeCtx({ items: [] })
  const core = new PeerCore(ctx, undefined, translator('en'))
  const lines = core.progress({
    sessionId: PEER,
    label: 'Peer',
    running: false,
    updatedAt: 1_700_000_000_000,
    projections: {
      goal: null,
      todos: null,
      turnOutline: null,
      permissions: [],
      inbox: 'nonsense',
    },
  })
  assert.doesNotThrow(() => lines.join('\n'))
  const text = lines.join('\n')
  // Every one of these is a recognised key rendered from a shape it is not, so
  // each must contribute nothing at all — no line, no crash, and no fall-through
  // into the "other projections" list either.
  assert.doesNotMatch(text, /goal:/)
  assert.doesNotMatch(text, /todos:/)
  assert.doesNotMatch(text, /turns so far:/)
  assert.doesNotMatch(text, /permissions:/)
  assert.doesNotMatch(text, /queued input:/)
  assert.doesNotMatch(text, /other projections present/)
})

test('progress clips previews so a widened projection cannot become a transcript', () => {
  const ctx = fakeCtx({ items: [] })
  const core = new PeerCore(ctx)
  const huge = 'x'.repeat(5000)
  const text = core
    .progress({
      sessionId: PEER,
      label: 'Peer',
      running: true,
      updatedAt: 1_700_000_000_000,
      projections: { turnOutline: [{ turn: 1, seq: 1, prompt: huge, response: huge }] },
    })
    .join('\n')
  assert.ok(text.length < 1000, `expected the preview to be clipped, got ${text.length} chars`)
  assert.doesNotMatch(text, /x{300}/)
})

test('an unknown projection contributes its name but never its value', () => {
  const ctx = fakeCtx({ items: [] })
  const core = new PeerCore(ctx, undefined, translator('en'))
  const text = core
    .progress({
      sessionId: PEER,
      label: 'Peer',
      running: true,
      updatedAt: 1_700_000_000_000,
      projections: { mystery: { secretTranscript: 'should not be printed' } },
    })
    .join('\n')
  assert.match(text, /other projections present: mystery/)
  assert.doesNotMatch(text, /should not be printed/)
})

// ------------------------------------------------------------- localization

test('normalizeLocale maps BCP 47 tags onto shipped locales', () => {
  assert.equal(normalizeLocale('zh'), 'zh')
  assert.equal(normalizeLocale('zh-CN'), 'zh')
  assert.equal(normalizeLocale('zh_Hans'), 'zh')
  assert.equal(normalizeLocale('en-US'), 'en')
  assert.equal(normalizeLocale('EN'), 'en')
  assert.equal(normalizeLocale('fr'), undefined)
  assert.equal(normalizeLocale(''), undefined)
  assert.equal(normalizeLocale(null), undefined)
  assert.equal(normalizeLocale(42), undefined)
})

test('the locale comes from the Host settings document, defaulting to Chinese', () => {
  assert.equal(resolveLocale(fakeCtx({ items: [], locale: { preference: 'en' } })), 'en')
  assert.equal(resolveLocale(fakeCtx({ items: [], locale: { preference: 'zh-CN' } })), 'zh')
  // An absent preference "delegates to the browser", which the Host cannot read,
  // so the documented fallback applies — Simplified Chinese, by instruction.
  assert.equal(resolveLocale(fakeCtx({ items: [] })), DEFAULT_LOCALE)
  assert.equal(resolveLocale(fakeCtx({ items: [], locale: {} })), DEFAULT_LOCALE)
  assert.equal(resolveLocale(fakeCtx({ items: [], locale: { preference: 'fr' } })), DEFAULT_LOCALE)
})

test('a settings provider that throws on read falls back instead of breaking', () => {
  const ctx = fakeCtx({ items: [] })
  ctx.get = () => {
    throw new Error('settings exploded')
  }
  assert.equal(resolveLocale(ctx), DEFAULT_LOCALE)
})

test('both shipped locales cover every key the plugin asks for', () => {
  const en = translator('en')
  const zh = translator('zh')
  for (const key of [
    'cmd.peers.desc',
    'cmd.peer.desc',
    'cmd.peer.hint',
    'channel.none',
    'channel.header',
    'channel.line',
    'channel.revokeHintLine',
    'usage.peer',
    'usage.connect',
    'usage.revoke',
    'usage.progress',
    'peer.unknownSub',
    'connect.already',
    'connect.declined',
    'connect.ok',
    'revoke.none',
    'revoke.done',
    'resolve.many',
    'resolve.noneWithCandidates',
    'resolve.noneAlone',
    'resolve.hidden.archived',
    'resolve.hidden.subagent',
    'resolve.hidden.blank',
    'resolve.moreCandidates',
    'resolve.selfNotVisible',
    'resolve.peerNotVisible',
    'budget.spent',
    'progress.conversation',
    'progress.projected',
    'progress.goal',
    'progress.todos',
    'progress.queued',
    'progress.turns',
    'progress.turn',
    'progress.other',
    'consent.grant.header',
    'consent.grant.question',
    'consent.grant.detail',
    'consent.grant.once',
    'consent.grant.session',
    'consent.grant.decline',
    'consent.grant.wakeNote',
    'silent.needsRunning',
  ]) {
    // A missing key returns the key itself, which would surface as raw
    // identifiers in the palette or the consent card.
    assert.notEqual(en(key), key, `en is missing ${key}`)
    assert.notEqual(zh(key), key, `zh is missing ${key}`)
    assert.notEqual(en(key), '', `en ${key} is empty`)
    assert.notEqual(zh(key), '', `zh ${key} is empty`)
  }
  assert.match(zh('consent.grant.question', { peer: 'X' }), /X/)
  assert.match(en('consent.grant.question', { peer: 'X' }), /X/)
})

test('the consent card is asked in the client language and still maps back', async () => {
  // The question names the peer by the label resolved from the VISIBLE set, not
  // by whatever the caller passed, so give the fake peer a real title.

  const zh = fakeCtx({ items: [titled(SELF, '本对话'), titled(PEER, '对端')], agentIds: [SELF, PEER], grant: 1 })
  const zhCore = new PeerCore(zh, undefined, translator('zh'))
  await zhCore.deliver({
    selfAgent: zh.agents.get(SELF),
    selfLabel: '本对话',
    peerEntry: { sessionId: PEER, label: '对端', running: true, projections: {} },
    payload: { kind: 'notice', summary: 'hi' },
  })
  const zhQuestion = zh.asked[0].questions[0]
  assert.equal(zhQuestion.header, '平级会话通道')
  assert.match(zhQuestion.question, /对端/)
  assert.deepEqual(
    zhQuestion.options.map((option) => option.label),
    ['仅这一次', '本对话内允许', '拒绝'],
  )
  // Labels are echoed by the UI, so a localized label must still resolve to the
  // tier the human actually picked.
  assert.equal(zhCore.store.between(SELF, PEER).tier, 'session')

  const en = fakeCtx({ items: [titled(SELF, 'This one'), titled(PEER, 'Peer')], agentIds: [SELF, PEER], grant: 0 })
  const enCore = new PeerCore(en, undefined, translator('en'))
  await enCore.deliver({
    selfAgent: en.agents.get(SELF),
    selfLabel: 'This conversation',
    peerEntry: { sessionId: PEER, label: 'Peer', running: true, projections: {} },
    payload: { kind: 'notice', summary: 'hi' },
  })
  assert.equal(en.asked[0].questions[0].header, 'Peer session channel')
  assert.equal(enCore.store.between(SELF, PEER).tier, 'once')
})

test('progress copy follows the translator', () => {
  const entry = {
    sessionId: PEER,
    label: '对端',
    running: true,
    updatedAt: 1_700_000_000_000,
    projections: { todos: [{ content: '写路由', status: 'in_progress' }] },
  }
  const ctx = fakeCtx({ items: [] })
  const zhText = new PeerCore(ctx, undefined, translator('zh')).progress(entry).join('\n')
  assert.match(zhText, /会话：\s+「对端」/)
  assert.match(zhText, /状态：\s+运行中/)
  assert.match(zhText, /待办：1 项中完成 0 项 · 进行中：写路由/)
  const enText = new PeerCore(ctx, undefined, translator('en')).progress(entry).join('\n')
  assert.match(enText, /conversation: "对端"/)
  assert.match(enText, /state:\s+running/)
  assert.match(enText, /todos: 0 of 1 complete · now: 写路由/)
})

// ------------------------------------------------- registration smoke checks

test('every tool definition is accepted by a registry-shaped sink', () => {
  const ctx = fakeCtx({ items: [] })
  const registered = []
  ctx.tools = {
    register(definition) {
      // Mirror the checks ToolRuntime.register performs.
      assert.equal(typeof definition.name, 'string')
      assert.equal(typeof definition.description, 'string')
      assert.equal(typeof definition.output, 'object')
      assert.equal(typeof definition.output.render, 'function')
      assert.notEqual(definition.name, 'run_code')
      registered.push(definition.name)
      return () => {}
    },
  }
  const core = new PeerCore(ctx)
  assert.doesNotThrow(() => registerTools(ctx, core))
  assert.deepEqual(registered.sort(), ['peer_inbox', 'peer_list', 'peer_progress', 'peer_send'])
})

// `peer_inbox`'s id is the first OPTIONAL parameter this plugin adds, and
// `defineTool` compiles every parameter spec through the host's own JSON Schema
// compiler at definition time. Registering therefore already proves the spec
// compiles; what is asserted here is the fact that matters — no `required`
// entry, so calling `peer_inbox()` with no arguments stays legal.
test('the tool-definition compiler accepts an omitted optional parameter', () => {
  const ctx = fakeCtx({ items: [] })
  const registered = []
  ctx.tools = { register: (definition) => (registered.push(definition), () => {}) }
  assert.doesNotThrow(() => registerTools(ctx, new PeerCore(ctx)))

  const inbox = registered.find((definition) => definition.name === 'peer_inbox')
  assert.equal(inbox.parameters.type, 'object')
  assert.equal(inbox.parameters.properties.id.type, 'string')
  assert.equal(inbox.parameters.required, undefined, 'the id must be optional')
})

test('every command definition registers with a name and a handler', () => {
  const ctx = fakeCtx({ items: [] })
  const core = new PeerCore(ctx)
  const names = []
  registerCommands(
    {
      register(definition) {
        assert.equal(typeof definition.name, 'string')
        assert.equal(typeof definition.description, 'string')
        assert.equal(typeof definition.handler, 'function')
        names.push(definition.name)
        return () => {}
      },
    },
    core,
  )
  assert.deepEqual(names, ['peers', 'peer'])
})

// ------------------------------------------------- loop protection (delivery)

test('a delivery carries a hop, and the chain is refused past the limit', async () => {
  const ctx = fakeCtx({ items: [summary(SELF), summary(PEER)], agentIds: [SELF, PEER], grant: 1 })
  const core = new PeerCore(ctx)
  const entry = (id, label) => ({ sessionId: id, label, running: true, projections: {} })

  // Turn by turn: A opens, B answers, A answers back, B answers again. The
  // fourth transmission is hop 4, one past the cap, and must be refused — so
  // the test expects that call to throw instead of growing the list.
  const order = [[SELF, PEER], [PEER, SELF], [SELF, PEER], [PEER, SELF]]
  const hops = []
  for (let i = 0; i < order.length; i += 1) {
    const [from, to] = order[i]
    const payload = i === 0 ? { kind: 'request', summary: 'hop 1', requestId: 'req-chain' } : { kind: 'reply', summary: `hop ${i + 1}`, replyTo: 'req-chain' }
    const send = () =>
      core.deliver({
        selfAgent: ctx.agents.get(from),
        selfLabel: from,
        peerEntry: entry(to, to),
        payload,
      })
    if (i < HOP_LIMIT) {
      const result = await send()
      hops.push(result.hop)
    } else {
      await assert.rejects(
        send,
        // Locale-agnostic: the copy follows the client language, so match either.
        (error) => error instanceof PeerRefusal && /hop|跳/.test(error.message),
        'a chain beyond the cap is refused rather than delivered',
      )
    }
  }
  assert.deepEqual(hops, [1, 2, 3], 'each answer deepens the chain by one')
})

test('the delivery rate limit refuses without spending the budget', async () => {
  // `session` tier on purpose: the rate window lives on the CHANNEL, and a
  // `once` grant that runs out is revoked and reopened, which would hand every
  // delivery a brand-new window and make the limit unreachable. That is what an
  // earlier draft of this test actually measured.
  const ctx = fakeCtx({ items: [summary(SELF), summary(PEER)], agentIds: [SELF, PEER], grant: 1 })
  const core = new PeerCore(ctx)
  const peerEntry = { sessionId: PEER, label: 'Peer', running: true, projections: {} }
  const selfAgent = ctx.agents.get(SELF)
  const send = () => core.deliver({ selfAgent, selfLabel: 'Me', peerEntry, payload: { kind: 'notice', summary: 'x' } })

  const channel = (await send()).channel
  const before = channel.remaining
  assert.equal(channel.rateCount, 1, 'the opener counts once')

  for (let i = channel.rateCount; i < RATE_LIMIT; i += 1) await send()
  const atLimit = channel.rateCount
  assert.equal(atLimit, RATE_LIMIT, 'the window is full')

  await assert.rejects(
    send,
    // Locale-agnostic, same reason as the hop guard above.
    (error) => error instanceof PeerRefusal && /rate|速率/.test(error.message),
  )
  // The refused attempt still counts inside the window. That is deliberate: if
  // it did not, a caller that retried past the limit would eventually be let
  // through without the window having elapsed.
  assert.equal(channel.rateCount, atLimit + 1, 'the refused attempt counts inside the window')
  // `before` was read after the opener, so only the top-ups may have spent.
  assert.equal(channel.remaining, before - (RATE_LIMIT - 1), 'but it must not consume quota')
})

test('a request is remembered as pending, and an answer retires it', async () => {
  // The copy follows the client language, and the default is Simplified Chinese;
  // this has to name a locale or it asserts English against Chinese output.
  const ctx = fakeCtx({ items: [summary(SELF), summary(PEER)], agentIds: [SELF, PEER], grant: 1, locale: { preference: 'en' } })
  const core = new PeerCore(ctx)
  const entry = (id, label) => ({ sessionId: id, label, running: true, projections: {} })

  await core.deliver({
    selfAgent: ctx.agents.get(SELF),
    selfLabel: 'Me',
    peerEntry: entry(PEER, 'Peer'),
    payload: { kind: 'request', summary: 'answer me', requestId: 'req-1', replyWithin: '5ms' },
  })

  // Now it is really overdue: a real clock, a real deadline. `pendingReports`
  // is read-only, so nothing else in the suite is disturbed by this.
  await new Promise((resolve) => setTimeout(resolve, 12))
  const text = core.pendingReports(SELF).join('\n')
  // Locale-agnostic: the copy follows the client language, and this core was
  // built without a locale, so it speaks the default. What matters is that the
  // one overdue request is named, once.
  assert.match(text, /req-1/)
  assert.match(text, /1/)
  assert.doesNotMatch(text, /\{count\}/, 'the count must be interpolated, not left as a placeholder')
  assert.deepEqual(core.pendingReports(SELF), [], 'announced once, never repeated')

  const answered = await core.deliver({
    selfAgent: ctx.agents.get(PEER),
    selfLabel: 'Peer',
    peerEntry: entry(SELF, 'Me'),
    payload: { kind: 'reply', summary: 'here', replyTo: 'req-1' },
  })
  assert.equal(core.noteReply(PEER, 'req-1', answered.channel), true)
  assert.deepEqual(core.store.pendingFor(SELF), [], 'an answer retires the deadline')
})

// -------------------------------------------------------------- plugin entry

/**
 * Wire the real tools into a fake host and hand them back, so a test drives
 * exactly what the model calls — the same code path the live harness takes, not
 * a re-implementation of it.
 *
 * The store is fresh per call unless `sharedStore: true` is asked for, because
 * the plugin's store is module-scoped and would otherwise leak channels between
 * tests. `sharedStore` exists only for the re-apply test, which is about that
 * very module-scoped lifetime; with `apply: true` the whole entry runs instead
 * of just the tool half, so the shared store is the one the entry uses.
 *
 * All other options are forwarded to {@link fakeCtx}.
 * @returns the context, the tools, a `call`, and the self agent.
 */
function wirePlugin(options = {}) {
  const { sharedStore = false, apply = false, ...ctxOptions } = options
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER)],
    agentIds: [SELF, PEER],
    revive: true,
    ...ctxOptions,
  })
  const registered = []
  ctx.tools = { register: (definition) => (registered.push(definition), () => {}) }
  const store = sharedStore ? undefined : new PeerStore()
  if (apply) {
    ctx.inject = (_deps, callback) => callback({ commands: { register: () => () => {} } })
    pluginEntry.apply(ctx)
  } else {
    registerTools(ctx, new PeerCore(ctx, store, translator(DEFAULT_LOCALE)))
  }
  const tools = new Map(registered.map((definition) => [definition.name, definition]))
  const call = (name, args = {}) =>
    tools.get(name).execute(args, {
      agent: ctx.agents.get(SELF),
      signal: new AbortController().signal,
      deferContext() {},
    })
  // `store` is exposed so a test can assert the state a path leaves BEHIND, not
  // just what it returned — the difference that matters for read and reply
  // markers.
  return { ctx, call, tools, store, selfAgent: ctx.agents.get(SELF) }
}

test('the plugin entry declares its services and wires both halves in apply()', async () => {
  const plugin = (await import('../lib/index.js')).default
  assert.equal(typeof plugin.apply, 'function')
  for (const service of ['agents', 'sessionController', 'workspaceRegistry', 'userQuestions', 'tools']) {
    assert.ok(plugin.inject.includes(service), `expected ${service} to be injected`)
  }

  const ctx = fakeCtx({ items: [] })
  const registered = []
  ctx.tools = { register: (definition) => (registered.push(definition.name), () => {}) }
  const injectedDeps = []
  ctx.inject = (deps, callback) => {
    injectedDeps.push(...deps)
    callback({ commands: { register: (definition) => (registered.push(`/${definition.name}`), () => {}) } })
  }

  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.deepEqual(injectedDeps, ['commands'])
  assert.deepEqual(registered.sort(), ['/peer', '/peers', 'peer_inbox', 'peer_list', 'peer_progress', 'peer_send'])
})

// The loader re-applies a plugin on file change WITHOUT re-evaluating the
// module, so `apply()` runs again against the same module instance. A store
// built inside apply() would be discarded there, silently dropping every open
// channel. Observed live, so it is pinned here.
test('open channels survive the plugin being re-applied', async () => {
  // Both applies go through the real entry and therefore the module-scoped
  // store — that lifetime is the subject of this test, so it must not be faked.
  const first = wirePlugin({ apply: true, grant: 1 })
  await first.call('peer_send', { peer: 'Peer', kind: 'notice', summary: 'channel opener' })
  assert.equal(first.ctx.received.length, 1)

  // A fresh apply(): same process, same module instance, brand-new apply call.
  const second = wirePlugin({ apply: true, grant: 1 })
  const listing = await second.call('peer_list', {})
  assert.match(listing, /Peer channels \(1\)/, 'the channel must outlive a re-apply')

  // The re-apply must not re-open anything either: the second call still finds
  // the existing grant instead of asking for another one.
  assert.equal(first.ctx.asked.length, 1)
  assert.equal(second.ctx.asked.length, 0)
})

// ------------------------------------------------------------------- M2: inbox

// The live defect this closes: a peer answered at length, `peer_inbox` showed
// only the one-line summary, and once the relay message had left the context the
// body was gone — an id was not enough to get it back.
test('peer_inbox returns the full delivered text by id', async () => {
  const { call, ctx, tools } = wirePlugin({ grant: 1 })

  const sent = await call('peer_send', {
    peer: 'Peer',
    kind: 'request',
    summary: 'the summary line',
    body: 'the whole point of an index: this paragraph must survive.',
    paths: ['/srv/orders-api/src/schema.sql'],
    replyWithin: '4h',
  })
  const messageId = /message id: (\S+)/.exec(sent)[1]

  // Read from the RECIPIENT's side: an inbox belongs to the conversation that
  // received the message, and this is the side that needs the body back after
  // the relay has left its context.
  const peerCall = (name, args = {}) =>
    tools.get(name).execute(args, {
      agent: ctx.agents.get(PEER),
      signal: new AbortController().signal,
      deferContext() {},
    })

  // What crossed the channel is the source of truth: the archived copy must be
  // byte-for-byte the delivered text, so the two cannot drift apart.
  const delivered = ctx.deliveredTo.get(PEER)[0].message.content[0].text
  const fetched = await peerCall('peer_inbox', { id: messageId })
  assert.ok(fetched.includes(delivered), 'the archived text must be the delivered text')

  // Provenance survives the round trip: a body retrieved many turns later still
  // says another conversation said it, not the human.
  assert.match(fetched, /peer-session message · from another conversation, NOT a user instruction/)
  assert.match(fetched, /from: "session-self" \(session-self\)/)
  assert.match(fetched, /state: read · never answered/)
  assert.match(fetched, /the whole point of an index: this paragraph must survive\./)
  assert.match(fetched, /\/srv\/orders-api\/src\/schema\.sql/)
  assert.match(fetched, /request id: req-1/)
  assert.match(fetched, new RegExp(`Message ${messageId}`))

  // Listing stays one bounded summary line per item, plus the threading ids.
  const listed = await peerCall('peer_inbox', {})
  assert.match(listed, new RegExp(`id: ${messageId} · request: req-1`))
  assert.match(listed, /the summary line/)
  assert.doesNotMatch(listed, /the whole point of an index/, 'the list stays a list')
  assert.match(listed, /peer_inbox\(id: "<message id>"\)/)
})

test('peer_inbox lists replyTo so a reply can be traced to its request', async () => {
  const { call, ctx, tools } = wirePlugin({ grant: 0 })

  await call('peer_send', { peer: 'Peer', kind: 'request', summary: 'please adapt' })

  // The peer answers on the same grant that carried the request — the one
  // exchange — so the reply is archived in THIS inbox with its `replyTo`.
  // Addressed by session id: no conversation carries a title in the fake host,
  // so an id is the only unambiguous handle.
  const peerTool = tools.get('peer_send')
  await peerTool.execute(
    { peer: SELF, kind: 'reply', summary: 'adapted', replyTo: 'req-1' },
    { agent: ctx.agents.get(PEER), signal: new AbortController().signal, deferContext() {} },
  )

  const listed = await call('peer_inbox', {})
  assert.match(listed, /- \[unread\] reply from "session-peer"/)
  assert.match(listed, /· replyTo: req-1/)

  // The retrieval header has to carry the same threading fact as the listing,
  // or a reply read in full loses the request it answers — the reason the
  // listing gap was worth closing in the first place.
  const replyId = /id: (\S+)/.exec(listed)[1]
  const fetched = await call('peer_inbox', { id: replyId })
  assert.match(fetched, /in reply to: req-1/)
  assert.match(fetched, /state: read/)
  assert.match(fetched, /kind: reply/)
})

// The user's chosen semantics: fetching the BODY is reading it; listing a
// summary is not. So the marker survives any number of listings and disappears
// only once the text has actually been retrieved.
test('only fetching the body marks an item read, not listing it', async () => {
  const { call, ctx, tools } = wirePlugin({ grant: 0 })

  await call('peer_send', { peer: 'Peer', kind: 'request', summary: 'please adapt', body: 'the body' })
  await tools.get('peer_send').execute(
    { peer: SELF, kind: 'reply', summary: 'adapted', replyTo: 'req-1' },
    { agent: ctx.agents.get(PEER), signal: new AbortController().signal, deferContext() {} },
  )

  const listed = await call('peer_inbox', {})
  assert.match(listed, /- \[unread\] reply from "session-peer"/)
  assert.match(await call('peer_inbox', {}), /- \[unread\] reply from "session-peer"/)

  const replyId = /id: (\S+)/.exec(listed)[1]
  await call('peer_inbox', { id: replyId })

  const after = await call('peer_inbox', {})
  assert.doesNotMatch(after, /\[unread\]/, 'the fetched item is no longer unread')
  assert.doesNotMatch(after, /\[read\]/, 'a settled item carries no marker at all')
  assert.match(after, /- reply from "session-peer"/)
})

// Read and awaiting-reply are orthogonal facts sharing one field. Marking a
// request read must not erase the fact that nobody answered it — that marker
// is the one thing the inbox exists to show.
test('reading an unanswered request keeps it marked as unanswered', async () => {
  const { call, ctx, tools, store } = wirePlugin({ grant: 0 })

  await tools.get('peer_send').execute(
    { peer: SELF, kind: 'request', summary: 'please adapt', replyWithin: '4h' },
    { agent: ctx.agents.get(PEER), signal: new AbortController().signal, deferContext() {} },
  )

  const before = await call('peer_inbox', {})
  assert.match(before, /- \[unread\] request from "session-peer"/)
  const requestId = /id: (\S+)/.exec(before)[1]
  // The real minted id, not a hand-written one: this test drives the genuine
  // tool path, so `replyTo` has to name the request that path actually issued.
  const realRequestId = /· request: (\S+)/.exec(before)[1]

  const fetched = await call('peer_inbox', { id: requestId })
  assert.match(fetched, /state: read · never answered/)

  const after = await call('peer_inbox', {})
  assert.match(after, /- \[read · never answered\] request from "session-peer"/)
  assert.doesNotMatch(after, /\[unread\]/)
  // Kept so the marker can be asserted by id after the reply goes out.
  const requestMessageId = requestId

  // And it is still answerable, on the same grant: `markReplied` accepting a
  // read-but-unanswered request is what keeps "read" from breaking the one
  // exchange.
  const answered = await tools.get('peer_send').execute(
    { peer: SELF, kind: 'reply', summary: 'adapted', replyTo: realRequestId },
    { agent: ctx.agents.get(PEER), signal: new AbortController().signal, deferContext() {} },
  )
  assert.match(answered, /Delivered a reply/)
  const settled = await call('peer_inbox', {})
  assert.doesNotMatch(settled, /never answered/, 'the request is answered now')
  // Assert the STATE the tool path left behind, not a word that happens to be in
  // the reply's own summary: the earlier version matched the summary text and so
  // passed whether or not the marker was ever written.
  const answeredRequest = store.findInboxItem(SELF, requestMessageId)
  assert.equal(
    answeredRequest.status,
    'replied',
    'answering a request marks the request it answers, not merely the reply it sent',
  )
})

// The live harness found this one: `peer_inbox` returned "Peer inbox is empty."
// for an empty inbox BEFORE it ever asked about overdue requests — and asking is
// what marks them reported, so the single announcement B5 promises was consumed
// by a branch that dropped it. An empty inbox is exactly when a waiting user
// wonders, so the two must not be mutually exclusive.
test('an overdue request is announced even when the inbox is empty', async () => {
  const { call, tools, ctx } = wirePlugin({ grant: 1 })

  await tools.get('peer_send').execute(
    { peer: PEER, kind: 'request', summary: 'answer me', replyWithin: '1ms' },
    { agent: ctx.agents.get(SELF), signal: new AbortController().signal, deferContext() {} },
  )
  // `peer_send` announced nothing: the deadline had not passed yet.
  await new Promise((resolve) => setTimeout(resolve, 12))

  const empty = await call('peer_inbox', {})
  assert.match(empty, /Peer inbox is empty/)
  assert.match(empty, /req-1/, 'the overdue request is named by the same call')
  assert.doesNotMatch(empty, /\{count\}|\{requestId\}/, 'placeholders must be interpolated')

  // Announced once: the announcement was consumed by THAT call.
  const again = await call('peer_inbox', {})
  assert.match(again, /Peer inbox is empty/)
  assert.doesNotMatch(again, /req-1/, 'not repeated on the next call')
})

test('an unknown inbox id says so, and names the ids that exist', async () => {
  const { call, ctx, tools } = wirePlugin({ grant: 0 })
  const empty = await call('peer_inbox', { id: 'pm-nope' })
  assert.match(empty, /No inbox message with id "pm-nope"/)
  assert.match(empty, /inbox is empty/)

  // One message has to actually arrive here before the refusal can name an id.
  // It is addressed to THIS conversation, which is why this test cannot reuse an
  // outbound `peer_send`: that one lands in the peer's inbox.
  await tools.get('peer_send').execute(
    { peer: SELF, kind: 'notice', summary: 'hello' },
    { agent: ctx.agents.get(PEER), signal: new AbortController().signal, deferContext() {} },
  )

  const missing = await call('peer_inbox', { id: 'pm-nope' })
  assert.match(missing, /Known ids, newest first: pm-/)
  assert.doesNotMatch(missing, /inbox is empty/)
})
