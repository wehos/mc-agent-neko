// Hot-reloadable REAL skill: one bounded wheat-farm pass — the OPP_WHEAT_FARM executor
// (T-0069 sustainable food). (Checkpoint #13.2, 2026-07-02: the proposal was wired but this
// FILE never existed — every dispatch was customSkill 'Cannot find module' → false ×3 →
// 5-min cooldown, forever. feedUp only CONSUMES food sources; this skill CREATES one.)
//
// Pass = harvest mature wheat nearby → bake bread at a table → eat if hungry → replant the
// freed farmland → sow spare seeds on any empty farmland → if seeds remain and no plot
// exists, till a few water-adjacent dirt cells (crafting a wooden hoe if materials allow).
// ALWAYS self-cooldowns ~5min (bot._wheatFarmCooldownUntil — the proposer gates on it) so
// unripe plots never pin the kind. Return contract: truthy iff real progress (harvested /
// baked / ate / sowed / tilled); honest false otherwise. No module-level mutable state.
// Invoked via: {"skill":"wheatFarm", [{"breadTarget": 4}]}  ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
import {
    freshOracleSnapshot,
    liveOracleTargetState,
    loadClearedTargets,
    markOracleTargetCleared,
    targetCleared,
} from './oracleGuard.js';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

export default async function wheatFarm(bot, ctx, opts = {}) {
    const { skills, world, mc, Vec3 } = ctx;
    const breadTarget = Number(opts && opts.breadTarget) || 4;
    const inv = () => world.getInventoryCounts(bot);
    const hostileNear = (r) => { try { return Object.values(bot.entities || {}).some(e => e && e !== bot.entity && e.position && mc.isHostile(e) && e.position.distanceTo(bot.entity.position) < r); } catch (e) { return false; } };
    const isNight = () => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } };
    const findByName = (names, r, count) => {
        try {
            const ids = names.map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(Boolean);
            return (bot.findBlocks({ matching: ids, maxDistance: r, count: count || 32 }) || []);
        } catch (e) { return []; }
    };
    // The self-cooldown is unconditional: whatever happens below, don't re-court this kind
    // for 5 minutes (crops grow on wall-clock minutes; churning on an unripe plot is waste).
    const done = (result) => { try { bot._wheatFarmCooldownUntil = Date.now() + 300000; } catch (e) {} return result; };

    if (isNight()) { prog('wheatFarm: night — defer, false.'); return done(false); }
    if (hostileNear(12)) { prog('wheatFarm: hostile within 12b — false.'); return done(false); }

    let harvested = 0, baked = 0, ate = false, sowed = 0, tilled = 0;

    // ── 0) ★农场巡回 (2026-07-05 用户四连问: 坐标不保存/无巡回/种子播完提案断链)。
    //    farm.json 持久锚点; 脚边 24b 无麦无田但锚点在 12-250b 内 → 先走回农场再干活。
    //    (提案侧 modes.js 挂 w.farm + world_model 熟期巡逻分支配套, 种子=0 也会派收获。)──
    const FARM_FILE = path.resolve(process.cwd(), 'bots', '_supervisor', 'farm.json');
    let farmAnchor = null;
    try { farmAnchor = JSON.parse(fs.readFileSync(FARM_FILE, 'utf8')); } catch (e) {}
    if (!findByName(['wheat', 'farmland'], 24, 2).length && farmAnchor && Number.isFinite(farmAnchor.x)) {
        const fd = Math.hypot(farmAnchor.x - bot.entity.position.x, farmAnchor.z - bot.entity.position.z);
        if (fd > 12 && fd < 250) {
            prog(`wheatFarm: 0 巡回 → 农场锚 @${farmAnchor.x},${farmAnchor.z} (${Math.round(fd)}b)`);
            try {
                await Promise.race([
                    skills.goToPosition(bot, farmAnchor.x, farmAnchor.y || null, farmAnchor.z, 8),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('farm-walk-timeout')), 90000)),
                ]);
            } catch (e) {
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                prog(`wheatFarm: 0 巡回未达: ${e.message}`);
            }
            if (bot.interrupt_code || bot.health <= 0) return done(false);
        }
    }

    // 1) Harvest MATURE wheat within 24b (age 7 only — breaking green wheat wastes the plot).
    const matureWheat = findByName(['wheat'], 24, 32)
        .map(p => bot.blockAt(p))
        .filter(b => { try { return b && b.name === 'wheat' && Number(b.getProperties().age) >= 7; } catch (e) { return false; } })
        .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
    const freedPlots = [];
    for (const b of matureWheat.slice(0, 12)) {
        if (bot.interrupt_code || bot.health <= 0) break;
        if (hostileNear(10)) break;
        const p = b.position;
        try {
            if (bot.entity.position.distanceTo(p) > 4) await skills.goToPosition(bot, p.x, p.y, p.z, 2);
            if (await skills.breakBlockAt(bot, p.x, p.y, p.z)) { harvested++; freedPlots.push(p); }
        } catch (e) {}
    }
    if (harvested) { try { await skills.pickupNearbyItems(bot); } catch (e) {} }

    // 2) Bake bread toward the target (3 wheat each; craftRecipe handles the table).
    const wheatCt = inv().wheat || 0;
    const breadCt = inv().bread || 0;
    if (wheatCt >= 3 && breadCt < breadTarget) {
        const want = Math.min(Math.floor(wheatCt / 3), breadTarget - breadCt);
        try { if (await skills.craftRecipe(bot, 'bread', want)) baked = want; }
        catch (e) { prog(`wheatFarm: bread craft failed (${e && e.message || e}) — wheat kept for next pass.`); }
    }
    while (bot.food < 16 && (inv().bread || 0) > 0) {
        try { await skills.consume(bot, 'bread'); ate = true; } catch (e) { break; }
    }

    // 2.5) ★采种 (2026-07-05 用户'farm能力太弱'加强): 种子<8 → 打附近草丛集种。没有这步,
    //      开局 2-4 颗种子的农场永远长不大 (打草是零工具零风险动作, 1/8 掉种)。
    const seedsLeft = () => inv().wheat_seeds || 0;
    let gathered = 0;
    if (seedsLeft() < 8 && !bot.interrupt_code) {
        const s0 = seedsLeft();
        const grasses = findByName(['short_grass', 'tall_grass', 'grass'], 16, 24);
        for (const p of grasses.slice(0, 16)) {
            if (bot.interrupt_code || bot.health <= 0 || seedsLeft() >= 8) break;
            if (hostileNear(10)) break;
            try {
                if (bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z)) > 4) await skills.goToPosition(bot, p.x, p.y, p.z, 2);
                await skills.breakBlockAt(bot, p.x, p.y, p.z);
            } catch (e) {}
        }
        try { await skills.pickupNearbyItems(bot); } catch (e) {}
        gathered = seedsLeft() - s0;
        if (gathered > 0) prog(`wheatFarm: 2.5 采种 +${gathered} (seeds=${seedsLeft()})`);
    }

    // 3) Replant freed plots, then sow spare seeds on any empty farmland within 12b.
    for (const p of freedPlots) {
        if (bot.interrupt_code || bot.health <= 0 || !seedsLeft()) break;
        try { if (await skills.tillAndSow(bot, p.x, p.y - 1, p.z, 'wheat_seeds')) sowed++; } catch (e) {}
    }
    if (seedsLeft() && !bot.interrupt_code) {
        const emptyFarmland = findByName(['farmland'], 12, 24)
            .filter(p => { try { const a = bot.blockAt(new Vec3(p.x, p.y + 1, p.z)); return a && a.name === 'air'; } catch (e) { return false; } });
        for (const p of emptyFarmland.slice(0, 8)) {
            if (bot.interrupt_code || bot.health <= 0 || !seedsLeft()) break;
            try { if (await skills.tillAndSow(bot, p.x, p.y, p.z, 'wheat_seeds')) sowed++; } catch (e) {}
        }
    }

    // 4) Seeds but nowhere to put them → start a plot: till water-adjacent dirt/grass (the
    //    hydration range is 4, so cells directly beside water always qualify). Craft a wooden
    //    hoe first if we can afford one. Bounded to 4 tills per pass.
    if (seedsLeft() && sowed === 0 && !bot.interrupt_code) {
        const hasHoe = () => bot.inventory.items().some(i => /_hoe$/.test(i.name || ''));
        if (!hasHoe()) {
            const c = inv();
            const planks = ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks']
                .reduce((s, n) => s + (c[n] || 0), 0);
            if (planks >= 2 && (c.stick || 0) >= 2) {
                try { await skills.craftRecipe(bot, 'wooden_hoe', 1); } catch (e) {}
            }
        }
        if (hasHoe()) {
            let water = findByName(['water'], 24, 12);   // ★12→24 (新家附近水源可能不在 12b 内)
            if (!water.length) {
                // ★2026-07-06 oracle 寻水腿: 干旱高地 24b 恒无水 (tilled=0 空转实录) —
                //   ore-oracle 已扫地表水(y58-70), 走最近水源再立田 (黑曜石桶浇同源受益)。
                try {
                    const oo = bot._world && bot._world.oracleOres;
                    const cleared = freshOracleSnapshot(oo) ? await loadClearedTargets(oo.worldId) : [];
                    const w0 = freshOracleSnapshot(oo) && Array.isArray(oo.water)
                        ? oo.water.find((candidate) => candidate && !targetCleared(candidate, 'water', cleared))
                        : null;
                    if (w0) {
                        const wd = Math.hypot(w0.x - bot.entity.position.x, w0.z - bot.entity.position.z);
                        if (wd < 300 && !bot.interrupt_code) {   // 220→300: 出生点重生后到水 233b (麦田=死亡循环唯一结构解, 值得走)
                            prog(`wheatFarm: 24b 无水 → oracle 水源 @${w0.x},${w0.y},${w0.z} (${Math.round(wd)}b) 走过去立田`);
                            await Promise.race([
                                skills.goToPosition(bot, w0.x, null, w0.z, 4),
                                new Promise((_, rej) => setTimeout(() => rej(new Error('water-walk-timeout')), 90000)),
                            ]).catch(() => { try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} });
                            water = findByName(['water'], 24, 12);
                            if (!water.length && liveOracleTargetState(bot, Vec3, w0, 'water', 24) === 'absent') {
                                await markOracleTargetCleared(oo, 'water', w0, 'live-target-absent');
                                prog(`wheatFarm: oracle 水源已不存在 @${w0.x},${w0.y},${w0.z} → quarantine`);
                            }
                        }
                    }
                } catch (e) {}
                if (!water.length) prog('wheatFarm: oracle 也无可达水源 — 本区立田不可行');
            }
            outer: for (const w of water) {
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    if (tilled >= 4 || bot.interrupt_code || bot.health <= 0) break outer;
                    const gx = w.x + dx, gy = w.y, gz = w.z + dz;
                    try {
                        const g = bot.blockAt(new Vec3(gx, gy, gz));
                        const above = bot.blockAt(new Vec3(gx, gy + 1, gz));
                        if (!g || !/^(dirt|grass_block)$/.test(g.name || '') || !above || above.name !== 'air') continue;
                        if (await skills.tillAndSow(bot, gx, gy, gz, 'wheat_seeds')) { tilled++; sowed++; }
                    } catch (e) {}
                }
            }
        } else if (!hasHoe()) {
            prog('wheatFarm: seeds on hand but no hoe and no materials for one — plot deferred.');
        }
    }

    // ── 5) ★农场锚点落盘 + 持久地标 (坐标保存问题的正解): 以最近 farmland 为锚写 farm.json
    //    (sowed/tilled 刷新 sownAt = 熟期计时起点), 并登记持久 'farm' 地标 (非 _TRANSIENT_LM
    //    类, 不过期 — goBedSleep regBedLandmark 同款直写)。──────────────────────────────
    try {
        const fl = findByName(['farmland'], 24, 1)[0];
        if (fl) {
            const prevSown = (farmAnchor && farmAnchor.sownAt) || 0;
            fs.writeFileSync(FARM_FILE, JSON.stringify({
                x: fl.x, y: fl.y, z: fl.z,
                sownAt: (sowed || tilled) ? Date.now() : prevSown,
                updatedAt: Date.now(),
            }));
            if (bot._landmarks && typeof bot._landmarks === 'object') {
                const key = `farm@${fl.x},${fl.y},${fl.z}`;
                const _n = Date.now();
                if (!bot._landmarks[key]) bot._landmarks[key] = { kind: 'farm', x: fl.x, y: fl.y, z: fl.z, ts: _n, seen: _n, meta: null };
                else bot._landmarks[key].seen = _n;
            }
            prog(`wheatFarm: 5 农场锚落盘 @${fl.x},${fl.y},${fl.z} sownAt=${(sowed || tilled) ? 'now' : 'kept'}`);
        }
    } catch (e) {}

    prog(`wheatFarm: pass done — harvested=${harvested} baked=${baked} ate=${ate} sowed=${sowed} tilled=${tilled} gathered=${gathered} bread=${inv().bread || 0}/${breadTarget} food=${bot.food}`);
    if (harvested || baked || ate || sowed || gathered) return done({ harvested, baked, ate, sowed, tilled, gathered });
    return done(false);
}
