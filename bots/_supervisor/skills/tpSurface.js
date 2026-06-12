// One-off RESCUE skill (cheat — user-authorized to break a dead-lock): teleport the bot
// from a deep-stuck spot up to the SURFACE at its own x,z, landing AT ground level (no
// fatal fall), and top up health+food so the constant low-HP self_preservation flee
// stops hijacking the pathfinder. Used to free a bot that broke its pickaxe deep down
// and can't climb/craft its way out. Invoked: skills.customSkill(bot,'tpSurface').
// ctx = { skills, world, mc, Vec3, log }
export default async function tpSurface(bot, ctx) {
    const { Vec3, log } = ctx;
    const SOLID_SKIP = new Set(['air', 'cave_air', 'void_air', 'water', 'flowing_water', 'lava', 'flowing_lava',
        'oak_leaves', 'jungle_leaves', 'birch_leaves', 'spruce_leaves', 'acacia_leaves', 'dark_oak_leaves',
        'mangrove_leaves', 'cherry_leaves', 'azalea_leaves', 'short_grass', 'tall_grass', 'snow']);
    const p = bot.entity.position;
    const x = Math.floor(p.x), z = Math.floor(p.z);
    // Highest real ground block at this x,z (skip air/water/leaves/foliage) -> stand on top.
    let gy = null;
    for (let y = 200; y > 0; y--) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (b && b.boundingBox === 'block' && !SOLID_SKIP.has(b.name)) { gy = y; break; }
    }
    const ty = (gy != null ? gy + 1 : 80);
    log(bot, `tpSurface: ground=${gy} -> tp to y=${ty}`);
    // Heal + feed FIRST so we don't arrive at ~5 HP (which makes self_preservation flee
    // every tick and steal the pathfinder, the thing that pinned the bot underground).
    bot.chat('/effect give Neko minecraft:instant_health 1 5');
    bot.chat('/effect give Neko minecraft:regeneration 12 4');
    bot.chat('/effect give Neko minecraft:saturation 5 9');
    await new Promise(r => setTimeout(r, 400));
    bot.chat(`/tp Neko ${x + 0.5} ${ty} ${z + 0.5}`);
    await new Promise(r => setTimeout(r, 800));
    log(bot, `tpSurface done: now y=${Math.floor(bot.entity.position.y)} hp=${Math.round(bot.health)} food=${bot.food}`);
    return Math.floor(bot.entity.position.y) >= (gy != null ? gy - 1 : 50);
}
