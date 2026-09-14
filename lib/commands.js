/**
 * The two user-typed commands.
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
 * Descriptions are fixed at registration time, so the caller re-registers when
 * the language changes — see the disposer {@link registerCommands} returns.
 *
 * @module dsh-peer-sessions/commands
 */

import { PeerRefusal } from './core.js'
import { stripInvisible, displayToken } from './addressable.js'

const TIERS = ['once', 'session']

/** Turn any thrown value into one readable line. */
function messageOf(error) {
  if (error instanceof PeerRefusal) return error.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * Split ` connect Some title session` into a title and an optional tier.
 * @param rawInput - the text following the command name.
 * @param allowTier - whether a trailing tier token is accepted.
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
  const t = core.t
  const channels = core.store.channelsFor(sessionId)
  if (channels.length === 0) return t('channel.none')
  const entries = await core.addressable(signal)
  const byId = new Map(entries.map((entry) => [entry.sessionId, entry]))
  const lines = [t('channel.header', { count: channels.length })]
  channels.forEach((channel, index) => {
    const peerId = core.peerIdOf(channel, sessionId)
    const peer = byId.get(peerId)
    const state =
      peer === undefined ? t('state.notVisible') : t(peer.running ? 'state.running' : 'state.notRunning')
    const remaining = channel.remaining === null ? '∞' : String(channel.remaining)
    lines.push(
      t('channel.line', {
        index: index + 1,
        label: peer?.label ?? peerId,
        tier: t(`tier.${channel.tier}`),
        remaining,
        state,
      }),
      `   ${peerId}`,
    )
  })
  lines.push('', t('channel.revokeHintLine'))
  return lines.join('\n')
}

/**
 * Register every command against an already-injected commands context.
 *
 * @param commands - the `commands` service.
 * @param core - the peer core, which carries the live translator.
 * @returns a disposer that unregisters all of them, so a language change can
 *   re-register with fresh descriptions.
 */
export function registerCommands(commands, core) {
  const t = core.t
  const disposers = []

  disposers.push(
    commands.register({
      name: 'peers',
      description: t('cmd.peers.desc'),
      handler: async ({ agent, signal }) => {
        try {
          return { kind: 'success', text: await renderChannels(core, agent.id, signal) }
        } catch (error) {
          return { kind: 'error', text: messageOf(error) }
        }
      },
    }),
  )

  disposers.push(
    commands.register({
      name: 'peer',
      description: t('cmd.peer.desc'),
      input: { hint: t('cmd.peer.hint') },
      handler: async ({ agent, rawInput, signal }) => {
        // Pasted text routinely carries zero-width characters that are neither
        // visible nor matched by `\s`, so strip them before parsing: without
        // this, a subcommand that looks correct fails to match and the error
        // names a token identical to what the human typed.
        const trimmed = stripInvisible(rawInput).trim()
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
              return { kind: 'error', text: t('usage.peer') }
            default:
              return { kind: 'error', text: t('peer.unknownSub', { sub: displayToken(sub) }) }
          }
        } catch (error) {
          return { kind: 'error', text: messageOf(error) }
        }
      },
    }),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** `/peer connect <title> [once|session]` */
async function connect(core, agent, tail, signal) {
  const t = core.t
  const { title, tier } = parseTarget(tail, true)
  if (title === '') return { kind: 'error', text: t('usage.connect') }
  const peer = await core.resolveOrRefuse(title, agent.id, signal)

  const existing = core.store.between(agent.id, peer.sessionId)
  if (existing !== undefined) {
    return {
      kind: 'success',
      text: t('connect.already', {
        label: peer.label,
        tier: t(`tier.${existing.tier}`),
        remaining: existing.remaining ?? '∞',
      }),
    }
  }

  let chosen = tier
  if (chosen === undefined) {
    const selfLabel = await core.labelOf(agent.id, signal)
    chosen = await core.askGrantFor(agent, peer.label, selfLabel, signal)
    if (chosen === null) return { kind: 'success', text: t('connect.declined', { label: peer.label }) }
  }

  const channel = core.store.open({ a: agent.id, b: peer.sessionId, tier: chosen, by: agent.id })
  return {
    kind: 'success',
    text: t('connect.ok', {
      label: peer.label,
      channel: channel.id,
      tier: t(`tier.${channel.tier}`),
      tierNote: t(channel.tier === 'once' ? 'connect.tierNoteOnOnce' : 'connect.tierNoteSession'),
      remaining: channel.remaining ?? '∞',
      peerState: t(peer.running ? 'state.running' : 'connect.peerCold'),
    }),
  }
}

/** `/peer revoke <title>` */
async function revoke(core, agent, tail, signal) {
  const t = core.t
  const { title } = parseTarget(tail, false)
  if (title === '') return { kind: 'error', text: t('usage.revoke') }
  const peer = await core.resolveOrRefuse(title, agent.id, signal)
  const channel = core.store.between(agent.id, peer.sessionId)
  if (channel === undefined) return { kind: 'error', text: t('revoke.none', { label: peer.label }) }
  core.store.revoke(channel)
  return { kind: 'success', text: t('revoke.done', { channel: channel.id, label: peer.label }) }
}

/** `/peer progress <title>` — read-only, never wakes the peer. */
async function progress(core, agent, tail, signal) {
  const { title } = parseTarget(tail, false)
  if (title === '') return { kind: 'error', text: core.t('usage.progress') }
  const peer = await core.resolveOrRefuse(title, agent.id, signal)
  return { kind: 'success', text: core.progress(peer).join('\n') }
}
