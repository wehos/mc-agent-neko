// Hot-reloadable: build a REAL nether portal — place 10 obsidian by hand and light
// it with flint_and_steel. NO /setblock (task #9: the legit path, unlike
// buildNetherPortal.js which cheats). Then walk in and wait for the dimension swap.
//
// Geometry: vertical portal in the plane z=z0, interior 2 wide (x0..x0+1) x 3 tall.
// The bottom obsidian pair is sunk INTO the ground (replacing the ground blocks) so
// the interior floor is flush with the terrain — the bot walks straight in, no jump.
// Minimal 10-block frame (no corners); one temporary cobblestone is placed at a top
// corner so the top row has an adjacent face to build against, then left in place
// (corner blocks don't affect portal activation).
//
// Needs in inventory: obsidian x10, flint_and_steel x1, cobblestone x4+ (supports).
// Invoked via: {"skill":"realNetherPortal","args":[]}  (or from missionNether)
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] [portal] ${s}\n`); } catch (e) {} };

export default async function realNetherPortal(bot, ctx) {
    const { skills, world, Vec3, log } = ctx;
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const inNether = () => { try { return /nether/.test(bot.game.dimension); } catch (e) { return false; } };
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    if (inNether()) { prog('already in the nether'); return { entered: true }; }

    // ── Re-entrancy: a lit portal already standing nearby → just walk in. ──
    const findPortal = () => world.getNearestBlock(bot, 'nether_portal', 32);
    const enterPortal = async (pb) => {
        prog(`entering portal @ ${pb.position}`);
        try { await skills.goToPosition(bot, pb.position.x, pb.position.y, pb.position.z, 1); } catch (e) {}
        // Step INTO the portal block and stand still — the swap takes ~4s of contact.
        try { await bot.lookAt(pb.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
        bot.setControlState('forward', true);
        await wait(1500);
        bot.clearControlStates();
        for (let i = 0; i < 30; i++) {           // up to 15s for the dimension swap
            if (inNether()) { prog('★★★ DIMENSION SWAP — WE ARE IN THE NETHER ★★★'); log(bot, 'Entered the Nether!'); return true; }
            await wait(500);
        }
        prog('stood in portal but no dimension swap (yet)');
        return inNether();
    };
    const existing = findPortal();
    if (existing) { const ok = await enterPortal(existing); return { entered: ok, reused: true }; }

    if (has('obsidian') < 10) { prog(`need obsidian 10, have ${has('obsidian')} — abort`); return { entered: false, reason: 'obsidian' }; }
    if (has('flint_and_steel') < 1) { prog('no flint_and_steel — abort'); return { entered: false, reason: 'flint_and_steel' }; }

    // ── Site: 2 blocks in front (+z) of where we stand, on solid ground. ──
    const p = bot.entity.position.floored();
    const x0 = p.x, z0 = p.z + 2, gy = p.y - 1;   // gy = ground level (the block we stand on)
    prog(`building at interior-bottom ${x0},${gy},${z0} (obsidian=${has('obsidian')})`);

    const cells = {
        bottom: [[x0, gy, z0], [x0 + 1, gy, z0]],
        left:   [[x0 - 1, gy + 1, z0], [x0 - 1, gy + 2, z0], [x0 - 1, gy + 3, z0]],
        right:  [[x0 + 2, gy + 1, z0], [x0 + 2, gy + 2, z0], [x0 + 2, gy + 3, z0]],
        top:    [[x0, gy + 4, z0], [x0 + 1, gy + 4, z0]],
    };
    const interior = [];
    for (let dx = 0; dx <= 1; dx++) for (let dy = 1; dy <= 3; dy++) interior.push([x0 + dx, gy + dy, z0]);

    const digAt = async (x, y, z) => {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (b && b.name !== 'air' && b.name !== 'cave_air' && !/water|lava/.test(b.name)) {
            try { await bot.tool.equipForBlock(b); } catch (e) {}
            try { await bot.dig(b); } catch (e) {}
        }
    };
    const solidAt = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return b && b.boundingBox === 'block'; };
    const placeReal = async (type, x, y, z) => {
        if (bot.interrupt_code) return false;
        const want = type === 'obsidian' ? 'obsidian' : type;
        for (let t = 0; t < 3; t++) {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (b && b.name === want) return true;
            if (b && b.name !== 'air' && b.name !== 'cave_air') await digAt(x, y, z);
            try { await skills.placeBlock(bot, type, x, y, z, 'bottom', true); } catch (e) {}
            await wait(250);
        }
        const fin = bot.blockAt(new Vec3(x, y, z));
        return !!(fin && fin.name === want);
    };

    // ── Terrain prep: clear interior + frame airspace, support the column bases. ──
    for (const [x, y, z] of [...interior, ...cells.left, ...cells.right, ...cells.top]) await digAt(x, y, z);
    for (const [x, , z] of [[x0 - 1, 0, z0], [x0 + 2, 0, z0]]) {
        if (!solidAt(x, gy, z)) {
            if (has('cobblestone') < 1) { prog('no cobblestone for column support — abort'); return { entered: false, reason: 'cobble' }; }
            await placeReal('cobblestone', x, gy, z);
        }
    }

    // ── Frame: bottom (sunk into ground) → columns → temp top support → top row. ──
    let placed = 0, failed = [];
    const placeFrame = async (list) => {
        for (const [x, y, z] of list) {
            if (bot.interrupt_code) { prog('interrupted mid-build — bail (re-entrant, will resume)'); return false; }
            if (await placeReal('obsidian', x, y, z)) placed++;
            else failed.push(`${x},${y},${z}`);
        }
        return true;
    };
    for (const [x, y, z] of cells.bottom) await digAt(x, y, z);   // sink the bottom row
    if (!await placeFrame(cells.bottom)) return { entered: false, reason: 'interrupted' };
    if (!await placeFrame(cells.left)) return { entered: false, reason: 'interrupted' };
    if (!await placeFrame(cells.right)) return { entered: false, reason: 'interrupted' };
    if (!solidAt(x0 - 1, gy + 4, z0)) await placeReal('cobblestone', x0 - 1, gy + 4, z0);  // temp support for top row
    if (!await placeFrame(cells.top)) return { entered: false, reason: 'interrupted' };
    if (failed.length) { prog(`frame INCOMPLETE, failed cells: ${failed.join(' | ')} — abort light`); return { entered: false, reason: 'frame', failed }; }
    prog(`frame complete (${placed} obsidian placed)`);

    // ── Make sure the interior is clear, then light it. ──
    for (const [x, y, z] of interior) await digAt(x, y, z);
    const lightTargets = [
        [x0, gy, z0], [x0 + 1, gy, z0],            // top faces of the bottom row
        [x0 - 1, gy + 1, z0], [x0 + 2, gy + 1, z0], // inner faces of the columns
    ];
    let lit = false;
    for (const [x, y, z] of lightTargets) {
        try { await skills.equip(bot, 'flint_and_steel'); } catch (e) {}
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) continue;
        try { await bot.lookAt(b.position.offset(0.5, 1, 0.5), true); } catch (e) {}
        try { await bot.activateBlock(b); } catch (e) { prog(`activate err ${e.message}`); }
        await wait(1500);
        const inb = bot.blockAt(new Vec3(x0, gy + 1, z0));
        if (inb && inb.name === 'nether_portal') { lit = true; break; }
    }
    if (!lit) { prog('failed to light the portal — frame stands, will retry next pass'); return { entered: false, reason: 'light' }; }
    prog('★ portal LIT (real obsidian + flint_and_steel, no cheats)');
    log(bot, 'Nether portal built & lit — the real way.');

    // ── Walk in. ──
    const pb = bot.blockAt(new Vec3(x0, gy + 1, z0));
    const entered = pb ? await enterPortal(pb) : false;
    return { entered, built: true };
}
