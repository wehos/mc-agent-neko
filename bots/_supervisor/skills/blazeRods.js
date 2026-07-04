// Hot-reloadable REAL skill: the in-nether stage of the legit speedrun. Remember the
// arrival portal, find a fortress (nether_bricks scan + expanding exploration legs),
// farm blazes to the rod / eye-equivalent target, then WALK BACK OUT through the
// portal. The exit phase lives HERE because realNetherPortal.js early-returns when
// already in the nether. No cheats anywhere.
//
// Contract (kernel dispatch-cooldown aware):
//   - return false ONLY for "cannot act / zero progress on a full budget" (wrong dim,
//     a full ~50s spawner camp with zero eyeEq gained, no exit portal known/re-lightable/
//     buildable, fruitless full-budget fortress search) — trips the cooldown after 3x.
//   - return the eye-equivalent COUNT (rods*2 + powder + eyes) for partial progress or
//     interrupts; 0 is falsy-but-not-false, so an interrupt never trips the cooldown.
//   - GET_BLAZE_RODS stays committed while in the nether (isGoalDone = back overworld),
//     so each re-dispatch resumes via the phase-select (farm → exit).
// Cross-call state: bot._netherPortalNether, bot._netherExplore, endgame.json — never
// module scope (hot-reload resets module state; HANDOFF red line).
// Invoked via: {"skill":"blazeRods","args":[{"rodTarget":7,"eyeEquivTarget":14,"maxMs":480000}]}
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';

