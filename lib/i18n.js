/**
 * Localization for everything this plugin shows a human.
 *
 * The browser's language lives in the Host settings document, under the `locale`
 * namespace `dsh-client-locale` owns. Two facts shape this module:
 *
 *   - `locale.preference` is an EXPLICIT selection. Its absence "delegates to
 *     the browser", which means the Host has no way to learn the effective
 *     language — `navigator.language` never crosses to this side. So an unset or
 *     unrecognized preference falls back to {@link DEFAULT_LOCALE}.
 *   - `settings/updated` is an emit event any context can listen to, so the
 *     language is followed live rather than only at plugin load.
 *
 * What is localized here is what a human reads: the command palette descriptions
 * and the command answers. Model-facing tool descriptions and the peer-message
 * provenance header stay in English — they are the model's interface and a
 * machine-readable attribution label, not UI copy.
 *
 * @module dsh-peer-sessions/i18n
 */

/** Settings namespace owned by the locale plugin. */
export const LOCALE_NAMESPACE = 'locale'

/** Field carrying the explicit locale selection inside that namespace. */
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** Locales this plugin ships copy for. */
export const SUPPORTED_LOCALES = ['zh', 'en']

/**
 * Language used when the Host cannot know the client's choice.
 *
 * The fallback is Simplified Chinese by explicit instruction, because an unset
 * preference is indistinguishable from "the browser decided", and a guess would
 * be wrong as often as right.
 */
export const DEFAULT_LOCALE = 'zh'

/**
 * Map any BCP 47-ish tag onto a locale this plugin ships, or undefined.
 * @param raw - the raw preference value, of unknown type.
 * @returns `'zh'`, `'en'`, or undefined when it is neither.
 */
export function normalizeLocale(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  const tag = raw.toLowerCase()
  for (const locale of SUPPORTED_LOCALES) {
    if (tag === locale || tag.startsWith(`${locale}-`) || tag.startsWith(`${locale}_`)) return locale
  }
  return undefined
}

/**
 * Read the effective locale from the Host settings document.
 * @param ctx - host context; `settings` is read optionally so a deployment
 *   without a settings provider still works.
 * @param fallback - locale to use when nothing explicit is set.
 * @returns the locale this plugin should speak.
 */
export function resolveLocale(ctx, fallback = DEFAULT_LOCALE) {
  let section
  try {
    section = ctx.get('settings')?.get?.(LOCALE_NAMESPACE)
  } catch {
    // A settings provider that throws on read must not break the plugin; the
    // documented fallback is the safe answer.
    return fallback
  }
  if (section === null || typeof section !== 'object') return fallback
  return normalizeLocale(section[LOCALE_PREFERENCE_FIELD]) ?? fallback
}

