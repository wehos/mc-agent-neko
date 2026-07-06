// Hot-reloadable REAL skill: climb from deep underground back to the surface.
// goToSurface only PATHFINDS on a NON-digging movement set, so it can't punch through a
// ceiling and a bot sealed in a mine just loops failing (it got pinned at y23 in a 1-wide
// tunnel, unable to reach open ground to place a crafting table / remake a broken pickaxe).
// PRIMARY method here: drive the mineflayer pathfinder with DIGGING + towering ENABLED
// toward a high Y goal, so it carves a staircase up on its own (robust, no manual
// block-placement timing). FALLBACKS: dig straight-up headroom + pillarUp, then a manual
// jump-and-place pillar. Never opens a water/lava ceiling on the manual paths.
// Invoked: skills.customSkill(bot,'surfaceUp', targetY).  ctx = { skills, world, mc, Vec3, log }
import mfp from 'mineflayer-pathfinder';
import fs from 'fs';
import path from 'path';
const { goals, Movements } = mfp;
// Real-time debug log (appendFileSync, unbuffered) — skill log() goes to block-buffered
// stdout which the supervisor can't read for minutes, leaving surfaceUp un-debuggable.
const DBG = path.resolve(process.cwd(), 'bots', '_supervisor', 'surfaceUp.log');
const dbg = (s) => { try { fs.appendFileSync(DBG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

const OPEN = new Set(['air', 'cave_air', 'void_air']);
const NO_DIG = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const SCAFFOLD = ['cobblestone', 'dirt', 'cobbled_deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'stone', 'deepslate', 'gravel', 'netherrack'];
const STONY = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/;
// Bare-hand BREAKABLE stone-family (pick only needed for the DROP, not to break). C304-A: the
// sandstone family matches STONY (substring "stone") but was MISSING here — so a no-pick bot
// under a red_sandstone/sandstone roof (ubiquitous just below red_sand in mesa/badlands +
// desert) hit canPlanNoPickStoneBreach==false → verticalBlocked → fell through to the
// lateral/DEEP-DESCEND escape and drifted DOWN under the cap (T-0023: y60→54→49 越逃越深).
// All sandstone variants are hardness 0.8, hand-breakable; adding them lets the vertical
// breach punch the mesa cap so the down-drift branch is never reached. (Plain/colored
// terracotta is hand-breakable too but is NOT STONY, so it already takes the soft guardedDig
// path and never consults this set.)
const NO_PICK_BREACHABLE = new Set([
    'stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobbled_deepslate',
    'sandstone', 'red_sandstone', 'smooth_sandstone', 'smooth_red_sandstone',
    'cut_sandstone', 'cut_red_sandstone', 'chiseled_sandstone', 'chiseled_red_sandstone',
]);
const FOOD_RE = /cooked_|_bread|^bread$|^apple$|golden_apple|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|^cod$|^salmon$|melon_slice|sweet_berries|_stew|^rabbit$|baked_|rotten_flesh|spider_eye/;
const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
const FOOT_REPLACEABLE = new Set(['torch', 'wall_torch', 'redstone_torch', 'redstone_wall_torch', 'soul_torch', 'soul_wall_torch']);

export default async function surfaceUp(bot, ctx, targetY = 63, opts = {}) {
    const { skills, world, mc, Vec3, log } = ctx;
    // ★孤儿协程截止 (评审 replenishKit.js:94): 嵌套调用方 (replenishKit 步①等) 用 Promise.race
    // 截断本技能时, 被 race 掉的协程会继续跑 climbLeg/破顶循环并清 interrupt_code — 与调用方的
    // 下一步 (chopWood/craft) 抢身体控制权, C362-broad 的 200 徒手破顶预算 × ~7.5s/块 可拖 20min
    // 级。opts.maxMs: 技能自己到点收尾退出 (各主循环条件里查 deadlineHit, 孤儿窗口收敛到单次
    // guardedDig 的 ≤26s 尾巴)。kernel 直派不带 opts → deadlineAt=0 永不过期, 存量行为与返回
    // 契约零变化 (到点返回 surfaceReady(), 对带 maxMs 的嵌套调用方而言返回值本就被忽略)。
    const deadlineAt = (opts && Number.isFinite(opts.maxMs) && opts.maxMs > 0) ? Date.now() + opts.maxMs : 0;
    const deadlineHit = () => !!(deadlineAt && Date.now() >= deadlineAt);
    // C226-D: callers pass RELATIVE targets (pos.y + N). When the bot is already
    // high (on a peak/mountainside the caller mislabels "enclosed"), pos.y+18 from
    // y118 = 136 → surfaceReady never satisfied → runaway pillar to y127-136 where
    // night skeletons/exposure kill it (death@y127 shot:Skeleton confirmed). Cap the
    // target at a sane surface ceiling: this both bounds the climb AND lets the
    // entry surfaceReady() early-exit fire (yNow>=cap-2 && openAbove ⇒ already out).
    // 90 keeps the MAROONED-rescue floor (max 84) intact while killing the runaway.
    // Fix lives in the primitive so all 5 call sites are covered at once.
    const SURFACE_CEILING = 90;
    if (Number.isFinite(targetY)) targetY = Math.min(targetY, SURFACE_CEILING);
    const yNow = () => Math.floor(bot.entity.position.y);
    const scafCount = () => SCAFFOLD.reduce((s, n) => s + (world.getInventoryCounts(bot)[n] || 0), 0);
    const hasPick = () => bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
    const heldIsPick = () => !!(bot.heldItem && /_pickaxe$/.test(bot.heldItem.name));
    const inventoryCounts = () => {
        try { return world.getInventoryCounts(bot) || {}; } catch (e) { return {}; }
    };
    const ensureEmergencyPick = async () => {
        if (hasPick()) return true;
        const craftLocal = skills.craftRecipeLocal || skills.craftRecipe;
        const craftTimed = async (name, count = 1) => {
            await Promise.race([
                craftLocal(bot, name, count),
                new Promise((_, rej) => setTimeout(() => rej(new Error(`${name}-timeout`)), 12000)),
            ]);
        };
        const nearTable = () => {
            try {
                const t = world.getNearestBlock(bot, 'crafting_table', 4);
                return !!(t && t.position && bot.entity.position.distanceTo(t.position) <= 4.5);
            } catch (e) { return false; }
        };
        const ensureTable = async () => {
            let c = inventoryCounts();
            if ((c.crafting_table || 0) > 0 || nearTable()) return true;
            const plankName = WOOD_TYPES.map(w => `${w}_planks`).find(n => (c[n] || 0) >= 4);
            if (!plankName) {
                const logName = WOOD_TYPES.map(w => `${w}_log`).find(n => (c[n] || 0) > 0);
                if (logName) {
                    const pn = logName.replace(/_log$/, '_planks');
                    dbg(`emergency pick: crafting ${pn} for local table`);
                    await craftTimed(pn, 1);
                    c = inventoryCounts();
                }
            }
            const tablePlanks = WOOD_TYPES.map(w => `${w}_planks`).find(n => (c[n] || 0) >= 4);
            if (!tablePlanks) return false;
            dbg(`emergency pick: crafting local crafting_table from ${tablePlanks}`);
            await craftTimed('crafting_table', 1);
            return (inventoryCounts().crafting_table || 0) > 0 || nearTable();
        };
        try {
            await ensureTable().catch(e => dbg(`emergency pick table prep failed: ${e && e.message ? e.message : String(e)}`));
            const c = inventoryCounts();
            if ((c.cobblestone || 0) >= 3 && (c.stick || 0) >= 2) {
                dbg(`emergency pick: crafting stone_pickaxe before stone ceiling`);
                await craftTimed('stone_pickaxe', 1);
            } else if ((c.oak_planks || c.spruce_planks || c.birch_planks || c.jungle_planks || c.acacia_planks || c.dark_oak_planks || c.mangrove_planks || c.cherry_planks || 0) >= 3 && (c.stick || 0) >= 2) {
                dbg(`emergency pick: crafting wooden_pickaxe before stone ceiling`);
                await craftTimed('wooden_pickaxe', 1);
            }
        } catch (e) {
            dbg(`emergency pick failed: ${e && e.message ? e.message : String(e)}`);
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
        }
        return hasPick();
    };
    const famineEmergency = () => bot.food <= 2 && !bot.inventory.items().some(it => it && it.name && FOOD_RE.test(it.name));
    const famineNoPickStoneBreachOk = () => {
        if (!famineEmergency()) return false;
        if ((bot.health || 0) < 8) return false;
        try {
            const a = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'advisory.json'), 'utf8'));
            const ts = Number(a.ts || 0);
            if (!ts || Date.now() - ts > 45000) return false;
            const actionable = Number(a.actionableHostiles);
            const nearest = Number.isFinite(Number(a.actionableNearest)) ? Number(a.actionableNearest) : Number(a.nearest);
            if (!Number.isFinite(actionable)) return false;
            return actionable === 0 || (actionable <= 1 && Number.isFinite(nearest) && nearest > 5.5);
        } catch (e) {
            return false;
        }
    };
    const plannedNoPickStone = () => Date.now() < (bot._plannedNoPickStoneUntil || 0);
    const openAbove = (depth = 8) => {
        const p = bot.entity.position.floored();
        for (let dy = 1; dy <= depth; dy++) {
            const b = bot.blockAt(p.offset(0, dy, 0));
            if (b && /water|lava/.test(b.name || '')) return false;
            if (b && b.boundingBox === 'block' && !OPEN.has(b.name)) return false;
        }
        return true;
    };
    // Height alone is not surface. Live failure: y=62 inside a sealed hill pocket made
    // prepNether/feedUp loop forever. A climb is done only once the bot has real headroom.
    //
    // C281 (T-0038): the absolute targetY is a CEILING, NOT a goal to pillar toward.
    // surfaceUp exists to escape a SEAL (rock/water overhead). Once the bot has genuine
    // OPEN SKY overhead it is already surfaced — forcing the climb up to targetY just
    // builds a 1-wide cobble spire in open air, and the instant the next skill's
    // pathfinder takes the body it sprint-walks off the spire to a fatal fall (实拍
    // 2026-06-20 16:10:37: surfaceUp pillared to y86 in open desert → chopWood path →
    // 坠落 y86→67 摔死; mine_motion place env @y82 showed all 36 neighbors air = pure
    // free-standing spire). So: a deep clear column overhead (real sky, not just an
    // 8-block cave pocket) = done, regardless of yNow. The targetY-2 gate stays as the
    // fallback for the tall-but-finite cave-ceiling case (openSky false) where we've
    // nonetheless climbed high enough. A sealed hill pocket keeps openAbove(8) false, so
    // that case still climbs as before.
    const openSky = () => openAbove(48);
    // ★C307-fix: standing IN water with open sky overhead is NOT "surfaced" — surfaceUp's
    // job includes swimOutOfWater(), which lives inside climbToSurface() AFTER this entry
    // early-exit. Without the !inWater() guard, a bot treading water at a watery worksite
    // (open sky above) early-exits as "already at open surface" and never gets pulled out →
    // prepNether's WET-WORKSITE place-table guard ("body in water — surface/escape first")
    // re-calls surfaceUp every ~3s forever (live 17:37 idle-spin @-101,62,147). Treat
    // in-water as not-ready so swimOutOfWater runs. (Sealed-pocket case keeps openAbove(8)
    // false as before; this only adds the water exclusion.)
    const surfaceReady = () => !inWater() && openAbove(8) && (openSky() || yNow() >= targetY - 2);
    const inWater = () => {
        try {
            const p = bot.entity.position.floored();
            const foot = bot.blockAt(p);
            const head = bot.blockAt(p.offset(0, 1, 0));
            return [foot, head].some(b => b && /water/.test(b.name || ''));
        } catch (e) { return false; }
    };
    const swimOutOfWater = async () => {
        if (!inWater()) return true;
        const y0 = yNow();
        dbg(`water escape: swim-up start y=${y0}`);
        try {
            bot.setControlState('jump', true);
            for (let i = 0; i < 80 && inWater(); i++) {
                await skills.wait(bot, 100);
                const p = bot.entity.position.floored();
                const above = bot.blockAt(p.offset(0, 2, 0));
                if (above && above.boundingBox === 'block' && !NO_DIG.has(above.name)) break;
            }
        } finally {
            try { bot.setControlState('jump', false); } catch (e) {}
        }
        // ★2026-07-05 溺水簇根修 (drowning×2+Bogged@16,175 同点: 水淹竖井顶实心, 潜水硬凿
        // 5x 慢 → 氧尽循环)。垂直被水锁死 → 横向找空气柱 (4向×6格探测头位有 air 的列)
        // 冲刺游过去; 氧气≤6 没探到也赌方向冲。3-4 向×4s 有界; 仍湿则如实返 false,
        // climb 侧看到 false 不该潜水长凿。
        if (inWater()) {
            const oxy = () => { try { return (typeof bot.oxygenLevel === 'number') ? bot.oxygenLevel : 20; } catch (e) { return 20; } };
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                if (!inWater()) break;
                const p = bot.entity.position.floored();
                let airAt = -1;
                for (let d = 2; d <= 6; d++) {
                    const head = bot.blockAt(p.offset(dx * d, 1, dz * d));
                    if (head && (head.name === 'air' || head.name === 'cave_air')) { airAt = d; break; }
                }
                if (airAt < 0 && oxy() > 6) continue;
                if (airAt < 0) airAt = 4;
                dbg(`water escape: lateral → dir=${dx},${dz} d=${airAt} oxy=${oxy()}`);
                try { await bot.lookAt(bot.entity.position.offset(dx * airAt, 1.0, dz * airAt), true); } catch (e) {}
                bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', true);
                await skills.wait(bot, 4000);
                try { bot.clearControlStates(); } catch (e) {}
            }
        }
        dbg(`water escape: swim-up end y=${yNow()} wet=${inWater()} dy=${yNow() - y0}`);
        return !inWater();
    };
    const ensurePickForStone = async (block, why = '') => {
        if (!block || !STONY.test(block.name || '')) return true;
        if (!hasPick()) await ensureEmergencyPick();
        if (!hasPick()) return plannedNoPickStone();
        if (heldIsPick()) return true;
        const pick = bot.inventory.items().find(it => /_pickaxe$/.test(it.name));
        try { if (pick) await skills.equip(bot, pick.name); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
        if (heldIsPick()) return true;
        try { await bot.tool.equipForBlock(block); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
        if (heldIsPick()) return true;
        dbg(`stone dig blocked: no pick actually held for ${block.name}${why ? ' ' + why : ''} held=${bot.heldItem ? bot.heldItem.name : 'empty'}`);
        return false;
    };
    const motion = (event, data = {}) => {
        try {
            const p = bot.entity.position;
            fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                ts: new Date().toISOString(),
                event,
                pos: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) },
                skill: bot._currentSkill || 'surfaceUp',
                mob: bot._mobility ? bot._mobility.state : null,
                data,
            }) + '\n');
        } catch (e) {}
    };
    const envSnap = () => {
        const c = bot.entity.position.floored();
        const out = [];
        for (let dy = -1; dy <= 2; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const b = bot.blockAt(c.offset(dx, dy, dz));
                    out.push({ d: [dx, dy, dz], n: b ? b.name : null, bb: b ? b.boundingBox : null });
                }
            }
        }
        return out;
    };
    const blockName = (b) => b ? `${b.name}@${b.position.x},${b.position.y},${b.position.z}` : 'null';
    // C247 GROUND-TRUTH probe: when vertically sealed with no pillar material, the only
    // real escapes are (a) a lateral opening into a connected cave (path-up), or (b) a
    // nearby DROP-bearing block (dirt/gravel) to harvest for pillaring. Probe the 4
    // cardinals at head level + straight up, reporting blocks-to-first-air and the
    // material run, so the escape can aim instead of tunnelling blind.
    const DROP_BAREHAND = /dirt|gravel|sand|coarse_dirt|rooted_dirt|mud|clay|grass_block|podzol|moss_block/;
    const wideScan = (reach = 16) => {
        const c = bot.entity.position.floored();
        const out = {};
        const dirs = { px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] };
        for (const [key, [dx, dz]] of Object.entries(dirs)) {
            let toAir = null, firstDrop = null, run = [];
            for (let d = 1; d <= reach; d++) {
                // head-level cell (feet+1) — the cell the bot would walk into
                const b = bot.blockAt(c.offset(dx * d, 1, dz * d));
                const nm = b ? (b.name || '') : 'air';
                const open = !b || b.boundingBox === 'empty' || OPEN.has(nm);
                if (open && toAir == null) toAir = d;
                if (DROP_BAREHAND.test(nm) && firstDrop == null) firstDrop = d;
                if (d <= 4) run.push(nm);
                if (open) break;
            }
            out[key] = { toAir, firstDrop, run };
        }
        let upToAir = null, upRun = [];
        for (let d = 1; d <= 24; d++) {
            const b = bot.blockAt(c.offset(0, d, 0));
            const nm = b ? (b.name || '') : 'air';
            const open = !b || b.boundingBox === 'empty' || OPEN.has(nm);
            if (d <= 6) upRun.push(nm);
            if (open) { upToAir = d; break; }
        }
        out.up = { toAir: upToAir, run: upRun };
        return out;
    };
    const guardedDig = async (block, why = '') => {
        if (!block) return false;
        const owner = `surfaceUp:${why || 'dig'}`;
        const acquire = async () => {
            const t0 = Date.now();
            while (Date.now() - t0 < 900) {
                const busy = bot.targetDigBlock
                    || bot._mineMotionActiveDig
                    || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil);
                if (!busy || bot._bodyDigLockOwner === owner) {
                    bot._bodyDigLockOwner = owner;
                    bot._bodyDigLockUntil = Date.now() + 6000;
                    return true;
                }
                await new Promise(r => setTimeout(r, 80));
            }
            motion('dig.slot.busy', {
                owner,
                target: `${block.name}@${block.position.x},${block.position.y},${block.position.z}`,
                heldBy: bot._bodyDigLockOwner || 'targetDigBlock',
            });
            return false;
        };
        if (!(await acquire())) return false;
        try {
            for (let n = 0; n < 2; n++) {
                const fresh = bot.blockAt(block.position);
                if (!fresh || fresh.boundingBox !== 'block') return true;
                if (!(await ensurePickForStone(fresh, why))) return false;
                if (!STONY.test(fresh.name || '')) { try { await bot.tool.equipForBlock(fresh); } catch (e) {} }
                try { bot.clearControlStates(); } catch (e) {}
                try { await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                try {
                    // ★C223b: the dig cutoff must be the block's REAL bare-hand dig time, not a fixed
                    // 12s — coal_ore bare-hand is ~15s (hardness 3 ×5), deepslate ~16.5s; a too-short
                    // cutoff aborts at 0 progress and the bot can never breach an ore/deepslate ceiling
                    // to surface (the y67-under-meadow tomb). Scale to digTime×1.4 + 1.5s (5s floor, 26s cap).
                    let timeoutMs = 5000;
                    try {
                        const ht = bot.heldItem ? bot.heldItem.type : null;
                        const dt = fresh.digTime(ht);
                        if (Number.isFinite(dt) && dt > 0) timeoutMs = Math.max(5000, Math.min(26000, Math.round(dt * 1.4) + 1500));
                    } catch (e) {}
                    await Promise.race([
                        bot.dig(fresh, true),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('dig-timeout')), timeoutMs)),
                    ]);
                    // ★#8 (review-2026-07-06 穿砾石柱窒息, deaths 3/4): 上挖逃生若头顶是重力方块
                    // (gravel/sand/concrete_powder), 挖掉支撑后它塌进刚清的格; 上升占用该格=埋头窒息。
                    // 挖的是头顶及以上格(上升路径)时, 立刻把塌落物逐个清掉(等它 settle→挖), 直到该列
                    // 耗尽, 再让上升逻辑占用。只影响上挖, 侧/下挖不触发。
                    try {
                        const GRAVITY = /^(gravel|sand|red_sand|.*concrete_powder|suspicious_gravel|suspicious_sand)$/;
                        const dp = fresh.position;
                        if (dp.y >= Math.floor(bot.entity.position.y) + 1
                            && GRAVITY.test((bot.blockAt(dp.offset(0, 1, 0)) || {}).name || '')) {
                            let cleared = 0;
                            for (let k = 0; k < 8; k++) {
                                if (bot.interrupt_code || bot.death_abort) break;
                                await skills.wait(bot, 160);   // 等落沙下坠 settle 进 dp
                                const settled = bot.blockAt(dp);
                                if (!settled || settled.boundingBox !== 'block' || !GRAVITY.test(settled.name || '')) break;
                                try { await bot.tool.equipForBlock(settled); } catch (e) {}
                                try {
                                    await Promise.race([
                                        bot.dig(settled, true),
                                        new Promise((_, rej) => setTimeout(() => rej(new Error('gravel-clear-timeout')), 4000)),
                                    ]);
                                    cleared++;
                                } catch (e) { break; }
                            }
                            if (cleared) motion('surfaceUp.gravel_clear', { at: `${dp.x},${dp.y},${dp.z}`, cleared, why });
                        }
                    } catch (e) {}
                    return true;
                } catch (e) {
                    try { bot.stopDigging(); } catch (_) {}
                    motion('dig.retry', {
                        owner,
                        attempt: n,
                        target: `${fresh.name}@${fresh.position.x},${fresh.position.y},${fresh.position.z}`,
                        error: e && e.message ? e.message : String(e),
                    });
                    await new Promise(r => setTimeout(r, 140));
                }
            }
            return false;
        } finally {
            if (bot._bodyDigLockOwner === owner) {
                bot._bodyDigLockOwner = null;
                bot._bodyDigLockUntil = 0;
            }
        }
    };
    const stepEdgeAssist = async (why = 'pf-stall') => {
        if (bot.targetDigBlock || bot._mineMotionActiveDig || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil)) return false;
        const solid = (b) => b && b.boundingBox === 'block';
        const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow']);
        const open = (b) => !b || b.boundingBox === 'empty' || PASSABLE.has(b.name || '');
        const bad = (b) => b && /water|lava|fire|cactus|magma/.test(b.name || '');
        const stationStep = (b) => b && /crafting_table|furnace|blast_furnace|smoker|chest|barrel|bed|anvil|enchanting_table|grindstone|stonecutter|loom|cartography_table|smithing_table|fletching_table|lectern|composter/i.test(b.name || '');
        const blockName = (b) => b ? `${b.name}@${b.position.x},${b.position.y},${b.position.z}` : 'null';
        const clearableStepRoof = (b) => {
            if (!b || b.boundingBox !== 'block') return false;
            if (bad(b) || stationStep(b) || /bedrock|obsidian|end_portal|nether_portal/.test(b.name || '')) return false;
            const stony = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|cobble/.test(b.name || '');
            return !stony || hasPick();
        };
        const p0 = bot.entity.position.clone();
        const cell = p0.floored();
        const ownHead = bot.blockAt(cell.offset(0, 1, 0));
        let ownAbove = bot.blockAt(cell.offset(0, 2, 0));
        if (!open(ownHead)) {
            motion('surfaceUp.step_edge.blocked', {
                why,
                reason: 'own-head-blocked',
                ownHead: blockName(ownHead),
                ownAbove: blockName(ownAbove),
                env: envSnap(),
            });
            return false;
        }
        if (!open(ownAbove)) {
            const clearable = clearableStepRoof(ownAbove);
            motion('surfaceUp.step_edge.own_above_notch.begin', {
                why,
                clearable,
                block: blockName(ownAbove),
                env: envSnap(),
            });
            let ok = false;
            let error = null;
            if (clearable) {
                try {
                    ok = await guardedDig(ownAbove, 'own-above-notch');
                    await skills.wait(bot, 120);
                    ownAbove = bot.blockAt(cell.offset(0, 2, 0));
                    ok = ok && open(ownAbove);
                } catch (e) {
                    error = e && e.message ? e.message : String(e);
                }
            }
            motion('surfaceUp.step_edge.own_above_notch.end', {
                why,
                ok,
                error,
                after: blockName(ownAbove),
                env: envSnap(),
            });
            if (!ok) return false;
        }
        const yaw = bot.entity.yaw || 0;
        const yawDx = Math.abs(Math.sin(yaw)) >= Math.abs(Math.cos(yaw)) ? (Math.sign(-Math.sin(yaw)) || 1) : 0;
        const yawDz = yawDx ? 0 : (Math.sign(Math.cos(yaw)) || 1);
        const candidates = [];
        for (const [dx, dz] of [[yawDx, yawDz], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (!dx && !dz) continue;
            if (candidates.some(c => c.dx === dx && c.dz === dz)) continue;
            const foot = bot.blockAt(cell.offset(dx, 0, dz));
            const head = bot.blockAt(cell.offset(dx, 1, dz));
            const above = bot.blockAt(cell.offset(dx, 2, dz));
            const below = bot.blockAt(cell.offset(dx, -1, dz));
            if (!solid(foot) || stationStep(foot) || !open(head) || !open(above) || bad(foot) || bad(head) || bad(above)) continue;
            const align = (dx === yawDx && dz === yawDz) ? 0 : 1;
            const dist = Math.hypot(p0.x - (cell.x + dx + 0.5), p0.z - (cell.z + dz + 0.5));
            candidates.push({ dx, dz, foot, head, above, below, align, dist });
        }
        candidates.sort((a, b) => (a.align - b.align) || (a.dist - b.dist));
        for (const c of candidates.slice(0, 2)) {
            const target = cell.offset(c.dx, 0, c.dz);
            dbg(`step-edge assist begin ${why} dir=${c.dx},${c.dz} target=${target.x},${target.y},${target.z} step=${blockName(c.foot)} head=${blockName(c.head)} above=${blockName(c.above)} below=${blockName(c.below)}`);
            try {
                fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                    ts: new Date().toISOString(),
                    event: 'surfaceUp.step_edge.begin',
                    pos: { x: +p0.x.toFixed(3), y: +p0.y.toFixed(3), z: +p0.z.toFixed(3) },
                    skill: bot._currentSkill || 'surfaceUp',
                    mob: bot._mobility ? bot._mobility.state : null,
                    env: envSnap(),
                    data: { why, dir: [c.dx, c.dz], target: { x: target.x, y: target.y, z: target.z }, step: blockName(c.foot), head: blockName(c.head), above: blockName(c.above), below: blockName(c.below) },
                }) + '\n');
            } catch (e) {}
            try {
                bot._bodyMoveLockOwner = 'surfaceUp:step-edge';
                bot._bodyMoveLockUntil = Date.now() + 3600;
                let maxY = p0.y;
                let p1 = bot.entity.position.clone();
                let ok = false;
                const targetDist = (p) => Math.hypot(p.x - (target.x + 0.5), p.z - (target.z + 0.5));
                const roseEnough = (p) => Math.floor(p.y) > cell.y || p.y > p0.y + 0.72;
                const settledInTarget = (p) => Math.floor(p.x) === target.x && Math.floor(p.z) === target.z && targetDist(p) <= 0.9;
                const stepSucceeded = (p) => roseEnough(p) && settledInTarget(p);
                for (const phase of ['press', 'runup']) {
                    const start = bot.entity.position.clone();
                    if (phase === 'runup') {
                        try { bot.clearControlStates(); } catch (e) {}
                        try { await bot.lookAt(target.offset(0.5, 1.05, 0.5), true); } catch (e) {}
                        bot.setControlState('sneak', true);
                        bot.setControlState('back', true);
                        await skills.wait(bot, 220);
                        try { bot.clearControlStates(); } catch (e) {}
                        await skills.wait(bot, 80);
                        try {
                            fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                                ts: new Date().toISOString(),
                                event: 'surfaceUp.step_edge.runup',
                                pos: { x: +bot.entity.position.x.toFixed(3), y: +bot.entity.position.y.toFixed(3), z: +bot.entity.position.z.toFixed(3) },
                                skill: bot._currentSkill || 'surfaceUp',
                                mob: bot._mobility ? bot._mobility.state : null,
                                data: { why, dir: [c.dx, c.dz], from: { x: +start.x.toFixed(3), y: +start.y.toFixed(3), z: +start.z.toFixed(3) } },
                            }) + '\n');
                        } catch (e) {}
                    }
                    try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                    try { bot.clearControlStates(); } catch (e) {}
                    await bot.lookAt(target.offset(0.5, phase === 'runup' ? 1.05 : 1.25, 0.5), true);
                    bot.setControlState('sprint', false);
                    bot.setControlState('forward', true);
                    bot.setControlState('jump', true);
                    const t0 = Date.now();
                    while (Date.now() - t0 < (phase === 'runup' ? 1100 : 820)) {
                        const p = bot.entity.position;
                        if (p.y > maxY) maxY = p.y;
                        if (stepSucceeded(p)) break;
                        await skills.wait(bot, 45);
                    }
                    try { bot.clearControlStates(); } catch (e) {}
                    await skills.wait(bot, 120);
                    p1 = bot.entity.position.clone();
                    ok = stepSucceeded(p1);
                    if (ok) break;
                }
                if (!ok && roseEnough(p1) && !settledInTarget(p1)) {
                    try {
                        fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                            ts: new Date().toISOString(),
                            event: 'surfaceUp.step_edge.edge_miss',
                            pos: { x: +p1.x.toFixed(3), y: +p1.y.toFixed(3), z: +p1.z.toFixed(3) },
                            skill: bot._currentSkill || 'surfaceUp',
                            mob: bot._mobility ? bot._mobility.state : null,
                            env: envSnap(),
                            data: {
                                why,
                                dir: [c.dx, c.dz],
                                target: { x: target.x, y: target.y, z: target.z },
                                floor: { x: Math.floor(p1.x), y: Math.floor(p1.y), z: Math.floor(p1.z) },
                                targetDist: +targetDist(p1).toFixed(3),
                                recovery: 'center-press',
                            },
                        }) + '\n');
                    } catch (e) {}
                    try {
                        await bot.lookAt(target.offset(0.5, 1.15, 0.5), true);
                        bot.setControlState('sprint', false);
                        bot.setControlState('jump', false);
                        bot.setControlState('forward', true);
                        await skills.wait(bot, 420);
                    } finally {
                        try { bot.clearControlStates(); } catch (e) {}
                    }
                    await skills.wait(bot, 120);
                    p1 = bot.entity.position.clone();
                    ok = stepSucceeded(p1);
                }
                dbg(`step-edge assist end ok=${ok} y=${p0.y.toFixed(2)}->${p1.y.toFixed(2)} maxRise=${(maxY - p0.y).toFixed(2)} dist=${targetDist(p1).toFixed(2)} settled=${settledInTarget(p1)}`);
                try {
                    fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                        ts: new Date().toISOString(),
                        event: 'surfaceUp.step_edge.end',
                        pos: { x: +p1.x.toFixed(3), y: +p1.y.toFixed(3), z: +p1.z.toFixed(3) },
                        skill: bot._currentSkill || 'surfaceUp',
                        mob: bot._mobility ? bot._mobility.state : null,
                        env: envSnap(),
                        data: { ok, why, dir: [c.dx, c.dz], maxRise: +(maxY - p0.y).toFixed(3), targetDist: +targetDist(p1).toFixed(3), settledInTarget: settledInTarget(p1) },
                    }) + '\n');
                } catch (e) {}
                if (ok) return true;
            } catch (e) {
                try { bot.clearControlStates(); } catch (e2) {}
                dbg(`step-edge assist err ${e.message}`);
            } finally {
                if (bot._bodyMoveLockOwner === 'surfaceUp:step-edge') {
                    bot._bodyMoveLockOwner = null;
                    bot._bodyMoveLockUntil = 0;
                }
            }
        }
        return false;
    };
    const entryYSU = yNow();      // ★C362-broad 观测: EXIT 处对照入口 y, 打 'surfaceUp gained' 进度日志
    let c362Broad = false;        // 本次是否走了放宽后的无镐破顶路径 (climbToSurface 闭包内赋值)
    dbg(`ENTER y=${yNow()} target=${targetY} scaffold=${scafCount()} goalY=${typeof (goals.GoalY || goals.GoalYLevel)}`);
    if (surfaceReady()) { dbg('already at open surface'); return true; }

    // FREEZE the interrupting survival modes for the whole climb. At low HP (~5, after a
    // rough dive) self_preservation FLEES every tick and grabs the pathfinder, which
    // cancelled surfaceUp's climb goto instantly ("goal was changed before it could be
    // completed") — the bot then sat at y23 forever. Tick modes fighting us is the real
    // reason it couldn't surface, not pillarUp. Disable them while we climb; restore after.
    const GUARD = ['mobility', 'self_preservation', 'self_defense', 'item_collecting', 'unstuck', 'hunting', 'cowardice', 'idle_staring', 'elbow_room', 'torch_placing', 'auto_eat'];
    const prevModes = {};
    try { for (const m of GUARD) if (bot.modes && bot.modes.exists && bot.modes.exists(m)) { prevModes[m] = bot.modes.isOn(m); bot.modes.setOn(m, false); } } catch (e) {}
    try { bot.clearControlStates(); } catch (e) {}
    dbg(`modes frozen: ${Object.keys(prevModes).join(',')}`);
    try {
      await climbToSurface();
    } finally {
      try { for (const m in prevModes) bot.modes.setOn(m, prevModes[m]); } catch (e) {}
    }
    dbg(`EXIT y=${yNow()} (target ${targetY})`);
    // ★孤儿协程截止的可观测退出: 到点主动交还身体, 不再清 interrupt_code / 不再与调用方下一步打架。
    if (deadlineHit()) {
        dbg(`EXIT on caller deadline (opts.maxMs=${opts && opts.maxMs}) y=${yNow()}`);
        log(bot, `surfaceUp: caller deadline hit (maxMs=${opts && opts.maxMs}) — yielding body at y=${yNow()}.`);
        motion('surfaceUp.deadline.exit', { y: yNow(), maxMs: (opts && opts.maxMs) || 0 });
    }
    // C247: when the climb failed and we're still enclosed, dump a ground-truth scan so
    // the lateral-escape design can see whether a cave / drop-block is within reach.
    if (!surfaceReady()) {
        try {
            const sc = wideScan();
            dbg(`EXIT-SCAN ${JSON.stringify(sc)}`);
            motion('surfaceUp.exit_sealed_scan', { y: yNow(), hasPick: hasPick(), scaffold: scafCount(), scan: sc, env: envSnap() });
        } catch (e) { dbg(`exit-scan err ${e.message}`); }
    }
    // ★C362-broad 验证信号: 实际爬升了才打 gained (kernel/progress 可见); y>=50 场景出现
    // 'surfaceUp gained' = 放宽修复生效的直接证据.
    const gainedYSU = yNow() - entryYSU;
    if (gainedYSU >= 1) log(bot, `surfaceUp gained +${gainedYSU}y (y ${entryYSU}->${yNow()}${c362Broad ? ', C362-broad no-pick breach' : ''})`);
    log(bot, `surfaceUp done: y=${yNow()} (target ${targetY}).`);
    return surfaceReady();

    async function climbToSurface() {
    if (inWater()) {
        await swimOutOfWater();
        if (inWater()) {
            dbg(`water escape: still wet at y=${yNow()}, aborting surfaceUp to avoid underwater dig/place loop`);
            return false;
        }
    }
    // ---- PRIMARY: pathfinder carves a staircase up (digging allowed) --------------
    try {
        const moves = new Movements(bot);
        // No-pick pathfinding must be route-finding, not a hidden bare-hand stone miner.
        // Dirt/gravel cleanup is left to the manual fallback below; stone without a pick
        // is too slow and drops nothing, which caused the live famine surfacing deadlock.
        // No-pick pathfinding is normally route-finding only (stone bare-hand is slow/no-drop).
        // EXCEPTION: when sealed inside an enclosed cavity with no pick, route-finding alone can't
        // escape (no open path exists) — allow digging so it can break out (breakBlockAt now permits
        // bounded bare-hand stone; pathfinder still prefers dirt/gravel, cobble is high-cost fallback).
        const enclosedNoPick = !hasPick() && !!(bot._mobility && bot._mobility.enclosed);
        moves.canDig = hasPick() || enclosedNoPick;
        // ★never carve through own infrastructure (2026-07-02 05:21Z: pathfinder dug the
        // bot's white_bed, skill:null dig in mine_motion.jsonl) — beds/workstations/chests
        // join blocksCantBreak. typeof-guarded: this file hot-reloads and may run against a
        // pre-hardenMovements skills.js; ordinary terrain digging is unaffected.
        if (typeof skills.hardenMovements === 'function') { try { skills.hardenMovements(bot, moves); } catch (e) {} }
        moves.allow1by1towers = true;
        moves.allowParkour = false;
        const scaf = SCAFFOLD.map(n => mc.getBlockId(n)).filter(id => id != null);
        if (scaf.length) moves.scafoldingBlocks = scaf;
        bot.pathfinder.setMovements(moves);
        const GoalY = goals.GoalY || goals.GoalYLevel;
        const climbLeg = async (GoalY, legY) => {
            bot.pathfinder.setGoal(new GoalY(legY));
            const started = Date.now();
            let last = bot.entity.position.clone();
            let quiet = 0;
            let assisted = false;
            while (!surfaceReady() && yNow() < legY && Date.now() - started < 30000 && !deadlineHit()) {
                await skills.wait(bot, 700);
                if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} }
                const p = bot.entity.position.clone();
                const moved = p.distanceTo(last);
                const pathing = !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving());
                if (moved < 0.18 && !bot.targetDigBlock && !bot._mineMotionActiveDig) quiet++;
                else quiet = 0;
                if (quiet >= 3) {
                    const ok = await stepEdgeAssist(`leg-${legY}-quiet${quiet}`);
                    assisted = assisted || ok;
                    quiet = 0;
                    if (ok) {
                        bot.pathfinder.setGoal(new GoalY(legY));
                    } else if (!pathing && Date.now() - started > 2500) {
                        break;
                    } else if (Date.now() - started > 8000) {
                        break;
                    }
                }
                last = p;
            }
            try { bot.pathfinder.setGoal(null); } catch (e) {}
            return assisted;
        };
        // Climb in short legs so A* never times out on a tall shaft; monitor each leg
        // for the live "pathing but no controls / no movement" stair-edge stall.
        let stall = 0;
        while (!surfaceReady() && yNow() < targetY && stall < 4 && !deadlineHit()) {
            if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} }
            const y0 = yNow();
            const legY = Math.min(y0 + 8, targetY);
            let err = '';
            let assisted = false;
            try { assisted = await climbLeg(GoalY, legY); }
            catch (e) { err = e.message; }
            dbg(`pf leg ${y0}->${yNow()} (goal ${legY}) stall=${stall}${assisted ? ' assisted=1' : ''}${err ? ' err=' + err : ''}`);
            if (yNow() <= y0) stall++; else stall = 0;
        }
    } catch (e) { dbg(`pf block threw: ${e.message}`); log(bot, `surfaceUp pathfinder leg err: ${e.message}`); }
    finally { try { bot.pathfinder.setGoal(null); } catch (e) {} }
    if (surfaceReady()) { dbg(`reached open surface y=${yNow()} via pathfinder`); log(bot, `surfaceUp: reached open surface y=${yNow()} via pathfinder.`); return true; }
    dbg(`pathfinder phase done, still y=${yNow()} — entering fallback`);

    // ---- FALLBACK: dig straight-up headroom, then tower (pillarUp / manual) --------
    const seekHeadroomColumn = async () => {
        const open = (p) => {
            const b = bot.blockAt(p);
            return (!b || b.boundingBox !== 'block') && !(b && /water|lava/.test(b.name || ''));
        };
        const floor = (p) => {
            const b = bot.blockAt(p);
            return b && b.boundingBox === 'block' && !/lava/.test(b.name || '');
        };
        const m0 = bot.entity.position.floored();
        const candidates = [];
        for (let dx = -8; dx <= 8; dx++) {
            for (let dz = -8; dz <= 8; dz++) {
                const d = Math.abs(dx) + Math.abs(dz);
                if (d === 0 || d > 10) continue;
                const p = m0.offset(dx, 0, dz);
                if (!open(p) || !open(p.offset(0, 1, 0)) || !floor(p.offset(0, -1, 0))) continue;
                let clear = 0;
                for (let up = 2; up <= 10; up++) {
                    if (!open(p.offset(0, up, 0))) break;
                    clear++;
                }
                if (clear < 2) continue;
                candidates.push({ p, d, clear });
            }
        }
        candidates.sort((a, b) => (b.clear - a.clear) || (a.d - b.d));
        for (const c of candidates.slice(0, 6)) {
            if (deadlineHit()) break;
            dbg(`headroom candidate @${c.p.x},${c.p.y},${c.p.z} clear=${c.clear} d=${c.d}`);
            try {
                await Promise.race([
                    skills.goToPosition(bot, c.p.x + 0.5, c.p.y, c.p.z + 0.5, 0),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('headroom route timeout')), 6000)),
                ]);
            } catch (e) {
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                dbg(`headroom route failed @${c.p.x},${c.p.y},${c.p.z}: ${e.message}`);
                continue;
            }
            const here = bot.entity.position.floored();
            if (Math.abs(here.x - c.p.x) <= 1 && Math.abs(here.z - c.p.z) <= 1) {
                dbg(`headroom reached @${here.x},${here.y},${here.z} clear=${c.clear}`);
                return true;
            }
        }
        dbg(`headroom no candidates from @${m0.x},${m0.y},${m0.z}`);
        return false;
    };
    let headroomFound = false;
    if (!hasPick() && await seekHeadroomColumn()) {
        headroomFound = true;
        dbg(`headroom seek succeeded, retrying vertical climb from y=${yNow()}`);
    }
    let plannedStoneBreaches = 0;
    // Sealed inside an enclosed cavity with no pick = trapped; breaking out (even slow bare-hand
    // stone) beats rotting. Treat it like the famine emergency for breach budget/food gates.
    // ★C362 (2026-07-04 14h no-pick tomb livelock @y16: bot buried in a 1-wide stone pocket,
    // mobility state NOT flagged 'enclosed' so the 200-breach budget never engaged → stuck at
    // plannedStoneLimit=2 → verticalBlocked → 0.0y gained for 14 HOURS). Broaden: a pickless bot
    // with a SOLID stone ceiling directly overhead IS tombed regardless of what the mobility
    // classifier says — unlock the full bare-hand breach budget to grind out.
    // ★C362-broad (2026-07-04 晨): 原修只盖 y<50, 当天 y57 同类楔死/被埋活锁漏网 — "无镐+头顶
    // 实心可破"跟深度无关, y 门去掉. 新排除项: 自愿封顶 (夜宿) 时不要徒手拆自家棚顶 — 封顶旗
    // 有两面, 并联读取 (评审修正: 旧注释断言 nightShelter 不设旗, 并行改动后已失真):
    //   · prepNether.js (夜庇护封顶段) 的 bot._nightSealingUntil — TTL 12s, 只盖"正在垒块"瞬间
    //     (modes.js:3797 夜间封顶让位同款);
    //   · nightShelter.js 的 bot._nightSealedUntil — TTL 10s 滚动续期, 盖整夜 hold; 停止
    //     续期后自动过期, 不会 stale 到白天压住真石棺逃生.
    // 任一窗口内不触发放宽 — 夜宿口袋的棚顶不拆.
    const _ceilCapped = (() => {
        try {
            for (let h = 2; h <= 3; h++) {
                const c = bot.blockAt(bot.entity.position.offset(0, h, 0));
                if (c && c.boundingBox === 'block' && (NO_PICK_BREACHABLE.has(c.name) || /_ore$/.test(c.name || ''))) return true;
            }
        } catch (e) {}
        return false;
    })();
    const _nightSealHold = (() => { try {
        const now = Date.now();
        return !!((bot._nightSealedUntil && now < bot._nightSealedUntil) || (bot._nightSealingUntil && now < bot._nightSealingUntil));
    } catch (e) { return false; } })();
    const _mobEnclosed = !!(bot._mobility && bot._mobility.enclosed);
    const trappedEnclosed = !hasPick() && !_nightSealHold && (_mobEnclosed || _ceilCapped);
    if (trappedEnclosed && !_mobEnclosed) {
        c362Broad = true;
        dbg(`C362-broad: pickless under solid breachable ceiling at y=${yNow()} (mobility!=enclosed) — bare-hand breach budget unlocked (200)`);
        log(bot, `surfaceUp C362-broad: 无镐+头顶实心可破 (y=${yNow()}) — 徒手破顶预算解锁 (200)`);
        motion('surfaceUp.c362_broad.engaged', { y: yNow(), ceilCapped: _ceilCapped, env: envSnap() });
    } else if (!hasPick() && _ceilCapped && _nightSealHold) {
        dbg(`C362-broad suppressed: night-seal window active (_nightSealedUntil/_nightSealingUntil) — not breaching own shelter roof`);
        motion('surfaceUp.c362_broad.night_seal_hold', { y: yNow() });
    }
    const plannedStoneLimit = (famineEmergency() || trappedEnclosed) ? 200 : 2;
    const canPlanNoPickStoneBreach = (block, h) => {
        // ★C223b: ENTOMBED escape — *_ore blocks (coal_ore etc.) are bare-hand BREAKABLE (they just
        // don't DROP without a pick). A coal_ore ceiling was sealing the bot in a tomb at y67 under a
        // meadow ("fallback no-pick stone blocked at h=2 name=coal_ore"). Losing one ore drop beats a
        // permanent tomb — accept the plain stone family OR any *_ore (generic, covers deepslate ores).
        const nm = block && (block.name || '');
        if (!nm || (!NO_PICK_BREACHABLE.has(nm) && !/_ore$/.test(nm))) return false;
        if (plannedStoneBreaches >= plannedStoneLimit) return false;
        // C247: a trapped-enclosed bot in a TALL air pocket has its stone ceiling at h=4
        // (feet+4 = ~2.4 blocks above eye height, well within the ~4.5 reach). The old
        // `h>3` cap wrongly forbade breaching it unless famine (food<=2) — so a sealed
        // bot with food>2 could never break out of a 4-tall pocket (live: y66 pocket,
        // air y67-69, stone y70, frozen 2h). Allow trapped-enclosed up to the loop's h=4.
        if (h > 3 && !famineEmergency() && !trappedEnclosed) return false;
        const famineBreach = famineNoPickStoneBreachOk();
        // food8-13 dead-zone trap: the bot is sealed in, hp19, but food<14 blocked the breach and
        // food>2 missed the famine bypass → frozen forever. When trappedEnclosed, hp>=8 is enough
        // to break out (escaping the seal beats starving in it).
        if (!famineBreach && !trappedEnclosed && ((bot.health || 0) < 16 || bot.food < 14)) return false;
        // ★C237: hp<8 + trappedEnclosed was the no-pick TERMINAL FREEZE (live: hp6 food17 sealed
        // at y66, 0 pick / 0 wood / 209 cobble, spun `TABLE gate no wood` for hours; digReset
        // exists but nothing dispatched it, and THIS hp<8 floor blocked the only UPWARD escape).
        // Breaking UP is ZERO fall-risk (stableFloorBelow checked below) + ZERO hazard (water/
        // lava/fire/cactus/magma guarded below) + enclosed = no mob reaches during the breach, and
        // surfaceUp freezes the survival modes for the whole climb. The SOLE residual risk is
        // surfacing INTO darkness, so keep the hp<8 breach DAYTIME-only (day mobs burn). "Find
        // beats frozen" — escape the seal in daylight rather than rot in it. Night/dusk still HOLD.
        const breachTod = (() => { try { return bot.time.timeOfDay; } catch (e) { return 6000; } })();
        const breachIsNight = breachTod >= 13000 && breachTod <= 23000;
        if (trappedEnclosed && (bot.health || 0) < 8 && breachIsNight) return false;
        if (!stableFloorBelow()) return false;
        const cell = bot.entity.position.floored();
        for (const off of [[0, 0, 0], [0, 1, 0], [0, -1, 0]]) {
            const b = bot.blockAt(cell.offset(off[0], off[1], off[2]));
            if (b && /water|lava|fire|cactus|magma/.test(b.name || '')) return false;
        }
        return true;
    };
    const clearReplaceableFootTarget = async (why = 'manual-pillar') => {
        const cell = bot.entity.position.floored();
        const foot = bot.blockAt(cell);
        if (!foot || OPEN.has(foot.name || '')) return true;
        if (foot.boundingBox === 'block' || !FOOT_REPLACEABLE.has(foot.name || '')) return true;
        motion('surfaceUp.manual_pillar.clear_foot_target.begin', {
            why,
            block: blockName(foot),
            env: envSnap(),
        });
        let ok = false;
        let error = null;
        try {
            try { bot.clearControlStates(); } catch (e) {}
            try { await bot.lookAt(foot.position.offset(0.5, 0.35, 0.5), true); } catch (e) {}
            await Promise.race([
                bot.dig(foot, true),
                new Promise((_, rej) => setTimeout(() => rej(new Error('clear-foot-timeout')), 2500)),
            ]);
            await skills.wait(bot, 120);
            const after = bot.blockAt(cell);
            ok = !after || OPEN.has(after.name || '') || (after.boundingBox === 'empty' && !FOOT_REPLACEABLE.has(after.name || ''));
        } catch (e) {
            error = e && e.message ? e.message : String(e);
            try { bot.stopDigging(); } catch (_) {}
        } finally {
            try { bot.clearControlStates(); } catch (e) {}
        }
        motion('surfaceUp.manual_pillar.clear_foot_target.end', {
            why,
            ok,
            error,
            after: blockName(bot.blockAt(cell)),
            env: envSnap(),
        });
        return ok;
    };
    const underfootPillarHasHeadroom = (why = 'manual-pillar') => {
        const cell = bot.entity.position.floored();
        const head = bot.blockAt(cell.offset(0, 1, 0));
        const above = bot.blockAt(cell.offset(0, 2, 0));
        if (head && head.boundingBox === 'block' && !OPEN.has(head.name || '')) {
            motion('surfaceUp.manual_pillar.blocked_low_head', {
                why,
                head: blockName(head),
                above: blockName(above),
                env: envSnap(),
            });
            return false;
        }
        if (above && above.boundingBox === 'block' && !OPEN.has(above.name || '')) {
            motion('surfaceUp.manual_pillar.blocked_low_ceiling', {
                why,
                above: blockName(above),
                hasPick: hasPick(),
                env: envSnap(),
            });
            return false;
        }
        return true;
    };
    const manualPillar = async (mustBeatY = yNow()) => {
        const name = SCAFFOLD.find(n => (world.getInventoryCounts(bot)[n] || 0) > 0);
        if (!name) return false;
        if (!(await clearReplaceableFootTarget('manual-pillar'))) return false;
        if (!underfootPillarHasHeadroom('manual-pillar')) return false;
        const y0 = Math.max(yNow(), mustBeatY);
        try {
            await skills.placeBlockUnderFeet(bot, name, { retries: 1, settleMs: 220 });
        } catch (e) { try { bot.setControlState('jump', false); } catch (_) {} }
        await new Promise(r => setTimeout(r, 250));
        return yNow() > y0;
    };
    const scaffoldStep = async () => {
        const name = SCAFFOLD.find(n => (world.getInventoryCounts(bot)[n] || 0) > 0);
        if (!name) return false;
        const open = (p) => {
            const b = bot.blockAt(p);
            return (!b || b.boundingBox !== 'block') && !(b && /water|lava/.test(b.name || ''));
        };
        const y0 = yNow();
        const m = bot.entity.position.floored();
        for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
            const foot = m.offset(dx, 0, dz);
            if (!open(foot) || !open(m.offset(dx, 1, dz)) || !open(m.offset(dx, 2, dz))) continue;
            const bp = bot.entity.position;
            if (Math.hypot(bp.x - (foot.x + 0.5), bp.z - (foot.z + 0.5)) < 0.85) continue;
            let ref = bot.blockAt(m.offset(dx, -1, dz)), face = Vec3 ? new Vec3(0, 1, 0) : null;
            if (!(ref && ref.boundingBox === 'block')) {
                ref = bot.blockAt(m.offset(0, -1, 0));
                face = Vec3 ? new Vec3(dx, 0, dz) : null;
            }
            if (!(ref && ref.boundingBox === 'block') || !face) continue;
            try { await bot.equip(bot.inventory.items().find(it => it.name === name), 'hand'); } catch (e) {}
            try { await bot.placeBlock(ref, face); } catch (e) { continue; }
            try { await bot.lookAt(m.offset(dx + 0.5, 1.6, dz + 0.5), true); } catch (e) {}
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 1000));
            try { bot.clearControlStates(); } catch (e) {}
            await new Promise(r => setTimeout(r, 200));
            if (yNow() > y0) {
                dbg(`scaffold-step ${name} d=${dx},${dz} rose ${y0}->${yNow()}`);
                return true;
            }
        }
        return false;
    };
    const stableFloorBelow = () => {
        try {
            const m = bot.entity.position.floored();
            const below = bot.blockAt(m.offset(0, -1, 0));
            return !!(below && below.boundingBox === 'block' && !/water|lava|fire|cactus|magma/.test(below.name || ''));
        } catch (e) { return false; }
    };
    const ensureStableFooting = async (why = 'fallback') => {
        if (stableFloorBelow()) return true;
        const p0 = bot.entity.position.clone();
        motion('surfaceUp.footing.unstable', {
            why,
            pos: { x: +p0.x.toFixed(3), y: +p0.y.toFixed(3), z: +p0.z.toFixed(3) },
            env: envSnap(),
        });
        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}
        await skills.wait(bot, 420);
        if (stableFloorBelow()) {
            const p1 = bot.entity.position;
            motion('surfaceUp.footing.settled', {
                why,
                from: { x: +p0.x.toFixed(3), y: +p0.y.toFixed(3), z: +p0.z.toFixed(3) },
                to: { x: +p1.x.toFixed(3), y: +p1.y.toFixed(3), z: +p1.z.toFixed(3) },
                env: envSnap(),
            });
            return true;
        }
        const name = SCAFFOLD.find(n => (world.getInventoryCounts(bot)[n] || 0) > 0);
        if (name) {
            try {
                const rose = await manualPillar(yNow());
                if (stableFloorBelow() || rose) {
                    motion('surfaceUp.footing.pillar_recovered', { why, block: name, rose, y: yNow(), env: envSnap() });
                    return true;
                }
            } catch (e) {
                motion('surfaceUp.footing.pillar_failed', { why, block: name, error: e && e.message ? e.message : String(e), env: envSnap() });
            }
        }
        motion('surfaceUp.footing.blocked', { why, y: yNow(), env: envSnap() });
        return false;
    };
    // C247 LATERAL ESCAPE: vertical surfacing is hopeless when sealed with no pick and
    // too few pillar blocks (live: 2 planks can't tower the ~21 blocks from a y66 tomb to
    // the surface; pillarUp historically only worked because it had 209 cobble). A self-dug
    // stone micro-tomb almost always sits beside a connected cave — so when the vertical
    // climb stalls, tunnel HORIZONTALLY toward the nearest opening: zero fall-risk, and once
    // open space is reached the normal pathfinder/vertical phases take over next cycle.
    // canDig=true lets A* carve the corridor (safeToBreak ignores the pickaxe — bare-hand
    // stone breaks, just slowly); dontCreateFlow + hazard scan keep it off water/lava.
    let lateralTried = false;
    const cellOpen = (p) => { const b = bot.blockAt(p); return !b || b.boundingBox === 'empty' || OPEN.has(b.name || ''); };
    const cellHazard = (p) => { const b = bot.blockAt(p); return b && /water|lava|fire|magma/.test(b.name || ''); };
    // Find an adjacent (incl. diagonal) cell the bot can step into that DROPS into a lower
    // cavity: foot+head open AND the block below open (a hole). Returns {dx,dz,depth} of the
    // deepest such drop. A self-dug micro-pocket usually opens downward into the cave it was
    // dug from — descending reconnects to the cave system (a real up-route elsewhere), and for
    // a naked hp-low bot even a fatal drop is a clean spawn-reset, both beat an eternal freeze.
    const findDescent = (c0) => {
        let best = null;
        for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const foot = c0.offset(dx, 0, dz), head = c0.offset(dx, 1, dz), below = c0.offset(dx, -1, dz);
            if (!cellOpen(foot) || !cellOpen(head) || !cellOpen(below)) continue;
            if (cellHazard(foot) || cellHazard(head) || cellHazard(below)) continue;
            let depth = 0;
            for (let dy = -1; dy >= -16; dy--) {
                const p = c0.offset(dx, dy, dz);
                if (cellHazard(p)) { depth = -1; break; }   // lava/water column — skip this dir
                if (cellOpen(p)) depth++; else break;
            }
            if (depth >= 1 && (!best || depth > best.depth)) best = { dx, dz, depth };
        }
        return best;
    };
    const lateralEscape = async () => {
        const start = bot.entity.position.clone();
        const c0 = start.floored();
        const scan = wideScan(14);
        // A REAL lateral opening lies BEYOND a wall (toAir>=2). toAir==1 is just the bot's own
        // pocket edge — pathing to it is a no-op (live: pz toAir=1 → moved=0, looped forever).
        const cand = [['px', 1, 0], ['nx', -1, 0], ['pz', 0, 1], ['nz', 0, -1]]
            .map(([k, dx, dz]) => ({ k, dx, dz, toAir: scan[k] && scan[k].toAir }))
            .filter(o => Number.isFinite(o.toAir) && o.toAir >= 2 && o.toAir <= 14)
            .sort((a, b) => a.toAir - b.toAir);
        const descent = findDescent(c0);
        dbg(`lateral: scan ${JSON.stringify(scan)} cand=${cand.map(c => c.k + ':' + c.toAir).join(',') || 'none'} descent=${descent ? `${descent.dx},${descent.dz} depth=${descent.depth}` : 'none'}`);
        motion('surfaceUp.lateral.begin', { y: yNow(), scan, cand: cand.map(c => ({ k: c.k, toAir: c.toAir })), descent, env: envSnap() });

        // A DEEP descent (>=4) is a real cavity worth dropping into; a shallow one (live
        // depth=1) is just an adjacent micro-pocket — descending it only to have the same
        // fallback's step-edge-assist climb back up = y65↔y66 oscillation. So shallow
        // descents are ignored; the committed escape is a HOMEWARD horizontal carve.
        if (descent && descent.depth >= 4) {
            // Manual step+fall into the connected lower cavity (pathfinder refuses big drops).
            const tx = c0.x + descent.dx, tz = c0.z + descent.dz;
            dbg(`lateral: DEEP-DESCEND ${descent.dx},${descent.dz} depth=${descent.depth} → step into ${tx},${c0.y},${tz}`);
            try {
                try { bot.pathfinder.setGoal(null); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                await bot.lookAt(new Vec3(tx + 0.5, c0.y + 0.3, tz + 0.5), true);
                bot.setControlState('forward', true);
                bot.setControlState('sprint', false);
                const t0 = Date.now();
                while (Date.now() - t0 < 4000) {
                    await skills.wait(bot, 120);
                    if (yNow() < c0.y - 0.5 || bot.entity.position.distanceTo(start) > 1.4) break;
                }
            } catch (e) { dbg(`lateral descend err ${e.message}`); }
            finally { try { bot.clearControlStates(); } catch (e) {} }
            await skills.wait(bot, 400);
        } else {
            // MANUAL HOMEWARD TUNNEL. The pathfinder will NOT carve stone here (proven live:
            // GoalY 66->66, GoalNear horizontal 63ms moved=0 — A* refuses the dig-corridor);
            // but guardedDig breaks bare-hand stone fine (it broke the y70 ceiling in 8s). So
            // dig the 2-tall corridor toward spawn ONE block at a time and step in — the
            // mineDown idiom, horizontal. Toward spawn = trees + open surface, and the hill
            // thins that way. ~8 blocks/call, cumulative across cycles → out of the stone core.
            // Aim at a real cave-mouth if wideScan found one; else the dominant home axis.
            const sp = (bot.spawnPoint && Number.isFinite(bot.spawnPoint.x)) ? bot.spawnPoint : { x: 0, y: 87, z: 0 };
            let stepDx, stepDz;
            if (cand.length) { stepDx = cand[0].dx; stepDz = cand[0].dz; }
            else {
                const ddx = sp.x - c0.x, ddz = sp.z - c0.z;
                if (Math.abs(ddx) >= Math.abs(ddz)) { stepDx = Math.sign(ddx) || 1; stepDz = 0; }
                else { stepDx = 0; stepDz = Math.sign(ddz) || 1; }
            }
            const why = cand.length ? `cave-mouth ${cand[0].k}` : `homeward ${stepDx},${stepDz}`;
            dbg(`lateral: MANUAL-TUNNEL ${why} from ${c0.x},${c0.y},${c0.z}`);
            const budget = 8;
            let carved = 0;
            try { bot.pathfinder.setGoal(null); } catch (e) {}
            for (let s = 0; s < budget && !deadlineHit(); s++) {
                const cur = bot.entity.position.floored();
                const aheadFoot = cur.offset(stepDx, 0, stepDz);
                const aheadHead = cur.offset(stepDx, 1, stepDz);
                if (cellHazard(aheadFoot) || cellHazard(aheadHead) || cellHazard(aheadFoot.offset(0, -1, 0))) { dbg(`tunnel: hazard ahead at step ${s}, stop`); break; }
                for (const p of [aheadHead, aheadFoot]) {
                    const b = bot.blockAt(p);
                    if (b && b.boundingBox === 'block' && !OPEN.has(b.name)) {
                        try { bot._plannedNoPickStoneUntil = Date.now() + 15000; } catch (e) {}   // enable bare-hand stone in guardedDig
                        await guardedDig(b, 'tunnel');
                    }
                }
                try {
                    await bot.lookAt(new Vec3(aheadFoot.x + 0.5, aheadFoot.y + 0.5, aheadFoot.z + 0.5), true);
                    bot.setControlState('forward', true);
                    const t0 = Date.now();
                    while (Date.now() - t0 < 1600) { await skills.wait(bot, 100); if (bot.entity.position.floored().distanceTo(cur) >= 1) break; }
                } finally { try { bot.clearControlStates(); } catch (e) {} }
                const after = bot.entity.position.floored();
                if (after.x === cur.x && after.z === cur.z && after.y >= cur.y) { dbg(`tunnel: no advance after dig at step ${s} (block left?) stop`); break; }
                carved++;
            }
            dbg(`lateral: MANUAL-TUNNEL carved=${carved}/${budget}`);
        }
        const moved = bot.entity.position.distanceTo(start);
        const fp = bot.entity.position.floored();
        dbg(`lateral: end moved=${moved.toFixed(1)} y=${yNow()} pos=${fp.x},${fp.y},${fp.z}`);
        motion('surfaceUp.lateral.end', { y: yNow(), moved: +moved.toFixed(2), mode: (descent && descent.depth >= 4) ? 'deep-descend' : 'carve', env: envSnap() });
        return moved > 1.2 || yNow() < c0.y - 0.5;
    };
    let stuckFloor = 0;
    for (let i = 0; i < 100 && !surfaceReady() && !deadlineHit(); i++) {
        try { bot.interrupt_code = false; } catch (e) {}
        const y0 = yNow();
        let opened = 0;
        let verticalBlocked = false;
        if (!(await ensureStableFooting(`fallback-iter-${i}-before-dig`))) {
            if (await stepEdgeAssist(`fallback-unstable-${stuckFloor}`)) continue;
            if (await scaffoldStep()) continue;
            break;
        }
        for (let h = 2; h <= 4; h++) {
            const c = bot.blockAt(bot.entity.position.offset(0, h, 0));
            if (!c) { opened++; continue; }
            if (NO_DIG.has(c.name)) break;
            if (!OPEN.has(c.name)) {
                if (!hasPick() && STONY.test(c.name)) {
                    await ensureEmergencyPick();
                    if (!hasPick()) {
                        if (canPlanNoPickStoneBreach(c, h)) {
                            plannedStoneBreaches++;
                            try { bot._plannedNoPickStoneUntil = Date.now() + 15000; } catch (e) {}
                            dbg(`fallback planned no-pick stone breach ${plannedStoneBreaches}/${plannedStoneLimit} at h=${h} name=${c.name}`);
                            motion('surfaceUp.no_pick_stone.planned_breach', {
                                h,
                                block: `${c.name}@${c.position.x},${c.position.y},${c.position.z}`,
                                food: bot.food,
                                hp: Math.round(bot.health || 0),
                                plannedStoneBreaches,
                                plannedStoneLimit,
                                env: envSnap(),
                            });
                        } else {
                            verticalBlocked = true;
                            dbg(`fallback no-pick stone blocked at h=${h} name=${c.name}`);
                            motion('surfaceUp.no_pick_stone.blocked', {
                                h,
                                block: `${c.name}@${c.position.x},${c.position.y},${c.position.z}`,
                                food: bot.food,
                                hp: Math.round(bot.health || 0),
                                plannedStoneBreaches,
                                plannedStoneLimit,
                                scan: wideScan(),   // C247: ground-truth for lateral-escape aiming
                            });
                            break;
                        }
                    }
                }
                const digY = yNow();
                const dug = await guardedDig(c, 'fallback');
                const afterDigY = yNow();
                if (!dug) {
                    verticalBlocked = true;
                    dbg(`fallback clear failed at h=${h} name=${c.name} y=${afterDigY} — guardedDig returned false`);
                    break;
                }
                if (afterDigY < digY) {
                    verticalBlocked = true;
                    motion('surfaceUp.fallback.fell_during_dig', {
                        h,
                        block: `${c.name}@${c.position.x},${c.position.y},${c.position.z}`,
                        fromY: digY,
                        toY: afterDigY,
                        env: envSnap(),
                    });
                    dbg(`fallback fell during dig at h=${h} ${c.name}: ${digY}->${afterDigY}; stabilizing before more headroom`);
                    break;
                }
                const after = bot.blockAt(c.position);
                if (after && after.boundingBox === 'block' && !OPEN.has(after.name)) {
                    verticalBlocked = true;
                    dbg(`fallback clear failed at h=${h} name=${after.name} y=${yNow()} — stop treating it as opened`);
                    break;
                }
            }
            opened++;
        }
        if ((verticalBlocked || opened < 2) && await scaffoldStep()) continue;
        try { await skills.pillarUp(bot, Math.min(y0 + Math.max(2, opened), targetY)); } catch (e) {}
        if (yNow() <= y0) {
            let rose = false;
            for (let m = 0; m < 3 && !rose; m++) rose = await manualPillar(y0);
            const progressed = yNow() > y0;
            if (!progressed) stuckFloor++;
            else stuckFloor = 0;
            dbg(`fallback iter ${i}: opened=${opened} y ${y0}->${yNow()} manualRose=${rose} progressed=${progressed} stuckFloor=${stuckFloor}`);
            if (!progressed) {
                if (await stepEdgeAssist(`fallback-stuck-${stuckFloor}`)) continue;
                if (await scaffoldStep()) continue;
                // C247: vertical is sealed and we have no pick / no pillar stock — the only
                // real exit is sideways into the adjacent cave. Try ONCE per surfaceUp call,
                // then let the loop re-evaluate (surfaceReady / vertical) from the new spot.
                if (stuckFloor >= 2 && trappedEnclosed && !hasPick() && !lateralTried) {
                    lateralTried = true;
                    dbg(`fallback: vertical sealed (stuckFloor=${stuckFloor}) + trappedEnclosed + no pick → lateral escape`);
                    // On success BREAK (not continue): the lateral move relocated the bot;
                    // re-entering this climb loop would let step-edge-assist climb straight
                    // back up and undo it (live: descend y66→65 then assist climbed 65→66).
                    if (await lateralEscape()) { dbg(`lateral moved bot → EXIT surfaceUp, re-eval next cycle`); break; }
                }
                // ★C223c: exit ONLY after 3 CONSECUTIVE stuck iters — not on the first manualPillar
                // miss (`!rose`). The old `!rose ||` aborted the climb after ONE transient pillar
                // failure, stranding the bot mid-shaft (observed: rose 67→68→69 then EXIT at iter 2
                // stuckFloor=1 because manualPillar momentarily returned false). stuckFloor>=3 with the
                // inner manualPillar×3 retries gives real persistence while staying bounded.
                if (stuckFloor >= 3) break;
            }
        } else {
            stuckFloor = 0;
            dbg(`fallback iter ${i}: pillarUp rose ${y0}->${yNow()}`);
        }
    }
    } // end climbToSurface
}
