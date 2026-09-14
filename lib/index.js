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

import { PeerCore } from './core.js'
import { PeerStore } from './store.js'
import { registerCommands } from './commands.js'
import { registerTools } from './tools.js'

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

export default {
  // Every service this plugin reads. Most are host-plane registries; the
  // plugin publishes nothing of its own and holds no cross-session state that
  // another row would need, so it belongs in the host composition as one row.
  inject: [
    'agents',
    'sessions',
    'sessionTitle',
    'sessionController',
    'workspaceRegistry',
    'userQuestions',
    'tools',
  ],

  apply(ctx) {
    sharedStore ??= new PeerStore()
    const core = new PeerCore(ctx, sharedStore)

    // Model-facing half. Registered globally: visible in every conversation.
    // Without a channel each tool is inert and says so, which is what keeps
    // "everyone can see the tool" from meaning "everyone can reach everyone".
    registerTools(ctx, core)

    // Human-facing half. `inject` runs the callback in an effect scope owned by
    // the dependency, so the registrations unwind with it.
    ctx.inject(['commands'], (commandsCtx) => {
      registerCommands(commandsCtx.commands, core)
    })
  },
}
