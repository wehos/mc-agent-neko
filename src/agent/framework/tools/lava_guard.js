/**
 * Framework v2 — Fluid guard (blueprint §E.2: "another judge that always ensures
 * mining never digs into lava" + the MLG exception "don't place water over lava").
 * ★2026-07-07 用户令 (岩浆和水裁判 试装): extended from lava-only to BOTH fluids — the
 * water judge mirrors the lava one, because breaking into an aquifer at depth drowns
 * the bot in a sealed pocket just as surely as lava burns it (mineDown C311 / deaths
 * #112,#200). The per-target `safeToDigBlock` judge is now wired live into the ORE/
 * block collector's dig primitive (skills.js `safeDig`).
 *
 * Pure READ predicates — no bot mutation, no lane needed. They are PRECONDITIONS
 * for the DIG lane and the SURVIVAL_MLG clutch-water tool. Keeping them as plain
 * functions lets any layer (instinct, tool, skill) call them cheaply.
 */

import { canMineWaterAdjacentWithBreathing } from './water_navigation.js';

const LAVA_RE = /lava/;
const WATER_RE = /water/;
const isLava = (b) => !!b && LAVA_RE.test(b.name || '');
const isWater = (b) => !!b && WATER_RE.test(b.name || '');   // source + flowing_water
const isFluid = (b) => isLava(b) || isWater(b);
const solid = (b) => !!b && b.boundingBox === 'block';

// Depth below which open water is a drowning-pocket hazard, not a swimmable surface
// river (mirrors skills.js collectBlock's y>=55 water-routing gate; deaths #112 y35,
// #200 y47 were sealed-ceiling drownings). Above it the swim reflex handles water.
const WATER_UNDERGROUND_Y = 55;
// Only judge digs close enough that a released flow reaches the bot's pocket before it
// can react. Far tunnel/descent digs are already guarded by mineDown/branchMine.
const FLUID_NEAR_BOT = 3;

/** Is the block at an absolute Vec3 position lava? */
export function isLavaAt(bot, pos) {
    try { return isLava(bot.blockAt(pos)); } catch (e) { return false; }
}

/** Is the block at an absolute Vec3 position water (source or flowing)? */
export function isWaterAt(bot, pos) {
    try { return isWater(bot.blockAt(pos)); } catch (e) { return false; }
}

/**
 * Which fluids are FACE-adjacent to the cell at `pos`? Breaking the block there opens a
 * face to any source/flow touching it, so that fluid can pour into the freshly-opened
 * cell. Returns {lava, water} booleans. Pure/read-only.
 */
export function fluidAdjacent(bot, pos) {
    let lava = false, water = false;
    try {
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const b = bot.blockAt(pos.offset(dx, dy, dz));
            if (isLava(b)) lava = true;
            else if (isWater(b)) water = true;
        }
    } catch (e) {}
    return { lava, water };
}

/**
 * Scan the column straight below the bot for the first non-air block. Returns
 * what the bot would land ON and whether it is lava.
 * @returns {{landingY:number|null, block:any|null, isLava:boolean, dist:number}}
 */
export function landingBelow(bot, maxDrop = 32) {
    try {
        const p = bot.entity.position.floored();
        for (let dy = 1; dy <= maxDrop; dy++) {
            const b = bot.blockAt(p.offset(0, -dy, 0));
            if (!b) continue;
            const name = b.name || '';
            if (name === 'air' || name === 'cave_air' || name === 'void_air') continue;
            // water counts as a safe (already-cushioned) landing
            return { landingY: p.y - dy, block: b, isLava: isLava(b), dist: dy };
        }
    } catch (e) {}
    return { landingY: null, block: null, isLava: false, dist: Infinity };
}

/**
 * Is it safe to dig the block directly under the bot's feet? FALSE if the block
 * at feet-1 OR feet-2 is lava (digging down would drop the bot into it), or if
 * lava is adjacent at foot level (a dig could open a flow). This is the DIG lane
 * precondition — callers must consult it before any digDown.
 */
