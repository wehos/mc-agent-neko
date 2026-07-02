// Hot-reloadable REAL skill: the missing NIGHT_DIG_ONE@92 / NIGHT_SEAL@91 dispatch
// target. Two modes selected by the first arg (world_model passes ['dig_one'] or ['seal']):
//   'dig_one' -> 挖三填一 cap shelter: dig ONE block down + cap the head + patch only the
//                open sides (skills.digOneCapOne — reuses digDown's water/lava/gravity
//                guards). Downgrades to 'seal' when the dig is unsafe (gravity column,
//                y<=16, aquifer) — digOneCapOne itself refuses those.
//   'seal'    -> bunker in place: fill every open cell of the feet ring, head ring and
//                ceiling around the bot (shelter.js ring geometry, boundingBox test).
// Then HOLD sealed (eating if hungry) until day / interrupt / maxMs.
//
// Per-dispatch maxMs=120s: the NIGHT_* commitment is sticky until isGoalDone releases it
// (w.time.phase==='day'), so the kernel simply re-dispatches; re-entry is cheap (already
// sealed → phase 1 places nothing) and the 2s-cycle churn is avoided while every held
// second stays interruptible.
//
// Red lines honored: ENTRY condition (already day) checked ONCE at the gate; the hold
// loop checks bot.interrupt_code AND bot.health<=0 EVERY iteration; zero module-level
// state; no infinite retry (out-of-blocks + can't-dig → return false, kernel cooldown
// spaces out genuinely impossible dispatches).
// Invoked via: {"skill":"nightShelter",["dig_one"]}  ctx = { skills, world, mc, Vec3, log }
export default async function nightShelter(bot, ctx, mode = 'seal', opts = {}) {
    const { skills, world, Vec3, log } = ctx;
    const maxMs = (opts && opts.maxMs) || 120000;
    const t0 = Date.now();
    const FILLER = ['cobblestone', 'cobbled_deepslate', 'dirt', 'tuff', 'andesite', 'stone', 'granite', 'diorite'];
    const filler = () => FILLER.find(n => (world.getInventoryCounts(bot)[n] || 0) > 0);
    // modes.js refreshes bot._world every ~2s; phase 'day' is exactly what isGoalDone
    // uses to release NIGHT_DIG_ONE/NIGHT_SEAL, so skill and proposer share one truth.
    const isDay = () => { try { return !!(bot._world && bot._world.time && bot._world.time.phase === 'day'); } catch (e) { return false; } };

    if (mode !== 'dig_one') mode = 'seal'; // only two modes; junk args behave as the safe default

    // ── ENTRY gate (checked once, per red line — not re-checked mid-build) ──
    if (isDay()) return true; // night already over, nothing to shelter from

    // ── PHASE 1: build the shelter ──
    if (mode === 'dig_one') {
        // ★undiggable-under-feet guard (live 2026-07-02 04:33: bot stood ON its own furnace,
        // PICKLESS — furnace is pick-tier, ~17.5s bare-hand vs the ~3-5s per-dig budget, so
        // digOneCapOne's digDown(1) cycled held items (stick/planks/dandelion/egg/beef...)
        // all night, each swap RESETTING break progress — visible as "switching tools,
        // furnace never breaks"). Utility blocks are ALSO the bot's own infrastructure —
        // never shelter-dig them even with a pick. digTime check is fail-open (try/catch).
        const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        const utilityRe = /furnace|crafting_table|chest|barrel|smoker|blast_furnace|bed$/;
        let tooHard = false;
        try { tooHard = below ? below.digTime(bot.heldItem ? bot.heldItem.type : null, false, false, false) > 4500 : false; } catch (e) {}
        if (below && (utilityRe.test(below.name || '') || tooHard)) {
            log(bot, `nightShelter: block under feet is ${below.name} (${utilityRe.test(below.name || '') ? 'own utility block' : 'undiggable within budget'}) — skip dig_one, seal instead.`);
            mode = 'seal';
        } else {
            const ok = await skills.digOneCapOne(bot).catch(() => false);
            if (!ok) { log(bot, 'nightShelter: dig_one refused/failed (gravity/depth/aquifer guard) — downgrading to seal.'); mode = 'seal'; }
            else log(bot, 'nightShelter: 挖三填一 pocket sealed.');
        }
    }
    if (mode === 'seal') {
        const p = bot.entity.position.floored();
        // feet ring (y), head ring (y+1), ceiling (y+2) — shelter.js geometry.
        const RING = [
            [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
            [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
            [0, 2, 0],
        ];
        let placed = 0, openLeft = 0;
        for (const [dx, dy, dz] of RING) {
            if (bot.interrupt_code || bot.health <= 0) return false;
            const c = new Vec3(p.x + dx, p.y + dy, p.z + dz);
            const b = bot.blockAt(c);
            if (b && b.boundingBox === 'block') continue; // solid terrain already walls this cell
            const f = filler();
            if (!f) { openLeft++; continue; }
            await skills.placeBlock(bot, f, c.x, c.y, c.z, 'bottom', true).catch(() => {});
            const after = bot.blockAt(c);
            if (after && after.boundingBox === 'block') placed++;
            else openLeft++;
        }
        log(bot, `nightShelter: sealed ${placed} cell(s), ${openLeft} still open, filler left=${filler() || 'none'}.`);
        // Holes remain and the block bag is empty → last resort is the dig-one pocket
        // (it needs ~1 cap block at most and digOneCapOne re-checks its own safety).
        if (openLeft > 0 && !filler()) {
            if (!(await skills.digOneCapOne(bot).catch(() => false))) {
                log(bot, 'nightShelter: no filler and cannot dig — exposed');
                return false;
            }
        }
    }

    // ── PHASE 2: hold until day (EVERY iteration checks interrupt + death, red line) ──
    while (!isDay() && Date.now() - t0 < maxMs) {
        if (bot.interrupt_code || bot.health <= 0) break;
        if (bot.food != null && bot.food < 12) {
            const f = bot.inventory.items().find(i =>
                /^(cooked_|bread$|apple$|baked_|carrot$|potato$)/.test(i.name) || /cooked_/.test(i.name));
            if (f) await skills.consume(bot, f.name).catch(() => {});
        }
        await skills.wait(bot, 2000);
    }
    return true; // sheltered the night slice we were dispatched for (commitment holds till day)
}
