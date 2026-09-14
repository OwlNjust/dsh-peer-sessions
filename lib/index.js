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
import { registerCommands } from './commands.js'
import { registerTools } from './tools.js'

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
    const core = new PeerCore(ctx)

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
