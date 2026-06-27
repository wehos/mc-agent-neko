// Hot-reloadable REAL skill: branch-mine for ores (no cheats).
// Optionally staircases down to targetY, then digs a straight horizontal tunnel,
// scanning for and mining any ore within reach each step. Solves the "pathfinding
// failed / cannot reach ore" problem by actively EXPOSING ores instead of relying
// on the pathfinder to squeeze up to a buried ore.
// Invoked via: !newAction("await skills.customSkill(bot, 'branchMine', 24, 45)")
//   length  = tunnel length (default 24)
//   targetY = if a number, staircase down to this Y first (e.g. -50 for diamonds)
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import mfp from 'mineflayer-pathfinder';
const { goals: BM_GOALS, Movements: BM_MOVES } = mfp;

const ORES = ['diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'deepslate_iron_ore',
              'coal_ore', 'deepslate_coal_ore', 'gold_ore', 'deepslate_gold_ore',
              'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
              'copper_ore', 'deepslate_copper_ore', 'emerald_ore', 'deepslate_emerald_ore'];
const IRON_ORES = ['iron_ore', 'deepslate_iron_ore'];

export default async function branchMine(bot, ctx, length = 24, targetY = null) {
    const { skills, world, mc, Vec3, log } = ctx;
    // Use the CHEAP pickaxe to tunnel (stone), and save the good pickaxe's
    // durability for actually mining ores (diamond needs iron+ to drop).
    const PICK_TIER = {
        wooden_pickaxe: 1, golden_pickaxe: 1,
        stone_pickaxe: 2,
        iron_pickaxe: 3,
        diamond_pickaxe: 4, netherite_pickaxe: 5,
    };
    const CHEAP_PICKS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
    const BEST_PICKS = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
    const pickCount = () => world.getInventoryCounts(bot);
    const requiredPickTier = (name = '') => {
        if (/obsidian/.test(name)) return 4;
        if (/diamond_ore|redstone_ore|emerald_ore|gold_ore/.test(name)) return 3;
        if (/iron_ore|lapis_ore|copper_ore/.test(name)) return 2;
        if (/coal_ore|stone|deepslate|andesite|diorite|granite|tuff|cobble|blackstone/.test(name)) return 1;
        return 0;
    };
    const equipPick = async (minTier = 1, preferBest = false) => {
        const inv = pickCount();
        const order = preferBest ? BEST_PICKS : CHEAP_PICKS;
        const pick = order.find(p => (inv[p] || 0) > 0 && PICK_TIER[p] >= minTier);
        if (!pick) return false;
        try {
            const ok = await skills.equip(bot, pick);
            await skills.wait(bot, 80);
            return ok !== false;
        } catch (e) {
            return false;
        }
    };
    const equipDig = async () => equipPick(1, false);
    const equipBest = async () => equipPick(1, true);
    await equipDig();

    const OPEN = new Set(['air', 'cave_air', 'void_air', 'water', 'flowing_water']);
    const solid = (b) => b && b.boundingBox === 'block';
    const open = (b) => !b || b.boundingBox === 'empty' || OPEN.has(b.name);
    const BAD_FLUID = /lava|water/;
    const FOOD_RE = /(?:beef|porkchop|mutton|chicken|rabbit|cod|salmon|bread|apple|carrot|potato|berries|stew|pie|cookie|melon_slice)$/;
    const edibleHeld = () => bot.inventory.items().some(i => FOOD_RE.test(i.name || ''));
    const isIronOre = (name = '') => IRON_ORES.includes(name);
    const filler = () => bot.inventory.items().find(i =>
        /^(cobblestone|cobbled_deepslate|deepslate|stone|dirt|granite|diorite|andesite|tuff)$/.test(i.name));
    const distToBlock = (block) => bot.entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5));
    const blockObj = (b) => b ? { name: b.name, x: b.position.x, y: b.position.y, z: b.position.z, bb: b.boundingBox } : null;
    // ★C305 (T-0035) HUMAN-LIKE ORE REACH for branchMine — the SECOND x-ray path (collectBlock's
    // C304 doesn't cover this one). directMineOre digs ANY ore within 4.6 raw eye-distance (line
    // ~242) with NO path check → reaches straight THROUGH an air gap to ore in an opposite cliff/
    // ravine wall (用户实拍:站墙头够对面峡谷矿). Gate: ore must have a real SHORT walk/dig path to
    // an adjacent stand cell — canDig (mine toward a buried vein) but NO scaffolding/pillaring (can't
    // bridge a gap). Mirrors C304. Self-contained (imports pf) so it's live on ③ hot-reload, no restart.
    let _bmReach = null, _bmReachErr = false;
    const _mineDBG = (m) => { try { fs.appendFileSync('bots/_supervisor/mine_dbg.log', `[${new Date().toISOString()}] ${m}\n`); } catch (e) {} };
    const _oreReachableBM = async (oreBlock) => {
        if (_bmReachErr) return true;   // pathfinder unavailable → fail open (never block mining outright)
        try {
            if (!_bmReach) {
                _bmReach = new BM_MOVES(bot);
                _bmReach.canDig = true;
                _bmReach.scafoldingBlocks = [];
                _bmReach.allow1by1towers = false;
                _bmReach.maxDropDown = 3;
                _bmReach.dontCreateFlow = true;
            }
            const bp = oreBlock.position;
            const d3 = distToBlock(oreBlock);
            const res = await bot.pathfinder.getPathTo(_bmReach, new BM_GOALS.GoalNear(bp.x, bp.y, bp.z, 2), 800);
            const st = res ? res.status : 'null';
            if (!res || res.status !== 'success') {
                _mineDBG(`★C305 ${oreBlock.name}@${bp.x},${bp.y},${bp.z} d3=${d3.toFixed(1)} REJECT status=${st} (no walk/dig path, no bridge)`);
                return false;
            }
            const len = (res.path && res.path.length) || 0;
            const budget = Math.max(8, Math.ceil(d3 * 2.5));
            const ok = len <= budget;
            _mineDBG(`★C305 ${oreBlock.name}@${bp.x},${bp.y},${bp.z} d3=${d3.toFixed(1)} len=${len} budget=${budget} ${ok ? 'OK' : 'REJECT(detour too long)'}`);
            return ok;
        } catch (e) { _bmReachErr = true; return true; }   // construction/path error → fail open
    };
    const envSnap = () => {
        const c = bot.entity.position.floored();
        const out = [];
        for (let dy = -1; dy <= 2; dy++) {
            for (let dz0 = -1; dz0 <= 1; dz0++) {
                for (let dx0 = -1; dx0 <= 1; dx0++) {
                    const b = bot.blockAt(c.offset(dx0, dy, dz0));
                    out.push({ d: [dx0, dy, dz0], n: b ? b.name : null, bb: b ? b.boundingBox : null });
                }
            }
        }
        return out;
    };
    const motion = (event, data = {}) => {
        try {
            const p = bot.entity.position;
            fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                ts: new Date().toISOString(),
                event,
                pos: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) },
                foot: blockObj(bot.blockAt(p)),
                head: blockObj(bot.blockAt(p.offset(0, 1, 0))),
                above: blockObj(bot.blockAt(p.offset(0, 2, 0))),
                held: bot.heldItem ? bot.heldItem.name : 'empty',
                hp: Math.round(bot.health || 0),
                food: bot.food,
                skill: bot._currentSkill || 'branchMine',
                mob: bot._mobility ? bot._mobility.state : null,
                env: envSnap(),
                data,
            }) + '\n');
        } catch (e) {}
    };
    const blockedByLava = (pos) => {
        const sides = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
        return sides.some(([x, y, z]) => {
            const b = bot.blockAt(pos.offset(x, y, z));
            return b && /lava/.test(b.name || '');
        });
    };
    const nightActionableStop = (phase = 'branchMine') => {
        try {
            const t = bot.time.timeOfDay;
            const nightish = t >= 12500 && t <= 23000;
            if (!nightish || Math.floor(bot.entity.position.y) < 50) return null;
            let adv = null;
            try { adv = JSON.parse(fs.readFileSync('bots/_supervisor/advisory.json', 'utf8')); } catch (e) {}
            if (adv && Date.now() - Number(adv.ts || 0) < 45000
                && Number(adv.actionableHostiles || 0) > 0
                && Number(adv.actionableNearest || 99) <= 8) {
                return `${phase}: night actionable hostile ${Number(adv.actionableNearest || 0).toFixed(1)}b risk=${adv.risk || 0}`;
            }
            if (!adv || Date.now() - Number(adv.ts || 0) >= 45000) {
                const near = Object.values(bot.entities || {}).filter(e => {
                    try { return e && e.position && mc && mc.isHostile && mc.isHostile(e) && e.position.distanceTo(bot.entity.position) <= 8; }
                    catch (e2) { return false; }
                }).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
                if (near) return `${phase}: night local hostile ${near.name}@${near.position.distanceTo(bot.entity.position).toFixed(1)}b`;
            }
        } catch (e) {}
        return null;
    };
    const lowFoodEssentialStop = (phase = 'branchMine') => {
        try {
            if (edibleHeld()) return null;
            const hp = Math.round(bot.health || 0);
            if (bot.food < 8) return `${phase}: low-food buffer spent food=${bot.food} hp=${hp}`;
            if (hp < 14) return `${phase}: low-hp buffer spent food=${bot.food} hp=${hp}`;
            if (bot.food > 8) return null;
            const t = bot.time.timeOfDay;
            const duskOrNight = t >= 11500 && t <= 23000;
            let adv = null;
            try { adv = JSON.parse(fs.readFileSync('bots/_supervisor/advisory.json', 'utf8')); } catch (e) {}
            if (adv && Date.now() - Number(adv.ts || 0) < 45000 && Number(adv.actionableHostiles || 0) > 0) {
                return `${phase}: low-food actionable hostile risk=${adv.risk || 0}`;
            }
            if (duskOrNight) {
                return `${phase}: low-food dusk/night food=${bot.food} hp=${hp} tod=${t}`;
            }
        } catch (e) {}
        return null;
    };
    const digBlock = async (block, label, maxMs = 9000) => {
        if (!block || open(block)) return 'gone';
        if (/lava|water|bedrock/.test(block.name || '')) return 'blocked';
        if (blockedByLava(block.position)) return 'lava-near';
        const owner = `branchMine:${label || 'dig'}`;
        const acquire = async () => {
            const t0 = Date.now();
            while (Date.now() - t0 < 900) {
                const busy = bot.targetDigBlock
                    || bot._mineMotionActiveDig
                    || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil);
                if (!busy || bot._bodyDigLockOwner === owner) {
                    bot._bodyDigLockOwner = owner;
                    bot._bodyDigLockUntil = Date.now() + Math.max(6000, maxMs + 1000);
                    return true;
                }
                await new Promise(r => setTimeout(r, 80));
            }
            motion('dig.slot.busy', {
                owner,
                label,
                target: blockObj(block),
                heldBy: bot._bodyDigLockOwner || 'targetDigBlock',
            });
            return false;
        };
        if (!(await acquire())) return 'busy';
        try {
            const fresh = bot.blockAt(block.position);
            if (!fresh || open(fresh)) return 'gone';
            const reqTier = requiredPickTier(fresh.name || '');
            if (reqTier > 0) {
                const preferBest = ORES.includes(fresh.name);
                if (!(await equipPick(reqTier, preferBest))) return 'wrong-tool';
            } else {
                try { await bot.tool.equipForBlock(fresh); } catch (e) {}
            }
            const held = bot.heldItem ? bot.heldItem.type : null;
            const heldName = bot.heldItem ? bot.heldItem.name : null;
            if (bot.game.gameMode !== 'creative' && !fresh.canHarvest(held)) {
                const heldTier = heldName && PICK_TIER[heldName] ? PICK_TIER[heldName] : 0;
                if (!(reqTier > 0 && heldTier >= reqTier)) return 'wrong-tool';
            }
            try { bot.clearControlStates(); } catch (e) {}
            try { await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
            try {
                await Promise.race([
                    bot.dig(fresh, true),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('dig-timeout')), maxMs)),
                ]);
                log(bot, `branchMine ${label}: dug ${fresh.name}@${fresh.position.x},${fresh.position.y},${fresh.position.z}`);
                return 'ok';
            } catch (e) {
                try { bot.stopDigging(); } catch (_) {}
                motion('dig.retry', {
                    owner,
                    label,
                    target: blockObj(fresh),
                    error: e && e.message ? e.message : String(e),
                });
                return e && e.message === 'dig-timeout' ? 'timeout' : 'error';
            }
        } finally {
            if (bot._bodyDigLockOwner === owner) {
                bot._bodyDigLockOwner = null;
                bot._bodyDigLockUntil = 0;
            }
        }
    };
    const carveStandCell = async (feet) => {
        const cells = [feet, feet.offset(0, 1, 0)];
        for (const c of cells) {
            const b = bot.blockAt(c);
            if (!open(b)) {
                const r = await digBlock(b, 'ore-window', 9000);
                if (r !== 'ok' && r !== 'gone') return false;
            }
        }
        return true;
    };
    const directMineOre = async (oreBlock) => {
        if (!oreBlock || !ORES.includes(oreBlock.name)) return false;
        if (bot.food <= 8 && !edibleHeld() && !isIronOre(oreBlock.name)) {
            log(bot, `branchMine ore-chase skip ${oreBlock.name}@${oreBlock.position.x},${oreBlock.position.y},${oreBlock.position.z} low-food essential iron only food=${bot.food} hp=${Math.round(bot.health || 0)}`);
            motion('branchMine.ore.skip', { reason: 'low-food-essential-iron-only', block: blockObj(oreBlock) });
            return false;
        }
        const p0 = bot.entity.position.floored();
        const rel = [oreBlock.position.x - p0.x, oreBlock.position.y - p0.y, oreBlock.position.z - p0.z];
        if (blockedByLava(oreBlock.position)) {
            log(bot, `branchMine ore-chase skip ${oreBlock.name}@${oreBlock.position.x},${oreBlock.position.y},${oreBlock.position.z} rel=${rel.join(',')} lava-near`);
            return false;
        }
        // ★C305 HUMAN-LIKE REACH GATE: only mine ore we can genuinely WALK/dig up to (short path
        // to an adjacent stand cell, no bridging). Blocks the raw-4.6 direct-dig from reaching
        // straight through an air gap to ore in an opposite wall. Unreachable → caller adds to
        // `skipped`, bot keeps tunnelling and exposes reachable ore instead of x-ray-grabbing this.
        if (!(await _oreReachableBM(oreBlock))) {
            log(bot, `branchMine ore-chase skip ${oreBlock.name}@${oreBlock.position.x},${oreBlock.position.y},${oreBlock.position.z} rel=${rel.join(',')} ★C305 no-short-reach-path (across gap/wall) — not x-ray-mining`);
            motion('branchMine.ore.skip', { reason: 'C305-no-short-reach-path', block: blockObj(oreBlock) });
            return false;
        }
        await equipBest();
        // ★C337 (T-0035 reopen·回归根治): the C305 path-exists gate is NECESSARY but NOT SUFFICIENT —
        // a DETOUR path can exist (gate OK) while the ore sits behind a SOLID wall within 4.6b, and
        // the raw distToBlock<=4.6 direct-dig then reaches THROUGH the near wall = x-ray (用户实拍
        // "矿在距离内但中间完全没通、隔着石头"; mine_dbg: copper_ore d3=5.5 budget=14 OK→still dug).
        // distToBlock<=4.6 is necessary-not-sufficient; add a REAL occlusion check: only DIRECT-dig
        // when we have clear line-of-sight to the ore (no solid block between eye and ore). If walled
        // off → fall through to the carve-stand-cell path below, which APPROACHES properly (digs an
        // adjacent stand cell + steps in) instead of x-ray-grabbing. canSeeBlock=false for fully-buried
        // ore is fine here: that just routes it to the carve path, which exposes it legitimately.
        const _canSee = (b) => { try { return bot.canSeeBlock(b); } catch (e) { return false; } };
        if (distToBlock(oreBlock) <= 4.6 && _canSee(oreBlock)) {
            const r = await digBlock(oreBlock, `ore-chase rel=${rel.join(',')}`, 9000);
            await equipDig();
            if (r === 'ok') {
                try { await skills.pickupNearbyItems(bot); } catch (e) {}
                // ★C282: guarantee the ore drop lands in inventory even if mined from above and
                // it fell to a ledge below — but ONLY via a SAFE descent (never fall for an ore).
                try { await skills.ensurePickupAt(bot, oreBlock.position, { radius: 4 }); } catch (e) {}
                return true;
            }
            log(bot, `branchMine ore-chase direct ${oreBlock.name}@${oreBlock.position.x},${oreBlock.position.y},${oreBlock.position.z} rel=${rel.join(',')} => ${r}`);
            return false;
        }

        // Human-like short cut-in: make a 1x2 stand cell on the side of the ore,
        // step into it, then mine the ore. This is intentionally local only; long
        // navigation remains the caller's job.
        const sideOffsets = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
        const stands = [];
        for (const [sx, sy, sz] of sideOffsets) {
            stands.push(oreBlock.position.offset(sx, -1, sz));
            stands.push(oreBlock.position.offset(sx, 0, sz));
        }
        stands.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
        for (const feet of stands.slice(0, 4)) {
            if (bot.interrupt_code) break;
            const floor = bot.blockAt(feet.offset(0, -1, 0));
            if (!solid(floor)) continue;
            if (!(await carveStandCell(feet))) continue;
            try { await skills.goToPosition(bot, feet.x, feet.y, feet.z, 0); } catch (e) {}
            const cur = bot.blockAt(oreBlock.position);
            if (cur && ORES.includes(cur.name) && distToBlock(cur) <= 4.6 && _canSee(cur)) {
                await equipBest();
                const r = await digBlock(cur, `ore-chase-window rel=${rel.join(',')}`, 9000);
                await equipDig();
                if (r === 'ok') {
                    try { await skills.pickupNearbyItems(bot); } catch (e) {}
                    return true;
                }
                log(bot, `branchMine ore-chase window ${cur.name}@${cur.position.x},${cur.position.y},${cur.position.z} rel=${rel.join(',')} => ${r}`);
            }
        }
        await equipDig();
        return false;
    };
    const mineNearby = async () => {
        const skipped = new Set();
        for (let pass = 0; pass < 8; pass++) {
            const lowFoodStop = lowFoodEssentialStop('ore-chase');
            if (lowFoodStop) {
                log(bot, `branchMine stop ${lowFoodStop}; yield to survival policy`);
                motion('branchMine.stop', { reason: lowFoodStop });
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                return false;
            }
            const stop = nightActionableStop('ore-chase');
            if (stop) {
                log(bot, `branchMine stop ${stop}; yield to survival policy`);
                motion('branchMine.stop', { reason: stop });
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                return false;
            }
            // ★T-0094 SCAN-RADIUS FIX: getNearestBlocks signature is (bot, types, DISTANCE, COUNT) —
            // the old (bot, ORES, 5, 16) read as distance=5/count=16, i.e. it only ever saw ore
            // within 5 blocks (NOT the 16 the surrounding comments assumed). At y14 a 5-block bubble
            // misses most of the iron the tunnel walks PAST, so mineNearby found "0 ores" and the bot
            // tunnelled straight on by exposed iron → mining-yield≈0. Restore the intended 16-block
            // reach (count 24, plenty for a dense seam) so each step actually harvests the band.
            const ores = world.getNearestBlocks(bot, ORES, 16, 24)
                .filter(b => b && ORES.includes(b.name) && !skipped.has(`${b.position.x},${b.position.y},${b.position.z}`))
                .filter(b => !(bot.food <= 8 && !edibleHeld()) || isIronOre(b.name))
                .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
            if (ores.length === 0) break;
            let mined = false;
            for (const b of ores) {
                if (bot.interrupt_code) return;
                if (await directMineOre(b)) { mined = true; break; }
                skipped.add(`${b.position.x},${b.position.y},${b.position.z}`);
            }
            if (!mined) break;
        }
        return true;
    };
    const stepInto = async (feet, dx, dz, label) => {
        const nightStop = nightActionableStop(`step ${label || ''}`);
        if (nightStop) {
            log(bot, `branchMine stop ${nightStop}; no step`);
            motion('branchMine.step.end', { label, ok: false, reason: 'night-actionable-hostile', detail: nightStop, target: { x: feet.x, y: feet.y, z: feet.z } });
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
            try { bot.clearControlStates(); } catch (e) {}
            return false;
        }
        const floorPos = feet.offset(0, -1, 0);
        const footPos = feet;
        const headPos = feet.offset(0, 1, 0);
        const floor = bot.blockAt(floorPos);
        const foot = bot.blockAt(footPos);
        const head = bot.blockAt(headPos);
        motion('branchMine.step.begin', {
            label,
            target: { x: feet.x, y: feet.y, z: feet.z },
            dir: [dx, dz],
            floor: blockObj(floor),
            foot: blockObj(foot),
            head: blockObj(head),
        });
        if ([floor, foot, head].some(b => b && BAD_FLUID.test(b.name || ''))) {
            log(bot, `branchMine ${label}: stop fluid near target floor=${floor ? floor.name : 'null'} foot=${foot ? foot.name : 'null'} head=${head ? head.name : 'null'}`);
            motion('branchMine.step.end', { label, ok: false, reason: 'fluid', target: { x: feet.x, y: feet.y, z: feet.z } });
            return false;
        }
        if (!solid(floor)) {
            const f = filler();
            if (!f) {
                log(bot, `branchMine ${label}: no floor and no filler at ${floorPos.x},${floorPos.y},${floorPos.z}`);
                motion('branchMine.step.end', { label, ok: false, reason: 'no-floor-no-filler', target: { x: feet.x, y: feet.y, z: feet.z }, floor: blockObj(floor) });
                return false;
            }
            try { await skills.equip(bot, f.name); await skills.wait(bot, 120); } catch (e) {}
            let ok = await skills.placeBlock(bot, f.name, floorPos.x, floorPos.y, floorPos.z, 'bottom', true).catch(() => false);
            if (!ok) {
                try { await skills.wait(bot, 220); await skills.equip(bot, f.name); await skills.wait(bot, 120); } catch (e) {}
                ok = await skills.placeBlock(bot, f.name, floorPos.x, floorPos.y, floorPos.z, 'bottom', true).catch(() => false);
            }
            if (!ok) {
                log(bot, `branchMine ${label}: failed to bridge floor with ${f.name} at ${floorPos.x},${floorPos.y},${floorPos.z}`);
                motion('branchMine.step.end', { label, ok: false, reason: 'bridge-failed', filler: f.name, target: { x: feet.x, y: feet.y, z: feet.z } });
                return false;
            }
        }
        for (const c of [footPos, headPos]) {
            const b = bot.blockAt(c);
            if (b && !open(b)) {
                const r = await digBlock(b, label, 9000);
                if (r !== 'ok' && r !== 'gone') {
                    log(bot, `branchMine ${label}: failed clearing ${b.name}@${c.x},${c.y},${c.z} => ${r}`);
                    motion('branchMine.step.end', { label, ok: false, reason: `clear-${r}`, block: blockObj(b), target: { x: feet.x, y: feet.y, z: feet.z } });
                    return false;
                }
            }
        }
        const localDropStep = async () => {
            const cur = bot.entity.position;
            const targetCenter = feet.offset(0.5, 0, 0.5);
            const horiz = Math.hypot(cur.x - targetCenter.x, cur.z - targetCenter.z);
            const yDrop = cur.y - feet.y;
            const freshFloor = bot.blockAt(floorPos);
            const freshFoot = bot.blockAt(footPos);
            const freshHead = bot.blockAt(headPos);
            if (horiz > 1.75 || yDrop < 0.55 || yDrop > 1.65) return false;
            if (!solid(freshFloor) || !open(freshFoot) || !open(freshHead)) return false;
            if ([freshFloor, freshFoot, freshHead].some(b => b && BAD_FLUID.test(b.name || ''))) return false;
            motion('branchMine.step.local_drop.begin', {
                label,
                target: { x: feet.x, y: feet.y, z: feet.z },
                horiz: +horiz.toFixed(3),
                yDrop: +yDrop.toFixed(3),
                floor: blockObj(freshFloor),
                foot: blockObj(freshFoot),
                head: blockObj(freshHead),
            });
            try {
                try { bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                try { await bot.lookAt(new Vec3(targetCenter.x, cur.y + 1.2, targetCenter.z), true); } catch (_) {}
                bot.setControlState('forward', true);
                const t0 = Date.now();
                while (Date.now() - t0 < 950) {
                    if (bot.entity.position.distanceTo(targetCenter) <= 1.05 && Math.abs(bot.entity.position.y - feet.y) <= 0.75) break;
                    await new Promise(r => setTimeout(r, 80));
                }
            } finally {
                try { bot.clearControlStates(); } catch (_) {}
            }
            const dist = bot.entity.position.distanceTo(targetCenter);
            const ok = dist <= 1.15 && Math.abs(bot.entity.position.y - feet.y) <= 0.75;
            motion('branchMine.step.local_drop.end', {
                label,
                ok,
                target: { x: feet.x, y: feet.y, z: feet.z },
                dist: +dist.toFixed(3),
                y: +bot.entity.position.y.toFixed(3),
            });
            return ok;
        };
        try {
            bot._bodyMoveLockOwner = `branchMine:${label || 'step'}`;
            bot._bodyMoveLockUntil = Date.now() + 4200;
            try {
                await Promise.race([
                    skills.goToPosition(bot, feet.x + 0.5, feet.y, feet.z + 0.5, 0.35),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('step-timeout')), 3000)),
                ]);
            } catch (e) {
                try { bot.pathfinder.stop(); } catch (_) {}
                motion('branchMine.step.path.err', {
                    label,
                    error: e && e.message ? e.message : String(e),
                    target: { x: feet.x, y: feet.y, z: feet.z },
                });
            }
            if (bot.entity.position.distanceTo(feet.offset(0.5, 0, 0.5)) > 1.05) {
                const assisted = typeof skills.stepEdgeAssist === 'function'
                    ? await skills.stepEdgeAssist(bot, {
                        why: `branchMine-${label || 'step'}`,
                        goal: { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 },
                        owner: `branchMine:${label || 'step'}:step-edge`,
                        moveMs: 900,
                    }).catch(() => false)
                    : false;
                motion('branchMine.step.edgeAssist', {
                    label,
                    ok: assisted,
                    target: { x: feet.x, y: feet.y, z: feet.z },
                });
                if (!assisted && bot.entity.position.distanceTo(feet.offset(0.5, 0, 0.5)) > 1.05) {
                    const dropped = await localDropStep();
                    if (!dropped && bot.entity.position.distanceTo(feet.offset(0.5, 0, 0.5)) > 1.05) {
                        motion('branchMine.step.rawHop.skipped', {
                            label,
                            reason: 'structured-step-edge-failed',
                            target: { x: feet.x, y: feet.y, z: feet.z },
                            pos: {
                                x: +bot.entity.position.x.toFixed(3),
                                y: +bot.entity.position.y.toFixed(3),
                                z: +bot.entity.position.z.toFixed(3),
                            },
                        });
                    }
                }
                try { bot.clearControlStates(); } catch (e) {}
            }
        } finally {
            if (bot._bodyMoveLockOwner === `branchMine:${label || 'step'}`) {
                bot._bodyMoveLockOwner = null;
                bot._bodyMoveLockUntil = 0;
            }
        }
        const ok = bot.entity.position.distanceTo(feet.offset(0.5, 0, 0.5)) <= 1.15;
        log(bot, `branchMine ${label}: step ${ok ? 'ok' : 'stalled'} target=${feet.x},${feet.y},${feet.z} pos=${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}`);
        const endFloor = bot.blockAt(floorPos);
        const endFoot = bot.blockAt(footPos);
        const endHead = bot.blockAt(headPos);
        const dist = bot.entity.position.distanceTo(feet.offset(0.5, 0, 0.5));
        const reason = ok ? 'ok'
            : (BAD_FLUID.test((endFoot && endFoot.name) || '') || BAD_FLUID.test((endHead && endHead.name) || '') ? 'fluid-after-move'
                : (!solid(endFloor) ? 'floor-lost'
                    : (!open(endFoot) ? 'foot-blocked-after-clear'
                        : (!open(endHead) ? 'head-blocked-after-clear'
                            : (Math.abs(bot.entity.position.y - feet.y) > 0.75 ? 'wrong-y' : 'not-centered')))));
        motion('branchMine.step.end', {
            label,
            ok,
            reason,
            target: { x: feet.x, y: feet.y, z: feet.z },
            dist: +dist.toFixed(3),
            floor: blockObj(endFloor),
            foot: blockObj(endFoot),
            head: blockObj(endHead),
        });
        return ok;
    };

    // Dig a real 1x2 STAIRCASE down to targetY (player-style). Each step we
    // mine the diagonally-lower cell (legs+head+headroom) and walk down into it.
    // This avoids digDown's "reached a drop" stalls and never free-falls into
    // lava — we inspect the cells before mining and stop if lava is adjacent.
    if (typeof targetY === 'number') {
        const descentStartY = Math.floor(bot.entity.position.y);
        let yaw = bot.entity.yaw;
        let dx = -Math.sin(yaw), dz = Math.cos(yaw);
        if (Math.abs(dx) >= Math.abs(dz)) { dx = Math.sign(dx) || 1; dz = 0; } else { dz = Math.sign(dz) || 1; dx = 0; }
        let guard = 0, stall = 0;
        while (Math.floor(bot.entity.position.y) > targetY && guard++ < 220) {
            if (bot.interrupt_code) break;
            const lowFoodStop = lowFoodEssentialStop('descent');
            if (lowFoodStop) { log(bot, `branchMine stop ${lowFoodStop}; no more descent`); motion('branchMine.descent.stop', { reason: 'low-food-essential-stop', detail: lowFoodStop, y: Math.floor(bot.entity.position.y), targetY }); return false; }
            const stop = nightActionableStop('descent');
            if (stop) { log(bot, `branchMine stop ${stop}; no more descent`); motion('branchMine.descent.stop', { reason: 'night-actionable-hostile', detail: stop, y: Math.floor(bot.entity.position.y), targetY }); return false; }
            const b = bot.entity.position.floored();
            const targetFeet = new Vec3(b.x + dx, b.y - 1, b.z + dz);
            const cells = [
                targetFeet,                            // step legs
                new Vec3(b.x + dx, b.y, b.z + dz),     // step head
                new Vec3(b.x + dx, b.y + 1, b.z + dz), // headroom
            ];
            const floor = bot.blockAt(targetFeet.offset(0, -1, 0));
            let lava = false;
            for (const c of cells) {
                const blk = bot.blockAt(c);
                if (blk && BAD_FLUID.test(blk.name || '')) { lava = true; break; }
            }
            if (floor && BAD_FLUID.test(floor.name || '')) lava = true;
            if (lava) { log(bot, `Fluid ahead at y=${b.y}, stopping descent.`); motion('branchMine.descent.stop', { reason: 'fluid', y: b.y, target: { x: targetFeet.x, y: targetFeet.y, z: targetFeet.z }, floor: blockObj(floor) }); break; }
            let clearFailed = null;
            for (const c of cells) {
                const blk = bot.blockAt(c);
                if (blk && !open(blk)) {
                    const r = await digBlock(blk, `descent-clear y${b.y}->${b.y - 1}`, 9000);
                    if (r !== 'ok' && r !== 'gone') {
                        clearFailed = { result: r, block: blk };
                        break;
                    }
                }
            }
            if (clearFailed) {
                const blk = clearFailed.block;
                log(bot, `branchMine descent: failed clearing ${blk.name}@${blk.position.x},${blk.position.y},${blk.position.z} => ${clearFailed.result}`);
                motion('branchMine.descent.stop', {
                    reason: `clear-${clearFailed.result}`,
                    y: b.y,
                    target: { x: targetFeet.x, y: targetFeet.y, z: targetFeet.z },
                    block: blockObj(blk),
                });
                break;
            }
            const before = b.y;
            const stepped = await stepInto(targetFeet, dx, dz, `descent-step y${before}->${before - 1}`);
            if ((await mineNearby()) === false) return false;
            if (!stepped || Math.floor(bot.entity.position.y) >= before) { stall++; if (stall >= 5) { log(bot, 'descent stalled'); motion('branchMine.descent.stop', { reason: 'stalled', y: b.y, target: { x: targetFeet.x, y: targetFeet.y, z: targetFeet.z } }); break; } }
            else stall = 0;
        }
        const descentEndY = Math.floor(bot.entity.position.y);
        log(bot, `descended to y=${descentEndY}`);
        if (descentStartY > targetY && descentEndY >= descentStartY) {
            motion('branchMine.descent.stop', { reason: 'no-y-progress', startY: descentStartY, endY: descentEndY, targetY });
            return false;
        }
    }

    if ((await mineNearby()) === false) return false;

    // ── Horizontal tunnel heading ──────────────────────────────────────────────
    // ★T-0094 ORE-DIRECTED HEADING: the old heading was a pure yaw snapshot snapped to a
    // cardinal axis — i.e. whichever way the bot happened to be facing (often the descent
    // direction or a flee-turn), NOT toward ore. So at the iron band it blind-tunnelled past
    // iron seams instead of into them (mining-yield≈0). Instead: scan the band for the
    // nearest REACHABLE ore (prefer iron — the bottleneck for the armor/tool chain) and aim
    // the tunnel at it, so the lateral dig drives THROUGH the seam. The reach gate (_oreReachableBM)
    // is the same C305 human-like check used for ore-chasing, so we never aim at x-ray-only ore
    // across a gap. Fall back to the yaw heading when nothing reachable is in range.
    const cardinalToward = (fromPos, toPos) => {
        const ddx = toPos.x - fromPos.x, ddz = toPos.z - fromPos.z;
        if (Math.abs(ddx) >= Math.abs(ddz)) return { dx: Math.sign(ddx) || 1, dz: 0 };
        return { dx: 0, dz: Math.sign(ddz) || 1 };
    };
    let dx, dz, headingSrc = 'yaw';
    {
        const yaw = bot.entity.yaw;
        dx = -Math.sin(yaw); dz = Math.cos(yaw);
        if (Math.abs(dx) >= Math.abs(dz)) { dx = Math.sign(dx) || 1; dz = 0; } else { dz = Math.sign(dz) || 1; dx = 0; }
        try {
            const me = bot.entity.position.floored();
            // Prefer iron when in/near the iron band; otherwise aim at any ore on offer.
            const wantIron = Math.floor(bot.entity.position.y) <= 40;
            const scan = world.getNearestBlocks(bot, wantIron ? IRON_ORES : ORES, 16, 24) || [];
            let pool = scan.filter(b => b && (wantIron ? IRON_ORES : ORES).includes(b.name));
            if (wantIron && pool.length === 0) pool = (world.getNearestBlocks(bot, ORES, 16, 24) || []).filter(b => b && ORES.includes(b.name));
            // nearest-first; pick the first that passes the reach gate so we head at real ore.
            pool.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
            for (const ob of pool.slice(0, 6)) {
                if (Math.abs(ob.position.x - me.x) < 1 && Math.abs(ob.position.z - me.z) < 1) continue; // directly above/below — heading undefined
                if (await _oreReachableBM(ob)) {
                    const c = cardinalToward(me, ob.position);
                    dx = c.dx; dz = c.dz; headingSrc = `ore:${ob.name}@${ob.position.x},${ob.position.y},${ob.position.z}`;
                    break;
                }
            }
        } catch (e) {}
        log(bot, `branchMine heading ${dx},${dz} src=${headingSrc}`);
        motion('branchMine.tunnel.heading', { dx, dz, src: headingSrc });
    }

    // ★T-0094 SYSTEMATIC COVERAGE: every RIB_EVERY steps, look down each side wall and run an
    // ore pass there. Combined with the restored 16-block scan radius, a side glance lets the
    // ore-chaser carve in to seams flanking the spine instead of only the seams the spine cuts —
    // approximating standard branch-mining coverage without committing to (and getting lost in)
    // long perpendicular spurs. Perp axis = rotate heading 90°.
    const RIB_EVERY = 3;
    const perp = { dx: -dz, dz: dx };
    const ribGlance = async () => {
        const me = bot.entity.position;
        for (const sgn of [1, -1]) {
            if (bot.interrupt_code) return true;
            try { await bot.lookAt(me.offset(perp.dx * sgn * 2, 1.0, perp.dz * sgn * 2), true); } catch (e) {}
            if ((await mineNearby()) === false) return false;  // survival yield — propagate so the tunnel aborts too
        }
        return true;
    };

    let stale = 0;
    for (let i = 0; i < length; i++) {
        if (bot.interrupt_code) break;
        const lowFoodStop = lowFoodEssentialStop(`tunnel-step ${i + 1}/${length}`);
        if (lowFoodStop) { log(bot, `branchMine stop ${lowFoodStop}; no more tunnel`); motion('branchMine.tunnel.stop', { reason: 'low-food-essential-stop', detail: lowFoodStop, step: i + 1, length }); return false; }
        const stop = nightActionableStop(`tunnel-step ${i + 1}/${length}`);
        if (stop) { log(bot, `branchMine stop ${stop}; no more tunnel`); motion('branchMine.tunnel.stop', { reason: 'night-actionable-hostile', detail: stop, step: i + 1, length }); return false; }
        const p = bot.entity.position.floored();
        const beforePos = `${p.x},${p.z}`;
        const ok = await stepInto(new Vec3(p.x + dx, p.y, p.z + dz), dx, dz, `tunnel-step ${i + 1}/${length}`);
        if (!ok) stale++;
        if ((await mineNearby()) === false) return false;
        // Standard branch-mining rib: glance down both side walls periodically so flanking
        // seams get exposed/mined, not just the ore the spine happens to slice through.
        if ((i + 1) % RIB_EVERY === 0) { if ((await ribGlance()) === false) return false; if (bot.interrupt_code) break; }
        const np = bot.entity.position.floored();
        if (`${np.x},${np.z}` === beforePos) { stale++; if (stale >= 4) { log(bot, 'tunnel blocked, stopping'); break; } }
        else stale = 0;
    }
    log(bot, `branchMine done. y=${Math.floor(bot.entity.position.y)} inv=${JSON.stringify(world.getInventoryCounts(bot))}`);
    return true;
}
