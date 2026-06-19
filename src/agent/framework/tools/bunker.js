/**
 * Framework v2 — Instant bunker / seal (blueprint §F + user obs #7).
 *
 * ★USER #7 (2026-06-19 live): the LIVE night-shelter "dug a hole then walled up"
 * built the walls by NAVIGATING to each placement (skills.placeBlock → goToPosition),
 * so after placing a few blocks the bot had WALKED OUTSIDE its own ring and ended up
 * unsheltered. The first sealBunker draft had the SAME bug (it used skills.placeBlock).
 *
 * FIX — two principles:
 *   1. DIG-IN FIRST ("三填一"): dig DOWN 1-2 so the bot is below grade with solid
 *      walls already on all 4 sides (the surrounding ground), then cap the single
 *      cell overhead. This is the cheapest, always-centered shelter — no walls to
 *      walk around.
 *   2. NEVER NAVIGATE TO PLACE: use bot.placeBlock(referenceBlock, faceVector)
 *      which only ROTATES the bot in place (no pathfinding/walking), placing against
 *      an adjacent block the bot can already reach. The bot stays centered.
 *
 * Runs on the PLACEMENT lane, uninterruptible. NEEDS IN-GAME VALIDATION (V3) — the
 * exact placeBlock face geometry + digDown interaction can only be confirmed live.
 */

import { LANE } from '../contracts.js';
import { getLaneManager } from '../tool_lanes.js';

const SEAL_RE = /^(dirt|grass_block|cobblestone|cobbled_deepslate|granite|diorite|andesite|tuff|gravel|netherrack|stone|sand|sandstone)$/;
const solid = (b) => !!b && b.boundingBox === 'block';
const isLava = (b) => !!b && /lava/.test(b.name || '');

function sealItem(bot) {
    try { return bot.inventory.items().find(i => SEAL_RE.test(i.name)) || null; } catch (e) { return null; }
}

/** Place a block at absolute cell `target` (a floored Vec3) by referencing a solid
 *  neighbor and rotating in place — NEVER walking. Returns true if the cell ends solid. */
async function placeAt(bot, target, log) {
    if (solid(bot.blockAt(target))) return true;          // already filled
    const it = sealItem(bot);
    if (!it) { log('[bunker] out of sealable blocks'); return false; }
    try { await bot.equip(it, 'hand'); } catch (e) { log(`[bunker] equip: ${e.message}`); return false; }
    // try each solid neighbor as the reference face
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        const refPos = target.offset(dx, dy, dz);
        const ref = bot.blockAt(refPos);
        if (!solid(ref)) continue;
        const faceVec = target.minus(ref.position);       // from ref toward target (unit cardinal)
        try {
            await bot.placeBlock(ref, faceVec);            // rotates in place, no walking
            if (solid(bot.blockAt(target))) return true;
        } catch (e) { /* try next reference */ }
    }
    return solid(bot.blockAt(target));
}

export async function sealBunker(bot, opts = {}) {
    const lm = getLaneManager(bot, { log: opts.log });
    return lm.runExclusive(LANE.PLACEMENT, (ctx) => _seal(bot, ctx, opts), {
        label: 'seal-bunker', timeoutMs: opts.timeoutMs || 10000, generous: true,
    });
}

async function _seal(bot, ctx, opts) {
    const log = opts.log || (() => {});
    const skills = await import('../../library/skills.js');

    // ── Phase 1: DIG-IN (preferred). Dig down up to 2 if there's solid, non-lava
    //    ground below — that gives us solid walls on all 4 sides for free. ──
    let dug = 0;
    for (let i = 0; i < 2; i++) {
        if (ctx.preempted()) break;
        const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (!solid(below) || isLava(below)) break;        // air/water/lava below → can't dig in
        try {
            const ok = await skills.digDown(bot, 1);
            if (!ok) break;
            dug++;
        } catch (e) { log(`[bunker] digDown stop: ${e.message}`); break; }
    }

    // ── Phase 2: cap overhead WITHOUT walking. After digging in, the cell above
    //    the head has solid horizontal neighbors (the ground we dug past) to place
    //    against. If we couldn't dig in (dug=0), also ring the 4 head-level sides
    //    so a mob can't reach us even with an open top. ──
    const foot = bot.entity.position.floored();
    let walls = 0, roof = 0;

    if (dug === 0) {
        // surface fallback: 4 head-level cardinal walls (block horizontal LoS/reach),
        // placed against the floor beside the bot (face up) — no walking.
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (ctx.preempted()) break;
            const target = foot.offset(dx, 1, dz);
            if (await placeAt(bot, target, log)) walls++;
        }
    }

    // Roof cap: the cell directly above the head (foot + 2). After dig-in its
    // horizontal neighbors at that level are solid; on the surface fallback the
    // just-placed head walls serve as references.
    const cap = foot.offset(0, 2, 0);
    if (!ctx.preempted() && await placeAt(bot, cap, log)) roof = 1;

    const sealed = roof >= 1;
    log(`[bunker] dig-in=${dug} walls=${walls} roof=${roof} sealed=${sealed} @${foot.x},${foot.y},${foot.z}`);
    return { digIn: dug, walls, roof, sealed };
}
