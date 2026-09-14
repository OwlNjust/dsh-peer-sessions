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

/**
 * How far a conversation chain may propagate before a delivery is refused.
 *
 * Two peers in a loop do not repeat forever through the channel budget: each
 * round costs tokens and a model turn, so the budget is far too coarse to stop
 * a three-way cascade. This counts CAUSAL hops — a message sent in response to
 * a peer message carries that message's hop plus one — and refuses beyond it.
 */
export const HOP_LIMIT = 3

/** How many deliveries one pair may make inside {@link RATE_WINDOW_MS}. */
export const RATE_LIMIT = 30

/** The window {@link RATE_LIMIT} is measured over. */
export const RATE_WINDOW_MS = 60_000

/**
 * How long an inbound hop keeps counting as "the message being answered".
 *
 * Without an expiry the mark would outlive its turn and silently inflate the
 * hop count of an unrelated delivery an hour later.
 */
const HOP_MEMORY_MS = 15 * 60_000

/** How many inbox items to retain per session. */
const INBOX_LIMIT = 50

/** Stable key for an unordered session pair. */
export function pairKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

/**
 * Human-readable state for one inbox item.
 *
 * The vocabulary is deliberately narrow, because `new` was outright wrong here
 * once: it read as "not read yet" on an item the reader had just opened. A live
 * peer conversation reported exactly that, and it was right — a label must not
 * contradict the state it labels.
 *
 *   [unread]                  nobody has fetched the body
 *   [read · never answered]   fetched, and it is a request still owed a reply
 *   (no marker)               settled: read, and answered if an answer was due
 *
 * Note what these words do NOT claim. `replied` is set on the request the
 * ANSWERING side received, because a reply lands in the OTHER side's inbox — so
 * it means "I answered it", never "I was answered". Only that side sees it.
 *
 * @param status - the item's stored status.
 * @returns the marker to show, or '' for a settled item.
 */
export function readMarker(status) {
  // `unread-unanswered` is included deliberately: it is the state a request
  // STARTS in, and forgetting it here is how the very first listing of an
  // incoming request came out with no marker at all.
  if (status === 'unread' || status === 'unread-unanswered') return 'unread'
  if (status === 'read-unanswered') return 'read · never answered'
  return ''
}

/** One line's worth of state for the by-id retrieval header. */
export function stateLabel(status) {
  if (status === 'unread' || status === 'unread-unanswered') return 'unread · never opened'
  if (status === 'read-unanswered') return 'read · never answered'
  return status
}

/**
 * Turn a `replyWithin` string into milliseconds.
 *
 * Until this existed the field was pure prose: it was printed into the message
 * body and never interpreted, so a request could not actually time out and B5's
 * "notify the sender" had nothing to fire on. Only units that cannot be misread
 * are accepted — `m` is minutes here because that is what the tool description
 * has always promised ("4h", "15m"), and seconds are spelled out.
 *
 * @param raw - the value the model supplied, of unknown shape.
 * @returns milliseconds, or undefined when absent or unrecognizable.
 */
export function parseDuration(raw) {
  if (typeof raw !== 'string') return undefined
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d)\s*$/i.exec(raw)
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  const unit = match[2].toLowerCase()
  const perUnit = { ms: 1, s: 1000, sec: 1000, secs: 1000, m: 60_000, min: 60_000, mins: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, d: 86_400_000 }
  return value * perUnit[unit]
}

