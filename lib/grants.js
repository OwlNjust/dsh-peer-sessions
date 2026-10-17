/**
 * Durable grants — a peer channel's survival across a process restart or a
 * module reload.
 *
 * A grant used to live only in the process (see `store.js`). Since dsh 0.2.1
 * the Host offers exactly the mechanism that changes that without touching the
 * session vocabulary: `appendPluginRecord` writes an `ignorable` event whose
 * type is `plugin:<owner>/<name>`, the model never sees it, fork and resume carry
 * it, and a reader that does not recognize it skips it. `pluginRecordOf` reads
 * one back.
 *
 * WHY THIS IS AN APPEND-ONLY LOG RATHER THAN ONE UPDATED RECORD: a session log
 * is append-only and immutable, so "the current channel" is the FOLD of its
 * records, last write per channel wins. That also makes the read path tolerant
 * by construction — an older build's records, a revoked-then-reopened channel,
 * and a record with a payload shape this build does not understand all resolve
 * to a defined state instead of an error.
 *
 * WHERE A RECORD LIVES — and this is the important design decision: in the log
 * of the session whose HUMAN approved the channel (`channel.createdBy`), never
 * in the peer's log. The peer's conversation never saw that card; writing its
 * authorization into the peer's log would be a provenance lie, and H3 says the
 * consent is the human's, in the conversation where they gave it. The
 * consequence is deliberate: after a restart, a channel is usable again once the
 * GRANTING conversation has loaded it. The other end asking first gets its own
 * card, which is the honest answer — *its* human never approved anything.
 *
 * WHAT IS NOT PERSISTED, on purpose: the plugin's inbox, pending-request
 * deadlines, inbound hop marks, and the rate window. Those describe deliveries
 * in flight, not authority; a restart ends the in-flight half and must not
 * resurrect a deadline nobody is waiting for any more.
 *
 * @module dsh-peer-sessions/grants
 */

// A NAMESPACE import, not named imports, and that is load-bearing: on a Host
// older than dsh 0.2.1 these two exports do not exist, and `import { x } from`
// would fail at link time — taking the whole plugin down on a deployment that
// can still do everything except survive a restart (the desktop build measured
// in MAINTENANCE.md §三 坑 17 is exactly such a Host). A namespace import leaves
// them `undefined`, which {@link durabilityAvailable} turns into the documented
// memory-only behaviour plus one warning, never a crash.
import * as sessionApi from '@deepseek-ai/dsh-session'

import { pairKey } from './store.js'

/**
 * Whether this Host can persist a grant at all.
 *
 * False on dsh < 0.2.1, where `appendPluginRecord` does not exist. Every caller
 * then keeps working from the in-memory store and the plugin says so once
 * (`PeerCore.persist`), instead of throwing on every delivery.
 */
export const durabilityAvailable =
  typeof sessionApi.appendPluginRecord === 'function' && typeof sessionApi.pluginRecordOf === 'function'

/** One full snapshot of a channel's durable state. */
export const GRANT_RECORD = 'plugin:dsh-peer-sessions/channel'

/** One tombstone: this pair's channel is gone, and the snapshot before it is void. */
export const REVOKE_RECORD = 'plugin:dsh-peer-sessions/revoke'

/**
 * Payload version, checked on read.
 *
 * A record whose version this build does not know is SKIPPED, not guessed at: a
 * future build may store a shape this one would silently misread, and a wrong
 * grant is worse than a missing one. Bump this whenever the payload stops being
 * faithfully readable by the previous version.
 */
export const GRANT_RECORD_VERSION = 1

const TIERS = new Set(['once', 'session'])

