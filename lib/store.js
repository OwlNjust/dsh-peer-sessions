/**
 * Peer channel state — process-scoped, deliberately not persisted.
 *
 * A grant is valid "for this conversation only". The plugin itself is
 * process-scoped while a conversation is identified by its session id, so an
 * in-memory map keyed by session id has exactly the required lifetime: it
 * survives a conversation going cold and being resumed, and it dies with the
 * process. Nothing is written to disk, so nothing survives a restart — which is
 * the documented scope, not an oversight.
 *
 * Storing grants as a custom session event was considered and rejected:
 * `dsh-session` exports `KNOWN_SESSION_EVENT_TYPES`, so a vocabulary addition
 * is a contract risk for a benefit this map already provides.
 *
 * @module dsh-peer-sessions/store
 */

/** Hard ceiling on deliveries per channel, so two peers cannot ping-pong forever. */
export const CHANNEL_BUDGET = 200

/** How many inbox items to retain per session. */
const INBOX_LIMIT = 50

/** Stable key for an unordered session pair. */
export function pairKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

/**
 * Human-readable state for one inbox item.
 *
 * `read` and `replied` deliberately return an empty marker: those two are the
 * settled states, and a line that says nothing is how an inbox stays scannable.
 * `replied` never reaches the by-id retrieval path in practice — a reply writes
 * into the OTHER side's inbox and sets the request to `replied` here — so
 * "request sent" is the honest description rather than "you answered".
 *
 * @param status - the item's stored status.
 * @returns the marker to show, or '' for a settled item.
 */
export function readMarker(status) {
  if (status === 'unread') return 'unread'
  // A request whose body HAS been fetched but which nobody has answered yet.
  if (status === 'new') return 'new · never answered'
  if (status === 'awaiting-reply') return 'never opened'
  return ''
}

/** One line's worth of state for the by-id retrieval header. */
export function stateLabel(status) {
  if (status === 'new') return 'read · still unanswered'
  if (status === 'awaiting-reply') return 'unread · never opened'
  return status
}

export class PeerStore {
  constructor() {
    /** @type {Map<string, object>} pair key -> channel */
    this.channels = new Map()
    /** @type {Map<string, object[]>} recipient session id -> inbox items, newest last */
    this.inbox = new Map()
    this.seq = 0
  }

  /** One channel between two sessions, or undefined. */
  between(a, b) {
    return this.channels.get(pairKey(a, b))
  }

  /**
   * Open (or re-open) a channel covering BOTH directions, per the single-point
   * grant decision.
   * @param args - the two session ids, the tier, and the initiating session.
   * @returns the channel.
   */
  open({ a, b, tier, by }) {
    const key = pairKey(a, b)
    const [left, right] = a < b ? [a, b] : [b, a]
    const channel = {
      id: `pc-${++this.seq}`,
      a: left,
      b: right,
      tier,
      remaining: tier === 'once' ? 1 : CHANNEL_BUDGET,
      createdAt: Date.now(),
      createdBy: by,
      lastActivityAt: Date.now(),
      /**
       * Requests this channel has carried, as requestId -> the session that
       * issued it. A `once` grant buys one exchange, so the answer to a request
       * the same grant carried must ride along instead of asking again — and
       * asking again would raise the card in the PEER's conversation, which
       * reads as "didn't I just approve this?".
       * @type {Map<string, string>}
       */
      openRequests: new Map(),
    }
    this.channels.set(key, channel)
    return channel
  }

  /** Remember that `from` issued `requestId` over this channel. */
  noteRequest(channel, requestId, from) {
    channel.openRequests.set(requestId, from)
  }

  /**
   * Whether `requestId` is answerable on this channel by `bySession` — true
   * only when the request was issued by the OTHER side of the channel, so that
   * one side's request cannot be used to unlock the other side's budget.
   * @param channel - the channel in question.
   * @param requestId - the request the reply names in `replyTo`.
   * @param bySession - the session attempting to reply.
   * @returns whether this reply rides the grant that carried the request.
   */
  isAnswerableOn(channel, requestId, bySession) {
    return channel.openRequests.get(requestId) === this.other(channel, bySession)
  }

  /** Remove one channel. */
  revoke(channel) {
    this.channels.delete(pairKey(channel.a, channel.b))
  }

  /**
   * Consume one delivery from a channel.
   * @param channel - the channel being used.
   * @returns whether the delivery is within budget.
   */
  spend(channel) {
    if (channel.remaining !== null && channel.remaining <= 0) return false
    if (channel.remaining !== null) channel.remaining -= 1
    channel.lastActivityAt = Date.now()
    return true
  }

