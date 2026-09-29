/**
 * dsh-peer-sessions — peer channels between conversations at the same level.
 *
 * Two conversations the user runs in parallel, neither outranking the other,
 * can send each other messages and read each other's projected progress. There
 * is no parent and no child; the existing `send_message`/`list_agents` pair is
 * built on parent-owns-child and is deliberately not reused.
 *
 * The full specification is `docs/design.md`. The four invariants that shape
 * every file here:
 *
 *   H1  The addressable set is the sidebar set (or smaller). An agent never
 *       reaches a conversation the human cannot see.        — addressable.js
 *   H2  A peer message is attributable and can never be forged into a user
 *       instruction. Never `sessionController.prompt()`.    — messages.js
 *   H3  Consent is taken from the human by this plugin directly, never relayed
 *       through the model.                                   — consent.js
 *   H4  A peer message escalates nothing.                    — core.js, tools.js
 *
 * One row in the host composition activates all of it: the commands and the
 * tools are registered globally, so every conversation gets them, and there is
 * no client half to build.
 *
 * @module dsh-peer-sessions
 */

import z from '@deepseek-ai/schemastery'

import { PeerCore, CORE_DEFAULTS } from './core.js'
import { PeerStore, STORE_DEFAULTS } from './store.js'
import { registerCommands } from './commands.js'
import { registerTools } from './tools.js'
import { resolveLocale, translator, LOCALE_NAMESPACE, DEFAULT_LOCALE } from './i18n.js'

/**
 * The channel store deliberately lives at module scope rather than inside
 * `apply()`.
 *
 * The loader re-applies a plugin when it notices the package's files change,
 * and it re-imports this same CACHED module to do so — the file is not
 * re-evaluated, but `apply()` runs again. A store created inside `apply()` is
 * therefore discarded on every re-apply, silently dropping every open channel
 * mid-collaboration. Observed live: a channel that had just carried a delivery
 * was gone on the next call, with no restart in between.
 *
 * Module scope fixes that while keeping the documented lifetime exactly: grants
 * still die with the process, and if a future loader ever did re-evaluate this
 * module, the store would simply be recreated — the old, safe behaviour.
 */
let sharedStore

/**
 * The resolved language, held at module scope for the same reason as the store:
 * a re-apply must not reset it. Read through {@link liveTranslator} so a change
 * made while the plugin is loaded is picked up by the next string.
 */
const i18n = { locale: DEFAULT_LOCALE }

/** Memoized translators, so each string does not rebuild one. */
const translators = new Map()

/**
 * A translator bound to whatever locale is current at call time.
 * @returns `(key, params?) => string`.
 */
function liveTranslator() {
  const locale = i18n.locale
  let bound = translators.get(locale)
  if (bound === undefined) {
    bound = translator(locale)
    translators.set(locale, bound)
  }
  return bound
}

const t = (key, params) => liveTranslator()(key, params)

/**
 * Every threshold, with the value it takes when the row names no `config`.
 *
 * The numbers themselves live next to the code that enforces them
 * (`STORE_DEFAULTS` / `CORE_DEFAULTS`), and a test asserts this schema's defaults
 * are exactly those. Do not inline a number here: the two would drift, and the
 * drift would be invisible — the schema is what a user reads.
 *
 * Every field MUST carry `.default(...)`. A required field with no default makes
 * an omitted `config` a validation failure, and a failing plugin is only a
 * WARNING at startup: the profile boots with this plugin silently missing. See
 * MAINTENANCE.md §十一之七.
 *
 * `z` is `@deepseek-ai/schemastery`, the builder every Host plugin uses; the
 * package is deliberately NOT declared in `dependencies` (nothing here is — see
 * MAINTENANCE.md §十一之一) so the instance is the Host's own.
 */
export const Config = z.object({
  // Safety ceilings.
  hopLimit: z.number().step(1).min(1).default(STORE_DEFAULTS.hopLimit),
  rateLimit: z.number().step(1).min(1).default(STORE_DEFAULTS.rateLimit),
  rateWindowMs: z.number().step(1).min(1).default(STORE_DEFAULTS.rateWindowMs),
  channelBudget: z.number().step(1).min(1).default(STORE_DEFAULTS.channelBudget),
  inboxLimit: z.number().step(1).min(1).default(STORE_DEFAULTS.inboxLimit),
  requestMemory: z.number().step(1).min(1).default(STORE_DEFAULTS.requestMemory),
  pendingGraceMs: z.number().step(1).min(1).default(STORE_DEFAULTS.pendingGraceMs),
  hopMemoryMs: z.number().step(1).min(1).default(STORE_DEFAULTS.hopMemoryMs),
  // Presentation preferences.
  maxCandidates: z.number().step(1).min(1).default(CORE_DEFAULTS.maxCandidates),
  recentTurns: z.number().step(1).min(0).default(CORE_DEFAULTS.recentTurns),
  previewMaxChars: z.number().step(1).min(1).default(CORE_DEFAULTS.previewMaxChars),
})

