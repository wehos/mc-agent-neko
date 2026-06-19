/**
 * Framework v2 — public entry. `createFramework(agent)` builds the kernel + lane
 * manager and returns the handle the agent ticks. Everything is gated behind a
 * feature flag (default OFF) so importing/wiring this changes NO behavior until
 * explicitly enabled.
 *
 * Wiring (agent.js): construct once after the bot spawns, then call
 * `framework.tick(delta)` from Agent.update(). See docs/framework-v2-scaffold.md §6.
 */

import { Kernel } from './kernel.js';
import { getLaneManager } from './tool_lanes.js';
import { FRAMEWORK_ENABLED_DEFAULT } from './contracts.js';

export { getWorld, mentalState, proposeTasks, registerResourceNode, markDepleted, nearestNode, ingestScan } from './world_model.js';
export { ToolLaneManager, getLaneManager, preempts, LanePreempted } from './tool_lanes.js';
export * as instinct from './instinct.js';
export * as contracts from './contracts.js';
export { Kernel };

/**
 * Build the framework handle for an agent. Idempotent per agent.
 * @param {any} agent
 * @param {Object} [opts] forwarded to Kernel ({enabled, shadow, log})
 */
export function createFramework(agent, opts = {}) {
    if (agent && agent._framework) return agent._framework;
    const bot = agent && agent.bot;
    const lanes = bot ? getLaneManager(bot, { log: opts.log }) : null;
    const kernel = new Kernel(agent, opts);
    const handle = {
        kernel,
        lanes,
        enabled: kernel.enabled,
        /** tick from Agent.update(delta) */
        tick: (delta) => kernel.tick(delta),
        /** route a player message into companion mode */
        onPlayerMessage: (source, msg) => kernel.onPlayerMessage(source, msg),
    };
    if (agent) agent._framework = handle;
    return handle;
}

export { FRAMEWORK_ENABLED_DEFAULT };
