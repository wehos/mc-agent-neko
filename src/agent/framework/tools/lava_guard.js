/**
 * Framework v2 — Lava guard (blueprint §E.2: "another judge that always ensures
 * mining never digs into lava" + the MLG exception "don't place water over lava").
 *
 * Pure READ predicates — no bot mutation, no lane needed. They are PRECONDITIONS
 * for the DIG lane and the SURVIVAL_MLG clutch-water tool. Keeping them as plain
 * functions lets any layer (instinct, tool, skill) call them cheaply.
 */

const LAVA_RE = /lava/;
const isLava = (b) => !!b && LAVA_RE.test(b.name || '');
const solid = (b) => !!b && b.boundingBox === 'block';

/** Is the block at an absolute Vec3 position lava? */
export function isLavaAt(bot, pos) {
    try { return isLava(bot.blockAt(pos)); } catch (e) { return false; }
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

export { isLava as _isLava, solid as _solid };
