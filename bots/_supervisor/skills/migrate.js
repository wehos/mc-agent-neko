// migrate — CROSS-CONTINENT RELOCATION to escape an unlivable spawn (ocean food-desert)
// and SETTLE at a good home (land animals + trees + plains/forest biome).
//
// WHY THIS EXISTS (user's correction): a human in a bad spawn does NOT sit and starve, nor
// wait for someone to swap the world — they WALK OUT hundreds of blocks in ONE consistent
// direction until they hit livable land (cows/pigs/sheep, trees, a plains/forest biome), then
// plant a bed there. forageExplore (maxBlocks~160, bearing reset each leg = circles the desert)
// is "buy groceries"; migrate is "move house". This encodes that human decision.
//
// HARD SAFETY (the explore-and-die lesson — peaceful does NOT stop drowning/lava/falls):
//   - daylight + hp>=gateHp + food>=gateFood to START; per-leg re-gate (night->prepNether
//     bunker & resume at dawn; close hostile / hp-drop / food-floor -> break & return).
//   - self_preservation tick reflex (modes.js) runs THROUGHOUT goToPosition: drown/burn/fall/
//     night-bunker are handled by the body's own instincts; migrate only steers.
//   - cancellable: breaks on bot.interrupt_code (cancel_skill or a mobility reflex emergency),
//     mirroring branchMine — NOT by clearing the flag (that would make an 8-min march un-stoppable).
//
// opts: { maxBlocks=800, legBlocks=24, gateHp=14, gateFood=12, abortHp=8, legFoodFloor=7,
//         settleScore=14, maxMs=480000, jitterDeg=0, cooldownMin=20, force=false }
//
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';

