// Hot-reloadable ORCHESTRATION: gear up to diamond and gather the nether-portal
// prerequisites, self-sufficiently. Drives achieve() for each goal (craftables +
// diamond/obsidian mining), equips armour as it goes. Runs under the supervised
// lock (LLM silenced) via run_skill. This is the staging step before building &
// lighting a nether portal. Invoked via: {"skill":"prepNether"}
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const OAK_APPLE_BACKOFF = path.resolve(process.cwd(), 'bots', '_supervisor', 'oak_apple_backoff.json');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };
const readOakAppleBackoff = () => {
    try {
        const rec = JSON.parse(fs.readFileSync(OAK_APPLE_BACKOFF, 'utf8'));
        return rec && typeof rec.until === 'number' && rec.until > Date.now() ? rec : null;
    } catch (e) { return null; }
};
const writeOakAppleBackoff = (rec) => {
    try { fs.writeFileSync(OAK_APPLE_BACKOFF, JSON.stringify(rec)); } catch (e) {}
};

export default async function prepNether(bot, ctx) {
    const { skills, world, mc, log, Vec3 } = ctx;
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const equipArmor = async () => { if (bot.armorManager) { try { await bot.armorManager.equipAll(); } catch (e) {} } };
    const cancelRequested = () => !!(bot._supervisorCancelAt && Date.now() - bot._supervisorCancelAt < 30000);
    // HUMAN RHYTHM + RESOURCE SENSE: night only matters when EXPOSED on the surface. Being
    // UNDERGROUND is safe, and if we're well-supplied (pickaxe + blocks + food) the smart move
    // at night is to be DOWN mining — not idling, not grinding exposed. So we only hole up when
    // we're on the exposed surface AND not equipped to go mine safely. (This fixes the too-rigid
    // "always hide at night" — per the resource-management instinct, a kitted bot spends the
    // night productively underground.)
    const isNightNow = () => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } };
    // DUSK = sun setting, mobs about to spawn (~12000→13000). Used for a PROACTIVE pre-night
    // securing pass (the user's "入夜前明确提醒") so we never get caught leisurely working when
    // night actually lands.
    const isDuskNow = () => { try { const t = bot.time.timeOfDay; return t >= 12000 && t < 13000; } catch (e) { return false; } };
    // "深处=安全"必须同时无怪: 199死在y54黑隧道(苦力怕背刺1.8格爆) — 深度挡不住已经
    // 刷在隧道里的怪。夜间继续作业的门槛: 真的深(y<50) 且 12格内干净。
    const undergroundSafe = () => { try { return bot.entity.position.y < 50 && hostilesNear(12) === 0; } catch (e) { return bot.entity.position.y < 50; } };
    const canMineSafely = () => {
        const c = world.getInventoryCounts(bot);
        const pick = ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'].some(p => (c[p] || 0) > 0);
        const blocks = (c.dirt || 0) + (c.cobblestone || 0) + (c.cobbled_deepslate || 0) + (c.stone || 0) + (c.netherrack || 0) >= 8;
        return pick && blocks;   // kitted to dig down & seal a mining tunnel safely
    };
    // ★装备感知 (用户: 有铁剑+盾却被僵尸打死). If we're equipped to WIN a night fight (sword +
    // shield + decent HP), DON'T hole up idle — keep working; modes.self_defense kills mobs with
    // the gear as they come (mirrors modes.shouldNightShelter's canWin). Only the NAKED/weak bot
    // holes up at night. This is the "equipped human works through the night, fights off zombies".
    const canFightNight = () => {
        const c = world.getInventoryCounts(bot);
        const sword = Object.keys(c).some(n => /_sword$/.test(n) && c[n] > 0);
        const shield = (c.shield || 0) > 0;
        // ★C256: must also be ARMORED. An UNARMORED bot (armorCount=0) takes unmitigated
        // damage and CANNOT survive a multi-mob night swarm even with sword+shield — it can't
        // block 5 directions and out-DPS them while eating full hits. Deaths 1 & 5 this world
        // (and ~86% of all historical deaths per death_log) were unarmored bots that read
        // "sword+shield = safe enough", skipped sealing/holding, and got swarmed exposed. With
        // no armor → canFightNight is false → the bot ALWAYS holes up+seals at night instead of
        // working the surface. Underground/enclosed night mining is still allowed (separate
        // breaks at the undergroundSafe / _mobility.enclosed checks), so this only forbids
        // EXPOSED-SURFACE night work for a squishy bot. Once it has armor (leather counts; pairs
        // with the C255 iron fix → iron armor), it may fight/work at night again.
        const armor = Object.keys(c).filter(n => /_(helmet|chestplate|leggings|boots)$/.test(n) && c[n] > 0).length;
        return sword && shield && armor >= 1 && bot.health >= 10;
    };
    const hasEdible = () => bot.inventory.items().some(i =>
        i && i.name &&
        /beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|berries|potato|carrot|melon|cookie|pumpkin_pie|beetroot|mushroom_stew|rabbit_stew|suspicious_stew/i.test(i.name) &&
        i.name !== 'rotten_flesh');
    const snacklessCritical = () => !hasEdible() && (bot.food <= 8 || bot.health <= 10);
    const famineBudget = () => !hasEdible() && (bot.food <= 2 || (bot.food <= 6 && bot.health <= 10));
    const bodyBudgetBunkerHold = () => !hasEdible() && bot.food <= 6 && bot.health <= 8;
    const coveredAboveNow = () => {
        try {
            for (let dy = 1; dy <= 3; dy++) {
                const h = bot.blockAt(bot.entity.position.offset(0, dy, 0));
                if (h && h.boundingBox === 'block') return true;
            }
        } catch (e) {}
        return false;
    };
    const containedMobilityNow = () => {
        const mobState = (bot._mobility && (bot._mobility.state || '')) || '';
        return !!(bot._mobility && bot._mobility.enclosed) || /POCKET|ENC|MAROONED|ENTOMBED/.test(mobState);
    };
    const shouldDuskShelter = () => isDuskNow() && snacklessCritical() && !undergroundSafe() && !canFightNight();
    const shouldDayFamineHostileShelter = () => {
        try {
            const securedLowResourceHold = bodyBudgetBunkerHold() && (coveredAboveNow() || containedMobilityNow());
            const threatRadius = securedLowResourceHold ? 10 : 16;
            const localThreat = noRegenActionableThreats(threatRadius);
            const advisoryThreat = freshAdvisoryThreat();
            const actionable = advisoryThreat ? advisoryThreat.actionable : localThreat.actionable;
            return famineBudget()
                && !isNightNow()
                && !undergroundSafe()
                && (!bot.game || !bot.game.dimension || /overworld/.test(bot.game.dimension))
                && actionable > 0;
        } catch (e) { return false; }
    };
    // ★SPAWN-PROOF (用户洞察): hostile mobs only spawn in DARKNESS (block light 0). A ring of
    // torches around us lights the area → NO mobs spawn here → no night swarm to fight/flee at
    // all. This is strictly better than passively bunkering/kiting ONCE WE HAVE TORCHES. Bounded
    // (≤6 torches, within reach), skips if <3 torches (early naked nights still rely on the
    // instant-bunker). Lights the immediate ~6-block bubble — enough to hold/work the night safely.
    const spawnProof = async () => {
        if (bot.interrupt_code || has('torch') < 3) return;
        const base = bot.entity.position.floored();
        const offs = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]];
        let placed = 0;
        for (const [dx, dz] of offs) {
            if (has('torch') < 1 || placed >= 6 || bot.interrupt_code) break;
            for (let dy = 1; dy >= -2; dy--) {
                const gp = base.offset(dx, dy - 1, dz), ap = base.offset(dx, dy, dz);
                const g = bot.blockAt(gp), a = bot.blockAt(ap);
                const solid = g && g.boundingBox === 'block' && !/water|lava/.test(g.name || '');
                const open = a && /^(air|cave_air|short_grass|tall_grass|snow)$/.test(a.name || '');
                if (solid && open) {
                    try { await skills.placeBlock(bot, 'torch', ap.x, ap.y, ap.z, 'bottom', true); placed++; } catch (e) {}
                    break;
                }
            }
        }
        if (placed > 0) prog(`prepNether: spawn-proofed with ${placed} torches (no-spawn zone)`);
    };
    const nightBunkerStaticWeapon = async (opts = {}) => {
        try {
            let c = world.getInventoryCounts(bot);
            const refresh = () => { c = world.getInventoryCounts(bot); return c; };
            if (Object.keys(c).some(n => /_sword$/.test(n) && c[n] > 0)) return false;
            const hostileCount = hostilesNear(8);
            const threat = noRegenActionableThreats(8);
            const daylightSingleSpider = !!opts.allowDaySingleSpider
                && !isNightNow()
                && hostileCount === 1
                && bot.health >= 12
                && Object.values(bot.entities).some(e =>
                    e && e.position && /spider/i.test(e.name || '')
                    && e.position.distanceTo(bot.entity.position) < 8);
            if (threat.actionable > 0 && !daylightSingleSpider) return false;
            const planksEq = Object.keys(c).filter(k => k.endsWith('_planks')).reduce((s, k) => s + c[k], 0)
                + Object.keys(c).filter(k => k.endsWith('_log')).reduce((s, k) => s + c[k], 0) * 4;
            if (planksEq < 3) return false;
            if (bot._lastNightStaticWeaponAt && Date.now() - bot._lastNightStaticWeaponAt < 30000) return false;
            bot._lastNightStaticWeaponAt = Date.now();
            const reason = opts.reason || (daylightSingleSpider ? 'DAY spider-lock' : 'NIGHT');
            const directCraft = async (itemName, tableBlock = null) => {
                try {
                    const item = bot.registry.itemsByName[itemName];
                    if (!item || typeof bot.recipesAll !== 'function') return false;
                    const recipes = bot.recipesAll(item.id, null, tableBlock) || [];
                    const recipe = recipes.find(r => r && (!r.requiresTable || tableBlock)
                        && (r.delta || []).every(d => d.count >= 0 || bot.inventory.count(d.id, d.metadata) >= -d.count));
                    if (!recipe) {
                        prog(`prepNether: ${reason} direct craft no recipe for ${itemName}`);
                        return false;
                    }
                    try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                    try { bot.clearControlStates(); } catch (e) {}
                    await bot.craft(recipe, 1, tableBlock);
                    prog(`prepNether: ${reason} direct crafted ${itemName} now=${has(itemName)}`);
                    return true;
                } catch (e) {
                    prog(`prepNether: ${reason} direct craft ${itemName} err ${e.message}`);
                    return false;
                } finally {
                    try { bot.clearControlStates(); } catch (e) {}
                    refresh();
                }
            };
            const threatNearest = threat.nearest ? `${threat.nearest.name}@${threat.nearest.d.toFixed(1)} dy=${threat.nearest.dy.toFixed(1)}` : 'none';
            prog(`prepNether: ${reason} static weapon check food=${bot.food} hp=${Math.round(bot.health)} planksEq=${planksEq} table=${c.crafting_table || 0} hostiles8=${hostileCount} actionable8=${threat.actionable} layered8=${threat.layered} nearest=${threatNearest}`);
            const maxPlankStack = () => Math.max(0, ...Object.keys(c).filter(k => k.endsWith('_planks')).map(k => c[k] || 0));
            if (maxPlankStack() < 4) {
                const logName = Object.keys(c).find(k => k.endsWith('_log') && c[k] > 0);
                if (logName) {
                    const plankName = logName.replace(/_log$/, '_planks');
                    await skills.craftRecipeLocal(bot, plankName, 1).catch(e => prog(`prepNether: ${reason} static planks err ${e.message}`));
                    if (Math.max(0, ...Object.keys(refresh()).filter(k => k.endsWith('_planks')).map(k => c[k] || 0)) < 4) await directCraft(plankName, null);
                    refresh();
                }
            }
            if ((c.crafting_table || 0) < 1 && !world.getNearestBlock(bot, 'crafting_table', 4) && Object.keys(c).some(k => k.endsWith('_planks') && c[k] >= 4)) {
                const beforeTable = has('crafting_table');
                await skills.craftRecipeLocal(bot, 'crafting_table', 1).catch(e => prog(`prepNether: ${reason} static table err ${e.message}`));
                refresh();
                if (has('crafting_table') <= beforeTable && !world.getNearestBlock(bot, 'crafting_table', 4)) await directCraft('crafting_table', null);
            }
            if (!world.getNearestBlock(bot, 'crafting_table', 4) && has('crafting_table') > 0) {
                try { await skills.placeBlockNearby(bot, 'crafting_table', 2); } catch (e) { prog(`prepNether: ${reason} static table place err ${e.message}`); }
                refresh();
            }
            if (has('stick') < 1) {
                const beforeStick = has('stick');
                await skills.craftRecipeLocal(bot, 'stick', 1).catch(e => prog(`prepNether: ${reason} static stick err ${e.message}`));
                refresh();
                if (has('stick') <= beforeStick) await directCraft('stick', null);
            }
            const sword = has('cobblestone') >= 2 ? 'stone_sword' : 'wooden_sword';
            const before = has(sword);
            await skills.craftRecipeLocal(bot, sword, 1).catch(e => prog(`prepNether: ${reason} static ${sword} err ${e.message}`));
            if (has(sword) <= before) {
                const table = world.getNearestBlock(bot, 'crafting_table', 4);
                if (table && bot.entity.position.distanceTo(table.position) <= 4.5) await directCraft(sword, table);
            }
            if (has(sword) > before) {
                await skills.equip(bot, sword).catch(() => {});
                prog(`prepNether: ${reason} static ${sword} crafted/equipped count=${has(sword)}`);
                return true;
            }
        } catch (e) { prog(`prepNether: static weapon err ${e.message}`); }
        return false;
    };
    const holeUpAtNight = async () => {
        let logged = false, proofed = false;
        // A STALE interrupt (death-abort / finished flee) must not skip the night hold:
        // that exact skip let a naked respawn walk straight into wood-chopping at night
        // beside the zombie that just killed it (death 195 → spiral). Clear it and give
        // modes 800ms — a LIVE fight re-sets interrupt_code within ticks and the hold
        // loop below still yields to it; only the GHOST flag is neutralized here.
        if (isNightNow() && bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} try { await skills.wait(bot, 800); } catch (e) {} }
        // ★夜晚意识 (用户诊断: bot 没夜晚意识,天黑还慢悠悠挖→被偷袭死). TWO proactive changes:
        // (A) DUSK pre-warning + securing BEFORE mobs spawn — don't wait for night to land.
        // (B) At night on the SURFACE, ALWAYS secure (spawn-proof + hole up). The old code let
        //     `canMineSafely()` (有镐+方块) skip holing-up → the bot kept LEISURELY surface-mining
        //     exposed at night and got ambushed. "能挖"≠"地表夜里安全". Only genuinely-deep
        //     (undergroundSafe, y<50) lets work continue — there it's already safe to mine.
        if (isDuskNow() && !undergroundSafe() && !bot.interrupt_code) {
            prog('prepNether: ★DUSK 天黑将至 — 主动收尾转生存(spawn-proof + 准备入夜)');
            try { await spawnProof(); } catch (e) {} proofed = true;
        }
        let dugIn = false;
        while ((isNightNow() || shouldDuskShelter() || shouldDayFamineHostileShelter()) && !bot.interrupt_code && !cancelRequested()) {
            const duskCriticalHold = shouldDuskShelter();
            const dayFamineHostileHold = shouldDayFamineHostileShelter();
            if (duskCriticalHold && !logged) {
                prog(`prepNether: ★DUSK critical snackless shelter — hp=${Math.round(bot.health)} food=${bot.food}; hole up now, no feedUp/kit`);
                logged = true;
            }
            if (dayFamineHostileHold && !logged) {
                const threat10 = noRegenActionableThreats(10);
                prog(`prepNether: ★DAY famine-hostile shelter — hp=${Math.round(bot.health)} food=${bot.food} hostiles10=${hostilesNear(10)} actionable10=${threat10.actionable} layered10=${threat10.layered} hostiles16=${hostilesNear(16)} secured=${bodyBudgetBunkerHold() && (coveredAboveNow() || containedMobilityNow())}; no exposed freeze`);
                logged = true;
            }
            if (!duskCriticalHold && !dayFamineHostileHold && undergroundSafe()) break;   // 真正深处(y<50)=已安全 → 继续作业(不再用 canMineSafely 放行地表暴露作业)
            if (!duskCriticalHold && !dayFamineHostileHold && bot._mobility && bot._mobility.enclosed) break;   // ★封闭地穴(状态机全知列探测)=夜昼无别,继续作业(用户指点: y<50 代理判断漏掉 y≥50 的崖体隧道/封闭洞)
            if (!duskCriticalHold && !dayFamineHostileHold && canFightNight()) break;     // ★装备齐全(剑+盾+血)→ 不躲,继续干,self_defense 边干边砍怪(对齐 modes)
            if (!proofed) { try { await spawnProof(); } catch (e) {} proofed = true; }   // 先照亮 hold 点 — 无光不刷怪
            if (!logged) { prog('prepNether: ★NIGHT 入夜→优先生存:停止暴露作业,spawn-proof + hole up 到天亮'); logged = true; }
            // ★裸装确定性地堡 (#24 最小版): 干等 modes 来救不够确定 — 自己挖二封一。
            // 徒手挖泥土有掉落,挖出的土正好封顶,零资源自洽(夜税的主根:裸重生地表过夜)。
            // 已有顶盖(coveredAbove)就不重复挖。
            if (!dugIn) {
                try {
                    const alreadyCoveredAbove = () => {
                        for (let dy = 1; dy <= 3; dy++) {
                            const h = bot.blockAt(bot.entity.position.offset(0, dy, 0));
                            if (h && h.boundingBox === 'block') return true;
                        }
                        return false;
                    };
                    if (alreadyCoveredAbove()) {
                        dugIn = true;
                        bot._nightWetBunkerFails = 0;
                        prog(`prepNether: bunker already covered — skip water relocation and hold y=${Math.floor(bot.entity.position.y)}`);
                        await nightBunkerStaticWeapon();
                        await noRegenStaticKit('night-bunker-covered');
                        await skills.wait(bot, 6000);
                        continue;
                    }
                    // ★WATERFRONT VETO (drowned kills x3: #265/#268/#272 — #272 was dragged
                    // off this very dig site by a drowned surfacing 0.8b away at night; the
                    // old check only refused water UNDER our feet, not water BESIDE us,
                    // and a night shoreline is drowned spawning ground). Any surface water
                    // within 8 blocks → walk 12 blocks directly away from it before digging.
                    const standingInFluid = () => {
                        const p = bot.entity.position.floored();
                        for (const dy of [0, 1]) {
                            const b = bot.blockAt(p.offset(0, dy, 0));
                            if (b && /water|lava/.test(b.name || '')) return true;
                        }
                        return false;
                    };
                    const nearestWaterDist = (r = 8) => {
                        try {
                            const wb = world.getNearestBlock(bot, 'water', r);
                            if (!wb || !wb.position) return null;
                            return wb.position.distanceTo(bot.entity.position);
                        } catch (e) { return null; }
                    };
                    try {
                        const wb = world.getNearestBlock(bot, 'water', 8);
                        if (wb) {
                            const me = bot.entity.position;
                            let ax = me.x - wb.position.x, az = me.z - wb.position.z;
                            const L = Math.hypot(ax, az) || 1; ax /= L; az /= L;
                            if (snacklessCritical()) {
                                prog(`prepNether: bunker water veto softened at food=${bot.food} hp=${Math.round(bot.health)} — no night relocation, dig/hold in place`);
                            } else {
                                prog(`prepNether: bunker site too close to water (${Math.round(L)}b) — moving 12b inland before digging`);
                                try { await skills.goToPosition(bot, Math.round(me.x + ax * 12), null, Math.round(me.z + az * 12), 2); } catch (e) {}
                            }
                        }
                    } catch (e) {}
                    const wetDist = nearestWaterDist(4);
                    if (standingInFluid() || wetDist !== null) {
                        const wetFails = bot._nightWetBunkerFails || 0;
                        const injuredHold = bot.health <= 16 && !standingInFluid();
                        const repeatedWetFail = wetFails >= 5 && !standingInFluid();
                        if ((snacklessCritical() && !standingInFluid()) || injuredHold || repeatedWetFail) {
                            bot._nightWetBunkerFails = 0;
                            prog(`prepNether: wet-adjacent bunker accepted (waterDist=${wetDist === null ? 'none' : wetDist.toFixed(1)} hp=${Math.round(bot.health)} fails=${wetFails}) — seal/hold beats night relocation loop`);
                        } else {
                            bot._nightWetBunkerFails = wetFails + 1;
                            prog(`prepNether: bunker veto still wet after relocation (standing=${standingInFluid()} waterDist=${wetDist === null ? 'none' : wetDist.toFixed(1)}) — do not dig; move again/hold`);
                            try { await skills.moveAway(bot, 10); } catch (e) {}
                            try { await skills.wait(bot, 1000); } catch (e) {}
                            continue;
                        }
                    }
                    bot._nightWetBunkerFails = 0;
                    dugIn = true;
                    const coveredAbove = () => {
                        for (let dy = 1; dy <= 3; dy++) {
                            const h = bot.blockAt(bot.entity.position.offset(0, dy, 0));
                            if (h && h.boundingBox === 'block') return true;
                        }
                        return false;
                    };
                    const sealBlock = () => bot.inventory.items().find(i => /^(dirt|grass_block|cobblestone|cobbled_deepslate|granite|diorite|andesite|tuff|gravel|netherrack)$/.test(i.name));
                    const containedMobility = () => {
                        const mobState = (bot._mobility && (bot._mobility.state || '')) || '';
                        return !!(bot._mobility && bot._mobility.enclosed) || /POCKET|ENC|MAROONED|ENTOMBED/.test(mobState);
                    };
                    const sealCurrentRoof = async (why) => {
                        const seal = sealBlock();
                        if (!seal) {
                            const already = coveredAbove();
                            prog(`prepNether: bunker roof seal skipped (${why}) no seal block; covered=${already}`);
                            return already;
                        }
                        const base = bot.entity.position.floored();
                        for (const dy of [2, 3]) {
                            const target = base.offset(0, dy, 0);
                            const before = bot.blockAt(target);
                            if (before && before.boundingBox === 'block') return true;
                            try { await skills.placeBlock(bot, seal.name, target.x, target.y, target.z, 'bottom', true); } catch (e) {
                                prog(`prepNether: bunker roof seal place failed (${why}) ${seal.name}@${target.x},${target.y},${target.z}: ${e.message}`);
                            }
                            const after = bot.blockAt(target);
                            if (after && after.boundingBox === 'block') {
                                prog(`prepNether: bunker roof sealed in place (${why}) ${after.name}@${target.x},${target.y},${target.z}`);
                                return true;
                            }
                        }
                        const finallyCovered = coveredAbove();
                        prog(`prepNether: bunker roof seal exhausted (${why}) block=${seal.name} covered=${finallyCovered}`);
                        return finallyCovered;
                    };
                    // ★C252: naked + no pick → digDown throws on stone → the old code aborted
                    // and LOOPED EXPOSED on the surface all night (user-reported 2026-06-18:
                    // bot idling in the open at hp10/food0, "bunker err stone dig blocked
                    // without held pick" spamming). We can't dig a hole, but we usually carry a
                    // few dirt — box ourselves in instead: place seal blocks at the 4 head-level
                    // sides + the roof. A head ring + roof blocks mob LoS/pathing far better than
                    // standing in the open. Best-effort, errors swallowed; partial walls still help.
                    const surfaceDirtShelter = async () => {
                        const base = bot.entity.position.floored();
                        let placed = 0;
                        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                            const seal = sealBlock();
                            if (!seal) break;
                            const t = base.offset(dx, 1, dz);   // head level
                            const b = bot.blockAt(t);
                            if (b && b.boundingBox === 'block') continue;
                            try { await skills.placeBlock(bot, seal.name, t.x, t.y, t.z, 'bottom', true); placed++; } catch (e) {}
                        }
                        const roofed = await sealCurrentRoof('surface dirt-shelter');
                        prog(`prepNether: ★surface dirt-shelter walls=${placed} roof=${roofed} y=${Math.floor(bot.entity.position.y)} (no-pick, can't dig — box in vs expose)`);
                        return roofed;
                    };
                    const lowResourceNoDigHold = bodyBudgetBunkerHold();
                    if (coveredAbove()) {
                        prog(`prepNether: bunker already covered — hold position y=${Math.floor(bot.entity.position.y)}, no extra digDown`);
                        await nightBunkerStaticWeapon();
                    } else if (lowResourceNoDigHold) {
                        const contained = containedMobility();
                        const seal = sealBlock();
                        const sealedNow = await sealCurrentRoof(`body-budget hold contained=${contained}`);
                        prog(`prepNether: body-budget bunker ${sealedNow ? 'SEALED' : 'held-unsealed'} contained=${contained} seal=${seal ? seal.name : 'none'} y=${Math.floor(bot.entity.position.y)} — no digDown`);
                        await nightBunkerStaticWeapon();
                    } else {
                        // ★C252: catch digDown's no-pick/stone throw HERE (was bubbling to the
                        // outer catch → dugIn=false → re-loop exposed). On dig failure, box in
                        // with dirt on the surface instead of standing in the open.
                        let dugOk = true;
                        try { await skills.digDown(bot, 2); }
                        catch (e) { dugOk = false; prog(`prepNether: digDown blocked (${e.message}) — surface dirt-shelter fallback`); }
                        const seal = sealBlock();
                        if (dugOk && seal) {
                            const top = bot.entity.position.floored().offset(0, 2, 0);
                            try { await skills.placeBlock(bot, seal.name, top.x, top.y, top.z, 'bottom', true); } catch (e) {}
                            // ★C260: digDown assumes the pit's 4 sides are solid ground, but on a
                            // hilltop/slope the hillside drops away and leaves sides OPEN — death 8
                            // (@y85, coveredAbove=1, zombie reached through an open side at 1.2b despite
                            // 340 cobble). Wall any open foot+head-level side so the bunker is truly
                            // enclosed, not just roofed. Same head-ring idea as surfaceDirtShelter.
                            const base2 = bot.entity.position.floored();
                            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                                for (const dy of [0, 1]) {
                                    const s = sealBlock();
                                    if (!s) break;
                                    const t = base2.offset(dx, dy, dz);
                                    const b = bot.blockAt(t);
                                    if (b && b.boundingBox === 'block') continue;
                                    try { await skills.placeBlock(bot, s.name, t.x, t.y, t.z, 'bottom', true); } catch (e) {}
                                }
                            }
                        } else if (!dugOk) {
                            await surfaceDirtShelter();
                        }
                        const sealedNow = coveredAbove();
                        prog(`prepNether: ★dug-in bunker ${sealedNow ? 'SEALED' : 'unsealed(无封顶料,坑里也比地表强)'} y=${Math.floor(bot.entity.position.y)}`);
                        await nightBunkerStaticWeapon();
                    }
                } catch (e) { dugIn = false; prog(`prepNether: bunker err ${e.message}`); }
            }
            await nightBunkerStaticWeapon();
            await noRegenStaticKit('night-bunker');
            await skills.wait(bot, 6000);   // idle so self_preservation can dig in / hold the shelter
        }
        if (cancelRequested()) {
            prog('prepNether: supervisor cancel observed in night gate — returning');
            return false;
        }
        // ★黎明出坑警戒 (224: 夜里刷的苦力怕白天不烧,蹲坑口等开门,hp8出坑2.9格起爆):
        // dawn broke — before resuming work, peek for lingering creepers/mobs within 10;
        // wait them out in the hole (up to 60s, they wander off) instead of walking into one.
        if (!isNightNow() && !bot.interrupt_code) {
            const dawnLingeringHostiles = (r = 10) => {
                const threat = noRegenActionableThreats(r);
                return threat.actionable;
            };
            // ★C261: CAP the cumulative dawn-exit hold. The inner loop waits 60s, but the caller
            // re-enters it every cycle, so a zombie sitting in shade that never burns off froze the
            // bot for 6 MIN (confirmed STALL @5,69,8, hp20/food20, "dawn-exit hold 1 mob, waiting
            // them out" re-logged every 60s). After ~72s total, stop cowering and proceed — let
            // self_defense fight the lingering mob while work resumes. Freezing the whole run is far
            // worse than trading hits with one zombie at full hp.
            if (dawnLingeringHostiles(10) === 0) {
                bot._dawnHoldSince = 0;
            } else if (bot._dawnHoldSince && Date.now() - bot._dawnHoldSince > 72000) {
                prog(`prepNether: dawn-exit hold timed out (>72s, lingering=${dawnLingeringHostiles(10)}) — proceed, let self_defense fight; no perpetual cower`);
                bot._dawnHoldSince = 0;
            } else {
                if (!bot._dawnHoldSince) bot._dawnHoldSince = Date.now();
                for (let w = 0; w < 10; w++) {
                    const lingering = dawnLingeringHostiles(10);
                    if (lingering === 0) { bot._dawnHoldSince = 0; break; }
                    if (w === 0) {
                        const threat10 = noRegenActionableThreats(10);
                        prog(`prepNether: ★dawn-exit hold — ${lingering} actionable mob(s) at the door (raw=${threat10.raw} layered=${threat10.layered}), waiting them out`);
                    }
                    if (w === 0) await nightBunkerStaticWeapon({ allowDaySingleSpider: true, reason: 'DAWN lingering-mob' });
                    await skills.wait(bot, 6000);
                }
            }
        }
    };

    // Order matters: a weapon + FULL body armour first (survival), then the rest of the
    // kit, then portal materials. obsidian last (it's the risky/uncertain one).
    // ★C262 (统一 1+2+3, 2026-06-19): the old goals jumped shield→iron_pickaxe→DIAMOND gear with
    // NO iron armor and NO iron weapon. To get diamond armor the bot had to mine diamonds at y<16
    // (the deadliest depth) while UNARMORED, and died there 20+ times before ever consolidating
    // (deaths 19/20 carried raw_iron 15/31 — full armor's worth — and died before crafting it;
    // death 21 had armorCount=1 but sword:null = no weapon). Insert the IRON tier (sword + full
    // armor) BEFORE the diamond tier so the bot completes a survivable kit from the iron it can mine
    // at moderate depth, THEN descends for diamonds already armored. 3-in-1: (1) full armor set,
    // (2) always a real sword (no weapon gap), (3) armor+weapon complete before the deep diamond dive.
    const goals = [
        { item: 'shield', count: 1 },          // shield blocks skeleton arrows + melee (shieldFight)
        { item: 'iron_pickaxe', count: 1 },    // needed to mine the rest (and diamonds)
        { item: 'iron_sword', count: 1 },      // ★2: a real weapon — death 21 was sword:null, couldn't fight back
        { item: 'iron_chestplate', count: 1 }, // ★1: iron armor (chest=most protection) BEFORE the deep diamond dive
        { item: 'iron_leggings', count: 1 },
        { item: 'iron_helmet', count: 1 },
        { item: 'iron_boots', count: 1 },
        { item: 'diamond_sword', count: 1 },   // ★3: diamonds only after the iron survival kit is done
        { item: 'diamond_chestplate', count: 1 },
        { item: 'diamond_leggings', count: 1 },
        { item: 'diamond_helmet', count: 1 },
        { item: 'diamond_boots', count: 1 },
        { item: 'flint_and_steel', count: 1 },
        { item: 'obsidian', count: 10 }, // 10 = minimal nether portal frame
    ];

    prog(`==== prepNether START | inv diamonds=${has('diamond')} ====`);
    const stationaryKitOnly = () => Number(bot._prepStationaryKitOnlyUntil || 0) > Date.now();
    const stationaryKitOpportunity = () => {
        try {
            const c = world.getInventoryCounts(bot);
            const fuel = (c.coal || 0) + (c.charcoal || 0) + planksEqHeld();
            const furnaceReady = (c.furnace || 0) > 0 || !!world.getNearestBlock(bot, 'furnace', 4) || (c.cobblestone || 0) >= 8;
            const tableReady = (c.crafting_table || 0) > 0 || !!world.getNearestBlock(bot, 'crafting_table', 4) || maxHeldPlankStack() >= 4;
            if ((c.iron_pickaxe || 0) < 1 && (c.raw_iron || 0) > 0 && fuel > 0 && furnaceReady) return 'raw-iron-local-smelt';
            if ((c.iron_pickaxe || 0) < 1 && (c.iron_ingot || 0) >= 3 && (c.stick || 0) >= 2 && tableReady) return 'iron-pickaxe-local-craft';
            if ((c.shield || 0) < 1 && (c.iron_ingot || 0) >= 1 && planksEqHeld() >= 6 && tableReady) return 'shield-local-craft';
        } catch (e) {}
        return null;
    };

    // ---- KILL-BOX EXPULSION (mirror of missionNether's — here because prepNether is
    // hot-reloaded every ~3s call, so this fires immediately without waiting for the
    // sticky missionNether to re-arm with new code). Deaths #259/261/263/266 all fell
    // into one cave-riddled ~30b death cluster; overseer writes its center to
    // advisory.json dzone. Inside it and not in melee → walk straight out first.
    try {
        const a = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'advisory.json'), 'utf8'));
        if (a && a.dzone && Date.now() - a.ts < 45000) {
            const z = a.dzone, p0 = bot.entity.position;
            const d0 = Math.hypot(p0.x - z.cx, p0.z - z.cz);
            const HOSZ = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
            const inMelee = Object.values(bot.entities).some(e =>
                e && e.position && e.name && HOSZ.test(e.name) && e.position.distanceTo(p0) < 6);
            const suppressed = bot._killBoxSuppressUntil && Date.now() < bot._killBoxSuppressUntil;
            if (d0 < z.r && !inMelee && !suppressed) {
                const staticOnly = stationaryKitOnly();
                const staticKit = staticOnly && !hasEdible() && bot.food <= 6 && (coveredAboveNow() || containedMobilityNow()) && stationaryKitOpportunity();
                if (staticKit) {
                    prog(`★KILL-BOX(prep): stationary kit override ${staticKit} food=${bot.food} hp=${Math.round(bot.health)} y=${Math.round(p0.y)} — no surfaceUp/expel`);
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                } else if (p0.y < 55) {
                    // underground in the honeycomb core — vertical first (see missionNether)
                    prog(`★KILL-BOX(prep): underground in cluster (y=${Math.round(p0.y)}) → surfaceUp first`);
                    try { await skills.customSkill(bot, 'surfaceUp'); } catch (e) {}
                } else {
                    const ux = d0 > 0.5 ? (p0.x - z.cx) / d0 : 1, uz = d0 > 0.5 ? (p0.z - z.cz) / d0 : 0;
                    const tx = Math.round(z.cx + ux * (z.r + 16)), tz = Math.round(z.cz + uz * (z.r + 16));
                    prog(`★KILL-BOX(prep): ${Math.round(d0)}b inside death cluster @${z.cx},${z.cz}(${z.n}) → expelling to ${tx},${tz}`);
                    try { await skills.goToPosition(bot, tx, Math.round(p0.y), tz, 3); } catch (e) {}
                }
            }
        }
    } catch (e) {}

    // ---- DEATH RECOVERY (corpse run) ------------------------------------------------
    // On a (re)start triggered by death, rush back to where we died and reclaim the gear
    // we dropped before it despawns (~5 min). Without this, every death resets the grind
    // to naked (the Sisyphus loop in this hostile world). STRICTLY BOUNDED + INTERRUPTIBLE
    // by design: at most a few legs and a hard time cap; the death spot is consumed (file
    // deleted) on the FIRST attempt so a stale corpse is never retried; and it ABORTS the
    // instant a survival mode interrupts us (drowning / flee / new death) — so the recovery
    // can never become its own loop or death-trap.
    const DPOS = path.resolve(process.cwd(), 'bots', '_supervisor', 'death_pos.json');
    // Dropped-item detection. ONLY use e.name === 'item' — accessing the legacy
    // prismarine-entity getters e.objectType / e.entityType / e.displayName triggers a
    // deprecation path (printObjectTypeWarning) that THROWS and crashes the whole agent
    // subprocess (exit 1) → agent_process.js restarts it → ~15s offline → the bot dies in
    // the gap if night/mobs. That spurious-restart churn was the real "death cascade".
    const isItem = (e) => e && e.position && e.name === 'item';
    const isNight = () => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } };
    const HOSTILE = /zombie|skeleton|creeper|spider|witch|enderman|drowned|husk|stray|phantom|slime|piglin|hoglin|silverfish|cave_spider|pillager|vindicator/i;
    const hostilesNear = (r = 12) => Object.values(bot.entities).filter(e => e && e.position && e.name && HOSTILE.test(e.name) && e.position.distanceTo(bot.entity.position) < r).length;
    const noRegenActionableThreats = (r = 8) => {
        const secured = bodyBudgetBunkerHold() && (coveredAboveNow() || containedMobilityNow());
        const me = bot.entity.position;
        let raw = 0, actionable = 0, layered = 0;
        let nearest = null;
        for (const e of Object.values(bot.entities || {})) {
            if (!e || !e.position || !e.name || !HOSTILE.test(e.name)) continue;
            const d = e.position.distanceTo(me);
            if (d >= r) continue;
            raw++;
            const dy = e.position.y - me.y;
            const absDy = Math.abs(dy);
            if (!nearest || d < nearest.d) nearest = { name: e.name, d, dy };
            const nearMelee = d < 4.25;
            const nearCreeper = /creeper/i.test(e.name) && d < 5.5;
            const separatedByLayer = secured && absDy >= 4.5 && d >= 5.5 && !/creeper|skeleton|stray|witch|drowned|pillager|vindicator/i.test(e.name);
            if (separatedByLayer && !nearMelee && !nearCreeper) layered++;
            else actionable++;
        }
        return { raw, actionable, layered, nearest, secured };
    };
    const freshAdvisoryThreat = () => {
        try {
            const a = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'advisory.json'), 'utf8'));
            const ts = Number(a.ts || 0);
            if (!ts || Date.now() - ts > 45000) return null;
            const actionable = Number(a.actionableHostiles);
            if (!Number.isFinite(actionable)) return null;
            return {
                raw: Number(a.hostiles || 0),
                actionable,
                layered: Number(a.layeredHostiles || 0),
                nearest: Number(a.nearest || Infinity),
                secured: true,
                source: 'advisory',
            };
        } catch (e) {
            return null;
        }
    };
    const tableRecoveryThreat = (r = 12) => {
        const local = noRegenActionableThreats(r);
        const adv = freshAdvisoryThreat();
        if (adv) return { ...local, ...adv, localActionable: local.actionable, localRaw: local.raw };
        return { ...local, source: 'local' };
    };
    const tableRecoveryUndergroundWorksite = () => {
        try {
            const p = bot.entity.position.floored();
            let openSurface = Math.floor(bot.entity.position.y) >= 55;
            if (openSurface) {
                for (let dy = 1; dy <= 8; dy++) {
                    const b = bot.blockAt(p.offset(0, dy, 0));
                    if (b && /water|lava/.test(b.name || '')) { openSurface = false; break; }
                    if (b && b.boundingBox === 'block') { openSurface = false; break; }
                }
            }
            return !openSurface && (bot.entity.position.y < 62 || (bot._mobility && (bot._mobility.enclosed || bot._mobility.state === 'POCKET')));
        } catch (e) {
            return bot.entity.position.y < 62;
        }
    };
    const tableRecoveryVerticalPocket = () => {
        try {
            const p = bot.entity.position;
            const foot = bot.blockAt(p);
            const head = bot.blockAt(p.offset(0, 1, 0));
            const above = bot.blockAt(p.offset(0, 2, 0));
            const below = bot.blockAt(p.offset(0, -1, 0));
            const openBody = (!foot || foot.boundingBox !== 'block') && (!head || head.boundingBox !== 'block');
            const stable = !!(below && below.boundingBox === 'block' && !/water|lava|fire|magma|cactus/.test(below.name || ''));
            const stonyCap = !!(above && above.boundingBox === 'block' && /stone|cobblestone|andesite|diorite|granite|tuff|deepslate/.test(above.name || ''));
            return openBody && stable && stonyCap && (coveredAboveNow() || containedMobilityNow());
        } catch (e) {
            return false;
        }
    };
    const maxHeldPlankStack = () => {
        const c = world.getInventoryCounts(bot);
        return Math.max(0, ...Object.keys(c).filter(k => k.endsWith('_planks')).map(k => c[k] || 0));
    };
    const heldLogs = () => {
        const c = world.getInventoryCounts(bot);
        return Object.keys(c).filter(k => k.endsWith('_log')).reduce((s, k) => s + (c[k] || 0), 0);
    };
    const hasAnyHeldPick = () => {
        try {
            return bot.inventory.items().some(i => i && /_pickaxe$/.test(i.name || ''));
        } catch (e) {
            return false;
        }
    };
    const needsCraftingTable = (name) => {
        return /^(wooden|stone|iron|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe)$/.test(name)
            || /^(wooden|stone|iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/.test(name)
            || /^(shield|bucket|crafting_table)$/.test(name);
    };
    const tableRecoveryBlocked = (goalName) => {
        if (!needsCraftingTable(goalName)) return null;
        const tableNear = world.getNearestBlock(bot, 'crafting_table', 4);
        if (has('crafting_table') > 0 || tableNear || maxHeldPlankStack() >= 4 || heldLogs() > 0) return null;
        const undergroundWorksite = tableRecoveryUndergroundWorksite();
        const verticalPocket = tableRecoveryVerticalPocket();
        if (!undergroundWorksite && !verticalPocket) return null;
        const threat = tableRecoveryThreat(12);
        const threatNearest = typeof threat.nearest === 'number'
            ? threat.nearest
            : (threat.nearest && typeof threat.nearest.d === 'number' ? threat.nearest.d : Infinity);
        const daytime = !isNightNow() && !isDuskNow();
        // C219: food 门槛 14→(8 || hasEdible)。一个健康(hp≥14)、白天、无威胁的 bot 上地表砍几下木
        // 救活当前 craft(iron_pickaxe 等)是轻量就近收益,不该用"开苦工"的 food≥14 余量卡死。food
        // 落在 >2 && <14 死区时(normalSafeDay 卡 food≥14、famineVerticalEmergency 卡 food≤2),有铁无木
        // 无台的健康 bot 会在 TABLE gate 空转 3min+(live 实测 food13)。保留 hp≥14(地表战斗安全)/白天/
        // threat=0;手里有吃的就放行(keepFed 同轮先吃,food 会回升),没吃的也要 food≥8 才上,避免饿着爬。
        const normalSafeDay = undergroundWorksite && daytime && threat.actionable === 0 && bot.health >= 14 && (bot.food >= 8 || hasEdible());
        const famineVerticalEmergency = daytime
            && !hasEdible()
            && bot.food <= 2
            && bot.health >= 8
            && verticalPocket
            && (threat.actionable === 0 || (threat.actionable <= 1 && threatNearest > 5.5));
        // ★C224: no-regen DEADLOCK breaker (hp 8-13 dead-zone, between C217's hp<8 last-resort and
        // normalSafeDay's hp≥14). When hurt AND unable to regen (food<18 + no edible in inv), the bot
        // is in an ABSORBING underground deadlock: hp won't rise without regen, regen won't start
        // without food≥18, food can't be gained without surfacing to hunt — but normalSafeDay's hp≥14
        // gate blocks that surface. Sitting tight = frozen forever (live 05:37: hp9 food17 spun the
        // TABLE gate indefinitely past dawn). At a daytime surface with NO actionable threat (forest
        // home, mobs burn by day, shield in kit), going up to hunt+chop is the ONLY escape and a
        // calculated risk worth taking — same "find beats frozen" logic as C217.
        const noRegenDeadlock = daytime
            && !hasEdible()
            && bot.food < 18
            && bot.health >= 8 && bot.health < 14
            && verticalPocket
            && threat.actionable === 0;
        const staleReason = Date.now() < (bot._prepTableRecoveryBlockedUntil || 0)
            ? (bot._prepTableRecoveryBlockedReason || 'achieve table gate')
            : 'no local wood/table/logs';
        return {
            goal: goalName,
            reason: staleReason,
            night: isNightNow() || isDuskNow(),
            safeDay: normalSafeDay || famineVerticalEmergency || noRegenDeadlock,
            famineVerticalEmergency: famineVerticalEmergency || noRegenDeadlock,
            noRegenDeadlock,
            threat,
        };
    };
    const handleTableRecoveryBlocked = async (goalName) => {
        const block = tableRecoveryBlocked(goalName);
        if (!block) return false;
        const now = Date.now();
        const noPick = !hasAnyHeldPick();
        const verticalRecoveryPocket = () => {
            try {
                if (!noPick || !block.safeDay) return false;
                return tableRecoveryVerticalPocket();
            } catch (e) {
                return false;
            }
        };
        if (block.safeDay && noPick && now <= (bot._prepTableRecoverySurfaceTryUntil || 0) && verticalRecoveryPocket()
            && now > (bot._prepTableRecoveryVerticalContinueUntil || 0)) {
            bot._prepTableRecoverySurfaceTryUntil = 0;
            bot._prepTableRecoveryVerticalContinueUntil = now + 12000;
            prog(`prepNether: TABLE recovery overrides no-pick surface cooldown — still in vertical stone pocket at y=${bot.entity.position.y.toFixed(1)}, continue bounded surfaceUp`);
        }
        if (block.safeDay && now > (bot._prepTableRecoverySurfaceTryUntil || 0)) {
            const beforeY = bot.entity && bot.entity.position ? bot.entity.position.y : null;
            const noPickCooldown = block.famineVerticalEmergency ? 30000 : 600000;
            bot._prepTableRecoverySurfaceTryUntil = now + (noPick ? noPickCooldown : 120000);
            prog(`prepNether: TABLE recovery for ${goalName} — ${block.reason}; ${block.famineVerticalEmergency ? 'famine vertical emergency' : 'daylight safe window'}, bounded surfaceUp for wood/table recovery${noPick ? (block.famineVerticalEmergency ? ' (no pick: short famine cooldown after probe)' : ' (no pick: long cooldown after probe)') : ''}`);
            try {
                await Promise.race([
                    skills.customSkill(bot, 'surfaceUp', 63),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('table-recovery-surfaceUp-timeout')), 60000)),
                ]);
            } catch (e) {
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                prog(`prepNether: TABLE recovery surfaceUp incomplete: ${e.message}`);
            }
            const afterY = bot.entity && bot.entity.position ? bot.entity.position.y : null;
            const gainedY = (typeof beforeY === 'number' && typeof afterY === 'number') ? (afterY - beforeY) : 0;
            if (noPick && gainedY >= 0.75 && tableRecoveryBlocked(goalName)) {
                bot._prepTableRecoverySurfaceTryUntil = Date.now() + 12000;
                prog(`prepNether: TABLE recovery surfaceUp gained ${gainedY.toFixed(1)}y without pick — short cooldown, continue vertical wood/table recovery`);
            } else if (noPick && block.famineVerticalEmergency && tableRecoveryBlocked(goalName)) {
                bot._prepTableRecoverySurfaceTryUntil = Date.now() + 12000;
                prog(`prepNether: TABLE recovery famine surfaceUp gained ${gainedY.toFixed(1)}y — short cooldown, continue emergency vertical recovery`);
            }
            // ★C229 兜底: surfaceUp above only CLIMBS — it never actually CHOPS. The softlock was
            // exactly this: bot surfaces but stays wood-blocked (no wood → no plank → no stick →
            // can't recraft pick/table → TABLE gate forever). This is the FORWARD half of the
            // reverse wood path (achieve.js C229 gate refuses to deep-mine the last pick; this
            // restocks wood once surfaced). Gated by optionalWoodSafe (surface+day+no hostile+
            // hp>14+food ok+reachable tree) — at low hp / night / hostiles it skips silently and
            // yields to survival (never the dangerous-surface-expedition the risk note warns of).
            try {
                if (heldLogs() < 2 && maxHeldPlankStack() < 8) {
                    const woodGate = optionalWoodSafe();
                    if (woodGate.ok) {
                        prog(`prepNether: ★C229 TABLE recovery — surfaced, still wood-blocked (logs=${heldLogs()} planksMax=${maxHeldPlankStack()}); chopWood ${woodGate.target}`);
                        try {
                            await Promise.race([
                                skills.customSkill(bot, 'chopWood', 4),
                                new Promise((_, rej) => setTimeout(() => rej(new Error('table-recovery-chop-timeout')), 90000)),
                            ]);
                        } catch (e) { try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} prog(`prepNether: TABLE recovery chopWood incomplete: ${e.message}`); }
                    }
                }
            } catch (e) {}
            return true;
        }
        if (!bot._lastPrepTableGateLogAt || now - bot._lastPrepTableGateLogAt > 30000) {
            bot._lastPrepTableGateLogAt = now;
            prog(`prepNether: TABLE gate for ${goalName} — ${block.reason}; tableInv=${has('crafting_table')} tableNear=no planksMax=${maxHeldPlankStack()} logs=${heldLogs()} night=${block.night} actionable12=${block.threat.actionable} threatSrc=${block.threat.source}; no repeat 3x3 craft loop`);
        }
        try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}
        try { await skills.wait(bot, 6000); } catch (e) {}
        return true;
    };
    const latestDeathNear = (d) => {
        try {
            const lines = fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'death_log.jsonl'), 'utf8').trim().split('\n').slice(-12).reverse();
            for (const line of lines) {
                const rec = JSON.parse(line);
                if (!rec || typeof rec.x !== 'number' || typeof rec.z !== 'number') continue;
                if (Math.hypot((rec.x || 0) - d.x, (rec.y || 0) - d.y, (rec.z || 0) - d.z) <= 8) return rec;
            }
        } catch (e) {}
        return null;
    };
    const recoveryCombatKit = () => {
        const c = world.getInventoryCounts(bot);
        const sword = Object.keys(c).some(n => /_sword$/.test(n) && c[n] > 0);
        const shield = (c.shield || 0) > 0;
        const armor = Object.keys(c).filter(n => /_(helmet|chestplate|leggings|boots)$/.test(n) && c[n] > 0).length;
        return sword && (shield || armor >= 2) && bot.health >= 16;
    };
    const daylightFamineForageWindow = () => {
        try {
            const securedLowResourceHold = bodyBudgetBunkerHold() && (coveredAboveNow() || containedMobilityNow());
            const threatRadius = securedLowResourceHold ? 10 : 16;
            const threat = noRegenActionableThreats(threatRadius);
            return famineBudget()
                && !isNight()
                && bot.entity.position.y >= 55
                && threat.actionable === 0
                && (!bot.game || !bot.game.dimension || /overworld/.test(bot.game.dimension));
        } catch (e) { return false; }
    };
    const corpseRun = async () => {
        let d; try { d = JSON.parse(fs.readFileSync(DPOS, 'utf8')); } catch (e) { return; }
        if (!d || typeof d.x !== 'number') { try { fs.unlinkSync(DPOS); } catch (e) {} return; }
        const ageS = Math.round((Date.now() - (d.t || 0)) / 1000);
        if (ageS > 270) { try { fs.unlinkSync(DPOS); } catch (e) {} prog(`corpseRun: death ${ageS}s old — gear despawned, skip`); return; }
        if (bot.game && bot.game.dimension && !/overworld/.test(bot.game.dimension)) { try { fs.unlinkSync(DPOS); } catch (e) {} prog('corpseRun: not overworld, skip'); return; }
        // SAFETY GATE — do NOT walk a freshly-respawned (usually naked, no-armor, low-hp)
        // bot back toward its death spot through a night-time mob swarm: that just feeds
        // the death loop (the exact suicide-walk the supervised lock exists to stop). KEEP
        // the death file (don't consume) so a LATER prepNether re-arm can recover once it's
        // safe — daytime, no nearby hostiles, and not critically hurt. The age check above
        // retires the file naturally once the gear would have despawned anyway.
        // Walk back toward the death spot ONLY when it's clearly safe. A freshly-respawned
        // bot is usually naked/low-armor; sending it toward where mobs just killed it —
        // through ANY nearby swarm, day or night — just re-feeds the death cascade (it
        // killed us again at hp1 in daylight). So defer (keep the death file, retry later)
        // unless there are NO hostiles near us right now AND we're not hurt. The age check
        // retires the file once the gear would have despawned anyway.
        if (hostilesNear(16) > 0 || bot.health < 14) {
            prog(`corpseRun: UNSAFE (mobs=${hostilesNear(16)} hp=${Math.round(bot.health)} night=${isNight()}) — defer recovery, establish first`);
            return;
        }
        // 夜不捞尸 (the design note said "daytime only" but the code never gated it —
        // saw a night run toward a skeleton cave for a corpse holding 19 tuff): keep the
        // file, retry at dawn; the 270s age check writes off what expires. Life > loot.
        if (isNight()) {
            prog('corpseRun: night — defer to dawn (life > loot)');
            return;
        }
        // 垃圾尸体不出门 (one day, three junk runs: whole daytime rebuild windows spent
        // hiking for tuff, and the trip itself killed us twice). agent.js marks v=true
        // only for iron+ gear / diamonds / ingot stash; old files without v run as before.
        if (d.v === false) {
            try { fs.unlinkSync(DPOS); } catch (e) {}
            prog('corpseRun: JUNK corpse (no iron+/diamond gear) — skip the trip, re-gather locally');
            return;
        }
        // ★水葬不捞 (202→203 螺旋: 水中死→裸重生跳水捞装备→自己淹死→新水葬,90s一轮):
        // a corpse in/under water is a siren — the dive costs more than the gear. The
        // death record may carry inWater; otherwise probe the (loaded) death cell. Skip
        // AND consume so the siren never re-fires.
        let waterGrave = d.inWater === true;
        if (!waterGrave && Vec3) {
            try {
                const db = bot.blockAt(new Vec3(d.x, d.y, d.z));
                const db1 = bot.blockAt(new Vec3(d.x, d.y + 1, d.z));
                waterGrave = !!((db && /water/.test(db.name || '')) || (db1 && /water/.test(db1.name || '')));
            } catch (e) {}
        }
        if (waterGrave) {
            try { fs.unlinkSync(DPOS); } catch (e) {}
            prog('corpseRun: WATER GRAVE — skip the dive (不为装备淹死自己), gear written off');
            return;
        }
        const drec = latestDeathNear(d);
        const combatCause = drec && /creeper|zombie|skeleton|drowned|spider|witch|husk|stray|slime|pillager|vindicator/i.test(drec.cause || '');
        if (ageS < 180 && combatCause && (drec.underground || (drec.hostileCount || 0) > 0) && (!recoveryCombatKit() || hostilesNear(24) > 0)) {
            prog(`corpseRun: COMBAT DEATH HOT (${drec.cause} age=${ageS}s underground=${!!drec.underground} mobs=${drec.hostileCount || 0}) — defer until armed/clear`);
            return;
        }
        try { fs.unlinkSync(DPOS); } catch (e) {}              // committing — consume so we never retry a stale corpse
        prog(`corpseRun: -> death @ ${d.x.toFixed(0)},${d.y.toFixed(0)},${d.z.toFixed(0)} age=${ageS}s`);
        const start = Date.now();
        const MAX_LEGS = 5, MAX_MS = 90000;
        const distToDeath = () => Math.hypot(bot.entity.position.x - d.x, bot.entity.position.y - d.y, bot.entity.position.z - d.z);
        for (let leg = 0; leg < MAX_LEGS && (Date.now() - start) < MAX_MS; leg++) {
            if (bot.interrupt_code) { prog('corpseRun: survival mode interrupted — abort'); break; }
            // 途中入夜即弃 (211: 白天出发差140tick入夜,半路天黑涉水被僵尸逮住 — 入口夜门
            // 拦不住旅途夜变): the entry gate checks dawn, the TRIP must too. Life > loot.
            if (isNight()) { prog('corpseRun: night fell MID-TRIP — abandon recovery (life > loot)'); break; }
            try { await skills.goToPosition(bot, d.x, d.y, d.z, 1); } catch (e) { prog(`corpseRun: goto err ${e.message}`); }
            if (bot.interrupt_code) { prog('corpseRun: interrupted after goto — abort'); break; }
            const items = Object.values(bot.entities).filter(e => isItem(e) && e.position.distanceTo(bot.entity.position) < 30);
            if (items.length) {
                // Walk over each dropped stack (mineflayer auto-collects on contact).
                for (const it of items.slice(0, 16)) {
                    if (bot.interrupt_code) break;
                    if ((Date.now() - start) >= MAX_MS) break;
                    try { await skills.goToPosition(bot, it.position.x, it.position.y, it.position.z, 0); } catch (e) {}
                    await skills.wait(bot, 250);
                }
                continue; // re-scan for any stragglers next leg
            }
            // No items in range. Distinguish "arrived, truly nothing here" from "couldn't
            // get there yet" (goto threw / was nudged by a mode) — only the former is done.
            const dist = distToDeath();
            if (dist <= 6) { prog(`corpseRun: arrived (dist=${dist.toFixed(1)}), no items — done`); break; }
            prog(`corpseRun: not arrived (dist=${dist.toFixed(0)}), retry leg ${leg + 1}`);
        }
        try { await equipArmor(); } catch (e) {}
        prog(`corpseRun: done | iron_pick=${has('iron_pickaxe')} sword=${has('diamond_sword') || has('iron_sword') || has('stone_sword')} shield=${has('shield')}`);
    };
    try { await corpseRun(); } catch (e) { prog(`corpseRun threw: ${e.message}`); }

    // ---- DEATH RECOVERY (bank withdraw) --------------------------------------------
    // Breaks the "die → respawn NAKED → die again" spiral when the corpse run fails (the
    // 5-min despawn usually beats us back). On a naked respawn we land at the world spawn
    // point (no bed in this no-sheep jungle), which is exactly where bankGear anchored the
    // bank chest. So: find the bank, withdraw a weapon + tools + armor + food, re-arm. This
    // is the symmetric WITHDRAW to bankGear's deposit. Fully guarded — any failure is logged
    // and swallowed so prepNether's normal grind continues.
    const BANKF = path.resolve(process.cwd(), 'bots', '_supervisor', 'bank.json');
    const BEDF_R = path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json');  // local: BEDF (below) is in TDZ here
    const SPAWNF_R = path.resolve(process.cwd(), 'bots', '_supervisor', 'spawn_pos.json');
    const validSpawn = (sp) => sp && typeof sp.x === 'number' && typeof sp.z === 'number' && !(sp.x === 0 && sp.z === 0);
    const haveSword = () => { const c = world.getInventoryCounts(bot); return Object.keys(c).some(n => /_sword$/.test(n) && c[n] > 0); };
    const haveAnyArmor = () => { const c = world.getInventoryCounts(bot); return Object.keys(c).some(n => /_(helmet|chestplate|leggings|boots)$/.test(n) && c[n] > 0); };
    const bankRecover = async () => {
        // 1) Locate the bank: bank.json → bed.json → world spawn. None → nothing to recover from.
        let bank = null, src = null;
        try { const b = JSON.parse(fs.readFileSync(BANKF, 'utf8')); if (typeof b.x === 'number') { bank = b; src = 'bank'; } } catch (e) {}
        if (!bank) { try { const b = JSON.parse(fs.readFileSync(BEDF_R, 'utf8')); if (typeof b.x === 'number') { bank = b; src = 'bed'; } } catch (e) {} }
        // spawn_pos.json = actual recorded respawn coord (agent.js). bot.spawnPoint is the
        // (0,0) sentinel on this LAN server, so prefer the measured respawn. No (0,0) filter.
        if (!bank) { try { const s = JSON.parse(fs.readFileSync(SPAWNF_R, 'utf8')); if (typeof s.x === 'number') { bank = { x: s.x, y: s.y, z: s.z }; src = 'respawn'; } } catch (e) {} }
        if (!bank && validSpawn(bot.spawnPoint)) { bank = { x: bot.spawnPoint.x, y: bot.spawnPoint.y, z: bot.spawnPoint.z }; src = 'spawn'; }
        // DIAGNOSTIC: log spawnPoint so progress.txt reveals if it's real or the (0,0) sentinel.
        try { const sp = bot.spawnPoint; prog(`bankRecover: bot.spawnPoint=${sp ? `${sp.x},${sp.y},${sp.z}` : 'null'} bankSrc=${src || 'none'}`); } catch (e) {}
        if (!bank) { prog('bankRecover: no bank/bed/spawn location — skip'); return; }
        // GHOST-BANK GUARD: a recorded bank coord can outlive the chest (never built /
        // blown up / built elsewhere). Death #267 aftermath: naked bot walked 40 blocks
        // of night to (96,64,-34), found NO chest, walked back — pure exposure for zero
        // loot, and it would repeat the trip EVERY respawn. After a "no chest" strike,
        // skip this bank location for an hour (file-persisted; hot-reload safe).
        const GHOSTF = path.resolve(process.cwd(), 'bots', '_supervisor', 'bank_ghost.json');
        try {
            const g = JSON.parse(fs.readFileSync(GHOSTF, 'utf8'));
            if (g && g.x === Math.round(bank.x) && g.z === Math.round(bank.z) && Date.now() - g.t < 3600000) {
                prog('bankRecover: bank marked ghost (no chest there recently) — skip the trip');
                return;
            }
        } catch (e) {}
        // 2) Only bother if we're under-armed (naked respawn). Kitted + safe → skip the detour.
        if (haveSword() && haveAnyArmor() && bot.health >= 14) { prog('bankRecover: already armed (sword+armor, hp ok) — skip'); return; }
        const tableHold = tableRecoveryBlocked('bucket') || tableRecoveryBlocked('crafting_table');
        if (tableHold && containedMobilityNow()) {
            if (!bot._lastBankTableRecoveryGateAt || Date.now() - bot._lastBankTableRecoveryGateAt > 30000) {
                bot._lastBankTableRecoveryGateAt = Date.now();
                prog(`bankRecover: table recovery hold in ${bot._mobility && bot._mobility.state || 'ENC'} — skip bank path; tableInv=${has('crafting_table')} planksMax=${maxHeldPlankStack()} logs=${heldLogs()} actionable12=${tableHold.threat ? tableHold.threat.actionable : 'n/a'}`);
            }
            return;
        }
        // No-regen cave budget: bankRecover runs before keepFed(), so without this guard it can
        // steal the body for a long/destructive cave path and only later discover that hunger
        // logic would have held in place. With low HP, no normal food, and no regen, recovery
        // trips are allowed only when the bank is already right beside us.
        if (!hasEdible() && bot.health < 14 && bot.food < 18) {
            const me = bot.entity.position;
            const bankDist = Math.hypot(me.x - bank.x, me.y - bank.y, me.z - bank.z);
            if (bankDist > 4.5) {
                prog(`bankRecover: no-regen trip gate — hp=${Math.round(bot.health)} food=${bot.food} no normal food bankDist=${Math.round(bankDist)}; keepFed/hold before bank path`);
                return;
            }
        }
        if (famineBudget()) {
            const me = bot.entity.position;
            const bankDist = Math.hypot(me.x - bank.x, me.y - bank.y, me.z - bank.z);
            if (hostilesNear(16) > 0 || bankDist > 8) {
                prog(`bankRecover: FAMINE danger gate — hp=${Math.round(bot.health)} food=${bot.food} hostiles16=${hostilesNear(16)} bankDist=${Math.round(bankDist)}; shelter/food before bank trip`);
                return;
            }
        }
        prog(`bankRecover: under-armed (sword=${haveSword()} armor=${haveAnyArmor()} hp=${Math.round(bot.health)}) — withdraw from bank(${src}) @ ${bank.x.toFixed(0)},${bank.y.toFixed(0)},${bank.z.toFixed(0)}`);
        // 3) Walk to the bank.
        try { await skills.goToPosition(bot, bank.x, bank.y, bank.z, 2); } catch (e) { prog(`bankRecover: goto err ${e.message}`); }
        if (bot.interrupt_code) { prog('bankRecover: interrupted en route — abort'); return; }
        // 4) Find the chest and open it.
        let chest = null;
        try { chest = bot.findBlock({ matching: b => b && b.name && b.name.includes('chest'), maxDistance: 6 }); } catch (e) {}
        if (!chest) { try { chest = bot.findBlock({ matching: b => b && b.name && b.name.includes('chest'), maxDistance: 12 }); } catch (e) {} }
        if (!chest) {
            prog('bankRecover: no chest within 12 of bank — marking ghost (skip for 1h)');
            try { fs.writeFileSync(GHOSTF, JSON.stringify({ x: Math.round(bank.x), z: Math.round(bank.z), t: Date.now() })); } catch (e) {}
            return;
        }
        let container = null;
        try { container = await bot.openContainer(chest); } catch (e) { prog(`bankRecover: open err ${e.message}`); return; }
        // 5) Withdraw: best of each gear class + some food. Symmetric to bankGear's deposit().
        const WANT = [
            { re: /_sword$/, n: 1, label: 'sword' },
            { re: /_pickaxe$/, n: 1, label: 'pickaxe' },
            { re: /^shield$/, n: 1, label: 'shield' },
            { re: /_helmet$/, n: 1, label: 'helmet' },
            { re: /_chestplate$/, n: 1, label: 'chestplate' },
            { re: /_leggings$/, n: 1, label: 'leggings' },
            { re: /_boots$/, n: 1, label: 'boots' },
            { re: /^(cooked_beef|cooked_porkchop|cooked_chicken|cooked_mutton|bread|cooked_cod|cooked_salmon|apple)$/, n: 8, label: 'food' },
            // ★环2: also pull MATERIALS so a low-tier respawn can immediately re-craft tools
            // (far better than naked 0-inventory). achieve() later turns these into gear.
            { re: /^cobblestone$/, n: 8, label: 'cobblestone' },
            { re: /_planks$/, n: 8, label: 'planks' },
            { re: /^coal$/, n: 4, label: 'coal' },
            { re: /^stick$/, n: 4, label: 'stick' },
            { re: /^iron_ingot$/, n: 64, label: 'iron_ingot' },  // take all available
            { re: /^raw_iron$/, n: 64, label: 'raw_iron' },      // take all available
        ];
        const took = [];
        try {
            for (const w of WANT) {
                if (bot.interrupt_code) break;
                const inChest = container.containerItems().filter(it => it && w.re.test(it.name));
                if (!inChest.length) continue;
                // Prefer the highest-tier item (netherite > diamond > iron > ...) by stack order.
                const tier = (nm) => nm.startsWith('netherite_') ? 4 : nm.startsWith('diamond_') ? 3 : nm.startsWith('iron_') ? 2 : nm.startsWith('golden_') ? 1 : 0;
                inChest.sort((a, b) => tier(b.name) - tier(a.name));
                let remaining = w.n;
                for (const it of inChest) {
                    if (remaining <= 0 || bot.interrupt_code) break;
                    const grab = Math.min(remaining, it.count);
                    try { await container.withdraw(it.type, null, grab); took.push(`${it.name}x${grab}`); remaining -= grab; } catch (e) { prog(`bankRecover: withdraw ${it.name} err ${e.message}`); }
                }
            }
        } catch (e) { prog(`bankRecover: withdraw loop err ${e.message}`); }
        try { await container.close(); } catch (e) {}
        // 6) Re-arm: equip the best weapon we now have, then armor.
        try { const c = world.getInventoryCounts(bot); const sword = Object.keys(c).find(n => /_sword$/.test(n) && c[n] > 0); if (sword) await skills.equip(bot, sword); } catch (e) {}
        try { await equipArmor(); } catch (e) {}
        prog(`bankRecover: took [${took.join(' ')}] — sword=${haveSword()} armor=${haveAnyArmor()}`);
        if (took.length) log(bot, `Recovered gear from bank: ${took.join(', ')}`);
    };
    try { await bankRecover(); } catch (e) { prog(`bankRecover threw: ${e.message}`); }

    // ---- SURVIVE FIRST: stock building blocks so the shelter reflex can actually build --
    // THE mechanical root of the death loop: a naked respawn carries ~0 blocks, so the
    // self_preservation bunker can neither dig DOWN (water floods at this water-edge spawn)
    // NOR pillar-box UP (needs ~7 blocks) → "Can't seal" → dies, over and over (cantSeal=19,
    // 24 deaths). Fix: the FIRST thing each life, punch a buffer of dirt (free, everywhere on
    // the surface, no tool needed) so the shelter reflexes always have material. "Survive
    // first, grind later" — the human move. Skip once we have enough.
    const buildBlocks = () => { const c = world.getInventoryCounts(bot); return (c.dirt || 0) + (c.cobblestone || 0) + (c.stone || 0) + (c.dirt_path || 0) + Object.keys(c).filter(n => /_planks$|_log$/.test(n)).reduce((s, n) => s + c[n], 0); };
    // NIGHT GATE: sticky re-arm re-enters prepNether every ~8s, and at night this
    // stocking step was DIGGING THE BOT OUT OF ITS OWN SEALED BUNKER to go find dirt
    // (alarm caught it punching its own cobblestone cap at 05:09). Block-stocking is
    // daytime work; at night the bunker IS the survival plan.
    if (buildBlocks() < 14 && !bot.interrupt_code && !isNightNow()) {
        prog(`prepNether: SURVIVE-FIRST — stocking shelter blocks (have ${buildBlocks()})`);
        try { await skills.collectBlock(bot, 'dirt', 18); } catch (e) { prog(`prepNether: stock blocks err ${e.message}`); }
        prog(`prepNether: shelter blocks now ${buildBlocks()}`);
    }

    // ---- ESTABLISH HOME (strategy layer; bed-centric) — TOP PRIORITY ----------------
    // ROOT fix for the night-swarm death loop (creeper→skeleton→zombie keep cycling as the
    // proximate killer because the real problem is being naked at a bad night respawn): a
    // BED relocates our respawn (1.21: right-click sets spawn, day or night) AND lets us
    // sleep through the night. Trying ONCE at startup failed — that lands on a night/unsafe
    // respawn and defers forever. So we keep trying in EVERY SAFE WINDOW during the grind:
    // a daytime lull near sheep actually plants the bed. No-op once home is set; defers fast
    // (cheap) when unsafe / no sheep. setBed self-bootstraps (hunt sheep→wool→craft→place→
    // set spawn). bankGear later anchors the home chest to this bed (家一体化).
    const BEDF = path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json');
    const homeSet = () => { try { return typeof JSON.parse(fs.readFileSync(BEDF, 'utf8')).x === 'number'; } catch (e) { return false; } };
    const tryHome = async () => {
        // ★家域饱和穿透 (homeSet()短路让搬家重评估永远跑不到): 锚40格内积8+死=家域沦陷,
        // 即使"家已建"也要重新调setBed(其第0步会评估并触发远环搬迁)。
        const homeSaturated = () => {
            try {
                const bj = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json'), 'utf8'));
                if (typeof bj.x !== 'number') return false;
                const dl = fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'death_log.jsonl'), 'utf8').trim().split('\n').slice(-60);
                let n = 0;
                for (const l of dl) { try { const r = JSON.parse(l); if (typeof r.x === 'number' && Math.hypot(r.x - bj.x, r.z - bj.z) < 40) n++; } catch (e) {} }
                return n >= 8;
            } catch (e) { return false; }
        };
        if ((homeSet() && !homeSaturated()) || bot.interrupt_code) return;
        if (bot.health < 10) return;                            // too hurt to do anything but survive
        // By DAY we run setBed even with spiders around — this jungle has no sheep, so setBed
        // bootstraps a bed from SPIDER STRING (4 string=1 wool, 2x2), and spiders ARE the
        // string source. setBed's own guards keep it safe (spider-hunt is day+calm gated).
        // Only at NIGHT-with-swarm do we defer (survive first). Fixes the old bug where any
        // hostile within 12 (incl. our string-source spiders) blocked the bed mission forever.
        const nightNow = (() => { try { const t = bot.time.timeOfDay; return t >= 12800 && t <= 23000; } catch (e) { return false; } })();
        if (nightNow && hostilesNear(12) > 0) return;
        prog('prepNether: window — establishing home (setBed)');
        try { await skills.customSkill(bot, 'setBed'); } catch (e) { prog(`prepNether: setBed threw ${e.message}`); }
    };
    await tryHome();

    // ---- ADAPTIVE WATER PREP (learn from fall deaths) -------------------------------
    // agent.js drops prep_water.json when we DIE to a fall. The MLG water-clutch reflex
    // (modes.js) needs a filled bucket as ammo — so once we can spare the iron (have an
    // iron pick / some iron / already a bucket), secure a water_bucket and keep it. Gated
    // so it never derails the early wood/stone grind (early falls are handled by the
    // pathfinder-flee that avoids ledges instead).
    const PWF = path.resolve(process.cwd(), 'bots', '_supervisor', 'prep_water.json');
    let wantWater = false; try { wantWater = !!JSON.parse(fs.readFileSync(PWF, 'utf8')).t; } catch (e) {}
    const canSpareIron = has('iron_pickaxe') > 0 || has('iron_ingot') >= 3 || has('bucket') > 0;
    if (wantWater && has('water_bucket') < 1 && canSpareIron && !bot.interrupt_code) {
        prog('prepNether: fall-death prep — securing a water bucket for MLG clutch');
        if (await handleTableRecoveryBlocked('bucket')) return false;
        try { if (has('bucket') < 1) await skills.customSkill(bot, 'achieve', { item: 'bucket', count: 1 }); } catch (e) {}
        try {
            if (has('bucket') > 0) {
                const water = world.getNearestBlock(bot, 'water', 32);
                if (water) {
                    await skills.goToPosition(bot, water.position.x, water.position.y + 1, water.position.z, 1);
                    const emptyB = bot.inventory.items().find(i => i.name === 'bucket');
                    if (emptyB) { try { await bot.equip(emptyB, 'hand'); } catch (e) {} try { await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true); } catch (e) {} try { bot.activateItem(); } catch (e) {} }
                    prog(`prepNether: water_bucket=${has('water_bucket')}`);
                }
            }
        } catch (e) { prog(`prepNether: water prep err ${e.message}`); }
    }

    // KIT: keep torches stocked so the torch_placing mode can LIGHT the mines. Dark deep
    // caves spawn the zombies/creepers that swarmed and killed us during diamond mining (the
    // CONFIRMED deep-mining death cause — fall + cave-mob, not lava). We mine plenty of coal;
    // turn some into torches (achieve makes the sticks). Gated on already having coal so it
    // never derails the early grind. (Resource-management kit item — torches → no dark → no
    // cave-mob swarm → survive the diamond mine.)
    const stockTorches = async () => {
        if (bot.interrupt_code || has('torch') >= 12) return;
        if (famineBudget()) {
            prog(`prepNether: SKIP torch kit — famine body budget food=${bot.food} hp=${Math.round(bot.health)} no edible`);
            return;
        }
        if (bot.health < 14 && bot.food < 18 && !hasEdible()) {
            prog(`prepNether: SKIP torch kit — no-regen body budget food=${bot.food} hp=${Math.round(bot.health)} no normal food; don't chop/craft optional torches`);
            return;
        }
        if (has('coal') < 1 && has('charcoal') < 1) return;
        prog(`prepNether: KIT — stocking torches to light the mines (torch=${has('torch')} coal=${has('coal')})`);
        try { await skills.customSkill(bot, 'achieve', { item: 'torch', count: 16 }); } catch (e) { prog(`prepNether: torch err ${e.message}`); }
        prog(`prepNether: torches now ${has('torch')}`);
    };

    // ★饿不能扛 (#21 资源管理): food<18 = NO regen, so a long underground grind with no
    // food held turns every hit permanent — the proven "10HP no-food cave death" pattern.
    // Layer-① auto_eat already eats whatever we HOLD; the gap is ACQUISITION mid-grind:
    // hunting-mode only fires when idle (never under the supervised lock) and feedUp was
    // never called by this orchestrator. Policy: hold food >= a snack at all times; when
    // we're out AND truly hungry (≤6), surface and hunt — but only by day (feedUp itself
    // bails on night/hostiles, surfaceUp is the long climb we already know how to do).
    const FOOD_RE2 = /cooked_|_bread|^bread$|^apple$|golden_apple|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|^cod$|^salmon$|melon_slice|sweet_berries|_stew|^rabbit$|baked_/;
    const edibleNow = () => bot.inventory.items().find(i => FOOD_RE2.test(i.name) && i.name !== 'rotten_flesh');
    const woodEqNow = () => {
        const c = world.getInventoryCounts(bot);
        return Object.keys(c).filter(k => k.endsWith('_planks')).reduce((s, k) => s + c[k], 0)
            + Object.keys(c).filter(k => k.endsWith('_log')).reduce((s, k) => s + c[k], 0) * 4;
    };
    const openSurfaceNow = () => {
        if (Math.floor(bot.entity.position.y) < 55) return false;
        const p = bot.entity.position.floored();
        for (let dy = 1; dy <= 8; dy++) {
            const b = bot.blockAt(p.offset(0, dy, 0));
            if (b && /water|lava/.test(b.name || '')) return false;
            if (b && b.boundingBox === 'block') return false;
        }
        return true;
    };
    const reachableWoodTarget = () => {
        const logTypes = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
        let blocks = [];
        try { blocks = world.getNearestBlocks(bot, logTypes, 18, 16) || []; } catch (e) {}
        const me = bot.entity.position;
        let nearest = null, best = Infinity, high = null;
        for (const b of blocks) {
            if (!b || !b.position) continue;
            const dist = b.position.distanceTo(me);
            const dy = b.position.y - me.y;
            if (!high || dist < high.dist) high = { block: b, dist, dy };
            if (dist <= 12 && Math.abs(dy) <= 3 && dist < best) { nearest = { block: b, dist, dy }; best = dist; }
        }
        if (nearest) return { ok: true, target: `${nearest.block.name}@${nearest.dist.toFixed(1)}b dy=${nearest.dy.toFixed(1)}` };
        if (high) return { ok: false, reason: `nearest tree ${high.block.name}@${high.dist.toFixed(1)}b dy=${high.dy.toFixed(1)} would require climb/stair` };
        return { ok: false, reason: 'no cheap tree within 18b' };
    };
    const optionalWoodSafe = () => {
        if (!openSurfaceNow()) return { ok: false, reason: `not true surface y=${Math.floor(bot.entity.position.y)} enclosed=${!!(bot._mobility && bot._mobility.enclosed)}` };
        if (isNightNow()) return { ok: false, reason: 'night' };
        if (hostilesNear(24) > 0) return { ok: false, reason: `hostiles24=${hostilesNear(24)}` };
        if (bot.health <= 14) return { ok: false, reason: `hp=${Math.round(bot.health)}` };
        if (bot.food <= 14 && !edibleNow()) return { ok: false, reason: `food=${bot.food} no edible held` };
        return reachableWoodTarget();
    };
    const foodSignalBeforeSurface = () => {
        try {
            if (isNightNow()) return { ok: false, reason: 'night' };
            if (hostilesNear(14) > 0) return { ok: false, reason: `hostiles14=${hostilesNear(14)}` };
            const me = bot.entity.position;
            const dist = (p) => p && typeof p.distanceTo === 'function' ? p.distanceTo(me) : Infinity;
            const dy = (p) => p ? Math.abs(p.y - me.y) : Infinity;
            const huntable = (e) => {
                const name = (e && (e.name || e.displayName)) || '';
                return (mc && typeof mc.isHuntable === 'function' && mc.isHuntable(e))
                    || /cow|pig|sheep|chicken|rabbit/i.test(name);
            };
            const entities = Object.values(bot.entities || {}).filter(e => e && e.position);
            const animal = entities
                .filter(e => huntable(e) && dist(e.position) <= 48 && dy(e.position) <= 4)
                .sort((a, b) => dist(a.position) - dist(b.position))[0];
            if (animal) return { ok: true, target: `animal ${animal.name || animal.displayName || 'mob'}@${Math.round(dist(animal.position))} dy=${Math.round(animal.position.y - me.y)}` };
            const fish = entities
                .filter(e => /cod|salmon/i.test((e.name || e.displayName) || '') && dist(e.position) <= 32 && dy(e.position) <= 5)
                .sort((a, b) => dist(a.position) - dist(b.position))[0];
            if (fish) return { ok: true, target: `fish ${fish.name || fish.displayName || 'fish'}@${Math.round(dist(fish.position))} dy=${Math.round(fish.position.y - me.y)}` };
            const FOOD_DROP = /rotten_flesh|beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|carrot|potato|melon/i;
            const item = entities
                .filter(e => {
                    const dropped = (e.getDroppedItem && e.getDroppedItem()) || {};
                    return e.name === 'item' && FOOD_DROP.test(dropped.name || '') && dist(e.position) <= 8 && dy(e.position) <= 3;
                })
                .sort((a, b) => dist(a.position) - dist(b.position))[0];
            if (item) return { ok: true, target: `near food-drop ${((item.getDroppedItem && item.getDroppedItem()) || {}).name || 'item'}@${Math.round(dist(item.position))} dy=${Math.round(item.position.y - me.y)}` };
            const nearBlock = (name, range, maxDy) => {
                try {
                    const b = world.getNearestBlock(bot, name, range);
                    if (b && b.position && dy(b.position) <= maxDy) return b;
                } catch (e) {}
                return null;
            };
            const melon = nearBlock('melon', 40, 5);
            if (melon) return { ok: true, target: `melon@${Math.round(dist(melon.position))} dy=${Math.round(melon.position.y - me.y)}` };
            const berry = nearBlock('sweet_berry_bush', 40, 5);
            if (berry) return { ok: true, target: `sweet_berry_bush@${Math.round(dist(berry.position))} dy=${Math.round(berry.position.y - me.y)}` };
            const oak = (() => {
                try {
                    const blocks = world.getNearestBlocks(bot, ['oak_leaves', 'dark_oak_leaves', 'oak_log', 'dark_oak_log'], 18, 32) || [];
                    return blocks
                        .filter(b => b && b.position)
                        .sort((a, b) => dist(a.position) - dist(b.position))[0] || null;
                } catch (e) { return null; }
            })();
            const anyItem = entities
                .filter(e => e.name === 'item' && dist(e.position) <= 8 && dy(e.position) <= 3)
                .sort((a, b) => dist(a.position) - dist(b.position))[0];
            const itemReason = anyItem ? ` generic item@${Math.round(dist(anyItem.position))} dy=${Math.round(anyItem.position.y - me.y)} is not confirmed food` : '';
            const oakReason = oak ? ` nearest oak ${oak.name}@${Math.round(dist(oak.position))} dy=${Math.round(oak.position.y - me.y)} is not food-signal` : '';
            return { ok: false, reason: `no same-level animal/fish/food-drop/melon/berry.${itemReason}${oakReason}` };
        } catch (e) {
            return { ok: false, reason: `scan err ${e.message}` };
        }
    };
    const feedUpDryNoFood = () => {
        try {
            const rec = bot._feedUpDryNoFood || {};
            const until = Math.max(bot._feedUpDryNoFoodUntil || 0, rec.until || 0);
            const left = until - Date.now();
            if (left <= 0 || edibleNow()) return null;
            const signal = foodSignalBeforeSurface();
            if (signal.ok) return null;
            const p = bot.entity.position;
            if (Number.isFinite(rec.x) && Number.isFinite(rec.y) && Number.isFinite(rec.z)) {
                const moved = Math.hypot(p.x - rec.x, p.z - rec.z);
                const dy = Math.abs(p.y - rec.y);
                if (moved > 18 || dy > 8) return null;
            }
            return {
                left,
                reason: rec.reason || 'dry-no-food',
                food: rec.food,
                hp: rec.hp,
                scan: rec.scan || signal.reason || 'scan=unknown',
            };
        } catch (e) {
            return null;
        }
    };
    const oakAppleForageSignal = () => {
        try {
            if (hasEdible() || !(bot.health <= 8 && bot.food < 18)) return { ok: false, reason: 'not low-hp no-regen' };
            if (isNightNow()) return { ok: false, reason: 'night' };
            if (isDuskNow()) return { ok: false, reason: 'dusk' };
            if (bot.food <= 3 && bot.health <= 8) {
                const localOak = localCriticalOakSignal();
                if (localOak.ok) return localOak;
                return { ok: false, reason: `critical-local-only ${localOak.reason}` };
            }
            const tod = (bot.time && bot.time.timeOfDay) || 0;
            if (tod >= 11000 && tod < 23000) return { ok: false, reason: `late-day tod=${tod}` };
            const threat10 = noRegenActionableThreats(10);
            if (threat10.actionable > 0) return { ok: false, reason: `actionable10=${threat10.actionable} hostiles10=${hostilesNear(10)}` };
            if (bot.game && bot.game.dimension && !/overworld/.test(bot.game.dimension)) return { ok: false, reason: `dimension=${bot.game.dimension}` };
            const me = bot.entity.position;
            const dist = (p) => p && typeof p.distanceTo === 'function' ? p.distanceTo(me) : Infinity;
            const dy = (p) => p ? Math.abs(p.y - me.y) : Infinity;
            const blocks = world.getNearestBlocks(bot, ['oak_leaves', 'dark_oak_leaves', 'oak_log', 'dark_oak_log'], 14, 32) || [];
            const oak = blocks
                .filter(b => b && b.position && dist(b.position) <= 12 && dy(b.position) <= 6)
                .sort((a, b) => dist(a.position) - dist(b.position))[0];
            if (!oak) return { ok: false, reason: 'no bounded oak' };
            const exactDist = dist(oak.position);
            const exactDy = oak.position.y - me.y;
            return {
                ok: true,
                target: `${oak.name}@${Math.round(exactDist)} dy=${Math.round(exactDy)}`,
                name: oak.name,
                dist: exactDist,
                dy: exactDy,
                pos: { x: oak.position.x, y: oak.position.y, z: oak.position.z },
            };
        } catch (e) {
            return { ok: false, reason: `oak scan err ${e.message}` };
        }
    };
    const localCriticalOakSignal = () => {
        try {
            if (hasEdible() || bot.food > 3 || bot.health > 8) return { ok: false, reason: 'not critical no-regen' };
            if (isNightNow()) return { ok: false, reason: 'night' };
            if (isDuskNow()) return { ok: false, reason: 'dusk' };
            if (bot.game && bot.game.dimension && !/overworld/.test(bot.game.dimension)) return { ok: false, reason: `dimension=${bot.game.dimension}` };
            const threat10 = noRegenActionableThreats(10);
            if (threat10.actionable > 0) return { ok: false, reason: `actionable10=${threat10.actionable} hostiles10=${hostilesNear(10)}` };
            const me = bot.entity.position;
            const dist = (p) => p && typeof p.distanceTo === 'function' ? p.distanceTo(me) : Infinity;
            const dy = (p) => p ? Math.abs(p.y - me.y) : Infinity;
            const blocks = world.getNearestBlocks(bot, ['oak_leaves', 'dark_oak_leaves', 'oak_log', 'dark_oak_log'], 8, 48) || [];
            const candidates = blocks
                .filter(b => {
                    if (!b || !b.position || !b.name) return false;
                    const d = dist(b.position);
                    const y = dy(b.position);
                    if (/_log$/.test(b.name)) return d <= 3.1 && y <= 2.5;
                    if (/_leaves$/.test(b.name)) return d <= 5.25 && y <= 4.25;
                    return false;
                })
                .sort((a, b) => dist(a.position) - dist(b.position));
            const oak = candidates[0];
            if (!oak) return { ok: false, reason: 'no close local oak' };
            const exactDist = dist(oak.position);
            const exactDy = oak.position.y - me.y;
            return {
                ok: true,
                target: `${oak.name}@${Math.round(exactDist)} dy=${Math.round(exactDy)}`,
                name: oak.name,
                dist: exactDist,
                dy: exactDy,
                pos: { x: oak.position.x, y: oak.position.y, z: oak.position.z },
            };
        } catch (e) {
            return { ok: false, reason: `local oak scan err ${e.message}` };
        }
    };
    const keepFed = async () => {
        // 维持线必须≥18 (回血阈值): 旧值14让bot吃到14就停 — 永远差4点回不了血,
        // 全天挂着hp1-2的慢性病根(磕碰伤一辈子不愈合)。19留1点余量。
        if (bot.interrupt_code || (bot.food >= 19 && bot.health >= 14)) return true;
        const f = edibleNow();
        if (f) { prog(`prepNether: KIT — eating ${f.name} (food=${bot.food})`); try { await skills.consume(bot, f.name); } catch (e) {} return true; }
        const emergencyJunk = bot.inventory.items().find(i => /rotten_flesh|spider_eye/.test(i.name || ''));
        if (emergencyJunk && bot.food <= 11 && bot.health <= 8 && !hasEdible()) {
            prog(`prepNether: emergency food — eating ${emergencyJunk.name} before movement (food=${bot.food} hp=${Math.round(bot.health)})`);
            try { await skills.consume(bot, emergencyJunk.name); } catch (e) {}
            try { await skills.wait(bot, 600); } catch (e) {}
            bot._prepEmergencyJunkAteAt = Date.now();
            if (bot.food >= 18 || bot.health >= 14 || hasEdible()) return true;
            prog(`prepNether: emergency food eaten but still no-regen (food=${bot.food} hp=${Math.round(bot.health)}); re-evaluate food route before mining`);
        }
        const lowHpNoRegen = bot.health < 14 && bot.food < 18;
        if (lowHpNoRegen && !hasEdible()) await noRegenStaticKit('keepFed');
        if (bot.food >= 12 && !lowHpNoRegen) return true;        // no food held but enough buffer to continue short prep work
        if (isNightNow()) {
            prog(`prepNether: ★HUNGRY/LOWHP food=${bot.food} hp=${Math.round(bot.health)}, no food held, night — HOLD all work until dawn`);
            let held = 0;
            while (isNightNow() && !bot.interrupt_code && (bot.food < 12 || (bot.health < 14 && bot.food < 18)) && !edibleNow()) {
                if (held > 0 && held % 5 === 0) prog(`prepNether: hungry-night hold ${held * 6}s food=${bot.food} hp=${Math.round(bot.health)}`);
                try { bot.clearControlStates(); } catch (e) {}
                try { await skills.wait(bot, 6000); } catch (e) { break; }
                held++;
            }
            if (bot.interrupt_code) return false;
            if ((bot.food >= 12 && !(bot.health < 14 && bot.food < 18)) || edibleNow()) return true;
        }
        if (lowHpNoRegen && !hasEdible()) {
            const oakSignal = oakAppleForageSignal();
            const persistedOakBackoff = (() => {
                const rec = oakSignal.ok ? readOakAppleBackoff() : null;
                if (!rec || rec.target !== oakSignal.target) return 0;
                const staleReachBackoff = bot.food <= 3
                    && oakSignal.dist <= 5.1
                    && rec.reachable === 0
                    && rec.nearest
                    && rec.nearest.dist <= 5.1
                    && (rec.maxReach == null || rec.maxReach < 5.05);
                if (staleReachBackoff) {
                    prog(`prepNether: bounded oak/apple forage ignores stale reach backoff for ${oakSignal.target} nearest=${rec.nearest.name}@${rec.nearest.dist.toFixed(2)} maxReach=${rec.maxReach == null ? 'old' : rec.maxReach} food=${bot.food} hp=${Math.round(bot.health)}`);
                    return 0;
                }
                const occludedRetryBackoff = bot.food <= 3
                    && oakSignal.dist <= 5.2
                    && rec.reachable > 0
                    && rec.broken === 0
                    && rec.failed > 0
                    && rec.maxReach >= 5
                    && rec.nearest
                    && rec.nearest.dist <= 5.2;
                if (occludedRetryBackoff) {
                    const shortUntil = (rec.at || Date.now()) + 30000;
                    const wait = Math.max(0, shortUntil - Date.now());
                    if (wait <= 0) prog(`prepNether: bounded oak/apple forage ignores long occlusion backoff for ${oakSignal.target} failed=${rec.failed} opened=${rec.openedWindows || 0}`);
                    return wait;
                }
                const nearLogRetryBackoff = bot.food <= 3
                    && oakSignal.dist <= 2.5
                    && rec.reachable === 0
                    && (rec.maxReach || 0) >= 5
                    && rec.nearest
                    && rec.nearest.dist <= 6.5;
                if (nearLogRetryBackoff) {
                    const shortUntil = (rec.at || Date.now()) + 45000;
                    const wait = Math.max(0, shortUntil - Date.now());
                    if (wait <= 0) prog(`prepNether: bounded oak/apple forage ignores long near-log backoff for ${oakSignal.target} nearest=${rec.nearest.name}@${rec.nearest.dist.toFixed(2)}`);
                    return wait;
                }
                try {
                    bot._prepOakApplePulseBackoffUntil = Math.max(bot._prepOakApplePulseBackoffUntil || 0, rec.until);
                    bot._prepOakApplePulseBackoffTarget = rec.target;
                } catch (e) {}
                return Math.max(0, rec.until - Date.now());
            })();
            let runtimeOakBackoff = Math.max(0, (bot._prepOakApplePulseBackoffUntil || 0) - Date.now());
            const runtimeBackoffTarget = bot._prepOakApplePulseBackoffTarget || null;
            if (runtimeOakBackoff > 0 && runtimeBackoffTarget && runtimeBackoffTarget !== oakSignal.target) {
                prog(`prepNether: bounded oak/apple forage clears runtime backoff target mismatch old=${runtimeBackoffTarget} new=${oakSignal.target}`);
                bot._prepOakApplePulseBackoffUntil = 0;
                bot._prepOakApplePulseBackoffTarget = null;
                runtimeOakBackoff = 0;
            } else if (runtimeOakBackoff > 0 && !runtimeBackoffTarget && bot.food <= 3 && bot.health <= 8) {
                prog(`prepNether: bounded oak/apple forage clears unscoped critical runtime backoff for ${oakSignal.target}`);
                bot._prepOakApplePulseBackoffUntil = 0;
                runtimeOakBackoff = 0;
            }
            const lastSweep = bot._feedUpLastLeafSweep && Date.now() - bot._feedUpLastLeafSweep.at < 10 * 60 * 1000 ? bot._feedUpLastLeafSweep : null;
            const staleRuntimeReachBackoff = oakSignal.ok
                && runtimeOakBackoff > 0
                && bot.food <= 3
                && oakSignal.dist <= 5.1
                && lastSweep
                && lastSweep.reachable === 0
                && lastSweep.nearest
                && lastSweep.nearest.dist <= 5.1
                && (lastSweep.maxReach == null || lastSweep.maxReach < 5.05);
            if (staleRuntimeReachBackoff) {
                prog(`prepNether: bounded oak/apple forage clears stale runtime reach backoff for ${oakSignal.target} nearest=${lastSweep.nearest.name}@${lastSweep.nearest.dist.toFixed(2)} maxReach=${lastSweep.maxReach == null ? 'old' : lastSweep.maxReach}`);
                bot._prepOakApplePulseBackoffUntil = 0;
                bot._prepOakApplePulseBackoffTarget = null;
                runtimeOakBackoff = 0;
            }
            const nearLogRuntimeRetry = oakSignal.ok
                && runtimeOakBackoff > 45000
                && bot.food <= 3
                && oakSignal.dist <= 2.5
                && lastSweep
                && lastSweep.reachable === 0
                && (lastSweep.maxReach || 0) >= 5
                && lastSweep.nearest
                && lastSweep.nearest.dist <= 6.5;
            if (nearLogRuntimeRetry) {
                prog(`prepNether: bounded oak/apple forage shortens near-log runtime backoff for ${oakSignal.target} nearest=${lastSweep.nearest.name}@${lastSweep.nearest.dist.toFixed(2)}`);
                bot._prepOakApplePulseBackoffUntil = Date.now() + 45000;
                bot._prepOakApplePulseBackoffTarget = oakSignal.target;
                runtimeOakBackoff = 45000;
            }
            const oakPulseBackoff = Math.max(0, runtimeOakBackoff, persistedOakBackoff);
            if (oakSignal.ok && oakPulseBackoff <= 0) {
                const foodBeforeOak = bot.food;
                bot._prepOakApplePulseBackoffUntil = Date.now() + 90000;
                bot._prepOakApplePulseBackoffTarget = oakSignal.target;
                prog(`prepNether: bounded oak/apple forage — ${oakSignal.target}; direct feedUp pulse, no surfaceUp blind climb (food=${bot.food} hp=${Math.round(bot.health)})`);
                try { await skills.customSkill(bot, 'feedUp', 18); } catch (e) { prog(`prepNether: oak/apple feedUp err ${e.message}`); }
                const sweep = bot._feedUpLastLeafSweep && Date.now() - bot._feedUpLastLeafSweep.at < 10000 ? bot._feedUpLastLeafSweep : null;
                if (sweep && (!sweep.reachable || !sweep.broken)) {
                    const decayKick = !!sweep.decayKick;
                    const occludedNearLeaf = sweep.reachable > 0
                        && !sweep.broken
                        && (sweep.failed || 0) > 0
                        && (sweep.maxReach || 0) >= 5
                        && sweep.nearest
                        && sweep.nearest.dist <= 5.2;
                    const backoffMs = decayKick ? 45000 : (occludedNearLeaf ? 30000 : (sweep.reachable ? 180000 : 300000));
                    bot._prepOakApplePulseBackoffUntil = Date.now() + backoffMs;
                    bot._prepOakApplePulseBackoffTarget = oakSignal.target;
                    const n = sweep.nearest ? `${sweep.nearest.name}@${Math.round(sweep.nearest.dist)} dy=${Math.round(sweep.nearest.dy)} ${sweep.nearest.x},${sweep.nearest.y},${sweep.nearest.z}` : 'none';
                    writeOakAppleBackoff({
                        at: Date.now(),
                        until: bot._prepOakApplePulseBackoffUntil,
                        target: oakSignal.target,
                        reachable: sweep.reachable,
                        broken: sweep.broken,
                        failed: sweep.failed || 0,
                        maxReach: sweep.maxReach,
                        openedWindows: sweep.openedWindows || 0,
                        nearest: sweep.nearest || null,
                        decayKick,
                    });
                    prog(`prepNether: bounded oak/apple forage no real leaf action reachable=${sweep.reachable} broken=${sweep.broken} failed=${sweep.failed || 0} opened=${sweep.openedWindows || 0} decayKick=${decayKick} nearest=${n}; oak pulse backoff ${Math.ceil(backoffMs / 1000)}s`);
                }
                if (edibleNow() || bot.food > foodBeforeOak || (bot.food >= 18 && bot.health < 14)) return true;
                prog(`prepNether: bounded oak/apple forage found no edible/improvement (${foodBeforeOak}->${bot.food}); hold body`);
                bot._prepLowHpNoFoodUntil = Date.now() + 60000;
                try { bot.clearControlStates(); } catch (e) {}
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                return false;
            }
            if (oakSignal.ok && oakPulseBackoff > 0 && (!bot._lastPrepOakAppleBackoffLogAt || Date.now() - bot._lastPrepOakAppleBackoffLogAt > 30000)) {
                bot._lastPrepOakAppleBackoffLogAt = Date.now();
                prog(`prepNether: bounded oak/apple forage backoff ${Math.ceil(oakPulseBackoff / 1000)}s for ${oakSignal.target}`);
            }
            if (oakSignal.ok && oakPulseBackoff > 0) {
                const junkBoosted = Date.now() - (bot._prepEmergencyJunkAteAt || 0) < 180000;
                const probeReady = Date.now() > (bot._prepBoostedOakClimbUntil || 0);
                if (junkBoosted && probeReady && bot.food >= 14 && bot.health <= 8 && !isNightNow() && !isDuskNow() && hostilesNear(16) === 0) {
                    bot._prepBoostedOakClimbUntil = Date.now() + 300000;
                    const surfTarget = Math.max(63, Math.floor(bot.entity.position.y) + 6);
                    prog(`prepNether: boosted oak climb probe — ate emergency junk, ${oakSignal.target} still unreachable/backoff; surfaceUp target=${surfTarget} then one feedUp pulse`);
                    try { await skills.customSkill(bot, 'surfaceUp', surfTarget); } catch (e) { prog(`prepNether: boosted oak climb surfaceUp err ${e.message}`); }
                    try { await skills.customSkill(bot, 'feedUp', 18); } catch (e) { prog(`prepNether: boosted oak climb feedUp err ${e.message}`); }
                    if (edibleNow() || bot.food >= 18 || bot.health >= 14) return true;
                    prog(`prepNether: boosted oak climb probe found no recovery (food=${bot.food} hp=${Math.round(bot.health)}); resume hold`);
                    bot._prepLowHpNoFoodUntil = Date.now() + 60000;
                    try { bot.clearControlStates(); } catch (e) {}
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                    return false;
                }
                bot._prepLowHpNoFoodUntil = Date.now() + Math.min(oakPulseBackoff, 30000);
                try { bot.clearControlStates(); } catch (e) {}
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                return false;
            }
        }
        const foodSurfaceBackoff = Math.max(0, (bot._prepNoFoodSurfaceBackoffUntil || 0) - Date.now());
        const moderateSafeUndergroundWork = () => {
            try {
                if (openSurfaceNow() || isNightNow() || isDuskNow()) return false;
                if (bot.food < 8 || bot.health < 14 || edibleNow()) return false;
                if (!hasAnyHeldPick()) return false;
                if (!coveredAboveNow() && !containedMobilityNow()) return false;
                const threat = noRegenActionableThreats(12);
                return threat.actionable === 0;
            } catch (e) {
                return false;
            }
        };
        if (moderateSafeUndergroundWork()) {
            if (!bot._lastModerateUndergroundNoFoodWorkAt || Date.now() - bot._lastModerateUndergroundNoFoodWorkAt > 30000) {
                bot._lastModerateUndergroundNoFoodWorkAt = Date.now();
                prog(`prepNether: HUNGER/LOWHP gate — no surface food signal, but hp=${Math.round(bot.health)} food=${bot.food} calm/enclosed with pick; allow local underground prep only`);
            }
            return true;
        }
        if (foodSurfaceBackoff > 0 && !openSurfaceNow() && bot.food >= 7) {
            prog(`prepNether: HUNGER/LOWHP gate — last surface/feedUp found no food; backoff ${Math.ceil(foodSurfaceBackoff / 1000)}s before another cave climb (food=${bot.food} hp=${Math.round(bot.health)})`);
            try { bot.clearControlStates(); } catch (e) {}
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
            return false;
        }
        if (!openSurfaceNow() && bot.food <= 3 && bot.health <= 8 && !edibleNow()) {
            const localOak = localCriticalOakSignal();
            if (localOak.ok) {
                const foodBeforeLocalOak = bot.food;
                bot._prepOakApplePulseBackoffUntil = Date.now() + 45000;
                bot._prepOakApplePulseBackoffTarget = localOak.target;
                prog(`prepNether: CRITICAL local oak forage — ${localOak.target}; bounded feedUp only, no surfaceUp/no long cave-climb backoff (food=${bot.food} hp=${Math.round(bot.health)})`);
                try { await skills.customSkill(bot, 'feedUp', 18); } catch (e) { prog(`prepNether: critical local oak feedUp err ${e.message}`); }
                const sweep = bot._feedUpLastLeafSweep && Date.now() - bot._feedUpLastLeafSweep.at < 10000 ? bot._feedUpLastLeafSweep : null;
                if (sweep) {
                    const decayKick = !!sweep.decayKick;
                    const backoffMs = decayKick ? 45000 : 60000;
                    bot._prepOakApplePulseBackoffUntil = Date.now() + backoffMs;
                    bot._prepOakApplePulseBackoffTarget = localOak.target;
                    writeOakAppleBackoff({
                        at: Date.now(),
                        until: bot._prepOakApplePulseBackoffUntil,
                        target: localOak.target,
                        reachable: sweep.reachable,
                        broken: sweep.broken,
                        failed: sweep.failed || 0,
                        maxReach: sweep.maxReach,
                        openedWindows: sweep.openedWindows || 0,
                        nearest: sweep.nearest || null,
                        decayKick,
                    });
                    prog(`prepNether: CRITICAL local oak forage sweep reachable=${sweep.reachable} broken=${sweep.broken} failed=${sweep.failed || 0} decayKick=${decayKick}; retry backoff ${Math.ceil(backoffMs / 1000)}s`);
                }
                if (edibleNow() || bot.food > foodBeforeLocalOak) return true;
                prog(`prepNether: CRITICAL local oak forage no edible/improvement (${foodBeforeLocalOak}->${bot.food}); hold body, retry local signal shortly`);
                bot._prepLowHpNoFoodUntil = Date.now() + 45000;
                try { bot.clearControlStates(); } catch (e) {}
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                return false;
            }
            prog(`prepNether: CRITICAL no-regen food gate — food=${bot.food} hp=${Math.round(bot.health)} no edible, enclosed/high-pocket; no surfaceUp blind climb, hold for bounded/local forage only`);
            bot._prepLowHpNoFoodUntil = Date.now() + 60000;
            bot._prepNoFoodSurfaceBackoffUntil = Date.now() + 90000;
            try { bot.clearControlStates(); } catch (e) {}
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
            return false;
        }
        if (!openSurfaceNow() && bot.food >= 7) {
            const signal = foodSignalBeforeSurface();
            if (!signal.ok) {
                prog(`prepNether: HUNGER/LOWHP gate — no concrete food signal before cave climb (${signal.reason}); hold instead of surfaceUp (food=${bot.food} hp=${Math.round(bot.health)} y=${Math.round(bot.entity.position.y)})`);
                bot._prepLowHpNoFoodUntil = Date.now() + 60000;
                bot._prepNoFoodSurfaceBackoffUntil = Date.now() + 180000;
                try { bot.clearControlStates(); } catch (e) {}
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                return false;
            }
            prog(`prepNether: food signal before surface climb — ${signal.target}`);
        }
        const dryFood = feedUpDryNoFood();
        if (dryFood) {
            prog(`prepNether: HUNGER/LOWHP gate — feedUp dry no-food cooldown ${Math.ceil(dryFood.left / 1000)}s reason=${dryFood.reason} prev=${dryFood.food}/${dryFood.hp}; hold instead of retrying feedUp (food=${bot.food} hp=${Math.round(bot.health)})`);
            bot._prepLowHpNoFoodUntil = Date.now() + Math.min(dryFood.left, 60000);
            if (!openSurfaceNow() && bot.food >= 7) bot._prepNoFoodSurfaceBackoffUntil = Date.now() + Math.max(dryFood.left, 60000);
            try { bot.clearControlStates(); } catch (e) {}
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
            return false;
        }
        prog(`prepNether: ★HUNGRY/LOWHP food=${bot.food} hp=${Math.round(bot.health)}, no food held → surfacing to hunt (feedUp)`);
        try {
            if (!openSurfaceNow()) {
                const surfTarget = Math.max(63, Math.floor(bot.entity.position.y) + 8);
                prog(`prepNether: enclosed/high-pocket food run — surfaceUp target=${surfTarget}`);
                await skills.customSkill(bot, 'surfaceUp', surfTarget);
            }
        } catch (e) { prog(`prepNether: surfaceUp err ${e.message}`); }
        const foodBeforeHunt = bot.food;
        try { await skills.customSkill(bot, 'feedUp', 18); } catch (e) { prog(`prepNether: feedUp err ${e.message}`); }
        prog(`prepNether: hunt done — food=${bot.food} hp=${Math.round(bot.health)}`);
        if (bot.food <= 2 && bot.health <= 6 && woodEqNow() < 2) {
            prog(`prepNether: FAMINE forage — feedUp found no food; trying nearby wood/apples once before holding`);
            try { await skills.customSkill(bot, 'chopWood', 2, { allowCriticalForage: true }); } catch (e) { prog(`prepNether: famine chopWood err ${e.message}`); }
        }
        const edibleAfter = edibleNow();
        if (edibleAfter) {
            prog(`prepNether: famine recovery food item ${edibleAfter.name} — eat before resuming`);
            try { await skills.consume(bot, edibleAfter.name); } catch (e) {}
        }
        if ((bot.food < 12 || (bot.health < 14 && bot.food < 18)) && !edibleNow() && bot.food <= foodBeforeHunt) {
            prog(`prepNether: HUNGER/LOWHP gate — feedUp found no edible food and food did not improve (${foodBeforeHunt}->${bot.food}, hp=${Math.round(bot.health)}); stop prep work`);
            bot._prepLowHpNoFoodUntil = Date.now() + 60000;
            if (bot.food >= 7) bot._prepNoFoodSurfaceBackoffUntil = Date.now() + 180000;
            try { bot.clearControlStates(); } catch (e) {}
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
            return false;
        }
        if (bot.food <= 2 && !edibleNow()) {
            prog(`prepNether: FAMINE gate — feedUp found no edible food; stop all prep work at food=${bot.food} hp=${Math.round(bot.health)}`);
            try { bot.clearControlStates(); } catch (e) {}
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
            return false;
        }
        return true;
    };

    const planksEqHeld = () => {
        const c = world.getInventoryCounts(bot);
        return Object.keys(c).filter(k => k.endsWith('_planks')).reduce((s, k) => s + c[k], 0)
            + Object.keys(c).filter(k => k.endsWith('_log')).reduce((s, k) => s + c[k], 0) * 4;
    };
    const localStation = async (type) => {
        const near = world.getNearestBlock(bot, type, 4);
        if (near && bot.entity.position.distanceTo(near.position) <= 4.5) return near;
        if (has(type) <= 0) return null;
        const empty = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern']);
        const noBuild = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'bedrock']);
        const stoneLike = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/;
        const hasPick = () => bot.inventory.items().some(i => /_pickaxe$/.test(i.name));
        const base = bot.entity.position.floored();
        const offsets = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[2,0,0],[-2,0,0],[0,0,2],[0,0,-2]];
        for (const [dx, dy, dz] of offsets) {
            const p = base.offset(dx, dy, dz);
            let t = bot.blockAt(p);
            const floor = bot.blockAt(p.offset(0, -1, 0));
            if (!t) continue;
            if (!empty.has(t.name || '')) {
                if (noBuild.has(t.name || '') || t.boundingBox !== 'block') continue;
                if (stoneLike.test(t.name || '') && !hasPick()) continue;
                try {
                    prog(`prepNether: FAMINE local station niche — dig ${t.name} @${p.x},${p.y},${p.z} for ${type}`);
                    await skills.breakBlockAt(bot, p.x, p.y, p.z);
                    t = bot.blockAt(p);
                } catch (e) { continue; }
            }
            if (!t || !empty.has(t.name || '')) continue;
            if (!floor || floor.boundingBox !== 'block' || noBuild.has(floor.name || '')) continue;
            try {
                const ok = await skills.placeBlock(bot, type, p.x, p.y, p.z, 'bottom', true);
                if (ok) {
                    const placed = world.getNearestBlock(bot, type, 4);
                    if (placed) return placed;
                }
            } catch (e) {}
        }
        return null;
    };
    const famineStaticKit = async () => {
        const lowFoodContainedStaticKit = !hasEdible() && bot.food <= 6 && (coveredAboveNow() || containedMobilityNow());
        if (!famineBudget() && !lowFoodContainedStaticKit) return false;
        let helped = false;
        const staticReason = famineBudget() ? 'FAMINE' : 'LOW-FOOD contained';
        prog(`prepNether: ${staticReason} static kit check food=${bot.food} hp=${Math.round(bot.health)} shield=${has('shield')} ironPick=${has('iron_pickaxe')} iron=${has('iron_ingot')} raw=${has('raw_iron')} planksEq=${planksEqHeld()}`);
        const targetIron = has('iron_pickaxe') < 1 && has('stick') >= 2 ? 3 : 1;
        if (has('iron_ingot') < targetIron && has('raw_iron') > 0 && (has('coal') > 0 || has('charcoal') > 0 || planksEqHeld() > 0)) {
            const f = await localStation('furnace');
            if (f) {
                try {
                    const before = has('iron_ingot');
                    const need = Math.max(1, Math.min(has('raw_iron'), targetIron - before));
                    await skills.customSkill(bot, 'smeltSafe', 'raw_iron', need);
                    helped = helped || has('iron_ingot') > before;
                } catch (e) {
                    prog(`prepNether: ${staticReason} static smelt err ${e.message}`);
                }
            } else {
                prog(`prepNether: ${staticReason} static kit — no reachable furnace spot, no movement`);
            }
        }
        if (has('crafting_table') < 1 && !world.getNearestBlock(bot, 'crafting_table', 4) && planksEqHeld() >= 4) {
            try { helped = (await skills.craftRecipeLocal(bot, 'crafting_table', 1)) || helped; }
            catch (e) { prog(`prepNether: ${staticReason} static table err ${e.message}`); }
        }
        if (has('iron_pickaxe') < 1 && has('iron_ingot') >= 3 && has('stick') >= 2) {
            const t = await localStation('crafting_table');
            if (t) {
                try {
                    const before = has('iron_pickaxe');
                    if (await skills.craftRecipeLocal(bot, 'iron_pickaxe', 1)) {
                        helped = true;
                        if (has('iron_pickaxe') > before) {
                            try { await skills.equip(bot, 'iron_pickaxe'); } catch (e) {}
                            prog(`prepNether: ${staticReason} static iron_pickaxe crafted/equipped ironPick=${has('iron_pickaxe')}`);
                        }
                    }
                } catch (e) { prog(`prepNether: ${staticReason} static iron_pickaxe err ${e.message}`); }
            } else {
                prog(`prepNether: ${staticReason} static iron_pickaxe — no reachable crafting table spot, no movement`);
            }
        }
        if (has('shield') < 1 && has('iron_ingot') >= 1 && planksEqHeld() >= 6) {
            const t = await localStation('crafting_table');
            if (t) {
                try {
                    const before = has('shield');
                    if (await skills.craftRecipeLocal(bot, 'shield', 1)) {
                        helped = true;
                        if (has('shield') > before) {
                            try { await skills.equip(bot, 'shield'); } catch (e) {}
                            prog(`prepNether: ${staticReason} static shield crafted/equipped shield=${has('shield')}`);
                        }
                    }
                } catch (e) { prog(`prepNether: ${staticReason} static shield err ${e.message}`); }
            } else {
                prog(`prepNether: ${staticReason} static shield — no reachable crafting table spot, no movement`);
            }
        }
        if (!Object.keys(world.getInventoryCounts(bot)).some(n => /_sword$/.test(n) && has(n) > 0) && planksEqHeld() >= 2) {
            const t = await localStation('crafting_table');
            if (t) {
                try {
                    if (has('stick') < 1) await skills.craftRecipeLocal(bot, 'stick', 4);
                    const sword = has('cobblestone') >= 2 ? 'stone_sword' : 'wooden_sword';
                    const before = has(sword);
                    await skills.craftRecipeLocal(bot, sword, 1);
                    helped = helped || has(sword) > before;
                } catch (e) { prog(`prepNether: ${staticReason} static sword err ${e.message}`); }
            }
        }
        return helped;
    };

    // ★人类式资源管理 (#21, 用户提出"想想人类玩家怎么做"): humans manage FUTURE consumption,
    // not current possession. The rules encoded here:
    //   1. 备用镐铁律 — a pickaxe is a CONSUMABLE (132 uses for stone tier). Always hold 2
    //      EFFECTIVE picks; a >85%-worn pick is not a pick (durability sense — replace it
    //      BEFORE it snaps mid-swing, cobble is free while mining).
    //   2. 木头是地下的硬通货 — sticks come only from wood and wood only from the surface.
    //      Hold a log/plank buffer at all times; top it up when CHEAP (surface, daytime),
    //      never discover it's gone when EXPENSIVE (deep, pick broken = run is dead — the
    //      exact #23 "surface to craft pickaxe" freeze).
    //   3. 家当自愈 — placed kit (furnace/crafting_table) gets left behind when flows are
    //      interrupted (用户实测: 熔炉熔完落在原地). Replacements from held cobble are nearly
    //      free; walking back never is.
    const PICK_RE = /_pickaxe$/;
    const effectivePicks = () => {
        // count picks with real life left; fall back to raw count if durability is unreadable
        try {
            let n = 0;
            for (const it of bot.inventory.items()) {
                if (!PICK_RE.test(it.name)) continue;
                const max = it.maxDurability || 0;
                const used = (typeof it.durabilityUsed === 'number') ? it.durabilityUsed : 0;
                if (!max || (used / max) < 0.85) n++;
            }
            return n;
        } catch (e) {
            const c = world.getInventoryCounts(bot);
            return ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].reduce((s, n2) => s + (c[n2] || 0), 0);
        }
    };
    const noRegenStaticKit = async (reason = 'body-budget') => {
        if (bot.interrupt_code || hasEdible() || bot.health >= 14 || bot.food >= 18) return false;
        if (bot._lastNoRegenStaticKitAt && Date.now() - bot._lastNoRegenStaticKitAt < 20000) return false;
        bot._lastNoRegenStaticKitAt = Date.now();

        const base = bot.entity.position.floored();
        const foot = bot.blockAt(base);
        const head = bot.blockAt(base.offset(0, 1, 0));
        const under = bot.blockAt(base.offset(0, -1, 0));
        const velY = Math.abs((bot.entity.velocity && bot.entity.velocity.y) || 0);
        const unsafeFluid = (b) => b && /water|lava/.test(b.name || '');
        const stable = velY < 0.12 && under && under.boundingBox === 'block' && !unsafeFluid(foot) && !unsafeFluid(head) && !unsafeFluid(under);
        const hostileCount = hostilesNear(8);
        const threat = noRegenActionableThreats(8);
        const tableNear = world.getNearestBlock(bot, 'crafting_table', 4);
        let c = world.getInventoryCounts(bot);
        const count = (n) => c[n] || 0;
        const planksEqLocal = () => Object.keys(c).filter(k => k.endsWith('_planks')).reduce((s, k) => s + c[k], 0)
            + Object.keys(c).filter(k => k.endsWith('_log')).reduce((s, k) => s + c[k], 0) * 4;
        const maxPlankStack = () => Math.max(0, ...Object.keys(c).filter(k => k.endsWith('_planks')).map(k => c[k] || 0));
        const hasSwordTier = () => Object.keys(c).some(n => /^(stone|iron|diamond|netherite)_sword$/.test(n) && c[n] > 0);
        const kitReady = () => effectivePicks() >= 1 && (count('crafting_table') > 0 || world.getNearestBlock(bot, 'crafting_table', 4))
            && count('stick') >= 2 && hasSwordTier();
        let helped = false;

        if (kitReady()) {
            if (!bot._lastNoRegenStaticKitReadyLogAt || Date.now() - bot._lastNoRegenStaticKitReadyLogAt > 120000) {
                bot._lastNoRegenStaticKitReadyLogAt = Date.now();
                prog(`prepNether: NO-REGEN static kit ready (${reason}) pick=${effectivePicks()} tableNear=${tableNear ? `${tableNear.position.x},${tableNear.position.y},${tableNear.position.z}` : 'yes'} stick=${count('stick')} swordTier=yes`);
            }
            return false;
        }

        const threatNearest = threat.nearest ? `${threat.nearest.name}@${threat.nearest.d.toFixed(1)} dy=${threat.nearest.dy.toFixed(1)}` : 'none';
        prog(`prepNether: NO-REGEN static kit check (${reason}) pos=${base.x},${base.y},${base.z} foot=${foot ? foot.name : 'null'} head=${head ? head.name : 'null'} under=${under ? under.name : 'null'} stable=${stable} hostiles8=${hostileCount} actionable8=${threat.actionable} layered8=${threat.layered} secured=${threat.secured} nearest=${threatNearest} hp=${Math.round(bot.health)} food=${bot.food} pick=${effectivePicks()} tableInv=${count('crafting_table')} tableNear=${tableNear ? `${tableNear.position.x},${tableNear.position.y},${tableNear.position.z}` : 'none'} cobble=${count('cobblestone')} stick=${count('stick')} planksEq=${planksEqLocal()}`);
        if (!stable) {
            prog(`prepNether: NO-REGEN static kit skip — unstable/fluid body, no local crafting movement`);
            return false;
        }
        if (threat.actionable > 0) {
            prog(`prepNether: NO-REGEN static kit skip — actionable hostile within 8 (${threatNearest}), keep body for defense`);
            return false;
        }
        if (threat.layered > 0) {
            prog(`prepNether: NO-REGEN static kit — ignoring ${threat.layered}/${threat.raw} layered sealed threat(s) for zero-move local crafting (${threatNearest})`);
        }

        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}

        const refresh = () => { c = world.getInventoryCounts(bot); return c; };
        if (maxPlankStack() < 4) {
            const logName = Object.keys(c).find(k => k.endsWith('_log') && c[k] > 0);
            if (logName) {
                const plankName = logName.replace(/_log$/, '_planks');
                const before = planksEqLocal();
                try { await skills.craftRecipeLocal(bot, plankName, 1); } catch (e) { prog(`prepNether: NO-REGEN static planks err ${e.message}`); }
                refresh();
                helped = helped || planksEqLocal() > before;
            }
        }

        if (count('crafting_table') < 1 && !world.getNearestBlock(bot, 'crafting_table', 4) && maxPlankStack() >= 4) {
            const before = count('crafting_table');
            try { await skills.craftRecipeLocal(bot, 'crafting_table', 1); } catch (e) { prog(`prepNether: NO-REGEN static table err ${e.message}`); }
            refresh();
            helped = helped || count('crafting_table') > before;
        }

        if (count('stick') < 2 && planksEqLocal() >= 2) {
            const before = count('stick');
            try { await skills.craftRecipeLocal(bot, 'stick', 1); } catch (e) { prog(`prepNether: NO-REGEN static stick err ${e.message}`); }
            refresh();
            helped = helped || count('stick') > before;
        }

        if (effectivePicks() < 1 && count('cobblestone') >= 3 && count('stick') >= 2) {
            const before = count('stone_pickaxe');
            try { await skills.craftRecipeLocal(bot, 'stone_pickaxe', 1); } catch (e) { prog(`prepNether: NO-REGEN static pick err ${e.message}`); }
            refresh();
            if (count('stone_pickaxe') > before) {
                helped = true;
                try { await skills.equip(bot, 'stone_pickaxe'); } catch (e) {}
                prog(`prepNether: NO-REGEN static stone_pickaxe crafted/equipped count=${count('stone_pickaxe')}`);
            }
        }

        if (!hasSwordTier() && count('cobblestone') >= 2 && count('stick') >= 1) {
            const before = count('stone_sword');
            try { await skills.craftRecipeLocal(bot, 'stone_sword', 1); } catch (e) { prog(`prepNether: NO-REGEN static sword err ${e.message}`); }
            refresh();
            if (count('stone_sword') > before) {
                helped = true;
                try { await skills.equip(bot, 'stone_sword'); } catch (e) {}
                prog(`prepNether: NO-REGEN static stone_sword crafted/equipped count=${count('stone_sword')}`);
            }
        }

        prog(`prepNether: NO-REGEN static kit result helped=${helped} pick=${effectivePicks()} tableInv=${count('crafting_table')} tableNear=${world.getNearestBlock(bot, 'crafting_table', 4) ? 'yes' : 'none'} cobble=${count('cobblestone')} stick=${count('stick')} planksEq=${planksEqLocal()}`);
        return helped;
    };
    const keepKit = async () => {
        if (bot.interrupt_code) return;
        if (famineBudget()) {
            await famineStaticKit();
            prog(`prepNether: SKIP roaming kit — famine body budget food=${bot.food} hp=${Math.round(bot.health)} no edible`);
            return;
        }
        const c = () => world.getInventoryCounts(bot);
        const cnt = (n) => c()[n] || 0;
        const planksEq = () => Object.keys(c()).filter(k => k.endsWith('_planks')).reduce((s, k) => s + c()[k], 0)
            + Object.keys(c()).filter(k => k.endsWith('_log')).reduce((s, k) => s + c()[k], 0) * 4;
        const onSurface = bot.entity.position.y >= 55;
        // 1) spare picks (durability-aware). craftRecipe places our held table when needed.
        let guard = 0;
        while (effectivePicks() < 2 && cnt('cobblestone') >= 3 && (cnt('stick') >= 2 || planksEq() >= 2) && guard++ < 3) {
            prog(`prepNether: KIT — effective picks ${effectivePicks()}<2 → crafting spare stone_pickaxe`);
            try {
                if (cnt('stick') < 2) { try { await skills.customSkill(bot, 'achieve', { item: 'stick', count: 4 }); } catch (e) {} }
                await skills.craftRecipe(bot, 'stone_pickaxe', 1);
            } catch (e) { prog(`prepNether: spare pick err ${e.message}`); break; }
        }
        // 2) stick buffer (works underground while logs last — planks/sticks need no table)
        if (cnt('stick') < 4 && planksEq() >= 2) {
            try { await skills.customSkill(bot, 'achieve', { item: 'stick', count: 8 }); } catch (e) {}
        }
        // 3) wood buffer — top up ONLY where it's cheap: surface + daylight. 8 planks-worth
        //    covers a full expedition of pick/stick replacements.
        if (planksEq() < 8 && onSurface && !isNightNow()) {
            const woodGate = optionalWoodSafe();
            if (!woodGate.ok) {
                prog(`prepNether: SKIP wood buffer — ${woodGate.reason}`);
                return;
            }
            prog(`prepNether: KIT — wood buffer low (${planksEq()} planks-eq), ${woodGate.target} → chopWood before descending`);
            try { await skills.customSkill(bot, 'chopWood', 3); } catch (e) { prog(`prepNether: wood buffer err ${e.message}`); }
        }
        // 4) placed-kit self-heal — 状态池版 (用户实拍怒斥满地工作台):
        //    a. 顺手收: 状态池里 10 格内的站点,背包又缺这类 → 收回+注销 (路过即清)
        //    b. 造新门控: 池里 24 格内已有登记站点就不再造新的 (achieve 的 placeTable 会走过去用)
        const stF2 = path.resolve(process.cwd(), 'bots', '_supervisor', 'stations.json');
        const stAll = (() => { try { const a = JSON.parse(fs.readFileSync(stF2, 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } })();
        const stNear = (type, maxD) => { const me = bot.entity.position; let bd = maxD, bs = null; for (const s of stAll) { if (s.type !== type) continue; const dd = Math.hypot(s.x - me.x, s.y - me.y, s.z - me.z); if (dd < bd) { bd = dd; bs = s; } } return bs; };
        for (const ty of ['crafting_table', 'furnace']) {
            const near = stNear(ty, 8);
            // 无条件回收 (40min登记6台0回收的教训: 背包常备一张→"缺了才收"永远不触发,
            // 地上的台子只进池不出池). 路过8格内就收 — 同类堆叠不占格,台子回家才是家当。
            if (near && !bot.interrupt_code) {
                prog(`prepNether: KIT — 顺手收 ${ty} @${near.x},${near.y},${near.z}`);
                try { await skills.goToPosition(bot, near.x, near.y, near.z, 2); } catch (e) {}
                try { await skills.collectBlock(bot, ty, 1); } catch (e) {}
                try {
                    const still = bot.blockAt(new Vec3(near.x, near.y, near.z));
                    if (!still || still.name !== ty) fs.writeFileSync(stF2, JSON.stringify(stAll.filter(s => !(s.type === ty && s.x === near.x && s.y === near.y && s.z === near.z))));
                } catch (e) {}
            }
        }
        if (cnt('crafting_table') === 0 && !stNear('crafting_table', 24)) { try { await skills.customSkill(bot, 'achieve', { item: 'crafting_table', count: 1 }); } catch (e) {} }
        if (cnt('furnace') === 0 && cnt('cobblestone') >= 8 && !stNear('furnace', 24)) { try { await skills.customSkill(bot, 'achieve', { item: 'furnace', count: 1 }); } catch (e) {} }
        // 5) 桶生命周期 (用户: 自主规划何时造桶/何时顺手接水 — MLG 反射没弹药就是摆设):
        //    造桶: 铁器时代确立(有铁镐)且能匀出 3 锭 → 桶是常备 kit,不再只靠摔死后的创伤记忆。
        if (cnt('bucket') === 0 && cnt('water_bucket') === 0 && cnt('iron_pickaxe') > 0 && cnt('iron_ingot') >= 3) {
            prog('prepNether: KIT — iron tier secured → crafting bucket (MLG ammo)');
            try { await skills.customSkill(bot, 'achieve', { item: 'bucket', count: 1 }); } catch (e) {}
        }
        // 6) ★床不过夜 (痛: 辛苦做的床被收进背包,没等到安家窗口就随尸沉进峡谷): a bed in
        //    the BAG is a bed at RISK — re-anchor it NOW, every boundary, regardless of the
        //    day+calm gate (placing takes 2s; setBed handles place+activate+bed.json).
        try {
            const bedItem = bot.inventory.items().find(i => /_bed$/.test(i.name));
            if (bedItem) {
                prog(`prepNether: KIT — bed in bag (${bedItem.name}) → emergency re-anchor via setBed`);
                try { await skills.customSkill(bot, 'setBed'); } catch (e) { prog(`prepNether: re-anchor err ${e.message}`); }
            }
        } catch (e) {}
        //    接水: 空桶在手 + 12 格内有水 + 同层(不为接水下崖) + 白天 → 顺手接满。
        //    "要用时没水,不要时遍地是水" — 路过就接是人类的肌肉记忆。
        if (cnt('bucket') > 0 && cnt('water_bucket') === 0 && !isNightNow()) {
            try {
                const water = world.getNearestBlock(bot, 'water', 12);
                if (water && Math.abs(water.position.y - bot.entity.position.y) <= 4) {
                    prog('prepNether: KIT — 顺手接水 (filling MLG bucket)');
                    await skills.goToPosition(bot, water.position.x, water.position.y + 1, water.position.z, 1);
                    const emptyB = bot.inventory.items().find(i => i.name === 'bucket');
                    if (emptyB) { try { await bot.equip(emptyB, 'hand'); } catch (e) {} try { await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true); } catch (e) {} try { bot.activateItem(); } catch (e) {} }
                    prog(`prepNether: water_bucket=${cnt('water_bucket')}`);
                }
            } catch (e) {}
        }
    };
    const famineCritical = () => famineBudget();
    const lowFoodHostileStaticWeapon = async (phase) => {
        try {
            const hasSword = Object.keys(world.getInventoryCounts(bot)).some(n => /_sword$/.test(n) && has(n) > 0);
            if (hasSword || isNightNow() || hasEdible() || bot.food > 8 || hostilesNear(10) < 1) return false;
            return await nightBunkerStaticWeapon({ allowDaySingleSpider: true, reason: `${phase} low-food hostile-lock` });
        } catch (e) {
            prog(`prepNether: low-food hostile static weapon err ${e.message}`);
            return false;
        }
    };

    // ★死亡不清零: once we've earned a KEY piece of gear (shield / diamond_sword), bank a
    // copy so a death doesn't reset us to naked (bankRecover withdraws it next life). Gated to
    // fire AT MOST ONCE per prepNether run (banked flag) — banking is a detour, so we don't
    // want it after every goal stalling the grind. bankGear self-guards (anchor/safe/has-spares).
    let banked = false;
    const ironPlusPick = () => has('iron_pickaxe') > 0 || has('diamond_pickaxe') > 0 || has('netherite_pickaxe') > 0;
    const undergroundWorksite = () => {
        return tableRecoveryUndergroundWorksite();
    };
    const diamondCost = (name) => ({
        diamond_sword: 2,
        diamond_chestplate: 8,
        diamond_leggings: 7,
        diamond_helmet: 5,
        diamond_boots: 4,
        diamond_pickaxe: 3,
    })[name] || 0;
    const ironDependentGoal = (name) => /^(shield|iron_pickaxe|diamond_|flint_and_steel|obsidian)/.test(name || '');
    const deathZoneMiningBlocked = () => {
        const until = Number(bot._achieveDZMiningBlockedUntil || 0);
        if (!until || Date.now() >= until) return null;
        return bot._achieveDZMiningBlocked || { until };
    };
    const ironProbeCoolingDown = () => {
        try {
            const now = Date.now();
            const state = bot._achieveProbeState || {};
            let best = null;
            for (const [key, st] of Object.entries(state)) {
                if (!/iron_ore|raw_iron|iron_ingot/.test(key)) continue;
                const until = Number(st && st.blockedUntil || 0);
                if (!until || until <= now) continue;
                if (!best || until > best.until) best = { key, until, reason: st.cooldownReason || 'probe-budget' };
            }
            return best;
        } catch (e) { return null; }
    };
    for (const g of goals) {
        if (cancelRequested()) {
            prog('prepNether: supervisor cancel observed — returning');
            return false;
        }
        if (/^diamond_/.test(g.item) && !ironPlusPick() && has('diamond') < diamondCost(g.item)) {
            prog(`prepNether: hold ${g.item} — no iron+ pickaxe and diamonds=${has('diamond')}; finish iron tier before diamond gear`);
            return false;
        }
        if (g.item === 'shield' && has('shield') < g.count && undergroundWorksite() && (has('iron_ingot') < 1 || planksEqHeld() < 6)) {
            prog(`prepNether: defer shield — underground/enclosed y=${Math.floor(bot.entity.position.y)} iron=${has('iron_ingot')} planksEq=${planksEqHeld()}; don't surface/climb for optional shield parts`);
            continue;
        }
        const dzBlockTop = deathZoneMiningBlocked();
        if (dzBlockTop && ironDependentGoal(g.item) && has(g.item) < g.count && has('iron_ingot') < 1 && has('raw_iron') < 1) {
            const wait = Math.max(0, Math.ceil(((dzBlockTop.until || bot._achieveDZMiningBlockedUntil) - Date.now()) / 1000));
            prog(`prepNether: death-zone mining cooldown after ${dzBlockTop.block || 'ore'} repeat=${dzBlockTop.repeats || '?'}; yield ${wait}s before iron-dependent goal ${g.item}`);
            return false;
        }
        const probeBlockTop = ironProbeCoolingDown();
        if (probeBlockTop && ironDependentGoal(g.item) && has(g.item) < g.count && has('iron_ingot') < 1 && has('raw_iron') < 1) {
            const wait = Math.max(0, Math.ceil((probeBlockTop.until - Date.now()) / 1000));
            prog(`prepNether: iron probe cooldown ${probeBlockTop.key} (${probeBlockTop.reason}); yield ${wait}s before iron-dependent goal ${g.item}`);
            return false;
        }
        if (await handleTableRecoveryBlocked(g.item)) return false;
        if (await holeUpAtNight() === false) return false;   // work by day, hide by night — don't grind exposed in the dark
        await tryHome();   // keep planting the home bed in any safe window (no-op once set) — top priority
        await famineStaticKit();
        await lowFoodHostileStaticWeapon(`before ${g.item}`);
        await stockTorches();   // light the mines before deep diamond runs — kills the cave-mob swarm deaths
        if (famineCritical()) {
            if (daylightFamineForageWindow() && (!bot._lastPrepFamineForageAt || Date.now() - bot._lastPrepFamineForageAt > 60000)) {
                bot._lastPrepFamineForageAt = Date.now();
                prog(`prepNether: FAMINE daylight forage window before ${g.item} — hp=${Math.round(bot.health)} food=${bot.food}; hand body to keepFed/feedUp once`);
                if (await keepFed() === false) return false;
            } else {
                prog(`prepNether: FAMINE gate — no edible food and food=${bot.food}, hp=${Math.round(bot.health)}; yield before kit goal ${g.item} (night=${isNight()} hostiles10=${hostilesNear(10)} hostiles16=${hostilesNear(16)} secured=${bodyBudgetBunkerHold() && (coveredAboveNow() || containedMobilityNow())})`);
                return false;
            }
            if (famineCritical()) {
                prog(`prepNether: FAMINE gate — forage pulse did not recover food before ${g.item}; hold body`);
                return false;
            }
        }
        if (await keepFed() === false) return false;   // food<18=no regen — eat held food / surface-hunt before the next dive
        await keepKit();   // 家当自愈: replace lost furnace/table/pickaxe from cobble stock
        let tries = 0;
        while (has(g.item) < g.count && tries++ < 3) {
            if (cancelRequested()) {
                prog(`prepNether: supervisor cancel observed mid-${g.item} — returning`);
                return false;
            }
            if (await handleTableRecoveryBlocked(g.item)) return false;
            if (await holeUpAtNight() === false) return false;   // if night fell mid-goal, stop and hole up before continuing
            await tryHome();   // ALSO try the bed on every dawn-surfacing mid-goal — else a long
                               // stuck goal (deep naked trough) starves the bed mission, which
                               // only fired once per goal at the top. Self-gated → cheap no-op.
            await famineStaticKit();
            await lowFoodHostileStaticWeapon(`mid ${g.item}`);
            if (famineCritical()) {
                if (daylightFamineForageWindow() && (!bot._lastPrepFamineForageAt || Date.now() - bot._lastPrepFamineForageAt > 60000)) {
                    bot._lastPrepFamineForageAt = Date.now();
                    prog(`prepNether: FAMINE daylight forage window mid-${g.item} — hp=${Math.round(bot.health)} food=${bot.food}; hand body to keepFed/feedUp once`);
                    if (await keepFed() === false) return false;
                } else {
                    prog(`prepNether: FAMINE gate mid-goal — no edible food and food=${bot.food}, hp=${Math.round(bot.health)}; stop ${g.item} (night=${isNight()} hostiles10=${hostilesNear(10)} hostiles16=${hostilesNear(16)} secured=${bodyBudgetBunkerHold() && (coveredAboveNow() || containedMobilityNow())})`);
                    return false;
                }
                if (famineCritical()) {
                    prog(`prepNether: FAMINE gate mid-goal — forage pulse did not recover food for ${g.item}; hold body`);
                    return false;
                }
            }
            if (await keepFed() === false) return false;   // and keep the hunger floor mid-goal too (a single achieve goal
                               // can grind underground for an hour — between-goal checks miss it)
            const dzBlockMid = deathZoneMiningBlocked();
            if (dzBlockMid && ironDependentGoal(g.item) && has(g.item) < g.count && has('iron_ingot') < 1 && has('raw_iron') < 1) {
                const wait = Math.max(0, Math.ceil(((dzBlockMid.until || bot._achieveDZMiningBlockedUntil) - Date.now()) / 1000));
                prog(`prepNether: death-zone mining cooldown mid-${g.item} after ${dzBlockMid.block || 'ore'} repeat=${dzBlockMid.repeats || '?'}; yield ${wait}s`);
                return false;
            }
            const probeBlockMid = ironProbeCoolingDown();
            if (probeBlockMid && ironDependentGoal(g.item) && has(g.item) < g.count && has('iron_ingot') < 1 && has('raw_iron') < 1) {
                const wait = Math.max(0, Math.ceil((probeBlockMid.until - Date.now()) / 1000));
                prog(`prepNether: iron probe cooldown mid-${g.item} ${probeBlockMid.key} (${probeBlockMid.reason}); yield ${wait}s`);
                return false;
            }
            if (bot.interrupt_code) try { bot.interrupt_code = false; } catch (e) {}
            prog(`prepNether: need ${g.item} ${has(g.item)}/${g.count} (try ${tries})`);
            try { await skills.customSkill(bot, 'achieve', g); }
            catch (e) { prog(`prepNether: ${g.item} threw ${e.message}`); }
            if (has(g.item) < g.count) await skills.wait(bot, 3000);
        }
        if (/helmet|chestplate|leggings|boots/.test(g.item)) await equipArmor();
        prog(`prepNether: ${g.item} -> ${has(g.item)}/${g.count}`);
        // After a KEY piece lands (shield or the diamond sword), bank a copy once so death
        // doesn't wipe the investment. bankGear no-ops if there's nothing spare/no anchor/unsafe.
        if (!banked && /^(shield|diamond_sword)$/.test(g.item) && has(g.item) >= g.count && !bot.interrupt_code) {
            prog(`prepNether: key gear ${g.item} secured — banking a copy (death-proof)`);
            try { await skills.customSkill(bot, 'bankGear'); banked = true; } catch (e) { prog(`prepNether: bankGear threw ${e.message}`); }
        }
    }
    await equipArmor();
    const summary = goals.map(g => `${g.item}=${has(g.item)}`).join(' ');
    prog(`==== prepNether DONE | ${summary} ====`);
    log(bot, `prepNether done. ${summary}`);
    return goals.every(g => has(g.item) >= g.count);
}
