/**
 * Framework v2 — Instant bunker / seal (blueprint §F: "instant-build a bunker to
 * wall yourself in for dig-in survival" — one of the scripted actions that
 * "should be foolproof but often breaks").
 *
 * Runs on the PLACEMENT lane, uninterruptible. Seals the 4 cardinal gaps at head
 * height + the roof above the head, so a mob can't reach/see the bot. Reuses the
 * same sealable-block set + skills.placeBlock the prepNether bunker uses, so
 * behavior is consistent with the proven path — the difference is it runs on an
 * exclusive lane (can't be yanked mid-seal by a reflex).
 */

import { LANE } from '../contracts.js';
import { getLaneManager } from '../tool_lanes.js';

const SEAL_RE = /^(dirt|grass_block|cobblestone|cobbled_deepslate|granite|diorite|andesite|tuff|gravel|netherrack|stone)$/;
const solid = (b) => !!b && b.boundingBox === 'block';

function sealItem(bot) {
    try { return bot.inventory.items().find(i => SEAL_RE.test(i.name)) || null; } catch (e) { return null; }
}

/**
 * Seal the bot in place. Places blocks at the 4 head-level cardinal gaps and the
 * roof (head+1). Best-effort: places where there's an open gap with a placeable
 * face; skips already-solid sides. Returns {walls, roof, sealed}.
 */
export async function sealBunker(bot, opts = {}) {
    const lm = getLaneManager(bot, { log: opts.log });
    return lm.runExclusive(LANE.PLACEMENT, (ctx) => _seal(bot, ctx, opts), {
        label: 'seal-bunker', timeoutMs: opts.timeoutMs || 8000, generous: true,
    });
}

async function _seal(bot, ctx, opts) {
    const log = opts.log || (() => {});
    const skills = await import('../../library/skills.js');
    const headY = 1; // head is ~1 block above feet
    const p = bot.entity.position.floored();
    let walls = 0, roof = 0;

    // 4 cardinal walls at head level.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (ctx.preempted()) break;
        const target = p.offset(dx, headY, dz);
        if (solid(bot.blockAt(target))) continue;     // already walled
        const it = sealItem(bot);
        if (!it) { log('[bunker] out of sealable blocks (walls)'); break; }
        try {
            const ok = await skills.placeBlock(bot, it.name, target.x, target.y, target.z, 'bottom', true);
            if (ok) walls++;
        } catch (e) { log(`[bunker] wall place failed: ${e && e.message}`); }
    }

    // Roof above head (head+1).
    if (!ctx.preempted()) {
        const top = p.offset(0, headY + 1, 0);
        if (!solid(bot.blockAt(top))) {
            const it = sealItem(bot);
            if (it) {
                try {
                    const ok = await skills.placeBlock(bot, it.name, top.x, top.y, top.z, 'bottom', true);
                    if (ok) roof++;
                } catch (e) { log(`[bunker] roof place failed: ${e && e.message}`); }
            }
        } else {
            roof = 1; // already roofed
        }
    }

    const sealed = walls >= 0 && roof >= 1;
    log(`[bunker] sealed walls=${walls} roof=${roof}`);
    return { walls, roof, sealed };
}
