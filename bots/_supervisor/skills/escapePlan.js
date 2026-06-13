import fs from 'fs';
import path from 'path';

// escapePlan — the first real piece of the architecture refactor (docs/HANDOFF.md §4).
//
// WHY THIS EXISTS
// The patch-route endpoint (C42–C207) produced an *absorbing livelock*: every layer
// (mission KILL-BOX, prepNether, core pin-breaker, OS watchdog) was patched to "hold"
// at low food, and the holds' only exit conditions (a fresh actionable hostile / a local
// food signal / a watchdog interrupt) are physically improbable for a sealed, stationary
// bot or were patched shut. Result: bot sat at pos=9,52,-11 food=4 hp=15 for 2h+, food
// monotonically declining, going nowhere. See bots/_supervisor/test/fixtures/livelock-9-52-11.json.
//
// The structural fix is a PLANNER, not another gate. Given the full world state, there is
// almost always a safe exit (the bot has an iron pickaxe and 305 cobblestone — it is not
// trapped, it is *paralyzed*). planEscape() computes that exit as ONE coherent objective
// instead of letting N local heuristics each vote "hold".
//
// DESIGN
//   planEscape(state)  — PURE function. No bot, no I/O. Offline-regression-testable.
//                        Input: a plain snapshot {pos,hostiles,dzone,food,hp,hasPickaxe,tod}.
//                        Output: a decision {action, target, waypoints, heading, reason}.
//   default export      — the hot-loadable supervisor skill. Phase A: DRY-RUN only (compute
//                        + log the plan, never move the body). Phase B wires real navigation.
//
// This keeps the dangerous half (moving a live bot) out of Phase A entirely, so the
// decision logic can be proven against the captured livelock with zero live risk.

// ---------------------------------------------------------------------------
// PURE PLANNER (offline-testable — exported separately, takes/returns plain data)
// ---------------------------------------------------------------------------

const RELOCATE_DIST = 40;     // how far (xz blocks) to relocate away from the trap
const WAYPOINT_STEP = 12;     // segment length; each goToPosition leg must finish in ~60s
const ACTIONABLE_DEFER_D = 8; // if a real actionable hostile is this close, defer to combat/flee
const LOW_FOOD = 6;           // food at/below this with no edible = starvation paralysis risk
const NIGHT_START = 13000, NIGHT_END = 23000;

function norm2(x, z) {
    const m = Math.hypot(x, z);
    return m < 1e-6 ? { x: 0, z: 0, m: 0 } : { x: x / m, z: z / m, m };
}

// Weighted centroid of hostiles in the xz plane. Near mobs dominate (1/d^2) so the
// heading runs away from the *cluster the bot is actually pinned against*, not from a
// lone far straggler that happens to skew a plain average.
function hostileCentroid(hostiles) {
    let sx = 0, sz = 0, w = 0;
    for (const h of hostiles || []) {
        if (h == null || h.x == null || h.z == null) continue;
        const d = (h.d != null) ? h.d : Math.max(1, Math.hypot(h.x, h.z));
        const wi = 1 / Math.max(1, d * d);
        sx += h.x * wi; sz += h.z * wi; w += wi;
    }
    return w > 0 ? { x: sx / w, z: sz / w, n: (hostiles || []).length } : null;
}

function isNight(tod) {
    return typeof tod === 'number' && tod > NIGHT_START && tod < NIGHT_END;
}

/**
 * Decide how to break out of a low-food / death-zone paralysis.
 * PURE: depends only on `state`. Returns a plan object; never mutates anything.
 *
 * @param {object} state
 *   pos:        {x,y,z}
 *   hostiles:   [{x,y,z,d,actionable,layered}]   (positions are absolute; d = distance to bot)
 *   dzone:      {cx,cz,r,n} | null               (historical death-zone center xz, radius, count)
 *   food, hp:   numbers
 *   hasPickaxe: bool
 *   hasEdible:  bool                              (any food item in inventory)
 *   tod:        number                            (minecraft daytime 0..24000)
 * @returns {{action,target,waypoints,heading,reason,flags}}
 */
