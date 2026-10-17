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
import { buildPeerMessageFromText, buildDeliveryNotice, renderPeerBody, mergeIntoBatch, PEER_KIND } from './messages.js'
import { PeerStore, parseDuration, pairKey } from './store.js'
import { appendGrant, appendRevoke, replayOf, revokeTimeIn, durabilityAvailable } from './grants.js'
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
 * Whether a message may be folded into one the peer has not read yet.
 *
 * When a conversation is busy, the Host queues a peer message as its own turn
 * (`claim()` takes exactly one `next-turn` item per turn), so a burst of progress
 * reports becomes N turns — and the first one is verified against a world that
 * the later ones have already moved on. Merging keeps the queued message single
 * and current: each new one is folded in place, with its own time and label, so
 * one turn reads the whole burst in send order. Nothing is dropped: a merge is a
 * concatenation, and when the queued message is already being read the caller
 * falls back to an ordinary queued turn.
 */
const MERGE_WHILE_BUSY = true

/**
 * Cap on one merged body.
 *
 * A long Task can queue hundreds of messages; an unbounded concatenation would
 * turn the peer's next turn into a log dump. Past this, the overflow is delivered
 * as its own ordinary message instead — still in order, still nothing dropped.
 */
const MERGE_MAX_CHARS = 12_000

/**
 * The presentation preferences, as defaults.
 *
 * These are display choices rather than safety ceilings, but they live in the
 * same `Config` schema (`lib/index.js`) so a user has one place to look. The
 * constants above stay the source of truth; a test pins the schema's defaults
 * back to them.
 */
export const CORE_DEFAULTS = Object.freeze({
  maxCandidates: MAX_CANDIDATES,
  recentTurns: RECENT_TURNS,
  previewMaxChars: PREVIEW_MAX_CHARS,
  mergeWhileBusy: MERGE_WHILE_BUSY,
  mergeMaxChars: MERGE_MAX_CHARS,
})

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

/** Clip one preview string to the configured preview bound. */
function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * One bounded line describing any thrown value.
 *
 * Persistence and replay failures are logged rather than surfaced: they arrive
 * from a `catch` of unknown shape, and an unbounded string in a log line can
 * itself become the problem.
 * @param error - any thrown value.
 * @returns a clipped description.
 */
