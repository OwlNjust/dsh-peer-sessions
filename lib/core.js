/**
 * Channel orchestration shared by the commands and the tools.
 *
 * Every delivery re-reads the addressable set (invariant H1.2) and re-checks
 * BOTH ends of the channel (H1.1), so archiving either conversation revokes the
 * channel immediately without any listener or cache to invalidate.
 *
 * @module dsh-peer-sessions/core
 */

import { listAddressable, listWithHidden, resolveTarget, formatCandidate } from './addressable.js'
import { askGrant, askWake } from './consent.js'
import { buildPeerMessage, buildDeliveryNotice } from './messages.js'
import { PeerStore } from './store.js'

/** A refusal the user should read as an explanation, not a crash. */
export class PeerRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'PeerRefusal'
  }
}

export class PeerCore {
  /**
   * @param ctx - the plugin's host context.
   */
  constructor(ctx) {
    this.ctx = ctx
    this.store = new PeerStore()
  }

  /** The addressable set, right now. */
  addressable(signal) {
    return listAddressable(this.ctx, signal)
  }

  /**
   * Resolve one peer reference, or explain why it could not be resolved.
   * @param query - the title, label, or session id.
   * @param selfId - the asking session id.
   * @param signal - cancellation.
   * @returns the resolved entry.
   * @throws {PeerRefusal} with candidates when the reference is absent or ambiguous.
   */
  async resolveOrRefuse(query, selfId, signal) {
    const entries = await this.addressable(signal)
    const found = resolveTarget(entries, query, selfId)
    if (found.kind === 'one') return found.entry
    if (found.kind === 'many') {
      const lines = found.candidates.map((entry, index) => formatCandidate(entry, index))
      throw new PeerRefusal(
        `"${query}" matches ${found.candidates.length} conversations. Name one exactly:\n${lines.join('\n')}`,
      )
    }
    const hint =
      found.candidates.length === 0
        ? 'There is no other visible conversation to address.'
        : `Visible conversations:\n${found.candidates.map((entry, index) => formatCandidate(entry, index)).join('\n')}`
    throw new PeerRefusal(`No conversation matches "${query}". ${hint}`)
  }

  /**
   * Confirm both ends are still in the addressable set.
   * @param selfId - the sending session id.
   * @param peerId - the receiving session id.
   * @param signal - cancellation.
   * @returns the addressable entry for the peer.
   * @throws {PeerRefusal} naming the side that fell out of view.
   */
  async assertBothVisible(selfId, peerId, signal) {
    const { entries } = await listWithHidden(this.ctx, signal)
    const self = entries.find((entry) => entry.sessionId === selfId)
    if (self === undefined) {
      throw new PeerRefusal(
        'This conversation is not visible in the sidebar (archived, blank, or a subagent), so it may not address anyone.',
      )
    }
    const peer = entries.find((entry) => entry.sessionId === peerId)
    if (peer === undefined) {
      throw new PeerRefusal(
        'That conversation is no longer visible in the sidebar — it may have just been archived. Nothing was sent.',
      )
    }
    return { self, peer }
  }

  /**
   * Deliver one payload to a peer, obtaining a grant if there is none.
   *
   * @param args - sender identity, the peer entry, the payload, and options.
   * @returns a result describing what happened.
   * @throws {PeerRefusal} when the hard rule forbids the delivery.
   */
  async deliver({ selfAgent, selfLabel, peerEntry, payload, silent = false, signal }) {
    const selfId = selfAgent.id
    const peerId = peerEntry.sessionId
    const { peer } = await this.assertBothVisible(selfId, peerId, signal)

    let channel = this.store.between(selfId, peerId)
    if (channel !== undefined && channel.remaining !== null && channel.remaining <= 0) {
      // An exhausted `once` channel is a spent grant, not an open one.
      this.store.revoke(channel)
      channel = undefined
    }

    if (channel === undefined) {
      const tier = await askGrant(this.ctx, { agent: selfAgent, peerLabel: peer.label, selfLabel, signal })
      if (tier === null) return { outcome: 'declined' }
      channel = this.store.open({ a: selfId, b: peerId, tier, by: selfId })
    }

    // Resolve the target BEFORE spending budget: a wake the human declines must
    // not burn a `once` grant on a delivery that never happened.
    const target = await this.ensureLive(peer, selfAgent, signal)
    if (target === undefined) {
      return { outcome: 'target-not-running', peer }
    }

    if (!this.store.spend(channel)) {
      throw new PeerRefusal('This channel has reached its delivery budget. Revoke it and open a new one to continue.')
    }

    const message = buildPeerMessage({
      senderId: selfId,
      senderLabel: selfLabel,
      tier: channel.tier,
      channelId: channel.id,
      ...payload,
    })

    // `followup` queues a distinct turn and wakes the driver; a peer that is
    // mid-turn therefore receives this when it finishes, never in the middle of
    // a step. `steer` is deliberately never used — it would interrupt.
    if (silent) target.inject(message)
    else target.followup(message)

    const item = this.store.record({
      id: `pm-${this.store.seq}-${Date.now().toString(36)}`,
      channelId: channel.id,
      from: selfId,
      fromLabel: selfLabel,
      to: peerId,
      kind: payload.kind,
      summary: payload.summary,
      requestId: payload.requestId,
      replyTo: payload.replyTo,
      replyWithin: payload.replyWithin,
      deliveredAt: Date.now(),
      status: payload.kind === 'request' ? 'awaiting-reply' : 'unread',
    })

    return { outcome: 'delivered', peer, channel, item, silent }
  }