export class PeerStore {
  constructor() {
    /** @type {Map<string, object>} pair key -> channel */
    this.channels = new Map()
    /** @type {Map<string, object[]>} recipient session id -> inbox items, newest last */
    this.inbox = new Map()
    /**
     * Per session, the hop count of the peer message it is currently answering:
     * `{ hop, at }`. The model never sees or forwards this — the plugin carries
     * it, because a number the model had to relay would be one it could drop.
     * @type {Map<string, {hop: number, at: number}>}
     */
    this.inboundHops = new Map()
    /**
     * Requests still owed an answer, `requestId -> record`. Kept for BOTH ends
     * so an overdue request can be reported to whoever is still waiting.
     * @type {Map<string, object>}
     */
    this.pending = new Map()
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

  /**
   * Record that `sessionId` is handling an inbound peer message of this hop.
   * @param sessionId - the receiving session.
   * @param hop - the hop count carried by the message it received.
   */
  noteInboundHop(sessionId, hop) {
    this.inboundHops.set(sessionId, { hop, at: Date.now() })
  }

  /**
   * The hop count a message sent right now should carry.
   *
   * A delivery made while answering a peer message continues that chain, so it
   * carries one more hop than the message it answers. A delivery made on the
   * user's own initiative starts a fresh chain at hop 1.
   *
   * @param sessionId - the sending session.
   * @returns the hop count to carry.
   */
  nextHop(sessionId) {
    const mark = this.inboundHops.get(sessionId)
    if (mark === undefined) return 1
    // A stale mark would inflate an unrelated delivery: past the memory window
    // this is a new chain, not an answer to something from twenty minutes ago.
    if (Date.now() - mark.at > HOP_MEMORY_MS) {
      this.inboundHops.delete(sessionId)
      return 1
    }
    return mark.hop + 1
  }

  /**
   * Whether one more delivery on this channel is within its rate limit.
   *
   * A fixed window with a single counter, not a sliding list of timestamps:
   * the channel already knows its last activity, and a long-running pair must
   * not accumulate per-delivery state forever.
   *
   * @param channel - the channel being used.
   * @param now - current time, for testability.
   * @returns whether the delivery is allowed.
   */
  withinRate(channel, now = Date.now()) {
    if (channel.rateWindowStart === undefined || now - channel.rateWindowStart >= RATE_WINDOW_MS) {
      channel.rateWindowStart = now
      channel.rateCount = 0
    }
    channel.rateCount += 1
    return channel.rateCount <= RATE_LIMIT
  }

  /**
   * Remember a request that is owed an answer.
   * @param record - who issued it, which channel, and when it is due.
   */
  notePending(record) {
    this.pending.set(record.requestId, { ...record, reported: false })
  }

  /** Forget a pending request, once an answer arrives. */
  clearPending(requestId) {
    return this.pending.delete(requestId)
  }

  /**
   * Pending requests addressed to one session whose deadline has passed and
   * which have not been reported yet, newest deadline first, each marked as
   * reported so the same miss is announced once and not on every call.
   *
   * @param sessionId - the session that is still waiting for answers.
   * @param now - current time, for testability.
   * @returns the overdue records, now marked reported.
   */
  overdueRequests(sessionId, now = Date.now()) {
    const out = []
    for (const record of this.pending.values()) {
      if (record.from !== sessionId) continue
      if (record.reported) continue
      if (now < record.dueAt) continue
      record.reported = true
      record.overdue = true
      out.push(record)
    }
    return out.sort((x, y) => x.dueAt - y.dueAt)
  }

  /** Whether a request is already known to be past its deadline. */
  isOverdue(requestId, now = Date.now()) {
    const record = this.pending.get(requestId)
    if (record === undefined) return false
    return now >= record.dueAt
  }

  /**
   * Every request one session is still owed an answer to, soonest deadline
   * first. Overdue ones sort first because `Infinity` sorts last.
   * @param sessionId - the session that asked.
   * @returns the pending records.
   */
  pendingFor(sessionId) {
    const out = []
    for (const record of this.pending.values()) {
      if (record.from === sessionId) out.push(record)
    }
    return out.sort((x, y) => x.dueAt - y.dueAt)
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
        if (item.requestId === requestId && (item.status === 'unread-unanswered' || item.status === 'read-unanswered')) {
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
   * Whether a body has been read and whether a request has been answered are
   * ORTHOGONAL facts sharing one `status` field, so reading must not overwrite
   * the answer marker: a request whose body has been read is still owed a reply.
   * Collapsing it to plain `read` would erase the one thing the inbox exists to
   * show (B6), hence the `read-unanswered` state — and the name says what it is,
   * which the earlier `new` did not.
   * @returns whether a matching item was found.
   */
  markRead(sessionId, messageId) {
    const list = this.inbox.get(sessionId)
    if (list === undefined) return false
    const item = list.find((entry) => entry.id === messageId)
    if (item === undefined) return false
    if (item.status === 'unread') item.status = 'read'
    else if (item.status === 'unread-unanswered') item.status = 'read-unanswered'
    return true
  }

  /** Drop every channel one session participates in. */
  dropSession(sessionId) {
    for (const channel of this.channelsFor(sessionId)) this.revoke(channel)
    this.inbox.delete(sessionId)
    this.inboundHops.delete(sessionId)
    // Drop the requests this session was still waiting on; a request the OTHER
    // side is waiting on stays, because its own deadline is not this session's
    // to forget.
    for (const [requestId, record] of this.pending) {
      if (record.from === sessionId) this.pending.delete(requestId)
    }
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
