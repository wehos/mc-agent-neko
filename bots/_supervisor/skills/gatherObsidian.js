// Hot-reloadable REAL skill: legit nether-portal kit — obsidian via the water-bucket
// lava→obsidian conversion mined with a DIAMOND pickaxe, plus flint_and_steel from
// gravel-flint + iron. No cheats. realNetherPortal only CONSUMES obsidian (aborts at
// <10), so this skill is the supply side of ENTER_NETHER.
//
// Contract (kernel counts FAILED iff the skill threw / returned false / {failed:true}):
//   - return false when THIS dispatch made zero obsidian progress (wrong dim, no
//     diamond pick, kit prereqs impossible, no lava, fruitless passes) — 3x trips
//     the 5-min kind cooldown that spaces retries.
//   - return the obsidian COUNT only when THIS dispatch mined at least one block,
//     measured against the count at entry. NEVER return the stale lifetime holdings:
//     a truthy no-op return resets the kernel fail counter and the sticky
//     GET_PORTAL_KIT commitment re-dispatches the identical fruitless run forever.
// Invoked via: {"skill":"gatherObsidian","args":[{"obsidianTarget":14,"maxMs":480000}]}
// ctx = { skills, world, mc, Vec3, log }
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const OPEN = new Set(['air', 'cave_air', 'void_air']);