const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] [blaze] ${s}\n`); } catch (e) {} };
// endgame.json read/merge/write lives in skills.egRead/egPatch now (the ONE shared,
// BOM-safe, atomic tmp+rename store) — the per-file copies drifted and are gone.

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword'];

export default async function blazeRods(bot, ctx, opts = {}) {
    const { skills, world, Vec3, log } = ctx;
    // 0 is a LEGIT target (endPortalReady → world_model passes eyeTarget 0 → targetMet is
    // trivially true → straight to exitNether); `|| default` would resurrect it to 7/14 and
    // strand the bot farming rods it can never need. Number.isFinite keeps 0, drops junk.
    const rodTarget = Number.isFinite(opts && opts.rodTarget) ? opts.rodTarget : 7;
    const eqTarget = Number.isFinite(opts && opts.eyeEquivTarget) ? opts.eyeEquivTarget : 14;
    const maxMs = (Number.isFinite(opts && opts.maxMs) && opts.maxMs > 0) ? opts.maxMs : 480000; // 0-budget is never legit
    const t0 = Date.now();
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const eyeEq = () => has('blaze_rod') * 2 + has('blaze_powder') + has('ender_eye');
    const eyeEq0 = eyeEq();  // dispatch-start snapshot: "progress" = eyeEq GREW this dispatch (kernel contract: never return a stale count as progress)
    const inNether = () => { try { return /nether/.test(String(bot.game.dimension || '')); } catch (e) { return false; } };
    const timeUp = () => Date.now() - t0 >= maxMs;
    const targetMet = () => eyeEq() >= eqTarget || has('blaze_rod') >= rodTarget;

    if (!inNether()) { log(bot, 'blazeRods: not in the nether — abort (ENTER_NETHER owns getting here).'); return false; }

    const goWithTimeout = async (x, y, z, range, ms) => {
        let to = null;
        try {
            // ★2026-07-05 预审 P1: goToPosition 的 NoPath/MAROONED 是 resolve(false) 不是 reject —
            // 旧版把它当成功 → 探索循环的失败换向整体失效, 撞熔岩海方向沿一堵墙越走越远。
            const r = await Promise.race([
                skills.goToPosition(bot, x, y, z, range),
                new Promise((_, rej) => { to = setTimeout(() => rej(new Error('leg-timeout')), ms); }),
            ]);
            return r !== false;
        } catch (e) {
            try { bot.pathfinder.stop(); } catch (e2) {}
            try { bot.pathfinder.setGoal(null); } catch (e2) {}
            try { bot.clearControlStates(); } catch (e2) {}
            return false;
        } finally { if (to) clearTimeout(to); }
    };

    // ── PHASE 0: anchor the arrival portal (idempotent; survives restarts via endgame.json).
    //    SCAN FIRST: re-entry after a MIGRATE builds a NEW overworld portal whose nether twin
    //    (~overworld/8 coords) is nowhere near a previous trip's anchor, so a persisted anchor
    //    from ANY earlier trip may sit across a lava ocean. A portal block we can actually SEE
    //    is always a valid (and nearer) exit — trust it and re-persist; the saved anchor is
    //    only the fallback for mid-farm re-dispatches deep in the fortress, out of scan range. ──
    {
        const pb0 = world.getNearestBlock(bot, 'nether_portal', 32);
        if (pb0) {
            const a = { x: pb0.position.x, y: pb0.position.y, z: pb0.position.z };
            const old = bot._netherPortalNether;
            if (!old || old.x !== a.x || old.y !== a.y || old.z !== a.z) {
                bot._netherPortalNether = a;
                skills.egPatch(bot, { netherEntered: true, netherPortalNether: a });
                prog(`portal anchored @ ${a.x},${a.y},${a.z}${old ? ` (rescanned — replaces stale ${old.x},${old.y},${old.z})` : ''}`);
            } else {
                skills.egPatch(bot, { netherEntered: true });
            }
        } else {
            if (!bot._netherPortalNether) {
                const saved = (bot._endgame && bot._endgame.netherPortalNether) || skills.egRead(bot).netherPortalNether;
                if (saved && typeof saved.x === 'number') bot._netherPortalNether = saved;
            }
            skills.egPatch(bot, { netherEntered: true });
        }
    }

    // ── Inline portal rebuild (compact copy of realNetherPortal's placeReal/light geometry;
    //    realNetherPortal itself early-returns in the nether so we CANNOT call it). ──
    const rebuildPortal = async () => {
        if (has('obsidian') < 10 || has('flint_and_steel') < 1) return null;
        const p = bot.entity.position.floored();
        const x0 = p.x, z0 = p.z + 2, gy = p.y - 1;
        const digAt = async (x, y, z) => {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (b && b.name !== 'air' && b.name !== 'cave_air' && !/water|lava|nether_portal|obsidian/.test(b.name)) {
                try { await bot.tool.equipForBlock(b); } catch (e) {}
                try { await bot.dig(b); } catch (e) {}
            }
        };
        const solidAt = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!(b && b.boundingBox === 'block'); };
        const placeReal = async (type, x, y, z) => {
            for (let t = 0; t < 3; t++) {
                if (bot.interrupt_code) return false;
                const b = bot.blockAt(new Vec3(x, y, z));
                if (b && b.name === type) return true;
                if (b && b.name !== 'air' && b.name !== 'cave_air') await digAt(x, y, z);
                try { await skills.placeBlock(bot, type, x, y, z, 'bottom', true); } catch (e) {}
                await skills.wait(bot, 250);
            }
            const fin = bot.blockAt(new Vec3(x, y, z));
            return !!(fin && fin.name === type);
        };
        const frame = [
            [x0, gy, z0], [x0 + 1, gy, z0],                                        // bottom (sunk)
            [x0 - 1, gy + 1, z0], [x0 - 1, gy + 2, z0], [x0 - 1, gy + 3, z0],      // left column
            [x0 + 2, gy + 1, z0], [x0 + 2, gy + 2, z0], [x0 + 2, gy + 3, z0],      // right column
        ];
        const top = [[x0, gy + 4, z0], [x0 + 1, gy + 4, z0]];
        const interior = [];
        for (let dx = 0; dx <= 1; dx++) for (let dy = 1; dy <= 3; dy++) interior.push([x0 + dx, gy + dy, z0]);
        for (const [x, y, z] of [...interior, ...frame, ...top]) await digAt(x, y, z);
        const fillerN = ['cobblestone', 'cobbled_deepslate', 'netherrack', 'blackstone', 'basalt'].find(n => has(n) > 0);
        for (const [x, z] of [[x0 - 1, z0], [x0 + 2, z0]]) {
            if (!solidAt(x, gy, z) && fillerN) await placeReal(fillerN, x, gy, z);  // column base supports
        }
        let ok = true;
        for (const [x, y, z] of frame) { if (!(await placeReal('obsidian', x, y, z))) ok = false; }
        if (!solidAt(x0 - 1, gy + 4, z0) && fillerN) await placeReal(fillerN, x0 - 1, gy + 4, z0); // temp top support
        for (const [x, y, z] of top) { if (!(await placeReal('obsidian', x, y, z))) ok = false; }
        if (!ok) { prog('rebuild: frame incomplete'); return null; }
        for (const [x, y, z] of interior) await digAt(x, y, z);
        let lit = false;
        for (const [x, y, z] of [[x0, gy, z0], [x0 + 1, gy, z0], [x0 - 1, gy + 1, z0], [x0 + 2, gy + 1, z0]]) {
            try { await skills.equip(bot, 'flint_and_steel'); } catch (e) {}
            const b = bot.blockAt(new Vec3(x, y, z));
            if (!b) continue;
            try { await bot.lookAt(b.position.offset(0.5, 1, 0.5), true); } catch (e) {}
            try { await bot.activateBlock(b); } catch (e) {}
            await skills.wait(bot, 1500);
            const inb = bot.blockAt(new Vec3(x0, gy + 1, z0));
            if (inb && inb.name === 'nether_portal') { lit = true; break; }
        }
        if (!lit) { prog('rebuild: frame stands but failed to light'); return null; }
        prog(`rebuilt exit portal @ ${x0},${gy + 1},${z0} (real obsidian, no cheats)`);
        return { x: x0, y: gy + 1, z: z0 };
    };

    // ── Re-light a ghast-extinguished portal. Fireballs break the nether_portal BLOCKS but
    //    the obsidian frame (blast resistance 1200) survives — and we almost never carry the
    //    10 obsidian rebuildPortal needs (the kit's 14 minus realNetherPortal's 10 leaves ~4).
    //    So the cheap fix comes FIRST: flint_and_steel on the intact frame's interior faces,
    //    mirroring realNetherPortal's lighting idiom. Returns portal-block coords or null. ──
    const relightPortal = async () => {
        if (has('flint_and_steel') < 1) return null;
        let cands = [];
        try { cands = bot.findBlocks({ matching: (b) => b && b.name === 'obsidian', maxDistance: 24, count: 48 }) || []; }
        catch (e) { return null; }
        // Frame-bottom candidates: obsidian with the 3-tall former interior (now air, maybe
        // residual fire from the fireball) directly above. Filters out random obsidian floor.
        const airish = (v) => { const b = bot.blockAt(v); return !!(b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'fire')); };
        const bottoms = cands.filter(v => airish(v.offset(0, 1, 0)) && airish(v.offset(0, 2, 0)) && airish(v.offset(0, 3, 0)));
        bottoms.sort((p1, p2) => p1.distanceTo(bot.entity.position) - p2.distanceTo(bot.entity.position));
        for (const v of bottoms.slice(0, 6)) {
            if (bot.interrupt_code || bot.health <= 0) return null;
            await goWithTimeout(v.x, v.y + 1, v.z, 3, 30000);
            const b = bot.blockAt(v);
            if (!b || b.name !== 'obsidian') continue;
            try { await skills.equip(bot, 'flint_and_steel'); } catch (e) {}
            try { await bot.lookAt(b.position.offset(0.5, 1, 0.5), true); } catch (e) {}
            try { await bot.activateBlock(b); } catch (e) {}
            await skills.wait(bot, 1500);
            const relit = world.getNearestBlock(bot, 'nether_portal', 8);
            if (relit) {
                prog(`re-lit extinguished portal @ ${relit.position.x},${relit.position.y},${relit.position.z} (flint_and_steel on the surviving frame)`);
                return { x: relit.position.x, y: relit.position.y, z: relit.position.z };
            }
        }
        return null;
    };

    // ── EXIT phase: walk back out through the portal. Own 3-min deadline (the farm may
    //    have consumed all of maxMs; the sticky commitment re-dispatches us to resume). ──
    const exitNether = async () => {
        let target = bot._netherPortalNether
            || (bot._endgame && bot._endgame.netherPortalNether)
            || skills.egRead(bot).netherPortalNether || null;
        if (!target || typeof target.x !== 'number') {
            const pb2 = world.getNearestBlock(bot, 'nether_portal', 64);
            target = pb2 ? { x: pb2.position.x, y: pb2.position.y, z: pb2.position.z } : null;
        }
        if (!target) {
            const rebuilt = (await relightPortal()) || (await rebuildPortal());   // extinguished frame nearby? re-light beats rebuild
            if (rebuilt) { bot._netherPortalNether = rebuilt; skills.egPatch(bot, { netherPortalNether: rebuilt }); target = rebuilt; }
        }
        if (!target) { log(bot, 'blazeRods: rods secured but NO exit portal known/re-lightable/buildable — abort (need an intact frame + flint_and_steel, or obsidian x10).'); return false; }

        // Walk toward the portal in ≤32-block legs, interrupt-checked per leg.
        const tv = new Vec3(target.x, target.y, target.z);
        const exitDeadline = Date.now() + 180000;
        let stalls = 0, lastD = Infinity;
        while (Date.now() < exitDeadline) {
            if (bot.interrupt_code || bot.health <= 0) return eyeEq();
            if (bot.food < 12) await skills.eatPreferred(bot);
            const p = bot.entity.position;
            const dx = tv.x + 0.5 - p.x, dz = tv.z + 0.5 - p.z;
            const flat = Math.hypot(dx, dz);
            if (flat <= 3 && Math.abs(tv.y - p.y) <= 4) break;
            const step = Math.min(32, flat);
            const tx = p.x + (dx / (flat || 1)) * step;
            const tz = p.z + (dz / (flat || 1)) * step;
            const ty = step >= flat ? tv.y : Math.floor(p.y);
            await goWithTimeout(tx, ty, tz, 2, 45000);
            const nd = bot.entity.position.distanceTo(tv);
            if (nd >= lastD - 1) {
                stalls++;
                if (stalls >= 4) { log(bot, `blazeRods: cannot path back to portal (stuck at ${Math.round(nd)} blocks) — abort this dispatch.`); return false; }
            } else { stalls = 0; }
            lastD = nd;
        }

        // Stand INTO the portal block and poll for the swap (realNetherPortal enterPortal idiom).
        let pb = world.getNearestBlock(bot, 'nether_portal', 16);
        if (!pb) {
            // Ghast-broken portal at the anchor: the portal BLOCKS are gone but the frame
            // survives — re-light with the flint_and_steel we carry; the full rebuild
            // (obsidian x10 we usually don't have) is strictly the last resort.
            const rebuilt = (await relightPortal()) || (await rebuildPortal());
            if (rebuilt) { bot._netherPortalNether = rebuilt; skills.egPatch(bot, { netherPortalNether: rebuilt }); pb = world.getNearestBlock(bot, 'nether_portal', 16); }
        }
        if (!pb) { log(bot, 'blazeRods: arrived at anchor but no portal block (and no re-light/rebuild) — abort.'); return false; }
        try { await skills.goToPosition(bot, pb.position.x, pb.position.y, pb.position.z, 1); } catch (e) {}
        try { await bot.lookAt(pb.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
        bot.setControlState('forward', true);
        await skills.wait(bot, 1500);
        bot.clearControlStates();
        for (let i = 0; i < 30; i++) {                                   // up to 15s for the dimension swap
            if (!inNether()) {
                skills.egPatch(bot, { netherEntered: true });
                prog(`★ EXITED the nether: rods=${has('blaze_rod')} powder=${has('blaze_powder')} eyes=${has('ender_eye')} (eyeEq=${eyeEq()})`);
                log(bot, `Back in the overworld with ${has('blaze_rod')} blaze rods (eyeEq=${eyeEq()}/${eqTarget}).`);
                return eyeEq();
            }
            await skills.wait(bot, 500);
        }
        log(bot, 'blazeRods: stood in the portal but no dimension swap — will retry next dispatch.');
        // eyeEq0 DELTA, not stock (2026-07-02 contract audit): targetMet() from a PRIOR dispatch
        // phase-selects straight here with eyeEq()===eyeEq0; `> 0` returned that stale count →
        // kernel success → fail-counter reset → hot ~2s re-dispatch of the identical
        // stand-adjacent/no-swap cycle forever. Farm→exit rods gained THIS dispatch stay truthy;
        // a pure no-swap re-stand strikes into the 60s-capped in-nether cooldown.
        return eyeEq() > eyeEq0 ? eyeEq() : false;
    };

    // ── PHASE-SELECT: enough rods already → straight to EXIT. ──
    if (targetMet()) return await exitNether();

    // ── FARM (a): find a fortress — nether_bricks scan, else expanding exploration legs.
    //    Exploration state lives on bot._netherExplore (resumable across dispatches). ──
    if (!bot._netherExplore) {
        bot._netherExplore = { origin: { x: Math.floor(bot.entity.position.x), z: Math.floor(bot.entity.position.z) }, dirIdx: 0, leg: 0 };
    }
    const findFortress = () => bot.findBlock({ matching: (b) => b && b.name === 'nether_bricks', maxDistance: 64 });
    // ★2026-07-05 oracle 接缝 (daemon 维度修复后 nearest.fortress 首次可用): 有新鲜堡垒坐标
    // → 直线分段行军替代盲螺旋; 连续 3 腿走不通(熔岩海)则本轮退回螺旋换向。
    const oracleFortress = () => {
        try {
            const o = bot._world && bot._world.oracle;
            const f = o && o.fresh && o.dim === 'the_nether' && o.nearest && o.nearest.fortress;
            return (f && Number.isFinite(f.x)) ? f : null;
        } catch (e) { return null; }
    };
    let fortress = findFortress();
    while (!fortress && !timeUp()) {
        if (bot.interrupt_code || bot.health <= 0) return eyeEq();
        // ★2026-07-05 预审 P1: 下界死亡重生回主世界后技能变僵尸 — 主世界扫 nether_bricks +
        // 按下界坐标走腿, 烧完预算还占着 supervised busy。维度守卫: 已离开下界即结算退出。
        if (!inNether()) { prog('blazeRods: no longer in nether (death/portal) — bail'); return eyeEq() > eyeEq0 ? eyeEq() : 0; }
        if (bot.food < 12) await skills.eatPreferred(bot);
        const st = bot._netherExplore;
        const of = oracleFortress();
        if (of && (st.oracleFails || 0) < 3) {
            const p = bot.entity.position;
            const dx = of.x - p.x, dz = of.z - p.z, flat = Math.hypot(dx, dz) || 1;
            const step = Math.min(32, flat);
            const ok = await goWithTimeout(p.x + (dx / flat) * step, Math.floor(p.y), p.z + (dz / flat) * step, 6, 45000);
            st.oracleFails = ok ? 0 : (st.oracleFails || 0) + 1;
            if (!ok) st.dirIdx = (st.dirIdx + 1) % 4;
            if ((st.oracleFails || 0) === 3) prog(`blazeRods: oracle 定向连败 3 腿 (熔岩海?) — 本轮退回螺旋探索`);
        } else {
            const dir = DIRS[st.dirIdx % 4];
            const dist = (st.leg + 1) * 32;
            const tx = st.origin.x + dir[0] * dist;
            const tz = st.origin.z + dir[1] * dist;
            const ok = await goWithTimeout(tx, Math.floor(bot.entity.position.y), tz, 6, 45000);
            if (ok) st.leg++;
            else st.dirIdx = (st.dirIdx + 1) % 4;                        // change heading, never grind one wall
        }
        fortress = findFortress();
    }
    if (!fortress) {
        log(bot, `blazeRods: no fortress within budget (explored ${bot._netherExplore.leg} legs from ${bot._netherExplore.origin.x},${bot._netherExplore.origin.z}).`);
        // eyeEq0 DELTA (2026-07-02 contract audit): keepInventory keeps a partial stock across
        // deaths, so `> 0` returned a stale truthy count on a fruitless FULL-budget search in a
        // walled/lava-locked pocket → kernel reset the fail counter → identical 8-min search
        // re-dispatched forever. Zero gained = strike; bot._netherExplore persists, so the next
        // dispatch resumes the leg pattern after the cooldown spaces it.
        return eyeEq() > eyeEq0 ? eyeEq() : false;                       // fruitless full budget → cooldown spaces retries
    }
    prog(`fortress found @ ${fortress.position.x},${fortress.position.y},${fortress.position.z}`);

    // ── FARM (b): blaze camp. Shield to offhand, best sword, retreat-on-low-hp. ──
    for (const s of SWORDS) { if (has(s)) { await skills.equip(bot, s).catch(() => {}); break; } }
    const shieldItem = bot.inventory.items().find(i => i.name === 'shield');
    if (shieldItem && (!bot.inventory.slots[45] || bot.inventory.slots[45].name !== 'shield')) {
        try { await bot.equip(shieldItem, 'off-hand'); } catch (e) {}
    }
    const haveShield = () => !!(bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');

    await goWithTimeout(fortress.position.x, fortress.position.y + 1, fortress.position.z, 3, 60000);
    let stalls = 0;
    while (!targetMet() && !timeUp()) {
        if (bot.interrupt_code || bot.health <= 0) return eyeEq();
        if (!inNether()) { prog('blazeRods: no longer in nether (death mid-farm) — bail'); return eyeEq() > eyeEq0 ? eyeEq() : 0; }   // ★2026-07-05 预审 P1 僵尸模式守卫
        if (bot.food < 12) await skills.eatPreferred(bot);
        if (bot.health <= 8) {
            // Retreat + regen under shield; blaze fireballs are shield-blockable.
            log(bot, `blazeRods: hp=${Math.round(bot.health)} — retreating to regen.`);
            await skills.moveAway(bot, 14).catch(() => {});
            try { if (haveShield()) bot.activateItem(true); } catch (e) {}
            for (let w = 0; w < 20; w++) {
                if (bot.interrupt_code || bot.health <= 0) break;
                if (bot.health >= 14) break;
                await skills.wait(bot, 1000);
            }
            try { bot.deactivateItem(); } catch (e) {}
            continue;
        }
        const bl = world.getNearestEntityWhere(bot, (e) => (e.name || '') === 'blaze', 32);
        if (!bl) {
            const sp = bot.findBlock({ matching: (b) => b && b.name === 'spawner', maxDistance: 48 });
            if (sp) {
                await goWithTimeout(sp.position.x, sp.position.y, sp.position.z, 4, 30000);
                // CAMP, don't churn: blaze spawner cycles are 10-40s, and once we're within
                // 4 blocks the scan+go iteration is sub-second — without this wait the whole
                // stall budget burns in ~2s between waves and we false out into the 5-min
                // kernel cooldown. Interrupt-aware (skills.wait aborts on bot.interrupt_code).
                await skills.wait(bot, 5000);
            } else {
                await skills.moveAway(bot, 12).catch(() => {});
            }
            stalls++;
            // 10 x ~5s = ≥50s camped: at least one full worst-case spawn cycle before giving up.
            if (stalls >= 10) {
                log(bot, 'blazeRods: camped the fortress ~50s+ with no blaze — give up this dispatch (cooldown spaces retries).');
                // Rods farmed THIS dispatch = real progress, no strikeout; a stale pre-dispatch
                // count must NOT mask a zero-progress run (kernel failure contract).
                return eyeEq() > eyeEq0 ? eyeEq() : false;
            }
            continue;
        }
        stalls = 0;
        const d = bl.position.distanceTo(bot.entity.position);
        if (has('bow') > 0 && has('arrow') > 0 && d > 10) {
            // shieldFight's bow-draw pattern: draw, charge, re-aim, release.
            try { await skills.equip(bot, 'bow'); } catch (e) {}
            try {
                const aim = () => bot.lookAt(bl.position.offset(0, (bl.height || 1.8) * 0.6, 0));
                await aim();
                bot.activateItem();
                await skills.wait(bot, 1100);
                await aim();
                bot.deactivateItem();
            } catch (e) {}
            for (const s of SWORDS) { if (has(s)) { await skills.equip(bot, s).catch(() => {}); break; } }
        } else {
            await skills.attackEntity(bot, bl, true).catch(() => {});
        }
        await skills.pickupNearbyItems(bot).catch(() => {});
    }
    if (!targetMet()) {
        log(bot, `blazeRods: budget out mid-farm (rods=${has('blaze_rod')}/${rodTarget} eyeEq=${eyeEq()}/${eqTarget}) — commitment re-dispatches to resume.`);
        // eyeEq0 DELTA (2026-07-02 contract audit): a visible-but-unreachable blaze keeps `bl`
        // non-null so stalls resets every loop, bypassing the stalls>=10 guard above entirely —
        // the whole 8-min budget can burn with ZERO gained while stale stock kept `> 0` truthy →
        // kernel reset the fail counter → identical zero-gain cycle forever. Rods farmed THIS
        // dispatch stay truthy (partial progress); a zero-gain full budget strikes.
        return eyeEq() > eyeEq0 ? eyeEq() : false;
    }
    prog(`rod target met: rods=${has('blaze_rod')} eyeEq=${eyeEq()} — heading to exit portal`);
    return await exitNether();
}
