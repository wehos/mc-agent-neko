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

    // ---- FAST x-ray mining. collectBlock locates+paths+vein-follows the nearest
    // diamond within 64; the survival modes deal with any mobs/water en route. ----
    // BANK-AWARE mining: deposit each haul into the persistent chest so a later
    // death can't erase progress; keep diving until chest + inventory >= count, then
    // withdraw enough to craft. (death drops only what we carry, not the chest.)
    let g2 = 0;
    let banked = await skills.customSkill(bot, 'diamondBank', 'count').catch(() => 0);
    const bankedAtEntry = banked;
    while ((banked + dia()) < count && g2++ < 10) {
        if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} } // a mode acted — resume
        // ★Re-check the pickaxe mid-mining: it can break (durability) or be lost to a death+
        // respawn while this loop runs. Keep digging the diamond layer pickaxe-less = useless.
        if (!hasIronPick()) { log(bot, '⛏️ pickaxe gone mid-dive — stop mining (achieve re-acquires).'); break; }
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
            // nothing in x-ray range — tunnel to expose fresh ground, then search again
            try { await skills.customSkill(bot, 'branchMine', 16); }
            catch (e) { try { await skills.digDown(bot, 6); } catch (e2) {} }
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
