// Hot-reloadable REAL skill: CRAFT_EYES dispatch target — convert blaze_rod →
// blaze_powder (1 rod = 2 powder) and blaze_powder + ender_pearl → ender_eye in
// batches. Both are 2x2 recipes (no crafting table strictly needed; craftRecipe
// places/reuses one anyway if the server demands it). No cheats.
//
// Contract (kernel dispatch-cooldown discipline): returns the ender_eye COUNT only
// when THIS dispatch crafted at least one eye (delta over the entry count — real
// progress); returns false on EVERY zero-progress dispatch, even with stale eyes
// held from earlier runs. Rationale: the kernel counts failure only on res===false,
// so a stale truthy count would reset its 3-strike counter and the 5-min CRAFT_EYES
// cooldown could never engage — while isGoalDone's craftable===0 release provably
// can't fire either (craftable is a pure inventory formula; rods+pearls held keeps
// it >0 even when bot.craft itself fails, e.g. full inventory). 3x false → cooldown
// → the endgame chain proceeds instead of hot-spinning the 2s dispatch loop.
// NO-PROGRESS guard: if a craft pass adds no eyes, stop — don't spin the guard out.
// Invoked via: {"skill":"craftEyes","args":[{"eyeTarget":14}]}
// ctx = { skills, world, mc, Vec3, log }
export default async function craftEyes(bot, ctx, opts = {}) {
    const { skills, world, log } = ctx;
    const target = (opts && opts.eyeTarget) || 14;
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    // Entry snapshot: progress is measured as delta over THIS dispatch, never as the
    // absolute (possibly stale) held count — see the return-contract comment above.
    const eyesAtEntry = has('ender_eye');

    let guard = 0;
    while (has('ender_eye') < target && guard++ < 20) {
        if (bot.interrupt_code || bot.health <= 0) break;
        const eyesShort = target - has('ender_eye');
        // powder needed for the eyes we can actually pair with pearls, minus stock.
        const powderShort = Math.max(0, Math.min(eyesShort, has('ender_pearl')) - has('blaze_powder'));
        if (powderShort > 0 && has('blaze_rod') > 0) {
            // craftRecipe count = recipe executions; each rod → 2 powder.
            const times = Math.min(has('blaze_rod'), Math.ceil(powderShort / 2));
            await skills.craftRecipe(bot, 'blaze_powder', times).catch(e => log(bot, `craftEyes powder err: ${e.message}`));
        }
        const n = Math.min(has('ender_pearl'), has('blaze_powder'), eyesShort);
        if (n < 1) break;                                            // nothing left to convert
        const before = has('ender_eye');
        await skills.craftRecipe(bot, 'ender_eye', n).catch(e => log(bot, `craftEyes eye err: ${e.message}`));
        if (has('ender_eye') <= before) break;                       // NO-PROGRESS: craft failed → stop, don't spin
    }

    const eyesNow = has('ender_eye');
    const delta = eyesNow - eyesAtEntry;
    log(bot, `craftEyes: eyes=${eyesNow}/${target} (+${Math.max(0, delta)} this dispatch) `
        + `pearls=${has('ender_pearl')} powder=${has('blaze_powder')} rods=${has('blaze_rod')}`
        + (delta > 0 ? '' : ' — NO progress this dispatch → false (kernel 3-strike cooldown).'));
    return delta > 0 ? eyesNow : false;
}