function errorText(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`
}

export class PeerCore {
  /**
   * @param ctx - the plugin's host context.
   * @param store - the channel store. Supplied by the caller so it can outlive
   *   one `apply()`; see the note in `index.js`.
   * @param t - the translator for human-facing copy. Callers pass a function
   *   that reads the CURRENT locale, so a language change is picked up without
   *   rebuilding anything.
   * @param options - the presentation preferences; anything omitted falls back
   *   to the module defaults, so `new PeerCore(ctx)` is unchanged behaviour.
   */
  constructor(ctx, store = new PeerStore(), t = translator(DEFAULT_LOCALE), options = {}) {
    this.ctx = ctx
    this.store = store
    this.t = t
    this.maxCandidates = options.maxCandidates ?? MAX_CANDIDATES
    this.recentTurns = options.recentTurns ?? RECENT_TURNS
    this.previewMaxChars = options.previewMaxChars ?? PREVIEW_MAX_CHARS
    this.mergeWhileBusy = options.mergeWhileBusy ?? MERGE_WHILE_BUSY
    this.mergeMaxChars = options.mergeMaxChars ?? MERGE_MAX_CHARS
    /**
     * Claim the store's durable sink.
     *
     * Done here rather than at the composition site so the invariant holds for
     * every core ever built on a store — production, tests, or a script — and
     * so a re-built core (every `apply`) replaces a stale one automatically. The
     * store reports every grant, quota change, and revocation through it, which
     * is why no call site has to remember to persist anything.
     */
    this.store.attach((kind, channel) => this.persist(kind, channel))
  }

  /** Clip one preview line through this instance's configured bound. */
  clip(text) {
    return clip(text, this.previewMaxChars)
  }

  /**
   * Replay one conversation's durable grants into the store, once per session.
   *
   * Called at every entry point that READS channel state — if it were only
   * called on the send path, `peer_list` would show no channels and `/peer
   * revoke` would refuse to revoke a channel that is in fact still persisted,
   * which is the one place a stale view is dangerous.
   *
   * A session that is not live right now yields nothing and is NOT marked as
   * hydrated, so the read is retried once the session exists. Marking it early
   * would silently disable persistence for that conversation until the process
   * restarts, which is exactly the bug this feature exists to fix.
   *
   * THE CROSS-CHECK, and why it needs to read the other end's log: a channel is
   * revoked by whichever conversation types `/peer revoke`, and only the
   * GRANTING conversation's log holds the grant. A revocation issued while the
   * granting conversation is cold can therefore only be written into the
   * revoking conversation's log — so a replay that trusted its own log alone
   * would resurrect the revoked channel. Each adopted channel is therefore
   * checked against the peer's newest tombstone, read from the live Session when
   * there is one and through `sessionController.inspect()` (cold-safe, does not
   * wake anything) otherwise. `inspect` failing is not fatal: the channel is
   * kept, which is the same behaviour as a deployment without the method.
   *
   * @param sessionId - the conversation whose grants to load.
   * @returns how many channels were adopted (before any cross-check removal).
   */
  async hydrate(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return 0
    if (!durabilityAvailable) {
      this.warnNoDurability()
      return 0
    }
    if (this.store.hasHydrated(sessionId)) return 0
    const session = this.ctx.sessions?.get?.(sessionId)
    if (session === undefined) return 0

    let operations
    try {
      operations = replayOf(session)
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-peer-sessions: could not read durable grants (${errorText(error)})`)
      return 0
    }
    // Marked only after a successful read: a read that threw must be retried,
    // because marking it would disable this conversation's persistence until the
    // process restarts — the exact failure this feature exists to remove.
    this.store.markHydrated(sessionId)

    let adopted = 0
    /**
     * pair key -> the time the channel currently in the store was established,
     * for the cross-check below.
     */
    const grantedAt = new Map()
    for (const operation of operations) {
      const key = operation.kind === 'upsert'
        ? pairKey(operation.channel.a, operation.channel.b)
        : pairKey(operation.pair.a, operation.pair.b)
      // THE MERGE RULE, and it is not optional once two logs share one store: a
      // replay must never let an OLD record overwrite a NEWER state. Live
      // reproduction of the failure: A revoked at T1 and re-granted at T2; the
      // tombstone also went into B's log (both ends were live); B was then woken
      // and hydrated, replayed its T1 tombstone unconditionally, and deleted A's
      // T2 channel from the shared store. `peer_list` then showed no channels
      // while the log still held a live grant. Comparing record times makes the
      // newest write per pair win, whichever log it came from.
      const existing = this.store.channels.get(key)
      if (existing !== undefined && (existing.stateAt ?? 0) > operation.at) continue

      if (operation.kind === 'upsert') {
        this.store.adopt(operation.channel, operation.at)
        grantedAt.set(key, operation.at)
        adopted += 1
      } else {
        // Replay-only: a tombstone already in the log must not be appended
        // again, or a session restored N times would carry N tombstones.
        this.store.forget({ id: operation.pair.channelId ?? 'replayed', a: operation.pair.a, b: operation.pair.b })
        grantedAt.delete(key)
      }
    }
    if (adopted === 0) return 0

    for (const [key, writtenAt] of grantedAt) {
      const channel = this.store.channels.get(key)
      if (channel === undefined) continue
      const peerId = channel.a === sessionId ? channel.b : channel.a
      const peerSession = this.ctx.sessions?.get?.(peerId) ?? (await this.inspectSession(peerId))
      if (peerSession === undefined) continue
      const revokedAt = revokeTimeIn(peerSession, channel.a, channel.b)
      // Equal timestamps count as revoked: when two records cannot be ordered,
      // the one that withdraws authority wins.
      if (revokedAt !== undefined && revokedAt >= (channel.stateAt ?? writtenAt)) this.store.forget(channel)
    }
    return adopted
  }

  /**
   * Read a conversation that is not live, without waking it.
   *
   * `sessionController.inspect` returns the persisted header and event prefix and
   * explicitly does not activate an Agent. Anything it throws (a session that
   * needs migration, a writer holding it) means "cannot check", never "revoked":
   * the caller keeps the channel it already adopted.
   *
   * @param sessionId - the conversation to read.
   * @returns the inspection, or undefined when it cannot be read.
   */
  async inspectSession(sessionId) {
    const controller = this.ctx.sessionController
    if (typeof controller?.inspect !== 'function') return undefined
    try {
      return await controller.inspect(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Find a channel that exists only in a log, not in this process's store.
   *
   * This is what makes `/peer revoke` honest for a channel the PEER's human
   * approved: after a restart the granting log may be the only place the channel
   * exists, and revoking "nothing" while reporting nothing would leave the peer
   * able to send. The newest record for the pair decides, so a tombstone that is
   * already there is not resurrected as a live channel.
   *
   * @param a - one end of the pair.
   * @param b - the other end.
   * @returns the channel named by the newest surviving grant, or undefined.
   */
  async durableChannelBetween(a, b) {
    const key = pairKey(a, b)
    for (const id of [a, b]) {
      const session = this.ctx.sessions?.get?.(id) ?? (await this.inspectSession(id))
      if (session === undefined) continue
      let newest
      for (const operation of replayOf(session)) {
        const operationKey =
          operation.kind === 'upsert'
            ? pairKey(operation.channel.a, operation.channel.b)
            : pairKey(operation.pair.a, operation.pair.b)
        if (operationKey !== key) continue
        if (newest === undefined || operation.at >= newest.at) newest = operation
      }
      if (newest !== undefined && newest.kind === 'upsert') return newest.channel
    }
    return undefined
  }

  /**
   * Say once that this Host cannot persist a grant.
   *
   * A dsh older than 0.2.1 has no `appendPluginRecord`. Everything except
   * survival across a restart still works there, so the plugin degrades to its
   * previous lifetime instead of refusing to load — but it says so, once, rather
   * than letting a user believe the channel is durable when it is not.
   */
  warnNoDurability() {
    if (this.warnedNoDurability === true) return
    this.warnedNoDurability = true
    this.ctx.logger?.warn?.(
      'dsh-peer-sessions: this Host has no appendPluginRecord (dsh >= 0.2.1), so grants live only in this process',
    )
  }

  /**
   * Make one channel transition durable.
   *
   * A GRANT belongs in the log of the conversation whose human approved it
   * (`channel.createdBy`) — not necessarily the sender. A channel the PEER's user
   * approved is usable from here, but writing consent into the log of a
   * conversation whose human never saw the card would be a provenance lie, and
   * H3 keeps consent where it was given.
   *
   * A TOMBSTONE goes to every live end of the pair: either human may withdraw the
   * channel, and the end that did not grant it has no grant record to overwrite.
   * With both ends live this makes the withdrawal durable on both sides; with the
   * granting end cold it lands in the revoker's log, which is exactly what
   * {@link hydrate}'s cross-check reads when the granting end comes back.
   *
   * Deliberately swallows its own failures: every caller has already changed
   * in-memory state, and a delivery or a revocation must not fail because its
   * audit trail could not be written. The failure is logged, where a human can
   * find it, and the in-memory state stays authoritative for this process.
   *
   * @param kind - `'open'`, `'update'`, or `'revoke'`.
   * @param channel - the channel as it stands after the transition.
   */
  persist(kind, channel) {
    if (!durabilityAvailable) {
      this.warnNoDurability()
      return
    }
    const targets = kind === 'revoke' ? [channel.a, channel.b] : [channel.createdBy]
    for (const id of new Set(targets)) {
      if (typeof id !== 'string' || id === '') continue
      const session = this.ctx.sessions?.get?.(id)
      if (session === undefined) continue
      try {
        if (kind === 'revoke') appendRevoke(session, channel)
        else appendGrant(session, channel)
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-peer-sessions: could not persist channel ${channel.id} (${errorText(error)})`)
      }
    }
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
    const shown = found.candidates.slice(0, this.maxCandidates)
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
   * @param signal - cancellation.
   * @param waitCallId - the calling tool's id, when a tool call is asking: it
   *   names the card so the client hides rather than cancels it (坑 17).
   * @returns the discriminated consent answer (see `askGrant`).
   */
  askGrantFor(agent, peerLabel, signal, waitCallId) {
    return askGrant(this.ctx, { agent, peerLabel, signal, t: this.t, waitCallId })
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
   * Settle which grant this delivery runs on, BEFORE anything awaits.
   *
   * A `once` grant buys ONE EXCHANGE, not one message: the answer to a request
   * that grant carried rides along instead of asking again — which would raise a
   * card in the peer's conversation and read as "didn't I just approve this?".
   *
   * Order is the whole point of this method. The exchange is consumed HERE,
   * synchronously, rather than at the end of the async path: everything
   * downstream may await, and two answers to the same request would otherwise
   * both observe an unspent grant, both ride it, and both deliver — one approval
   * buying two exchanges.
   *
   * @param selfId - the sending session.
   * @param peerId - the receiving session.
   * @param payload - the message about to be sent.
   * @returns the channel to deliver on (`undefined` when none survives) and
   *   whether this delivery rides a grant that is being spent by it.
   */
  resolveGrant(selfId, peerId, payload) {
    const channel = this.store.between(selfId, peerId)
    if (channel === undefined || channel.remaining === null || channel.remaining > 0) {
      return { channel, ridesExistingGrant: false }
    }
    const answering = payload.kind === 'reply' ? payload.replyTo : undefined
    if (!this.store.isAnswerableOn(channel, answering, selfId)) {
      // An exhausted `once` channel is a spent grant, not an open one.
      this.store.revoke(channel)
      return { channel: undefined, ridesExistingGrant: false }
    }
    this.store.revoke(channel)
    return { channel, ridesExistingGrant: true }
  }

  /**
   * Fold this message into the one already queued for the peer, if there is one.
   *
   * The mechanism is the Host's own inbox facade: `agent.inbox.nextTurn` lists
   * the messages that are queued but NOT yet claimed, and `inbox.replace(id, …)`
   * atomically swaps one of them (durably — it goes through the inbox splice).
   * So the queued message stays a single durable message while its content grows,
   * and the peer's next turn reads the whole burst once.
   *
   * The two ways this legitimately declines, both falling back to the ordinary
   * `followup`:
   *   - the queued message is gone (`replace` returns false because it was just
   *     claimed). The peer is already reading it; the new message must be its own
   *     turn. Nothing is lost, it is just not merged.
   *   - the merged body would exceed {@link PeerCore.mergeMaxChars}. A long task
   *     can queue a lot; past the cap the overflow gets its own message.
   *
   * Only a relay THIS conversation left queued is considered — `source.kind` and
   * `senderSessionId` are structural, not text matching — and only for the
   * non-silent path: a silent delivery is context injected into the peer's next
   * STEP, where replacing in-flight content would be a different, riskier thing.
   *
   * @param target - the peer's live agent.
   * @param selfId - this conversation's session id.
   * @param body - the new message's own rendering (timestamps included).
   * @returns whether the message was merged into the queued one.
   */
  mergeQueued(target, selfId, body) {
    if (this.mergeWhileBusy !== true) return false
    const inbox = target?.inbox
    if (inbox === undefined || typeof inbox.replace !== 'function') return false
    const pending = Array.isArray(inbox.nextTurn)
      ? inbox.nextTurn.find(
          (message) => message?.source?.kind === PEER_KIND && message.source.senderSessionId === selfId,
        )
      : undefined
    if (pending === undefined) return false

    const previousText = (pending.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    if (previousText === '') return false

    const mergedText = mergeIntoBatch(previousText, body)
    if (mergedText.length > this.mergeMaxChars) return false
    const mergedMessage = buildPeerMessageFromText(mergedText, selfId)
    // An exception here would happen after the peer was woken and the quota
    // spent; the caller's fallback (`followup`) is the safe answer, so a throwing
    // `replace` is treated exactly like "it was already claimed".
    try {
      return inbox.replace(pending.id, mergedMessage) === true
    } catch {
      return false
    }
  }

  /**
   * Write down what just crossed the channel.
   *
   * Everything here is bookkeeping for later reads (`peer_inbox`, the overdue
   * notice, the reply-direction check, the hop the peer will answer on), so it is
   * kept together and after the delivery for one reason: the record must describe
   * a delivery that actually happened.
   *
   * @param args - the delivery facts.
   * @returns the stored inbox item.
   */
  recordDelivery({ selfId, selfLabel, peerId, peer, channel, payload, body, hop, sentAt }) {
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
      sentAt,
      deliveredAt: sentAt,
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
      // The request is what lets a `once` exchange's answer ride the same grant,
      // so it belongs to the durable state: a restart between question and
      // answer must not lose it. Only `once` channels persist their carried
      // requests (see `grants.js`), so only they need the extra write.
      if (channel.tier === 'once') this.store.markChanged(channel)
    }
    return item
  }

  /**
   * Deliver one payload to a peer, obtaining a grant if there is none.
   *
   * @param args - sender identity, the peer entry, the payload, and options.
   * @returns a result describing what happened.
   * @throws {PeerRefusal} when the hard rule forbids the delivery.
   */
  async deliver({ selfAgent, selfLabel, peerEntry, payload, silent = false, signal, waitCallId }) {
    const selfId = selfAgent.id
    const peerId = peerEntry.sessionId
    // Load this conversation's durable grants BEFORE the first state read: a
    // channel approved before a restart must be found instead of raising a
    // second card for a decision the human already made.
    await this.hydrate(selfId)
    const { peer } = await this.assertBothVisible(selfId, peerId, signal)

    // Liveness is read FIRST, before any prompt, so the grant card can state the
    // whole cost of approving. Idle conversations are cold in this deployment,
    // so a second "wake it?" prompt after every grant was pure friction.
    const live = this.ctx.agents.get(peerId)
    const willWake = live === undefined

    let { channel, ridesExistingGrant } = this.resolveGrant(selfId, peerId, payload)

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
    if (hop > this.store.hopLimit) {
      throw new PeerRefusal(this.t('hop.exceeded', { hop, limit: this.store.hopLimit }))
    }

    if (channel === undefined) {
      const consent = await askGrant(this.ctx, {
        agent: selfAgent,
        peerLabel: peer.label,
        signal,
        t: this.t,
        willWake,
        waitCallId,
      })
      // "Could not ask" and "the human said no" are different facts, and the
      // caller needs both: only one of them is worth retrying. Both still send
      // nothing.
      if (consent.outcome === 'unavailable') {
        return { outcome: 'consent-unavailable', peer, reason: consent.reason }
      }
      if (consent.outcome !== 'granted') return { outcome: 'declined', peer }
      const tier = consent.tier

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
      throw new PeerRefusal(
        this.t('rate.limited', { limit: this.store.rateLimit, seconds: this.store.rateWindowMs / 1000 }),
      )
    }
    if (!ridesExistingGrant && !this.store.spend(channel)) {
      throw new PeerRefusal(this.t('budget.spent'))
    }

    // Render once and use the SAME text for the delivered message and for the
    // inbox copy, so the archived body cannot drift from what was delivered.
    const sentAt = Date.now()
    const body = renderPeerBody({
      senderId: selfId,
      senderLabel: selfLabel,
      tier: channel.tier,
      channelId: channel.id,
      hop,
      sentAt,
      ...payload,
    })
    const message = buildPeerMessageFromText(body, selfId)

    // `followup` queues a distinct turn and wakes the driver; a peer that is
    // mid-turn therefore receives this when it finishes, never in the middle of
    // a step. `steer` is deliberately never used — it would interrupt.
    //
    // A message that would become its OWN queued turn is first offered to the
    // message already waiting for the same peer: while that one is still
    // unclaimed, folding into it is what turns a burst of progress reports into
    // one readable batch instead of N turns that each work from a stale state.
    // When the fold cannot happen (already claimed, cap reached, different
    // sender) the ordinary queued turn is still exactly what happens.
    if (silent) target.inject(message)
    else if (!this.mergeQueued(target, selfId, body)) target.followup(message)

    // The receiver now knows which hop it is answering, so a message it sends
    // back continues this chain instead of starting a fresh one.
    this.store.noteInboundHop(peerId, hop, selfId)

    const item = this.recordDelivery({ selfId, selfLabel, peerId, peer, channel, payload, body, hop, sentAt })

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
   * WHERE THESE SHAPES COME FROM — empirical, not contract. Each key below is
   * owned by another package, and none of them promises this plugin stability.
   * Verified against dsh 0.2.0-rc.2, with the owning definition for the next
   * upgrade review:
   *
   *   goal         dsh-goal                 `goalProjectionDefinition` (wire view = state.current)
   *   todos        dsh-tool-todo            `TodoItem[] | null`
   *   permissions  dsh-permission-presets   `{ currentValue: string }`
   *   inbox        dsh-agent-loop           `{ 'next-turn': [], 'next-step': [] }` (elements unvalidated)
   *   turnOutline  dsh-session-turn-outline `{ turn, seq, prompt, response }[]`
   *
   * A change in any of them degrades SILENTLY: the guard below stops matching and
   * the view loses a line without an error. `title` — read in `addressable.js`,
   * not here — is the only one with a test that uses the Host's own schema as its
   * oracle; the rest are unguarded, which is why they are named above.
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
        const now = typeof active?.content === 'string' ? t('progress.todoNow', { content: this.clip(active.content) }) : ''
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
        for (const raw of values.turnOutline.slice(-this.recentTurns)) {
          const entry = asRecord(raw)
          if (entry === undefined) continue
          const prompt = typeof entry.prompt === 'string' && entry.prompt !== '' ? this.clip(entry.prompt) : t('progress.turnNoPreview')
          const response =
            typeof entry.response === 'string' && entry.response !== ''
              ? t('progress.turnResponse', { response: this.clip(entry.response) })
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
