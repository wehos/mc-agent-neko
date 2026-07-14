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

// ★2026-07-09 用户令 HP/食物本能熔断: 这两个闸门直读 process.env, 控"因低血/因饿"行为;
// 任一/双闸开(=== '1')恢复原行为, 默认关(!= '1', 含未设)时相应低血/低饿分支变惰性。
const _hpOn   = () => process.env.MC_HP_INSTINCTS   === '1';
const _foodOn = () => process.env.MC_FOOD_INSTINCTS === '1';

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
    // ★C323-A (T-0059, 用户实证 desert husk 死循环 deaths0→7 全甲也磨死): desert/badlands 是 HUSK
    // 死亡陷阱——husk 日光免疫(白天也杀),裸/半甲被持续群压必死。旧 -4 太弱:沙漠有兔子(animals≥2)+
    // grass 把 siteScore 推到≥0 → 过 C325 targetSafe → 锚进 husk 沙漠。提到 -12(同 water 死亡陷阱级),
    // 让 siteScore 必为负 → targetSafe 否决 → 不锚沙漠 → setBed 自选非沙漠安全家。stony/雪/冰无 husk,
    // 仍 -4(harsh 但非死亡陷阱)。
    if (/(desert|badlands)/.test(b)) return -12;   // ★husk death-trap (day-immune mobs) — never anchor home here
    if (/(stony|peaks|snowy|ice|frozen)/.test(b)) return -4;
    return 0;   // unknown/neutral
}

// Habitability score for a sampled site. Land animals are decisive (sustainable food),
// then biome, trees, grass; death-heat is a strong penalty (don't settle a kill-zone).
// PURE: takes a plain {biome, landAnimals, trees, grass, deathsNear}.
function siteScore(s) {
    const a = s || {};
    return biomeScore(a.biome)
        + Math.min(a.landAnimals || 0, 3) * 4
        + Math.min((a.reachableTrees != null ? a.reachableTrees : a.trees) || 0, 6)   // ★C324: REACHABLE trees only (plateau-top visible trees don't count)
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
    // ★2026-07-09 用户令 HP/食物本能熔断: 低血/低饿 no-go start-gate; 任一闸开恢复。
    if (_hpOn() && s.hp < (s.gateHp ?? 14)) return { go: false, reason: `hp=${s.hp} < ${s.gateHp ?? 14} — too fragile to migrate` };
    if (_foodOn() && s.food < (s.gateFood ?? 12)) return { go: false, reason: `food=${s.food} < ${s.gateFood ?? 12} — too low for a long march` };
    if ((s.msSinceLastMigrate ?? Infinity) < (s.cooldownMs ?? 1200000))
        return { go: false, reason: `migrated ${Math.round((s.msSinceLastMigrate || 0) / 60000)}min ago < cooldown — give the new area a chance` };
    // Unlivable evidence: EITHER a confirmed food desert (ocean biome / streaks) OR we keep
    // dying clustered here (a human who's died 3+ times in one region relocates regardless of
    // biome). Either alone is sufficient — staying is the proven-fatal choice.
    const desert = (s.oceanStreak || 0) >= 3 || (s.noAnimalStreak || 0) >= 4 || s.currentOcean === true;
    const diedHere = !!(s.foodDeathsClustered || s.insideDeathZone);
    // ★C309 (T-0042): woodless-bootstrap deadlock is a THIRD kind of unlivable. The old gate had
    // only a FOOD dimension (ocean/no-animal) and a death-cluster dimension — NO wood/tree
    // dimension. A pickless bot in a treeless desert (0 reachable logs, 0 wood in inv) can never
    // progress wood→table→pickaxe HERE no matter how healthy, so it thrashes forever (live 18:38:
    // hp20/food20/picks0, chopDBG nearest=NONE, cycling prepNether→chop(none)→swim). Treat a
    // CONFIRMED woodless-bootstrap (caller's noTreeStreak>=2, so one scan-miss can't fire a march)
    // as unlivable → relocate to a tree-bearing biome.
    const bootstrapStuck = !!s.bootstrapStuck;
    if (!desert && !diedHere && !bootstrapStuck)
        return { go: false, reason: `no unlivable evidence (oceanStreak=${s.oceanStreak} noAnimalStreak=${s.noAnimalStreak} currentOcean=${s.currentOcean} diedHere=${diedHere} bootstrapStuck=${bootstrapStuck}) — let forageExplore try first` };
    return { go: true, reason: `unlivable: desert=${desert}(ocean=${s.currentOcean} streak=${s.oceanStreak}/${s.noAnimalStreak}) diedHere=${diedHere} bootstrapStuck=${bootstrapStuck}(noTree) hp=${s.hp} food=${s.food} — relocate cross-continent` };
}