export default async function gatherObsidian(bot, ctx, opts = {}) {
    const { skills, world, Vec3, log } = ctx;
    const target = (opts && opts.obsidianTarget) || 14;
    const maxMs = (opts && opts.maxMs) || 480000;
    const t0 = Date.now();
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const startObs = has('obsidian');                 // progress baseline: THIS dispatch only
    const minedThisRun = () => has('obsidian') - startObs;
    // Shared abort-path return: count only if THIS run mined something — stale
    // holdings from earlier runs are NOT progress (header contract).
    const progressOrFalse = () => (minedThisRun() > 0 ? has('obsidian') : false);
    const timeUp = () => Date.now() - t0 >= maxMs;
    const stop = () => !!bot.interrupt_code || bot.health <= 0;
    const hasDiamondPick = () => bot.inventory.items().some(i => /^(diamond|netherite)_pickaxe$/.test(i.name));
    const isLavaB = (b) => !!(b && /lava/.test(b.name));
    const isWaterB = (b) => !!(b && /water/.test(b.name));

    // ── ENTRY GATES (mineDiamonds:34 idiom — bail, don't grind uselessly). ──
    const dim = String((bot.game && bot.game.dimension) || 'overworld');
    if (/nether|end/.test(dim)) { log(bot, `gatherObsidian ABORT — wrong dimension (${dim}); water buckets need the overworld.`); return false; }
    if (!hasDiamondPick()) { log(bot, 'gatherObsidian ABORT — no diamond pickaxe; obsidian is unminable without one.'); return false; }
    // Fast kit-math gate: flint_and_steel costs 1 iron, bucket costs 3 — if the iron
    // isn't in inventory even as raw_iron, no amount of gravel digging assembles the
    // kit. Fail in <1s here (world_model's GET_PORTAL_KIT gate pre-checks iron too;
    // this is the in-skill backstop so a mis-gated dispatch never burns budget).
    const ironShort = (has('flint_and_steel') >= 1 ? 0 : 1)
        + ((has('water_bucket') >= 1 || has('bucket') >= 1) ? 0 : 3)
        - has('iron_ingot') - has('raw_iron');
    if (ironShort > 0) {
        log(bot, `gatherObsidian ABORT — kit iron short by ${ironShort} (iron_ingot=${has('iron_ingot')} raw_iron=${has('raw_iron')} bucket=${has('bucket')} flint_and_steel=${has('flint_and_steel')}) — restock iron first.`);
        return false;
    }

    // ── STEP A: flint_and_steel (skip entirely if we already carry one). ──
    if (has('flint_and_steel') < 1) {
        if (has('flint') < 1) {
            for (let digs = 0; digs < 20 && has('flint') < 1; digs++) {
                if (stop() || timeUp()) break;
                const g = await world.getNearestBlockAsync(bot, 'gravel', 64);
                if (!g) break;
                await skills.breakBlockAt(bot, g.position.x, g.position.y, g.position.z).catch(() => {});
                await skills.pickupNearbyItems(bot).catch(() => {});
                // 10%/dig flint reroll: re-place the collected gravel nearby and re-dig it.
                if (has('flint') < 1 && has('gravel') > 0) {
                    await skills.placeBlockNearby(bot, 'gravel').catch(() => {});
                }
            }
        }
        if (has('flint') >= 1) {
            if (has('iron_ingot') < 1 && has('raw_iron') > 0) {
                await skills.customSkill(bot, 'smeltSafe', 'raw_iron', 1).catch(() => {});
            }
            if (has('iron_ingot') >= 1) await skills.craftRecipe(bot, 'flint_and_steel', 1).catch(() => {});
        }
    }

    // ── STEP B: water bucket. ──
    if (has('water_bucket') < 1 && has('bucket') < 1) {
        if (has('iron_ingot') < 3 && has('raw_iron') > 0) {
            await skills.customSkill(bot, 'smeltSafe', 'raw_iron', Math.min(has('raw_iron'), 3)).catch(() => {});
        }
        if (has('iron_ingot') >= 3) await skills.craftRecipe(bot, 'bucket', 1).catch(() => {});
    }
    if (has('bucket') >= 1 && has('water_bucket') < 1) {
        // ★2026-07-05 预审 P1: 原版 32 格无水即整体 abort false, 与岩浆分支的迁移重试不对称
        // → 派发点无水 = 3-strike 冷却原地死循环。改: 与 useToolOn 的 64 格对齐 + 三段
        // 有界 moveAway 迁移 (岩浆分支同款)。
        for (let wtry = 0; wtry < 3 && has('water_bucket') < 1 && !stop() && !timeUp(); wtry++) {
            const w0 = await world.getNearestBlockAsync(bot, 'water', 64);
            if (w0) {
                await skills.goToPosition(bot, w0.position.x, w0.position.y + 1, w0.position.z, 2).catch(() => {});
                await skills.useToolOn(bot, 'bucket', 'water').catch(() => {});
                if (has('water_bucket') >= 1) break;
            }
            if (has('water_bucket') < 1) { log(bot, `gatherObsidian: no water within 64b (try ${wtry + 1}/3) — relocating 24b`); await skills.moveAway(bot, 24).catch(() => {}); }
        }
    }
    if (has('water_bucket') < 1 || has('flint_and_steel') < 1) {
        log(bot, `gatherObsidian: kit prereq missing (water_bucket=${has('water_bucket')} flint_and_steel=${has('flint_and_steel')} flint=${has('flint')} iron_ingot=${has('iron_ingot')}) — abort.`);
        return false;
    }

    // ── STEP C: lava→obsidian convert + mine loop. ──
    const lavaSides = (v) => { let n = 0; for (const [dx, dz] of SIDES) { if (isLavaB(bot.blockAt(v.offset(dx, 0, dz)))) n++; } return n; };
    const nearestLavaSource = async () => {
        // ★(0714) 岩浆源(黑曜石农场料源) — 异步化(getNearestBlocksWhereAsync/getNearestBlockAsync)防 ws 阻塞;唯一调用点在下方 async while 循环 (await)
        const bs = await world.getNearestBlocksWhereAsync(bot, (b) => b && b.name === 'lava' && b.metadata === 0, 64, 1);
        return (bs && bs.length) ? bs[0] : await world.getNearestBlockAsync(bot, 'lava', 64);
    };
    // Solid standing spot near the pool EDGE: 2 open cells above, ≤1 lava side (never
    // stand on a block bordering lava on 2+ sides), 1-4 blocks flat from the source.
    const findStand = (lp) => {
        let best = null, bd = Infinity;
        for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -1; dy <= 1; dy++) {
            const v = lp.offset(dx, dy, dz);
            const b = bot.blockAt(v);
            if (!b || b.boundingBox !== 'block' || /lava|magma/.test(b.name)) continue;
            const a1 = bot.blockAt(v.offset(0, 1, 0)), a2 = bot.blockAt(v.offset(0, 2, 0));
            if (!a1 || !a2 || !OPEN.has(a1.name) || !OPEN.has(a2.name)) continue;
            if (lavaSides(v) >= 2) continue;
            const flat = Math.hypot(v.x - lp.x, v.z - lp.z);
            if (flat < 1 || flat > 4) continue;
            const d = v.distanceTo(bot.entity.position);
            if (d < bd) { bd = d; best = v; }
        }
        return best;
    };
    // Pour the water sheet: look at the TOP face of a solid block beside the lava and
    // activate the bucket — the water spreads over the sources and freezes obsidian.
    const pour = async (lp) => {
        // NEVER pour into our own column: the eye-distance metric otherwise picks the
        // very block we STAND ON whenever it borders lava (own top face d=1.6 beats any
        // neighbor's ~1.89, and findStand allows 1 lava side), dumping the water source
        // at our feet — the outward current then shoves us toward the pool while the
        // sheet is still converting. Excluding the bot's x/z column forces a neighbor.
        const feet = bot.entity.position.floored();
        let pt = null, bd = Infinity;
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 1; dy++) {
            const v = lp.offset(dx, dy, dz);
            if (v.x === feet.x && v.z === feet.z) continue;                 // own standing column
            const b = bot.blockAt(v);
            if (!b || b.boundingBox !== 'block') continue;
            const above = bot.blockAt(v.offset(0, 1, 0));
            if (above && above.boundingBox === 'block') continue;           // need an open top face
            if (lavaSides(v) < 1 && !isLavaB(above)) continue;              // must actually border lava
            const d = v.offset(0.5, 1, 0.5).distanceTo(bot.entity.position.offset(0, 1.6, 0));
            if (d > 4.2) continue;
            if (d < bd) { bd = d; pt = v; }
        }
        if (!pt) return false;
        try { const ok = await skills.equip(bot, 'water_bucket'); if (!ok) return false; } catch (e) { return false; }
        try { await bot.lookAt(pt.offset(0.5, 1, 0.5), true); } catch (e) {}
        await skills.wait(bot, 200);
        try { bot.activateItem(); } catch (e) { return false; }
        await skills.wait(bot, 2500);                                       // let the sheet spread + convert
        return true;
    };
    // Only mine obsidian cells that are drop-safe: no lava beside it, and either water
    // touches it (the sheet catches drops + re-converts exposed lava) or nothing molten below.
    const safeToMine = (pos) => {
        for (const [dx, dz] of SIDES) if (isLavaB(bot.blockAt(pos.offset(dx, 0, dz)))) return false;
        const above = bot.blockAt(pos.offset(0, 1, 0));
        if (isLavaB(above)) return false;
        let waterish = isWaterB(above);
        for (const [dx, dz] of SIDES) if (isWaterB(bot.blockAt(pos.offset(dx, 0, dz)))) waterish = true;
        return waterish || !isLavaB(bot.blockAt(pos.offset(0, -1, 0)));
    };
    const rescoop = async () => {
        if (has('water_bucket') >= 1 || has('bucket') < 1) return;
        const ws = await world.getNearestBlocksWhereAsync(bot, (b) => b && b.name === 'water' && b.metadata === 0, 8, 1);
        const src = (ws && ws.length) ? ws[0] : null;
        if (!src) return;
        await skills.goToPosition(bot, src.position.x, src.position.y, src.position.z, 2).catch(() => {});
        try { const ok = await skills.equip(bot, 'bucket'); if (!ok) return; } catch (e) { return; }
        try { await bot.lookAt(src.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
        await skills.wait(bot, 200);
        try { bot.activateItem(); } catch (e) {}
        await skills.wait(bot, 400);
    };

    let stalls = 0;
    while (has('obsidian') < target && !timeUp()) {
        if (stop()) break;                                                   // interrupt/death — return progress below
        if (!hasDiamondPick()) { log(bot, 'gatherObsidian: diamond pick gone mid-run — stop mining.'); break; }
        const lv = await nearestLavaSource();
        if (!lv) {
            stalls++;
            if (stalls > 2) { log(bot, `gatherObsidian: no lava within 48 after relocating — abort (+${minedThisRun()} obsidian this run; cooldown only if zero).`); return progressOrFalse(); }
            await skills.moveAway(bot, 24).catch(() => {});
            continue;
        }
        const stand = findStand(lv.position);
        if (!stand) {
            stalls++;
            if (stalls >= 4) { log(bot, `gatherObsidian: no safe standing edge at any reachable pool — abort (+${minedThisRun()} obsidian this run).`); return progressOrFalse(); }
            await skills.moveAway(bot, 8).catch(() => {});
            continue;
        }
        await skills.goToPosition(bot, stand.x, stand.y + 1, stand.z, 1).catch(() => {});
        if (stop() || timeUp()) break;

        const before = has('obsidian');
        await pour(lv.position);

        // Mine the frozen sheet — obsidian is ~9.4s/block even with a diamond pick, so
        // re-check interrupt/death/budget EVERY block.
        const cells = bot.findBlocks({ matching: (b) => b && b.name === 'obsidian', maxDistance: 6, count: 8 });
        for (const c of cells) {
            if (stop() || timeUp() || has('obsidian') >= target) break;
            if (!hasDiamondPick()) break;
            if (!safeToMine(c)) continue;
            // ★2026-07-05 预审 P1: 自身列排除 (pour() :126-130 有同款守卫, 挖矿循环漏了) —
            // pathfinder 会把 bot 送上黑曜石壳, 挖脚下/站立格 = 9.4s 后直坠壳下岩浆层。
            // 站立列(同 x,z 且 c 不高于脚)不挖; 正下方是岩浆的格子须与 bot 水平距离 >=2。
            const feet = bot.entity.position.floored();
            if (c.x === feet.x && c.z === feet.z && c.y <= feet.y) continue;
            if (isLavaB(bot.blockAt(c.offset(0, -1, 0))) && Math.hypot(c.x - feet.x, c.z - feet.z) < 2) continue;
            await skills.breakBlockAt(bot, c.x, c.y, c.z).catch(() => {});
            await skills.pickupNearbyItems(bot).catch(() => {});
        }
        await rescoop();                                                     // refill the bucket for the next pass

        if (has('obsidian') <= before) {
            stalls++;
            if (stalls >= 4) { log(bot, `gatherObsidian: no progress after ${stalls} passes (obsidian=${has('obsidian')}/${target}, +${minedThisRun()} this run) — abort.`); return progressOrFalse(); }
        } else { stalls = 0; }
    }

    log(bot, `gatherObsidian done: obsidian=${has('obsidian')}/${target} (+${minedThisRun()} this run) flint_and_steel=${has('flint_and_steel')} water_bucket=${has('water_bucket')} hp=${Math.round(bot.health)} (${Math.round((Date.now() - t0) / 1000)}s)`);
    // Progress THIS dispatch (or target actually met — e.g. kit crafted with obsidian
    // already banked) → truthy count; a zero-gain exit (interrupt/timeUp/pick-gone
    // break with nothing mined) → false so the kernel cooldown spaces retries.
    return (minedThisRun() > 0 || has('obsidian') >= target) ? has('obsidian') : false;
}
