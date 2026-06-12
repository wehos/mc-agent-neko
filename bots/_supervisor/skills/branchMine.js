// Hot-reloadable REAL skill: branch-mine for ores (no cheats).
// Optionally staircases down to targetY, then digs a straight horizontal tunnel,
// scanning for and mining any ore within reach each step. Solves the "pathfinding
// failed / cannot reach ore" problem by actively EXPOSING ores instead of relying
// on the pathfinder to squeeze up to a buried ore.
// Invoked via: !newAction("await skills.customSkill(bot, 'branchMine', 24, 45)")
//   length  = tunnel length (default 24)
//   targetY = if a number, staircase down to this Y first (e.g. -50 for diamonds)
// ctx = { skills, world, mc, Vec3, log }
const ORES = ['diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'deepslate_iron_ore',
              'coal_ore', 'deepslate_coal_ore', 'gold_ore', 'deepslate_gold_ore',
              'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
              'copper_ore', 'deepslate_copper_ore', 'emerald_ore', 'deepslate_emerald_ore'];

export default async function branchMine(bot, ctx, length = 24, targetY = null) {
    const { skills, world, Vec3, log } = ctx;
    // Use the CHEAP pickaxe to tunnel (stone), and save the good pickaxe's
    // durability for actually mining ores (diamond needs iron+ to drop).
    const equipDig = async () => { for (const p of ['stone_pickaxe', 'iron_pickaxe', 'wooden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']) if (world.getInventoryCounts(bot)[p]) { await skills.equip(bot, p).catch(() => {}); return; } };
    const equipBest = async () => { for (const p of ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']) if (world.getInventoryCounts(bot)[p]) { await skills.equip(bot, p).catch(() => {}); return; } };
    await equipDig();

    const mineNearby = async () => {
        for (const ore of ORES) {
            let b, tries = 0;
            while ((b = world.getNearestBlock(bot, ore, 5)) && tries++ < 6) {
                if (bot.interrupt_code) return;
                await equipBest(); // good pickaxe to mine ore (so diamonds drop)
                try { await skills.collectBlock(bot, ore, 1); } catch (e) { break; }
                await equipDig(); // back to the cheap pickaxe for tunneling
            }
        }
    };

    // Dig a real 1x2 STAIRCASE down to targetY (player-style). Each step we
    // mine the diagonally-lower cell (legs+head+headroom) and walk down into it.
    // This avoids digDown's "reached a drop" stalls and never free-falls into
    // lava — we inspect the cells before mining and stop if lava is adjacent.
    if (typeof targetY === 'number') {
        let yaw = bot.entity.yaw;
        let dx = -Math.sin(yaw), dz = Math.cos(yaw);
        if (Math.abs(dx) >= Math.abs(dz)) { dx = Math.sign(dx) || 1; dz = 0; } else { dz = Math.sign(dz) || 1; dx = 0; }
        let guard = 0, stall = 0;
        while (Math.floor(bot.entity.position.y) > targetY && guard++ < 220) {
            if (bot.interrupt_code) break;
            const b = bot.entity.position.floored();
            const cells = [
                new Vec3(b.x + dx, b.y - 1, b.z + dz), // step legs
                new Vec3(b.x + dx, b.y, b.z + dz),     // step head
                new Vec3(b.x + dx, b.y + 1, b.z + dz), // headroom
            ];
            let lava = false;
            for (const c of cells) {
                const blk = bot.blockAt(c);
                if (blk && (blk.name === 'lava' || blk.name === 'flowing_lava')) { lava = true; break; }
            }
            if (lava) { log(bot, `Lava ahead at y=${b.y}, stopping descent.`); break; }
            for (const c of cells) {
                const blk = bot.blockAt(c);
                if (blk && blk.name !== 'air' && blk.name !== 'cave_air') {
                    // Equip the right tool for THIS block before digging. Without this
                    // the staircase digs with whatever's in hand (often dirt) — mining
                    // stone/deepslate with a non-pickaxe is slow AND drops nothing.
                    try { await bot.tool.equipForBlock(blk); } catch (e) {}
                    try { await bot.dig(blk); } catch (e) {}
                }
            }
            const before = b.y;
            try { await skills.goToPosition(bot, b.x + dx, b.y - 1, b.z + dz, 0); } catch (e) {}
            await mineNearby();
            if (Math.floor(bot.entity.position.y) >= before) { stall++; if (stall >= 5) { log(bot, 'descent stalled'); break; } }
            else stall = 0;
        }
        log(bot, `descended to y=${Math.floor(bot.entity.position.y)}`);
    }

    await mineNearby();

    // Horizontal tunnel along the bot's current facing (snapped to a cardinal axis).
    const yaw = bot.entity.yaw;
    let dx = -Math.sin(yaw), dz = Math.cos(yaw);
    if (Math.abs(dx) >= Math.abs(dz)) { dx = Math.sign(dx) || 1; dz = 0; } else { dz = Math.sign(dz) || 1; dx = 0; }

    let stale = 0;
    for (let i = 0; i < length; i++) {
        if (bot.interrupt_code) break;
        const p = bot.entity.position.floored();
        const tx = p.x + dx * 2, tz = p.z + dz * 2;
        const beforePos = `${p.x},${p.z}`;
        try { await skills.goToPosition(bot, tx, p.y, tz, 0); } catch (e) { stale++; }
        await mineNearby();
        const np = bot.entity.position.floored();
        if (`${np.x},${np.z}` === beforePos) { stale++; if (stale >= 4) { log(bot, 'tunnel blocked, stopping'); break; } }
        else stale = 0;
    }
    log(bot, `branchMine done. y=${Math.floor(bot.entity.position.y)} inv=${JSON.stringify(world.getInventoryCounts(bot))}`);
    return true;
}