export function safeToDigDown(bot) {
    try {
        const p = bot.entity.position.floored();
        if (isLava(bot.blockAt(p.offset(0, -1, 0)))) return false;
        if (isLava(bot.blockAt(p.offset(0, -2, 0)))) return false;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (isLava(bot.blockAt(p.offset(dx, -1, dz)))) return false;
        }
        return true;
    } catch (e) {
        return false; // unknown → refuse (fail safe)
    }
}

/**
 * BOTH-fluid variant of safeToDigDown: refuse a dig-down if lava OR water sits at/under
 * the feet (drop-in) or floods in from a foot-level side. For descent callers that must
 * not staircase into an aquifer either. Fail-safe (refuse on unknown), like safeToDigDown.
 */
export function safeToDigDownFluid(bot) {
    try {
        const p = bot.entity.position.floored();
        if (isFluid(bot.blockAt(p.offset(0, -1, 0)))) return false;
        if (isFluid(bot.blockAt(p.offset(0, -2, 0)))) return false;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (isFluid(bot.blockAt(p.offset(dx, -1, dz)))) return false;
        }
        return true;
    } catch (e) {
        return false; // unknown → refuse (fail safe)
    }
}

/**
 * DIG-lane precondition for the ORE/block collector (wired live into skills.js `safeDig`).
 * Judge whether breaking `block` would open a fluid onto the bot's pocket:
 *   - LAVA: any lava face-adjacent to a target within FLUID_NEAR_BOT of the bot ⇒ refuse
 *     (contact = burn/death; the flow reaches the freshly-opened cell). Guarded at any depth.
 *   - WATER: underground wet faces are allowed only for an active miner already submerged beside
 *     a proven breathing station, and only when the block fits in one oxygen bar. Merely being wet
 *     is not permission; sealed water remains an execution-time hard stop, matching path planning.
 * Returns {ok:true} | {ok:false, hazard:'lava'|'water', reason}. Pure/read-only.
 * FAILS OPEN (returns ok on any error): a throwing predicate must never wedge the hot mining
 * loop — the reactive self_preservation layer stays as the backstop.
 */
export function safeToDigBlock(bot, block) {
    try {
        if (!block || !block.position || !bot || !bot.entity) return { ok: true };
        const p = block.position;
        const bp = bot.entity.position;
        const near = Math.abs(p.x - bp.x) <= FLUID_NEAR_BOT
            && Math.abs(p.y - bp.y) <= FLUID_NEAR_BOT
            && Math.abs(p.z - bp.z) <= FLUID_NEAR_BOT;
        if (!near) return { ok: true };
        const adj = fluidAdjacent(bot, p);
        if (adj.lava)
            return { ok: false, hazard: 'lava', reason: `lava face-adjacent to ${block.name} within ${FLUID_NEAR_BOT}b of bot` };
        if (adj.water && Math.floor(bp.y) < WATER_UNDERGROUND_Y
            && !canMineWaterAdjacentWithBreathing(bot, block))
            return {
                ok: false,
                hazard: 'water',
                reason: `water face-adjacent to ${block.name} underground without safe planned breathing coverage`,
            };
        return { ok: true };
    } catch (e) {
        return { ok: true }; // fail-open: never wedge the mining loop
    }
}

/**
 * Can we clutch-water onto the landing spot? FALSE over lava (blueprint §E.2
 * exception) — water would flash to obsidian/stone and not cushion the fall, and
 * placing into lava is a death trap. Also FALSE if there is no solid landing in
 * range (nothing to anchor water on).
 */
export function canClutchWater(bot) {
    const lb = landingBelow(bot);
    if (lb.isLava) return { ok: false, reason: 'lava below — cannot clutch (blueprint §E.2)', landing: lb };
    if (!lb.block) return { ok: false, reason: 'no landing block in range', landing: lb };
    if (/water/.test(lb.block.name || '')) return { ok: false, reason: 'already water below (no clutch needed)', landing: lb };
    return { ok: true, reason: 'clear', landing: lb };
}

export { isLava as _isLava, isWater as _isWater, isFluid as _isFluid, solid as _solid };
