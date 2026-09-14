/**
 * The four user-typed commands.
 *
 * Commands are the human's half of this plugin. Three properties come free from
 * the command registry and are load-bearing here:
 *
 *   - `CommandSourceMap` has exactly one variant, `user`, because every
 *     executor caller is a human-facing surface dispatching a human-typed line.
 *     A command therefore IS a human action, with no consent card required.
 *   - The handler runs against the receiving agent WITHOUT sending the command
 *     to the model, so managing channels costs no model turn.
 *   - Every invocation writes `command/run` and `command/done`, which is the
 *     audit trail for free.
 *
 * @module dsh-peer-sessions/commands
 */

import { PeerRefusal } from './core.js'
import { askGrant } from './consent.js'

const TIERS = ['once', 'session']

/** Turn any thrown value into one readable line. */
function messageOf(error) {
  if (error instanceof PeerRefusal) return error.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * Split ` connect Some title session` into a title and an optional tier.
 * @param rawInput - the text following the command name.
 * @returns the parsed parts.
 */
function parseTarget(rawInput, allowTier) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter((token) => token !== '')
  let tier
  if (allowTier && tokens.length > 1) {
    const last = tokens[tokens.length - 1].toLowerCase()
    if (TIERS.includes(last)) {
      tier = last
      tokens.pop()
    }
  }
  return { title: tokens.join(' '), tier }
}

/** Render the channel list for one session. */
async function renderChannels(core, sessionId, signal) {
  const channels = core.store.channelsFor(sessionId)
  if (channels.length === 0) {
    return 'No peer channels.\nOpen one with:  /peer connect <conversation title> [once|session]'
  }
  const entries = await core.addressable(signal)
  const byId = new Map(entries.map((entry) => [entry.sessionId, entry]))
  const lines = [`Peer channels for this conversation (${channels.length}):`]
  channels.forEach((channel, index) => {
    const peerId = core.peerIdOf(channel, sessionId)
    const peer = byId.get(peerId)
    const label = peer?.label ?? peerId
    const state = peer === undefined ? 'NOT VISIBLE (archived?)' : peer.running ? 'running' : 'not running'
    const remaining = channel.remaining === null ? 'unlimited' : String(channel.remaining)
    lines.push(
      `${index + 1}. "${label}"  tier=${channel.tier}  remaining=${remaining}  peer=${state}`,
      `   ${peerId}`,
    )
  })
  lines.push('', 'Revoke with:  /peer revoke <title>')
  return lines.join('\n')
}

/**
 * Register every command against an already-injected commands context.
 * @param commands - the `commands` service.
 * @param core - the peer core.
 */
export function registerCommands(commands, core) {
  commands.register({
    name: 'peers',
    description: 'List peer channels: peer conversation, grant tier, remaining quota, visibility',
    handler: async ({ agent, signal }) => {
      try {
        return { kind: 'success', text: await renderChannels(core, agent.id, signal) }
      } catch (error) {
        return { kind: 'error', text: messageOf(error) }
      }
    },
  })

  commands.register({
    name: 'peer',
    description: 'Peer channels: connect <title> [once|session] · revoke <title> · progress <title>',
    input: { hint: 'connect <title> [once|session] | revoke <title> | progress <title>' },
    handler: async ({ agent, rawInput, signal }) => {
      const trimmed = String(rawInput ?? '').trim()
      const [sub = '', ...rest] = trimmed.split(/\s+/)
      const tail = rest.join(' ')
      try {
        switch (sub.toLowerCase()) {
          case 'connect':
            return await connect(core, agent, tail, signal)
          case 'revoke':
            return await revoke(core, agent, tail, signal)
          case 'progress':
            return await progress(core, agent, tail, signal)
          case '':
            return {
              kind: 'error',
              text: [
                'Usage:',
                '  /peer connect <title> [once|session]   open a channel',
                '  /peer revoke <title>                   close a channel',
                '  /peer progress <title>                 read a peer\'s projected progress',
                '  /peers                                 list channels',
              ].join('\n'),
            }
          default:
            return { kind: 'error', text: `Unknown subcommand "${sub}". Try connect, revoke, progress, or /peers.` }
        }
      } catch (error) {
        return { kind: 'error', text: messageOf(error) }
      }
    },
  })
}

/** `/peer connect <title> [once|session]` */
async function connect(core, agent, tail, signal) {
  const { title, tier } = parseTarget(tail, true)
  if (title === '') return { kind: 'error', text: 'Usage: /peer connect <conversation title> [once|session]' }
  const peer = await core.resolveOrRefuse(title, agent.id, signal)

  const existing = core.store.between(agent.id, peer.sessionId)
  if (existing !== undefined) {
    return {
      kind: 'success',
      text: `Already connected to "${peer.label}" — tier=${existing.tier}, remaining=${existing.remaining ?? 'unlimited'}.`,
    }
  }

  let chosen = tier
  if (chosen === undefined) {
    const selfLabel = await labelFor(core, agent.id, signal)
    chosen = await askGrant(core.ctx, { agent, peerLabel: peer.label, selfLabel, signal })
    if (chosen === null) return { kind: 'success', text: `Declined. No channel was opened with "${peer.label}".` }
  }

  const channel = core.store.open({ a: agent.id, b: peer.sessionId, tier: chosen, by: agent.id })
  return {
    kind: 'success',
    text: [
      `Channel open: "${peer.label}" <-> this conversation`,
      `  channel:   ${channel.id}`,
      `  tier:      ${channel.tier} (${channel.tier === 'once' ? 'one delivery' : 'for this conversation'})`,
      `  remaining: ${channel.remaining ?? 'unlimited'}`,
      `  peer:      ${peer.running ? 'running' : 'not running — sending will ask before waking it'}`,
      '',
      'Nothing has been sent yet.',
    ].join('\n'),
  }
}

/** `/peer revoke <title>` */
async function revoke(core, agent, tail, signal) {
  const { title } = parseTarget(tail, false)
  if (title === '') return { kind: 'error', text: 'Usage: /peer revoke <conversation title>' }
  const peer = await core.resolveOrRefuse(title, agent.id, signal)
  const channel = core.store.between(agent.id, peer.sessionId)
  if (channel === undefined) {
    return { kind: 'error', text: `No peer channel with "${peer.label}". Run /peers to list the open ones.` }
  }
  core.store.revoke(channel)
  return {
    kind: 'success',
    text: `Channel ${channel.id} with "${peer.label}" revoked. Nothing further can be delivered on it.`,
  }
}

/** `/peer progress <title>` — read-only, never wakes the peer. */
async function progress(core, agent, tail, signal) {
  const { title } = parseTarget(tail, false)
  if (title === '') return { kind: 'error', text: 'Usage: /peer progress <conversation title>' }
  const peer = await core.resolveOrRefuse(title, agent.id, signal)
  return { kind: 'success', text: core.progress(peer).join('\n') }
}

/** The asking session's own label, for consent copy. */
async function labelFor(core, sessionId, signal) {
  const entries = await core.addressable(signal)
  return entries.find((entry) => entry.sessionId === sessionId)?.label ?? sessionId
}
