// ═══════════════════════════════════════════════════════════════════════════════════════
// ★DISABLED SURFACE WALL-BOX ("封箱") — 2026-07-07 (see docs/shelter-mechanism-disabled.md)
//   This standalone panic-box skill is DEAD CODE (the only reference is the !newAction chat
//   comment below — no live dispatcher calls it) AND it is the textbook case of the bug the
//   user gave up on: skills.placeBlock() path-navigates the bot to reach each block face, so
//   by the time the ring closes the bot has walked OUT of it — walls around the old spot, bot
//   standing outside. Per user decision "允许挖三填一，不允许封箱" the surface box is disabled:
//   this skill now places NOTHING (returns 0). The reliable dig-down pocket (挖三填一) lives in
//   nightShelter.js mode 'dig_one' and is unaffected. Escape hatch: env NEKO_ENABLE_SEAL_SHELTER=1.
//
// (Original doc, kept for reference) Hot-reloadable skill: wall yourself in for safety, like a
//   player panic-boxing against creepers/skeletons or to wait out the night. Places blocks on
//   every open side around the bot (feet ring, head ring, ceiling) from owned blocks.
//   Invoked via: !newAction("await skills.customSkill(bot, 'shelter', 0)")  holdMs optional.
//   ctx = { skills, world, mc, Vec3, log }
// ═══════════════════════════════════════════════════════════════════════════════════════
export default async function shelter(bot, ctx, holdMs = 0) {
    const { skills, Vec3, log } = ctx;
    // ★DISABLED: never build the surface box. No-op unless the escape-hatch env flag is set.
    if (process.env.NEKO_ENABLE_SEAL_SHELTER !== '1') {
        log(bot, 'shelter skill 已禁用 (地表封箱, 会把 bot 关在外面) — 不砌墙. 挖三填一见 nightShelter. (docs/shelter-mechanism-disabled.md)');
        return 0;
    }
    // ★材料优先级 (用户令 2026-07-07: 泥土 > 石头 > 其他): 泥土优先, 石系其次; 无木板。
    const MATS = ['dirt', 'coarse_dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'netherrack', 'andesite', 'diorite', 'granite'];
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
