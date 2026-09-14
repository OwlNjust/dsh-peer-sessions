/**
 * The addressable set — invariant H1.
 *
 * An agent may only ever reach a conversation the human can see in the sidebar.
 * The sidebar's own visibility rule lives in `dsh-client-ui-workspace`
 * (`sessionVisible`):
 *
 *     origin !== 'subagent' && !archived.has(id) && (!blank || id === current)
 *
 * This module reproduces that rule host-side and additionally drops every blank
 * row, so the set it returns is a strict SUBSET of what the sidebar shows.
 * Excluding more can never violate the rule; excluding less would.
 *
 * `current` is client state the host does not have, which is the only reason we
 * drop blank rows wholesale rather than keeping the selected one — a blank row
 * is the provisional "New Session" placeholder, not a conversation.
 *
 * @module dsh-peer-sessions/addressable
 */

/** Why one session is out of reach. */
const REASONS = {
  subagent: 'it is a subagent session',
  archived: 'it is archived',
  blank: 'it is a blank placeholder, not a conversation',
  noCwd: 'it has no workspace directory, so it never appears in the sidebar',
}

/**
 * Classify one session summary against the sidebar rule.
 * @param summary - one `SessionSummary` from the session controller.
 * @param archived - the workspace registry's archived session id set.
 * @returns whether the session is addressable, and why not when it is not.
 */
export function classify(summary, archived) {
  if (summary.origin === 'subagent') return { addressable: false, reason: REASONS.subagent }
  if (archived.has(summary.sessionId)) return { addressable: false, reason: REASONS.archived }
  if (summary.blank === true) return { addressable: false, reason: REASONS.blank }
  return { addressable: true }
}

/**
 * Read one projection value as a plain object.
 *
 * `SessionProjectionValue` is `JsonValue`, so a projection can legitimately be
 * `null`, a string, or an array. Checking only for `undefined` before reading a
 * property crashes on the `null` case — which is exactly what a session whose
 * title projection is unset supplies.
 *
 * @param value - any projection value.
 * @returns the value as a record, or undefined for every other JSON shape.
 */
export function asRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value
}

/**
 * Resolve a session's human-facing title, live or cold.
 *
 * The list projection carries the title when it is cached; a live session can
 * always be asked directly. A cold session with neither yields `undefined`, and
 * the caller falls back to a derived label rather than inventing a name.
 *
 * @param ctx - host context carrying `sessions` and `sessionTitle`.
 * @param summary - one `SessionSummary`.
 * @returns the title, or undefined when none is known.
 */
/**
 * Read a title out of one projection value.
 *
 * The projection shape is not this plugin's to define, and the three forms
 * below are all reachable in practice:
 *
 *   - `null` — the projection exists but this session has no title yet. This is
 *     the form that crashed the first live run, because a value being present
 *     says nothing about it being an object.
 *   - `{ ver, seq, val }` — the cached projection record, with `val` holding the
 *     title text or `null`.
 *   - `{ title, source, ... }` — a `SessionTitleSnapshot`, the typed provider
 *     view.
 *
 * A bare string is accepted too. Anything else yields `undefined` so the caller
 * falls back rather than inventing a name.
 *
 * @param value - one projection value of unknown shape.
 * @returns the title text, or undefined.
 */