// ---------------------------------------------------------------------------
// I/O helpers (kept OUT of the pure layer)
// ---------------------------------------------------------------------------
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function readMState() { return readJSON(MSTATE) || { oceanStreak: 0, noAnimalStreak: 0, lastMigrateAt: 0, barren: null }; }
function writeMState(s) { try { fs.writeFileSync(MSTATE, JSON.stringify(s)); } catch (e) {} }

// ★perf 2026-07-09: death_log.jsonl grows all session and was read+split whole on every march-leg
// probe. Cache the last-64 raw lines on the persistent bot object (~15s TTL, shared with the mining
// skills); deaths only accrue on death, so staleness is harmless.
function readRecentDeaths(bot, n = 60) {
    try {
        const now = Date.now();
        let lines;
        const m = bot && bot._deathLinesMemo;
        if (m && now - m.t < 15000) lines = m.lines;
        else {
            lines = [];
            try { lines = fs.readFileSync(DEATHLOG, 'utf8').trim().split('\n').slice(-64); } catch (e) {}
            if (bot) bot._deathLinesMemo = { t: now, lines };
        }
        return lines.slice(-n)
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
    // ★C263: a migration through snowy_taiga must punch through the mob gauntlet to reach the
    // ~800b needed to escape the bad biome. The old per-leg abort on closeActionable() (ANY
    // hostile within 8b) quit the whole journey at 25-254b every time — a single wandering
    // skeleton ended the migration. The reflex layer (interrupt_code, checked at the top of the
    // leg loop) already yields the march to self_defense when a mob actually engages, so a
    // preemptive abort is redundant for fightable mobs. The ONE threat we genuinely cannot march
    // past is a point-blank creeper: it explodes regardless of combat and self_defense can't save
    // a body that walked into the blast. So only a creeper within ~4.5b aborts the leg; everything
    // else is left to the reflex (yield) or simply walked past.
    const closeCreeper = () => {
        try {
            return Object.values(bot.entities || {}).some(e =>
                e && e !== bot.entity && e.position && /creeper/.test((e.name || '').toLowerCase())
                && e.position.distanceTo(bot.entity.position) < 4.5);
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
        let trees = 0, reachableTrees = 0, grass = 0;
        try {
            const logs = world.getNearestBlocks(bot, ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'], 40, 30) || [];
            trees = logs.length;
            // ★C324 (T-0055 keystone): count REACHABLE trees, not just VISIBLE ones. A log whose
            // base sits ≤2 above our standing level (we can step/jump up) and not buried far below
            // is approachable; plateau-top trees (wooded_badlands: trunks +3..+8 on VERTICAL terraces
            // we can't climb) are visible but unreachable. Counting visible trees made migrate
            // SETTLE in tree-rich badlands the bot then starved in — chopWood blacklisted every
            // plateau tree "unreachable" (T-0055). Cheap y-band proxy (no per-tree pathfind).
            const by = p.y;
            for (const lp of logs) { const ly = (lp && lp.position) ? lp.position.y : (lp ? lp.y : null); if (ly != null && ly <= by + 2 && ly >= by - 6) reachableTrees++; }
        } catch (e) {}
        try { grass = (world.getNearestBlocks(bot, ['grass_block', 'short_grass', 'tall_grass'], 24, 8) || []).length; } catch (e) {}
        const deaths = readRecentDeaths(bot);
        const deathsNear = deaths.filter(d => Math.hypot(d.x - p.x, d.z - p.z) < 24).length;
        return { biome, landAnimals, trees, reachableTrees, grass, deathsNear, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    };

    // ---- START GATE (re-confirm the human "this place is unlivable" decision) ----
    const mstate = readMState();
    const adv = readJSON(ADVISORY);
    const dzone = adv && adv.dzone ? adv.dzone : null;
    const pos0 = bot.entity.position.clone();
    const insideDeathZone = !!(dzone && Math.hypot(pos0.x - dzone.cx, pos0.z - dzone.cz) <= (dzone.r || 0));
    const deaths = readRecentDeaths(bot);
    // food-death proxy: deaths clustered near us (the spawn we keep dying at). The death log
    // doesn't always carry a cause field, so ">=3 deaths within 40b of here" == we keep dying here.
    const foodDeathsClustered = deaths.filter(d => Math.hypot(d.x - pos0.x, d.z - pos0.z) < 80).length >= 3;
    const currentOcean = /ocean|river|beach|shore/.test(curBiome().toLowerCase());

    // ★C309 (T-0042): woodless-bootstrap signal — pickless + no wood in inv + no reachable logs
    // = the tool chain can't progress here. Streak (mirrors noAnimalStreak) so a single scan-miss
    // (chunk not loaded / tree just out of range) can't fire a long march; reset the instant any
    // wood/pick appears. Only the EARLY healthy-day gate (missionNether:759) reaches here for a
    // food-full bot, so this is the lever that unlocks the treeless-desert deadlock.
    const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
    const _noPick = !bot.inventory.items().some(i => /_pickaxe$/.test(i.name || ''));
    const _noWoodInv = !bot.inventory.items().some(i => /_log$|_planks$/.test(i.name || ''));
    let _logsNear = 0;
    try { _logsNear = (await world.getNearestBlocksAsync(bot, LOGS, 128, 1) || []).length; } catch (e) {}
    const _woodlessBootstrap = _noPick && _noWoodInv && _logsNear === 0;
    mstate.noTreeStreak = _woodlessBootstrap ? ((mstate.noTreeStreak || 0) + 1) : 0;
    writeMState(mstate);
    const bootstrapStuck = (mstate.noTreeStreak || 0) >= 2;
    log_(`bootstrap-scan: noPick=${_noPick} noWoodInv=${_noWoodInv} logsNear=${_logsNear} → woodless=${_woodlessBootstrap} noTreeStreak=${mstate.noTreeStreak} bootstrapStuck=${bootstrapStuck}`);

    const decision = shouldMigrate({
        oceanStreak: mstate.oceanStreak, noAnimalStreak: mstate.noAnimalStreak, currentOcean,
        foodDeathsClustered, insideDeathZone, bootstrapStuck,
        hp: Math.round(bot.health), food: bot.food,
        isNight: isNight(), actionableClose: closeActionable(),
        msSinceLastMigrate: Date.now() - (mstate.lastMigrateAt || 0),
        cooldownMs: (opts.cooldownMin ?? 20) * 60000,
        gateHp, gateFood, force: opts.force === true,
    });
    log_(`gate: ${decision.reason}`);
    // ★kernel return contract (live 2026-07-02 04:0x: 12+ MIGRATE re-commits with the bot
    // pickless underground at y=55 — the truthy {migrated:false} no-go return reset the
    // kernel failure counter every dispatch, so the 3-strike cooldown never released the
    // commitment). A no-go decision did ZERO work: return false so the kind cools down and
    // the chain rotates instead of spinning on a gate that can't open from here.
    if (!decision.go) return false;

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
    // ★MIN-FORCE-ADVANCE (worker-frozen 0701, T-0110): a force-relocate fired to break a STUCK bot
    // must actually MOVE. isSettleSite settles at leg 1 whenever the CURRENT spot scores livable —
    // so a bot stuck in a livable-but-resourceless pocket (live: @71,85 sunflower_plains score=24,
    // elevated/unreachable trees, water-blocked descent) had the kernelDriver no-op-escape fire
    // migrate FOUR times, each settling in place movedBlocks=0 → never left. Require a force-relocate
    // to march a floor distance before it may settle, so it leaves the pocket to fresh ground where
    // trees are reachable / descent works. Caller may override via opts.minAdvance.
    const minForceAdv = (opts.minAdvance != null) ? opts.minAdvance : (opts.force === true ? 48 : 0);
    let imprisonEgressTried = false;   // ★C318 (T-0052): one surfaceUp break-out per imprisonment
    // ★C312 (T-0051): when FLEEING a death zone / bootstrap-stuck, the score>=14 + animals>=2 settle
    // bar (tuned for an IDEAL home) rejects perfectly good ESCAPE sites and traps the bot oscillating
    // around the kill-zone wood-starved (live: 4 migrations in 15min, each finds 34,85 trees=18
    // deathsNear=0 score=12<14 desert → never settles → re-migrates → never gets wood to craft a bed →
    // setBed fails forever). When the goal is to GET OFF a death zone, ANY tree-bearing, death-free,
    // non-water site is a valid escape: the bot settles there, chops the trees → wood → table/bed →
    // real anchor. deathsNear=0 guarantees we're clear of the cluster; trees>=4 guarantees wood to
    // bootstrap; the min-advance guard avoids settling right next to the zone on a fluke.
    const fleeingDeathZone = insideDeathZone || foodDeathsClustered || bootstrapStuck;
    const escapeSettleOk = (s) => {
        const a = s || {};
        const waterBiome = /ocean|river|beach|shore/.test((a.biome || '').toLowerCase());
        // ★C324 (T-0055 keystone): require REACHABLE trees≥4, not just visible. The whole T-0055
        // bug was C312 escape-settling in a wooded_badlands with 10 VISIBLE plateau trees the bot
        // could never reach → starved at a "tree-rich" home. reachableTrees (y-band filtered)
        // ensures the escape home actually has wood we can harvest to bootstrap.
        const usableTrees = (a.reachableTrees != null ? a.reachableTrees : a.trees) || 0;
        return !waterBiome && usableTrees >= 4 && (a.deathsNear || 0) === 0;
    };
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
        if (closeCreeper()) { abort = `creeper point-blank at leg ${leg} — yield to defense/EVAC`; break; }   // C263: only an unavoidable creeper aborts; other mobs handled by reflex (interrupt_code) or walked past
        // ★2026-07-09 用户令 HP/食物本能熔断: 低血中止行军; HP 闸开恢复。
        if (_hpOn() && Math.round(bot.health) <= abortHp) { abort = `hp=${Math.round(bot.health)} <= ${abortHp} at leg ${leg}`; break; }
        // ★2026-07-09 用户令 HP/食物本能熔断: 低饿 forage 补给+中止行军整块; 食物闸开恢复。
        if (_foodOn() && bot.food < legFoodFloor && !edibleHeld()) {
            // Top up before marching the last food away (forage budget lesson). One bounded try.
            log_(`leg ${leg}: food=${bot.food} < floor ${legFoodFloor} no edible → forage top-up`);
            try { await skills.customSkill(bot, 'forage', { targetFood: 14 }); } catch (e) {}
            if (bot.food < legFoodFloor && !edibleHeld()) { abort = `food=${bot.food} unsustainable at leg ${leg} — return, don't march starving`; break; }
        }

        // ---- evaluate CURRENT site (chunks loaded here) ----
        const site = sampleSite();
        const score = siteScore(site);
        if (!best || score > best.score) best = { ...site, score };
        if (totalAdv >= minForceAdv && isSettleSite(site, settleScore)) {
            settled = true; settleSite = { ...site, score };
            log_(`★ARRIVED livable land @${site.x},${site.z} biome=${site.biome} animals=${site.landAnimals} trees=${site.trees} score=${score} (adv=${Math.round(totalAdv)}b≥${minForceAdv}) — settle here`);
            break;
        }
        if (fleeingDeathZone && totalAdv >= 48 && escapeSettleOk(site)) {
            settled = true; settleSite = { ...site, score };
            log_(`★C312 ESCAPE-SETTLE @${site.x},${site.z} biome=${site.biome} trees=${site.trees} reachableTrees=${site.reachableTrees} deathsNear=${site.deathsNear} score=${score} (fleeing death-zone; reachable-tree+death-free escape beats oscillating) — settle here`);
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
            if (isNight() || closeCreeper() || (_hpOn() && Math.round(bot.health) <= abortHp)) break;   // C263: bail to outer gates (creeper-only, not every nearby mob) ★2026-07-09 用户令 HP/食物本能熔断: 低血中止 hop 仅 HP 闸开;夜/苦力怕不变。
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
            // ★C318 (T-0052): pathfinder-imprisonment. Every bearing stalls = horizontally boxed in
            // (mesa-pocket / death-zone terraces), yet mobility reads FREE so the MAROONED road-out
            // never fires and goToPosition just throws noPath on ALL directions → the bearing fan
            // exhausts → migrate aborts and "settles" IN the death-zone pocket (act_trace 23:45:
            // stalls=10 totalAdv=0b, imprisoned @28,-37). The ONE egress a horizontal fan can't give
            // is UP: surfaceUp pillars out of the pocket above the terraces, where horizontal pathing
            // works again. Fire ONCE per imprisonment (flag), reset to good progress, then retry the
            // fan from the higher vantage. surfaceUp self-no-ops if already open-sky (C307), so this
            // only acts when genuinely pocket-boxed. ③ hot-reload, no core-pathfinder change.
            if (stalls >= 2 && !imprisonEgressTried) {
                imprisonEgressTried = true;
                const sy = Math.round(bot.entity.position.y) + 10;
                log_(`★C318 imprisoned (stalls=${stalls} totalAdv=${Math.round(totalAdv)}b, bearings noPath) → surfaceUp(${sy}) break out of pocket, retry fan from higher vantage`);
                try { await skills.customSkill(bot, 'surfaceUp', sy); } catch (e) { log_(`C318 imprison-surfaceUp err: ${e && e.message || e}`); }
                turnIdx = 0; cur = rot(base, TURNS[0]); waterStreak = 0;
                continue;
            }
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
            imprisonEgressTried = false; // ★C318: real progress → re-arm break-out for any later pocket
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
    // ★C312: fleeing a death zone → the best tree-bearing, death-free site we saw counts as a real
    // settle (not just an ideal-score home), so we COMMIT + write its anchor instead of returning
    // settled=false and re-migrating next cycle (the oscillation that kept the bot wood-starved).
    const reachedGood = settled
        || (best && isSettleSite(best, settleScore))
        || (fleeingDeathZone && best && escapeSettleOk(best));
    // ★C325 (T-0059): NEVER re-anchor HOME into a hazard. A stalled/failed migration sets target =
    // best/sampleSite = wherever it ended up — which can be a death-zone / deep-mining hazard (live:
    // bed re-anchored to 64,60,63 score-1, the #121 fall+drown death zone). On respawn the KILL-BOX
    // expels the bot from spawn → it runs to this "home" → dies → respawns → roam-far-die loop. Only
    // pin the anchor when we genuinely SETTLED, or the target is at least death-free with a non-negative
    // score. For an unsettled hazard target, DON'T overwrite bed.json — leave setBed's own auto-selector
    // (which picks deaths-near=0 sites) to choose a safer home than the hazard we stalled in.
    const targetSafe = reachedGood || ((target.deathsNear || 0) === 0 && siteScore(target) >= 0);
    // ★P0-2 幻影家根修 (2026-07-04 取证: bed.json={141,62,119,src:'migrate'} 是迁徙【开始】时写的,
    // 那里从未放过床, bankGear/chopWood/prepNether 等不查 src 的读方全锚在幻影上): 预写改为事务式 —
    // 先快照旧值, 预写只为 pin setBed 的选址器 (setBed:45 读 bed.json 做 anchor), setBed 成功会用
    // 实证坐标覆盖 ({x,y,z,t} 无 src); setBed 失败/defer 则回滚快照, 幻影锚不再落盘过夜。
    let bedfPrior = null, bedfPinned = false;
    if (targetSafe) {
      try {
        try { bedfPrior = fs.readFileSync(BEDF, 'utf8'); } catch (e) {}
        const hy = Math.max(60, Math.min(95, Math.floor(bot.entity.position.y)));
        fs.writeFileSync(BEDF, JSON.stringify({
            x: target.x, y: hy, z: target.z, t: Date.now(),
            src: 'migrate', score: target.score ?? siteScore(target),
            biome: target.biome, animals: target.landAnimals, trees: target.trees,
        }));
        bedfPinned = true;
        log_(`anchor pinned (transactional) @${target.x},${target.z} (score=${target.score ?? '?'} biome=${target.biome}) — invoking setBed`);
      } catch (e) { log_(`anchor write err: ${e && e.message || e}`); }
    } else {
        log_(`★C325 anchor SKIP @${target.x},${target.z} (deathsNear=${target.deathsNear ?? '?'} score=${siteScore(target)}, unsettled hazard) — keep prior home, don't re-anchor a death zone → setBed auto-selects safer`);
    }

    let bedOk = false;
    try { bedOk = await skills.customSkill(bot, 'setBed'); } catch (e) { log_(`setBed threw: ${e && e.message || e}`); }
    if (bedfPinned && !bedOk) {
      // setBed 没放成床 → 回滚 pin, 不留幻影锚 (旧值有则还原, 无则删文件)
      try {
        if (bedfPrior != null) fs.writeFileSync(BEDF, bedfPrior);
        else fs.unlinkSync(BEDF);
        log_(`anchor pin ROLLED BACK (setBed defer/fail) — no phantom home persisted`);
      } catch (e) { log_(`anchor rollback err: ${e && e.message || e}`); }
    }

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
    // ★kernel return contract (live 2026-07-02 04:03 + 04:10): force=true last-resort gates
    // bypass migrate's own persisted cooldown, so any zero-movement outcome loops at the
    // kernel's ~2s tick with nothing to break it — first as food=0 leg-1 aborts, then as
    // "ARRIVED livable land" INSTANT settles when the proposer's stuck-terrain/wood-barren
    // signal is stale and the bot already stands somewhere good (settled:true made the old
    // !reachedGood guard wave the truthy through → 2s scan+setBed spin, bot visibly frozen).
    // A zero-movement run is idempotent at best (anchor write survives) — return false
    // UNCONDITIONALLY so 3 strikes cool the kind and BOOTSTRAP/GET_FOOD work the good land.
    if (movedTotal < 8) {
        log_(`zero-progress run (moved=${movedTotal}b, settled=${!!reachedGood}, abort=${abort || 'none'}) → false for kernel cooldown`);
        return false;
    }
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
