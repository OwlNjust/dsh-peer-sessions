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
 * `consent` answers the grant question; `wake` answers the cold-peer wake
 * question. They are separate because a cold peer with no channel raises BOTH
 * (may we talk at all, then may we spend tokens resuming it), and a fake that
 * conflated them would hide that ordering.
 */
function fakeCtx({ items, archived = [], agentIds = [], consent = null, wake = null, resolved = undefined }) {
  const received = []
  const agents = new Map(agentIds.map((id) => [id, fakeAgent(id, received)]))
  const asked = []
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
        const id = request.questions[0].id
        const answer = id === 'wake' ? wake : consent
        if (answer === null) throw new Error('no answerer')
        return { answers: [{ id, selected: [answer] }] }
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
    consent: 'Decline',
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
    consent: 'Allow for this conversation',
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
    consent: 'Allow once',
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
    consent: 'Allow for this conversation',
  })
  const core = new PeerCore(ctx)
  const peerEntry = { sessionId: PEER, label: 'Peer', running: true, projections: {} }
  const selfAgent = ctx.agents.get(SELF)
  await core.deliver({ selfAgent, selfLabel: 'Me', peerEntry, payload: { kind: 'notice', summary: 'one' } })
  await core.deliver({ selfAgent, selfLabel: 'Me', peerEntry, payload: { kind: 'notice', summary: 'two' } })
  assert.equal(ctx.asked.length, 1, 'the human is asked once per channel, not once per message')
  assert.equal(ctx.received.length, 2)
})

test('a cold peer is not woken when the human declines the wake prompt', async () => {
  const ctx = fakeCtx({
    items: [summary(SELF), summary(PEER, { running: false })],
    agentIds: [SELF], // the peer exists in the sidebar but has no live agent
    consent: 'Allow once',
    wake: 'Cancel',
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
    consent: 'Allow for this conversation',
    wake: 'Wake it and deliver',
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

test('progress reports projections but never transcript content', async () => {
  const ctx = fakeCtx({ items: [] })
  const core = new PeerCore(ctx)
  const lines = core.progress({
    sessionId: PEER,
    label: 'Peer',
    running: true,
    cwd: '/work/peer',
    updatedAt: 1_700_000_000_000,
    projections: {
      goal: { objective: 'ship the API', phase: 'active' },
      todo: { items: [{ status: 'completed' }, { status: 'pending' }] },
      mystery: { secretTranscript: 'should not be printed' },
    },
  })
  const text = lines.join('\n')
  assert.match(text, /ship the API/)
  assert.match(text, /1 of 2 complete/)
  assert.match(text, /other projections present: mystery/)
  assert.doesNotMatch(text, /should not be printed/)
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
