/**
 * Framework v2 — Instant bunker / seal ("挖三填一", blueprint §F + user obs #7).
 *
 * ★USER #7 + 2026-06-19 live V3 round 1 (FAILED, two root causes found):
 *   (a) The LIVE shelter / first draft placed via skills.placeBlock which NAVIGATES
 *       (goToPosition) → walked the bot OUT of its own ring. (b) Even after switching
 *       to rotate-in-place bot.placeBlock, round 1 still failed because:
 *         • the bot did not STAY in the hole — mineflayer modes (unstuck/etc.) moved
 *           it out mid-seal (a JS tool-lane does NOT freeze mineflayer modes), and
 *         • it only dug 1-2 deep, so the cap cell landed at/above the surface where
 *           the 4 horizontal neighbors are AIR → nothing to place the cap against
 *           (it stuck a block to a nearby tree instead).
 *
 * ★FIX — the real "挖三填一" (dig 3, fill 1), per user:
 *   1. PIN + mode-guard: pause the modes that move the bot (unstuck/item_collecting/
 *      followers) for the duration + pathfinder.stop + clearControlStates, so the bot
 *      stays put while we dig & cap. (Proper resolution belongs in the mineflayer layer
 *      long-term — see memory mineflayer-layer-primitives.)
 *   2. DIG DOWN 3: feet end at Y-3, head at Y-2, so the cap cell (head+1 = Y-1) sits
 *      BELOW the original surface, where its 4 horizontal neighbors are still solid
 *      ground → there IS a face to place the cap against. (Digging only 1-2 puts the
 *      cap at/above grade with air neighbors = uncappable — round-1 bug.)
 *   3. CAP at head+1 via rotate-in-place bot.placeBlock(ref, faceVec) — no walking.
 *   4. Report HONEST covered state read back from the world (not the tool's own
 *      success flag — memory validation-not-mock).
 *
 * Runs on the PLACEMENT lane. STILL needs in-game validation each change (V3).
 */

import { LANE } from '../contracts.js';
import { getLaneManager } from '../tool_lanes.js';

const SEAL_RE = /^(dirt|grass_block|cobblestone|cobbled_deepslate|granite|diorite|andesite|tuff|gravel|netherrack|stone|sand|sandstone)$/;
const solid = (b) => !!b && b.boundingBox === 'block';
const isLava = (b) => !!b && /lava/.test(b.name || '');

// Modes that can MOVE the bot mid-seal — paused for the duration, restored after.
const GUARD_MODES = ['unstuck', 'item_collecting', 'torch_placing', 'elbow_room', 'hunting'];

function sealItem(bot) {
    try { return bot.inventory.items().find(i => SEAL_RE.test(i.name)) || null; } catch (e) { return null; }
}
function pin(bot) {
    try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
    try { bot.clearControlStates(); } catch (e) {}
}

/** Place at absolute cell `target` by referencing a face-adjacent solid neighbor and
 *  ROTATING in place (no walking). Returns true if the cell ends solid. */
async function placeAt(bot, target, log) {
    if (solid(bot.blockAt(target))) return true;
    const it = sealItem(bot);
    if (!it) { log('[bunker] out of sealable blocks'); return false; }
    try { await bot.equip(it, 'hand'); } catch (e) { log(`[bunker] equip: ${e.message}`); return false; }
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        const ref = bot.blockAt(target.offset(dx, dy, dz));
        if (!solid(ref)) continue;
        const faceVec = target.minus(ref.position);
        try {
            await bot.placeBlock(ref, faceVec);
            if (solid(bot.blockAt(target))) return true;
        } catch (e) { /* try next reference */ }
    }
    return solid(bot.blockAt(target));
}

export async function sealBunker(bot, opts = {}) {
    const lm = getLaneManager(bot, { log: opts.log });
    return lm.runExclusive(LANE.PLACEMENT, (ctx) => _seal(bot, ctx, opts), {
        label: 'seal-bunker', timeoutMs: opts.timeoutMs || 12000, generous: true,
    });
}

async function _seal(bot, ctx, opts) {
    const log = opts.log || (() => {});
    const skills = await import('../../library/skills.js');

    // ── mode-guard: pause movement modes so they can't drag the bot out mid-seal. ──
    const prevModes = {};
    try { for (const m of GUARD_MODES) if (bot.modes && bot.modes.exists(m)) { prevModes[m] = bot.modes.isOn(m); bot.modes.setOn(m, false); } } catch (e) {}

    try {
        const startY = Math.floor(bot.entity.position.y);
        pin(bot);

        // ── DIG DOWN 3 ("三") so the cap lands at a solid-neighbor depth. dig 1 at a
        //    time, pinning between, so a half-dug step can't let a mode walk us off. ──
        let dug = 0;
        for (let i = 0; i < 3; i++) {
            if (ctx.preempted()) break;
            const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
            if (!solid(below) || isLava(below)) { log(`[bunker] stop dig: below=${below && below.name}`); break; }
            try {
                const ok = await skills.digDown(bot, 1);
                pin(bot);
                if (!ok) break;
                dug++;
            } catch (e) { log(`[bunker] digDown stop: ${e.message}`); break; }
        }

        // ── CAP ("填一") at head+1. After digging d, feet are at startY-d; head is
        //    startY-d .. startY-d+1; cap = head+1 = (startY-d)+2 = foot+2. With d=3 this
        //    is startY-1 (below grade → solid horizontal neighbors → placeable). ──
        pin(bot);
        const foot = bot.entity.position.floored();
        const cap = foot.offset(0, 2, 0);
        let capped = false;
        if (!ctx.preempted()) capped = await placeAt(bot, cap, log);

        // If we couldn't dig the full 3 (shallow/water/lava) the cap may be at a grade
        // with no solid neighbor → also try walling the 4 head-level sides so at least
        // horizontal reach is blocked (best-effort, honest about the open top).
        let walls = 0;
        if (!capped) {
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                if (ctx.preempted()) break;
                if (await placeAt(bot, foot.offset(dx, 1, dz), log)) walls++;
            }
        }

        // ── HONEST report: read the actual blocks back from the world (not our own
        //    success flags). "covered" = solid directly above head. ──
        const headCell = foot.offset(0, 2, 0);
        const covered = solid(bot.blockAt(headCell));
        pin(bot);
        log(`[bunker] dig=${dug} cap=${capped} walls=${walls} covered=${covered} foot=${foot.x},${foot.y},${foot.z}`);
        return { dig: dug, cap: capped, walls, covered, foot: { x: foot.x, y: foot.y, z: foot.z } };
    } finally {
        try { for (const m of Object.keys(prevModes)) bot.modes.setOn(m, prevModes[m]); } catch (e) {}
    }
}