const SUP = path.resolve(process.cwd(), 'bots', '_supervisor');
const ADVISORY = path.join(SUP, 'advisory.json');
const DEATHLOG = path.join(SUP, 'death_log.jsonl');
const BEDF = path.join(SUP, 'bed.json');
const MSTATE = path.join(SUP, 'migrate_state.json');
// Real-time debug log (appendFileSync, unbuffered & tailable) — the in-skill log() goes to the
// agent console only, and migrate runs NESTED inside missionNether so it produces no events.log
// skill_result. This file is the supervisor's one window into the march (leg-by-leg + verdict).
const MIGRATELOG = path.join(SUP, 'migrate.log');
const dbg = (s) => { try { fs.appendFileSync(MIGRATELOG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

const LAND_HUNT = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat'];
const NIGHT_START = 13000, NIGHT_END = 23000;

// ---------------------------------------------------------------------------
// PURE helpers (offline-testable — no bot, no I/O)
// ---------------------------------------------------------------------------

// Biome habitability: plains/forest/savanna/taiga/meadow are great (animals+trees);
// water/beach/river are the food-desert we're fleeing. Returns a signed score term.
function biomeScore(biome) {
    const b = (biome || '').toLowerCase();
    if (/ocean|river|beach|shore|deep_/.test(b)) return -12;
    if (/(^|_)(plains|meadow|savanna|forest|taiga|grove|birch|flower)/.test(b)) return 10;
    if (/(jungle|swamp|sparse|mangrove|cherry)/.test(b)) return 6;   // livable but trickier
    if (/(desert|badlands|stony|peaks|snowy|ice|frozen|wooded_badlands)/.test(b)) return -4;
    return 0;   // unknown/neutral
}

// Habitability score for a sampled site. Land animals are decisive (sustainable food),
// then biome, trees, grass; death-heat is a strong penalty (don't settle a kill-zone).
// PURE: takes a plain {biome, landAnimals, trees, grass, deathsNear}.
function siteScore(s) {
    const a = s || {};
    return biomeScore(a.biome)
        + Math.min(a.landAnimals || 0, 3) * 4
        + Math.min(a.trees || 0, 6)
        + ((a.grass || 0) > 0 ? 2 : 0)
        - (a.deathsNear || 0) * 5;
}

// Is this site good enough to STOP and settle? Needs visible land food AND a non-water biome
// AND a passing total score. PURE.
function isSettleSite(s, settleScore) {
    const a = s || {};
    const waterBiome = /ocean|river|beach|shore/.test((a.biome || '').toLowerCase());
    return (a.landAnimals || 0) >= 2 && !waterBiome && siteScore(a) >= (settleScore ?? 14);
}

function norm2(x, z) {
    const m = Math.hypot(x, z);
    return m < 1e-6 ? { x: 0, z: 0, m: 0 } : { x: x / m, z: z / m, m };
}

// Lock ONE consistent bearing for the whole journey (the crux vs forageExplore, which
// recomputes per-leg and circles the desert). Away from the death-zone centroid, else away
// from a remembered barren centroid, else +x. Optional small deterministic jitter so repeated
// migrations don't retread the exact same line. PURE.
function migrateBearing(pos, dzone, barrenCentroid, jitterDeg) {
    let rx = 0, rz = 0;
    if (dzone && (dzone.cx != null)) { const r = norm2(pos.x - dzone.cx, pos.z - dzone.cz); rx += r.x; rz += r.z; }
    if (barrenCentroid && (barrenCentroid.x != null)) { const r = norm2(pos.x - barrenCentroid.x, pos.z - barrenCentroid.z); rx += r.x; rz += r.z; }
    let h = norm2(rx, rz);
    if (h.m === 0) h = { x: 1, z: 0, m: 1 };
    if (jitterDeg) {
        const a = (jitterDeg * Math.PI) / 180;
        const ca = Math.cos(a), sa = Math.sin(a);
        h = { x: h.x * ca - h.z * sa, z: h.x * sa + h.z * ca, m: 1 };
    }
    return { x: h.x, z: h.z };
}

// Decide whether a cross-continent migration is warranted. PURE — takes accumulated signals.
//   signals: { oceanStreak, noAnimalStreak, foodDeathsClustered, insideDeathZone,
//              hp, food, isNight, actionableClose, msSinceLastMigrate, cooldownMs,
//              gateHp, gateFood, force }
// Returns {go, reason}.
function shouldMigrate(signals) {
    const s = signals || {};
    if (s.force) return { go: true, reason: 'force=true (manual / last-resort)' };
    if (s.isNight) return { go: false, reason: 'night — do not start a long march (bunker)' };
    if (s.actionableClose) return { go: false, reason: 'actionable hostile close — handle threat first' };
    if (s.hp < (s.gateHp ?? 14)) return { go: false, reason: `hp=${s.hp} < ${s.gateHp ?? 14} — too fragile to migrate` };
    if (s.food < (s.gateFood ?? 12)) return { go: false, reason: `food=${s.food} < ${s.gateFood ?? 12} — too low for a long march` };
    if ((s.msSinceLastMigrate ?? Infinity) < (s.cooldownMs ?? 1200000))
        return { go: false, reason: `migrated ${Math.round((s.msSinceLastMigrate || 0) / 60000)}min ago < cooldown — give the new area a chance` };
    // Unlivable evidence: EITHER a confirmed food desert (ocean biome / streaks) OR we keep
    // dying clustered here (a human who's died 3+ times in one region relocates regardless of
    // biome). Either alone is sufficient — staying is the proven-fatal choice.
    const desert = (s.oceanStreak || 0) >= 3 || (s.noAnimalStreak || 0) >= 4 || s.currentOcean === true;
    const diedHere = !!(s.foodDeathsClustered || s.insideDeathZone);
    if (!desert && !diedHere)
        return { go: false, reason: `no unlivable evidence (oceanStreak=${s.oceanStreak} noAnimalStreak=${s.noAnimalStreak} currentOcean=${s.currentOcean} diedHere=${diedHere}) — let forageExplore try first` };
    return { go: true, reason: `unlivable: desert=${desert}(ocean=${s.currentOcean} streak=${s.oceanStreak}/${s.noAnimalStreak}) diedHere=${diedHere} hp=${s.hp} food=${s.food} — relocate cross-continent` };
}

// ---------------------------------------------------------------------------
// I/O helpers (kept OUT of the pure layer)
// ---------------------------------------------------------------------------
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function readMState() { return readJSON(MSTATE) || { oceanStreak: 0, noAnimalStreak: 0, lastMigrateAt: 0, barren: null }; }
function writeMState(s) { try { fs.writeFileSync(MSTATE, JSON.stringify(s)); } catch (e) {} }

function readRecentDeaths(n = 60) {
    try {
        return fs.readFileSync(DEATHLOG, 'utf8').trim().split('\n').slice(-n)
            .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(r => r && typeof r.x === 'number');
    } catch (e) { return []; }
}

// ---------------------------------------------------------------------------
// HOT-LOADABLE SKILL
// ---------------------------------------------------------------------------
export default async function migrate(bot, ctx, opts = {}) {
    const { log, skills, world } = ctx;
    const log_ = (m) => { log(bot, `[migrate] ${m}`); dbg(m); };

    const maxBlocks = opts.maxBlocks || 800;
    const legBlocks = opts.legBlocks || 24;
    const gateHp = opts.gateHp ?? 14, gateFood = opts.gateFood ?? 6;
    // legFoodFloor=1: a human hungry in a FOOD DESERT does NOT sit and starve — staying =
    // guaranteed starvation, leaving = a chance at food. So commit to the march even hungry.
    // SAFETY is abortHp (=8), which is difficulty-robust: on easy, starvation floors hp at 10
    // (>8) so the full journey proceeds; on normal/hard, food→0 drops hp past 8 → abortHp aborts
    // BEFORE a starvation death. Opportunistic forage still tops up en route when food is found.
    const abortHp = opts.abortHp ?? 8, legFoodFloor = opts.legFoodFloor ?? 1;
    const settleScore = opts.settleScore ?? 14;
    const maxMs = opts.maxMs ?? 480000;

    const isNight = () => { try { const t = bot.time.timeOfDay; return t > NIGHT_START && t < NIGHT_END; } catch { return false; } };
    const closeActionable = () => {
        try {
            return Object.values(bot.entities || {}).some(e =>
                e && e !== bot.entity && e.position && ctx.mc.isHostile(e)
                && e.position.distanceTo(bot.entity.position) < 8);
        } catch { return false; }
    };
    const edibleHeld = () => {
        try { return bot.inventory.items().some(i => /cooked_|_bread|^bread$|^apple$|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|^cod$|^salmon$|melon_slice|sweet_berries|_stew|^rabbit$|baked_/.test(i.name) && i.name !== 'rotten_flesh'); }
        catch { return false; }
    };
    const inFluid = () => {
        try {
            const p = bot.entity.position.floored();
            for (const dy of [0, 1]) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && /water|lava/.test(b.name || '')) return true; }
        } catch (e) {} return false;
    };
    const curBiome = () => { try { return world.getBiomeName(bot); } catch (e) { return 'unknown'; } };
    // Sample habitability at the CURRENT position (chunks are loaded after we walk here).
    const sampleSite = () => {
        const p = bot.entity.position;
        const biome = curBiome();
        let landAnimals = 0;
        try {
            for (const e of Object.values(bot.entities || {})) {
                if (e && e.position && LAND_HUNT.includes((e.name || '').toLowerCase())
                    && e.position.distanceTo(p) < 48) landAnimals++;
            }
        } catch (e) {}
        let trees = 0, grass = 0;
        try { trees = (world.getNearestBlocks(bot, ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'], 40, 30) || []).length; } catch (e) {}
        try { grass = (world.getNearestBlocks(bot, ['grass_block', 'short_grass', 'tall_grass'], 24, 8) || []).length; } catch (e) {}
        const deaths = readRecentDeaths();
        const deathsNear = deaths.filter(d => Math.hypot(d.x - p.x, d.z - p.z) < 24).length;
        return { biome, landAnimals, trees, grass, deathsNear, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    };

    // ---- START GATE (re-confirm the human "this place is unlivable" decision) ----
    const mstate = readMState();
    const adv = readJSON(ADVISORY);
    const dzone = adv && adv.dzone ? adv.dzone : null;
    const pos0 = bot.entity.position.clone();
    const insideDeathZone = !!(dzone && Math.hypot(pos0.x - dzone.cx, pos0.z - dzone.cz) <= (dzone.r || 0));
    const deaths = readRecentDeaths();
    // food-death proxy: deaths clustered near us (the spawn we keep dying at). The death log
    // doesn't always carry a cause field, so ">=3 deaths within 40b of here" == we keep dying here.
    const foodDeathsClustered = deaths.filter(d => Math.hypot(d.x - pos0.x, d.z - pos0.z) < 80).length >= 3;
    const currentOcean = /ocean|river|beach|shore/.test(curBiome().toLowerCase());

    const decision = shouldMigrate({
        oceanStreak: mstate.oceanStreak, noAnimalStreak: mstate.noAnimalStreak, currentOcean,
        foodDeathsClustered, insideDeathZone,
        hp: Math.round(bot.health), food: bot.food,
        isNight: isNight(), actionableClose: closeActionable(),
        msSinceLastMigrate: Date.now() - (mstate.lastMigrateAt || 0),
        cooldownMs: (opts.cooldownMin ?? 20) * 60000,
        gateHp, gateFood, force: opts.force === true,
    });
    log_(`gate: ${decision.reason}`);
    if (!decision.go) return { migrated: false, reason: decision.reason };

    // ---- LOCK BEARING (consistent direction for the whole journey) ----
    const bearing = migrateBearing(
        { x: Math.round(pos0.x), z: Math.round(pos0.z) },
        dzone, mstate.barren, opts.jitterDeg || 0);
    log_(`★MIGRATE start @${Math.round(pos0.x)},${Math.round(pos0.z)} biome=${curBiome()} bearing=${bearing.x.toFixed(2)},${bearing.z.toFixed(2)} maxBlocks=${maxBlocks}`);

    // If we START enclosed (a night-bunker / dug pocket), surface FIRST — goToPosition can't
    // path horizontally out of a sealed pocket (the same limit forageExplore hits; observed in
    // the first force-test: bot stayed put at 5,79 because it began inside its night bunker).
    try {
        const p = bot.entity.position.floored();
        let covered = !!(bot._mobility && (bot._mobility.enclosed || /POCKET|ENTOMBED/.test(bot._mobility.state || '')));
        for (let dy = 1; dy <= 4 && !covered; dy++) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && b.boundingBox === 'block' && !/leaves|log/.test(b.name || '')) covered = true; }
        if (covered) {
            const sy = Math.round(pos0.y) + 6;
            log_(`enclosed at start → surfaceUp(${sy}) to clear overhead before marching`);
            try { await skills.customSkill(bot, 'surfaceUp', sy); } catch (e) { log_(`start-surfaceUp err: ${e && e.message || e}`); }
        }
    } catch (e) {}

    const t0 = Date.now();
    let best = null, settled = false, settleSite = null, abort = null;
    let waterStreak = 0, stalls = 0, totalAdv = 0;
    let waterLegs = 0;   // ★CUMULATIVE water legs (NOT reset on turn) — detects an open-ocean crossing

    // ★TRAVERSAL ROBUSTNESS (C222): the old single goToPosition(24b, GoalNear 3D) per leg stalled
    // at ~27b. ROOT CAUSE: goToGoal's getPathTo has a 1s plan budget that frequently FAILS to plan
    // a full 24-block 3D path over rough/coastal terrain, throwing PathfindingNoPlan with ZERO
    // advance — and two such throws aborted the entire march. Three fixes:
    //   (1) HOP-MARCH — subdivide each leg into short HOP-block goToPosition calls the planner CAN
    //       solve in 1s (terrain-following y per hop), instead of one ambitious 24b 3D target.
    //   (2) MULTI-TURN recovery — on a stalled leg, rotate through a FAN of bearing offsets
    //       (±30/60/90/130/180°) off the locked bearing to route around peninsulas/mountains/
    //       inlets, not the old single 25° nudge that gave up after 2 stalls.
    //   (3) RELATIVE stepping — hop target = current pos + bearing*HOP (not origin+bearing*leg*i),
    //       so a mid-journey turn doesn't teleport the target into already-failed terrain.
    const HOP = 8;
    const TURNS = [0, 30, -30, 60, -60, 90, -90, 130, -130, 180];
    let turnIdx = 0;
    const rot = (b, deg) => { const a = (deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a); return { x: b.x * ca - b.z * sa, z: b.x * sa + b.z * ca }; };
    const base = { x: bearing.x, z: bearing.z };
    let cur = { x: bearing.x, z: bearing.z };

    for (let leg = 1; totalAdv < maxBlocks && leg <= 400; leg++) {
        if (Date.now() - t0 > maxMs) { abort = `time budget ${Math.round(maxMs / 1000)}s exhausted at leg ${leg} (adv=${Math.round(totalAdv)}b)`; break; }
        // Cancellable + yields to mobility reflex emergencies (POCKET/ENTOMBED) — mirror branchMine.
        if (bot.interrupt_code) { abort = `interrupted (cancel/reflex) at leg ${leg}`; break; }

        // ---- per-leg SAFETY re-gate ----
        if (isNight()) {
            // Don't quit — bunker for the night (reuse prepNether's holeUpAtNight), then resume.
            log_(`leg ${leg}: night fell → prepNether bunker, resume at dawn`);
            try { await skills.customSkill(bot, 'prepNether'); } catch (e) { log_(`night bunker threw: ${e && e.message || e}`); }
            try { await skills.wait(bot, 3000); } catch (e) {}
            if (isNight()) { try { await skills.wait(bot, 4000); } catch (e) {} }
            leg--;                      // don't consume a travel leg on a night spent bunkering
            continue;
        }
        if (closeActionable()) { abort = `actionable hostile at leg ${leg} — yield to defense/EVAC`; break; }
        if (Math.round(bot.health) <= abortHp) { abort = `hp=${Math.round(bot.health)} <= ${abortHp} at leg ${leg}`; break; }
        if (bot.food < legFoodFloor && !edibleHeld()) {
            // Top up before marching the last food away (forage budget lesson). One bounded try.
            log_(`leg ${leg}: food=${bot.food} < floor ${legFoodFloor} no edible → forage top-up`);
            try { await skills.customSkill(bot, 'forage', { targetFood: 14 }); } catch (e) {}
            if (bot.food < legFoodFloor && !edibleHeld()) { abort = `food=${bot.food} unsustainable at leg ${leg} — return, don't march starving`; break; }
        }

        // ---- evaluate CURRENT site (chunks loaded here) ----
        const site = sampleSite();
        const score = siteScore(site);
        if (!best || score > best.score) best = { ...site, score };
        if (isSettleSite(site, settleScore)) {
            settled = true; settleSite = { ...site, score };
            log_(`★ARRIVED livable land @${site.x},${site.z} biome=${site.biome} animals=${site.landAnimals} trees=${site.trees} score=${score} — settle here`);
            break;
        }
        // water-drift: ending legs in/over open water counts toward a turn even when ADVANCING (a
        // straight march into open ocean "progresses" every leg but never finds land).
        const inWater = inFluid() || /ocean|river/.test((site.biome || '').toLowerCase());
        waterStreak = inWater ? waterStreak + 1 : 0;
        if (inWater) waterLegs++;
        // ★HARD OCEAN-ABORT (#33 drowning root): turning the bearing can't escape an open ocean —
        // every direction is water, so the old logic kept advancing+turning ~600b deep into the
        // sea (live: 637b march to -750, then a wet-bunker at night → drowned). Cap CUMULATIVE
        // water legs: once we've crossed too much open water, STOP marching and (after the loop)
        // walk back to the last land seen (`best` scores land > ocean), rather than drown mid-sea.
        if (waterLegs >= 7) { abort = `open-ocean crossing (${waterLegs} water legs, totalAdv=${Math.round(totalAdv)}b) — abort + return to land, don't drown mid-ocean`; break; }

        // ---- advance ONE leg via short, reliably-plannable hops along the current bearing ----
        try { if (bot._mobility && bot._mobility.state === 'MAROONED') { bot._mobility.state = 'FREE'; log_('cleared MAROONED — migrate owns movement'); } } catch (e) {}
        const before = bot.entity.position.clone();
        let legAdv = 0;
        for (let h = 0; h * HOP < legBlocks; h++) {
            if (bot.interrupt_code || Date.now() - t0 > maxMs) break;
            if (isNight() || closeActionable() || Math.round(bot.health) <= abortHp) break;   // bail to outer gates
            const hx = Math.round(bot.entity.position.x + cur.x * HOP);
            const hz = Math.round(bot.entity.position.z + cur.z * HOP);
            const hb = bot.entity.position.clone();
            try { await skills.goToPosition(bot, hx, Math.round(bot.entity.position.y), hz, 2); }
            catch (e) { /* PathfindingNoPlan etc — handled as a stalled hop below */ }
            const d = bot.entity.position.distanceTo(hb);
            legAdv += d;
            if (d < HOP * 0.4) break;    // this hop made no headway → stop hopping, let outer recovery turn
        }
        totalAdv += legAdv;
        const stalled = legAdv < legBlocks * 0.35;
        if (leg % 4 === 1 || stalled)
            log_(`leg ${leg} adv=${legAdv.toFixed(0)}b total=${Math.round(totalAdv)}b @${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.z)} (hp=${Math.round(bot.health)} food=${bot.food} biome=${site.biome} score=${score} bearing=${cur.x.toFixed(2)},${cur.z.toFixed(2)})`);

        // ---- recovery: rotate bearing on a stalled leg OR persistent water-drift ----
        if (stalled || waterStreak >= 3) {
            stalls++;
            turnIdx++;
            if (turnIdx < TURNS.length) {
                cur = rot(base, TURNS[turnIdx]);
                waterStreak = 0;
                log_(`leg ${leg}: ${stalled ? `stalled (adv=${legAdv.toFixed(0)}b)` : `water-drift`} — try bearing offset ${TURNS[turnIdx]}° -> ${cur.x.toFixed(2)},${cur.z.toFixed(2)}`);
            } else {
                abort = `exhausted ${TURNS.length} bearings (stalls=${stalls}, totalAdv=${Math.round(totalAdv)}b) at leg ${leg} — settle best-seen`;
                break;
            }
        } else {
            stalls = 0;                 // good progress on this heading — keep it
        }
    }

    // ★OCEAN-ABORT RETURN: if we bailed mid-ocean, walk back to the last LAND seen (best scores
    // land > water) so we settle/bed on solid ground instead of in the sea. Bounded; on failure
    // we're no worse off than the abort spot.
    if (abort && /open-ocean/.test(abort) && best && Number.isFinite(best.x)) {
        log_(`ocean-abort → walk back to last land @${best.x},${best.z} (score=${best.score})`);
        try {
            await Promise.race([
                skills.goToPosition(bot, best.x, Math.max(60, Math.round(best.y || 64)), best.z, 3),
                new Promise((_, rej) => setTimeout(() => rej(new Error('return-timeout')), 90000)),
            ]);
        } catch (e) { log_(`ocean-abort return err: ${e && e.message || e}`); }
    }

    // ---- SETTLE (write the anchor FIRST, then setBed builds the home here) ----
    const target = settleSite || best || sampleSite();
    const reachedGood = settled || (best && isSettleSite(best, settleScore));
    try {
        // Overwrite bed.json so setBed's own remote site-selector keeps the home HERE
        // (without this, auto-site-select's far-ring candidates would walk the bot away again).
        const hy = Math.max(60, Math.min(95, Math.floor(bot.entity.position.y)));
        fs.writeFileSync(BEDF, JSON.stringify({
            x: target.x, y: hy, z: target.z, t: Date.now(),
            src: 'migrate', score: target.score ?? siteScore(target),
            biome: target.biome, animals: target.landAnimals, trees: target.trees,
        }));
        log_(`anchor written @${target.x},${target.z} (score=${target.score ?? '?'} biome=${target.biome}) — invoking setBed`);
    } catch (e) { log_(`anchor write err: ${e && e.message || e}`); }

    let bedOk = false;
    try { bedOk = await skills.customSkill(bot, 'setBed'); } catch (e) { log_(`setBed threw: ${e && e.message || e}`); }

    // ---- persist outcome + reset streaks (we acted; give the new area a chance) ----
    // ★COOLDOWN-ON-STALL FIX (C222): impose the FULL cooldown only when we actually relocated a real
    // distance (or settled). A run that stalled at ~27b must NOT lock out retries for 20min and
    // strand the bot — a short/stalled run backdates lastMigrateAt so the next attempt (bearing-fan
    // resuming from a fresh sample) becomes eligible again in STALL_RETRY_MS.
    try {
        const ns = readMState();
        const movedReal = Math.round(bot.entity.position.distanceTo(pos0));
        const cooldownMs = (opts.cooldownMin ?? 20) * 60000;
        const STALL_RETRY_MS = 3 * 60000;
        const fullCooldown = reachedGood || movedReal >= 150;
        ns.lastMigrateAt = fullCooldown ? Date.now() : (Date.now() - Math.max(0, cooldownMs - STALL_RETRY_MS));
        ns.oceanStreak = 0; ns.noAnimalStreak = 0;
        // remember where we LEFT as a barren centroid, so a future migration heads further out.
        ns.barren = { x: Math.round(pos0.x), z: Math.round(pos0.z), t: Date.now() };
        writeMState(ns);
        log_(`persist: movedReal=${movedReal}b cooldown=${fullCooldown ? `full ${opts.cooldownMin ?? 20}min` : `short ${STALL_RETRY_MS / 60000}min (stalled)`}`);
    } catch (e) {}

    const movedTotal = Math.round(bot.entity.position.distanceTo(pos0));
    const r = {
        migrated: true, settled: reachedGood, bedOk,
        movedBlocks: movedTotal, end: { x: target.x, y: Math.round(bot.entity.position.y), z: target.z },
        site: target, abort,
        reason: reachedGood ? 'settled at livable land' : (abort || 'maxBlocks reached — settled best-seen'),
    };
    log_(`★MIGRATE DONE ${JSON.stringify(r)}`);
    return r;
}

export { migrate, shouldMigrate, migrateBearing, siteScore, isSettleSite, biomeScore };