const MESSAGES = {
  en: {
    'cmd.peers.desc': 'List peer channels: peer conversation, grant tier, remaining quota, visibility',
    'cmd.peer.desc': 'Peer channels: connect <title> [once|session] · revoke <title> · progress <title>',
    'cmd.peer.hint': 'connect <title> [once|session] | revoke <title> | progress <title>',

    'channel.none': 'No peer channels.\nOpen one with:  /peer connect <conversation title> [once|session]',
    'channel.header': 'Peer channels for this conversation ({count}):',
    'channel.line': '{index}. "{label}"  tier={tier}  remaining={remaining}  peer={state}',
    'channel.revokeHintLine': 'Revoke with:  /peer revoke <title>',
    'state.running': 'running',
    'state.notRunning': 'not running',
    'state.notVisible': 'NOT VISIBLE (archived?)',
    'tier.once': 'once',
    'tier.session': 'session',

    'usage.peer': [
      'Usage:',
      '  /peer connect <title> [once|session]   open a channel',
      '  /peer revoke <title>                   close a channel',
      "  /peer progress <title>                 read a peer's projected progress",
      '  /peers                                 list channels',
    ].join('\n'),
    'usage.connect': 'Usage: /peer connect <conversation title> [once|session]',
    'usage.revoke': 'Usage: /peer revoke <conversation title>',
    'usage.progress': 'Usage: /peer progress <conversation title>',
    'peer.unknownSub': 'Unknown subcommand "{sub}". Try connect, revoke, progress, or /peers.',

    'connect.already': 'Already connected to "{label}" — tier={tier}, remaining={remaining}.',
    'connect.declined': 'Declined. No channel was opened with "{label}".',
    'connect.ok': [
      'Channel open: "{label}" <-> this conversation',
      '  channel:   {channel}',
      '  tier:      {tier} ({tierNote})',
      '  remaining: {remaining}',
      '  peer:      {peerState}',
      '',
      'Nothing has been sent yet.',
    ].join('\n'),
    'connect.tierNoteOnOnce': 'one exchange',
    'connect.tierNoteSession': 'for this conversation',
    'connect.peerCold': 'not running — sending will wake it first',

    'revoke.none': 'No peer channel with "{label}". Run /peers to list the open ones.',
    'revoke.done': 'Channel {channel} with "{label}" revoked. Nothing further can be delivered on it.',

    'resolve.many': '"{query}" matches {count} conversations. Name one exactly:\n{lines}',
    'resolve.noneWithCandidates': 'No conversation matches "{query}". Visible conversations:\n{lines}',
    'resolve.noneAlone': 'There is no other visible conversation to address.',
    'resolve.hidden.archived':
      '"{label}" is archived, so it cannot be addressed. Unarchive it first, or pick another conversation.',
    'resolve.hidden.subagent': '"{label}" is a subagent session, not an addressable conversation.',
    'resolve.hidden.blank': '"{label}" is a blank placeholder row, not a conversation.',
    'resolve.moreCandidates': '\n…and {count} more. Name one by its session id.',
    'resolve.selfNotVisible':
      'This conversation is not visible in the sidebar (archived, blank, or a subagent), so it may not address anyone.',
    'resolve.peerNotVisible':
      'That conversation is no longer visible in the sidebar — it may have just been archived. Nothing was sent.',
    'budget.spent': 'This channel has reached its delivery budget. Revoke it and open a new one to continue.',

    'progress.conversation': 'conversation: "{label}"',
    'progress.sessionId': 'session id:   {sessionId}',
    'progress.state': 'state:        {state}',
    'progress.workspace': 'workspace:    {cwd}',
    'progress.lastActive': 'last active:  {iso}',
    'progress.projected': 'projected state (summaries only — no transcript, no file contents):',
    'progress.goal': '  goal: {objective}{phase}{rounds}',
    'progress.phase': ' [{phase}]',
    'progress.rounds': ' · round {rounds}',
    'progress.todos': '  todos: {done} of {total} complete{now}',
    'progress.todoNow': ' · now: {content}',
    'progress.permissions': '  permissions: {value}',
    'progress.queued': '  queued input: {turn} for the next turn, {step} for the next step',
    'progress.turns': '  turns so far: {count}',
    'progress.turn': '    turn {turn}: {prompt}{response}',
    'progress.turnNoPreview': '(no preview)',
    'progress.turnResponse': ' → {response}',
    'progress.other': '  other projections present: {keys}',

    'consent.grant.header': 'Peer session channel',
    'consent.grant.question': 'Allow a peer channel between this conversation and "{peer}"?',
    'consent.grant.detail':
      "A peer channel lets the two conversations send each other messages and read each other's projected " +
      'progress. It is symmetric: neither conversation outranks the other. Raw transcripts, tool arguments, ' +
      'attachments, and file contents are never exchanged.',
    'consent.grant.once': 'Allow once',
    'consent.grant.onceDesc': 'One exchange — the message and its answer — then the channel is spent',
    'consent.grant.session': 'Allow for this conversation',
    'consent.grant.sessionDesc': 'Valid for the rest of "{self}"; dies with it',
    'consent.grant.decline': 'Decline',
    'consent.grant.declineDesc': 'Nothing is sent and no channel is opened',
    'consent.grant.wakeNote':
      '"{peer}" is not running right now. Approving also wakes it, which starts a turn there and costs tokens.',

    'silent.needsRunning':
      'A silent delivery needs the peer running: it adds context without opening a turn, so waking it would ' +
      'contradict the request. Nothing was sent.',

    'rate.limited':
      'This pair has hit its rate limit ({limit} deliveries per {seconds}s). Nothing was sent. Wait, or batch ' +
      'several messages into one.',
    'hop.exceeded':
      'Refused: this message would be hop {hop} of a chain capped at {limit}. Peer messages may not relay onward ' +
      'indefinitely. Nothing was sent.',

    'timeout.header': 'Overdue: {count} request(s) you sent were never answered.',
    'timeout.line': '  {requestId} -> "{label}" (asked within {promised})',
    'timeout.note': '  Not resent, and not going to be. Tell the user, then either ask again or drop it.',
    'inbox.overdue': '[timed out] ',
  },

  zh: {
    'cmd.peers.desc': '列出平级通道：对端会话、授权档位、剩余额度、可见性',
    'cmd.peer.desc': '平级通道：connect <标题> [once|session] · revoke <标题> · progress <标题>',
    'cmd.peer.hint': 'connect <标题> [once|session] | revoke <标题> | progress <标题>',

    'channel.none': '当前没有平级通道。\n建立一条：  /peer connect <会话标题> [once|session]',
    'channel.header': '本对话的平级通道（{count} 条）：',
    'channel.line': '{index}. 「{label}」  档位={tier}  剩余={remaining}  对端={state}',
    'channel.revokeHintLine': '断开：  /peer revoke <标题>',
    'state.running': '运行中',
    'state.notRunning': '未运行',
    'state.notVisible': '不可见（已归档？）',
    'tier.once': '一次往来',
    'tier.session': '本对话内',

    'usage.peer': [
      '用法：',
      '  /peer connect <标题> [once|session]   建立通道',
      '  /peer revoke <标题>                   断开通道',
      '  /peer progress <标题>                 查看对端进度',
      '  /peers                                列出全部通道',
    ].join('\n'),
    'usage.connect': '用法：/peer connect <会话标题> [once|session]',
    'usage.revoke': '用法：/peer revoke <会话标题>',
    'usage.progress': '用法：/peer progress <会话标题>',
    'peer.unknownSub': '未知子命令「{sub}」。可用：connect、revoke、progress，或 /peers。',

    'connect.already': '已与「{label}」连接 —— 档位={tier}，剩余={remaining}。',
    'connect.declined': '已拒绝。没有与「{label}」建立任何通道。',
    'connect.ok': [
      '通道已建立：「{label}」 <-> 本对话',
      '  通道：  {channel}',
      '  档位：  {tier}（{tierNote}）',
      '  剩余：  {remaining}',
      '  对端：  {peerState}',
      '',
      '尚未发送任何内容。',
    ].join('\n'),
    'connect.tierNoteOnOnce': '一次往来',
    'connect.tierNoteSession': '本对话内有效',
    'connect.peerCold': '未运行 —— 发送时会先把它唤醒',

    'revoke.none': '没有与「{label}」的平级通道。用 /peers 查看已建立的通道。',
    'revoke.done': '通道 {channel}（与「{label}」）已断开，其上无法再投递任何内容。',

    'resolve.many': '「{query}」匹配到 {count} 个会话。请准确指定其中一个：\n{lines}',
    'resolve.noneWithCandidates': '没有会话匹配「{query}」。当前可见的会话：\n{lines}',
    'resolve.noneAlone': '没有其他可见会话可以作为对端。',
    'resolve.hidden.archived': '「{label}」已归档，因此不可寻址。先取消归档，或者换一个会话。',
    'resolve.hidden.subagent': '「{label}」是子代理会话，不是可寻址的对话。',
    'resolve.hidden.blank': '「{label}」是空白占位行，不是真实对话。',
    'resolve.moreCandidates': '\n……另有 {count} 个，可以用会话 ID 直接指定。',
    'resolve.selfNotVisible': '本对话在侧栏中不可见（已归档、空白占位、或子代理），因此不能向任何人发话。',
    'resolve.peerNotVisible': '该对话已不在侧栏中可见 —— 可能刚被归档。没有发送任何内容。',
    'budget.spent': '该通道的投递额度已用尽。断开后重新建立即可继续。',

    'progress.conversation': '会话：      「{label}」',
    'progress.sessionId': '会话 ID：   {sessionId}',
    'progress.state': '状态：      {state}',
    'progress.workspace': '工作目录：  {cwd}',
    'progress.lastActive': '最近活动：  {iso}',
    'progress.projected': '投影状态（只有摘要 —— 不含对话原文，不含文件内容）：',
    'progress.goal': '  目标：{objective}{phase}{rounds}',
    'progress.phase': ' [{phase}]',
    'progress.rounds': ' · 第 {rounds} 轮',
    'progress.todos': '  待办：{total} 项中完成 {done} 项{now}',
    'progress.todoNow': ' · 进行中：{content}',
    'progress.permissions': '  权限：{value}',
    'progress.queued': '  排队输入：下一回合 {turn} 条，下一步 {step} 条',
    'progress.turns': '  已有回合数：{count}',
    'progress.turn': '    第 {turn} 轮：{prompt}{response}',
    'progress.turnNoPreview': '（无预览）',
    'progress.turnResponse': ' → {response}',
    'progress.other': '  其他存在的投影：{keys}',

    'consent.grant.header': '平级会话通道',
    'consent.grant.question': '允许本对话与「{peer}」之间建立平级通道吗？',
    'consent.grant.detail':
      '平级通道让两个会话可以互发消息、互看对方的投影进度。它是**对等**的：谁也不比谁高一级。' +
      '原始对话记录、工具参数、附件与文件内容都不会被交换。',
    'consent.grant.once': '仅这一次',
    'consent.grant.onceDesc': '一次往来 —— 一条消息和它的回复 —— 然后通道作废',
    'consent.grant.session': '本对话内允许',
    'consent.grant.sessionDesc': '在「{self}」结束前一直有效，随它一起失效',
    'consent.grant.decline': '拒绝',
    'consent.grant.declineDesc': '不发送任何内容，也不建立通道',
    'consent.grant.wakeNote': '「{peer}」当前未运行。同意会同时把它唤醒，那会在那边开启一轮并消耗 token。',

    'rate.limited':
      '这一对会话已达速率上限（每 {seconds} 秒 {limit} 条）。没有发送任何内容。请稍等，或者把多条合并成一条。',
    'hop.exceeded':
      '已拒绝：这条消息会成为链条的第 {hop} 跳，而上限是 {limit} 跳。平级消息不允许无限接力转发。没有发送任何内容。',

    'timeout.header': '已超时：你发出的 {count} 条请求始终没有回复。',
    'timeout.line': '  {requestId} -> 「{label}」（约定的时间是 {promised}）',
    'timeout.note': '  不会重发，也不应该重发。把这件事告诉用户，然后要么重新问一次，要么放弃。',
    'inbox.overdue': '[已超时] ',

    'silent.needsRunning':
      '静默投递要求对端正在运行：它只添加上下文、不开启回合，所以唤醒它正好与这个要求矛盾。没有发送任何内容。',
  },
}

/**
 * Substitute `{name}` placeholders. A missing parameter is left verbatim rather
 * than replaced with "undefined", so a bug shows up as an obvious literal.
 * @param template - the catalog string.
 * @param params - substitution values.
 * @returns the rendered string.
 */
function fill(template, params) {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    const value = params[key]
    return value === undefined || value === null ? whole : String(value)
  })
}

/**
 * Build the translator for one locale.
 * @param locale - a supported locale; anything else falls back.
 * @param fallback - locale to fall back to.
 * @returns `(key, params?) => string`.
 */
export function translator(locale, fallback = DEFAULT_LOCALE) {
  const table = MESSAGES[locale] ?? MESSAGES[fallback]
  const backup = MESSAGES[fallback]
  return (key, params) => {
    const template = table[key] ?? backup[key]
    // A missing key returns the key itself: visible in a test, harmless in use.
    return template === undefined ? key : fill(template, params)
  }
}
