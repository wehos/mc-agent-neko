// scanFood — READ-ONLY diagnostic: what food can the bot actually reach from here?
// The bot keeps starving in low-food holds; before building a forage solution we need to
// know whether food is reachable nearby or the terrain is genuinely barren (-> must travel).
// Logs nearest huntable animals and edible blocks within range. Moves nothing.

export default async function scanFood(bot, ctx) {
    const { log, mc, Vec3 } = ctx;
    const p = bot.entity.position;
    const HUNT = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'horse', 'goat', 'salmon', 'cod'];
    const FOODBLOCK = ['wheat', 'carrots', 'potatoes', 'beetroots', 'sweet_berry_bush', 'melon', 'pumpkin', 'cave_vines', 'cave_vines_plant'];

    // Passive/huntable entities in range.
    const animals = [];
    try {
        for (const e of Object.values(bot.entities || {})) {
            if (!e || e === bot.entity || !e.position) continue;
            const nm = (e.name || '').toLowerCase();
            if (HUNT.includes(nm)) animals.push({ name: nm, d: +e.position.distanceTo(p).toFixed(1), x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) });
        }
    } catch (e) {}
    animals.sort((a, b) => a.d - b.d);

    // Edible blocks (mature crops / berries) within 48.
    const foundBlocks = [];
    try {
        for (const bn of FOODBLOCK) {
            const id = mc.getBlockId(bn);
            if (id == null) continue;
            const ps = bot.findBlocks({ matching: id, maxDistance: 48, count: 3 });
            for (const bp of ps) foundBlocks.push({ name: bn, d: +p.distanceTo(bp).toFixed(1), x: bp.x, y: bp.y, z: bp.z });
        }
    } catch (e) {}
    foundBlocks.sort((a, b) => a.d - b.d);

    let inv = {};
    try { for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count; } catch (e) {}

    const summary = {
        pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
        food: bot.food, hp: Math.round(bot.health || 0),
        animals: animals.slice(0, 6),
        animalCount: animals.length,
        foodBlocks: foundBlocks.slice(0, 6),
        nearestAnimal: animals[0] || null,
        nearestFoodBlock: foundBlocks[0] || null,
        verdict: animals.length ? `huntable animal at d=${animals[0].d}` : (foundBlocks.length ? `food block at d=${foundBlocks[0].d}` : 'NO reachable food in range — must travel/explore'),
    };
    log(bot, `[scanFood] ${JSON.stringify(summary)}`);
    return summary;
}
