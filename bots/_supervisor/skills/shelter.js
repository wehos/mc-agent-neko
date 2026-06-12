// Hot-reloadable REAL skill: wall yourself in for safety, like a player panic-
// boxing against creepers/skeletons or to wait out the night. Places blocks on
// every open side around the bot (feet ring, head ring, ceiling) from owned
// blocks (dirt/cobblestone/etc). No cheats.
// Invoked via: !newAction("await skills.customSkill(bot, 'shelter', 0)")
//   holdMs: optional ms to wait sealed in (e.g. 12000 to wait out danger).
// ctx = { skills, world, mc, Vec3, log }
export default async function shelter(bot, ctx, holdMs = 0) {
    const { skills, Vec3, log } = ctx;
    const MATS = ['cobblestone', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate'];
    const haveMat = () => MATS.find(m => bot.inventory.items().some(i => i.name === m && i.count > 0));
    const OPEN = (n) => !n || n === 'air' || n === 'cave_air' || n.includes('water') || n === 'short_grass' || n === 'tall_grass' || n.includes('leaves') || n.includes('fern') || n === 'vine';

    const p = bot.entity.position.floored();
    // feet ring (y), head ring (y+1), ceiling (y+2)
    const spots = [
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
        [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
        [0, 2, 0],
    ];
    let placed = 0;
    for (const [dx, dy, dz] of spots) {
        const mat = haveMat();
        if (!mat) { log(bot, 'Out of blocks while sheltering'); break; }
        const tx = p.x + dx, ty = p.y + dy, tz = p.z + dz;
        const b = bot.blockAt(new Vec3(tx, ty, tz));
        if (OPEN(b && b.name)) {
            try { await skills.placeBlock(bot, mat, tx, ty, tz, 'bottom'); placed++; }
            catch (e) {}
            await skills.wait(bot, 80);
        }
    }
    log(bot, `Sheltered: sealed ${placed} openings.`);
    if (holdMs > 0) await skills.wait(bot, holdMs);
    return placed;
}