/** Whether a value can serve as a session id or channel id. */
function idOf(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A finite epoch-ms value, or undefined — never a string or NaN. */
function stampOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The durable snapshot of one channel.
 *
 * `remaining` is persisted, not recomputed: the budget is a safety ceiling, and
 * a restart must not hand a spent channel a fresh one. `null` means unlimited
 * and is preserved as `null` rather than turned into a number.
 *
 * `openRequests` is persisted ONLY for a `once` channel. There it is what lets
 * the single exchange's ANSWER ride the same approval, and it is what the
 * "mid-exchange" line names — one entry, bounded. On a `session` channel the map
 * grows with every request and is read only once the budget is already spent, so
 * persisting it would cost log space for a fact nothing acts on.
 *
 * @param channel - a store channel.
 * @returns the JSON payload to append.
 */
export function snapshotOf(channel) {
  const payload = {
    id: channel.id,
    a: channel.a,
    b: channel.b,
    tier: channel.tier,
    remaining: channel.remaining === null ? null : channel.remaining,
    createdBy: channel.createdBy,
    // Only a `once` channel needs its carried requests back: they are what let
    // the answer ride the same approval, and what the "mid-exchange" line
    // names. On a `session` channel this map grows with every request and is
    // read only when the budget is already spent, so persisting it would cost
    // log space for a fact nothing acts on.
    openRequests: channel.tier === 'once' ? [...channel.openRequests].map(([requestId, from]) => [requestId, from]) : [],
  }
  // Optional stamps are OMITTED rather than set to `undefined`: the Host
  // snapshots the payload and refuses anything it cannot round-trip losslessly,
  // and `undefined` cannot. A log written that way would silently stop accepting
  // grants, which is the one failure this feature must not have.
  const createdAt = stampOf(channel.createdAt)
  if (createdAt !== undefined) payload.createdAt = createdAt
  const lastActivityAt = stampOf(channel.lastActivityAt)
  if (lastActivityAt !== undefined) payload.lastActivityAt = lastActivityAt
  return {
    v: GRANT_RECORD_VERSION,
    channel: payload,
  }
}

/**
 * The tombstone payload for one channel.
 * @param channel - the channel being revoked.
 * @returns the JSON payload to append.
 */
export function revokeDataOf(channel) {
  const payload = { v: GRANT_RECORD_VERSION, a: channel.a, b: channel.b }
  const channelId = idOf(channel.id)
  if (channelId !== undefined) payload.channelId = channelId
  return payload
}

/**
 * Append one channel snapshot to a session's log.
 * @param session - a live or detached `Session`.
 * @param channel - the channel as it stands now.
 * @returns the committed record's sequence number.
 * @throws whatever `appendPluginRecord` throws; callers must contain it, because
 *   a delivery that already happened must not fail over its audit trail.
 */
export function appendGrant(session, channel) {
  return sessionApi.appendPluginRecord(session, GRANT_RECORD, snapshotOf(channel))
}

/**
 * Append one tombstone to a session's log.
 * @param session - a live or detached `Session`.
 * @param channel - the channel being revoked.
 * @returns the committed record's sequence number.
 */
export function appendRevoke(session, channel) {
  return sessionApi.appendPluginRecord(session, REVOKE_RECORD, revokeDataOf(channel))
}

/**
 * Validate one GRANT payload into a store-shaped channel.
 *
 * Every field is checked here rather than at the point of use: a record may come
 * from an older build of this plugin, from a v3 event the format migration
 * renamed into the plugin namespace, or from a hand-edited log. A field this
 * build would misread makes the whole record unusable, which loses a channel —
 * better than adopting an id, a tier, or a budget the human never approved.
 *
 * @param data - the record's `data`, of unknown shape.
 * @returns a channel object with a `Map` of open requests, or undefined.
 */
export function channelOf(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  if (data.v !== GRANT_RECORD_VERSION) return undefined
  const raw = data.channel
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined

  const id = idOf(raw.id)
  const a = idOf(raw.a)
  const b = idOf(raw.b)
  if (id === undefined || a === undefined || b === undefined || a === b) return undefined
  if (!TIERS.has(raw.tier)) return undefined
  const remaining =
    raw.remaining === null
      ? null
      : typeof raw.remaining === 'number' && Number.isInteger(raw.remaining) && raw.remaining >= 0
        ? raw.remaining
        : undefined
  if (remaining === undefined) return undefined

  const openRequests = new Map()
  if (Array.isArray(raw.openRequests)) {
    for (const entry of raw.openRequests) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const requestId = idOf(entry[0])
      const from = idOf(entry[1])
      if (requestId !== undefined && from !== undefined) openRequests.set(requestId, from)
    }
  }

  return {
    id,
    a,
    b,
    tier: raw.tier,
    remaining,
    createdAt: stampOf(raw.createdAt) ?? Date.now(),
    createdBy: idOf(raw.createdBy) ?? a,
    lastActivityAt: stampOf(raw.lastActivityAt) ?? stampOf(raw.createdAt) ?? Date.now(),
    rateWindowStart: undefined,
    rateCount: 0,
    openRequests,
  }
}

