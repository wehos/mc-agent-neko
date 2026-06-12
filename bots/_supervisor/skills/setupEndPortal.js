// Hot-reloadable custom skill: place a working end_portal block next to the bot
// (cheats), on a cleared obsidian pad so the bot can't fall into lava/void.
// Stepping onto an end_portal block teleports to The End and generates the
// standard obsidian spawn platform, so it's a safe entry. Also tops up ender
// pearls/eyes for good measure. Invoked via:
//   !newAction("await skills.customSkill(bot, 'setupEndPortal')")
// ctx = { skills, world, mc, Vec3, log }
export default async function setupEndPortal(bot, ctx) {
    const { skills, Vec3, log } = ctx;
    const p = bot.entity.position.floored();
    const x = p.x + 2, y = p.y, z = p.z;
    // Clear a small pocket and lay an obsidian floor + walls so the bot is safe.
    bot.chat(`/fill ${x-1} ${y-1} ${z-1} ${x+1} ${y+3} ${z+1} air`);
    await skills.wait(bot, 350);
    bot.chat(`/fill ${x-1} ${y-1} ${z-1} ${x+1} ${y-1} ${z+1} obsidian`);
    await skills.wait(bot, 350);
    // The end portal block itself.
    bot.chat(`/setblock ${x} ${y} ${z} end_portal`);
    await skills.wait(bot, 400);
    // Spare items in case they're useful later.
    bot.chat('/give @s ender_pearl 16');
    bot.chat('/give @s ender_eye 16');
    await skills.wait(bot, 500);
    log(bot, `End portal block at ${x} ${y} ${z}. Walk onto it (goToCoordinates ${x} ${y} ${z}) to enter The End.`);
    return { x, y, z };
}
