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

// PURE travel-budget gate — the fix for the C210 death: never march the last food away to a
// target you can't safely reach. Returns {go, reason}. Conservative: each ~12 blocks of travel
// (round trip + combat overhead) costs ~1 food; water targets (descent/swim) cost double and
// risk drowning, so they need a fatter buffer and a higher floor.
function forageBudget(food, dist, inWater) {
    const FLOOR = inWater ? 8 : 5;                 // below this, traveling is too risky — shelter instead
    if (food < FLOOR) return { go: false, reason: `food=${food} < floor ${FLOOR}${inWater ? ' (water target)' : ''} — too low to travel, shelter/wait` };
    const cost = Math.ceil(dist / 12) * (inWater ? 2 : 1) + 2; // est. food spent reaching+fighting
    if (food - cost < 2) return { go: false, reason: `food=${food} can't afford est. cost ${cost} for d=${dist}${inWater ? ' water' : ''} (would dip below 2)` };
    return { go: true, reason: `food=${food} affords d=${dist} (est cost ${cost})` };
}

const HUNT = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat', 'salmon', 'cod', 'tropical_fish'];
const LAND_HUNT = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat'];
const EDIBLE_RE = /(^|_)(bread|apple|carrot|potato|beetroot|melon_slice|cookie|sweet_berries|glow_berries|dried_kelp|cooked_\w+|beef|porkchop|chicken|mutton|rabbit|cod|salmon)$/;
const NON_EDIBLE_RE = /(raw_copper|raw_iron|raw_gold|spider_eye|poisonous|pufferfish|rotten_flesh|kelp$)/;

function findEdible(bot) {
    for (const it of bot.inventory.items()) {
        if (NON_EDIBLE_RE.test(it.name)) continue;
        if (EDIBLE_RE.test(it.name)) return it.name;
    }
    return null;
}

// Nearest huntable, preferring LAND animals (no drowning risk) over water fish even if the
// fish is somewhat closer — the C210 death was a swim into deep water for distant salmon.
function nearestHuntable(bot) {
    const p = bot.entity.position;
    let land = null, landD = Infinity, water = null, waterD = Infinity;
    for (const e of Object.values(bot.entities || {})) {
        if (!e || e === bot.entity || !e.position) continue;
        const nm = (e.name || '').toLowerCase();
        if (!HUNT.includes(nm)) continue;
        const d = e.position.distanceTo(p);
        if (LAND_HUNT.includes(nm)) { if (d < landD) { landD = d; land = e; } }
        else { if (d < waterD) { waterD = d; water = e; } }
    }
    if (land && landD <= waterD + 24) return { entity: land, dist: landD, isWater: false };
    if (water) return { entity: water, dist: waterD, isWater: true };
    if (land) return { entity: land, dist: landD, isWater: false };
    return null;
}

export default async function forage(bot, ctx, opts = {}) {
    const { log, skills } = ctx;
    const targetFood = opts.targetFood || 14;
    const maxRounds = opts.maxRounds || 8;
    const log_ = (m) => log(bot, `[forage] ${m}`);
    log_(`START food=${bot.food} hp=${Math.round(bot.health || 0)} target=${targetFood}`);

    let ate = 0, killed = 0, abortedBudget = false;
    for (let round = 0; round < maxRounds; round++) {
        if (bot.food >= targetFood) { log_(`food=${bot.food} >= target — done`); break; }

        // 1) Eat what we already have first.
        const edible = findEdible(bot);
        if (edible) {
            log_(`eating ${edible} (food=${bot.food})`);
            try { await skills.consume(bot, edible); ate++; } catch (e) { log_(`consume ${edible} failed: ${e && e.message || e}`); }
            continue;
        }

        // 2) Hunt the nearest animal — but only if the food budget can afford the trip.
        const pick = nearestHuntable(bot);
        if (!pick) { log_(`no huntable animal in load range (round ${round}) — caller should travel/explore`); break; }
        const animal = pick.entity, ap = animal.position;
        const budget = forageBudget(bot.food, pick.dist, pick.isWater);
        if (!budget.go) { log_(`SKIP hunt ${animal.name} d=${pick.dist.toFixed(1)}${pick.isWater ? ' (water)' : ''}: ${budget.reason}`); abortedBudget = true; break; }
        log_(`round ${round}: hunt ${animal.name} at ${Math.round(ap.x)},${Math.round(ap.y)},${Math.round(ap.z)} d=${pick.dist.toFixed(1)}${pick.isWater ? ' (water)' : ''} food=${bot.food} — ${budget.reason}`);

        // No sprinting while low on food — sprinting drains hunger ~4x and was a factor in C210.
        try { bot.setControlState('sprint', false); if (bot.physics) bot.physics.sprint = false; } catch (e) {}

        // Travel to within attack reach. Bail if we start drowning (oxygen low) en route.
        try { await skills.goToPosition(bot, Math.round(ap.x), Math.round(ap.y), Math.round(ap.z), 2); } catch (e) { log_(`travel failed: ${e && e.message || e}`); }
        if (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel <= 6) { log_(`oxygen low (${bot.oxygenLevel}) — abort hunt, retreat`); break; }

        // Re-acquire (it may have moved) and attack to kill.
        const target = nearestHuntable(bot);
        if (target && target.entity.position.distanceTo(bot.entity.position) <= 6) {
            try { await skills.attackEntity(bot, target.entity, true); killed++; } catch (e) { log_(`attack failed: ${e && e.message || e}`); }
            try { await skills.pickupNearbyItems(bot); } catch (e) {}
        } else {
            log_(`could not close on ${animal.name} (still d=${target ? target.dist.toFixed(1) : '?'})`);
        }
    }

    // Final eat pass in case the last kill dropped food after the loop's eat check.
    const last = findEdible(bot);
    if (last && bot.food < targetFood) { try { await skills.consume(bot, last); ate++; } catch (e) {} }

    const r = { food: bot.food, hp: Math.round(bot.health || 0), ate, killed, abortedBudget, recommend: abortedBudget ? 'shelter (food too low to travel — do NOT march)' : null };
    log_(`DONE ${JSON.stringify(r)}`);
    return r;
}

export { forageBudget, nearestHuntable, findEdible };
