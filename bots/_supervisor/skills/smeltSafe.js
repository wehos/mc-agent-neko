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
    const { skills, world, Vec3, log } = ctx;
    const findFurnace = () => world.getNearestBlock(bot, 'furnace', 4);
    if (!findFurnace()) {
        if (!(world.getInventoryCounts(bot)['furnace'] > 0)) {
            await skills.craftRecipe(bot, 'furnace', 1).catch(() => {});
        }
        // Robust, cheat-free placement via core placeBlockNearby (digs a niche on
        // solid footing + retries + relocates) — same logic the crafting table uses.
        for (let attempt = 0; attempt < 3 && !findFurnace(); attempt++) {
            await skills.placeBlockNearby(bot, 'furnace').catch(() => {});
            if (!findFurnace()) await skills.wait(bot, 200);
        }
        log(bot, findFurnace() ? 'furnace placed' : 'could not place furnace');
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
    const consumed = inputBefore - (world.getInventoryCounts(bot)[item] || 0);
    log(bot, `smeltSafe(${item} x${num}) done. consumed=${consumed} inv=${JSON.stringify(world.getInventoryCounts(bot))}`);
    if (ok !== true && consumed <= 0) {
        log(bot, `smeltSafe: NO progress this dispatch (ok=${ok}) → false (kernel 3-strike cooldown).`);
        return false;
    }
    return true;
}
