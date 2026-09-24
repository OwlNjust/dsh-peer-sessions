/**
 * Channel orchestration shared by the commands and the tools.
 *
 * Every delivery re-reads the addressable set (invariant H1.2) and re-checks
 * BOTH ends of the channel (H1.1), so archiving either conversation revokes the
 * channel immediately without any listener or cache to invalidate.
 *
 * @module dsh-peer-sessions/core
 */

import { listAddressable, listWithHidden, resolveTarget, stripInvisible, asRecord } from './addressable.js'
import { askGrant } from './consent.js'
import { buildPeerMessageFromText, buildDeliveryNotice, renderPeerBody } from './messages.js'
import { PeerStore, HOP_LIMIT, RATE_LIMIT, RATE_WINDOW_MS, parseDuration } from './store.js'
import { translator, DEFAULT_LOCALE } from './i18n.js'

/** A refusal the user should read as an explanation, not a crash. */
export class PeerRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'PeerRefusal'
  }
}

/**
 * How many candidate conversations a "no match" refusal lists before summarising.
 *
 * The point of listing them is discovery after a typo; a wall of sixteen lines
 * buries that, and the full set is reachable by session id anyway.
 */
const MAX_CANDIDATES = 8

/** How many trailing turns the progress view summarises. */
const RECENT_TURNS = 3

/** Bound one preview line so a widened projection cannot become a transcript. */
const PREVIEW_MAX_CHARS = 200

/**
 * Find a hidden conversation the query names, so the refusal can say WHY it is
 * unreachable instead of only that nothing matched.
 * @param hidden - sessions excluded from the addressable set, with reason codes.
 * @param query - the reference the human or model supplied.
 * @returns the matching hidden entry, or undefined.
 */
function matchHidden(hidden, query) {
  const needle = stripInvisible(query).trim().toLowerCase()
  if (needle === '') return undefined
  return hidden.find(
    (entry) =>
      entry.sessionId.toLowerCase() === needle ||
      entry.label.toLowerCase() === needle ||
      entry.label.toLowerCase().includes(needle),
  )
}

/** Clip one preview string to {@link PREVIEW_MAX_CHARS}. */
function clip(text) {
  return text.length <= PREVIEW_MAX_CHARS ? text : `${text.slice(0, PREVIEW_MAX_CHARS - 1)}…`
}

export class PeerCore {
  /**
   * @param ctx - the plugin's host context.
   * @param store - the channel store. Supplied by the caller so it can outlive
   *   one `apply()`; see the note in `index.js`.
   * @param t - the translator for human-facing copy. Callers pass a function
   *   that reads the CURRENT locale, so a language change is picked up without
   *   rebuilding anything.
   */
  constructor(ctx, store = new PeerStore(), t = translator(DEFAULT_LOCALE)) {
    this.ctx = ctx
    this.store = store
    this.t = t
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
    const { entries, hidden } = await listWithHidden(this.ctx, signal)
    const found = resolveTarget(entries, query, selfId)
    if (found.kind === 'one') return found.entry
    if (found.kind === 'many') {
      throw new PeerRefusal(
        this.t('resolve.many', {
          query,
          count: found.candidates.length,
          lines: this.candidateLines(found.candidates),
        }),
      )
    }

    // A name the human still has in mind that matches nothing VISIBLE is most
    // often one they just archived. Naming that beats making them read the whole
    // list to notice the absence — which is what the first live run of this path
    // actually produced.
    const gone = matchHidden(hidden, query)
    if (gone !== undefined) {
      throw new PeerRefusal(this.t(`resolve.hidden.${gone.code}`, { label: gone.label }))
    }

    if (found.candidates.length === 0) throw new PeerRefusal(this.t('resolve.noneAlone'))
    const shown = found.candidates.slice(0, MAX_CANDIDATES)
    const more =
      found.candidates.length > shown.length
        ? this.t('resolve.moreCandidates', { count: found.candidates.length - shown.length })
        : ''
    throw new PeerRefusal(
      this.t('resolve.noneWithCandidates', { query, lines: this.candidateLines(shown) + more }),
    )
  }

