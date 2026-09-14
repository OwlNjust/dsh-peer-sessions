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
 * @module dsh-peer-sessions/consent
 */

import { PLUGIN_NAME } from './messages.js'

/** Option labels. The answer echoes labels, so these are matched back verbatim. */
const GRANT_ONCE = 'Allow once'
const GRANT_SESSION = 'Allow for this conversation'
const GRANT_DECLINE = 'Decline'

const WAKE_YES = 'Wake it and deliver'
const WAKE_NO = 'Cancel'

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
 * @param args - the asking agent, the peer's label, the asking session's label, and cancellation.
 * @returns `'once'`, `'session'`, or `null` when declined, cancelled, or unanswerable.
 */
export async function askGrant(ctx, { agent, peerLabel, selfLabel, signal }) {
  if (!isRuntimeRoot(ctx, agent)) return null
  let answer
  try {
    answer = await ctx.userQuestions.ask({
      agent,
      signal,
      questions: [
        {
          id: 'grant',
          header: 'Peer session channel',
          question: `Allow a peer channel between this conversation and "${peerLabel}"?`,
          detail:
            'A peer channel lets the two conversations send each other messages and read each other\'s ' +
            'projected progress. It is symmetric: neither conversation outranks the other. Raw transcripts, ' +
            'tool arguments, attachments, and file contents are never exchanged.',
          options: [
            {
              label: GRANT_ONCE,
              description: 'One exchange — the message and its answer — then the channel is spent',
            },
            { label: GRANT_SESSION, description: `Valid for the rest of "${selfLabel}"; dies with it` },
            { label: GRANT_DECLINE, description: 'Nothing is sent and no channel is opened' },
          ],
        },
      ],
    })
  } catch {
    // Aborted, no answerer composed, or the surface failed. Fail closed.
    return null
  }
  const selected = answer?.answers?.find((item) => item.id === 'grant')?.selected ?? []
  if (selected.includes(GRANT_ONCE)) return 'once'
  if (selected.includes(GRANT_SESSION)) return 'session'
  return null
}

/**
 * Ask the human whether a cold peer may be woken to receive one message.
 *
 * Waking a conversation starts a real agent run and spends tokens, so it never
 * happens implicitly.
 *
 * @param ctx - host context.
 * @param args - the asking agent, the peer's label, and cancellation.
 * @returns whether the human approved the wake.
 */
export async function askWake(ctx, { agent, peerLabel, signal }) {
  if (!isRuntimeRoot(ctx, agent)) return false
  let answer
  try {
    answer = await ctx.userQuestions.ask({
      agent,
      signal,
      questions: [
        {
          id: 'wake',
          header: 'Peer is not running',
          question: `"${peerLabel}" is not running right now. Wake it and deliver this message?`,
          detail:
            'Waking it resumes that conversation and starts a new turn there, which costs tokens. ' +
            'Declining sends nothing.',
          options: [
            { label: WAKE_YES, description: 'Resume the conversation and deliver the message' },
            { label: WAKE_NO, description: 'Send nothing' },
          ],
        },
      ],
    })
  } catch {
    return false
  }
  const selected = answer?.answers?.find((item) => item.id === 'wake')?.selected ?? []
  return selected.includes(WAKE_YES)
}

export { GRANT_ONCE, GRANT_SESSION, GRANT_DECLINE }
