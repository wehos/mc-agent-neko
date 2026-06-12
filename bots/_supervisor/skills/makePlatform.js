// Hot-reloadable terrain-rescue skill: lay a small solid platform under the bot
// and clear the space around it, so crafting (which needs to place a crafting
// table on free ground) and standing work in awful terrain (water/tree canopy).
// Uses /fill with RELATIVE coords (cheat — terrain救济 only, not for resources).
// Invoked via: !newAction("await skills.customSkill(bot, 'makePlatform')")
// ctx = { skills, world, mc, Vec3, log }
export default async function makePlatform(bot, ctx, mat = 'dirt') {
    const { skills, log } = ctx;
    // 5x5 solid floor just below feet.
    bot.chat(`/fill ~-2 ~-1 ~-2 ~2 ~-1 ~2 ${mat}`);
    await skills.wait(bot, 300);
    // Clear a 5x5x3 pocket for body + crafting table placement.
    bot.chat(`/fill ~-2 ~ ~-2 ~2 ~2 ~2 air`);
    await skills.wait(bot, 600);
    log(bot, 'Platform ready: solid floor laid and space cleared under bot.');
    return true;
}