  /**
   * Render candidate conversations as an indented list.
   *
   * Lives here rather than in `addressable.js` because the running/not-running
   * marker is human-facing copy and must follow the locale.
   * @param candidates - addressable entries.
   * @returns one line per candidate.
   */
  candidateLines(candidates) {
    return candidates
      .map((entry, index) => {
        const state = this.t(entry.running ? 'state.running' : 'state.notRunning')
        const where = entry.cwd === undefined ? '' : `  ${entry.cwd}`
        // A1 asks the candidate list for recent activity too: it is how a human
        // tells two similarly named conversations apart and picks the live one.
        const seen = Number.isFinite(entry.updatedAt) ? `  ${new Date(entry.updatedAt).toISOString()}` : ''
        return `${index + 1}. ${entry.label}  [${state}]  ${entry.sessionId}${where}${seen}`
      })
      .join('\n')
  }

  /**
   * Ask the human for a grant, with the plugin's live translator.
   *
   * Wrapped here so `commands.js` never has to touch `consent.js` directly, and
   * so both the tool path and the command path ask the identical question.
   * @param agent - the asking agent.
   * @param peerLabel - the peer's display label.
   * @param selfLabel - the asking conversation's display label.
   * @param signal - cancellation.
   * @returns the tier, or null when declined.
   */
  askGrantFor(agent, peerLabel, selfLabel, signal) {
    return askGrant(this.ctx, { agent, peerLabel, selfLabel, signal, t: this.t })
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
    if (self === undefined) throw new PeerRefusal(this.t('resolve.selfNotVisible'))
    const peer = entries.find((entry) => entry.sessionId === peerId)
    if (peer === undefined) throw new PeerRefusal(this.t('resolve.peerNotVisible'))
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

    // Liveness is read FIRST, before any prompt, so the grant card can state the
    // whole cost of approving. Idle conversations are cold in this deployment,
    // so a second "wake it?" prompt after every grant was pure friction.
    const live = this.ctx.agents.get(peerId)
    const willWake = live === undefined

    let channel = this.store.between(selfId, peerId)
    let ridesExistingGrant = false
    if (channel !== undefined && channel.remaining !== null && channel.remaining <= 0) {
      const answering = payload.kind === 'reply' ? payload.replyTo : undefined
      if (this.store.isAnswerableOn(channel, answering, selfId)) {
        // A `once` grant buys ONE EXCHANGE, not one message: the answer to a
        // request that same grant carried rides along, instead of asking again
        // — which would raise the card in the peer's conversation and read as
        // "didn't I just approve this?".
        ridesExistingGrant = true
        // Consume the exchange HERE, synchronously, rather than at the end of
        // the async path. Everything below may await, and two answers to the
        // same request would otherwise both observe an unspent grant, both ride
        // it, and both deliver — one approval buying two exchanges.
        this.store.revoke(channel)
      } else {
        // An exhausted `once` channel is a spent grant, not an open one.
        this.store.revoke(channel)
        channel = undefined
      }
    }

    // A silent delivery adds context without opening a turn, so it needs a
    // RUNNING peer: waking one is the exact opposite of what was asked. Refuse
    // the contradiction instead of quietly doing it. This check used to sit
    // inside the "no channel yet" branch, so with a channel already open a
    // silent send to a cold peer woke it, delivered by `inject`, and told the
    // caller "the peer was not woken" — the opposite of the truth.
    //
    // Skipped when the delivery rides an existing `once` grant: that path shows
    // no card, so no human is being asked to approve a contradiction.
    if (silent && willWake && !ridesExistingGrant) return { outcome: 'silent-needs-running', peer }

    // The hop guard runs HERE, before the grant card and before the wake: it
    // needs nothing but `selfId`, and a refusal that arrives after the human has
    // answered a card — or after a cold peer has been woken and billed — is a
    // refusal they already paid for.
    const hop = this.store.nextHop(selfId, peerId)
    if (hop > HOP_LIMIT) {
      throw new PeerRefusal(this.t('hop.exceeded', { hop, limit: HOP_LIMIT }))
    }

    if (channel === undefined) {
      const tier = await askGrant(this.ctx, {
        agent: selfAgent,
        peerLabel: peer.label,
        selfLabel,
        signal,
        t: this.t,
        willWake,
      })
      if (tier === null) return { outcome: 'declined' }

      // THE GRANT IS THE LONG POLE. Everything read before it is a stale
      // snapshot by the time it resolves: the human can archive either end
      // while reading the card, another delivery can open the channel, and the
      // peer can go cold. Re-read it all. H1 promises a delivery never reaches
      // a conversation the human cannot see, and A5 promises revocation is
      // immediate — both are only true if this re-read happens.
      await this.assertBothVisible(selfId, peerId, signal)

      const opened = this.store.between(selfId, peerId)
      if (opened !== undefined) {
        // Someone else established the channel while the card was open. Reuse
        // theirs instead of replacing it: overwriting would discard their tier,
        // quota and openRequests, and leave the id they were told about naming
        // a channel that no longer exists.
        channel = opened
      } else {
        channel = this.store.open({ a: selfId, b: peerId, tier, by: selfId })
      }
    } else if (this.store.between(selfId, peerId) !== channel) {
      // The channel was revoked while we were deciding (or while a card was
      // open). Nothing may be delivered on a grant the human has withdrawn.
      // Checked AFTER the grant and BEFORE anything is spent — and skipped for
      // `ridesExistingGrant`, which deliberately revokes as it spends.
      if (!ridesExistingGrant) throw new PeerRefusal(this.t('channel.revoked'))
    }

    // Re-read liveness rather than trusting the pre-prompt snapshot: a peer
    // that was mid-turn when the card opened may have finished and been
    // released since (idle conversations go cold here). Handing a message to a
    // disposed loop either throws internally or queues it into a dead inbox
    // while reporting success.
    let target = this.ctx.agents.get(peerId)
    if (target === undefined) target = await this.wake(peer)
    if (target === undefined) {
      return { outcome: 'target-not-running', peer }
    }

    // Loop protection, in the order that matters: the rate limit is about this
    // pair hammering each other, the hop limit about a chain propagating across
    // conversations. Hop is checked BEFORE the wake above (see `hop`), and both
    // before the budget is spent — a refused delivery must not consume quota.
    if (!this.store.withinRate(channel)) {
      throw new PeerRefusal(this.t('rate.limited', { limit: RATE_LIMIT, seconds: RATE_WINDOW_MS / 1000 }))
    }
    if (!ridesExistingGrant && !this.store.spend(channel)) {
      throw new PeerRefusal(this.t('budget.spent'))
    }

    // Render once and use the SAME text for the delivered message and for the
    // inbox copy, so the archived body cannot drift from what was delivered.
    const body = renderPeerBody({
      senderId: selfId,
      senderLabel: selfLabel,
      tier: channel.tier,
      channelId: channel.id,
      hop,
      ...payload,
    })
    const message = buildPeerMessageFromText(body, selfId)

    // `followup` queues a distinct turn and wakes the driver; a peer that is
    // mid-turn therefore receives this when it finishes, never in the middle of
    // a step. `steer` is deliberately never used — it would interrupt.
    if (silent) target.inject(message)
    else target.followup(message)

    // The receiver now knows which hop it is answering, so a message it sends
    // back continues this chain instead of starting a fresh one.
    this.store.noteInboundHop(peerId, hop, selfId)

    const item = this.store.record({
      id: this.store.nextMessageId(),
      channelId: channel.id,
      from: selfId,
      fromLabel: selfLabel,
      to: peerId,
      kind: payload.kind,
      summary: payload.summary,
      /**
       * The complete text that crossed the channel, provenance header included.
       * Stored so `peer_inbox` can return the body long after the relay message
       * has fallen out of the recipient's context — without it, an inbox item
       * is only a notification and the summary is all that survives.
       */
      text: body,
      requestId: payload.requestId,
      replyTo: payload.replyTo,
      replyWithin: payload.replyWithin,
      hop,
      deliveredAt: Date.now(),
      status: payload.kind === 'request' ? 'unread-unanswered' : 'unread',
    })

    // Remember the request so its answer can ride this same grant, and so the
    // waiter can be told when the deadline passes (B5).
    if (payload.kind === 'request' && payload.requestId !== undefined) {
      this.store.noteRequest(channel, payload.requestId, selfId)
      this.store.noteIssuer(payload.requestId, selfId)
      const ttl = parseDuration(payload.replyWithin)
      this.store.notePending({
        requestId: payload.requestId,
        from: selfId,
        to: peerId,
        toLabel: peer.label,
        channelId: channel.id,
        summary: payload.summary,
        replyWithin: payload.replyWithin,
        // A request with no usable deadline still becomes pending: it can be
        // answered, it simply never reports itself overdue.
        dueAt: ttl === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttl,
      })
    }
    if (ridesExistingGrant) {
      // The exchange is complete: one approval bought the question and its answer.
      this.store.revoke(channel)
    }

    return { outcome: 'delivered', peer, channel, item, silent, ridesExistingGrant, hop }
  }

