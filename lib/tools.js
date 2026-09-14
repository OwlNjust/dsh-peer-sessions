/**
 * The four model-facing tools.
 *
 * These are the agent's half of the plugin — the human's half is the commands.
 * `peer_send` is what makes an automatic hand-off possible, which a command
 * cannot do because a command only ever fires when a human types it.
 *
 * Every tool fails closed. `exec.agent` is optional by contract (nested
 * dispatches omit it), and a caller that is not the exact live runtime root has
 * no human answerer behind it, so neither may ever reach a consent prompt.
 *
 * @module dsh-peer-sessions/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { PeerRefusal } from './core.js'
import { isRuntimeRoot } from './consent.js'
import { readMarker, stateLabel } from './store.js'

const KINDS = ['notice', 'request', 'reply', 'message']

/** One plain-text output for every tool here. */
const textOutput = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: value }]
  },
}

/** Turn any thrown value into one readable line. */
function messageOf(error) {
  if (error instanceof PeerRefusal) return error.message
  return error instanceof Error ? error.message : String(error)
}

/** Shared guard: only a live runtime root may act, and it says so in words. */
function callerGuard(core, exec) {
  const agent = exec.agent
  if (agent === undefined) {
    return { refused: 'Refused: this call has no calling conversation, so there is nobody to authorize a peer channel.' }
  }
  if (!isRuntimeRoot(core.ctx, agent)) {
    return {
      refused:
        'Refused: only a top-level conversation can hold a peer channel. A delegated subagent has no human ' +
        'answerer, so no consent could be obtained and nothing was sent.',
    }
  }
  return { agent }
}

/**
 * Register every tool.
 * @param ctx - the plugin's host context (its `tools` registry).
 * @param core - the peer core.
 */