/**
 * Validate one REVOKE payload into the pair it voids.
 * @param data - the record's `data`, of unknown shape.
 * @returns the two session ids, or undefined.
 */
export function pairOf(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  if (data.v !== GRANT_RECORD_VERSION) return undefined
  const a = idOf(data.a)
  const b = idOf(data.b)
  if (a === undefined || b === undefined || a === b) return undefined
  return { a, b, channelId: idOf(data.channelId) }
}

/**
 * The event list of a live `Session` or of a `SessionInspection`.
 *
 * Both shapes reach the fold: the live Session exposes `.log`, and the
 * cold-safe `sessionController.inspect()` result exposes `.events`. A container
 * with neither is treated as empty rather than throwing, because the caller has
 * already decided that a missing log means "nothing to replay".
 * @param container - a Session, an inspection, or anything else.
 * @returns the event array, or an empty one.
 */
function eventsOf(container) {
  if (container === null || typeof container !== 'object') return []
  if (Array.isArray(container.log)) return container.log
  if (Array.isArray(container.events)) return container.events
  return []
}

/**
 * Fold one session's log into replay operations, in log order.
 *
 * Replay operations are returned instead of a finished map because applying them
 * must not delete a channel that simply has no record yet (a delivery can create
 * a channel and fail to persist it; re-hydrating later must not remove what is
 * still in use in this process). Only an explicit tombstone deletes.
 *
 * Each operation carries the RECORD's `time`, not the channel's creation time:
 * comparing a tombstone from the other end's log against a grant requires the
 * moment each was WRITTEN, and those are what decide which one is newer.
 *
 * @param session - a `Session`, live or restored.
 * @returns `{kind:'upsert', channel, at}` and `{kind:'revoke', pair, at}` operations.
 */
export function replayOf(session) {
  if (!durabilityAvailable) return []
  const events = eventsOf(session)
  const ops = []
  for (const event of events) {
    let record
    try {
      record = sessionApi.pluginRecordOf(event)
    } catch {
      // A reader that cannot even name the record treats it as absent.
      continue
    }
    if (record === undefined) continue
    const at = stampOf(record.time) ?? 0
    if (record.type === GRANT_RECORD) {
      const channel = channelOf(record.data)
      if (channel !== undefined) ops.push({ kind: 'upsert', channel, at })
    } else if (record.type === REVOKE_RECORD) {
      const pair = pairOf(record.data)
      if (pair !== undefined) ops.push({ kind: 'revoke', pair, at })
    }
  }
  return ops
}

/**
 * The latest tombstone time for one pair in a log, or undefined.
 *
 * Used to answer "did the other end revoke this channel after I granted it?" —
 * the one question a single log cannot answer by itself. A log with no grant
 * record for the pair (the common case for a peer that never granted anything)
 * still contributes its tombstones.
 *
 * @param session - a `Session`, live or restored.
 * @param a - one end of the pair.
 * @param b - the other end.
 * @returns the newest tombstone's record time, or undefined.
 */
export function revokeTimeIn(session, a, b) {
  if (!durabilityAvailable) return undefined
  const events = eventsOf(session)
  let newest
  for (const event of events) {
    let record
    try {
      record = sessionApi.pluginRecordOf(event)
    } catch {
      continue
    }
    if (record === undefined || record.type !== REVOKE_RECORD) continue
    const pair = pairOf(record.data)
    if (pair === undefined) continue
    if (pairKey(pair.a, pair.b) !== pairKey(a, b)) continue
    const at = stampOf(record.time) ?? 0
    if (newest === undefined || at > newest) newest = at
  }
  return newest
}
