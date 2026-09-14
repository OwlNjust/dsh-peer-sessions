/**
 * Consent — invariant H3 (authorization never passes through the model).
 *
 * The plugin asks the human directly through `ctx.userQuestions`, the same
 * service that backs the `ask_user_question` tool but reached as a service
 * rather than as a tool. The answer comes back to this code; the model neither
 * sees it nor relays it, so it cannot claim a longer grant than the human chose.
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
 * @param ctx - host context.
 * @param args - the asking agent, the peer's label, the asking session's label,
 *   the translator, and cancellation.
 * @returns `'once'`, `'session'`, or `null` when declined, cancelled, or unanswerable.
 */
export async function askGrant(ctx, { agent, peerLabel, selfLabel, signal, t }) {
  if (!isRuntimeRoot(ctx, agent)) return null

  const onceLabel = t('consent.grant.once')
  const sessionLabel = t('consent.grant.session')
  const declineLabel = t('consent.grant.decline')

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
          detail: t('consent.grant.detail'),
          options: [
            { label: onceLabel, description: t('consent.grant.onceDesc') },
            { label: sessionLabel, description: t('consent.grant.sessionDesc', { self: selfLabel }) },
            { label: declineLabel, description: t('consent.grant.declineDesc') },
          ],
        },
      ],
    })
  } catch {
    // Aborted, no answerer composed, or the surface failed. Fail closed.
    return null
  }

  const selected = answer?.answers?.find((item) => item.id === 'grant')?.selected ?? []
  if (selected.includes(onceLabel)) return 'once'
  if (selected.includes(sessionLabel)) return 'session'
  return null
}

/**
 * Ask the human whether a cold peer may be woken to receive one message.
 *
 * Waking a conversation starts a real agent run and spends tokens, so it never
 * happens implicitly.
 *
 * @param ctx - host context.
 * @param args - the asking agent, the peer's label, the translator, and cancellation.
 * @returns whether the human approved the wake.
 */
export async function askWake(ctx, { agent, peerLabel, signal, t }) {
  if (!isRuntimeRoot(ctx, agent)) return false

  const yesLabel = t('consent.wake.yes')

  let answer
  try {
    answer = await ctx.userQuestions.ask({
      agent,
      signal,
      questions: [
        {
          id: 'wake',
          header: t('consent.wake.header'),
          question: t('consent.wake.question', { peer: peerLabel }),
          detail: t('consent.wake.detail'),
          options: [
            { label: yesLabel, description: t('consent.wake.yesDesc') },
            { label: t('consent.wake.no'), description: t('consent.wake.noDesc') },
          ],
        },
      ],
    })
  } catch {
    return false
  }

  const selected = answer?.answers?.find((item) => item.id === 'wake')?.selected ?? []
  return selected.includes(yesLabel)
}
