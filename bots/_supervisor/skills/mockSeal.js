// mockSeal — DETERMINISTIC one-shot TEST for T-0074 (C341 sealed-room escape). User-directed.
// v2: the perimeter-fill v1 didn't reliably seal her (built around a water/cave roaming spot → leaks
// → C341 never saw a sealed room → inconclusive). v2 GUARANTEES the test condition: /fill a SOLID
// cobble cube around her, THEN carve a 3x3x2 air room at the center. Result: she stands in a fully
// walled 3x3 room with interior air (→ exits>0 → classifies FREE → the EXACT C341 mislabel case).
// Forces daylight + resistance (pure escape test, no mob death). Does NOT touch spawnpoint.
// args[0] = interior half-width (default 1 → 3x3 room; 2 → 5x5). Restores sticky→missionNether.
import fs from 'fs';
import path from 'path';

export default async function mockSeal(bot, ctx) {
    const { log } = ctx;
    const DIR = path.resolve(process.cwd(), 'bots', '_supervisor');
    try { fs.writeFileSync(path.join(DIR, 'sticky_skill.json'), JSON.stringify({ skill: 'missionNether', args: [] })); } catch (e) {}
    try { bot.interrupt_code = false; } catch (e) {}

    const IH = (ctx && ctx.args && Number(ctx.args[0])) || 1;   // interior half-width: 1→3x3 room, 2→5x5
    const SURFACE = !!(ctx && ctx.args && ctx.args[1]);          // surface test: tp UP into open sky first
    // pin her still + protect, capture center
    try { bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop(); bot.clearControlStates(); } catch (e) {}
    // ★surface enc-edge test: tp her HIGH into open air (above terrain) so the box's ±4 enc-probe columns
    // see open sky → enc=false → tests whether C341's `&& enc` gate skips a SURFACE sealed box (the
    // original bunker geometry that trapped her at y67). Underground boxes already validated (enc=true).
    if (SURFACE) {
        const p0 = bot.entity.position.floored();
        try { bot.chat(`/tp @s ${p0.x} ${p0.y + 40} ${p0.z}`); } catch (e) {}
        try { await new Promise(r => setTimeout(r, 1200)); } catch (e) {}
    }
    const p = bot.entity.position.floored();
    const x = p.x, y = p.y, z = p.z;
    const W = IH + 2;   // solid cube extends 2 past the interior so walls are ≥2 thick (no leaks)
    const cmds = [
        `/time set day`,
        `/effect give @s minecraft:resistance 300 4`,
        `/tp @s ${x} ${y} ${z}`,
        // 1) SOLID cobble cube (floor y-1 .. roof y+2, full block) — guarantees no terrain gap/water
        `/fill ${x - W} ${y - 1} ${z - W} ${x + W} ${y + 2} ${z + W} minecraft:cobblestone`,
        // 2) carve the interior room: IH-radius footprint, 2 high (y..y+1) → she stands in walled air
        `/fill ${x - IH} ${y} ${z - IH} ${x + IH} ${y + 1} ${z + IH} minecraft:air`,
        // 3) re-tp to dead center of the carved room (the cube fill may have shoved her)
        `/tp @s ${x} ${y} ${z}`,
    ];
    for (const c of cmds) {
        try { bot.interrupt_code = false; bot.chat(c); log(bot, `mockSeal: ${c}`); } catch (e) {}
        try { await new Promise(r => setTimeout(r, 700)); } catch (e) {}
    }
    log(bot, `mockSeal: ★SEALED ${IH * 2 + 1}x${IH * 2 + 1} room @${x},${y},${z} (solid cube + carved air). Observe: does C341 flip mob→SEALED and mine her out? (daylight+resistance, no death risk)`);
    return true;
}
