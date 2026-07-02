// Hot-reloadable REAL skill: HUNT_PEARLS dispatch target — overworld NIGHT enderman
// hunt under a 2-high cover pocket. Endermen are 3 blocks tall: they cannot occupy a
// 2-high space, so a roofed pocket turns the fight into safe hit-trading. Anti-stare
// mechanics: deliberate 1s gaze at the EYES to aggro (it teleport-approaches us), then
// look at its FEET and hold the pocket — NEVER chase (chasing leaves the cover).
//
// Contract (kernel dispatch-cooldown aware): always returns the ender_pearl COUNT
// (0 is falsy-but-not-false → a fruitless night never trips the cooldown; worst case
// is one ~6-min dispatch per empty night and isGoalDone releases at dawn). Returns
// false only for hard prereq failure (wrong dimension).
// All timers/counters loop-local; pocket position in a local var; nothing module-level.
// Invoked via: {"skill":"enderPearls","args":[{"pearlTarget":12,"maxMs":360000}]}
// ctx = { skills, world, mc, Vec3, log }
const FILLER = ['cobblestone', 'cobbled_deepslate', 'dirt', 'tuff', 'andesite', 'diorite', 'granite', 'stone'];
const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword'];

export default async function enderPearls(bot, ctx, opts = {}) {
    const { skills, world, Vec3, log } = ctx;
    const pearlTarget = (opts && opts.pearlTarget) || 12;
    const maxMs = (opts && opts.maxMs) || 360000;
    const t0 = Date.now();
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const filler = () => FILLER.find(b => has(b) > 0);
    const isDay = () => {
        try { if (bot._world && bot._world.time && bot._world.time.phase) return bot._world.time.phase === 'day'; } catch (e) {}
        try { const t = (bot.time.timeOfDay || 0) % 24000; return t < 12000 || t >= 23500; } catch (e) { return false; }
    };
    // Sword back to hand — consume() leaves FOOD in the hand and placeBlock leaves the
    // FILLER block, so anything that touched the hand slot must be followed by this or
    // every bot.attack below swings food/cobble at 1 dmg vs a 40-HP enderman.
    const equipSword = async () => {
        for (const s of SWORDS) { if (has(s)) { await skills.equip(bot, s).catch(() => {}); break; } }
    };

    const dim = String((bot.game && bot.game.dimension) || 'overworld');
    if (/nether|end/.test(dim)) { log(bot, `enderPearls ABORT — wrong dimension (${dim}); this is the overworld night hunt.`); return false; }

    // ── Gear: best sword to hand, shield to offhand (shieldFight idiom). ──
    await equipSword();
    const shieldItem = bot.inventory.items().find(i => i.name === 'shield');
    if (shieldItem && (!bot.inventory.slots[45] || bot.inventory.slots[45].name !== 'shield')) {
        try { await bot.equip(shieldItem, 'off-hand'); } catch (e) {}
    }

    // ── PREP: roof the pocket ONCE per call — a filler block 2 above our feet. Direct
    //    placement needs an adjacent solid face; on open ground, build a 3-high side
    //    pillar first and hang the roof off its top. ──
    const solid = (v) => { const b = bot.blockAt(v); return !!(b && b.boundingBox === 'block'); };
    const tryRoofHere = async () => {
        const p = bot.entity.position.floored();
        const roof = new Vec3(p.x, p.y + 2, p.z);
        if (solid(roof)) return p;                                   // natural overhang — done
        if (!filler()) return null;
        try { await skills.placeBlock(bot, filler(), roof.x, roof.y, roof.z, 'bottom', true); } catch (e) {}
        if (solid(roof)) return p;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (bot.interrupt_code || bot.health <= 0) return null;
            if (!filler()) return null;
            for (let dy = 0; dy <= 2; dy++) {
                const cell = new Vec3(p.x + dx, p.y + dy, p.z + dz);
                if (solid(cell)) continue;
                try { await skills.placeBlock(bot, filler(), cell.x, cell.y, cell.z, 'bottom', true); } catch (e) {}
            }
            try { await skills.placeBlock(bot, filler(), roof.x, roof.y, roof.z, 'bottom', true); } catch (e) {}
            if (solid(roof)) return p;
        }
        return null;
    };
    let pocket = await tryRoofHere();
    if (!pocket) {                                                   // placement failed here — move 6 and retry once
        await skills.moveAway(bot, 6).catch(() => {});
        pocket = await tryRoofHere();
    }
    if (!pocket) {
        pocket = bot.entity.position.floored();
        log(bot, 'enderPearls: could not roof a cover pocket — hunting uncovered (riskier; modes own emergencies).');
    }
    const toPocket = async () => {
        if (bot.entity.position.distanceTo(pocket.offset(0.5, 0, 0.5)) > 1.5) {
            await skills.goToPosition(bot, pocket.x, pocket.y, pocket.z, 0).catch(() => {});
        }
    };

    // ── MAIN night loop. ──
    let scanIdle = 0;
    const blacklist = new Set();  // per-dispatch: entity ids that burned their fight cap without dying — stop re-picking them as "nearest"
    while (has('ender_pearl') < pearlTarget && !isDay() && Date.now() - t0 < maxMs) {
        if (bot.interrupt_code || bot.health <= 0) break;
        if (bot.health <= 8) {                                       // stay in pocket, regen; modes own real emergencies
            await toPocket();
            await skills.wait(bot, 4000);
            continue;
        }
        if (bot.food < 12) {
            await skills.eatPreferred(bot);                          // shared safe-food helper (never throws)
            await equipSword();                                      // consume left food in hand — restore weapon
        }

        const em = world.getNearestEntityWhere(bot, (e) => (e.name || '') === 'enderman' && !blacklist.has(e.id), 48);
        if (!em) {
            scanIdle++;
            if (scanIdle >= 20) {                                    // ~60s with no endermen — yield the night
                log(bot, `enderPearls: no endermen for 60s+ — yielding night (pearls=${has('ender_pearl')}/${pearlTarget}).`);
                return has('ender_pearl');
            }
            await skills.wait(bot, 3000);
            continue;
        }
        scanIdle = 0;

        // ── AGGRO: from the pocket, stare at its EYES for 1s (aggro trigger), then drop
        //    our gaze to its FEET so we control when the anger starts — it teleports to us. ──
        await toPocket();
        await equipSword();     // roofing/eating may have left filler/food in hand — weapon up BEFORE the fight
        try { await bot.lookAt(em.position.offset(0, 2.6, 0), true); } catch (e) {}
        await skills.wait(bot, 1000);
        try { await bot.lookAt(em.position.offset(0, 0.2, 0), true); } catch (e) {}

        // ── FIGHT sub-loop: hold the pocket, swing when it's in reach, never chase. ──
        const id = em.id;
        let farSince = 0;
        const fightT0 = Date.now();                                  // per-target cap: a neutral idler must not eat the night
        let reAggroed = false;                                       // one re-stare if the first aggro glance missed
        while (!isDay() && Date.now() - t0 < maxMs) {
            if (bot.interrupt_code || bot.health <= 0) break;
            if (Date.now() - fightT0 > 45000) {                      // CAP: 45s and it's still alive → passive/unreachable
                blacklist.add(id);                                   // (e.g. in a cave below — no line of sight); skip it
                log(bot, 'enderPearls: target idle past 45s cap — blacklisting for this dispatch, next target.');
                break;
            }
            const ent = bot.entities[id];
            if (!ent || ent.isValid === false) break;                // dead/despawned — sweep drops below
            const d = ent.position.distanceTo(bot.entity.position);
            if (d >= 20) break;                                      // wandered/teleported off — new target
            if (d > 16) {                                            // TELEPORT-STALL: parked far away >6s
                if (!farSince) farSince = Date.now();
                else if (Date.now() - farSince > 6000) break;
            } else { farSince = 0; }
            if (d <= 3.2) {
                try { await bot.attack(ent); } catch (e) {}
                await skills.wait(bot, 600);
            } else {
                if (!reAggroed && Date.now() - fightT0 > 15000) {    // 15s and it hasn't closed — first stare missed;
                    reAggroed = true;                                //   one LIVE re-stare at the eyes (aggro trigger)
                    try { await bot.lookAt(ent.position.offset(0, 2.6, 0), true); } catch (e) {}
                    await skills.wait(bot, 1000);
                }
                try { await bot.lookAt(ent.position.offset(0, 0.2, 0), true); } catch (e) {}  // feet — no re-stare
                await skills.wait(bot, 400);                         // it approaches; we hold the pocket
            }
        }
        await skills.pickupNearbyItems(bot).catch(() => {});         // pearls drop where it died
    }

    log(bot, `enderPearls done: pearls=${has('ender_pearl')}/${pearlTarget} hp=${Math.round(bot.health)} day=${isDay()} (${Math.round((Date.now() - t0) / 1000)}s)`);
    return has('ender_pearl');   // count: 0 is falsy-but-not-false — never trips the kernel cooldown
}
