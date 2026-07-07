// Hot-reloadable REAL skill: mine diamonds FAST via the bot's x-ray (collectBlock
// finds the nearest diamond ore within 64 and pathfinds+vein-follows to it), and
// rely on the now-capable SURVIVAL MODES to stay alive during the exposure:
//   - self_defense -> shieldFight: closes on skeletons under a raised shield, kills
//   - self_preservation -> drowning escape-up / flee when truly outmatched
// The fully-sealed strip-mine kept the bot alive but was far too slow (0 diamonds in
// 8 min). With real combat/escape instincts we can afford the fast, exposed mining.
// Descent is WATER-AWARE (see below): seals side aquifers as it goes so the shaft
// never floods, and dodges water/lava in the downward path. Invoked: {"skill":"mineDiamonds",[3]}
// ctx = { skills, world, mc, Vec3, log }
const OPEN = new Set(['air', 'cave_air', 'void_air', 'water', 'flowing_water', 'lava', 'flowing_lava']);
const WATER = new Set(['water', 'flowing_water']);
const LAVA = new Set(['lava', 'flowing_lava']);
const FILLER = ['cobblestone', 'cobbled_deepslate', 'tuff', 'andesite', 'diorite', 'granite', 'dirt', 'stone'];
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export default async function mineDiamonds(bot, ctx, count = 3) {
    const { skills, world, Vec3, log } = ctx;
    const yNow = () => Math.floor(bot.entity.position.y);
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const dia = () => has('diamond');
    const blk = (c) => bot.blockAt(c);
    const isOpen = (c) => { const b = blk(c); return !b || OPEN.has(b.name); };
    const filler = () => FILLER.find(b => has(b) > 0);

    if (bot.armorManager) try { await bot.armorManager.equipAll(); } catch (e) {}

    // ★PICKAXE GUARD (用户: "铁镐掉了还往钻石层挖"). Diamond ore ONLY drops for an iron+ pickaxe.
    // If we lost ours (death dropped it / durability ran out), descending + mining the diamond
    // layer is pure waste — ore won't drop, we just burn time and HP. BAIL immediately so the
    // caller (achieve diamond branch) re-acquires a pickaxe before re-diving. Never mine the
    // diamond layer pickaxe-less.
    const hasIronPick = () => { const c = world.getInventoryCounts(bot); return Object.keys(c).some(n => /^(iron|diamond|netherite)_pickaxe$/.test(n) && c[n] > 0); };
    // ★Zero-progress exit MUST be false (kernel-contract audit 2026-07-02). This guard used to
    // `return dia()` — the stale held stock. On the kernel path (GET_DIAMOND commits, then the
    // lone pick breaks) the commitment survives the closed hasIronTierPick proposal gate via the
    // '(holding commitment)' fallback, so the guard re-fired every ~2s and the truthy (or 0 —
    // kernel counts failure only on `=== false`) return reset the dispatch-failure counter:
    // unbreakable hot livelock, the 3-strike cooldown never tripped. The "achieve re-acquires"
    // assumption only holds on the sub-skill path (achieve ignores our return anyway); the
    // kernel needs a strike here so the cooldown releases the kind for pick re-acquisition.
    if (!hasIronPick()) { log(bot, '⛏️ mineDiamonds ABORT — no iron+ pickaxe (lost it?). Can\'t harvest diamond; failing dispatch so the kind cools down and a pick gets re-acquired.'); return false; }
    // ★2026-07-06 孤镐护航闸 (两次实弹各烧一把铁镐): 只有铁镐没有石镐时, ~60 格下潜把
    //   铁镐耗死在石头上, 钻矿都没摸到 — equipForBlock 需要包里有石镐才护得住铁镐。
    //   诚实 false → 供应链先补石镐(REPLENISH ⓪.5/TOOL_UPKEEP), 铁镐只碰钻矿。
    const stonePicksCt = (() => { try { return bot.inventory.items().filter(i => i.name === 'stone_pickaxe').length; } catch (e) { return 0; } })();
    if (stonePicksCt === 0) { log(bot, '⛏️ mineDiamonds DEFER — 无石镐护航(孤铁镐下潜=烧死在石头上), 先补石镐再潜'); return false; }

    // ★PICK-RUNWAY GUARD (shared predicate skills.pickRunway — see skills.js). hasIronPick above
    // is the AFTER-the-fact check (pick already gone/lost); this is the BEFORE check: the LAST
    // pick is nearly dead and we can't field-craft a replacement (cobble+wood on hand), so digging
    // deeper only strands us pickless at depth (live 2026-07-02: achieve's xray staircase ground
    // the lone pick to dust underground at night). Checked at both dig-loop heads below.
    // Return contract on guard exit: truthy (this file's diamond-count shape) ONLY when THIS
    // dispatch actually gained diamonds (in hand or banked); zero progress returns false so the
    // kernel dispatch-cooldown engages. NEVER the stale held/banked stock count.
    const pickRunwayStop = () => {
        try {
            if (typeof skills.pickRunway !== 'function') return null;   // predicate not deployed → fail open
            const rw = skills.pickRunway(bot);
            return (rw && rw.aboutToBreak && !rw.canFieldCraftPick)
                ? `pick about to break (usesLeft=${rw.bestUsesLeft} tier=${rw.bestTier}) + no field recraft`
                : null;
        } catch (e) { return null; }   // a guard bug must never block mining → fail open
    };
    const diaAtEntry = dia();

    // GET OUT OF WATER FIRST. In a jungle/lake biome the dive often STARTS in surface
    // water; the water-aware descent can't seat a dry shaft there, so digDown just floods
    // and the drowning-escape mode fires every tick, pinning the bot at the surface
    // ("Drowning — escaping up!" looping forever, no descent). Relocate to a dry standing
    // spot (solid top + 2 air above, no water) before descending.
    const WATERY = new Set(['water', 'flowing_water']);
    const inWater = () => [bot.entity.position, bot.entity.position.offset(0, 1, 0), bot.entity.position.offset(0, -1, 0)]
        .some(c => { const b = blk(c); return b && WATERY.has(b.name); });
    // ★2026-07-07 用户令 "1铁镐可下地, 但边挖边补镐": 下矿途中【就地(不上浮)】把顺路挖到的铁转成
    // 备用铁镐, 让唯一能挖钻的镐永远有替补(石镐挖不了钻矿)。触发(用户定 2 选 1): (a)最好那把铁镐
    // 耐久<50% 且够料造≥1把; (b)已攒够 2 把镐的料(铁单位≥6)。每次开造尽量多造, 上限 3 把新镐, 且
    // 不超过 tier 目标 4 把(spec-pickaxe-stockpile)。就地链: smeltSafe 自放炉冶炼 raw_iron→锭,
    // craftRecipeLocal 自放台锻 iron_pickaxe(二者本就自带炉/台回收, 不喂幽灵设施, 不上浮)。安全:
    // 冶炼+锻造要静止 ~30s+ → 战斗/低血/水下/近怪 不开工; 60s 节流; 永不 throw, 失败不中断下潜。
    const IRON_PICK_TARGET = 4;
    // ★节流状态挂 bot(非函数局部): mineDiamonds 每次重派都新建闭包, 局部 var 会归 0 → 60s 节流
    // 跨派发失效, 每趟首次必补(~20-30s 冻结)。挂 bot._lastPickCraftAt 让节流真正跨派发生效。
    const HOSTILE_NEAR_CRAFT = /zombie|skeleton|creeper|spider|witch|enderman|drowned|husk|stray|slime|silverfish|cave_spider|warden|phantom|pillager|vindicator/i;
    const hostileNearCraft = (r = 10) => { try { return Object.values(bot.entities).some(e => e && e.position && e.name && HOSTILE_NEAR_CRAFT.test(e.name) && e.position.distanceTo(bot.entity.position) < r); } catch (e) { return false; } };
    const maybeReplenishIronPick = async () => {
        try {
            const now = Date.now();
            if (now - (bot._lastPickCraftAt || 0) < 60000) return false;   // 60s 节流(跨派发)
            if (bot.interrupt_code) return false;
            const rawIron = has('raw_iron'), ingots = has('iron_ingot');
            const ironUnits = rawIron + ingots;                  // 每把 iron_pickaxe = 3 铁单位 + 2 棍
            const sticks = has('stick');
            const cobble = has('cobblestone') + has('cobbled_deepslate');
            const ironPicks = (() => { try { return bot.inventory.items().filter(i => i.name === 'iron_pickaxe'); } catch (e) { return []; } })();
            const effIronPicks = ironPicks.length;
            if (effIronPicks >= IRON_PICK_TARGET) return false;   // 已到囤镐目标, 别无限冶炼
            const affordable = Math.min(Math.floor(ironUnits / 3), Math.floor(sticks / 2));
            if (affordable < 1) return false;                     // 连一把料都不够
            const remainPct = (i) => { const m = i.maxDurability || 0, u = (typeof i.durabilityUsed === 'number') ? i.durabilityUsed : 0; return m > 0 ? (m - u) / m : 1; };
            const bestPct = effIronPicks ? Math.max(...ironPicks.map(remainPct)) : 0;
            const lowDura = bestPct < 0.5 && affordable >= 1;     // 触发 (a)
            const stockpiled = affordable >= 2;                   // 触发 (b): 攒够 2 把料
            if (!lowDura && !stockpiled) return false;
            const picksToMake = Math.min(3, affordable, IRON_PICK_TARGET - effIronPicks);
            if (picksToMake < 1) return false;
            const needIngots = 3 * picksToMake;
            // 就地前置: 若需冶炼(锭不够), 必须能自放炉(有炉物品或够 8 cobble) 且有燃料(煤/木炭);
            // 备不出炉或没燃料就本轮不补(留给上浮补给链兜底), 免空转烧 60s 节流槽。
            const fuel = has('coal') + has('charcoal');
            if (needIngots > ingots && rawIron > 0 && (fuel < 1 || (has('furnace') < 1 && cobble < 8))) return false;
            // 锻造前置: iron_pickaxe 需 3x3 工作台 — 身上有随身台或邻近有台才开工(craftRecipeLocal
            // 会自放随身台+回收), 无台就本轮不补, 免白烧节流槽。
            const tableOk = has('crafting_table') >= 1 || (() => { try { return !!world.getNearestBlock(bot, 'crafting_table', 4); } catch (e) { return false; } })();
            if (!tableOk) return false;
            // 安全闸: 冶炼+锻造全程静止, 别在战斗/低血/水下/近怪时开工
            if ((bot.health || 20) < 12) return false;
            if (inWater()) return false;
            if (hostileNearCraft(10)) return false;
            bot._lastPickCraftAt = now;   // 先占坑防重入(即便本轮部分失败也隔 60s 再试, 跨派发)
            log(bot, `⛏️边挖边补镐: 触发=${lowDura ? '耐久' + Math.round(bestPct * 100) + '%' : '囤料'} 铁镐${effIronPicks}/${IRON_PICK_TARGET} 铁单位${ironUnits}(raw${rawIron}+锭${ingots}) 棍${sticks} → 就地造≤${picksToMake}把 y=${yNow()}`);
            try { bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop(); } catch (e) {}
            try { bot.clearControlStates(); } catch (e) {}
            // ① 冶炼: 补足锻造所需铁锭
            if (needIngots > has('iron_ingot') && has('raw_iron') > 0) {
                const smeltN = Math.min(has('raw_iron'), needIngots - has('iron_ingot'));
                try { await skills.customSkill(bot, 'smeltSafe', 'raw_iron', smeltN); }
                catch (e) { log(bot, `⛏️边挖边补镐: 冶炼 err ${e && e.message}`); }
            }
            if (bot.interrupt_code) return false;
            // ② 锻造: 按【冶炼后实际锭/棍】收敛把数, 就地自放台
            const makeNow = Math.min(picksToMake, Math.floor(has('iron_ingot') / 3), Math.floor(has('stick') / 2));
            if (makeNow < 1) { log(bot, `⛏️边挖边补镐: 冶炼后锭仍不足(锭${has('iron_ingot')}) → 本轮跳过锻造`); return false; }
            const before = (() => { try { return bot.inventory.items().filter(i => i.name === 'iron_pickaxe').length; } catch (e) { return effIronPicks; } })();
            try { await skills.craftRecipeLocal(bot, 'iron_pickaxe', makeNow); }
            catch (e) { try { await skills.craftRecipe(bot, 'iron_pickaxe', makeNow); } catch (e2) { log(bot, `⛏️边挖边补镐: 锻造 err ${e2 && e2.message}`); } }
            const after = (() => { try { return bot.inventory.items().filter(i => i.name === 'iron_pickaxe').length; } catch (e) { return before; } })();
            log(bot, `⛏️边挖边补镐: 就地锻造 铁镐 ${before}→${after} (本轮拟造 ${makeNow}) y=${yNow()}`);
            return after > before;
        } catch (e) { return false; }
    };
    const toDryLand = async () => {
        for (let r = 0; r < 6 && inWater(); r++) {
            const p = bot.entity.position.floored();
            let best = null, bd = 1e9;
            for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
                const x = p.x + dx, z = p.z + dz;
                for (let y = p.y + 5; y >= p.y - 6; y--) {
                    const g = blk(new Vec3(x, y, z));
                    if (!g || g.boundingBox !== 'block' || WATERY.has(g.name)) continue;
                    const a1 = blk(new Vec3(x, y + 1, z)), a2 = blk(new Vec3(x, y + 2, z));
                    if (a1 && a2 && OPEN.has(a1.name) && OPEN.has(a2.name) && !WATERY.has(a1.name) && !WATERY.has(a2.name)) {
                        const d = dx * dx + dz * dz;
                        if (d > 1 && d < bd) { bd = d; best = { x, y: y + 1, z }; }
                    }
                    break; // first solid from top at this column
                }
            }
            if (best) { await skills.goToPosition(bot, best.x + 0.5, best.y, best.z + 0.5, 1).catch(() => {}); }
            else { await skills.moveAway(bot, 10).catch(() => {}); }
        }
        log(bot, `toDryLand: inWater=${inWater()} y=${yNow()}`);
    };
    await toDryLand();

    // ★2026-07-05 用户令2: 全图挂锁定最近钻石 — ore-oracle (region 离线扫描, 只读世界文件)
    // 给出真·最近钻石坐标; 先地表走到目标柱再下潜, 井底即矿脉 (盲扫 y-52 时代结束)。
    // oracle 缺失/过期(>10min) → 原路径不变。顺路矿由原有 ore-chase 覆盖 (用户: 顺路的可以挖)。
    let oracleDia = null;
    try {
        const oo = bot._world && bot._world.oracleOres;
        if (oo && Array.isArray(oo.diamonds) && oo.diamonds.length && Date.now() - (oo.ts || 0) < 600000) {
            const p0 = bot.entity.position;
            const tgt = oo.diamonds[0];
            const dxz = Math.hypot(tgt.x - p0.x, tgt.z - p0.z);
            if (dxz < 250) {
                oracleDia = tgt;
                log(bot, `⛏️ ORACLE 钻石锁定 @${tgt.x},${tgt.y},${tgt.z} (平距 ${Math.round(dxz)}b, 库存告示 ${oo.totalFound} 颗) — 直奔目标柱`);
                if (dxz > 8) {
                    await Promise.race([
                        skills.goToPosition(bot, tgt.x, null, tgt.z, 6),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('oracle-walk-timeout')), 90000)),
                    ]).catch(() => { try { bot.pathfinder.stop(); } catch (e) {} try { bot.clearControlStates(); } catch (e) {} });
                }
            }
        }
    } catch (e) {}

    const lightUp = async () => { if (has('torch') > 0) { const p = bot.entity.position; try { await skills.placeBlock(bot, 'torch', p.x, p.y, p.z, 'bottom', true); } catch (e) {} } };
    const sealCell = async (c) => { if (isOpen(c)) { const f = filler(); if (f) { try { await skills.placeBlock(bot, f, c.x, c.y, c.z, 'bottom', true); } catch (e) {} } } };

    // ---- WATER-AWARE descent. Straight-down digDown is fast in dry stone but DROWNS
    // the bot when the 1x1 shaft punches past a deepslate aquifer: water floods in from
    // the SIDES (digDown only checks straight down), the bot is trapped ~100 blocks
    // under the surface, and oxygen runs out long before it can climb back up — the
    // escape-up safety net is hopeless from that depth. So PREVENT flooding: before
    // opening each chunk, seal any water/lava in the side walls of the column we're
    // about to expose. If water/lava is directly in the downward path, don't punch
    // through it — tunnel sideways to dodge the aquifer (the real-player move), then
    // resume digging down on dry ground. Lava below = stop and mine from here.
    // ★oracle 目标深度: 锁定钻石时下潜到其 y-1 即停 (y=9 的脉不必凿到 -52); 否则默认带底。
    const TARGET_Y = (typeof oracleDia === 'object' && oracleDia && Number.isFinite(oracleDia.y)) ? Math.min(oracleDia.y - 1, 16) : -52;

    // Seal water/lava in the 4 side walls at a single y-level the bot can currently
    // REACH (it must be standing adjacent — you can't place a block against a face
    // walled off by un-dug stone). Cheap when dry (just blockAt checks); only places
    // filler where a hazard actually touches the shaft, so it stays fast in plain rock.
    const sealLevel = async (y) => {
        const p = bot.entity.position.floored();
        for (const [dx, dz] of SIDES) {
            const c = new Vec3(p.x + dx, y, p.z + dz);
            const b = blk(c);
            if (b && (WATER.has(b.name) || LAVA.has(b.name))) {
                const f = filler();
                if (f) { try { await skills.placeBlock(bot, f, c.x, c.y, c.z, 'bottom', true); } catch (e) {} }
            }
        }
    };
    // Dig a short 1x2 horizontal tunnel to step off an aquifer/lava column onto dry
    // ground, sealing any water exposed and laying a floor so we don't drop. Returns
    // true if we managed to move to a new x,z.
    const tunnelAside = async () => {
        for (const [dx, dz] of SIDES) {
            const p0 = bot.entity.position.floored();
            const ahead = blk(new Vec3(p0.x + dx, p0.y, p0.z + dz));
            if (ahead && LAVA.has(ahead.name)) continue; // never walk into lava
            for (let step = 1; step <= 3; step++) {
                const p = bot.entity.position.floored();
                await sealLevel(p.y); await sealLevel(p.y + 1);
                const feet = new Vec3(p.x + dx, p.y, p.z + dz);
                const head = new Vec3(p.x + dx, p.y + 1, p.z + dz);
                for (const cell of [head, feet]) {
                    const b = blk(cell);
                    if (b && !OPEN.has(b.name)) { await skills.breakBlockAt(bot, cell.x, cell.y, cell.z).catch(() => {}); }
                }
                const floor = new Vec3(p.x + dx, p.y - 1, p.z + dz);
                const fb = blk(floor);
                if (fb && OPEN.has(fb.name)) { const f = filler(); if (f) { await skills.placeBlock(bot, f, floor.x, floor.y, floor.z, 'bottom', true).catch(() => {}); } }
                await skills.goToPosition(bot, p.x + dx, p.y, p.z + dz, 0).catch(() => {});
            }
            return true;
        }
        return false;
    };

    // Descend ONE block at a time, sealing the walls of the level we stand in BEFORE
    // digging deeper. This walls off side aquifers while we can still reach them, so
    // the shaft never floods. Water/lava directly below -> dodge sideways instead of
    // punching through. ~1 dig per level: fast in dry stone, only slows near hazards.
    let guard = 0, stalls = 0, drownStrikes = 0;
    while (yNow() > TARGET_Y && guard++ < 250) {
        if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} }
        // ★边挖边补镐 (用户令): BEFORE the pick-runway abort — a dying lone pick with iron on hand
        // should be replenished in place, not force a climb-out. Crafts a fresh iron pick so the
        // pickRunway check below sees a healthy pick and the descent continues.
        await maybeReplenishIronPick();
        // ★PICK-RUNWAY: never dig the shaft deeper on a dying lone pick — the remaining
        // uses are the climb-out budget. Banking hasn't run yet, so in-hand delta is exact.
        const pickStop = pickRunwayStop();
        if (pickStop) { log(bot, `⛏️ ${pickStop} — stop descent at y=${yNow()}, keep the last uses to climb out`); return dia() > diaAtEntry ? dia() : false; }
        // DROWNING-AWARE DESCENT. In a water world the shaft punches into an aquifer and
        // water floods the bot's head faster than sealLevel can wall it; the
        // self_preservation mode then escapes us UP every tick while THIS loop digs back
        // DOWN — the two fight and the bot thrashes in the flood forever (alive, but never
        // reaching diamonds). So: never keep digging down while submerged. Let the
        // escape-up mode lift us clear, relocate well aside onto fresh ground, and try a
        // new column. After a few strikes, give up the vertical shaft entirely and mine
        // HORIZONTALLY from here — diamonds exist at this depth too, and x-ray collectBlock
        // reaches 64 blocks, so we don't need to win the fight with the aquifer.
        if (bot.oxygenLevel !== undefined && bot.oxygenLevel <= 10) {
            log(bot, `drowning during descent (O2=${bot.oxygenLevel}) strike ${drownStrikes + 1} y=${yNow()}`);
            for (let w = 0; w < 10 && bot.oxygenLevel !== undefined && bot.oxygenLevel < 16; w++) await new Promise(r => setTimeout(r, 300));
            // Push HARDER through aquifers before giving up. In a WATER WORLD the shallow
            // water table (y~50-60) has aquifers everywhere, so the old 3-strike give-up bailed
            // at y~40 (stone level) — never reaching the dry stone below, let alone the y-52
            // deepslate where diamonds are (the bot had 600+ cobblestone, ZERO deepslate, ZERO
            // diamonds). We never DROWN-die here (we wait for O2 to refill each strike), so it's
            // safe to persist: only abandon the shaft after 7 strikes. Below the surface table
            // it's dry stone and the descent flies.
            if (++drownStrikes >= 7) { log(bot, `too many drownings — abandoning vertical shaft, mining from y=${yNow()}`); break; }
            await skills.moveAway(bot, 6).catch(() => {});
            continue;
        }
        const feetY = Math.floor(bot.entity.position.y);
        await sealLevel(feetY); await sealLevel(feetY + 1); // wall off this level first
        const below = blk(bot.blockAt(bot.entity.position).position.offset(0, -1, 0));
        const below2 = blk(bot.blockAt(bot.entity.position).position.offset(0, -2, 0));
        if (below && (LAVA.has(below.name) || (below2 && LAVA.has(below2.name)))) {
            log(bot, `lava below at y=${feetY} — stop descent, mine here`); break;
        }
        if (below && WATER.has(below.name)) {
            log(bot, `water below at y=${feetY} — tunneling aside to dodge aquifer`);
            if (!(await tunnelAside())) { if (++stalls > 6) break; }
            continue;
        }
        const ok = await skills.digDown(bot, 1).catch(() => false);
        if (guard % 4 === 0) await lightUp();
        if (!ok || Math.floor(bot.entity.position.y) >= feetY) {
            if (!(await tunnelAside())) { await skills.moveAway(bot, 2).catch(() => {}); }
            if (Math.floor(bot.entity.position.y) >= feetY && ++stalls > 6) break;
        } else { stalls = 0; }
    }
    await lightUp();
    log(bot, `at y=${yNow()}, water-aware descent done, x-ray mining (modes handle survival)...`);

    // ── ★2026-07-06 E 直线矿透 ([[spec-pickaxe-stockpile-redesign]]): oracle 有目标且"全知前瞻"确认无坠落/
    //   无挖穿液体/无空穴/无怪时, 朝钻石直线快挖(替代盲挖 branchMine)。blockAt 读已加载区块=权威无陈旧,
    //   命中任一风险即回退谨慎路径; 有怪先绕垂直轴一步(用户令 有怪绕路), 绕不开则停交回 collectBlock。 ──
    const HOSTILE_RE = /zombie|skeleton|creeper|spider|witch|enderman|drowned|husk|stray|slime|silverfish|cave_spider|warden|phantom/i;
    const hostileNear = (r = 8) => { try { return Object.values(bot.entities).some(e => e && e.position && e.name && HOSTILE_RE.test(e.name) && e.position.distanceTo(bot.entity.position) < r); } catch (e) { return false; } };
    // 沿 (dx,dz) 主轴前瞻 n 格: 要挖的 1x2(脚+头)与脚下地板全为待挖实心、无水/岩浆、无空穴 → 安全直挖。
    const straightSafe = (dx, dz, n = 5) => {
        try {
            const p = bot.entity.position.floored();
            const px = dz, pz = dx;   // 垂直于挖掘轴的单位向量(侧壁方向)
            for (let d = 1; d <= n; d++) {
                const floor = blk(p.offset(dx * d, -1, dz * d));
                if (!floor || floor.boundingBox !== 'block' || LAVA.has(floor.name) || WATER.has(floor.name)) return false;   // 悬空/液体地板 → 坠落或涌水
                for (const dy of [0, 1]) {
                    const c = blk(p.offset(dx * d, dy, dz * d));
                    if (c && (LAVA.has(c.name) || WATER.has(c.name))) return false;   // 挖穿到液体
                    if (!c || c.boundingBox === 'empty' || OPEN.has(c.name)) return false;   // 空穴(前方已 open)
                }
                // ★review 修 (off-axis 液体涌入): 侧壁/顶/底邻格若有岩浆/水, 挖开这段走廊会被从侧面淹/烧 —
                //   补齐 digDown/blockedByLava 的 6 邻检(它们正是为"含水层从侧面涌入"而设), 有液体即拒绝直挖。
                for (const dy of [0, 1]) {
                    for (const [ox, oy, oz] of [[px, 0, pz], [-px, 0, -pz], [0, 1, 0], [0, -1, 0]]) {
                        const s = blk(p.offset(dx * d + ox, dy + oy, dz * d + oz));
                        if (s && (LAVA.has(s.name) || WATER.has(s.name))) return false;
                    }
                }
            }
            return true;
        } catch (e) { return false; }
    };
    // 朝 tgt 曼哈顿直线挖(主轴优先): 每步前瞻安全才挖 1x2 + 走进; 有怪/不安全先绕垂直轴一步, 绕不开则停。
    const straightMineToward = async (tgt, maxSteps = 20) => {
        let dug = 0;
        for (let s = 0; s < maxSteps; s++) {
            if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} }
            if (bot.death_abort || pickRunwayStop()) break;
            const p = bot.entity.position;
            const dxRaw = tgt.x - p.x, dzRaw = tgt.z - p.z;
            if (Math.hypot(dxRaw, dzRaw) < 1.5) break;   // 到达目标柱(井底即脉, collectBlock 接手)
            let dx = Math.abs(dxRaw) >= Math.abs(dzRaw) ? (Math.sign(dxRaw) || 1) : 0;
            let dz = dx ? 0 : (Math.sign(dzRaw) || 1);
            if (hostileNear(6) || !straightSafe(dx, dz, 5)) {
                const ax = dx ? 0 : (Math.sign(dxRaw) || 1), az = dx ? (Math.sign(dzRaw) || 1) : 0;   // 垂直轴绕行
                if (!(ax || az) || hostileNear(6) || !straightSafe(ax, az, 5)) break;                 // 绕不开 → 停(回退谨慎路径)
                dx = ax; dz = az;
            }
            const fp = bot.entity.position.floored();
            const feet = new Vec3(fp.x + dx, fp.y, fp.z + dz);
            const head = feet.offset(0, 1, 0);
            for (const c of [head, feet]) { const b = blk(c); if (b && !OPEN.has(b.name)) await skills.breakBlockAt(bot, c.x, c.y, c.z).catch(() => {}); }
            await Promise.race([
                skills.goToPosition(bot, feet.x + 0.5, feet.y, feet.z + 0.5, 0),
                new Promise((r) => setTimeout(r, 3000)),
            ]).catch(() => {});
            // ★review 修 (走廊侧壁封堵): 与竖井下潜同款 — 走进新格后封住脚/头两层的 4 侧壁液体
            //   (straightSafe 已挡住"挖前有液体", 这里再兜底挖后渗漏的水/砾, 远离竖井密封逃生柱时的保险)。
            try { const yf = bot.entity.position.floored().y; await sealLevel(yf); await sealLevel(yf + 1); } catch (e) {}
            dug++;
        }
        return dug;
    };
    // 当前最近的新鲜 oracle 钻石(<10min, 平距<250) — 挖矿循环重取(oracle 每 60s 重扫, 逐颗接近)。
    const freshOracleDia = () => {
        try {
            const oo = bot._world && bot._world.oracleOres;
            if (!(oo && Array.isArray(oo.diamonds) && oo.diamonds.length && Date.now() - (oo.ts || 0) < 600000)) return null;
            const p0 = bot.entity.position;
            const t = oo.diamonds[0];
            return (t && Number.isFinite(t.x) && Math.hypot(t.x - p0.x, t.z - p0.z) < 250) ? t : null;
        } catch (e) { return null; }
    };

    // ---- FAST x-ray mining. collectBlock locates+paths+vein-follows the nearest
    // diamond within 64; the survival modes deal with any mobs/water en route. ----
    // BANK-AWARE mining: deposit each haul into the persistent chest so a later
    // death can't erase progress; keep diving until chest + inventory >= count, then
    // withdraw enough to craft. (death drops only what we carry, not the chest.)
    let g2 = 0;
    // ★2026-07-06 钻石滚雪球 ([[spec-pickaxe-stockpile-redesign]]): count 可达 40(得钻镐后). 旧固定 10 轮上限
    //   会让 40 目标每次派发只挖 ~10 轮就返回, 反复 re-descend 磨镐。上限随 count 放大(封顶 24 轮/派发, 免
    //   长期霸占身体不让生存反射复评); 跨派发靠 oracle 60s 重扫更新 diamonds[0] 逐颗接近, 自然滚雪球。
    const ROUND_CAP = Math.max(10, Math.min(24, count));
    let banked = await skills.customSkill(bot, 'diamondBank', 'count').catch(() => 0);
    const bankedAtEntry = banked;
    while ((banked + dia()) < count && g2++ < ROUND_CAP) {
        if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} } // a mode acted — resume
        // ★Re-check the pickaxe mid-mining: it can break (durability) or be lost to a death+
        // respawn while this loop runs. Keep digging the diamond layer pickaxe-less = useless.
        if (!hasIronPick()) { log(bot, '⛏️ pickaxe gone mid-dive — stop mining (achieve re-acquires).'); break; }
        // ★边挖边补镐 (用户令): top up spare iron picks in place from opportunistically-mined iron
        // BEFORE the pick-runway abort, so a dying pick with material on hand restores itself and
        // mining continues instead of aborting the dive.
        await maybeReplenishIronPick();
        // ★PICK-RUNWAY: same pre-emptive stop mid-mining (collectBlock/branchMine below grind the
        // pick on stone too). Progress counts banked deposits from THIS dispatch, not the stock.
        const pickStop = pickRunwayStop();
        if (pickStop) {
            log(bot, `⛏️ ${pickStop} — stop diamond mining at y=${yNow()} (achieve re-acquires)`);
            const gained = (banked + dia()) - (bankedAtEntry + diaAtEntry);
            return gained > 0 ? (dia() || gained) : false;
        }
        await lightUp();
        const before = dia();
        await skills.collectBlock(bot, 'diamond', count).catch(e => log(bot, `collect diamond err: ${e.message}`));
        if ((banked + dia()) >= count) break;
        if (dia() === before) {
            // nothing in x-ray range — ★E 直线矿透: oracle 有新鲜目标且前瞻安全 → 朝它直线快挖; 否则盲挖 branchMine 暴露新面
            const ot = freshOracleDia();
            let straightDug = 0;
            if (ot) { try { straightDug = await straightMineToward(ot, 20); } catch (e) { straightDug = 0; } }
            if (straightDug > 0) { log(bot, `⛏️ 直线矿透 +${straightDug} 步 → oracle @${ot.x},${ot.y},${ot.z} (前瞻安全)`); }
            else {
                try { await skills.customSkill(bot, 'branchMine', 16); }
                catch (e) { try { await skills.digDown(bot, 6); } catch (e2) {} }
            }
        }
        // bank what we've mined so far so a death from here on doesn't lose it
        if (dia() > 0) { await skills.customSkill(bot, 'diamondBank', 'deposit').catch(() => {}); }
        banked = await skills.customSkill(bot, 'diamondBank', 'count').catch(() => banked);
    }
    // Pull out enough to actually craft the pickaxe.
    if (banked >= count && dia() < count) await skills.customSkill(bot, 'diamondBank', 'withdraw', count).catch(() => {});
    // ★Gain-gate the final return (kernel-contract audit 2026-07-02), same idiom as the
    // pickRunway exits above. Raw `return dia()` here leaked the stale entry stock on three
    // zero-progress routes that bypass the gated exits: (a) hasIronPick() break mid-dive,
    // (b) g2 exhausting 10 rounds with no diamond in x-ray range and branchMine gaining none,
    // (c) the 7-strike drown-abandon mining a diamond-less shallow y — each reset the kernel
    // failure counter while GET_DIAMOND stayed committed (diamondsOnHand<floor), spinning hot.
    // `dia() >= count` keeps the withdraw-only run truthy (bank→hand transfer completes the
    // goal; isGoalDone releases next tick); every no-gain exit strikes the dispatch cooldown.
    const gained = (banked + dia()) - (bankedAtEntry + diaAtEntry);
    log(bot, `mineDiamonds done. diamond=${dia()} banked=${banked} gained=${gained} y=${yNow()} hp=${Math.round(bot.health)}`);
    return (gained > 0 || dia() >= count) ? (dia() || gained) : false;
}
