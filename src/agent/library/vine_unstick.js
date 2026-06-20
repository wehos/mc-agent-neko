/**
 * Vine unstick — mineflayer-layer monkey-patch for the recurring "stuck on vines"
 * terrain trap (user: ≥5 of the last 15 explorations). See memory
 * mineflayer-layer-primitives (terrain conflicts resolve at the mineflayer layer).
 *
 * ROOT CAUSE (read from prismarine-physics index.js isOnLadder, ~L439/584/592):
 * the physics treats ANY `vine` block as a ladder — when the bot stands in / presses
 * against a vine cell, its horizontal speed is clamped to ladderMaxSpeed (0.15) and,
 * if it's collided horizontally, vel.y is set to climbSpeed (it climbs UP). Vanilla
 * only lets you climb a vine that has a solid block behind it, but the physics does
 * NOT check that, so free-hanging jungle vines trap the bot: pathfinder walks into a
 * vine cell (boundingBox 'empty' → "safe"), then the physics clamps/climbs and the
 * bot crawls/clings instead of making progress.
 *
 * FIX: when the pathfinder WANTS to move but the bot is held ~stationary AND a vine
 * is in/adjacent to its body, bare-hand-break the trapping vine cells (vines break
 * instantly, no tool) so the cling releases and pathing resumes. Gated strictly on
 * "wants-to-move + not-moving + vine-present" so it never touches an intentional
 * climb or an idle bot. Pairs with removing vines from pathfinder climbables.
 */

const VINE_RE = /vine/;   // vine, weeping_vines, twisting_vines, cave_vines (+_plant)
const isVine = (b) => !!b && VINE_RE.test(b.name || '');

/** Install the vine-unstick hook on a bot. Idempotent. */
export function installVineUnstick(bot, log = () => {}) {
    if (bot._vineUnstick) return;
    const st = bot._vineUnstick = { lastPos: null, stuckSince: 0, lastBreakAt: 0, busy: false };

    const tick = async () => {
        if (st.busy) return;
        try {
            const e = bot.entity;
            if (!e || !e.position) return;
            const p = e.position;
            // horizontal displacement since last sample
            const moved = st.lastPos ? Math.hypot(p.x - st.lastPos.x, p.z - st.lastPos.z) : 1;
            st.lastPos = { x: p.x, y: p.y, z: p.z };

            // Does the pathfinder (or a raw control) actually want to move right now?
            let wantsMove = false;
            try { wantsMove = !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()); } catch (e) {}
            if (!wantsMove) { try { wantsMove = !!(e.controlState && (e.controlState.forward || e.controlState.back)); } catch (e) {} }
            if (!wantsMove) { st.stuckSince = 0; return; }

            // Is a vine in/against the bot's body?
            const m = p.floored();
            const bodyCells = [m, m.offset(0, 1, 0)];
            let trapped = bodyCells.some(c => isVine(bot.blockAt(c)));
            if (!trapped && e.isCollidedHorizontally) {
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    if (isVine(bot.blockAt(m.offset(dx, 0, dz))) || isVine(bot.blockAt(m.offset(dx, 1, dz)))) { trapped = true; break; }
                }
            }

            if (!(trapped && moved < 0.08)) { st.stuckSince = 0; return; }

            const now = Date.now();
            if (!st.stuckSince) st.stuckSince = now;
            // wedged on vines for >600ms and not breaking too fast → clear the trap
            if (now - st.stuckSince < 600 || now - st.lastBreakAt < 500) return;
            st.lastBreakAt = now;

            // Break vines in/around the body — foot & head first (those cling), then the
            // 4 cardinal sides the bot may be pressed against. Bare hand, instant.
            const targets = [m, m.offset(0, 1, 0)];
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { targets.push(m.offset(dx, 0, dz), m.offset(dx, 1, dz)); }
            st.busy = true;
            try {
                for (const t of targets) {
                    const b = bot.blockAt(t);
                    if (!isVine(b)) continue;
                    try { await bot.dig(b, true); log(`[vine_unstick] broke ${b.name} @${t.x},${t.y},${t.z}`); } catch (e) {}
                    break; // one per cycle — re-evaluate next tick (cheap, avoids long dig chains)
                }
            } finally { st.busy = false; }
        } catch (e) { st.busy = false; }
    };

    st.interval = setInterval(tick, 250);   // ~4Hz, lightweight blockAt checks
    return st;
}

/** Remove vine block ids from a pathfinder Movements' climbables (don't PLAN vine
 *  climbs — they're the trap). Call inside a Movements subclass constructor. */
export function unclimbVines(movements, registry) {
    try {
        for (const n of ['vine', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant', 'cave_vines', 'cave_vines_plant']) {
            const b = registry && registry.blocksByName && registry.blocksByName[n];
            if (b && movements.climbables) movements.climbables.delete(b.id);
        }
    } catch (e) {}
}
