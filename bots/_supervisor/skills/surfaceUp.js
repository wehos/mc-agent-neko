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
const NO_PICK_BREACHABLE = new Set(['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobbled_deepslate']);
const FOOD_RE = /cooked_|_bread|^bread$|^apple$|golden_apple|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|^cod$|^salmon$|melon_slice|sweet_berries|_stew|^rabbit$|baked_|rotten_flesh|spider_eye/;
const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
const FOOT_REPLACEABLE = new Set(['torch', 'wall_torch', 'redstone_torch', 'redstone_wall_torch', 'soul_torch', 'soul_wall_torch']);

export default async function surfaceUp(bot, ctx, targetY = 63) {
    const { skills, world, mc, Vec3, log } = ctx;
    const yNow = () => Math.floor(bot.entity.position.y);
    const scafCount = () => SCAFFOLD.reduce((s, n) => s + (world.getInventoryCounts(bot)[n] || 0), 0);
    const hasPick = () => bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
    const heldIsPick = () => !!(bot.heldItem && /_pickaxe$/.test(bot.heldItem.name));
    const inventoryCounts = () => {
        try { return world.getInventoryCounts(bot) || {}; } catch (e) { return {}; }
    };
    const ensureEmergencyPick = async () => {
        if (hasPick()) return true;
        const craftLocal = skills.craftRecipeLocal || skills.craftRecipe;
        const craftTimed = async (name, count = 1) => {
            await Promise.race([
                craftLocal(bot, name, count),
                new Promise((_, rej) => setTimeout(() => rej(new Error(`${name}-timeout`)), 12000)),
            ]);
        };
        const nearTable = () => {
            try {
                const t = world.getNearestBlock(bot, 'crafting_table', 4);
                return !!(t && t.position && bot.entity.position.distanceTo(t.position) <= 4.5);
            } catch (e) { return false; }
        };
        const ensureTable = async () => {
            let c = inventoryCounts();
            if ((c.crafting_table || 0) > 0 || nearTable()) return true;
            const plankName = WOOD_TYPES.map(w => `${w}_planks`).find(n => (c[n] || 0) >= 4);
            if (!plankName) {
                const logName = WOOD_TYPES.map(w => `${w}_log`).find(n => (c[n] || 0) > 0);
                if (logName) {
                    const pn = logName.replace(/_log$/, '_planks');
                    dbg(`emergency pick: crafting ${pn} for local table`);
                    await craftTimed(pn, 1);
                    c = inventoryCounts();
                }
            }
            const tablePlanks = WOOD_TYPES.map(w => `${w}_planks`).find(n => (c[n] || 0) >= 4);
            if (!tablePlanks) return false;
            dbg(`emergency pick: crafting local crafting_table from ${tablePlanks}`);
            await craftTimed('crafting_table', 1);
            return (inventoryCounts().crafting_table || 0) > 0 || nearTable();
        };
        try {
            await ensureTable().catch(e => dbg(`emergency pick table prep failed: ${e && e.message ? e.message : String(e)}`));
            const c = inventoryCounts();
            if ((c.cobblestone || 0) >= 3 && (c.stick || 0) >= 2) {
                dbg(`emergency pick: crafting stone_pickaxe before stone ceiling`);
                await craftTimed('stone_pickaxe', 1);
            } else if ((c.oak_planks || c.spruce_planks || c.birch_planks || c.jungle_planks || c.acacia_planks || c.dark_oak_planks || c.mangrove_planks || c.cherry_planks || 0) >= 3 && (c.stick || 0) >= 2) {
                dbg(`emergency pick: crafting wooden_pickaxe before stone ceiling`);
                await craftTimed('wooden_pickaxe', 1);
            }
        } catch (e) {
            dbg(`emergency pick failed: ${e && e.message ? e.message : String(e)}`);
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
        }
        return hasPick();
    };
    const famineEmergency = () => bot.food <= 2 && !bot.inventory.items().some(it => it && it.name && FOOD_RE.test(it.name));
    const famineNoPickStoneBreachOk = () => {
        if (!famineEmergency()) return false;
        if ((bot.health || 0) < 8) return false;
        try {
            const a = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'advisory.json'), 'utf8'));
            const ts = Number(a.ts || 0);
            if (!ts || Date.now() - ts > 45000) return false;
            const actionable = Number(a.actionableHostiles);
            const nearest = Number.isFinite(Number(a.actionableNearest)) ? Number(a.actionableNearest) : Number(a.nearest);
            if (!Number.isFinite(actionable)) return false;
            return actionable === 0 || (actionable <= 1 && Number.isFinite(nearest) && nearest > 5.5);
        } catch (e) {
            return false;
        }
    };
    const plannedNoPickStone = () => Date.now() < (bot._plannedNoPickStoneUntil || 0);
    const openAbove = (depth = 8) => {
        const p = bot.entity.position.floored();
        for (let dy = 1; dy <= depth; dy++) {
            const b = bot.blockAt(p.offset(0, dy, 0));
            if (b && /water|lava/.test(b.name || '')) return false;
            if (b && b.boundingBox === 'block' && !OPEN.has(b.name)) return false;
        }
        return true;
    };
    // Height alone is not surface. Live failure: y=62 inside a sealed hill pocket made
    // prepNether/feedUp loop forever. A climb is done only once the bot has real headroom.
    const surfaceReady = () => yNow() >= targetY - 2 && openAbove(8);
    const inWater = () => {
        try {
            const p = bot.entity.position.floored();
            const foot = bot.blockAt(p);
            const head = bot.blockAt(p.offset(0, 1, 0));
            return [foot, head].some(b => b && /water/.test(b.name || ''));
        } catch (e) { return false; }
    };
    const swimOutOfWater = async () => {
        if (!inWater()) return true;
        const y0 = yNow();
        dbg(`water escape: swim-up start y=${y0}`);
        try {
            bot.setControlState('jump', true);
            for (let i = 0; i < 80 && inWater(); i++) {
                await skills.wait(bot, 100);
                const p = bot.entity.position.floored();
                const above = bot.blockAt(p.offset(0, 2, 0));
                if (above && above.boundingBox === 'block' && !NO_DIG.has(above.name)) break;
            }
        } finally {
            try { bot.setControlState('jump', false); } catch (e) {}
        }
        dbg(`water escape: swim-up end y=${yNow()} wet=${inWater()} dy=${yNow() - y0}`);
        return !inWater();
    };
    const ensurePickForStone = async (block, why = '') => {
        if (!block || !STONY.test(block.name || '')) return true;
        if (!hasPick()) await ensureEmergencyPick();
        if (!hasPick()) return plannedNoPickStone();
        if (heldIsPick()) return true;
        const pick = bot.inventory.items().find(it => /_pickaxe$/.test(it.name));
        try { if (pick) await skills.equip(bot, pick.name); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
        if (heldIsPick()) return true;
        try { await bot.tool.equipForBlock(block); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
        if (heldIsPick()) return true;
        dbg(`stone dig blocked: no pick actually held for ${block.name}${why ? ' ' + why : ''} held=${bot.heldItem ? bot.heldItem.name : 'empty'}`);
        return false;
    };
    const motion = (event, data = {}) => {
        try {
            const p = bot.entity.position;
            fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                ts: new Date().toISOString(),
                event,
                pos: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) },
                skill: bot._currentSkill || 'surfaceUp',
                mob: bot._mobility ? bot._mobility.state : null,
                data,
            }) + '\n');
        } catch (e) {}
    };
    const envSnap = () => {
        const c = bot.entity.position.floored();
        const out = [];
        for (let dy = -1; dy <= 2; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const b = bot.blockAt(c.offset(dx, dy, dz));
                    out.push({ d: [dx, dy, dz], n: b ? b.name : null, bb: b ? b.boundingBox : null });
                }
            }
        }
        return out;
    };
    const blockName = (b) => b ? `${b.name}@${b.position.x},${b.position.y},${b.position.z}` : 'null';
    const guardedDig = async (block, why = '') => {
        if (!block) return false;
        const owner = `surfaceUp:${why || 'dig'}`;
        const acquire = async () => {
            const t0 = Date.now();
            while (Date.now() - t0 < 900) {
                const busy = bot.targetDigBlock
                    || bot._mineMotionActiveDig
                    || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil);
                if (!busy || bot._bodyDigLockOwner === owner) {
                    bot._bodyDigLockOwner = owner;
                    bot._bodyDigLockUntil = Date.now() + 6000;
                    return true;
                }
                await new Promise(r => setTimeout(r, 80));
            }
            motion('dig.slot.busy', {
                owner,
                target: `${block.name}@${block.position.x},${block.position.y},${block.position.z}`,
                heldBy: bot._bodyDigLockOwner || 'targetDigBlock',
            });
            return false;
        };
        if (!(await acquire())) return false;
        try {
            for (let n = 0; n < 2; n++) {
                const fresh = bot.blockAt(block.position);
                if (!fresh || fresh.boundingBox !== 'block') return true;
                if (!(await ensurePickForStone(fresh, why))) return false;
                if (!STONY.test(fresh.name || '')) { try { await bot.tool.equipForBlock(fresh); } catch (e) {} }
                try { bot.clearControlStates(); } catch (e) {}
                try { await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                try {
                    const timeoutMs = (!hasPick() && plannedNoPickStone() && STONY.test(fresh.name || '')) ? 12000 : 5000;
                    await Promise.race([
                        bot.dig(fresh, true),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('dig-timeout')), timeoutMs)),
                    ]);
                    return true;
                } catch (e) {
                    try { bot.stopDigging(); } catch (_) {}
                    motion('dig.retry', {
                        owner,
                        attempt: n,
                        target: `${fresh.name}@${fresh.position.x},${fresh.position.y},${fresh.position.z}`,
                        error: e && e.message ? e.message : String(e),
                    });
                    await new Promise(r => setTimeout(r, 140));
                }
            }
            return false;
        } finally {
            if (bot._bodyDigLockOwner === owner) {
                bot._bodyDigLockOwner = null;
                bot._bodyDigLockUntil = 0;
            }
        }
    };
    const stepEdgeAssist = async (why = 'pf-stall') => {
        if (bot.targetDigBlock || bot._mineMotionActiveDig || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil)) return false;
        const solid = (b) => b && b.boundingBox === 'block';
        const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow']);
        const open = (b) => !b || b.boundingBox === 'empty' || PASSABLE.has(b.name || '');
        const bad = (b) => b && /water|lava|fire|cactus|magma/.test(b.name || '');
        const stationStep = (b) => b && /crafting_table|furnace|blast_furnace|smoker|chest|barrel|bed|anvil|enchanting_table|grindstone|stonecutter|loom|cartography_table|smithing_table|fletching_table|lectern|composter/i.test(b.name || '');
        const blockName = (b) => b ? `${b.name}@${b.position.x},${b.position.y},${b.position.z}` : 'null';
        const clearableStepRoof = (b) => {
            if (!b || b.boundingBox !== 'block') return false;
            if (bad(b) || stationStep(b) || /bedrock|obsidian|end_portal|nether_portal/.test(b.name || '')) return false;
            const stony = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|cobble/.test(b.name || '');
            return !stony || hasPick();
        };
        const p0 = bot.entity.position.clone();
        const cell = p0.floored();
        const ownHead = bot.blockAt(cell.offset(0, 1, 0));
        let ownAbove = bot.blockAt(cell.offset(0, 2, 0));
        if (!open(ownHead)) {
            motion('surfaceUp.step_edge.blocked', {
                why,
                reason: 'own-head-blocked',
                ownHead: blockName(ownHead),
                ownAbove: blockName(ownAbove),
                env: envSnap(),
            });
            return false;
        }
        if (!open(ownAbove)) {
            const clearable = clearableStepRoof(ownAbove);
            motion('surfaceUp.step_edge.own_above_notch.begin', {
                why,
                clearable,
                block: blockName(ownAbove),
                env: envSnap(),
            });
            let ok = false;
            let error = null;
            if (clearable) {
                try {
                    ok = await guardedDig(ownAbove, 'own-above-notch');
                    await skills.wait(bot, 120);
                    ownAbove = bot.blockAt(cell.offset(0, 2, 0));
                    ok = ok && open(ownAbove);
                } catch (e) {
                    error = e && e.message ? e.message : String(e);
                }
            }
            motion('surfaceUp.step_edge.own_above_notch.end', {
                why,
                ok,
                error,
                after: blockName(ownAbove),
                env: envSnap(),
            });
            if (!ok) return false;
        }
        const yaw = bot.entity.yaw || 0;
        const yawDx = Math.abs(Math.sin(yaw)) >= Math.abs(Math.cos(yaw)) ? (Math.sign(-Math.sin(yaw)) || 1) : 0;
        const yawDz = yawDx ? 0 : (Math.sign(Math.cos(yaw)) || 1);
        const candidates = [];
        for (const [dx, dz] of [[yawDx, yawDz], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (!dx && !dz) continue;
            if (candidates.some(c => c.dx === dx && c.dz === dz)) continue;
            const foot = bot.blockAt(cell.offset(dx, 0, dz));
            const head = bot.blockAt(cell.offset(dx, 1, dz));
            const above = bot.blockAt(cell.offset(dx, 2, dz));
            const below = bot.blockAt(cell.offset(dx, -1, dz));
            if (!solid(foot) || stationStep(foot) || !open(head) || !open(above) || bad(foot) || bad(head) || bad(above)) continue;
            const align = (dx === yawDx && dz === yawDz) ? 0 : 1;
            const dist = Math.hypot(p0.x - (cell.x + dx + 0.5), p0.z - (cell.z + dz + 0.5));
            candidates.push({ dx, dz, foot, head, above, below, align, dist });
        }
        candidates.sort((a, b) => (a.align - b.align) || (a.dist - b.dist));
        for (const c of candidates.slice(0, 2)) {
            const target = cell.offset(c.dx, 0, c.dz);
            dbg(`step-edge assist begin ${why} dir=${c.dx},${c.dz} target=${target.x},${target.y},${target.z} step=${blockName(c.foot)} head=${blockName(c.head)} above=${blockName(c.above)} below=${blockName(c.below)}`);
            try {
                fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                    ts: new Date().toISOString(),
                    event: 'surfaceUp.step_edge.begin',
                    pos: { x: +p0.x.toFixed(3), y: +p0.y.toFixed(3), z: +p0.z.toFixed(3) },
                    skill: bot._currentSkill || 'surfaceUp',
                    mob: bot._mobility ? bot._mobility.state : null,
                    env: envSnap(),
                    data: { why, dir: [c.dx, c.dz], target: { x: target.x, y: target.y, z: target.z }, step: blockName(c.foot), head: blockName(c.head), above: blockName(c.above), below: blockName(c.below) },
                }) + '\n');
            } catch (e) {}
            try {
                bot._bodyMoveLockOwner = 'surfaceUp:step-edge';
                bot._bodyMoveLockUntil = Date.now() + 3600;
                let maxY = p0.y;
                let p1 = bot.entity.position.clone();
                let ok = false;
                const targetDist = (p) => Math.hypot(p.x - (target.x + 0.5), p.z - (target.z + 0.5));
                const roseEnough = (p) => Math.floor(p.y) > cell.y || p.y > p0.y + 0.72;
                const settledInTarget = (p) => Math.floor(p.x) === target.x && Math.floor(p.z) === target.z && targetDist(p) <= 0.9;
                const stepSucceeded = (p) => roseEnough(p) && settledInTarget(p);
                for (const phase of ['press', 'runup']) {
                    const start = bot.entity.position.clone();
                    if (phase === 'runup') {
                        try { bot.clearControlStates(); } catch (e) {}
                        try { await bot.lookAt(target.offset(0.5, 1.05, 0.5), true); } catch (e) {}
                        bot.setControlState('sneak', true);
                        bot.setControlState('back', true);
                        await skills.wait(bot, 220);
                        try { bot.clearControlStates(); } catch (e) {}
                        await skills.wait(bot, 80);
                        try {
                            fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                                ts: new Date().toISOString(),
                                event: 'surfaceUp.step_edge.runup',
                                pos: { x: +bot.entity.position.x.toFixed(3), y: +bot.entity.position.y.toFixed(3), z: +bot.entity.position.z.toFixed(3) },
                                skill: bot._currentSkill || 'surfaceUp',
                                mob: bot._mobility ? bot._mobility.state : null,
                                data: { why, dir: [c.dx, c.dz], from: { x: +start.x.toFixed(3), y: +start.y.toFixed(3), z: +start.z.toFixed(3) } },
                            }) + '\n');
                        } catch (e) {}
                    }
                    try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                    try { bot.clearControlStates(); } catch (e) {}
                    await bot.lookAt(target.offset(0.5, phase === 'runup' ? 1.05 : 1.25, 0.5), true);
                    bot.setControlState('sprint', false);
                    bot.setControlState('forward', true);
                    bot.setControlState('jump', true);
                    const t0 = Date.now();
                    while (Date.now() - t0 < (phase === 'runup' ? 1100 : 820)) {
                        const p = bot.entity.position;
                        if (p.y > maxY) maxY = p.y;
                        if (stepSucceeded(p)) break;
                        await skills.wait(bot, 45);
                    }
                    try { bot.clearControlStates(); } catch (e) {}
                    await skills.wait(bot, 120);
                    p1 = bot.entity.position.clone();
                    ok = stepSucceeded(p1);
                    if (ok) break;
                }
                if (!ok && roseEnough(p1) && !settledInTarget(p1)) {
                    try {
                        fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                            ts: new Date().toISOString(),
                            event: 'surfaceUp.step_edge.edge_miss',
                            pos: { x: +p1.x.toFixed(3), y: +p1.y.toFixed(3), z: +p1.z.toFixed(3) },
                            skill: bot._currentSkill || 'surfaceUp',
                            mob: bot._mobility ? bot._mobility.state : null,
                            env: envSnap(),
                            data: {
                                why,
                                dir: [c.dx, c.dz],
                                target: { x: target.x, y: target.y, z: target.z },
                                floor: { x: Math.floor(p1.x), y: Math.floor(p1.y), z: Math.floor(p1.z) },
                                targetDist: +targetDist(p1).toFixed(3),
                                recovery: 'center-press',
                            },
                        }) + '\n');
                    } catch (e) {}
                    try {
                        await bot.lookAt(target.offset(0.5, 1.15, 0.5), true);
                        bot.setControlState('sprint', false);
                        bot.setControlState('jump', false);
                        bot.setControlState('forward', true);
                        await skills.wait(bot, 420);
                    } finally {
                        try { bot.clearControlStates(); } catch (e) {}
                    }
                    await skills.wait(bot, 120);
                    p1 = bot.entity.position.clone();
                    ok = stepSucceeded(p1);
                }
                dbg(`step-edge assist end ok=${ok} y=${p0.y.toFixed(2)}->${p1.y.toFixed(2)} maxRise=${(maxY - p0.y).toFixed(2)} dist=${targetDist(p1).toFixed(2)} settled=${settledInTarget(p1)}`);
                try {
                    fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                        ts: new Date().toISOString(),
                        event: 'surfaceUp.step_edge.end',
                        pos: { x: +p1.x.toFixed(3), y: +p1.y.toFixed(3), z: +p1.z.toFixed(3) },
                        skill: bot._currentSkill || 'surfaceUp',
                        mob: bot._mobility ? bot._mobility.state : null,
                        env: envSnap(),
                        data: { ok, why, dir: [c.dx, c.dz], maxRise: +(maxY - p0.y).toFixed(3), targetDist: +targetDist(p1).toFixed(3), settledInTarget: settledInTarget(p1) },
                    }) + '\n');
                } catch (e) {}
                if (ok) return true;
            } catch (e) {
                try { bot.clearControlStates(); } catch (e2) {}
                dbg(`step-edge assist err ${e.message}`);
            } finally {
                if (bot._bodyMoveLockOwner === 'surfaceUp:step-edge') {
                    bot._bodyMoveLockOwner = null;
                    bot._bodyMoveLockUntil = 0;
                }
            }
        }
        return false;
    };
    dbg(`ENTER y=${yNow()} target=${targetY} scaffold=${scafCount()} goalY=${typeof (goals.GoalY || goals.GoalYLevel)}`);
    if (surfaceReady()) { dbg('already at open surface'); return true; }

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
    return surfaceReady();

    async function climbToSurface() {
    if (inWater()) {
        await swimOutOfWater();
        if (inWater()) {
            dbg(`water escape: still wet at y=${yNow()}, aborting surfaceUp to avoid underwater dig/place loop`);
            return false;
        }
    }
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
        const climbLeg = async (GoalY, legY) => {
            bot.pathfinder.setGoal(new GoalY(legY));
            const started = Date.now();
            let last = bot.entity.position.clone();
            let quiet = 0;
            let assisted = false;
            while (!surfaceReady() && yNow() < legY && Date.now() - started < 30000) {
                await skills.wait(bot, 700);
                if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} }
                const p = bot.entity.position.clone();
                const moved = p.distanceTo(last);
                const pathing = !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving());
                if (moved < 0.18 && !bot.targetDigBlock && !bot._mineMotionActiveDig) quiet++;
                else quiet = 0;
                if (quiet >= 3) {
                    const ok = await stepEdgeAssist(`leg-${legY}-quiet${quiet}`);
                    assisted = assisted || ok;
                    quiet = 0;
                    if (ok) {
                        bot.pathfinder.setGoal(new GoalY(legY));
                    } else if (!pathing && Date.now() - started > 2500) {
                        break;
                    } else if (Date.now() - started > 8000) {
                        break;
                    }
                }
                last = p;
            }
            try { bot.pathfinder.setGoal(null); } catch (e) {}
            return assisted;
        };
        // Climb in short legs so A* never times out on a tall shaft; monitor each leg
        // for the live "pathing but no controls / no movement" stair-edge stall.
        let stall = 0;
        while (!surfaceReady() && yNow() < targetY && stall < 4) {
            if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} }
            const y0 = yNow();
            const legY = Math.min(y0 + 8, targetY);
            let err = '';
            let assisted = false;
            try { assisted = await climbLeg(GoalY, legY); }
            catch (e) { err = e.message; }
            dbg(`pf leg ${y0}->${yNow()} (goal ${legY}) stall=${stall}${assisted ? ' assisted=1' : ''}${err ? ' err=' + err : ''}`);
            if (yNow() <= y0) stall++; else stall = 0;
        }
    } catch (e) { dbg(`pf block threw: ${e.message}`); log(bot, `surfaceUp pathfinder leg err: ${e.message}`); }
    finally { try { bot.pathfinder.setGoal(null); } catch (e) {} }
    if (surfaceReady()) { dbg(`reached open surface y=${yNow()} via pathfinder`); log(bot, `surfaceUp: reached open surface y=${yNow()} via pathfinder.`); return true; }
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
    const plannedStoneLimit = famineEmergency() ? 200 : 2;
    const canPlanNoPickStoneBreach = (block, h) => {
        if (!block || !NO_PICK_BREACHABLE.has(block.name || '')) return false;
        if (plannedStoneBreaches >= plannedStoneLimit) return false;
        if (h > 3 && !famineEmergency()) return false;
        const famineBreach = famineNoPickStoneBreachOk();
        if (!famineBreach && ((bot.health || 0) < 16 || bot.food < 14)) return false;
        if (!stableFloorBelow()) return false;
        const cell = bot.entity.position.floored();
        for (const off of [[0, 0, 0], [0, 1, 0], [0, -1, 0]]) {
            const b = bot.blockAt(cell.offset(off[0], off[1], off[2]));
            if (b && /water|lava|fire|cactus|magma/.test(b.name || '')) return false;
        }
        return true;
    };
    const clearReplaceableFootTarget = async (why = 'manual-pillar') => {
        const cell = bot.entity.position.floored();
        const foot = bot.blockAt(cell);
        if (!foot || OPEN.has(foot.name || '')) return true;
        if (foot.boundingBox === 'block' || !FOOT_REPLACEABLE.has(foot.name || '')) return true;
        motion('surfaceUp.manual_pillar.clear_foot_target.begin', {
            why,
            block: blockName(foot),
            env: envSnap(),
        });
        let ok = false;
        let error = null;
        try {
            try { bot.clearControlStates(); } catch (e) {}
            try { await bot.lookAt(foot.position.offset(0.5, 0.35, 0.5), true); } catch (e) {}
            await Promise.race([
                bot.dig(foot, true),
                new Promise((_, rej) => setTimeout(() => rej(new Error('clear-foot-timeout')), 2500)),
            ]);
            await skills.wait(bot, 120);
            const after = bot.blockAt(cell);
            ok = !after || OPEN.has(after.name || '') || (after.boundingBox === 'empty' && !FOOT_REPLACEABLE.has(after.name || ''));
        } catch (e) {
            error = e && e.message ? e.message : String(e);
            try { bot.stopDigging(); } catch (_) {}
        } finally {
            try { bot.clearControlStates(); } catch (e) {}
        }
        motion('surfaceUp.manual_pillar.clear_foot_target.end', {
            why,
            ok,
            error,
            after: blockName(bot.blockAt(cell)),
            env: envSnap(),
        });
        return ok;
    };
    const underfootPillarHasHeadroom = (why = 'manual-pillar') => {
        const cell = bot.entity.position.floored();
        const head = bot.blockAt(cell.offset(0, 1, 0));
        const above = bot.blockAt(cell.offset(0, 2, 0));
        if (head && head.boundingBox === 'block' && !OPEN.has(head.name || '')) {
            motion('surfaceUp.manual_pillar.blocked_low_head', {
                why,
                head: blockName(head),
                above: blockName(above),
                env: envSnap(),
            });
            return false;
        }
        if (above && above.boundingBox === 'block' && !OPEN.has(above.name || '')) {
            motion('surfaceUp.manual_pillar.blocked_low_ceiling', {
                why,
                above: blockName(above),
                hasPick: hasPick(),
                env: envSnap(),
            });
            return false;
        }
        return true;
    };
    const manualPillar = async (mustBeatY = yNow()) => {
        const name = SCAFFOLD.find(n => (world.getInventoryCounts(bot)[n] || 0) > 0);
        if (!name) return false;
        if (!(await clearReplaceableFootTarget('manual-pillar'))) return false;
        if (!underfootPillarHasHeadroom('manual-pillar')) return false;
        const y0 = Math.max(yNow(), mustBeatY);
        try {
            await skills.placeBlockUnderFeet(bot, name, { retries: 1, settleMs: 220 });
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
    const stableFloorBelow = () => {
        try {
            const m = bot.entity.position.floored();
            const below = bot.blockAt(m.offset(0, -1, 0));
            return !!(below && below.boundingBox === 'block' && !/water|lava|fire|cactus|magma/.test(below.name || ''));
        } catch (e) { return false; }
    };
    const ensureStableFooting = async (why = 'fallback') => {
        if (stableFloorBelow()) return true;
        const p0 = bot.entity.position.clone();
        motion('surfaceUp.footing.unstable', {
            why,
            pos: { x: +p0.x.toFixed(3), y: +p0.y.toFixed(3), z: +p0.z.toFixed(3) },
            env: envSnap(),
        });
        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}
        await skills.wait(bot, 420);
        if (stableFloorBelow()) {
            const p1 = bot.entity.position;
            motion('surfaceUp.footing.settled', {
                why,
                from: { x: +p0.x.toFixed(3), y: +p0.y.toFixed(3), z: +p0.z.toFixed(3) },
                to: { x: +p1.x.toFixed(3), y: +p1.y.toFixed(3), z: +p1.z.toFixed(3) },
                env: envSnap(),
            });
            return true;
        }
        const name = SCAFFOLD.find(n => (world.getInventoryCounts(bot)[n] || 0) > 0);
        if (name) {
            try {
                const rose = await manualPillar(yNow());
                if (stableFloorBelow() || rose) {
                    motion('surfaceUp.footing.pillar_recovered', { why, block: name, rose, y: yNow(), env: envSnap() });
                    return true;
                }
            } catch (e) {
                motion('surfaceUp.footing.pillar_failed', { why, block: name, error: e && e.message ? e.message : String(e), env: envSnap() });
            }
        }
        motion('surfaceUp.footing.blocked', { why, y: yNow(), env: envSnap() });
        return false;
    };
    let stuckFloor = 0;
    for (let i = 0; i < 100 && !surfaceReady(); i++) {
        try { bot.interrupt_code = false; } catch (e) {}
        const y0 = yNow();
        let opened = 0;
        let verticalBlocked = false;
        if (!(await ensureStableFooting(`fallback-iter-${i}-before-dig`))) {
            if (await stepEdgeAssist(`fallback-unstable-${stuckFloor}`)) continue;
            if (await scaffoldStep()) continue;
            break;
        }
        for (let h = 2; h <= 4; h++) {
            const c = bot.blockAt(bot.entity.position.offset(0, h, 0));
            if (!c) { opened++; continue; }
            if (NO_DIG.has(c.name)) break;
            if (!OPEN.has(c.name)) {
                if (!hasPick() && STONY.test(c.name)) {
                    await ensureEmergencyPick();
                    if (!hasPick()) {
                        if (canPlanNoPickStoneBreach(c, h)) {
                            plannedStoneBreaches++;
                            try { bot._plannedNoPickStoneUntil = Date.now() + 15000; } catch (e) {}
                            dbg(`fallback planned no-pick stone breach ${plannedStoneBreaches}/${plannedStoneLimit} at h=${h} name=${c.name}`);
                            motion('surfaceUp.no_pick_stone.planned_breach', {
                                h,
                                block: `${c.name}@${c.position.x},${c.position.y},${c.position.z}`,
                                food: bot.food,
                                hp: Math.round(bot.health || 0),
                                plannedStoneBreaches,
                                plannedStoneLimit,
                                env: envSnap(),
                            });
                        } else {
                            verticalBlocked = true;
                            dbg(`fallback no-pick stone blocked at h=${h} name=${c.name}`);
                            motion('surfaceUp.no_pick_stone.blocked', {
                                h,
                                block: `${c.name}@${c.position.x},${c.position.y},${c.position.z}`,
                                food: bot.food,
                                hp: Math.round(bot.health || 0),
                                plannedStoneBreaches,
                                plannedStoneLimit,
                            });
                            break;
                        }
                    }
                }
                const digY = yNow();
                const dug = await guardedDig(c, 'fallback');
                const afterDigY = yNow();
                if (!dug) {
                    verticalBlocked = true;
                    dbg(`fallback clear failed at h=${h} name=${c.name} y=${afterDigY} — guardedDig returned false`);
                    break;
                }
                if (afterDigY < digY) {
                    verticalBlocked = true;
                    motion('surfaceUp.fallback.fell_during_dig', {
                        h,
                        block: `${c.name}@${c.position.x},${c.position.y},${c.position.z}`,
                        fromY: digY,
                        toY: afterDigY,
                        env: envSnap(),
                    });
                    dbg(`fallback fell during dig at h=${h} ${c.name}: ${digY}->${afterDigY}; stabilizing before more headroom`);
                    break;
                }
                const after = bot.blockAt(c.position);
                if (after && after.boundingBox === 'block' && !OPEN.has(after.name)) {
                    verticalBlocked = true;
                    dbg(`fallback clear failed at h=${h} name=${after.name} y=${yNow()} — stop treating it as opened`);
                    break;
                }
            }
            opened++;
        }
        if ((verticalBlocked || opened < 2) && await scaffoldStep()) continue;
        try { await skills.pillarUp(bot, Math.min(y0 + Math.max(2, opened), targetY)); } catch (e) {}
        if (yNow() <= y0) {
            let rose = false;
            for (let m = 0; m < 3 && !rose; m++) rose = await manualPillar(y0);
            const progressed = yNow() > y0;
            if (!progressed) stuckFloor++;
            else stuckFloor = 0;
            dbg(`fallback iter ${i}: opened=${opened} y ${y0}->${yNow()} manualRose=${rose} progressed=${progressed} stuckFloor=${stuckFloor}`);
            if (!progressed) {
                if (await stepEdgeAssist(`fallback-stuck-${stuckFloor}`)) continue;
                if (await scaffoldStep()) continue;
                if (!rose || stuckFloor >= 3) break;
            }
        } else {
            stuckFloor = 0;
            dbg(`fallback iter ${i}: pillarUp rose ${y0}->${yNow()}`);
        }
    }
    } // end climbToSurface
}
