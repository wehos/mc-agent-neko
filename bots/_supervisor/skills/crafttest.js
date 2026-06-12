// One-shot diagnostic: isolate the "craft consumes ingredients but product vanishes"
// bug. Dumps slots before, places a table, crafts ONE of `item` via bot.craft
// directly (bypassing achieve), dumps slots after. ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

export default async function crafttest(bot, ctx, item = 'chest') {
    const { skills, world, mc } = ctx;
    const dump = (tag) => {
        const slots = [];
        bot.inventory.slots.forEach((s, i) => { if (s && s.name) slots.push(`#${i}:${s.name}x${s.count}`); });
        prog(`CT ${tag}: ${slots.join(' ')}`);
    };
    const cnt = (n) => world.getInventoryCounts(bot)[n] || 0;

    // ISOLATED test of craftRecipe: does it actually PRODUCE the item, or consume
    // ingredients and lose the product? No placeBlockNearby (that confused prior
    // diagnoses by consuming the crafted table).
    const planksBefore = cnt('oak_planks');
    const before = cnt(item);
    prog(`CT isolate craftRecipe(${item}): ${item}=${before} oak_planks=${planksBefore} stick=${cnt('stick')}`);
    try { await skills.craftRecipe(bot, item, 1); }
    catch (e) { prog(`CT craftRecipe threw: ${e.message}`); }
    await skills.wait(bot, 400);
    const nearTable = world.getNearestBlock(bot, 'crafting_table', 16);
    prog(`CT RESULT ${item}: ${before}->${cnt(item)} | oak_planks ${planksBefore}->${cnt('oak_planks')} | nearTable=${nearTable ? `${nearTable.position.x},${nearTable.position.y},${nearTable.position.z}` : 'none'}`);
    dump('after');
    return cnt(item) > before;
}