function readProjectedTitle(value) {
  if (typeof value === 'string') return value === '' ? undefined : value
  const record = asRecord(value)
  if (record === undefined) return undefined
  for (const key of ['title', 'val']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

export function titleOf(ctx, summary) {
  const projected = readProjectedTitle(summary.projections?.values?.title)
  if (projected !== undefined) return projected
  const live = ctx.sessions.get(summary.sessionId)
  if (live !== undefined) {
    // `foldSessionTitle` returns undefined when the log holds no title event;
    // the optional chain keeps this safe even if that ever changes to null.
    const snapshot = ctx.sessionTitle.get(live)
    if (snapshot?.title) return snapshot.title
  }
  return undefined
}

/**
 * Build the label a human would recognise for one session.
 * @param ctx - host context.
 * @param summary - one `SessionSummary`.
 * @returns the title, else the working directory's basename, else the raw id.
 */
export function labelOf(ctx, summary) {
  const title = titleOf(ctx, summary)
  if (title !== undefined) return title
  if (summary.cwd !== undefined) {
    const base = summary.cwd.split('/').filter((part) => part !== '').pop()
    if (base !== undefined) return base
  }
  return summary.sessionId
}

/**
 * Read the current addressable set.
 *
 * This is the ONLY list source the plugin may use. In particular it must not be
 * replaced by a corpus query (`sessionQuery.listSessions`), which returns every
 * persisted session including archived ones.
 *
 * The archive set is re-read on every call, so archiving a peer revokes
 * reachability with no listener and no cache to invalidate.
 *
 * @param ctx - host context.
 * @param signal - optional cancellation.
 * @returns addressable entries, enriched with `title` and `label`.
 */
export async function listAddressable(ctx, signal) {
  const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
  const { items } = await ctx.sessionController.list({}, signal)
  const out = []
  for (const summary of items) {
    if (!classify(summary, archived).addressable) continue
    out.push(enrich(ctx, summary))
  }
  return out
}

/**
 * Read the addressable set AND the rejection reason for every hidden session.
 * Used by the commands to explain a refusal instead of just failing.
 * @param ctx - host context.
 * @param signal - optional cancellation.
 * @returns `{ entries, hidden }`.
 */
export async function listWithHidden(ctx, signal) {
  const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
  const { items } = await ctx.sessionController.list({}, signal)
  const entries = []
  const hidden = []
  for (const summary of items) {
    const verdict = classify(summary, archived)
    if (verdict.addressable) entries.push(enrich(ctx, summary))
    else hidden.push({ sessionId: summary.sessionId, label: labelOf(ctx, summary), reason: verdict.reason })
  }
  return { entries, hidden }
}

/** Attach the derived presentation fields to one addressable summary. */
function enrich(ctx, summary) {
  const title = titleOf(ctx, summary)
  return {
    sessionId: summary.sessionId,
    title,
    label: labelOf(ctx, summary),
    running: summary.running === true,
    cwd: summary.cwd,
    updatedAt: summary.updatedAt,
    // Projection values are already JSON-safe wire data from the list cache.
    // Only read leaf fields from them; never treat this as a transcript.
    projections: summary.projections?.values ?? {},
  }
}

/**
 * Remove invisible formatting characters from user-supplied text.
 *
 * Text pasted out of a PDF, a web page, or a chat client routinely carries
 * zero-width spaces, word joiners, and bidi controls. They are invisible, they
 * are not matched by `\s`, and they survive `trim()` — so a value that looks
 * correct to the human fails to compare equal, and the resulting error names a
 * token that appears identical to what they typed. Observed live: a pasted
 * `/peer connect …` reported `unknown subcommand "connect"` while listing
 * `connect` as available.
 *
 * @param text - any user- or model-supplied string.
 * @returns the text with zero-width and bidi-control characters removed.
 */
export function stripInvisible(text) {
  return String(text ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
}

/**
 * Render a token for an error message, escaping it when it is not plain ASCII.
 *
 * A wrong subcommand is usually a typo, and showing it plainly is right. When it
 * contains anything a reader cannot see, the code points are the only honest way
 * to show what actually arrived.
 *
 * @param token - the offending token.
 * @returns the token, plus its code points when it is not plain ASCII letters.
 */
export function displayToken(token) {
  const text = String(token ?? '')
  if (/^[A-Za-z-]+$/.test(text)) return text
  const points = [...text]
    .map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ')
  return points === '' ? '(empty)' : `${text} [${points}]`
}

/**
 * Resolve a human-typed peer reference to exactly one addressable session.
 *
 * Never guesses: an ambiguous reference returns the candidates so the user can
 * pick, and an unknown one returns the whole set so they can see what exists.
 *
 * @param entries - the addressable set.
 * @param query - the title, label, or session id the user or model supplied.
 * @param selfId - the asking session's own id, which is never a valid peer.
 * @returns `{ kind: 'one', entry }`, `{ kind: 'many', candidates }`, or `{ kind: 'none', candidates }`.
 */
export function resolveTarget(entries, query, selfId) {
  const needle = stripInvisible(query).trim().toLowerCase()
  const others = entries.filter((entry) => entry.sessionId !== selfId)
  if (needle === '') return { kind: 'none', candidates: others }

  const byId = others.filter((entry) => entry.sessionId.toLowerCase() === needle)
  if (byId.length === 1) return { kind: 'one', entry: byId[0] }
  if (byId.length > 1) return { kind: 'many', candidates: byId }

  const exact = others.filter((entry) => entry.title !== undefined && entry.title.toLowerCase() === needle)
  if (exact.length === 1) return { kind: 'one', entry: exact[0] }
  if (exact.length > 1) return { kind: 'many', candidates: exact }

  const partial = others.filter((entry) => entry.title !== undefined && entry.title.toLowerCase().includes(needle))
  if (partial.length === 1) return { kind: 'one', entry: partial[0] }
  if (partial.length > 1) return { kind: 'many', candidates: partial }

  // Match the derived label too — a cold session often has no title yet, and the
  // label (the cwd basename) is what the user sees in that case.
  const byLabel = others.filter((entry) => entry.title === undefined && entry.label.toLowerCase().includes(needle))
  if (byLabel.length === 1) return { kind: 'one', entry: byLabel[0] }
  if (byLabel.length > 1) return { kind: 'many', candidates: byLabel }

  return { kind: 'none', candidates: others }
}
