// forage — acquire food when starving. The structural gap behind the food deadlock: the bot
// keeps freezing in low-food "conserve body" holds that have no exit, because nothing ever
// goes and GETS food. This is the action the Arbiter's FORAGE/EAT modes need.
//
// Strategy (bounded): while hungry —
//   1. if we already hold edible, EAT it (cheapest win);
//   2. else find the nearest huntable animal, travel to it, kill it, pick up drops, loop.
// Eats raw if that's all there is (raw salmon/cod still beat starving). Drowning is handled by
// the existing tick-level swim instinct; we additionally bail a hunt if oxygen runs low.
//
// opts: { targetFood=14, maxRounds=8 }

const HUNT = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat', 'salmon', 'cod', 'tropical_fish'];
const EDIBLE_RE = /(^|_)(bread|apple|carrot|potato|beetroot|melon_slice|cookie|sweet_berries|glow_berries|dried_kelp|cooked_\w+|beef|porkchop|chicken|mutton|rabbit|cod|salmon)$/;
const NON_EDIBLE_RE = /(raw_copper|raw_iron|raw_gold|spider_eye|poisonous|pufferfish|rotten_flesh|kelp$)/;

function findEdible(bot) {
    for (const it of bot.inventory.items()) {
        if (NON_EDIBLE_RE.test(it.name)) continue;
        if (EDIBLE_RE.test(it.name)) return it.name;
    }
    return null;
}

function nearestHuntable(bot) {
    const p = bot.entity.position;
    let best = null, bestD = Infinity;
    for (const e of Object.values(bot.entities || {})) {
        if (!e || e === bot.entity || !e.position) continue;
        if (!HUNT.includes((e.name || '').toLowerCase())) continue;
        const d = e.position.distanceTo(p);
        if (d < bestD) { bestD = d; best = e; }
    }
    return best;
}

export default async function forage(bot, ctx, opts = {}) {
    const { log, skills } = ctx;
    const targetFood = opts.targetFood || 14;
    const maxRounds = opts.maxRounds || 8;
    const log_ = (m) => log(bot, `[forage] ${m}`);
    log_(`START food=${bot.food} hp=${Math.round(bot.health || 0)} target=${targetFood}`);

    let ate = 0, killed = 0;
    for (let round = 0; round < maxRounds; round++) {
        if (bot.food >= targetFood) { log_(`food=${bot.food} >= target — done`); break; }

        // 1) Eat what we already have first.
        const edible = findEdible(bot);
        if (edible) {
            log_(`eating ${edible} (food=${bot.food})`);
            try { await skills.consume(bot, edible); ate++; } catch (e) { log_(`consume ${edible} failed: ${e && e.message || e}`); }
            continue;
        }

        // 2) Hunt the nearest animal.
        const animal = nearestHuntable(bot);
        if (!animal) { log_(`no huntable animal in load range (round ${round}) — caller should travel/explore`); break; }
        const ap = animal.position;
        log_(`round ${round}: hunt ${animal.name} at ${Math.round(ap.x)},${Math.round(ap.y)},${Math.round(ap.z)} d=${ap.distanceTo(bot.entity.position).toFixed(1)} food=${bot.food}`);

        // Travel to within attack reach. Bail if we start drowning (oxygen low) en route.
        try { await skills.goToPosition(bot, Math.round(ap.x), Math.round(ap.y), Math.round(ap.z), 2); } catch (e) { log_(`travel failed: ${e && e.message || e}`); }
        if (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel <= 4) { log_(`oxygen low (${bot.oxygenLevel}) — abort hunt, retreat`); break; }

        // Re-acquire (it may have moved) and attack to kill.
        const target = nearestHuntable(bot);
        if (target && target.position.distanceTo(bot.entity.position) <= 6) {
            try { await skills.attackEntity(bot, target, true); killed++; } catch (e) { log_(`attack failed: ${e && e.message || e}`); }
            try { await skills.pickupNearbyItems(bot); } catch (e) {}
        } else {
            log_(`could not close on ${animal.name} (still d=${target ? target.position.distanceTo(bot.entity.position).toFixed(1) : '?'})`);
        }
    }

    // Final eat pass in case the last kill dropped food after the loop's eat check.
    const last = findEdible(bot);
    if (last && bot.food < targetFood) { try { await skills.consume(bot, last); ate++; } catch (e) {} }

    const r = { food: bot.food, hp: Math.round(bot.health || 0), ate, killed };
    log_(`DONE ${JSON.stringify(r)}`);
    return r;
}
