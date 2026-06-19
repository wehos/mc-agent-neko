/**
 * Framework v2 — Block bridging / pillar (blueprint §F: "leave margin, don't be
 * extreme — bridging slower, jump hang-time higher → more fault tolerance").
 *
 * Runs on the LOCOMOTION lane. Wraps the existing skills.placeBlockUnderFeet but
 * forces GENEROUS parameters (longer jump, longer settle, more retries) so the
 * place reliably lands under the bot instead of failing at extreme timing. The
 * lane makes it uninterruptible (only a higher-prio lane — combat/MLG — preempts).
 */

import { LANE } from '../contracts.js';
import { getLaneManager } from '../tool_lanes.js';

// Generous defaults (vs skills.placeBlockUnderFeet's tighter jumpMs:900/settleMs:180).
const GENEROUS = { jumpMs: 1100, settleMs: 280, retries: 3, minClearance: 0.92 };

/**
 * Place one block under the feet (the bridging/pillar primitive), generously.
 * @param {string} blockType  e.g. 'cobblestone', 'dirt'
 */
export async function placeUnderFeet(bot, blockType, opts = {}) {
    const lm = getLaneManager(bot, { log: opts.log });
    return lm.runExclusive(LANE.LOCOMOTION, async (ctx) => {
        const skills = await import('../../library/skills.js');
        if (ctx.preempted()) return false;
        return skills.placeBlockUnderFeet(bot, blockType, { ...GENEROUS, ...opts });
    }, { label: `bridge:${blockType}`, timeoutMs: opts.timeoutMs || 8000, generous: true });
}

/**
 * Pillar straight up to targetY (or +N), generously. Repeated generous
 * placeUnderFeet on a single lane hold so reflexes can't yank it mid-pillar.
 */
export async function pillarUp(bot, targetY = null, opts = {}) {
    const lm = getLaneManager(bot, { log: opts.log });
    return lm.runExclusive(LANE.LOCOMOTION, async (ctx) => {
        const skills = await import('../../library/skills.js');
        if (ctx.preempted()) return false;
        return skills.pillarUp(bot, targetY);
    }, { label: 'pillar-up', timeoutMs: opts.timeoutMs || 15000, generous: true });
}