  /**
   * Record that an inbound request was answered.
   * @param sessionId - the answering session.
   * @param requestId - the request being answered.
   * @returns whether a matching open request was found.
   */
  noteReply(sessionId, requestId) {
    if (requestId === undefined) return false
    return this.store.markReplied(sessionId, requestId)
  }

  /**
   * Resolve the peer to a live agent, waking it only with explicit consent.
   * @returns the live agent, or undefined when it is cold and the human declined.
   */
  async ensureLive(peerEntry, selfAgent, signal) {
    const live = this.ctx.agents.get(peerEntry.sessionId)
    if (live !== undefined) return live
    const approved = await askWake(this.ctx, { agent: selfAgent, peerLabel: peerEntry.label, signal })
    if (!approved) return undefined
    const resolved = await this.ctx.sessionController.resolveAgent(peerEntry.sessionId)
    if (resolved.error !== undefined) return undefined
    return resolved.agent
  }

  /**
   * Build the progress view for one peer: projection and summary only.
   *
   * Never the transcript, never tool arguments, never attachment or file
   * contents. Unknown projections contribute their key name but not their value,
   * so a future projection cannot leak through this view by surprise.
   *
   * @param peerEntry - the addressable peer entry.
   * @returns a list of readable lines.
   */
  progress(peerEntry) {
    const lines = [
      `conversation: "${peerEntry.label}"`,
      `session id:   ${peerEntry.sessionId}`,
      `state:        ${peerEntry.running ? 'running' : 'not running'}`,
    ]
    if (peerEntry.cwd !== undefined) lines.push(`workspace:    ${peerEntry.cwd}`)
    lines.push(`last active:  ${new Date(peerEntry.updatedAt).toISOString()}`)

    const values = peerEntry.projections ?? {}
    const keys = Object.keys(values)
    if (keys.length > 0) {
      lines.push('', 'projected state (summaries only — no transcript, no file contents):')
      const goal = values.goal
      if (goal !== undefined && typeof goal.objective === 'string') {
        const phase = typeof goal.phase === 'string' ? ` [${goal.phase}]` : ''
        lines.push(`  goal: ${goal.objective}${phase}`)
      }
      const todo = values.todo
      if (todo !== undefined && Array.isArray(todo.items)) {
        const done = todo.items.filter((item) => item?.status === 'completed').length
        lines.push(`  todos: ${done} of ${todo.items.length} complete`)
      }
      const permissions = values.permissions
      if (permissions !== undefined && typeof permissions.currentValue === 'string') {
        lines.push(`  permissions: ${permissions.currentValue}`)
      }
      const inbox = values.inbox
      if (inbox !== undefined && typeof inbox === 'object' && inbox !== null) {
        const nextTurn = Array.isArray(inbox['next-turn']) ? inbox['next-turn'].length : 0
        const nextStep = Array.isArray(inbox['next-step']) ? inbox['next-step'].length : 0
        lines.push(`  queued input: ${nextTurn} for the next turn, ${nextStep} for the next step`)
      }
      const recognised = new Set(['goal', 'todo', 'permissions', 'inbox', 'title'])
      const others = keys.filter((key) => !recognised.has(key))
      if (others.length > 0) lines.push(`  other projections present: ${others.join(', ')}`)
    }
    return lines
  }

  /** Sender-side audit line for one delivery. */
  deliveryNotice(result) {
    const { peer, item, silent } = result
    const summary = `Delivered a ${item.kind} to "${peer.label}"${silent ? ' as silent context' : ''}.`
    const detail = [
      `  peer:       ${peer.label} (${peer.sessionId})`,
      `  channel:    ${item.channelId}`,
      `  message id: ${item.id}`,
      item.requestId === undefined ? undefined : `  request id: ${item.requestId}`,
      '  The receiving conversation sees this as another agent speaking, not as a user instruction.',
    ]
      .filter((line) => line !== undefined)
      .join('\n')
    return buildDeliveryNotice(summary, detail)
  }

  /** Which side of a channel is the peer, for display. */
  peerIdOf(channel, selfId) {
    return this.store.other(channel, selfId)
  }

  /** The label a human would recognise for one session, live or cold. */
  async labelOf(sessionId, signal) {
    const entries = await this.addressable(signal)
    return entries.find((entry) => entry.sessionId === sessionId)?.label ?? sessionId
  }

  /** Mint a request identity for a `request`-kind message. */
  nextRequestId() {
    this.requestSeq = (this.requestSeq ?? 0) + 1
    return `req-${this.requestSeq}-${Date.now().toString(36)}`
  }
}
