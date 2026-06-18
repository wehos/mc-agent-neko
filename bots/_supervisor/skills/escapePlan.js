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
// PURE TUNNEL GEOMETRY + SAFETY (offline-testable — the dangerous decisions live here)
// ---------------------------------------------------------------------------

// The feet-level cell sequence of a 1-wide tunnel from `start` along unit heading, n steps.
// CARDINAL-ONLY: each step moves exactly one block on a single axis (a staircase that
// approximates the heading), never diagonal — a diagonal step would need the corner block
// cleared too or the pathfinder/walker can't cut the corner. The accumulator picks the axis
// with the larger outstanding share each step, so the x:z ratio tracks the heading.
// Pure: deterministic from (start, heading, n).
function tunnelPath(start, heading, n) {
    const cells = [];
    let x = start.x, z = start.z;
    const ax = Math.abs(heading.x), az = Math.abs(heading.z);
    const sx = Math.sign(heading.x) || 0, sz = Math.sign(heading.z) || 0;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) {
        cx += ax; cz += az;
        if (sz === 0 || (sx !== 0 && cx >= cz)) { x += sx; cx -= 1; }   // step x
        else { z += sz; cz -= 1; }                                       // step z
        cells.push({ x, y: start.y, z });
    }
    return cells;
}

// Given the blocks read around a cell we're about to dig, is it safe to dig+step into?
// `reads`: { feet, head, floor, lavaAdjacent, headUnbreakable } (block names / booleans)
// Pure. Returns {safe, reason, needFloor}.
function cellSafety(reads) {
    const FLUID = /(lava|flowing_lava)/;
    if (reads.lavaAdjacent) return { safe: false, reason: 'lava adjacent to dig cell', needFloor: false };
    if (FLUID.test(reads.feet || '') || FLUID.test(reads.head || '')) return { safe: false, reason: 'dig cell is lava', needFloor: false };
    if (FLUID.test(reads.floor || '')) return { safe: false, reason: 'floor is lava', needFloor: false };
    if (reads.headUnbreakable) return { safe: false, reason: `head block ${reads.head} unbreakable`, needFloor: false };
    const floorIsAir = /^(air|cave_air|void_air|water|flowing_water)$/.test(reads.floor || 'air');
    return { safe: true, reason: 'ok', needFloor: floorIsAir };
}

// ---------------------------------------------------------------------------
// HOT-LOADABLE SKILL
//   default (no args / {execute:false})  -> DRY-RUN: compute + log the plan, never move.
//   {execute:true}                       -> EXECUTE: dig-tunnel out of the death-zone.
// ---------------------------------------------------------------------------

