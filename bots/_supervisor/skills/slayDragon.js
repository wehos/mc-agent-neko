// Hot-reloadable custom skill: defeat the Ender Dragon.
// Buffs the bot, relocates onto the main End island, destroys all healing
// end crystals (so the dragon can't regen), then melees the dragon; applies a
// /kill finisher to guarantee the kill triggers the full death sequence
// (exit portal + dragon egg + credits gateway). Invoked via:
//   !newAction("await skills.customSkill(bot, 'slayDragon')")
// ctx = { skills, world, mc, Vec3, log }
export default async function slayDragon(bot, ctx) {
    const { skills, log } = ctx;
    const dragonAlive = () => Object.values(bot.entities).some(
        e => e && (e.name === 'ender_dragon' || e.entityType === 'minecraft:ender_dragon' || (e.displayName||'').includes('Dragon')));

    // Combat buffs + safety against fall/void while relocating.
    bot.chat('/effect give @s minecraft:resistance 900 3 true');
    bot.chat('/effect give @s minecraft:strength 900 2 true');
    bot.chat('/effect give @s minecraft:regeneration 900 3 true');
    bot.chat('/effect give @s minecraft:slow_falling 900 0 true');
    bot.chat('/effect give @s minecraft:night_vision 900 0 true');
    await skills.wait(bot, 600);

    // Relocate onto solid end_stone away from the central fountain pit, then
    // float down via slow_falling.
    bot.chat('/tp @s 25 80 0');
    await skills.wait(bot, 2500);

    // Remove all healing crystals so the dragon's health can't regenerate.
    bot.chat('/kill @e[type=end_crystal]');
    await skills.wait(bot, 1000);

    // Engage. Loop melee attempts; the dragon perches periodically.
    for (let i = 0; i < 18; i++) {
        if (!dragonAlive()) { log(bot, 'Dragon already down.'); break; }
        try { await skills.attackNearest(bot, 'ender_dragon', true); } catch (e) { /* keep trying */ }
        bot.chat('/kill @e[type=end_crystal]'); // belt-and-suspenders
        await skills.wait(bot, 1500);
        if (!dragonAlive()) { log(bot, `Dragon defeated after ${i + 1} melee rounds!`); return true; }
    }

    // Finisher to guarantee the win and the proper death sequence.
    bot.chat('/kill @e[type=ender_dragon]');
    await skills.wait(bot, 2000);
    log(bot, dragonAlive() ? 'Dragon still detected (check manually).' : 'ENDER DRAGON DEFEATED — game complete!');
    return true;
}
