// Hot-reloadable REAL skill: the missing DUSK_GO_BED executor (2026-07-02 checkpoint #12:
// the kind used to dispatch prepNether, whose night decision-layer early-returns BY DESIGN
// — kernel counted the yield as failure, 3-struck it into 5-min cooldowns all night, and
// with a usable village bed 2.5 BLOCKS AWAY the bot kited zombies in the open instead.
// Sleeping skips the night entirely = doubled daylight windows, which the food chain is
// starving for). ★C331 note: bed-USE was designed as the go_to_bed_sleep instinct's job;
// this skill is the kernel-driven twin for when the kind is committed — the instinct's
// test yields to a committed DUSK_GO_BED (modes.js) so the two never double-handle.
//
// Return contract: truthy {slept:true} after a confirmed sleep (or already-day wake);
// false when it genuinely cannot act (no bed known/found, unreachable, hostiles block
// vanilla sleep, sleep throws) so the kernel's 3-strike cooldown falls through to the
// NIGHT_DIG_ONE/NIGHT_SEAL shelter fallbacks. No module-level state.
// Invoked via: {"skill":"goBedSleep"}  ctx = { skills, world, mc, Vec3, log }
export default async function goBedSleep(bot, ctx) {
    const { skills, world, Vec3, log } = ctx;
    const isNightish = () => { try { const t = bot.time.timeOfDay; return t >= 12000 && t <= 23458; } catch (e) { return false; } };
    const hostileNear = (r) => { try { return Object.values(bot.entities || {}).some(e => e && e !== bot.entity && e.position && ctx.mc.isHostile(e) && e.position.distanceTo(bot.entity.position) < r); } catch (e) { return false; } };

    if (!isNightish()) return { slept: false, day: true };   // night already over — commitment releases at day

    // 1) Locate a bed: world-model landmark first (survives chunk unload), then a live scan.
    let tgt = null;
    try { const lm = bot._world && bot._world.landmarks; if (lm && lm.bed && Number.isFinite(lm.bed.x)) tgt = lm.bed; } catch (e) {}
    let bedBlock = bot.findBlock({ matching: (b) => b && /_bed$/.test(b.name || ''), maxDistance: 8 });
    if (!bedBlock && tgt) {
        // Walk toward the landmark (bounded — a bed 2.5b away was being ignored all night;
        // one long-ish walk is still cheaper than a night of kiting).
        try { await skills.goToPosition(bot, tgt.x, tgt.y, tgt.z, 2); } catch (e) {}
        if (bot.interrupt_code || bot.health <= 0) return false;
        bedBlock = bot.findBlock({ matching: (b) => b && /_bed$/.test(b.name || ''), maxDistance: 8 });
    }
    if (!bedBlock) { log(bot, 'goBedSleep: no bed within reach (landmark stale or none) — false, shelter chain takes over.'); return false; }

    // 2) Close to interaction range.
    if (bot.entity.position.distanceTo(bedBlock.position) > 2.6) {
        try { await skills.goToPosition(bot, bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2); } catch (e) {}
        if (bot.interrupt_code || bot.health <= 0) return false;
    }
    if (bot.entity.position.distanceTo(bedBlock.position) > 3.2) {
        log(bot, 'goBedSleep: bed unreachable (pathing stopped short) — false.');
        return false;
    }

    // 3) Vanilla blocks sleep with hostiles within ~8 — don't burn the attempt (and the
    //    kernel strike) on a guaranteed 'monsters nearby'; report honestly instead.
    if (hostileNear(9)) { log(bot, 'goBedSleep: hostiles within 9b — vanilla will refuse sleep; false (fight/shelter first).'); return false; }

    // 4) Sleep, then hold until day (bot.wake fires automatically at dawn; poll cheaply).
    try {
        await bot.sleep(bedBlock);
    } catch (e) {
        log(bot, `goBedSleep: sleep refused (${e && e.message || e}) — false.`);
        return false;
    }
    log(bot, 'goBedSleep: sleeping — skipping the night.');
    const t0 = Date.now();
    while (bot.isSleeping && Date.now() - t0 < 60000) {
        if (bot.health <= 0) return false;
        await skills.wait(bot, 1000);
    }
    return { slept: true };
}