function planEscape(state) {
    const s = state || {};
    const pos = s.pos || { x: 0, y: 64, z: 0 };
    const hostiles = s.hostiles || [];
    const dz = s.dzone || null;
    const food = (s.food == null) ? 20 : s.food;
    const flags = {};

    // 1) Never override a genuine combat/flee situation. If a hostile is actionable AND
    //    close, the self-defense / kiting layers own the body — escape-relocate would
    //    walk the bot straight into a fight. Defer.
    const closeActionable = hostiles.find(h =>
        h && h.actionable === true && (h.d != null ? h.d : Infinity) <= ACTIONABLE_DEFER_D);
    if (closeActionable) {
        return {
            action: 'defer',
            target: null, waypoints: [], heading: null,
            reason: `actionable hostile ${closeActionable.name || '?'} at d=${closeActionable.d} <= ${ACTIONABLE_DEFER_D} — combat/flee layer owns body`,
            flags: { closeActionable: true },
        };
    }

    // 2) Is this actually a paralysis worth escaping? Low food with nothing to eat is the
    //    canonical case. (If there IS edible food, eating is the right move, not relocating.)
    const starving = food <= LOW_FOOD && s.hasEdible !== true;
    const insideDeathZone = dz && (Math.hypot(pos.x - dz.cx, pos.z - dz.cz) <= (dz.r || 0));
    flags.starving = starving;
    flags.insideDeathZone = !!insideDeathZone;
    if (!starving && !insideDeathZone) {
        return {
            action: 'none', target: null, waypoints: [], heading: null,
            reason: `no paralysis: food=${food} hasEdible=${s.hasEdible} insideDeathZone=${!!insideDeathZone}`,
            flags,
        };
    }

    // 3) Compute the escape HEADING: a unit xz vector that runs away from BOTH the
    //    death-zone center and the hostile cluster. This is the crux — the patch layers
    //    never combined these two repulsions into a single direction.
    let rx = 0, rz = 0;
    if (dz) {
        const r = norm2(pos.x - dz.cx, pos.z - dz.cz);
        rx += r.x; rz += r.z;                       // weight 1.0 away from death-zone
    }
    const cen = hostileCentroid(hostiles);
    if (cen) {
        const r = norm2(pos.x - cen.x, pos.z - cen.z);
        rx += r.x; rz += r.z;                       // weight 1.0 away from mob cluster
    }
    let heading = norm2(rx, rz);
    if (heading.m === 0) {
        // Degenerate (sitting exactly on both centroids, or no data): pick +x as an arbitrary
        // but deterministic bearing so the bot still moves somewhere fresh.
        heading = { x: 1, z: 0, m: 1 };
        flags.degenerateHeading = true;
    }

    // 4) Build the target and intermediate waypoints (xz only; y resolved live at the
    //    surface column). Each leg is <= WAYPOINT_STEP so a single goToPosition finishes
    //    inside its 60s budget even when digging.
    const tx = Math.round(pos.x + heading.x * RELOCATE_DIST);
    const tz = Math.round(pos.z + heading.z * RELOCATE_DIST);
    const legs = Math.max(1, Math.ceil(RELOCATE_DIST / WAYPOINT_STEP));
    const waypoints = [];
    for (let i = 1; i <= legs; i++) {
        const f = i / legs;
        waypoints.push({
            x: Math.round(pos.x + heading.x * RELOCATE_DIST * f),
            z: Math.round(pos.z + heading.z * RELOCATE_DIST * f),
        });
    }

    flags.night = isNight(s.tod);
    return {
        action: 'relocate_surface',
        target: { x: tx, y: null, z: tz },          // y=null: ascend to the surface column live
        waypoints,
        heading: { x: heading.x, z: heading.z },
        reason: `${starving ? 'starving(food=' + food + ',no edible)' : ''}${starving && insideDeathZone ? '+' : ''}${insideDeathZone ? 'inside death-zone(' + dz.cx + ',' + dz.cz + ' r' + dz.r + ')' : ''} — relocate ${RELOCATE_DIST}b heading (${heading.x.toFixed(2)},${heading.z.toFixed(2)}) to fresh ${flags.night ? 'terrain (NIGHT: stay cautious)' : 'surface + forage'}`,
        flags,
    };
}

// ---------------------------------------------------------------------------
// HOT-LOADABLE SKILL
//   default (no args / {execute:false})  -> DRY-RUN: compute + log the plan, never move.
//   {execute:true}                       -> EXECUTE: walk the relocation waypoints out
//                                           of the death-zone, re-planning each leg.
// ---------------------------------------------------------------------------

