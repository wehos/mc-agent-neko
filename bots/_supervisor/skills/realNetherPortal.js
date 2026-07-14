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
    const findPortal = async () => await world.getNearestBlockAsync(bot, 'nether_portal', 64);
    const enterPortal = async (pb) => {
        prog(`entering portal @ ${pb.position}`);
        try { await skills.goToPosition(bot, pb.position.x, pb.position.y, pb.position.z, 1); } catch (e) {}
        // Step INTO the portal block and stand still — the swap takes ~4s of contact.
        // ★2026-07-05 预审 P1: 盲走 1500ms ≈ 6.4 格, 直接穿过 1 格厚的门框平面走到门背面 —
        // 换维度要连续站在 portal 方块内 80 tick。改条件停止: 50ms 步长轮询脚/头是否已在
        // nether_portal 内, 命中即停(上限 2s); 首轮未命中回身再试一轮(可能穿过去了)。
        try { await bot.lookAt(pb.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
        const feetInPortal = () => {
            try {
                const p = bot.entity.position;
                const f = bot.blockAt(p); const h = bot.blockAt(p.offset(0, 1, 0));
                return (f && f.name === 'nether_portal') || (h && h.name === 'nether_portal');
            } catch (e) { return false; }
        };
        for (let attempt = 0; attempt < 2 && !feetInPortal(); attempt++) {
            bot.setControlState('forward', true);
            for (let t = 0; t < 40 && !feetInPortal(); t++) await wait(50);   // ≤2s
            bot.clearControlStates();
            if (!feetInPortal()) { try { await bot.lookAt(pb.position.offset(0.5, 0.5, 0.5), true); } catch (e) {} }   // 穿过去了→回身
        }
        bot.clearControlStates();
        for (let i = 0; i < 30; i++) {           // up to 15s for the dimension swap
            if (inNether()) { prog('★★★ DIMENSION SWAP — WE ARE IN THE NETHER ★★★'); log(bot, 'Entered the Nether!'); return true; }
            await wait(500);
        }
        prog('stood in portal but no dimension swap (yet)');
        return inNether();
    };
    // Persist the lit-portal anchor to endgame.json (shared egPatch: file∪cache∪patch, atomic
    // write) — building consumes the 10 obsidian, so without a persisted location ENTER_NETHER
    // could never re-enter after a nether death and the chain re-mined a full lava-pool kit
    // while the lit portal stood right there (review world_model:598/:600). Anchoring also
    // clears the dead-anchor memo below: we KNOW a lit portal stands here now.
    const anchorPortal = (pos) => {
        try { skills.egPatch(bot, { netherPortalOverworld: { x: pos.x, y: pos.y, z: pos.z } }); } catch (e) {}
        bot._portalAnchorMissAt = 0;
    };

    const existing = await findPortal();
    if (existing) {
        anchorPortal(existing.position);
        const ok = await enterPortal(existing);
        return { entered: ok, reused: true, failed: !ok };
    }

    // ── Persisted anchor beyond the 32-block scan → walk back and reuse it (review :598/:600:
    //    the in-file reuse only covered a portal within 32 blocks, so a far respawn/migration
    //    forced the fresh-10-obsidian path even with a standing lit portal). ──
    const anchor = (() => { try { return (skills.egRead(bot) || {}).netherPortalOverworld; } catch (e) { return null; } })();
    if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.z)
        && !(bot._portalAnchorMissAt && Date.now() - bot._portalAnchorMissAt < 600000)) {   // dead-anchor memo (bot._*, hot-reload safe): don't re-march to a portal we just found missing
        const ay = Number.isFinite(anchor.y) ? anchor.y : bot.entity.position.y;
        const dist = () => bot.entity.position.distanceTo(new Vec3(anchor.x, ay, anchor.z));
        if (dist() > 24) {
            prog(`persisted portal anchor @ ${anchor.x},${ay},${anchor.z} (${Math.round(dist())}b away) — walking back to reuse it`);
            // Bounded legs, each raced against a 60s cap (goToPosition has no deadline of its own
            // and a cross-country path can wedge); bail on interrupt/death or a no-headway leg.
            // Worst case ~6min — still far cheaper than an 8-min lava re-mine + fresh build.
            let lastD = dist();
            for (let leg = 0; leg < 6 && dist() > 24; leg++) {
                if (bot.interrupt_code || bot.health <= 0) break;
                await Promise.race([
                    skills.goToPosition(bot, anchor.x, ay, anchor.z, 8).catch(() => {}),
                    skills.wait(bot, 60000),                       // interrupt-aware cap
                ]);
                try { bot.pathfinder.stop(); } catch (e) {}
                await wait(300);                                   // let a raced-out goto settle before re-goaling
                const d = dist();
                if (lastD - d < 4) break;                          // no headway (wall/ocean) — stop burning budget
                lastD = d;
            }
        }
        const back = await findPortal();
        if (back) {
            anchorPortal(back.position);                           // refresh — portal may sit a few blocks off the stale anchor
            const ok = await enterPortal(back);
            return { entered: ok, reused: true, failed: !ok };
        }
        // ── Frame stands but UNLIT (ghast broke the portal blocks; obsidian survives)?
        //    A zero-cost flint_and_steel relight beats memo-miss → fresh 10-obsidian build
        //    (which we usually can't afford — the first build consumed the kit). Mirror the
        //    build path's lighting idiom: activate the top face of the block UNDER the
        //    anchored interior cell. blazeRods carries the same branch for the nether side.
        if (has('flint_and_steel') >= 1) {
            const cell = new Vec3(Math.floor(anchor.x), Math.floor(ay), Math.floor(anchor.z));
            const below = bot.blockAt(cell.offset(0, -1, 0));
            const inCell = bot.blockAt(cell);
            if (below && below.name === 'obsidian' && inCell && /^(air|cave_air|fire)$/.test(inCell.name)) {
                prog(`anchor frame stands unlit — attempting flint_and_steel relight @ ${cell}`);
                try { await skills.goToPosition(bot, cell.x, cell.y, cell.z, 3); } catch (e) {}
                for (let t = 0; t < 2 && !bot.interrupt_code && bot.health > 0; t++) {
                    try { await skills.equip(bot, 'flint_and_steel'); } catch (e) {}
                    try { await bot.lookAt(below.position.offset(0.5, 1, 0.5), true); } catch (e) {}
                    try { await bot.activateBlock(below); } catch (e) { prog(`relight activate err ${e.message}`); }
                    await wait(1500);
                    const relit = bot.blockAt(cell);
                    if (relit && relit.name === 'nether_portal') {
                        prog('★ anchor portal RELIT (flint_and_steel on the standing frame, zero obsidian spent)');
                        anchorPortal(relit.position);
                        const ok = await enterPortal(relit);
                        return { entered: ok, reused: true, relit: true, failed: !ok };
                    }
                }
                prog('relight failed — falling through to anchor-miss memo');
            }
        }
        // Anchor is stale (frame gone / unloaded / relight failed): memo the miss for 10min so
        // the kernel's 3 retry dispatches don't re-march here, then fall through to the build
        // path — its obsidian/flint gates keep the failed:true shape the kernel cooldown counts.
        bot._portalAnchorMissAt = Date.now();
        prog(`anchor miss — no lit nether_portal within 32 of ${anchor.x},${ay},${anchor.z}; falling through to build path`);
    }

    // failed:true = explicit dispatch-failure key the kernel's cooldown counts (kernel.js
    // no longer shape-sniffs entered===false — that collided with setupEndPortal's progress).
    if (has('obsidian') < 10) { prog(`need obsidian 10, have ${has('obsidian')} — abort`); return { entered: false, failed: true, reason: 'obsidian' }; }
    if (has('flint_and_steel') < 1) { prog('no flint_and_steel — abort'); return { entered: false, failed: true, reason: 'flint_and_steel' }; }

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
            if (has('cobblestone') < 1) { prog('no cobblestone for column support — abort'); return { entered: false, failed: true, reason: 'cobble' }; }
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
    if (!await placeFrame(cells.bottom)) return { entered: false, failed: true, reason: 'interrupted' };
    if (!await placeFrame(cells.left)) return { entered: false, failed: true, reason: 'interrupted' };
    if (!await placeFrame(cells.right)) return { entered: false, failed: true, reason: 'interrupted' };
    if (!solidAt(x0 - 1, gy + 4, z0)) await placeReal('cobblestone', x0 - 1, gy + 4, z0);  // temp support for top row
    if (!await placeFrame(cells.top)) return { entered: false, failed: true, reason: 'interrupted' };
    if (failed.length) { prog(`frame INCOMPLETE, failed cells: ${failed.join(' | ')} — abort light`); return { entered: false, failed: true, reason: 'frame', failedCells: failed }; }
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
    if (!lit) { prog('failed to light the portal — frame stands, will retry next pass'); return { entered: false, failed: true, reason: 'light' }; }
    prog('★ portal LIT (real obsidian + flint_and_steel, no cheats)');
    log(bot, 'Nether portal built & lit — the real way.');
    anchorPortal({ x: x0, y: gy + 1, z: z0 });   // persist the milestone BEFORE entering — survives the dimension swap/death

    // ── Walk in. ──
    const pb = bot.blockAt(new Vec3(x0, gy + 1, z0));
    const entered = pb ? await enterPortal(pb) : false;
    return { entered, built: true, failed: !entered };
}
