// Hot-reloadable REAL skill: the missing GET_ARMOR@68 dispatch target — turn banked
// iron (raw_iron + iron_ingot) into WORN iron armor, cheapest piece first, NO cheats.
// Closes the chronic unarmored-death gap: smelt what's needed via smeltSafe (safe
// furnace placement), craft each piece via craftChain's array-preset form (safe table
// placement under canopy), then armorManager.equipAll (mineDiamonds idiom).
//
// Return contract (kernel dispatch-cooldown discipline):
//   - number of armor pieces now held+worn (>0, truthy) ONLY when THIS dispatch made
//     progress: crafted a piece, newly equipped one (worn-slot delta), or the full
//     4-piece set is now held/worn (safe: isGoalDone armor>=4 releases GET_ARMOR).
//     Count semantics match modes.js vitals.armor (held + worn both count).
//   - false on EVERY zero-progress dispatch, even with 1-3 stale pieces held — the
//     kernel counts failure only on res===false, so returning a stale held count
//     resets its 3-strike/5-min cooldown and resurrects the exact GET_ARMOR
//     dispatch-spin livelock this file exists to close (isGoalDone alone can't
//     release: ironForArmor counts raw_iron+ingot and can sit >=4 forever).
// Red lines honored: interrupt+death checked EVERY pass; no module-level state (loop
// locals only); no infinite retry (stall>=2 on the same piece → stop).
// Invoked via: {"skill":"craftArmor"}  ctx = { skills, world, mc, Vec3, log }
export default async function craftArmor(bot, ctx, opts = {}) {
    const { skills, world, log } = ctx;
    const maxMs = (opts && opts.maxMs) || 180000;
    const t0 = Date.now();
    const inv = () => world.getInventoryCounts(bot);

    // [name, ironCost] CHEAPEST-FIRST so scarce iron becomes some protection asap.
    const PIECES = [['iron_boots', 4], ['iron_helmet', 5], ['iron_leggings', 7], ['iron_chestplate', 8]];
    const ARMOR_RE = /_helmet$|_chestplate$|_leggings$|_boots$/;

    // Pieces the bot HAS. getInventoryCounts iterates ALL slots (armor 5-8 included),
    // so held AND worn both count — same semantics as modes.js vitals.armor.
    const piecesHave = () => {
        let n = 0;
        try { const c = inv(); for (const k of Object.keys(c)) if (ARMOR_RE.test(k)) n += c[k]; } catch (e) {}
        return n;
    };
    const havePiece = (name) => {
        if ((inv()[name] || 0) > 0) return true; // covers worn too, but be explicit below anyway
        try {
            const sl = bot.inventory.slots || [];
            for (let i = 5; i <= 8; i++) if (sl[i] && sl[i].name === name) return true;
        } catch (e) {}
        return false;
    };
    // Pieces actually WORN (armor slots 5-8 only). Equipping moves held→worn without
    // changing piecesHave(), so the worn delta is how we detect "newly equipped" progress.
    const wornCount = () => {
        let n = 0;
        try {
            const sl = bot.inventory.slots || [];
            for (let i = 5; i <= 8; i++) if (sl[i] && ARMOR_RE.test(sl[i].name || '')) n++;
        } catch (e) {}
        return n;
    };
    const wornAtEntry = wornCount();

    // ★2026-07-05 铁镐保留额 (实弹事故: 首批 3 锭+1 raw 被 boots(4铁)截胡 — 铁镐目标只因
    // 缺 2 根棍被跳过, 铁流进甲件, 钻石解锁被推迟一整个补给周期)。无铁镐(含更高阶)时,
    // 永久保留 3 铁给镐: 甲件预算 = 总铁 - 3。keepInventory 下裸奔多死几次是可接受消耗,
    // 晚拿钻石不是。有镐后此门自动失效, 甲件照常。
    const _hasIronPick = () => {
        try { return bot.inventory.items().some(i => /^(iron|diamond|netherite)_pickaxe$/.test(i.name)); } catch (e) { return false; }
    };
    const _ironTotal = () => (inv()['iron_ingot'] || 0) + (inv()['raw_iron'] || 0);
    const _armorIronBudget = () => _ironTotal() - (_hasIronPick() ? 0 : 3);

    let crafted = 0, stall = 0;
    for (let pass = 0; pass < 4; pass++) {
        if (bot.interrupt_code || bot.health <= 0 || Date.now() - t0 > maxMs) break;

        const target = PIECES.find(([n]) => !havePiece(n));
        if (!target) break; // full set held/worn — done
        const [piece, cost] = target;

        // ★铁镐保留额执行点: 这件甲会吃掉镐的 3 铁 → 停 (见顶部 rationale)。
        if (cost > _armorIronBudget()) {
            log(bot, `craftArmor: PICK-RESERVE gate — ${piece} costs ${cost} but armor budget is ${_armorIronBudget()} `
                + `(iron ${_ironTotal()}, no iron pick yet → 3 reserved) — stopping, iron goes to the pickaxe first.`);
            break;
        }

        // Smelt just enough for THIS piece (smeltSafe places its own furnace safely).
        const ingots = inv()['iron_ingot'] || 0;
        if (ingots < cost) {
            const need = cost - ingots;
            const raw = inv()['raw_iron'] || 0;
            if (raw > 0) {
                await skills.customSkill(bot, 'smeltSafe', 'raw_iron', Math.min(raw, need)).catch(() => {});
            } else {
                // Can't afford the next piece — stop. If nothing was crafted/equipped
                // this dispatch the return below is false → kernel 3-strike cooldown
                // frees the chain (isGoalDone can't: ironForArmor counts raw+ingot and
                // may sit >=4 while still short of the next piece's cost, e.g. 4 ingots
                // vs a 5-ingot helmet — the classic hot-spin trap).
                log(bot, `craftArmor: iron short for ${piece} (${ingots}/${cost} ingots, no raw_iron) — stopping; `
                    + (crafted > 0 ? `crafted ${crafted} this dispatch, returning progress.`
                                   : `zero crafts this dispatch → false unless equip below newly wears a piece (kernel cooldown).`));
                break;
            }
        }

        // Craft via craftChain's array-preset form (handles table placement under canopy).
        const before = inv()[piece] || 0;
        await skills.customSkill(bot, 'craftChain', [[piece, 1]]).catch(() => {});
        const after = inv()[piece] || 0;

        // NO-PROGRESS cutoff: never infinite-retry the same failing craft (red line).
        if (after > before) { crafted++; stall = 0; }
        else if (++stall >= 2) {
            log(bot, `craftArmor: no progress on ${piece} twice (smelt/craft failing) — stop, no infinite retry.`);
            break;
        }
    }

    // Equip whatever we now have (armorManager idiom from mineDiamonds:26; name-based
    // skills.equip fallback when the plugin is absent).
    if (bot.armorManager) {
        try { await bot.armorManager.equipAll(); } catch (e) {}
    } else {
        for (const it of bot.inventory.items()) {
            if (bot.interrupt_code) break;
            if (ARMOR_RE.test(it.name || '')) await skills.equip(bot, it.name).catch(() => {});
        }
    }

    const have = piecesHave();
    const newlyWorn = wornCount() - wornAtEntry;
    // Progress = crafted a piece, newly wore one, or the full set is complete (full set
    // is safe to return truthy: isGoalDone GET_ARMOR armor>=4 releases the commitment).
    // A STALE held count is NOT progress — returning it truthy resets the kernel's
    // _dispatchFails counter (only res===false counts as failure) and the 3-strike/5-min
    // cooldown never engages, hot-spinning GET_ARMOR above the whole tier chain.
    const progressed = crafted > 0 || newlyWorn > 0 || have >= 4;
    log(bot, `craftArmor done: crafted ${crafted}, newly worn ${newlyWorn > 0 ? newlyWorn : 0}, armor held+worn=${have}/4, `
        + `iron_ingot=${inv()['iron_ingot'] || 0} raw_iron=${inv()['raw_iron'] || 0} hp=${Math.round(bot.health || 0)}`
        + (progressed ? '' : ' — NO progress this dispatch → false (kernel 3-strike cooldown).'));
    return progressed ? have : false;
}