export default async function escapePlan(bot, ctx, opts = {}) {
    const { log } = ctx;
    // navTo mode: dig-navigate to an arbitrary target (descend + horizontal) when the generic
    // pathfinder fast-fails (sealed pocket / vertical shaft). This is the general dig-navigation
    // primitive the bot lacked (Phase B exposed: goToPosition 0s-NoPath from a pocket, and the
    // destructive planner won't carve a shaft down). Reuses the proven cellSafety/stepToCardinal.
    if (opts && opts.navTo) {
        return await runNavTo(bot, ctx, opts);
    }
    const execute = opts && opts.execute === true;
    const state = readState(bot, ctx);
    const plan = planEscape(state);
    log(bot, `[escapePlan${execute ? '' : ' DRY-RUN'}] action=${plan.action} target=${plan.target ? `${plan.target.x},${plan.target.z}` : 'none'} :: ${plan.reason}`);

    if (!execute || plan.action !== 'relocate_surface') {
        return { dryRun: !execute, plan, state: { pos: state.pos, food: state.food, hp: state.hp, hostiles: state.hostiles.length } };
    }

    // ---- EXECUTE: dig-tunnel out of the death-zone -------------------------
    // THE missing primitive: the stock pathfinder fast-fails NoPath when sealed in stone, so
    // we carve our own 1-wide tunnel along the escape heading. missionNether's KILL-BOX hold
    // is death-zone-gated, so simply clearing the death-zone radius dissolves the livelock —
    // no surface ascent needed. Every block is gated by the PURE cellSafety() check so we
    // never dig into / next to lava. The planner is the movement authority here: if a stale
    // MAROONED flag would veto stepping, we clear it (this is exactly the deadlock the refactor
    // exists to resolve — one owner of the body, not N silent vetoes).
    const dz = state.dzone;
    const startPos = { ...state.pos };
    const log_ = (m) => log(bot, `[escapePlan] ${m}`);
    const { Vec3 } = ctx;
    const MAX_STEPS = 22;
    const bn = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)); } catch (e) { return null; } };
    const name = (b) => (b && b.name) || 'air';
    const UNBREAKABLE = /(bedrock|barrier|obsidian|reinforced_deepslate|end_portal)/;

    let stepped = 0, reached = false, abortReason = null;
    for (let i = 0; i < MAX_STEPS; i++) {
        const live = readState(bot, ctx);
        // Re-decide each step: a fresh close hostile hands the body to the defense layer.
        if (planEscape(live).action === 'defer') { abortReason = 'defer (close actionable hostile)'; break; }
        if (dz && Math.hypot(live.pos.x - dz.cx, live.pos.z - dz.cz) > dz.r + 2) {
            reached = true; log_(`cleared death-zone at step ${i} (d>${dz.r})`); break;
        }
        // Next feet-cell one block along the heading.
        const cur = bot.entity.position;
        const cx = Math.round(cur.x), cy = Math.round(cur.y), cz = Math.round(cur.z);
        const next = tunnelPath({ x: cx, y: cy, z: cz }, plan.heading, 1)[0];

        // Gather block reads and run the PURE safety gate before touching anything.
        const feet = bn(next.x, cy, next.z), head = bn(next.x, cy + 1, next.z), floor = bn(next.x, cy - 1, next.z);
        let lavaAdjacent = false;
        for (const [dx, dy, dz2] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
            if (/lava/.test(name(bn(next.x + dx, cy + dy, next.z + dz2))) || /lava/.test(name(bn(next.x + dx, cy + 1 + dy, next.z + dz2)))) { lavaAdjacent = true; break; }
        }
        const safety = cellSafety({ feet: name(feet), head: name(head), floor: name(floor), lavaAdjacent, headUnbreakable: UNBREAKABLE.test(name(head)) || UNBREAKABLE.test(name(feet)) });
        if (!safety.safe) { abortReason = `unsafe cell ${next.x},${cy},${next.z}: ${safety.reason}`; break; }

        try {
            if (safety.needFloor) { await ctx.skills.placeBlock(bot, 'cobblestone', next.x, cy - 1, next.z, 'bottom', true); }
            await ctx.skills.breakBlockAt(bot, next.x, cy, next.z);       // feet
            await ctx.skills.breakBlockAt(bot, next.x, cy + 1, next.z);   // head
        } catch (e) { abortReason = `dig threw: ${e && e.message || e}`; break; }

        // Step into the cleared cardinal cell by LOW-LEVEL walk, not pathfinder: GoalNear(...,1)
        // counts an adjacent block as already-reached and won't move, and the MAROONED gate can
        // veto goToGoal entirely. Manual lookAt+forward is the planner taking direct body control
        // (the one-owner principle) and reliably advances one cardinal block over cleared floor.
        try {
            await stepToCardinal(bot, next.x, next.z, cy, Vec3);
        } catch (e) { /* fall through to advance check */ }

        const np = bot.entity.position;
        const adv = Math.hypot(np.x - cur.x, np.z - cur.z);
        stepped++;
        if (i % 3 === 0 || adv < 0.5) log_(`step ${i + 1} dug ${next.x},${cy},${next.z} adv=${adv.toFixed(1)} pos=${Math.round(np.x)},${Math.round(np.y)},${Math.round(np.z)} food=${live.food} hp=${live.hp}`);
        if (adv < 0.3) { abortReason = `no advance after dig at step ${i + 1} (pos ${Math.round(np.x)},${Math.round(np.y)},${Math.round(np.z)})`; break; }
    }

    const end = bot.entity && bot.entity.position;
    const movedTotal = end ? Math.hypot(end.x - startPos.x, end.z - startPos.z) : 0;
    const clearedDZ = dz && end ? Math.hypot(end.x - dz.cx, end.z - dz.cz) > dz.r : null;
    log_(`tunnel done reached=${reached} steps=${stepped} movedTotal=${movedTotal.toFixed(1)}b clearedDeathZone=${clearedDZ} abort=${abortReason || 'none'} end=${end ? `${Math.round(end.x)},${Math.round(end.y)},${Math.round(end.z)}` : '?'}`);
    return { dryRun: false, plan, reached, steps: stepped, movedTotal: +movedTotal.toFixed(1), clearedDeathZone: clearedDZ, abort: abortReason };
}