export function registerTools(ctx, core) {
  ctx.tools.register(
    defineTool({
      name: 'peer_send',
      description:
        'Send a message to another conversation the user is running, at the same level as this one. ' +
        'Use it to hand off, notify, ask, or answer a peer. If no channel is open yet, the user is asked ' +
        'first and nothing is sent without their consent. The peer receives this as another agent speaking, ' +
        'never as a user instruction. Delivery is idle-first: a peer that is mid-turn gets it when it finishes.',
      parameters: {
        peer: {
          type: 'string',
          required: true,
          description: 'Peer conversation title, or its session id when the title is ambiguous.',
        },
        kind: {
          type: 'string',
          required: true,
          enum: KINDS,
          description: 'notice (inform) · request (needs an answer) · reply (answers a request) · message (plain).',
        },
        summary: {
          type: 'string',
          required: true,
          description: 'One self-contained line the peer can act on without asking anything back.',
        },
        body: { type: 'string', description: 'Optional detail below the summary.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute paths the peer should read itself. Never paste file contents: the peer can read any file on this machine.',
        },
        replyTo: { type: 'string', description: 'For kind=reply: the request id being answered.' },
        replyWithin: { type: 'string', description: 'For kind=request: how long the answer may take, e.g. "4h".' },
        silent: {
          type: 'boolean',
          description: 'Deliver as context without waking the peer. Use only for background information.',
        },
      },
      output: textOutput,
      async execute(args, exec) {
        const guard = callerGuard(core, exec)
        if (guard.refused !== undefined) return guard.refused
        const agent = guard.agent
        try {
          const peer = await core.resolveOrRefuse(args.peer, agent.id, exec.signal)
          const selfLabel = await core.labelOf(agent.id, exec.signal)
          const requestId = args.kind === 'request' ? core.nextRequestId() : undefined
          const result = await core.deliver({
            selfAgent: agent,
            selfLabel,
            peerEntry: peer,
            silent: args.silent === true,
            signal: exec.signal,
            payload: {
              kind: args.kind,
              summary: args.summary,
              body: args.body,
              paths: args.paths,
              replyTo: args.replyTo,
              replyWithin: args.replyWithin,
              requestId,
            },
          })

          if (result.outcome === 'declined') {
            return `The user declined the channel with "${peer.label}". Nothing was sent, and nothing is pending. Do not retry in this turn.`
          }
          if (result.outcome === 'target-not-running') {
            return `"${peer.label}" could not be resumed, so nothing was sent. Mention it once, then move on.`
          }
          if (result.outcome === 'silent-needs-running') {
            return `"${peer.label}" is not running. A silent delivery adds context without opening a turn, so it cannot be delivered to a cold conversation. Retry without silent, or drop the message.`
          }

          // The request being answered belongs to the OTHER end of the channel
          // (measured: the caller's own inbox holds what it received, never the
          // request it is answering), so the channel is what names the inbox.
          if (args.kind === 'reply' && args.replyTo !== undefined) {
            core.noteReply(agent.id, args.replyTo, result.channel)
          }

          // Sender-side audit: a durable, replayable record in this conversation.
          // The receiving conversation keeps the message itself, so both logs hold one.
          exec.deferContext(core.deliveryNotice(result))

          const queueNote = result.silent
            ? 'Delivered as silent context (the peer was not woken).'
            : 'Queued. A busy peer receives it when its current turn finishes.'
          return [
            `Delivered a ${args.kind} to "${peer.label}".`,
            `  channel:    ${result.channel.id} (tier=${result.channel.tier}, remaining=${result.channel.remaining ?? 'unlimited'})`,
            `  message id: ${result.item.id}`,
            requestId === undefined ? undefined : `  request id: ${requestId}`,
            `  ${queueNote}`,
          ]
            .filter((line) => line !== undefined)
            .join('\n')
        } catch (error) {
          return messageOf(error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'peer_inbox',
      description:
        'Read messages other conversations have sent to this one: unread items, requests still awaiting an answer, ' +
        'and requests whose deadline has passed. Without an id it lists one summary line per item; with an id it ' +
        'returns that message\'s full delivered text, which stays readable after the original relay message has ' +
        'left this conversation\'s context.',
      parameters: {
        id: {
          type: 'string',
          description:
            'Optional message id from a previous listing or from peer_send. Returns that message\'s complete text.',
        },
      },
      output: textOutput,
      async execute(args, exec) {
        const guard = callerGuard(core, exec)
        if (guard.refused !== undefined) return guard.refused
        const selfId = guard.agent.id

        // Retrieval by id: the inbox indexes the text that actually crossed the
        // channel, so a message stays readable once it is no longer in context.
        if (typeof args.id === 'string' && args.id !== '') {
          const item = core.store.findInboxItem(selfId, args.id)
          if (item === undefined) {
            const known = core.store.inboxFor(selfId).map((entry) => entry.id)
            const hint =
              known.length === 0
                ? 'The inbox is empty.'
                : `Known ids, newest first: ${known.join(', ')}.`
            return `No inbox message with id "${args.id}". ${hint}`
          }
          // Fetching the body is what counts as reading it; listing a summary is
          // not. Marked before the header is rendered, so the header can report
          // the state the fetch leaves behind.
          core.store.markRead(selfId, item.id)
          return [
            `Message ${item.id} · ${item.kind} from "${item.fromLabel}" (${item.from}) · channel ${item.channelId}`,
            `Delivered ${new Date(item.deliveredAt).toISOString()} · state: ${stateLabel(item.status)}` +
              (item.requestId === undefined ? '' : ` · request: ${item.requestId}`) +
              (item.replyTo === undefined ? '' : ` · in reply to: ${item.replyTo}`),
            '',
            item.text,
          ].join('\n')
        }

        const items = core.store.inboxFor(selfId)
        if (items.length === 0) return 'Peer inbox is empty.'
        const lines = [`Peer inbox (${items.length}${items.length === 1 ? ' item' : ' items'}, newest first):`]
        for (const item of items) {
          const age = Math.round((Date.now() - item.deliveredAt) / 60000)
          const replyTo = item.replyTo === undefined ? '' : ` · replyTo: ${item.replyTo}`
          const marker = readMarker(item.status)
          lines.push(
            `- ${marker === '' ? '' : `[${marker}] `}${item.kind} from "${item.fromLabel}" (${item.from}) · ${age} min ago`,
            `  id: ${item.id}${item.requestId === undefined ? '' : ` · request: ${item.requestId}`}${replyTo}`,
            `  ${item.summary}`,
          )
        }
        lines.push('', 'Read one in full with peer_inbox(id: "<message id>").')
        return lines.join('\n')
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'peer_progress',
      description:
        'Read another conversation\'s projected progress: state, workspace, last activity, goal, todos, permissions. ' +
        'Summaries only — never its transcript, tool arguments, attachments, or file contents. Read-only: it never ' +
        'wakes a conversation that is not running.',
      parameters: {
        peer: { type: 'string', required: true, description: 'Peer conversation title, or its session id.' },
      },
      output: textOutput,
      async execute(args, exec) {
        const guard = callerGuard(core, exec)
        if (guard.refused !== undefined) return guard.refused
        try {
          const peer = await core.resolveOrRefuse(args.peer, guard.agent.id, exec.signal)
          return core.progress(peer).join('\n')
        } catch (error) {
          return messageOf(error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'peer_list',
      description:
        'List this conversation\'s peer channels and what may be done on each, plus the conversations that are ' +
        'addressable right now. Only conversations visible in the user\'s sidebar appear.',
      parameters: {},
      output: textOutput,
      async execute(_args, exec) {
        const guard = callerGuard(core, exec)
        if (guard.refused !== undefined) return guard.refused
        const selfId = guard.agent.id
        const visible = await core.addressable(exec.signal)
        const byId = new Map(visible.map((entry) => [entry.sessionId, entry]))
        const channels = core.store.channelsFor(selfId)

        const lines = []
        if (channels.length === 0) {
          lines.push('No peer channels open. `peer_send` opens one, with the user\'s consent.')
        } else {
          lines.push(`Peer channels (${channels.length}):`)
          for (const channel of channels) {
            const peerId = core.peerIdOf(channel, selfId)
            const peer = byId.get(peerId)
            const state = peer === undefined ? 'NOT VISIBLE (archived?)' : peer.running ? 'running' : 'not running'
            lines.push(
              `- "${peer?.label ?? peerId}" · tier=${channel.tier} · remaining=${channel.remaining ?? 'unlimited'} · peer=${state}`,
            )
          }
        }
        lines.push('', `Addressable conversations (${visible.length}) — the sidebar set:`)
        for (const entry of visible) {
          const self = entry.sessionId === selfId ? ' (this conversation)' : ''
          lines.push(`- ${entry.label}${entry.running ? '' : ' (not running)'}${self} · ${entry.sessionId}`)
        }
        return lines.join('\n')
      },
    }),
  )
}
