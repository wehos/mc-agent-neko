// Hot-reloadable REAL skill: climb from deep underground back to the surface.
// goToSurface only PATHFINDS on a NON-digging movement set, so it can't punch through a
// ceiling and a bot sealed in a mine just loops failing (it got pinned at y23 in a 1-wide
// tunnel, unable to reach open ground to place a crafting table / remake a broken pickaxe).
// PRIMARY method here: drive the mineflayer pathfinder with DIGGING + towering ENABLED
// toward a high Y goal, so it carves a staircase up on its own (robust, no manual
// block-placement timing). FALLBACKS: dig straight-up headroom + pillarUp, then a manual
// jump-and-place pillar. Never opens a water/lava ceiling on the manual paths.
// Invoked: skills.customSkill(bot,'surfaceUp', targetY).  ctx = { skills, world, mc, Vec3, log }
import mfp from 'mineflayer-pathfinder';
import fs from 'fs';
import path from 'path';
const { goals, Movements } = mfp;
// Real-time debug log (appendFileSync, unbuffered) — skill log() goes to block-buffered
// stdout which the supervisor can't read for minutes, leaving surfaceUp un-debuggable.
const DBG = path.resolve(process.cwd(), 'bots', '_supervisor', 'surfaceUp.log');
const dbg = (s) => { try { fs.appendFileSync(DBG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

const OPEN = new Set(['air', 'cave_air', 'void_air']);
const NO_DIG = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const SCAFFOLD = ['cobblestone', 'dirt', 'cobbled_deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'stone', 'deepslate', 'gravel', 'netherrack'];
const STONY = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/;

export default async function surfaceUp(bot, ctx, targetY = 63) {
    const { skills, world, mc, Vec3, log } = ctx;
    const yNow = () => Math.floor(bot.entity.position.y);
    const scafCount = () => SCAFFOLD.reduce((s, n) => s + (world.getInventoryCounts(bot)[n] || 0), 0);
    const hasPick = () => bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
    const heldIsPick = () => !!(bot.heldItem && /_pickaxe$/.test(bot.heldItem.name));
    const plannedNoPickStone = () => Date.now() < (bot._plannedNoPickStoneUntil || 0);
    const ensurePickForStone = async (block, why = '') => {
        if (!block || !STONY.test(block.name || '')) return true;
        if (!hasPick()) return plannedNoPickStone();
        if (heldIsPick()) return true;
        const pick = bot.inventory.items().find(it => /_pickaxe$/.test(it.name));
        try { if (pick) await bot.equip(pick, 'hand'); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
        if (heldIsPick()) return true;
        try { await bot.tool.equipForBlock(block); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
        if (heldIsPick()) return true;
        dbg(`stone dig blocked: no pick actually held for ${block.name}${why ? ' ' + why : ''} held=${bot.heldItem ? bot.heldItem.name : 'empty'}`);
        return false;
    };
    const guardedDig = async (block, why = '') => {
        if (!block) return false;
        if (!(await ensurePickForStone(block, why))) return false;
        if (!STONY.test(block.name || '')) { try { await bot.tool.equipForBlock(block); } catch (e) {} }
        try { await bot.dig(block); return true; } catch (e) { return false; }
    };
    dbg(`ENTER y=${yNow()} target=${targetY} scaffold=${scafCount()} goalY=${typeof (goals.GoalY || goals.GoalYLevel)}`);
    if (yNow() >= targetY) { dbg('already at/above target'); return true; }

    // FREEZE the interrupting survival modes for the whole climb. At low HP (~5, after a
    // rough dive) self_preservation FLEES every tick and grabs the pathfinder, which
    // cancelled surfaceUp's climb goto instantly ("goal was changed before it could be
    // completed") — the bot then sat at y23 forever. Tick modes fighting us is the real
    // reason it couldn't surface, not pillarUp. Disable them while we climb; restore after.
    const GUARD = ['mobility', 'self_preservation', 'self_defense', 'item_collecting', 'unstuck', 'hunting', 'cowardice', 'idle_staring', 'elbow_room', 'torch_placing', 'auto_eat'];
    const prevModes = {};
    try { for (const m of GUARD) if (bot.modes && bot.modes.exists && bot.modes.exists(m)) { prevModes[m] = bot.modes.isOn(m); bot.modes.setOn(m, false); } } catch (e) {}
    try { bot.clearControlStates(); } catch (e) {}
    dbg(`modes frozen: ${Object.keys(prevModes).join(',')}`);
    try {
      await climbToSurface();
    } finally {
      try { for (const m in prevModes) bot.modes.setOn(m, prevModes[m]); } catch (e) {}
    }
    dbg(`EXIT y=${yNow()} (target ${targetY})`);
    log(bot, `surfaceUp done: y=${yNow()} (target ${targetY}).`);
    return yNow() >= targetY - 2;

    async function climbToSurface() {
    // ---- PRIMARY: pathfinder carves a staircase up (digging allowed) --------------
    try {
        const moves = new Movements(bot);
        // No-pick pathfinding must be route-finding, not a hidden bare-hand stone miner.
        // Dirt/gravel cleanup is left to the manual fallback below; stone without a pick
        // is too slow and drops nothing, which caused the live famine surfacing deadlock.
        moves.canDig = hasPick();
        moves.allow1by1towers = true;
        moves.allowParkour = false;
        const scaf = SCAFFOLD.map(n => mc.getBlockId(n)).filter(id => id != null);
        if (scaf.length) moves.scafoldingBlocks = scaf;
        bot.pathfinder.setMovements(moves);
        const GoalY = goals.GoalY || goals.GoalYLevel;
        // Climb in short legs so A* never times out on a tall shaft; stop early if stuck.
        let stall = 0;
        while (yNow() < targetY && stall < 4) {
            if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} }
            const y0 = yNow();
            const legY = Math.min(y0 + 8, targetY);
            let err = '';
            try { await bot.pathfinder.goto(new GoalY(legY)); }
            catch (e) { err = e.message; }
            dbg(`pf leg ${y0}->${yNow()} (goal ${legY}) stall=${stall}${err ? ' err=' + err : ''}`);
            if (yNow() <= y0) stall++; else stall = 0;
        }
    } catch (e) { dbg(`pf block threw: ${e.message}`); log(bot, `surfaceUp pathfinder leg err: ${e.message}`); }
    finally { try { bot.pathfinder.setGoal(null); } catch (e) {} }
    if (yNow() >= targetY - 2) { dbg(`reached y=${yNow()} via pathfinder`); log(bot, `surfaceUp: reached y=${yNow()} via pathfinder.`); return true; }
    dbg(`pathfinder phase done, still y=${yNow()} — entering fallback`);

    // ---- FALLBACK: dig straight-up headroom, then tower (pillarUp / manual) --------
    const seekHeadroomColumn = async () => {
        const open = (p) => {
            const b = bot.blockAt(p);
            return (!b || b.boundingBox !== 'block') && !(b && /water|lava/.test(b.name || ''));
        };
        const floor = (p) => {
            const b = bot.blockAt(p);
            return b && b.boundingBox === 'block' && !/lava/.test(b.name || '');
        };
        const m0 = bot.entity.position.floored();
        const candidates = [];
        for (let dx = -8; dx <= 8; dx++) {
            for (let dz = -8; dz <= 8; dz++) {
                const d = Math.abs(dx) + Math.abs(dz);
                if (d === 0 || d > 10) continue;
                const p = m0.offset(dx, 0, dz);
                if (!open(p) || !open(p.offset(0, 1, 0)) || !floor(p.offset(0, -1, 0))) continue;
                let clear = 0;
                for (let up = 2; up <= 10; up++) {
                    if (!open(p.offset(0, up, 0))) break;
                    clear++;
                }
                if (clear < 2) continue;
                candidates.push({ p, d, clear });
            }
        }
        candidates.sort((a, b) => (b.clear - a.clear) || (a.d - b.d));
        for (const c of candidates.slice(0, 6)) {
            dbg(`headroom candidate @${c.p.x},${c.p.y},${c.p.z} clear=${c.clear} d=${c.d}`);
            try {
                await Promise.race([
                    skills.goToPosition(bot, c.p.x + 0.5, c.p.y, c.p.z + 0.5, 0),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('headroom route timeout')), 6000)),
                ]);
            } catch (e) {
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                dbg(`headroom route failed @${c.p.x},${c.p.y},${c.p.z}: ${e.message}`);
                continue;
            }
            const here = bot.entity.position.floored();
            if (Math.abs(here.x - c.p.x) <= 1 && Math.abs(here.z - c.p.z) <= 1) {
                dbg(`headroom reached @${here.x},${here.y},${here.z} clear=${c.clear}`);
                return true;
            }
        }
        dbg(`headroom no candidates from @${m0.x},${m0.y},${m0.z}`);
        return false;
    };
    let headroomFound = false;
    if (!hasPick() && await seekHeadroomColumn()) {
        headroomFound = true;
        dbg(`headroom seek succeeded, retrying vertical climb from y=${yNow()}`);
    }
    let plannedStoneBreaches = 0;
    const manualPillar = async () => {
        const name = SCAFFOLD.find(n => (world.getInventoryCounts(bot)[n] || 0) > 0);
        if (!name) return false;
        try { await skills.equip(bot, name); } catch (e) {}
        const y0 = yNow();
        const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (!ref) return false;
        try {
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 280));
            try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); } catch (e) {}
            bot.setControlState('jump', false);
        } catch (e) { try { bot.setControlState('jump', false); } catch (_) {} }
        await new Promise(r => setTimeout(r, 250));
        return yNow() > y0;
    };
    const scaffoldStep = async () => {
        const name = SCAFFOLD.find(n => (world.getInventoryCounts(bot)[n] || 0) > 0);
        if (!name) return false;
        const open = (p) => {
            const b = bot.blockAt(p);
            return (!b || b.boundingBox !== 'block') && !(b && /water|lava/.test(b.name || ''));
        };
        const y0 = yNow();
        const m = bot.entity.position.floored();
        for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
            const foot = m.offset(dx, 0, dz);
            if (!open(foot) || !open(m.offset(dx, 1, dz)) || !open(m.offset(dx, 2, dz))) continue;
            const bp = bot.entity.position;
            if (Math.hypot(bp.x - (foot.x + 0.5), bp.z - (foot.z + 0.5)) < 0.85) continue;
            let ref = bot.blockAt(m.offset(dx, -1, dz)), face = Vec3 ? new Vec3(0, 1, 0) : null;
            if (!(ref && ref.boundingBox === 'block')) {
                ref = bot.blockAt(m.offset(0, -1, 0));
                face = Vec3 ? new Vec3(dx, 0, dz) : null;
            }
            if (!(ref && ref.boundingBox === 'block') || !face) continue;
            try { await bot.equip(bot.inventory.items().find(it => it.name === name), 'hand'); } catch (e) {}
            try { await bot.placeBlock(ref, face); } catch (e) { continue; }
            try { await bot.lookAt(m.offset(dx + 0.5, 1.6, dz + 0.5), true); } catch (e) {}
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 1000));
            try { bot.clearControlStates(); } catch (e) {}
            await new Promise(r => setTimeout(r, 200));
            if (yNow() > y0) {
                dbg(`scaffold-step ${name} d=${dx},${dz} rose ${y0}->${yNow()}`);
                return true;
            }
        }
        return false;
    };
    for (let i = 0; i < 80 && yNow() < targetY; i++) {
        try { bot.interrupt_code = false; } catch (e) {}
        const y0 = yNow();
        let opened = 0;
        let verticalBlocked = false;
        for (let h = 2; h <= 4; h++) {
            const c = bot.blockAt(bot.entity.position.offset(0, h, 0));
            if (!c) { opened++; continue; }
            if (NO_DIG.has(c.name)) break;
            if (!OPEN.has(c.name)) {
                if (!hasPick() && STONY.test(c.name)) {
                    if (!headroomFound && plannedStoneBreaches < 2) {
                        dbg(`planned no-pick ceiling breach ${plannedStoneBreaches + 1}/2 at h=${h} name=${c.name}`);
                        try { bot._plannedNoPickStoneUntil = Date.now() + 15000; } catch (e) {}
                        await guardedDig(c, 'planned-ceiling');
                        plannedStoneBreaches++;
                    } else {
                        verticalBlocked = true;
                        dbg(`fallback no-pick stone blocked at h=${h} name=${c.name}`);
                        break;
                    }
                } else {
                    await guardedDig(c, 'fallback');
                }
            }
            opened++;
        }
        if ((verticalBlocked || opened < 2) && await scaffoldStep()) continue;
        try { await skills.pillarUp(bot, Math.min(y0 + Math.max(2, opened), targetY)); } catch (e) {}
        if (yNow() <= y0) {
            let rose = false;
            for (let m = 0; m < 3 && !rose; m++) rose = await manualPillar();
            dbg(`fallback iter ${i}: opened=${opened} y ${y0}->${yNow()} manualRose=${rose}`);
            if (!rose) break;
        } else { dbg(`fallback iter ${i}: pillarUp rose ${y0}->${yNow()}`); }
    }
    } // end climbToSurface
}