  /**
   * Record that an inbound request was answered.
   *
   * Which end of the channel holds the request depends on who started the
   * exchange, and both directions are legitimate — so the channel is passed
   * through rather than assuming one. See `store.markReplied`.
   *
   * @param sessionId - the answering session.
   * @param requestId - the request being answered.
   * @param channel - the channel the reply went out on.
   * @returns whether a matching open request was found.
   */
  noteReply(sessionId, requestId, channel) {
    if (requestId === undefined) return false
    // DIRECTION CHECK, and it is mandatory: only a request issued by the OTHER
    // end may be answered. Naming your own request otherwise retires your own
    // deadline — killing the B5 notice you are waiting for — and flips the
    // peer's inbox item to answered, so their listing shows a request that
    // looks settled although nobody answered it. The `once` budget already had
    // this guard; pending and the inbox did not.
    const issuedBy = this.store.issuerOf(requestId, channel)
    if (issuedBy !== undefined && issuedBy === sessionId) return false
    // An answer retires the request's deadline: the waiting is over either way.
    this.store.clearPending(requestId)
    return this.store.markReplied(sessionId, requestId, channel)
  }

  /**
   * Requests this session issued whose deadline has passed and which nobody has
   * answered, each reported once.
   *
   * This is B5's "notify the sender", and it is deliberately passive: the plugin
   * cannot open a turn in the waiting conversation by itself, so the notice rides
   * the next thing that conversation does. Announcing an overdue request does
   * NOT resend it — "no infinite retry" is the same requirement.
   *
   * @param sessionId - the session that is waiting.
   * @returns lines to append to a tool result, or [] when there is nothing.
   */
  pendingReports(sessionId) {
    const overdue = this.store.overdueRequests(sessionId)
    if (overdue.length === 0) return []
    const lines = ['', this.t('timeout.header', { count: overdue.length })]
    for (const record of overdue) {
      lines.push(
        this.t('timeout.line', {
          requestId: record.requestId,
          label: record.toLabel ?? record.to,
          promised: record.replyWithin,
        }),
      )
    }
    lines.push(this.t('timeout.note'))
    return lines
  }

