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
export function titleOf(ctx, summary) {
  const projected = summary.projections?.values?.title
  if (projected !== undefined && typeof projected.title === 'string' && projected.title !== '') {
    return projected.title
  }
  const live = ctx.sessions.get(summary.sessionId)
  if (live !== undefined) {
    const snapshot = ctx.sessionTitle.get(live)
    if (snapshot !== undefined && snapshot.title !== '') return snapshot.title
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
  const needle = String(query ?? '').trim().toLowerCase()
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

/**
 * Render one candidate line for a command result.
 * @param entry - one addressable entry.
 * @param index - zero-based position, rendered as 1-based.
 * @returns a single readable line.
 */
export function formatCandidate(entry, index) {
  const state = entry.running ? 'running' : 'not running'
  const where = entry.cwd === undefined ? '' : `  ${entry.cwd}`
  return `${index + 1}. ${entry.label}  [${state}]  ${entry.sessionId}${where}`
}
