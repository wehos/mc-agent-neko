// Hot-reloadable REAL skill: reliably smelt by placing the furnace ourselves
// first (clearing any leaf/grass in the way), then calling smeltItem. The stock
// smeltItem's auto furnace placement fails under jungle canopy / uneven ground
// (blockUpdate timeout), same issue craftChain had with the crafting table.
// Invoked via: !newAction("await skills.customSkill(bot, 'smeltSafe', 'raw_iron', 6)")
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const STATIONS_F = path.resolve(process.cwd(), 'bots', '_supervisor', 'stations.json');
// 状态池登记 (满地台炉根治的一环): 任何用到/放置的熔炉都进 stations.json
const stRegister = (type, p) => {
    try {
        let a = []; try { a = JSON.parse(fs.readFileSync(STATIONS_F, 'utf8')); if (!Array.isArray(a)) a = []; } catch (e) {}
        a = a.filter(s => !(s.type === type && Math.abs(s.x - p.x) < 2 && Math.abs(s.y - p.y) < 2 && Math.abs(s.z - p.z) < 2));
        a.push({ type, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), t: Date.now() });
        fs.writeFileSync(STATIONS_F, JSON.stringify(a));
    } catch (e) {}
};
export default async function smeltSafe(bot, ctx, item, num = 1) {
    const { skills, world, log } = ctx;
    const findFurnace = () => world.getNearestBlock(bot, 'furnace', 4);
    if (!findFurnace()) {
        if (!(world.getInventoryCounts(bot)['furnace'] > 0)) {
            // Furnace is a 3x3 recipe. Craft it in the current pocket instead of
            // walking toward an old remote table; abort cleanly if no reachable
            // table can be placed. A failed craft must never fall through into
            // destructive placement recovery with an empty furnace inventory.
            const crafted = await skills.craftRecipeLocal(bot, 'furnace', 1).catch(() => false);
            if (!crafted || !(world.getInventoryCounts(bot)['furnace'] > 0)) {
                log(bot, 'smeltSafe: could not craft a furnace locally; placement skipped without moving or clearing terrain.');
                return false;
            }
        }
        // Smelting is a workstation action, not a travel request. Try one bounded
        // adjacent placement (at most a two-block niche), with no relocation or
        // pillar escape. Higher layers may explicitly choose a new work area.
        const placed = await skills.placeBlockNearby(bot, 'furnace', {
            maxTries: 1,
            relocate: false,
            pillar: false,
            positioning: false,
            maxDigBlocks: 2,
        }).catch(() => false);
        const observedFurnace = findFurnace();
        if (!observedFurnace) {
            log(bot, 'smeltSafe: could not place the carried furnace beside the bot; smelting aborted in place.');
            return false;
        }
        if (!placed) {
            log(bot, 'smeltSafe: placement confirmation failed, but the furnace is present; continuing with the observed furnace.');
        }
        log(bot, 'furnace placed');
    }
    { const f0 = findFurnace(); if (f0) stRegister('furnace', f0.position); }   // 用到即登记
    // ★kernel return contract (return-contract audit 2026-07-02): smeltItem signals EVERY
    // zero-progress mode by RETURNING false, never throwing — no fuel / fuel stack too small /
    // foreign input parked in the furnace / not enough input / no furnace / 11s zero-collection
    // timeout (skills.js:487-618). The old unconditional `return true` fed all of those to the
    // kernel as success, resetting its 3-strike counter every ~2s dispatch while isGoalDone
    // (hasIronTierPick for both GET_IRON_TOOLS and NIGHT_SMELT_IRON) provably can't release
    // with zero ingots produced → unbreakable hot livelock. Progress = INPUT-COUNT DELTA over
    // THIS dispatch (snapshot taken here, AFTER furnace craft/placement, so e.g. cobblestone
    // spent crafting the furnace can't masquerade as smelt progress): smeltItem retrieves
    // leftover input before returning, so consumed == items actually smelted — which also
    // credits partial smelts (total < num) that smeltItem itself mislabels as false.
    const inputBefore = world.getInventoryCounts(bot)[item] || 0;
    const ok = await skills.smeltItem(bot, item, num);
    // ★2026-07-14 (评审实锤): 被打断的派发不按库存差记进度 — 打断且炉窗已丢时 smeltItem 不强收
    //   炉内残料, "料进了炉"≠"炼出了锭", delta 会把它记成 consumed>0 → 假成功喂内核重置 3-strike。
    //   打断一律如实报 false (kernel 正确计一次失败; 料在炉里丢不了, 下次同炉复用时收回)。
    if (bot.interrupt_code) {
        log(bot, `smeltSafe: dispatch interrupted — not crediting progress (ok=${ok}).`);
        return false;
    }
    const consumed = inputBefore - (world.getInventoryCounts(bot)[item] || 0);
    log(bot, `smeltSafe(${item} x${num}) done. consumed=${consumed} inv=${JSON.stringify(world.getInventoryCounts(bot))}`);
    if (ok !== true && consumed <= 0) {
        log(bot, `smeltSafe: NO progress this dispatch (ok=${ok}) → false (kernel 3-strike cooldown).`);
        return false;
    }
    return true;
}
