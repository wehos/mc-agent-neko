// freeBot — EMERGENCY one-shot: undo a bot-trapping enclosure (e.g. a mis-built sealBedBunker that
// sealed her in with no exit). Removes the shell ABOVE the floor (keeps the floor so she doesn't fall)
// in a generous box around her current position, then restores sticky→missionNether. Day-safe.
import fs from 'fs';
import path from 'path';

export default async function freeBot(bot, ctx) {
    const { log } = ctx;
    const DIR = path.resolve(process.cwd(), 'bots', '_supervisor');
    try { fs.writeFileSync(path.join(DIR, 'sticky_skill.json'), JSON.stringify({ skill: 'missionNether', args: [] })); } catch (e) {}
    try { bot.interrupt_code = false; } catch (e) {}

    const p = bot.entity.position.floored();
    const x = p.x, y = p.y, z = p.z;
    // ★AGGRESSIVE liberation (v1's 9x9 didn't free her — frame still showed full cobble box).
    // 1) lay a guaranteed SOLID FLOOR plate one below feet (so air-clearing can't drop her),
    // 2) clear a BIG 15x15x10 air dome from feet up (obliterates any wall/roof shell),
    // 3) /tp onto the floor center, resistance + day. She ends standing in open daylight air.
    const cmds = [
        `/fill ${x - 3} ${y - 1} ${z - 3} ${x + 3} ${y - 1} ${z + 3} minecraft:cobblestone`,
        `/fill ${x - 7} ${y} ${z - 7} ${x + 7} ${y + 9} ${z + 7} minecraft:air`,
        `/tp @s ${x} ${y} ${z}`,
        `/effect give @s minecraft:resistance 120 4`,
        `/time set day`,
    ];
    for (const c of cmds) {
        try { bot.interrupt_code = false; bot.chat(c); log(bot, `freeBot: ${c}`); } catch (e) { log(bot, `freeBot chat err ${e && e.message || e}`); }
        try { await new Promise(r => setTimeout(r, 500)); } catch (e) {}
    }
    log(bot, `freeBot: done — cleared enclosure around ${x},${y},${z}; bot freed.`);
    return true;
}
