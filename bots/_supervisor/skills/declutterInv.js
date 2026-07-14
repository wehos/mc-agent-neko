// declutterInv — one-shot, NON-cheat inventory relief (origin: T-0055 wood deadlock, 2026-06-21;
// rebuilt 2026-07-14 as the first smartDiscard consumer). Root then as now: a FULL bag means
// chopped logs / pickups have no slot to land in → totals stay 0 → bootstrap deadlocks (T-0012).
// ★2026-07-14 rewrite (用户: "扔脚底原地再捡起来"):
//   • /clear is DEAD in this world (LAN 无作弊 — the chat command silently no-ops), so the old
//     body did nothing. Raw toss is equally futile: the server auto-re-inserts any drop inside
//     the pickup sphere once the 2s thrower delay expires (that was WHY this skill used /clear).
//   • skills.smartDiscard solves it geometrically: finds/digs a 1-2 deep pit in the 8 neighbour
//     columns, aims the toss INTO it, tags every spawn (item_collecting won't chase), steps back
//     inside the 2s grace, then recounts and honestly reports.
//   • Dropped the sticky→missionNether restore: missionNether is DEPRECATED (kernelDriver is the
//     live top dispatcher) — restoring it would derail the kernel on every declutter run.
// keep a useful buffer of each; discard only the excess. Cosmetic/■-only stacks → discard fully.
const CAPS = {
    cobblestone: 64, cobbled_deepslate: 64, coal: 64, dirt: 16, sandstone: 0, red_sandstone: 0,
    sand: 0, red_sand: 0, gravel: 0, granite: 0, andesite: 0, diorite: 0, tuff: 0, raw_copper: 0,
    terracotta: 0, white_terracotta: 0, orange_terracotta: 0, yellow_terracotta: 0, red_terracotta: 0,
    brown_terracotta: 0, light_gray_terracotta: 0, gray_terracotta: 0, sugar_cane: 0, wheat_seeds: 0,
    flint: 0, feather: 0, rabbit_hide: 0, armadillo_scute: 0, smooth_sandstone: 0, ink_sac: 0, clay_ball: 0,
};

export default async function declutterInv(bot, ctx) {
    const { skills, log } = ctx;
    try { bot.interrupt_code = false; } catch (e) {}

    const freeSlot = () => { try { return bot.inventory.emptySlotCount(); } catch (e) { return 0; } };
    const haveOf = (n) => { try { return bot.inventory.items().reduce((s, i) => s + (i.name === n ? i.count : 0), 0); } catch (e) { return 0; } };
    const before = freeSlot();

    const plan = [];
    for (const [name, cap] of Object.entries(CAPS)) {
        const surplus = haveOf(name) - cap;
        if (surplus > 0) plan.push({ name, num: surplus });
    }
    if (!plan.length) {
        log(bot, `declutterInv: nothing over cap — free slots ${before}, no discard needed.`);
        return true;
    }
    if (typeof skills.smartDiscard !== 'function') {
        log(bot, `declutterInv: skills.smartDiscard unavailable (pre-restart skills.js?) — cannot pit-discard, doing nothing (raw toss would just be re-collected).`);
        return false;
    }
    const pre = plan.reduce((s, p) => s + haveOf(p.name), 0);
    let ok = false;
    try { ok = await skills.smartDiscard(bot, plan); }
    catch (e) { log(bot, `declutterInv: smartDiscard err ${e && e.message || e}`); }
    const gone = pre - plan.reduce((s, p) => s + haveOf(p.name), 0);
    log(bot, `declutterInv: done — free slots ${before}→${freeSlot()} (pit-discarded ${gone} surplus, verified=${ok}). Pickups have somewhere to land now.`);
    return ok || gone > 0;
}
