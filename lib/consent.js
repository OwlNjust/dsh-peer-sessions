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
 * Turn whatever `ask()` rejected with into a reason that can be acted on.
 *
 * The failure that made this necessary: the browser rejects an unnamed card with
 * the BARE STRING `"ASK_CANCELLED"`, a Remote hop cannot restore it into a
 * `UserQuestionError` (that requires `{ name, message, code }`), and this code
 * looked only at `error?.code` — so the one word that identified the cause was
 * discarded and the report said `ask-failed`. Whatever is thrown now contributes
 * its code, or its name and message, or its own text, bounded.
 *
 * @param error - the rejection value, of unknown shape.
 * @returns a discriminated consent answer.
 */
function askFailure(error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : undefined
  if (code !== undefined) {
    // ASK_ABORTED means the turn's signal was aborted — the human is done here.
    if (code === 'ASK_ABORTED') return { outcome: 'declined', reason: 'canceled' }
    return { outcome: 'unavailable', reason: code }
  }
  // A bare string: `ASK_CANCELLED` arrives this way. It is deliberately NOT
  // reported as a refusal — a cancellation we cannot attribute to a human choice
  // must not tell the model "do not retry".
  if (typeof error === 'string' && error !== '') return { outcome: 'unavailable', reason: error.slice(0, 120) }
  const name = typeof error?.name === 'string' && error.name !== '' ? error.name : undefined
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : undefined
  if (name !== undefined && message !== undefined) {
    return { outcome: 'unavailable', reason: `${name}: ${message}`.slice(0, 200) }
  }
  if (message !== undefined) return { outcome: 'unavailable', reason: message.slice(0, 200) }
  if (name !== undefined) return { outcome: 'unavailable', reason: name }
  return { outcome: 'unavailable', reason: 'ask-failed' }
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
 * `waitCallId` is the CALLER's tool-call id, and passing it is what makes the card
 * a first-class one on the client. An unnamed card is `dismissal: 'cancel'`: when
 * it loses the editor seat the client cancels the whole request, and the
 * rejection crosses the Remote boundary as a bare string, so it cannot be
 * restored into a coded error (measured on the desktop build, 2026-09-30 — see
 * MAINTENANCE.md 坑 17). A named card is `dismissal: 'hide'`: it survives being
 * closed and is reachable again from its tool-call row. The official
 * `ask_user_question` tool always sends it; commands have no call id, which is
 * the one case that still asks anonymously.
 *
 * @param ctx - host context.
 * @param args - the asking agent, the peer's label, whether approving would also
 *   wake a cold peer, the translator, cancellation, and the calling tool's id
 *   when the question is raised by a tool call.
 * @returns `{ outcome: 'granted', tier }`, `{ outcome: 'declined', reason }`, or
 *   `{ outcome: 'unavailable', reason }` — never a bare tier.
 */
export async function askGrant(ctx, { agent, peerLabel, signal, t, willWake = false, waitCallId }) {
  // Not the live runtime root: there is no human answerer on this path at all,
  // so this is "unavailable", not "the human said no". The callers refuse such a
  // caller before getting here, which is why this is a backstop.
  if (!isRuntimeRoot(ctx, agent)) return { outcome: 'unavailable', reason: 'not-runtime-root' }

  const onceLabel = t('consent.grant.once')
  const sessionLabel = t('consent.grant.session')
  const declineLabel = t('consent.grant.decline')

  // No standing description paragraph, and no `detail` field: the question names
  // the peer and the three options carry the tiers. The ONE fact that must not
  // hide is the wake — approving a cold peer spends tokens in another
  // conversation — so it rides the QUESTION, which is the field every ask surface
  // certainly renders. The official tool never sends `detail` (the Host pairs it
  // with plan-review intent), so not sending it is one fewer shape difference
  // between this request and the one that is known to work.
  const question = willWake
    ? `${t('consent.grant.question', { peer: peerLabel })} ${t('consent.grant.wakeNote', { peer: peerLabel })}`
    : t('consent.grant.question', { peer: peerLabel })

  let answer
  try {
    answer = await ctx.userQuestions.ask({
      agent,
      signal,
      questions: [
        {
          id: 'grant',
          header: t('consent.grant.header'),
          question,
          options: [
            { label: onceLabel, description: t('consent.grant.onceDesc') },
            { label: sessionLabel, description: t('consent.grant.sessionDesc') },
            { label: declineLabel, description: t('consent.grant.declineDesc') },
          ],
        },
      ],
      // Named after the tool call that raised it, exactly as the official ask tool
      // does, so the card is `dismissal: 'hide'` rather than `'cancel'`.
      ...(typeof waitCallId === 'string' && waitCallId !== '' ? { wait: { callId: waitCallId } } : {}),
    })
  } catch (error) {
    return askFailure(error)
  }

  const selected = answer?.answers?.find((item) => item.id === 'grant')?.selected ?? []
  if (selected.includes(onceLabel)) return { outcome: 'granted', tier: 'once' }
  if (selected.includes(sessionLabel)) return { outcome: 'granted', tier: 'session' }
  // The card closed with the decline option chosen, or with nothing selected.
  return { outcome: 'declined', reason: 'declined' }
}
