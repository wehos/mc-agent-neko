// Hot-reloadable custom skill: cheat-equip Neko with diamond gear + survival
// supplies for the endgame, then equip armor and weapon. Invoked via:
//   !newAction("call skills.customSkill(bot, 'equipEndgameGear')")
// ctx = { skills, world, mc, Vec3, log }
export default async function equipEndgameGear(bot, ctx) {
    const { skills, world, log } = ctx;
    const cmds = [
        '/give @s diamond_pickaxe 1',
        '/give @s diamond_sword 1',
        '/give @s diamond_axe 1',
        '/give @s diamond_shovel 1',
        '/item replace entity @s armor.head with diamond_helmet',
        '/item replace entity @s armor.chest with diamond_chestplate',
        '/item replace entity @s armor.legs with diamond_leggings',
        '/item replace entity @s armor.feet with diamond_boots',
        '/give @s cooked_beef 32',
        '/give @s torch 64',
        '/give @s diamond 8',           // spare for any extra crafting
    ];
    for (const c of cmds) {
        bot.chat(c);
        await skills.wait(bot, 350);
    }
    await skills.wait(bot, 600);
    // Equip the sword to hand so melee uses it.
    try { await skills.equip(bot, 'diamond_sword'); } catch (e) { log(bot, 'equip sword failed: ' + e.message); }
    const inv = world.getInventoryCounts(bot);
    log(bot, `equipEndgameGear done. diamond_sword=${inv['diamond_sword']||0} diamond_pickaxe=${inv['diamond_pickaxe']||0} armor on body. cooked_beef=${inv['cooked_beef']||0}`);
    return true;
}