export default async function escapePlan(bot, ctx, opts = {}) {
    const { log } = ctx;
    const execute = opts && opts.execute === true;
    const state = readState(bot, ctx);
    const plan = planEscape(state);
    log(bot, `[escapePlan${execute ? '' : ' DRY-RUN'}] action=${plan.action} target=${plan.target ? `${plan.target.x},${plan.target.z}` : 'none'} :: ${plan.reason}`);

    if (!execute || plan.action !== 'relocate_surface') {
        return { dryRun: !execute, plan, state: { pos: state.pos, food: state.food, hp: state.hp, hostiles: state.hostiles.length } };
    }

    // ---- EXECUTE: horizontal relocation out of the death-zone --------------
    // Insight: missionNether's KILL-BOX hold is death-zone-gated. Leaving the death-zone
    // radius dissolves the hold's premise, so we do NOT need to dig to the surface here —
    // just walk clear of the trap at depth, re-planning each leg so a new actionable
    // hostile (or arrival in fresh terrain) aborts cleanly. Surface ascent stays a later
    // enhancement, not a prerequisite for breaking the livelock.
    const dz = state.dzone;
    const startPos = { ...state.pos };
    const log_ = (m) => log(bot, `[escapePlan] ${m}`);
    let reached = false, lastDist = 0;

    for (let i = 0; i < plan.waypoints.length; i++) {
        const wp = plan.waypoints[i];

        // Re-plan from live state before each leg — never trust the stale opening snapshot.
        const live = readState(bot, ctx);
        const rePlan = planEscape(live);
        if (rePlan.action === 'defer') { log_(`abort leg ${i + 1}: ${rePlan.reason}`); break; }

        // Already clear of the death-zone? Then the hold's premise is gone — done.
        if (dz) {
            const dFromCenter = Math.hypot(live.pos.x - dz.cx, live.pos.z - dz.cz);
            if (dFromCenter > dz.r + 2) { reached = true; log_(`cleared death-zone (d=${dFromCenter.toFixed(1)} > r=${dz.r}) at leg ${i + 1}`); break; }
        }

        log_(`leg ${i + 1}/${plan.waypoints.length} -> ${wp.x},${live.pos.y},${wp.z} (food=${live.food} hp=${live.hp})`);
        let ok = false;
        try { ok = await ctx.skills.goToPosition(bot, wp.x, live.pos.y, wp.z, 2); } catch (e) { log_(`leg ${i + 1} threw: ${e && e.message || e}`); }

        const now = bot.entity && bot.entity.position;
        const moved = now ? Math.hypot(now.x - startPos.x, now.z - startPos.z) : 0;
        log_(`leg ${i + 1} ok=${ok} movedFromStart=${moved.toFixed(1)}b pos=${now ? `${Math.round(now.x)},${Math.round(now.y)},${Math.round(now.z)}` : '?'}`);

        // Stall guard: if two consecutive legs make no net progress, stop (don't grind the
        // body budget the way the patch layers did). The planner will be re-invoked later.
        if (Math.abs(moved - lastDist) < 1.5 && i > 0) { log_(`stalled at leg ${i + 1} (no net progress) — yielding`); break; }
        lastDist = moved;
    }

    const end = bot.entity && bot.entity.position;
    const movedTotal = end ? Math.hypot(end.x - startPos.x, end.z - startPos.z) : 0;
    const clearedDZ = dz && end ? Math.hypot(end.x - dz.cx, end.z - dz.cz) > (dz.r) : null;
    log_(`relocation done reached=${reached} movedTotal=${movedTotal.toFixed(1)}b clearedDeathZone=${clearedDZ} end=${end ? `${Math.round(end.x)},${Math.round(end.y)},${Math.round(end.z)}` : '?'}`);
    return { dryRun: false, plan, reached, movedTotal: +movedTotal.toFixed(1), clearedDeathZone: clearedDZ };
}

// Build the planEscape input snapshot from the live bot + supervisor telemetry.
function readState(bot, ctx) {
    const { mc } = ctx;
    const p = bot.entity && bot.entity.position;
    const pos = p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : { x: 0, y: 64, z: 0 };

    const hostiles = [];
    try {
        for (const e of Object.values(bot.entities || {})) {
            if (!e || e === bot.entity || !e.position || !mc.isHostile(e)) continue;
            hostiles.push({
                name: e.name || (e.mobType || '?'),
                x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z),
                d: +e.position.distanceTo(p).toFixed(1),
            });
        }
    } catch (e) {}

    let hasEdible = false;
    try {
        for (const it of bot.inventory.items()) {
            const f = mc.getItemFood && mc.getItemFood(it.name);
            if (f && f.foodPoints > 0) { hasEdible = true; break; }
        }
    } catch (e) {}

    let hasPickaxe = false;
    try { hasPickaxe = bot.inventory.items().some(it => /pickaxe/.test(it.name)); } catch (e) {}

    // Death-zone: read advisory.json if available (overseer maintains it); else null.
    let dzone = null;
    try {
        const adv = readAdvisory();
        if (adv && adv.dzone) dzone = adv.dzone;
    } catch (e) {}

    return {
        pos,
        hostiles,
        dzone,
        food: bot.food != null ? bot.food : 20,
        hp: bot.health != null ? bot.health : 20,
        hasPickaxe,
        hasEdible,
        tod: (bot.time && bot.time.timeOfDay != null) ? bot.time.timeOfDay : null,
    };
}

function readAdvisory() {
    // Best-effort read of the overseer advisory for the death-zone. Kept OUT of the pure
    // planner so planEscape() stays I/O-free. Returns null on any failure (fresh planner
    // then simply runs without a death-zone repulsion term).
    try {
        const abs = path.resolve(process.cwd(), 'bots', '_supervisor', 'advisory.json');
        return JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) { return null; }
}

export { planEscape };