// Walk one cardinal block onto (tx,tz) at feet-level ty using DIRECT controls (not pathfinder).
// Used by digTunnel because GoalNear(...,1) treats an adjacent block as already-reached and the
// MAROONED gate can veto goToGoal. Looks at the cell center, holds forward up to ~2.5s, with a
// late jump-assist for a 1-block lip. Always releases controls in finally.
async function stepToCardinal(bot, tx, tz, ty, Vec3) {
    const cx = tx + 0.5, cz = tz + 0.5;
    try { await bot.lookAt(new Vec3(cx, ty + 1.6, cz), true); } catch (e) {}
    bot.setControlState('forward', true);
    const t0 = Date.now();
    let jumped = false;
    try {
        while (Date.now() - t0 < 2500) {
            const p = bot.entity.position;
            if (Math.hypot(p.x - cx, p.z - cz) < 0.35) break;
            if (!jumped && Date.now() - t0 > 800) {
                jumped = true; bot.setControlState('jump', true);
                setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) {} }, 250);
            }
            await new Promise(r => setTimeout(r, 100));
        }
    } finally {
        try { bot.setControlState('forward', false); bot.setControlState('jump', false); } catch (e) {}
    }
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

// ---------------------------------------------------------------------------
// GENERAL DIG-NAVIGATION (the EscapePlanner's real primitive: reach a target by carving
// when the stock pathfinder can't). Test-harness wrapper handles cheat setup + self-restore.
// ---------------------------------------------------------------------------

async function runNavTo(bot, ctx, opts) {
    const { log } = ctx;
    const VLOG = 'bots/_supervisor/verify.log';
    const L = (m) => { const line = `[${new Date().toISOString().slice(11, 19)}] [digNav] ${m}`; try { log(bot, line); } catch (e) {} try { fs.appendFileSync(VLOG, line + '\n'); } catch (e) {} };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const origDiff = (bot.game && bot.game.difficulty) || 'normal';
    const p0 = bot.entity.position;
    try {
        L(`navTo START target=${opts.navTo.x},${opts.navTo.y},${opts.navTo.z} from=${Math.round(p0.x)},${Math.round(p0.y)},${Math.round(p0.z)} diff=${origDiff}`);
        if (opts.peaceful) { bot.chat('/difficulty peaceful'); await sleep(1200); }
        for (const c of (opts.cmds || [])) { L(`cmd ${c}`); try { bot.chat(c); } catch (e) {} await sleep(700); }
        try { const pick = bot.inventory.items().find(i => /(diamond|iron|stone|golden|wooden)_pickaxe/.test(i.name)); if (pick) { await bot.equip(pick, 'hand'); L(`equipped ${pick.name}`); } else L('no pickaxe!'); } catch (e) { L(`equip err ${e && e.message}`); }
        try { if (bot._mobility && bot._mobility.state === 'MAROONED') bot._mobility.state = 'FREE'; } catch (e) {}
        const res = await digNavTo(bot, ctx, opts.navTo, L);
        L(`navTo DONE ${JSON.stringify(res)}`);
        return res;
    } catch (e) {
        L(`navTo THREW ${e && e.message || e}`);
        return { reached: false, error: String(e && e.message || e) };
    } finally {
        if (opts.peaceful) { try { bot.chat('/difficulty ' + origDiff); } catch (e) {} }
        try { fs.writeFileSync('bots/_supervisor/sticky_skill.json', JSON.stringify({ skill: 'missionNether', args: [] })); } catch (e) {}
    }
}