  /** Every channel one session participates in. */
  channelsFor(sessionId) {
    const out = []
    for (const channel of this.channels.values()) {
      if (channel.a === sessionId || channel.b === sessionId) out.push(channel)
    }
    return out.sort((x, y) => y.lastActivityAt - x.lastActivityAt)
  }

  /** The other end of a channel. */
  other(channel, sessionId) {
    return channel.a === sessionId ? channel.b : channel.a
  }

  /**
   * Record one delivered message in the recipient's inbox.
   *
   * The FULL text that crossed the channel is stored, not just the summary.
   * That is the whole point of an inbox item: once the relay message has left
   * the recipient's context, an id alone must still be enough to read what was
   * actually said. Keeping the complete delivered text (provenance header
   * included) also means a retrieval in a much later turn cannot be mistaken
   * for the human speaking — the header travels with the body even where the
   * original turn no longer exists.
   */
  record(item) {
    const list = this.inbox.get(item.to) ?? []
    list.push(item)
    while (list.length > INBOX_LIMIT) list.shift()
    this.inbox.set(item.to, list)
    return item
  }

  /** One session's inbox, newest first. */
  inboxFor(sessionId) {
    return [...(this.inbox.get(sessionId) ?? [])].reverse()
  }

  /**
   * One inbox item by its message id, or undefined.
   * @param sessionId - the session whose inbox is searched.
   * @param messageId - the id printed by `peer_send` and listed by `peer_inbox`.
   * @returns the matching item.
   */
  findInboxItem(sessionId, messageId) {
    return (this.inbox.get(sessionId) ?? []).find((entry) => entry.id === messageId)
  }

  /**
   * Mark one inbound request as answered.
   *
   * Which inbox holds the request depends on WHO STARTED the exchange, and both
   * directions are legitimate: a request is recorded in the inbox of its
   * recipient, so the holder is the answering session when it answers a request
   * it received, and the answering session's peer when it started the exchange
   * itself and is now being answered.
   *
   * An earlier version named exactly one of those inboxes and was therefore
   * wrong half the time. Measured, twice, in two directions — the rule is simply
   * "look in both ends of the channel", which needs no assumption about who
   * spoke first. The channel is authoritative for who the two ends are.
   *
   * @param sessionId - the session that is answering.
   * @param requestId - the request the reply names in `replyTo`.
   * @param channel - the channel the reply went out on, when there is one.
   * @returns whether a matching open request was found.
   */
  markReplied(sessionId, requestId, channel) {
    const ends = channel === undefined ? [sessionId] : [sessionId, this.other(channel, sessionId)]
    let found = false
    for (const holder of ends) {
      for (const item of this.inbox.get(holder) ?? []) {
        // `new` is a request whose body has ALREADY been read but which is still
        // unanswered; it is just as answerable as one nobody has opened yet.
        if (item.requestId === requestId && (item.status === 'awaiting-reply' || item.status === 'new')) {
          item.status = 'replied'
          item.repliedAt = Date.now()
          found = true
        }
      }
    }
    return found
  }

  /**
   * Mark one inbox item read — "the body has been fetched", not "the summary
   * was listed".
   *
   * Called only from the by-id retrieval path, which is the user's chosen
   * semantics: a summary line does not count as having read the message.
   *
   * Read and awaiting-reply are ORTHOGONAL facts sharing one field, so read
   * must not overwrite the reply marker: a request whose body has been read is
   * still a request nobody has answered. Calling it plain `read` would erase
   * the one thing the inbox exists to show (B6), so it becomes `new` instead.
   * @returns whether a matching item was found.
   */
  markRead(sessionId, messageId) {
    const list = this.inbox.get(sessionId)
    if (list === undefined) return false
    const item = list.find((entry) => entry.id === messageId)
    if (item === undefined) return false
    if (item.status === 'unread') item.status = 'read'
    else if (item.status === 'awaiting-reply') item.status = 'new'
    return true
  }

  /** Drop every channel one session participates in. */
  dropSession(sessionId) {
    for (const channel of this.channelsFor(sessionId)) this.revoke(channel)
    this.inbox.delete(sessionId)
  }

  /** Drop channels whose either end is no longer addressable. */
  prune(unreachableIds) {
    const dropped = []
    for (const channel of [...this.channels.values()]) {
      if (unreachableIds.has(channel.a) || unreachableIds.has(channel.b)) {
        this.revoke(channel)
        dropped.push(channel)
      }
    }
    return dropped
  }
}
