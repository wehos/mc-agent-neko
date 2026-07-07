// Hot-reloadable TEST helper (用户令 2026-07-08): cheat-give a materials kit to the bot so we can
// test whether the brain (gpt-5.5) can BUILD + LIGHT a nether portal in place on its own.
//
// This deployment runs on a LAN/integrated server; when "Allow Cheats" is on, joined players get
// command access, so `/give @self ...` succeeds. We give the finished materials (obsidian +
// flint_and_steel), plus cobblestone (frame supports/scaffolding) and a diamond pickaxe (so she can
// re-mine/correct a mis-placed obsidian — obsidian only breaks with a diamond pick). Then we read
// back the inventory and RETURN the counts so the dispatcher can verify the give actually landed
// (if counts didn't rise, cheats are OFF and the operator must give items by hand).
//
// Invoked via WS: {"type":"run_skill","skill":"giveKit","args":[]}
//   optional override: {"type":"run_skill","skill":"giveKit","args":[{"items":{"obsidian":10}}]}
// ctx = { skills, world, mc, Vec3, log }
export default async function giveKit(bot, ctx, spec) {
    const { world, log } = ctx;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const kit = (spec && typeof spec === 'object' && spec.items && typeof spec.items === 'object')
        ? spec.items
        : { obsidian: 14, flint_and_steel: 2, cobblestone: 32, diamond_pickaxe: 1 };

    const name = (bot && bot.username) || 'Neko';
    const counts = () => { try { return world.getInventoryCounts(bot) || {}; } catch (e) { return {}; } };
    const before = counts();

    for (const [item, count] of Object.entries(kit)) {
        try { bot.chat(`/give ${name} ${item} ${count}`); } catch (e) {}
        await wait(400);   // let the server process each give + inventory packet
    }
    await wait(1200);      // settle before reading back

    const after = counts();
    const got = {};
    for (const item of Object.keys(kit)) got[item] = after[item] || 0;
    const landed = Object.keys(kit).some((it) => (after[it] || 0) > (before[it] || 0));

    try {
        log(bot, landed
            ? `giveKit OK — obsidian=${got.obsidian || 0}, flint_and_steel=${got.flint_and_steel || 0}, cobblestone=${got.cobblestone || 0}, diamond_pickaxe=${got.diamond_pickaxe || 0}`
            : 'giveKit — NO items landed (cheats likely OFF; operator must /give by hand)');
    } catch (e) {}

    return { ok: true, landed, kit, got, before };
}
