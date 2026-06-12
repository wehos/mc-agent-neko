// Hot-reloadable REAL skill: craft a whole tool tier in one call (no cheats).
// Fixes two problems with the stock skills.craftRecipe:
//   1) it always uses recipes[0], which with MIXED planks (oak+jungle) can be a
//      variant we lack -> "missing ingredient". We pick a recipe we can afford.
//   2) its auto crafting-table placement (getNearestFreeSpace) fails under a
//      jungle canopy. We place a table ourselves at our feet.
// Invoked via: !newAction("await skills.customSkill(bot, 'craftChain', 'wood_tier')")
// ctx = { skills, world, mc, Vec3, log }
const PRESETS = {
    wood_tier: [['oak_planks', 4], ['jungle_planks', 4], ['crafting_table', 1],
                ['stick', 2], ['wooden_pickaxe', 1], ['wooden_sword', 1], ['wooden_axe', 1]],
    stone_tier: [['stick', 2], ['stone_pickaxe', 1], ['stone_sword', 1], ['stone_axe', 1], ['furnace', 1]],
    iron_tier: [['stick', 2], ['iron_pickaxe', 1], ['iron_sword', 1], ['shield', 1]],
    torches: [['stick', 2], ['torch', 16]],
};

function haveCounts(bot) {
    const h = {};
    for (const it of bot.inventory.items()) h[it.type] = (h[it.type] || 0) + it.count;
    return h;
}
// Pick the first recipe whose ingredient costs are all covered by inventory.
function affordableRecipe(bot, recipes) {
    const have = haveCounts(bot);
    for (const r of recipes) {
        const need = {};
        for (const d of (r.delta || [])) if (d.count < 0) need[d.id] = (need[d.id] || 0) + (-d.count);
        if (Object.entries(need).every(([t, c]) => (have[t] || 0) >= c)) return r;
    }
    return null;
}

export default async function craftChain(bot, ctx, preset) {
    const { skills, world, mc, Vec3, log } = ctx;
    const recipes = Array.isArray(preset) ? preset : PRESETS[preset];
    if (!recipes) { log(bot, `Unknown craft preset: ${preset}`); return false; }

    const findTable = () => world.getNearestBlock(bot, 'crafting_table', 4);
    async function craftSmart(name, count) {
        const id = mc.getItemId(name);
        if (id == null) { log(bot, `unknown item ${name}`); return false; }
        const table = findTable();
        let rs = bot.recipesFor(id, null, 1, table);
        if (!rs || rs.length === 0) rs = bot.recipesFor(id, null, 1, null);
        if (!rs || rs.length === 0) { log(bot, `no recipe avail for ${name}`); return false; }
        const r = affordableRecipe(bot, rs) || rs[0];
        try { await bot.craft(r, count, table || undefined); log(bot, `crafted ${name} (have ${world.getInventoryCounts(bot)[name] || 0})`); return true; }
        catch (e) { log(bot, `craft ${name} failed: ${e.message}`); return false; }
    }

    // STEP 1: craft all planks first so we have materials for the table+tools.
    for (const [name, count] of recipes) if (/_planks$/.test(name)) await craftSmart(name, count || 1);

    // STEP 2: if any recipe needs a table, ensure one is PLACED on the ground
    // (now that we have planks). craftRecipe's own placement fails under canopy.
    const needsTable = recipes.some(([n]) => /pickaxe|sword|_axe|shovel|hoe|furnace|shield|bed|chest|bow/.test(n));
    if (needsTable && !findTable()) {
        // Step to flatter open ground first — placeBlock times out
        // (blockUpdate never fires) when standing on uneven/leafy spots.
        await skills.moveAway(bot, 3).catch(() => {});
        if (!(world.getInventoryCounts(bot)['crafting_table'] > 0)) {
            // Ensure we have planks for the table — stone/iron tiers don't craft
            // planks themselves, and we may only have raw logs. Make planks first.
            const inv = world.getInventoryCounts(bot);
            const planks = Object.keys(inv).filter(n => n.endsWith('_planks')).reduce((s, n) => s + inv[n], 0);
            if (planks < 4) {
                const log = Object.keys(inv).find(n => n.endsWith('_log') || n.endsWith('_stem') || n.endsWith('_hyphae') || n.endsWith('_wood'));
                if (log) await craftSmart(log.replace(/_(log|stem|hyphae|wood)$/, '_planks'), 4);
            }
            await craftSmart('crafting_table', 1);
        }
        // Retry across several relocations — placeBlock intermittently times out
        // on bad footing, so don't give up after one spot.
        for (let attempt = 0; attempt < 5 && !findTable(); attempt++) {
            if (attempt > 0) await skills.moveAway(bot, 4).catch(() => {});
            const p = bot.entity.position.floored();
            for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [0, 2], [1, 1], [-1, -1]]) {
                if (findTable()) break;
                const blk = bot.blockAt(new Vec3(p.x + dx, p.y, p.z + dz));
                if (blk && blk.name !== 'air' && (blk.name.includes('leaves') || blk.name.includes('grass') || blk.name === 'vine' || blk.name.includes('fern'))) { try { await bot.dig(blk); } catch (e) {} }
                try { await skills.placeBlock(bot, 'crafting_table', p.x + dx, p.y, p.z + dz, 'bottom'); } catch (e) {}
                await skills.wait(bot, 200);
            }
        }
        const t = findTable();
        log(bot, t ? `table placed at ${t.position.x},${t.position.y},${t.position.z}` : 'could not place table after retries');
    }

    // STEP 3: craft everything else (sticks + tools), skipping planks/table.
    for (const [name, count] of recipes) {
        if (/_planks$/.test(name) || name === 'crafting_table') continue;
        await craftSmart(name, count || 1);
    }
    log(bot, `craftChain(${typeof preset === 'string' ? preset : 'custom'}) done. inv=${JSON.stringify(world.getInventoryCounts(bot))}`);
    return true;
}
