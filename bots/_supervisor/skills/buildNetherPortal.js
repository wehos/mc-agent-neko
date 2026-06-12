// Hot-reloadable custom skill: build and light a Nether portal next to the bot
// using setblock (cheats enabled), then report the interior coordinate so the
// supervisor can walk Neko in. Invoked via:
//   !newAction("await skills.customSkill(bot, 'buildNetherPortal')")
// ctx = { skills, world, mc, Vec3, log }
//
// Geometry: a vertical portal in the plane z = z0, interior 2 wide (x0..x0+1)
// x 3 tall (y0..y0+2). Minimum 10-obsidian frame (no corners). Interior is
// cleared to air, a small standing pad is laid, and the lower-left interior
// block is set to fire to activate the portal.
export default async function buildNetherPortal(bot, ctx) {
    const { skills, Vec3, log } = ctx;
    const p = bot.entity.position.floored();
    const x0 = p.x + 2;     // a couple blocks in front (+x)
    const y0 = p.y;         // interior bottom = bot feet level
    const z0 = p.z;

    // Clear a 5-wide x 5-tall x 3-deep pocket around the portal so the frame
    // and walk-in path aren't buried in terrain.
    bot.chat(`/fill ${x0-2} ${y0-1} ${z0-1} ${x0+3} ${y0+4} ${z0+1} air`);
    await skills.wait(bot, 300);
    // Standing pad under and around the portal so the bot doesn't fall.
    bot.chat(`/fill ${x0-2} ${y0-1} ${z0-1} ${x0+3} ${y0-1} ${z0+1} stone`);
    await skills.wait(bot, 300);

    // Obsidian frame (10 blocks, no corners).
    const frame = [
        [x0,   y0-1, z0], [x0+1, y0-1, z0],            // bottom
        [x0,   y0+3, z0], [x0+1, y0+3, z0],            // top
        [x0-1, y0,   z0], [x0-1, y0+1, z0], [x0-1, y0+2, z0], // left
        [x0+2, y0,   z0], [x0+2, y0+1, z0], [x0+2, y0+2, z0], // right
    ];
    for (const [bx, by, bz] of frame) {
        bot.chat(`/setblock ${bx} ${by} ${bz} obsidian`);
        await skills.wait(bot, 120);
    }
    // Ensure interior is air.
    bot.chat(`/fill ${x0} ${y0} ${z0} ${x0+1} ${y0+2} ${z0} air`);
    await skills.wait(bot, 300);
    // Light it.
    bot.chat(`/setblock ${x0} ${y0} ${z0} fire`);
    await skills.wait(bot, 1000);

    const interior = new Vec3(x0, y0, z0);
    log(bot, `Nether portal built & lit. Interior at ${x0} ${y0} ${z0}. Walk into it to travel to the Nether.`);
    return { x: x0, y: y0, z: z0 };
}
