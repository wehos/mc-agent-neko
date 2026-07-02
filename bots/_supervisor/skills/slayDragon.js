// Hot-reloadable REAL skill: slay the Ender Dragon LEGIT — ZERO server commands.
// Replaces the old cheat version (/effect x5, /tp, /kill x3 — all deleted).
// Phases:
//   A) reach the main island: if spawned on the obsidian platform off-island,
//      sneak-bridge block-by-block toward 0,0 (sneak = can't slip off the edge).
//   B) destroy the healing end crystals: bow from range when we have bow+arrows
//      (shieldFight draw idiom); otherwise pillar up an adjacent column behind a
//      blast-bunker block and strike once from max reach (they explode ~6 hearts
//      close up — treat every strike like a creeper tap), then dig back down our
//      own column. Iron-bar cages are broken bar by bar.
//   C) the dragon: melee it at the fountain EDGE when it perches (radius 4-6,
//      never onto the bedrock/portal cavity), hold a ~24 ring + bow shots of
//      opportunity while it circles, dodge breath clouds (area_effect_cloud).
// Hard void-safety: every pathing leg is refused unless the target AND midpoint
// columns have solid ground within 24 blocks below (safeGoTo).
// Death detect: dragon entity gone 3 consecutive 1s polls + a 2s re-check,
// EVERY stage gated on still-in-the-End + alive (a mid-fight death auto-respawns
// us in the overworld inside the poll window — health snaps back so stop()
// misses it — and the dimension swap empties bot.entities; entity absence alone
// is NOT a kill) -> stamp endgame.json {dragonDead:true} and return a summary.
// Return contract (kernel dispatch-cooldown discipline):
//   summary string   -> dragon died (truthy)
//   {progress:true}  -> interrupt/budget expiry WITH real progress (no cooldown)
//   false            -> zero progress, or 3x 3-minute no-progress stalls
// Red lines honored: bot.interrupt_code + bot.health<=0 checked EVERY loop
// iteration (break/return style); all cross-call state on bot._endgame +
// endgame.json, zero module-level mutables; no infinite retry (per-crystal
// attempt caps + skip, global 3-min stall strikes); NO cheat commands.
// Invoked via: {"skill":"slayDragon","args":[{"maxMs":600000}]}
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';

