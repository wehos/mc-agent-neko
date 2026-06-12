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
    await skills.smeltItem(bot, item, num);
    log(bot, `smeltSafe(${item} x${num}) done. inv=${JSON.stringify(world.getInventoryCounts(bot))}`);
    return true;
}
