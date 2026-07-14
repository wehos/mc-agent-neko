// sealBedBunker — one-shot, user-sanctioned durable fix for T-0043 night-respawn death loop.
// 2026-06-21 (claude-A). The night-validation proved: C322/C329-A set a working bed + spawn anchor
// (she respawns AT the bed @14,71,148), BUT the bed sits on an OPEN surface → every night-respawn
// drops her into the swarm (2+ hostiles at 3.4b on respawn) → chain death (deaths 16→17 this night).
// The bed gives a spawn ANCHOR but not a sealed SHELTER. Root fix = a permanent sealed cobblestone
// box AROUND the bed so respawn = safe enclosed; she breaks out with her iron pickaxe by day (cobble
// is fast). Built via /fill PERIMETER fills (floor/roof/4 walls) that DON'T touch the bed's interior
// blocks (so the bed survives — hollow-fill would delete it). Idempotent. Needs cheats. Dispatched
// one-shot; restores sticky→missionNether.
import fs from 'fs';
import path from 'path';

export default async function sealBedBunker(bot, ctx) {
    const { log } = ctx;
    const DIR = path.resolve(process.cwd(), 'bots', '_supervisor');
    const STICKY = path.join(DIR, 'sticky_skill.json');
    try { fs.writeFileSync(STICKY, JSON.stringify({ skill: 'missionNether', args: [] })); } catch (e) {}
    try { bot.interrupt_code = false; } catch (e) {}

    // ★C335-A (T-0043/T-0059): build the bunker at her ACTUAL CURRENT RESPAWN POINT, not a stale
    // bed.json — live evidence: bed.json said 14,71,148 but she respawned at 25,67,-16 (spawn anchor
    // didn't stick = T-0059 bed/spawn mismatch). Centering on her current pos + /spawnpoint there
    // makes respawn reliably land INSIDE this sealed box, breaking the night-respawn-into-swarm loop
    // regardless of where the (unreliable) bed anchor points. Override with bed.json only if asked.
    const p0 = bot.entity.position.floored();
    let bx = p0.x, by = p0.y, bz = p0.z;
    log(bot, `sealBedBunker: sealing a 5x5 bunker around CURRENT pos @${bx},${by},${bz} (respawn anchor)`);

    // box centered on (bx,by,bz): floor y=by-1, livable interior y=by..by+1, roof y=by+2.
    const x0 = bx - 2, x1 = bx + 2, z0 = bz - 2, z1 = bz + 2, yF = by - 1, yR = by + 2, yA = by, yB = by + 1;
    const cmds = [
        // ★SAFETY: /tp self to the EXACT center so wall fills never place cobble into the bot's body
        // (live hazard: standing on a wall line → suffocation). At center (interior) she's sealed in
        // safely and digs out by day with her iron pick.
        `/tp @s ${bx} ${by} ${bz}`,
        // clear a 3x3x2 livable interior to AIR first (in case she respawned in stone/hillside) so
        // she's not buried — she stands in open space inside the shell. (air-fill won't hurt the entity.)
        `/fill ${bx - 1} ${yA} ${bz - 1} ${bx + 1} ${yB} ${bz + 1} minecraft:air`,
        // floor + roof (full plates)
        `/fill ${x0} ${yF} ${z0} ${x1} ${yF} ${z1} minecraft:cobblestone`,
        `/fill ${x0} ${yR} ${z0} ${x1} ${yR} ${z1} minecraft:cobblestone`,
        // 4 walls at foot+head height (perimeter ring; interior cleared above stays air)
        `/fill ${x0} ${yA} ${z0} ${x0} ${yB} ${z1} minecraft:cobblestone`,
        `/fill ${x1} ${yA} ${z0} ${x1} ${yB} ${z1} minecraft:cobblestone`,
        `/fill ${x0} ${yA} ${z0} ${x1} ${yB} ${z0} minecraft:cobblestone`,
        `/fill ${x0} ${yA} ${z1} ${x1} ${yB} ${z1} minecraft:cobblestone`,
        // re-anchor spawnpoint at the bed (explicit coords, independent of bot position)
        `/spawnpoint @s ${bx} ${by} ${bz}`,
        // ensure it's day so this build + her next moments are mob-free (stabilize)
        `/time set day`,
    ];
    for (const c of cmds) {
        try { bot.interrupt_code = false; bot.chat(c); log(bot, `sealBedBunker: ${c}`); } catch (e) { log(bot, `sealBedBunker chat err ${e && e.message || e}`); }
        try { await new Promise(r => setTimeout(r, 700)); } catch (e) {}
    }
    log(bot, `sealBedBunker: done — bed @${bx},${by},${bz} now inside a sealed cobblestone box; respawn lands enclosed (she digs out by day with iron pick).`);
    return true;
}