/** The thresholds one `apply` works with: schema defaults, then the row's. */
function resolveOptions(config) {
  return { ...STORE_DEFAULTS, ...CORE_DEFAULTS, ...(config ?? {}) }
}

/** The config fields a row may set. Anything else is a typo, not a setting. */
export const CONFIG_FIELDS = Object.freeze(Object.keys({ ...STORE_DEFAULTS, ...CORE_DEFAULTS }))

// Every service this plugin reads. Most are host-plane registries; the plugin
// publishes nothing of its own and holds no cross-session state that another row
// would need, so it belongs in the host composition as one row. `settings` is
// read optionally (through `ctx.get`) because a deployment without a settings
// provider must still load.
export const inject = [
  'agents',
  'sessions',
  'sessionTitle',
  'sessionController',
  'workspaceRegistry',
  'userQuestions',
  'tools',
]

/**
 * Wire the plugin into the Host.
 *
 * NAMED EXPORTS ONLY, and `Config` above is the reason: the loader's
 * `unwrapExports` returns a module's `default` export alone when one exists, so a
 * `Config` sibling of a `default` export is silently discarded — no error, the
 * schema just never validates anything and `apply` keeps receiving `undefined`.
 * Measured against the real loader at dsh 0.2.0-rc.2; a test pins it.
 *
 * @param ctx - the host context.
 * @param config - the row's `config`, already validated and defaulted by cordis.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  i18n.locale = resolveLocale(ctx)

  // schemastery passes unknown keys through (the Host's dialect is not strict),
  // so a misspelled field would simply do nothing and say nothing. Report it
  // through the sanctioned channel — `console.*` is not a plugin's to write.
  const unknown = Object.keys(config ?? {}).filter((key) => !CONFIG_FIELDS.includes(key))
  if (unknown.length > 0) {
    ctx.logger?.warn?.(`dsh-peer-sessions: ignoring unknown config field(s): ${unknown.join(', ')}`)
  }

  // The store outlives one `apply` on purpose (see the note above it), so a
  // config change is adopted rather than rebuilt: channels keep their state and
  // the new thresholds govern what happens next.
  sharedStore ??= new PeerStore(options)
  sharedStore.configure(options)
  const core = new PeerCore(ctx, sharedStore, t, options)

  // Model-facing half. Registered globally: visible in every conversation.
  // Without a channel each tool is inert and says so, which is what keeps
  // "everyone can see the tool" from becoming "everyone can reach everyone".
  registerTools(ctx, core)

  // Human-facing half. `inject` runs the callback in an effect scope owned by
  // the dependency, so the registrations unwind with it — and the disposer is
  // RETURNED so the scope owns it explicitly rather than relying on the nested
  // registrations to be collected one by one.
  ctx.inject(['commands'], (commandsCtx) => {
    let dispose = registerCommands(commandsCtx.commands, core)

    // A command's description is fixed when it registers, so following the
    // language live means re-registering. `settings/document-updated` is the
    // only settings event the Host emits, and `dsh-client-locale` owns the
    // namespace it carries — we only read it. The listener used to name
    // `settings/updated`, which dsh 0.1.7-rc.2 removed: the subscription
    // therefore never fired and this whole branch was dead code (see
    // MAINTENANCE.md §十一之五). Handler copy needs none of this: it is
    // rendered per invocation through `core.t`, which always reads the current
    // locale.
    ctx.on('settings/document-updated', (ns) => {
      if (ns !== LOCALE_NAMESPACE) return
      const next = resolveLocale(ctx)
      if (next === i18n.locale) return
      i18n.locale = next
      dispose()
      dispose = registerCommands(commandsCtx.commands, core)
    })

    // Hand the scope the disposer for whatever registration is current at
    // unwind time. Without this the scope still collects the nested
    // registrations, but the contract is left implicit — and a future
    // registration that is NOT itself scope-owned would leak on unload.
    return () => dispose()
  })
}