const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] [dragon] ${s}\n`); } catch (e) {} };

const FILLER = ['cobblestone', 'cobbled_deepslate', 'end_stone', 'dirt', 'netherrack', 'stone', 'tuff', 'andesite', 'diorite', 'granite'];
const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'netherite_axe', 'diamond_axe', 'iron_axe'];

export default async function slayDragon(bot, ctx, opts = {}) {
    const { skills, world, Vec3, log } = ctx;
    const maxMs = (opts && opts.maxMs) || 1200000;   // total budget (kernel passes 600000; manual default 20 min)
    const t0 = Date.now();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const stop = () => !!bot.interrupt_code || bot.health <= 0;
    const overBudget = () => Date.now() - t0 > maxMs;

    // ── ENTRY GATE: must already be standing in the End. ──
    const inEnd = () => { try { return /end/.test(String((bot.game && bot.game.dimension) || '')); } catch (e) { return false; } };
    if (!inEnd()) {
        log(bot, `slayDragon: not in the End (dim=${bot.game && bot.game.dimension}) — abort.`);
        return false;
    }

    // endgame.json store: the ONE shared helper (skills.egRead/egPatch — BOM-safe,
    // file∪cache∪patch merge, ATOMIC tmp+rename write). The local copy is gone,
    // and so is the endEntered stamp it wrote at entry: that flag was read by
    // NOTHING (every consumer derives End status from bot.game.dimension) and
    // drifted from reality after any death respawn out of the End.

    // ── tiny helpers ──
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const filler = () => FILLER.find(n => has(n) > 0);
    // EXACT entity type only. The old displayName-contains-'dragon' fuzz also
    // matched dragon_fireball ('Dragon Fireball', a projectile): a tracked
    // fireball could impersonate the dragon in perch detection, HP tracking,
    // and the death confirm (goneStreak reset by a projectile).
    const dragon = () => Object.values(bot.entities).find(e => e && e.name === 'ender_dragon');
    const isCrystal = (e) => {
        const s = (((e && e.name) || '') + ' ' + ((e && e.displayName) || '')).toLowerCase();
        return /end/.test(s) && /crystal/.test(s);
    };
    const crystals = () => Object.values(bot.entities).filter(e => e && e.position && isCrystal(e));
    // O(1): mineflayer deletes despawned entities from bot.entities (keyed by
    // e.id — same key the strike path reads via bot.entities[cid]), so a keyed
    // lookup answers "alive?" without re-filtering the whole entity map.
    const crystalAlive = (id) => !!bot.entities[id];
    const eyePos = () => bot.entity.position.offset(0, 1.62, 0);
    const hDist = (pos) => { const p = bot.entity.position; return Math.hypot(pos.x - p.x, pos.z - p.z); };

    // ── progress accounting: drives the 3-min stall strategy + return contract ──
    let crystalsDestroyed = 0;
    let bridgedBlocks = 0;
    let madeProgress = false;
    let lastProgressAt = Date.now();
    let stallStrikes = 0;
    const bail = (why) => {
        const left = crystals().length;
        const d = dragon();
        const hp = d && typeof d.health === 'number' ? Math.round(d.health) : '?';
        log(bot, `slayDragon: ${why} — destroyed=${crystalsDestroyed} crystalsLeft=${left} dragonHp=${hp} t=${Math.round((Date.now() - t0) / 1000)}s`);
        prog(`${why} destroyed=${crystalsDestroyed} left=${left} dragonHp=${hp}`);
        if (madeProgress || crystalsDestroyed > 0 || bridgedBlocks > 4) {
            return { progress: true, crystals: left, dragonHp: d && d.health };
        }
        return false;
    };

    // ── VOID GUARD: refuse any leg whose target/midpoint column is pure void. ──
    const solidWithin = (x, yRef, z, depth = 24) => {
        const cx = Math.floor(x), cz = Math.floor(z);
        const yTop = Math.floor(yRef) + 1;
        for (let dy = 0; dy <= depth; dy++) {
            const b = bot.blockAt(new Vec3(cx, yTop - dy, cz));
            if (b && b.boundingBox === 'block') return true;
        }
        return false;
    };
    const safeGoTo = async (x, y, z, minDist = 2) => {
        const p = bot.entity.position;
        const mx = (p.x + x) / 2, mz = (p.z + z) / 2;
        if (!solidWithin(x, y, z) || !solidWithin(mx, Math.max(y, p.y), mz)) {
            log(bot, `slayDragon: refuse void leg -> ${Math.floor(x)},${Math.floor(z)} (no ground under path)`);
            return false;
        }
        try { await skills.goToPosition(bot, x, y, z, minDist); } catch (e) {}
        return Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z) < minDist + 6;
    };
    // point at the given radius from island center (0,0) along our current bearing.
    // Rim-aware (knockback mitigation-lite): probe the column 2 blocks FURTHER out
    // along the same bearing — if it has no ground we'd be standing at the island
    // edge, where one dragon charge is a void death; pull the radius inward until
    // the outward probe is solid, so ring targets sit >=2 blocks inside the rim.
    const ringPoint = (radius) => {
        const p = bot.entity.position;
        const r = Math.hypot(p.x, p.z) || 1;
        const ux = p.x / r, uz = p.z / r;
        let rad = radius;
        for (let i = 0; i < 4 && !solidWithin(ux * (rad + 2), p.y, uz * (rad + 2)); i++) rad = Math.max(4, rad - 4);
        return { x: ux * rad, z: uz * rad };
    };

    // ── gear: armor + shield + best sword (equipEndgameGear is a cheat file — not used). ──
    if (bot.armorManager) { try { await bot.armorManager.equipAll(); } catch (e) {} }
    const equipSword = async () => {
        for (const s of SWORDS) { if (has(s)) { try { await skills.equip(bot, s); } catch (e) {} return s; } }
        return null;
    };
    const shieldItem = bot.inventory.items().find(i => i.name === 'shield');
    if (shieldItem && (!bot.inventory.slots[45] || bot.inventory.slots[45].name !== 'shield')) {
        try { await bot.equip(shieldItem, 'off-hand'); } catch (e) {}
    }
    const haveShield = () => bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield';
    const raiseShield = () => { try { if (haveShield()) bot.activateItem(true); } catch (e) {} };
    const lowerShield = () => { try { bot.deactivateItem(); } catch (e) {} };
    await equipSword();

    // eat toward the target food level via the shared safe-food helper — the old
    // local FOOD_RE first-match could lock onto carrot_on_a_stick/poisonous_potato/
    // raw chicken mid-fight (see skills.eatPreferred for the priority list).
    const eatUp = async (target = 16) => {
        for (let i = 0; i < 4 && (bot.food || 0) < target; i++) {
            if (stop()) return;
            if (!await skills.eatPreferred(bot)) return;    // no safe food / consume failed
            await sleep(250);
        }
    };
    // back off toward safe center ground, shield up, eat, wait regen (≤30s)
    const regenBreak = async () => {
        lowerShield();
        try {
            const d = dragon();
            if (d && d.position && bot.entity.position.distanceTo(d.position) < 24) await skills.moveAwayFromEntity(bot, d, 12);
        } catch (e) {}
        const t = ringPoint(12);
        await safeGoTo(t.x, bot.entity.position.y, t.z, 2);
        raiseShield();
        await eatUp(18);
        const r0 = Date.now();
        while (!stop() && bot.health < 14 && Date.now() - r0 < 30000) await skills.wait(bot, 1000);   // interrupt-aware
        lowerShield();
    };
    const breathNear = (r = 5) => Object.values(bot.entities).some(e =>
        e && e.position && /area_effect_cloud/.test(e.name || '') && e.position.distanceTo(bot.entity.position) < r);

    // ── knockback mitigation-lite (the old /effect resistance+slow_falling net is
    // gone, and safeGoTo only vetoes PLANNED legs): dragon charges during perch
    // melee and crystal blasts off our own 15-40 block pillar are involuntary
    // flings with no guard. Detect the danger state and try the human recoveries:
    // water-bucket MLG (water DOES place in the End — it's the nether that bans
    // it), else a best-effort block clutch with a FILLER block.
    const fallDanger = () => {
        const e = bot.entity;
        if (!e || e.onGround) return false;
        const vy = e.velocity ? e.velocity.y : 0;
        // trigger arms: below the island floor (~y55, void-bound) OR fast descent
        if (e.position.y >= 55 && vy > -0.8) return false;  // on-island, not a serious fall (yet)
        // either way, only act when the floor is far (>=4 down) — short hops,
        // downhill steps, and rim ledges right below all self-resolve
        for (let d = 1; d <= 4; d++) {
            const b = bot.blockAt(e.position.offset(0, -d, 0));
            if (b && (b.boundingBox === 'block' || /water/.test(b.name || ''))) return false;
        }
        return true;
    };
    const holdingWB = () => bot.heldItem && bot.heldItem.name === 'water_bucket';
    const fallRescue = async () => {
        const wb = bot.inventory.items().find(i => i.name === 'water_bucket');
        const f = filler();
        prog(`fall danger y=${Math.floor(bot.entity.position.y)} vy=${((bot.entity.velocity && bot.entity.velocity.y) || 0).toFixed(2)} — ${wb ? 'MLG water' : f ? 'block clutch' : 'NO clutch item'}`);
        try {
            if (wb) { try { await bot.equip(wb, 'hand'); } catch (e) {} }
            for (let w = 0; w < 12 && !stop() && !bot.entity.onGround; w++) {
                if (wb && holdingWB()) {
                    // re-fires as the floor approaches, so timing self-corrects;
                    // once the water places, heldItem becomes 'bucket' and we stop
                    // activating (or we'd scoop our own landing water mid-fall).
                    try { await bot.look(bot.entity.yaw, -Math.PI / 2, true); } catch (e) {}
                    try { bot.activateItem(); } catch (e) {}
                } else if (!wb && f) {
                    const p = bot.entity.position.floored();
                    try { await skills.placeBlock(bot, f, p.x, p.y - 2, p.z, 'bottom', true); } catch (e) {}
                } else if (!wb) break;
                await sleep(150);
            }
            // landed in our own water — scoop it back so the bucket stays reusable
            if (wb && bot.entity.onGround && bot.heldItem && bot.heldItem.name === 'bucket') {
                await sleep(400);
                try {
                    const src = world.getNearestBlock(bot, 'water', 4);
                    if (src) { await bot.lookAt(src.position.offset(0.5, 0.5, 0.5), true); bot.activateItem(); }
                } catch (e) {}
            }
        } catch (e) {}
        await equipSword();                                 // hand back to combat state
    };

    // ── bow: shieldFight draw idiom + crude drop compensation for high pillar shots ──
    const aimAt = (tp) => tp.offset(0, 0.5 + Math.min(3, hDist(tp) * 0.03), 0);
    const bowShot = async (tp) => {
        lowerShield();
        try { await skills.equip(bot, 'bow'); } catch (e) { return false; }
        try {
            await bot.lookAt(aimAt(tp), true);
            bot.activateItem();            // draw
            await sleep(1100);             // full charge
            await bot.lookAt(aimAt(tp), true);
            bot.deactivateItem();          // release
        } catch (e) {}
        await sleep(900);                  // arrow flight
        return true;
    };
    const hasLoS = (tp) => {
        try {
            const from = eyePos();
            const dir = tp.minus(from);
            const dist = dir.norm();
            if (dist < 1) return true;
            const hit = bot.world.raycast(from, dir.scaled(1 / dist), Math.min(dist, 60));
            return !hit || (hit.position && hit.position.distanceTo(tp) < 2.5);
        } catch (e) { return true; }       // raycast unavailable -> just try the shot
    };

    prog(`LEGIT start dim=${bot.game.dimension} pos=${bot.entity.position.floored()} hp=${Math.round(bot.health)} food=${bot.food} bow=${has('bow')} arrows=${has('arrow')} blocks=${FILLER.reduce((a, n) => a + has(n), 0)}`);
    log(bot, `slayDragon (legit): crystals=${crystals().length} bow=${has('bow')} arrows=${has('arrow')} hp=${Math.round(bot.health)}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE A: get onto the main island (spawn platform may be offset over void).
    // ─────────────────────────────────────────────────────────────────────────
    const endStoneNear = (r) => { try { return !!world.getNearestBlock(bot, 'end_stone', r); } catch (e) { return false; } };
    if (!endStoneNear(6)) {
        prog('phase A: no end_stone near — bridging from the spawn platform toward 0,0');
        // buried spawn pocket: open headroom, then reassess
        for (let up = 0; up < 4; up++) {
            if (stop()) return bail('interrupted (dig out)');
            const p = bot.entity.position.floored();
            const over = bot.blockAt(new Vec3(p.x, p.y + 2, p.z));
            if (!over || over.boundingBox !== 'block') break;
            try { await skills.breakBlockAt(bot, p.x, p.y + 2, p.z); } catch (e) {}
        }
        let bridgeStalls = 0, placeFails = 0;
        bot.setControlState('sneak', true);
        try {
            for (let step = 0; step < 128; step++) {
                if (stop()) return bail('interrupted (bridge)');
                if (overBudget()) return bail('budget expired (bridge)');
                if (endStoneNear(4)) break;                       // island reached
                const p = bot.entity.position.floored();
                // axis-major single-block step toward 0,0
                let dx = 0, dz = 0;
                if (Math.abs(p.x) >= Math.abs(p.z)) dx = p.x === 0 ? 0 : -Math.sign(p.x);
                else dz = p.z === 0 ? 0 : -Math.sign(p.z);
                if (dx === 0 && dz === 0) dz = 1;
                const nx = p.x + dx, nz = p.z + dz;
                // clear head/feet at the next cell (end-stone hillside)
                for (const cy of [p.y + 1, p.y]) {
                    const b = bot.blockAt(new Vec3(nx, cy, nz));
                    if (b && b.boundingBox === 'block') { try { await skills.breakBlockAt(bot, nx, cy, nz); } catch (e) {} }
                }
                // floor under the next cell — place if it's air/void
                const fb = bot.blockAt(new Vec3(nx, p.y - 1, nz));
                if (!fb || fb.boundingBox !== 'block') {
                    const f = filler();
                    if (!f) return bail('out of bridging blocks');
                    let placed = false;
                    for (let t = 0; t < 3 && !placed; t++) {
                        if (stop()) return bail('interrupted (bridge place)');
                        try { await skills.placeBlock(bot, f, nx, p.y - 1, nz, 'bottom', true); } catch (e) {}
                        const nb = bot.blockAt(new Vec3(nx, p.y - 1, nz));
                        placed = !!(nb && nb.boundingBox === 'block');
                        if (!placed) await sleep(250);
                    }
                    if (!placed) { if (++placeFails >= 5) return bail('bridge placement failing'); continue; }
                    bridgedBlocks++;
                }
                // sneak-walk one block forward (sneak = edge-safe)
                try { await bot.lookAt(new Vec3(nx + 0.5, p.y + 1, nz + 0.5), true); } catch (e) {}
                bot.setControlState('forward', true);
                await sleep(800);
                bot.setControlState('forward', false);
                const np = bot.entity.position.floored();
                if (np.x === p.x && np.z === p.z) { if (++bridgeStalls >= 6) return bail('bridge stalled (not moving)'); }
                else bridgeStalls = 0;
            }
        } finally {
            bot.setControlState('sneak', false);
            bot.clearControlStates();
        }
        if (!endStoneNear(6)) return bail('could not reach the island');
        madeProgress = true;
        lastProgressAt = Date.now();
        prog(`phase A done: island reached (${bridgedBlocks} blocks bridged)`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE B: destroy the healing crystals.
    // ─────────────────────────────────────────────────────────────────────────
    const attempts = {};   // crystal entity id -> failed engagement rounds
    const hard = {};       // id -> bow couldn't kill it (caged / no LoS) -> pillar path
    const skip = {};       // id -> given up after 3 failed rounds
    let sawDragon = false;
    prog(`phase B: ${crystals().length} crystals up`);
    let bGuard = 0;
    while (!overBudget() && bGuard++ < 300) {
        if (stop()) return bail('interrupted (crystal phase)');
        if (fallDanger()) { await fallRescue(); continue; }   // blast/charge flung us — clutch first
        if (dragon()) sawDragon = true;
        const alive = crystals();
        if (alive.length === 0) { prog('phase B: all crystals down'); break; }

        // 3-min no-progress -> strategy change (reposition + retry skipped); 3 strikes -> return false
        if (Date.now() - lastProgressAt > 180000) {
            stallStrikes++;
            prog(`phase B stall #${stallStrikes} — repositioning, clearing skip/hard marks`);
            if (stallStrikes >= 3) {
                log(bot, 'slayDragon: no crystal progress for 3x3min — returning false (kernel cooldown spaces retries).');
                bail('stalled out (crystal phase)');
                return false;
            }
            for (const k of Object.keys(skip)) delete skip[k];
            for (const k of Object.keys(hard)) delete hard[k];
            const t = ringPoint(20 + stallStrikes * 8);
            await safeGoTo(t.x, bot.entity.position.y, t.z, 3);
            lastProgressAt = Date.now();
            continue;
        }

        const candidates = alive.filter(c => !skip[c.id]).sort((a, b) =>
            bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
        if (candidates.length === 0) {
            if (alive.length > 2) log(bot, `slayDragon: ⚠ ${alive.length} crystals alive but unreachable — engaging the dragon anyway (it will heal; long fight).`);
            prog(`phase B: ${alive.length} crystals left unreachable — proceeding to dragon`);
            break;
        }
        if (bot.health <= 8) { await regenBreak(); continue; }
        if (breathNear(5)) { try { await skills.moveAway(bot, 8); } catch (e) {} continue; }

        const c = candidates[0];
        const cid = c.id;
        const hasBow = has('bow') > 0 && has('arrow') > 0;
        let destroyedThis = false;

        if (hasBow && !hard[cid]) {
            // relocate to ≤40 with line of sight (≤4 relocations)
            let reloc = 0;
            while (!stop() && reloc < 4 && crystalAlive(cid) &&
                   (hDist(c.position) > 40 || !hasLoS(c.position.offset(0, 0.5, 0)))) {
                const p = bot.entity.position;
                const vx = c.position.x - p.x, vz = c.position.z - p.z;
                const n = Math.hypot(vx, vz) || 1;
                const ok = await safeGoTo(p.x + (vx / n) * 8, p.y, p.z + (vz / n) * 8, 1);
                if (!ok) await safeGoTo(p.x + (vz / n) * 6, p.y, p.z - (vx / n) * 6, 1);   // sidestep
                reloc++;
            }
            if (stop()) return bail('interrupted (crystal bow)');
            let shots = 0;
            while (shots < 4 && !stop() && crystalAlive(cid)) {
                await bowShot(c.position.offset(0, 0.5, 0));
                shots++;
                if (has('arrow') === 0) break;
            }
            await equipSword();
            if (!crystalAlive(cid)) destroyedThis = true;
            else hard[cid] = true;                            // caged/no LoS — pillar path next round
        } else {
            // ---- pillar-and-strike path ----
            const bx = Math.floor(c.position.x), bz = Math.floor(c.position.z);
            let based = false;
            for (const [ox, oz] of [[2, 2], [-2, -2], [2, -2], [-2, 2]]) {
                if (stop()) return bail('interrupted (crystal approach)');
                if (await safeGoTo(bx + ox, bot.entity.position.y, bz + oz, 2)) { based = true; break; }
            }
            if (!based || hDist(c.position) > 6) {
                attempts[cid] = (attempts[cid] || 0) + 1;
                if (attempts[cid] >= 3) { skip[cid] = true; prog(`crystal ${cid} skipped (unreachable x${attempts[cid]})`); }
                await sleep(300);
                continue;
            }
            // blast bunker: 2 filler blocks between us and the column
            const f = filler();
            if (f) {
                const p = bot.entity.position.floored();
                const ux = Math.sign(bx - p.x), uz = Math.sign(bz - p.z);
                if (ux !== 0 || uz !== 0) {
                    for (const dy of [1, 2]) { try { await skills.placeBlock(bot, f, p.x + ux, p.y + dy, p.z + uz, 'bottom', true); } catch (e) {} }
                }
            }
            // climb our own adjacent column to just below the crystal
            const yBefore = Math.floor(bot.entity.position.y);
            let up = false;
            try { up = await skills.pillarUp(bot, Math.floor(c.position.y) - 1); } catch (e) {}
            if (stop()) return bail('interrupted (pillar)');
            if (!up) {
                attempts[cid] = (attempts[cid] || 0) + 1;
                if (attempts[cid] >= 3) { skip[cid] = true; prog(`crystal ${cid} skipped (pillar fail x${attempts[cid]})`); }
                await sleep(300);
                continue;
            }
            // caged? break iron bars within reach, one at a time
            for (let bars = 0; bars < 8; bars++) {
                if (stop()) return bail('interrupted (bars)');
                const bb = world.getNearestBlock(bot, 'iron_bars', 3);
                if (!bb) break;
                try { await skills.breakBlockAt(bot, bb.position.x, bb.position.y, bb.position.z); } catch (e) {}
            }
            // strike ONCE from max reach — it explodes
            const ce = bot.entities[cid];
            const hpB = bot.health;
            if (ce && ce.position && bot.entity.position.distanceTo(ce.position) < 4.5) {
                try { await bot.lookAt(ce.position.offset(0, 0.5, 0), true); } catch (e) {}
                try { await bot.attack(ce); } catch (e) {}
                await sleep(500);
            }
            // crystal-blast knockback can throw us clean off our own 15-40 block
            // column — the exact killer the old /effect net absorbed. Clutch now,
            // BEFORE assessing/descending.
            if (fallDanger()) await fallRescue();
            if (!crystalAlive(cid)) destroyedThis = true;
            // descend by digging down our own placed column — never free-fall
            let ddTries = 0;
            while (Math.floor(bot.entity.position.y) - yBefore > 2 && ddTries++ < 3) {
                if (stop()) return bail('interrupted (descend)');
                try { await skills.digDown(bot, Math.floor(bot.entity.position.y) - yBefore); } catch (e) {}
            }
            if (bot.health < hpB - 8) {
                prog(`crystal blast hit hard (hp ${Math.round(hpB)}->${Math.round(bot.health)}) — regen break`);
                await regenBreak();
            }
            if (!destroyedThis) {
                attempts[cid] = (attempts[cid] || 0) + 1;
                if (attempts[cid] >= 3) { skip[cid] = true; prog(`crystal ${cid} skipped (strike fail x${attempts[cid]})`); }
            }
        }

        if (destroyedThis) {
            crystalsDestroyed++;
            madeProgress = true;
            lastProgressAt = Date.now();
            stallStrikes = 0;
            log(bot, `slayDragon: crystal DOWN (${crystalsDestroyed} destroyed, ${crystals().length} left)`);
            prog(`crystal destroyed #${crystalsDestroyed}, left=${crystals().length}`);
        }
        await sleep(300);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE C: the dragon — perch melee at the fountain edge, ring + bow otherwise.
    // ─────────────────────────────────────────────────────────────────────────
    await equipSword();
    prog(`phase C: engaging dragon (crystals left=${crystals().length})`);
    let lastHp = null;
    { const d0 = dragon(); if (d0) { sawDragon = true; if (typeof d0.health === 'number') lastHp = d0.health; } }
    let goneStreak = 0;
    const cPhaseT0 = Date.now();
    let cGuard = 0;
    let lastPickupAt = 0;   // circling-loop pickup throttle (see below)
    while (!overBudget() && cGuard++ < 2500) {
        if (stop()) return bail('interrupted (dragon phase)');
        if (fallDanger()) { await fallRescue(); continue; }   // charge knockback — clutch first
        const d = dragon();
        if (!d) {
            // ★ FALSE-KILL GUARD (checked at EVERY stage of the confirm): entity
            // absence alone is NOT death. A mid-fight death auto-respawns us in
            // the overworld within the 1s poll window (health snaps back to 20 so
            // stop() misses it) and the dimension swap resets bot.entities — the
            // dragon "vanishes" while very much alive. dragonDead is irreversible
            // (nothing ever clears it), so if we are no longer standing in the
            // End, abort WITHOUT stamping.
            if (!inEnd() || bot.health <= 0) {
                log(bot, `slayDragon: left the End mid-fight (dim=${bot.game && bot.game.dimension}) — NOT a kill, no dragonDead stamp.`);
                prog(`dragon gone but dim=${bot.game && bot.game.dimension} hp=${Math.round(bot.health)} — false-kill guard, no stamp`);
                return false;
            }
            if (!sawDragon) {
                // never saw it yet — don't misread slow entity tracking as a kill
                if (Date.now() - cPhaseT0 > 90000) {
                    const t = ringPoint(10);
                    await safeGoTo(t.x, bot.entity.position.y, t.z, 3);   // move in so it loads
                }
                await skills.wait(bot, 1000);
                continue;
            }
            goneStreak++;
            if (goneStreak >= 3) {
                await skills.wait(bot, 2000);         // confirm — not a tracking blip
                if (stop()) return bail('interrupted (death confirm)');
                if (!inEnd() || bot.health <= 0) {
                    prog('death confirm: left the End mid-confirm — false-kill guard, no stamp');
                    return false;
                }
                if (!dragon()) {
                    // corroborate with the last seen HP: a dragon that vanished at
                    // high health is far likelier untracked than dead — hold one
                    // extra 5s re-check before trusting absence. (Low/unknown HP
                    // proceeds: the kill often lands mid-melee between HP reads,
                    // and some servers never expose d.health at all.)
                    if (typeof lastHp === 'number' && lastHp > 60) {
                        await skills.wait(bot, 5000);
                        if (stop()) return bail('interrupted (death confirm)');
                        if (!inEnd() || bot.health <= 0) return false;
                        if (dragon()) { goneStreak = 0; continue; }   // tracking blip, not a kill
                    }
                    skills.egPatch(bot, { dragonDead: true });
                    const summary = `ENDER DRAGON SLAIN — legit, zero commands. crystals destroyed=${crystalsDestroyed}, time=${Math.round((Date.now() - t0) / 1000)}s, hp=${Math.round(bot.health)}`;
                    log(bot, `★★★ ${summary} ★★★`);
                    prog(`★★★ ${summary} ★★★`);
                    try { await skills.pickupNearbyItems(bot); } catch (e) {}
                    return summary;
                }
                goneStreak = 0;
            }
            await skills.wait(bot, 1000);
            continue;
        }
        sawDragon = true;
        goneStreak = 0;

        // progress = dragon HP dropping (crystals may re-heal it — only count drops)
        if (typeof d.health === 'number') {
            if (lastHp === null || d.health < lastHp - 0.01) { lastProgressAt = Date.now(); madeProgress = true; stallStrikes = 0; }
            lastHp = d.health;
        }
        if (Date.now() - lastProgressAt > 180000) {
            stallStrikes++;
            prog(`phase C stall #${stallStrikes} — repositioning`);
            if (stallStrikes >= 3) {
                log(bot, 'slayDragon: dragon HP flat for 3x3min — returning false (retry after cooldown).');
                bail('stalled out (dragon phase)');
                return false;
            }
            const t = ringPoint(14 + stallStrikes * 6);
            await safeGoTo(t.x, bot.entity.position.y, t.z, 3);
            lastProgressAt = Date.now();
            continue;
        }

        if (bot.health <= 8) { await regenBreak(); continue; }
        if (breathNear(5)) { try { await skills.moveAway(bot, 8); } catch (e) {} continue; }
        if ((bot.food || 0) < 16 && bot.entity.position.distanceTo(d.position) > 16) await eatUp(16);

        const perched = d.position.y < 75 && Math.hypot(d.position.x, d.position.z) < 14;
        if (perched) {
            // fountain EDGE only (radius ~5): never onto the bedrock fountain/portal cavity
            const t = ringPoint(5);
            await safeGoTo(t.x, bot.entity.position.y, t.z, 1);
            let swings = 0;
            while (!overBudget() && swings < 40) {
                if (stop()) return bail('interrupted (perch melee)');
                if (bot.health <= 8) break;
                if (fallDanger()) { await fallRescue(); break; }   // takeoff/charge knockback
                const dd = dragon();
                if (!dd) break;
                if (!(dd.position.y < 75 && Math.hypot(dd.position.x, dd.position.z) < 14)) break;   // took off
                const dist = bot.entity.position.distanceTo(dd.position);
                if (dist > 5) {
                    const p = bot.entity.position;
                    const vx = dd.position.x - p.x, vz = dd.position.z - p.z;
                    const n = Math.hypot(vx, vz) || 1;
                    const stepLen = Math.min(3, Math.max(1, dist - 3.5));
                    const ok = await safeGoTo(p.x + (vx / n) * stepLen, p.y, p.z + (vz / n) * stepLen, 1);
                    swings++;                                   // count as a round — no free spin
                    if (!ok) break;
                    continue;
                }
                try { await bot.lookAt(dd.position.offset(0, 1, 0), true); } catch (e) {}
                try { await bot.attack(dd); } catch (e) {}
                swings++;
                await sleep(650);
            }
        } else {
            // circling: hold the ~24 ring (the dragon strafes players camping center)
            const p = bot.entity.position;
            const r = Math.hypot(p.x, p.z);
            if (r < 16 || r > 34) { const t = ringPoint(24); await safeGoTo(t.x, p.y, t.z, 3); }
            if (has('bow') > 0 && has('arrow') > 0 && d.position && bot.entity.position.distanceTo(d.position) < 40) {
                await bowShot(d.position);                     // body shot
                await equipSword();
            }
            // drop pickup, THROTTLED: pickupNearbyItems runs full GoalFollow
            // pathfinding (5s timeouts, up to 10 attempts) — calling it every
            // ~0.7s iteration turned the ring hold into continuous item-chasing
            // off the safeGoTo-guarded path. At most once per 12s, and only when
            // a drop actually lies within its 8-block reach. (Shot arrows are
            // 'arrow' entities, not 'item' — walking the ring recovers those.)
            if (Date.now() - lastPickupAt > 12000) {
                const dropNear = Object.values(bot.entities).some(e =>
                    e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 8);
                if (dropNear) {
                    lastPickupAt = Date.now();
                    try { await skills.pickupNearbyItems(bot); } catch (e) {}
                }
            }
            await sleep(700);
        }
    }

    // budget expired with the dragon alive: truthy progress object -> no cooldown;
    // the kernel re-dispatches and every phase resumes from live entity state.
    return bail('budget expired (dragon alive)');
}
