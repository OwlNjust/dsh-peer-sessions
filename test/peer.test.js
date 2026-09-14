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

import { classify, listAddressable, resolveTarget, labelOf } from '../lib/addressable.js'
import { PeerStore, pairKey, CHANNEL_BUDGET } from '../lib/store.js'
import { buildPeerMessage, buildDeliveryNotice, PEER_KIND } from '../lib/messages.js'
import { translator, resolveLocale, normalizeLocale, DEFAULT_LOCALE } from '../lib/i18n.js'
import { isRuntimeRoot } from '../lib/consent.js'
import { PeerCore, PeerRefusal } from '../lib/core.js'
import { registerTools } from '../lib/tools.js'
import { registerCommands } from '../lib/commands.js'

// ---------------------------------------------------------------- test doubles

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

/** A fake agent that records what was delivered to it. */
function fakeAgent(id, received) {
  return {
    id,
    status: 'idle',
    followup(message) {
      received.push({ via: 'followup', message })
    },
    steer() {
      throw new Error('steer() must never be used: it would interrupt the peer')
    },
    inject(message) {
      received.push({ via: 'inject', message })
    },
  }
}

/**
 * A minimal host context: exactly the surface the plugin touches.
 *
 * `grant` and `wake` are OPTION INDICES the fake human picks (or null for "no
 * answerer"). They are indices rather than labels because a real UI echoes back
 * the label it was shown, whatever language that was — a fake that returned a
 * hard-coded English string would silently stop matching once the plugin asks
 * in another language, which is precisely how this was found.
 *
 * `locale` seeds the Host settings document the plugin reads its language from.
 */
function fakeCtx({
  items,
  archived = [],
  agentIds = [],
  grant = null,
  wake = null,
  locale,
  resolved = undefined,
}) {
  const received = []
  const agents = new Map(agentIds.map((id) => [id, fakeAgent(id, received)]))
  const asked = []
  const listeners = new Map()
  return {
    received,
    asked,
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
        const agent = agents.get(id)
        return agent === undefined ? { error: { code: 'session/not-found' } } : { agent }
      },
    },
    userQuestions: {
      ask: async (request) => {
        asked.push(request)
        const question = request.questions[0]
        const index = question.id === 'wake' ? wake : grant
        if (index === null) throw new Error('no answerer')
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

test('revoke removes the channel and replies mark an inbound request answered', () => {
  const store = new PeerStore()
  const channel = store.open({ a: 'a', b: 'b', tier: 'session', by: 'a' })
  store.record({ id: 'm1', to: 'b', requestId: 'req-1', status: 'awaiting-reply', kind: 'request' })
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

test('a cold peer is not woken when the human declines the wake prompt', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER, { running: false })],
    agentIds: [SELF], // the peer exists in the sidebar but has no live agent
    grant: 0,
    wake: 1,
  })
  const core = new PeerCore(ctx)
  const result = await core.deliver({
    selfAgent: ctx.agents.get(SELF),
    selfLabel: 'Me',
    peerEntry: { sessionId: PEER, label: 'Peer', running: false, projections: {} },
    payload: { kind: 'notice', summary: 'hi' },
  })
  assert.equal(result.outcome, 'target-not-running')
  assert.equal(ctx.received.length, 0)
  // A declined wake must NOT burn the grant: the channel survives for the next
  // attempt instead of a `once` grant being spent on nothing.
  assert.equal(core.store.between(SELF, PEER).remaining, 1)
  assert.equal(ctx.asked.length, 2, 'a cold peer with no channel raises the grant, then the wake question')
  assert.equal(ctx.asked[1].questions[0].id, 'wake')
})

test('a cold peer is woken and delivered to once both prompts are approved', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER, { running: false })],
    agentIds: [SELF, PEER],
    grant: 1,
    wake: 0,
  })
  const core = new PeerCore(ctx)
  const result = await core.deliver({
    selfAgent: ctx.agents.get(SELF),
    selfLabel: 'Me',
    peerEntry: { sessionId: PEER, label: 'Peer', running: false, projections: {} },
    payload: { kind: 'notice', summary: 'hi' },
  })
  assert.equal(result.outcome, 'delivered')
  assert.equal(ctx.received.length, 1)
  assert.equal(ctx.received[0].via, 'followup')
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
    'consent.wake.header',
    'consent.wake.question',
    'consent.wake.detail',
    'consent.wake.yes',
    'consent.wake.no',
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
  const titled = (id, title) => summary(id, { projections: { asOfSeq: 0, values: { title } } })

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

// -------------------------------------------------------------- plugin entry

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
  const plugin = (await import('../lib/index.js')).default

  const harness = () => {
    const ctx = fakeCtx({
      items: [summary(SELF), summary(PEER)],
      agentIds: [SELF, PEER],
      grant: 1,
    })
    const tools = new Map()
    ctx.tools = { register: (definition) => (tools.set(definition.name, definition), () => {}) }
    ctx.inject = (_deps, callback) => callback({ commands: { register: () => () => {} } })
    plugin.apply(ctx)
    const call = (name, args) =>
      tools.get(name).execute(args, {
        agent: ctx.agents.get(SELF),
        signal: new AbortController().signal,
        deferContext() {},
      })
    return { ctx, call }
  }

  const first = harness()
  await first.call('peer_send', { peer: 'Peer', kind: 'notice', summary: 'channel opener' })
  assert.equal(first.ctx.received.length, 1)

  // A fresh apply(): same process, same module instance, brand-new apply call.
  const second = harness()
  const listing = await second.call('peer_list', {})
  assert.match(listing, /Peer channels \(1\)/, 'the channel must outlive a re-apply')
})