// Carve a route to `target` {x,y,z}. Two phases, re-evaluated each step:
//   DESCEND  (cy > target.y+1): dig the block under the feet and drop 1, with a 3-deep lava
//            look-ahead. Hitting an air gap = a cave was reached (success for "get underground").
//   HORIZONTAL: cardinal 1-wide tunnel toward (target.x,target.z), gated by cellSafety, stepped
//            by the manual stepToCardinal (the proven walker). Places a cobble floor over gaps.
// Returns {reached, steps, abort?, cave?, end}. Pure-ish executor; all danger gated.
async function digNavTo(bot, ctx, target, L) {
    const { Vec3 } = ctx;
    const bn = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)); } catch (e) { return null; } };
    const nm = (b) => (b && b.name) || 'air';
    const UNBREAKABLE = /(bedrock|barrier|obsidian|reinforced_deepslate|end_portal|end_gateway)/;
    const LAVA = /lava/;
    const isAir = (b) => /^(air|cave_air|void_air)$/.test(nm(b));
    const MAX = 160;
    let steps = 0, abort = null, cave = false, stallN = 0;

    for (let i = 0; i < MAX; i++) {
        // ★Suppress the mobility reflex's tick-veto: chopWood sets this heartbeat so the mobility
        // state machine doesn't classify a deliberate vertical dig as MAROONED/POCKET and grab the
        // body (clearControlStates/guardedDig) every tick, which carpet-bombs our stepToCardinal.
        try { bot._climbingAt = Date.now(); } catch (e) {}
        const p = bot.entity.position;
        // ★Block coords are FLOOR of the entity position, NOT round: the bot stands at block
        // CENTER (x.5, z.5), so Math.round(151.5)=152 / Math.round(-9.5)=-9 point one block OFF —
        // we were digging the block NEXT TO the feet, not under them, so the bot never dropped.
        const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z);
        const dy = cy - target.y;
        const dxz = Math.hypot(target.x - cx, target.z - cz);
        if (Math.abs(dy) <= 1 && dxz <= 2) { return { reached: true, steps, end: { x: cx, y: cy, z: cz } }; }

        if (dy > 1) {
            // DESCEND by DELEGATING to branchMine(length, targetY) — the PROVEN descent (achieve uses
            // it). It digs a 1x2 DIAGONAL staircase (down+forward, so there's always a forward cell to
            // walk into) and handles gravity/step/tool/lava/stepEdgeAssist. Hand-rolling a straight-down
            // dig was a dead end: digging the block under the feet does NOT reliably drop the bot
            // (mineflayer support/position edge cases — mineDown.js hit the same no-op). Don't reinvent.
            const yBefore = cy;
            L(`descend: delegate to branchMine(targetY=${target.y}) from y${cy}`);
            try { await ctx.skills.customSkill(bot, 'branchMine', Math.max(10, Math.min(40, dy + 6)), target.y); }
            catch (e) { abort = `branchMine threw: ${e && e.message}`; break; }
            const ny = Math.floor(bot.entity.position.y);
            steps++;
            L(`descend via branchMine: y${yBefore}->${ny} (target y${target.y})`);
            if (ny >= yBefore - 1) { if (++stallN >= 2) { abort = `branchMine didn't descend (y${ny}) ×2`; break; } }
            else stallN = 0;
            continue; // re-eval: if still above target.y, branchMine again (it may stop early on ore/cave)
        }

        // HORIZONTAL: one cardinal step toward target on the dominant axis.
        const ddx = target.x - cx, ddz = target.z - cz;
        let stepX = 0, stepZ = 0;
        if (Math.abs(ddx) >= Math.abs(ddz) && ddx !== 0) stepX = Math.sign(ddx);
        else if (ddz !== 0) stepZ = Math.sign(ddz);
        else if (ddx !== 0) stepX = Math.sign(ddx);
        const nx = cx + stepX, nz = cz + stepZ;
        const feet = bn(nx, cy, nz), head = bn(nx, cy + 1, nz), floor = bn(nx, cy - 1, nz);
        let lavaAdjacent = false;
        for (const [ax, ay, az] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
            if (LAVA.test(nm(bn(nx + ax, cy + ay, nz + az))) || LAVA.test(nm(bn(nx + ax, cy + 1 + ay, nz + az)))) { lavaAdjacent = true; break; }
        }
        const safety = cellSafety({ feet: nm(feet), head: nm(head), floor: nm(floor), lavaAdjacent, headUnbreakable: UNBREAKABLE.test(nm(head)) || UNBREAKABLE.test(nm(feet)) });
        if (!safety.safe) { abort = `unsafe ${nx},${cy},${nz}: ${safety.reason}`; break; }
        try {
            if (safety.needFloor) await ctx.skills.placeBlock(bot, 'cobblestone', nx, cy - 1, nz, 'bottom', true);
            await ctx.skills.breakBlockAt(bot, nx, cy, nz);
            await ctx.skills.breakBlockAt(bot, nx, cy + 1, nz);
        } catch (e) { abort = `horiz dig threw: ${e && e.message}`; break; }
        try { await stepToCardinal(bot, nx, nz, cy, Vec3); } catch (e) {}
        const np = bot.entity.position;
        const adv = Math.hypot(np.x - cx, np.z - cz);
        steps++;
        if (i % 5 === 0 || adv < 0.5) L(`horiz ${i}: dug ${nx},${cy},${nz} adv=${adv.toFixed(1)} pos=${Math.round(np.x)},${Math.round(np.y)},${Math.round(np.z)} dxz=${dxz.toFixed(0)}`);
        if (adv < 0.3) { abort = `no advance at step ${i} (${Math.round(np.x)},${Math.round(np.y)},${Math.round(np.z)})`; break; }
    }
    const e = bot.entity.position;
    return { reached: false, steps, cave, abort, end: { x: Math.round(e.x), y: Math.round(e.y), z: Math.round(e.z) } };
}

export { planEscape, tunnelPath, cellSafety, digNavTo };
