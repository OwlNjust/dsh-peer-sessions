/**
 * Consent — invariant H3 (authorization never passes through the model).
 *
 * The plugin asks the human directly through `ctx.userQuestions`, the same
 * service that backs the `ask_user_question` tool but reached as a service
 * rather than as a tool. The answer comes back to this code; the model neither
 * sees it nor relays it, so it cannot claim a longer grant than the human chose.
 *
 * ONE card covers the whole decision. A cold peer used to raise a second prompt
 * after the grant ("wake it and deliver?"), which turned out to be friction
 * against a deployment fact: idle conversations are cold, so nearly every send
 * raised two cards. The grant now states the wake as part of its cost, and a
 * channel's approval covers waking its peer for that channel's life. Revoking
 * the channel is the off switch.
 *
 * Contract constraint that shapes every call here: a user question is valid
 * only for the exact live runtime ROOT. An owned child has no human answerer
 * and would block forever. Every entry point therefore checks
 * {@link isRuntimeRoot} first and fails closed, never prompting.
 *
 * Option labels are read from the same translator that builds the question, and
 * matched back by identity of value. They are never hard-coded here, because a
 * localized label that did not match would silently turn a grant into a decline.
 *
 * @module dsh-peer-sessions/consent
 */

/**
 * Whether this agent is the exact live runtime root, and so has a human
 * answerer on the other end of a user question.
 *
 * Runtime ownership — not durable session lineage — decides this. A session
 * bearing lineage that was resumed as a new root may ask normally; a live child
 * owned by another agent may not.
 *
 * @param ctx - host context carrying `agents`.
 * @param agent - the agent that would be asking.
 * @returns whether asking is safe.
 */
export function isRuntimeRoot(ctx, agent) {
  if (agent === undefined || agent === null) return false
  if (ctx.agents.get(agent.id) !== agent) return false
  return ctx.agents.roots().some((root) => root.id === agent.id)
}

/**
 * Ask the human whether a channel may be opened, and at which tier.
 *
 * The answer is a discriminated value, NOT a nullable tier. Three different
 * things used to collapse into `null` — the human picked "decline", the request
 * was aborted, and there was no answerer to ask at all — and every one of them
 * was reported to the model as "The user declined the channel". That reads as a
 * decision the human made, so the model is told not to retry; when the real cause
 * was a panel that failed to compose, a retryable transient was described as a
 * refusal. Fail-closed stays (nothing is ever delivered), but the reason travels.
 *
 * @param ctx - host context.
 * @param args - the asking agent, the peer's label, the asking session's label,
 *   whether approving would also wake a cold peer, the translator, and cancellation.
 * @returns `{ outcome: 'granted', tier }`, `{ outcome: 'declined', reason }`, or
 *   `{ outcome: 'unavailable', reason }` — never a bare tier.
 */
export async function askGrant(ctx, { agent, peerLabel, selfLabel, signal, t, willWake = false }) {
  // Not the live runtime root: there is no human answerer on this path at all,
  // so this is "unavailable", not "the human said no". The callers refuse such a
  // caller before getting here, which is why this is a backstop.
  if (!isRuntimeRoot(ctx, agent)) return { outcome: 'unavailable', reason: 'not-runtime-root' }

  const onceLabel = t('consent.grant.once')
  const sessionLabel = t('consent.grant.session')
  const declineLabel = t('consent.grant.decline')

  // The wake is stated in the question the human actually reads, so approving
  // never hides a side effect behind a second prompt.
  const detail = willWake
    ? `${t('consent.grant.detail')}\n\n${t('consent.grant.wakeNote', { peer: peerLabel })}`
    : t('consent.grant.detail')

  let answer
  try {
    answer = await ctx.userQuestions.ask({
      agent,
      signal,
      questions: [
        {
          id: 'grant',
          header: t('consent.grant.header'),
          question: t('consent.grant.question', { peer: peerLabel }),
          detail,
          options: [
            { label: onceLabel, description: t('consent.grant.onceDesc') },
            { label: sessionLabel, description: t('consent.grant.sessionDesc', { self: selfLabel }) },
            { label: declineLabel, description: t('consent.grant.declineDesc') },
          ],
        },
      ],
    })
  } catch (error) {
    // Fail closed, but keep WHY. The codes are stable (dsh-user-questions):
    // ASK_ABORTED means the human closed the card or the turn was cancelled —
    // that IS a refusal of this delivery. Anything else (CALLER_NOT_LIVE,
    // DELEGATED_CALLER, a surface that threw) means the question never reached a
    // human, so it must not be reported as their decision.
    const code = error?.code
    if (code === 'ASK_ABORTED') return { outcome: 'declined', reason: 'canceled' }
    return { outcome: 'unavailable', reason: typeof code === 'string' ? code : 'ask-failed' }
  }

  const selected = answer?.answers?.find((item) => item.id === 'grant')?.selected ?? []
  if (selected.includes(onceLabel)) return { outcome: 'granted', tier: 'once' }
  if (selected.includes(sessionLabel)) return { outcome: 'granted', tier: 'session' }
  // The card closed with the decline option chosen, or with nothing selected.
  return { outcome: 'declined', reason: 'declined' }
}
