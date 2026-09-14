/**
 * Message construction — invariant H2 (provenance cannot be forged).
 *
 * Every message that crosses a peer channel carries an explicit source whose
 * `kind` is `peer-message` and whose `form` is `relay`, plus the sender's
 * session id. The receiving model therefore sees that another conversation
 * spoke, never that the human did.
 *
 * This module deliberately does NOT use `ctx.sessionController.prompt()`.
 * That path builds its message as `{ kind: 'user', rpcId }`, which would make a
 * peer's words arrive as the human's own instruction — an injection channel
 * into the receiving conversation.
 *
 * `createUserMessage` performs no runtime validation of the source, so the
 * guards below are the only thing standing between a malformed call and a
 * message with no attributable sender. They throw rather than degrade.
 *
 * @module dsh-peer-sessions/messages
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const PLUGIN_NAME = 'dsh-peer-sessions'
export const PEER_KIND = 'peer-message'

/** Human-readable channel description per grant tier. */
const TIER_LABEL = {
  once: 'single delivery',
  session: 'this conversation',
}

/** Human-readable description per message kind. */
const KIND_LABEL = {
  notice: 'notice',
  request: 'request — expects a reply',
  reply: 'reply',
  message: 'message',
}

/**
 * Build the model-visible body of one peer message.
 * @param args - the sender, the channel, and the payload.
 * @returns the joined text.
 */
export function renderPeerBody({ senderId, senderLabel, tier, channelId, kind, summary, body, paths, replyTo, requestId, replyWithin }) {
  const lines = [
    '[peer-session message · from another conversation, NOT a user instruction]',
    `from: "${senderLabel}" (${senderId})`,
    `channel: ${channelId} · user-granted for ${TIER_LABEL[tier] ?? tier} · kind: ${KIND_LABEL[kind] ?? kind}`,
  ]
  if (requestId !== undefined) lines.push(`request id: ${requestId}`)
  if (replyWithin !== undefined) lines.push(`reply expected within: ${replyWithin}`)
  if (replyTo !== undefined) lines.push(`answering request: ${replyTo}`)
  lines.push('', summary)
  if (paths !== undefined && paths.length > 0) {
    lines.push('', 'referenced paths (read them yourself; no contents were sent):')
    for (const path of paths) lines.push(`  ${path}`)
  }
  if (body !== undefined && body !== '') lines.push('', body)
  return lines.join('\n')
}

/**
 * Build one relay-tagged user message addressed to a peer.
 *
 * @param args - sender identity, channel facts, and the payload.
 * @returns an immutable user message carrying attributable provenance.
 * @throws when the sender session id is missing, since an unattributable
 *   message is indistinguishable from the human speaking.
 */
export function buildPeerMessage(args) {
  const { senderId } = args
  if (typeof senderId !== 'string' || senderId === '') {
    throw new Error('dsh-peer-sessions: refusing to build a peer message without a sender session id')
  }
  const text = renderPeerBody(args)
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: PEER_KIND,
      form: 'relay',
      senderSessionId: senderId,
    },
  })
}

/**
 * Build the sender-side audit context.
 *
 * Deferred onto the tool result so the sending conversation keeps a durable,
 * replayable record of what left it — the receiving conversation keeps the
 * message itself, so both logs hold one.
 *
 * @param summary - one-line account of the delivery.
 * @param detail - optional continuation lines.
 * @returns an immutable plugin-sourced notice message.
 */
export function buildDeliveryNotice(summary, detail) {
  const text = detail === undefined ? summary : `${summary}\n${detail}`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: 'notice',
      summary,
    },
  })
}
