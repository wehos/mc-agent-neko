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

export default async function surfaceUp(bot, ctx, targetY = 63) {
    const { skills, world, mc, Vec3, log } = ctx;
    const yNow = () => Math.floor(bot.entity.position.y);
    const scafCount = () => SCAFFOLD.reduce((s, n) => s + (world.getInventoryCounts(bot)[n] || 0), 0);
    dbg(`ENTER y=${yNow()} target=${targetY} scaffold=${scafCount()} goalY=${typeof (goals.GoalY || goals.GoalYLevel)}`);
    if (yNow() >= targetY) { dbg('already at/above target'); return true; }

    // FREEZE the interrupting survival modes for the whole climb. At low HP (~5, after a
    // rough dive) self_preservation FLEES every tick and grabs the pathfinder, which
    // cancelled surfaceUp's climb goto instantly ("goal was changed before it could be
    // completed") — the bot then sat at y23 forever. Tick modes fighting us is the real
    // reason it couldn't surface, not pillarUp. Disable them while we climb; restore after.
    const GUARD = ['self_preservation', 'self_defense', 'item_collecting', 'unstuck', 'hunting', 'cowardice', 'idle_staring', 'elbow_room', 'torch_placing', 'auto_eat'];
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
        moves.canDig = true;
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
    for (let i = 0; i < 80 && yNow() < targetY; i++) {
        try { bot.interrupt_code = false; } catch (e) {}
        const y0 = yNow();
        let opened = 0;
        for (let h = 2; h <= 4; h++) {
            const c = bot.blockAt(bot.entity.position.offset(0, h, 0));
            if (!c) { opened++; continue; }
            if (NO_DIG.has(c.name)) break;
            if (!OPEN.has(c.name)) { try { await bot.tool.equipForBlock(c); } catch (e) {} try { await bot.dig(c); } catch (e) {} }
            opened++;
        }
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