  /**
   * Whether an inbound request this session holds is already past its deadline,
   * so a listing can say "timed out" rather than "waiting".
   * @param requestId - the request to check.
   * @returns whether its deadline has passed.
   */
  requestOverdue(requestId) {
    return requestId !== undefined && this.store.isOverdue(requestId)
  }

  /**
   * Resume a cold peer so a message can be delivered to it.
   *
   * Deliberately asks nothing: waking is part of what the channel's grant
   * bought, and the card that granted it said so. Re-prompting per delivery
   * would ask the same question on nearly every send, because idle
   * conversations are cold here.
   *
   * @param peerEntry - the addressable peer entry.
   * @returns the live agent, or undefined when it could not be resumed.
   */
  async wake(peerEntry) {
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
    const t = this.t
    const lines = [
      t('progress.conversation', { label: peerEntry.label }),
      t('progress.sessionId', { sessionId: peerEntry.sessionId }),
      t('progress.state', { state: t(peerEntry.running ? 'state.running' : 'state.notRunning') }),
    ]
    if (peerEntry.cwd !== undefined) lines.push(t('progress.workspace', { cwd: peerEntry.cwd }))
    // `updatedAt` is typed required-number, but a bad value must not surface as
    // the model-visible answer "Invalid time value" — that launders a contract
    // violation into something that reads like a legitimate refusal.
    const lastActive = Number.isFinite(peerEntry.updatedAt) ? new Date(peerEntry.updatedAt).toISOString() : undefined
    if (lastActive !== undefined) lines.push(t('progress.lastActive', { iso: lastActive }))

    const values = peerEntry.projections ?? {}
    const keys = Object.keys(values)
    if (keys.length > 0) {
      lines.push('', t('progress.projected'))

      // Every projection value is JsonValue, so a key being present says nothing
      // about its type: `todos` is an array or null, `goal` an object or null.
      // Each reader below goes through asRecord/Array.isArray for that reason.
      const goalProjection = asRecord(values.goal)
      const goalSnapshot = asRecord(goalProjection?.goal)
      if (goalSnapshot !== undefined && typeof goalSnapshot.objective === 'string') {
        const phase = typeof goalSnapshot.phase === 'string' ? t('progress.phase', { phase: goalSnapshot.phase }) : ''
        const rounds =
          typeof goalProjection.roundsStarted === 'number'
            ? t('progress.rounds', { rounds: goalProjection.roundsStarted })
            : ''
        lines.push(t('progress.goal', { objective: goalSnapshot.objective, phase, rounds }))
      }

      if (Array.isArray(values.todos)) {
        const todos = values.todos
        const done = todos.filter((item) => asRecord(item)?.status === 'completed').length
        const active = todos.map(asRecord).find((item) => item?.status === 'in_progress')
        const now = typeof active?.content === 'string' ? t('progress.todoNow', { content: clip(active.content) }) : ''
        lines.push(t('progress.todos', { done, total: todos.length, now }))
      }

      const permissions = asRecord(values.permissions)
      if (permissions !== undefined && typeof permissions.currentValue === 'string') {
        lines.push(t('progress.permissions', { value: permissions.currentValue }))
      }

      const inbox = asRecord(values.inbox)
      if (inbox !== undefined) {
        const nextTurn = Array.isArray(inbox['next-turn']) ? inbox['next-turn'].length : 0
        const nextStep = Array.isArray(inbox['next-step']) ? inbox['next-step'].length : 0
        lines.push(t('progress.queued', { turn: nextTurn, step: nextStep }))
      }

      // Turn outline: one bounded prompt/response preview per started turn. This
      // is the "recent summaries" half of the progress contract, and the
      // previews are already bounded by the projection — clipped again here so a
      // future widening of that bound cannot turn this view into a transcript.
      if (Array.isArray(values.turnOutline) && values.turnOutline.length > 0) {
        lines.push(t('progress.turns', { count: values.turnOutline.length }))
        for (const raw of values.turnOutline.slice(-RECENT_TURNS)) {
          const entry = asRecord(raw)
          if (entry === undefined) continue
          const prompt = typeof entry.prompt === 'string' && entry.prompt !== '' ? clip(entry.prompt) : t('progress.turnNoPreview')
          const response =
            typeof entry.response === 'string' && entry.response !== ''
              ? t('progress.turnResponse', { response: clip(entry.response) })
              : ''
          lines.push(t('progress.turn', { turn: String(entry.turn), prompt, response }))
        }
      }

      const recognised = new Set(['goal', 'todos', 'permissions', 'inbox', 'turnOutline', 'title'])
      const others = keys.filter((key) => !recognised.has(key))
      if (others.length > 0) lines.push(t('progress.other', { keys: others.join(', ') }))
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
