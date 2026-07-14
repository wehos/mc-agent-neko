// digReset — DELIBERATE death-reset for an unrecoverable dead-end.
//
// When the bot is hard-stuck at very low hp in a food desert (no food to regen, too fragile to
// act, sealed so it won't even die to reset), the only no-cheat escape is to let it die and
// respawn at full hp/food. This digs straight down: breakBlockAt removes the block under the
// feet, gravity drops the bot, repeat. At low hp a multi-block drop into the near-universal
// underground caverns (or simply being among deep mobs) is fatal — reliably, without relying on
// the flaky walk. On respawn the bot is healthy and forageExplore can finally run.
//
// SAFETY VALVE: refuses to run unless hp is genuinely low (<=6) — never dig-kill a healthy bot.
// Stops early if hp recovers (shouldn't) or after maxDepth.

export default async function digReset(bot, ctx, opts = {}) {
    const { log, skills, Vec3 } = ctx;
    const log_ = (m) => log(bot, `[digReset] ${m}`);
    const maxDepth = opts.maxDepth || 30;

    if (bot.health > 6) { log_(`refuse: hp=${Math.round(bot.health)} > 6 — digReset is only for an unrecoverable low-hp dead-end`); return { ran: false, reason: 'hp too high' }; }
    const startY = Math.round(bot.entity.position.y);
    log_(`START hp=${Math.round(bot.health)} food=${bot.food} y=${startY} — controlled death-reset (food-desert dead-end)`);

    for (let i = 0; i < maxDepth; i++) {
        if (!bot.entity) break;                       // died (entity gone) — done
        const p = bot.entity.position;
        const fx = Math.round(p.x), fy = Math.round(p.y), fz = Math.round(p.z);
        try {
            const below = bot.blockAt(new Vec3(fx, fy - 1, fz));
            if (below && /lava/.test(below.name)) { log_(`lava below at depth ${i} — letting it take the bot`); }
            await skills.breakBlockAt(bot, fx, fy - 1, fz);   // dig the block under feet; bot falls in
        } catch (e) { log_(`dig threw at depth ${i}: ${e && e.message || e}`); }
        await new Promise(r => setTimeout(r, 400));           // let gravity + fall resolve
        if (Math.round(bot.health) <= 0) { log_(`bot died at depth ${i}`); break; }
        if (i % 5 === 0) log_(`depth ${i} y=${Math.round(bot.entity.position.y)} hp=${Math.round(bot.health)}`);
    }
    const r = { ran: true, endY: bot.entity ? Math.round(bot.entity.position.y) : null, hp: bot.entity ? Math.round(bot.health) : 0 };
    log_(`DONE ${JSON.stringify(r)} — expect respawn to full hp/food shortly`);
    return r;
}
