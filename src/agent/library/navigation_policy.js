const UNDERGROUND_WATER_Y = 55;
const UNDERGROUND_MINING_SKILLS = new Set([
    'mineOres',
    'mineDiamonds',
    'branchMine',
    'mineDown',
]);

function blockNameAt(bot, position) {
    try { return (bot.blockAt(position) || {}).name || ''; }
    catch (e) { return ''; }
}

/**
 * Underground ore routines must not use an existing aquifer as an ordinary
 * route. Surface travel and dedicated escape/surface-up routines deliberately
 * stay outside this policy so they can still cross or leave water.
 */
export function shouldAvoidUndergroundWater(bot) {
    const y = bot && bot.entity && bot.entity.position && bot.entity.position.y;
    return Number.isFinite(y)
        && y < UNDERGROUND_WATER_Y
        && UNDERGROUND_MINING_SKILLS.has(bot._currentSkill || '');
}

/** Add water to pathfinder's hard avoid set while retaining liquid metadata. */
export function applyUndergroundWaterAvoidance(movements, bot, getBlockId) {
    if (!movements || !shouldAvoidUndergroundWater(bot)) return false;
    if (!(movements.blocksToAvoid instanceof Set))
        movements.blocksToAvoid = new Set(movements.blocksToAvoid || []);
    if (!(movements.blocksCantBreak instanceof Set))
        movements.blocksCantBreak = new Set(movements.blocksCantBreak || []);

    let added = false;
    for (const name of ['water', 'flowing_water']) {
        let id = null;
        try { id = getBlockId(name); } catch (e) { /* unknown block in this protocol */ }
        if (id != null) {
            movements.blocksToAvoid.add(id);
            // A blocksToAvoid entry is still offered to destructive movement
            // as a break target. Water is not meaningfully diggable, so make
            // it unbreakable as well to turn the policy into a true veto.
            movements.blocksCantBreak.add(id);
            added = true;
        }
    }
    return added;
}

/** True when either the feet or head cell is water. */
export function isBotInWater(bot) {
    const p = bot && bot.entity && bot.entity.position;
    if (!p) return false;
    const foot = blockNameAt(bot, p);
    const head = blockNameAt(bot, p.offset(0, 1, 0));
    return /^(?:flowing_)?water$/.test(foot) || /^(?:flowing_)?water$/.test(head);
}

/**
 * Stateful entry guard. If navigation begins in water, recovery swimming is
 * allowed only until the bot first reaches dry ground; from that point onward
 * the same navigation call treats any water contact as a new unsafe entry.
 */
export function createUndergroundWaterGuard(bot) {
    const enabled = shouldAvoidUndergroundWater(bot);
    let armed = enabled && !isBotInWater(bot);
    const startedInWater = enabled && !armed;
    return {
        enabled,
        startedInWater,
        get armed() { return armed; },
        observe() {
            if (!enabled) return 'disabled';
            const inWater = isBotInWater(bot);
            if (!armed) {
                if (inWater) return 'initial-water';
                armed = true;
                return 'armed';
            }
            return inWater ? 'entered' : 'dry';
        },
    };
}
