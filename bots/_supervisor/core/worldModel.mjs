// worldModel — the single source of truth (HANDOFF.md §4, the refactor's blackboard).
//
// WHY
// The patch-route disease: every layer (mission KILL-BOX, prepNether, core pin-breaker,
// watchdog) re-derived "the situation" from raw bot fields its own way, so they disagreed
// about whether to hold or move and fought over the body. There was no ONE agreed snapshot.
//
// buildWorldModel() collapses all perception (vitals + advisory + radar + mobility + a tiny
// bit of history) into ONE plain, immutable-ish object that every decision reads. It is a
// PURE function of its inputs — no bot, no fs, no clock side effects — so the exact snapshot
// the Arbiter saw can be replayed offline from decision_trace.jsonl for regression tests.

const LOW_FOOD = 6;          // at/below this, hunger gating starts to matter
const NIGHT_START = 13000, NIGHT_END = 23000;
const FRESH_ADVISORY_MS = 45000;

// Conservative edible-name matcher for the pure path (the live shadow runner may instead
// pass hasEdible computed from mc.getItemFood). Covers the foods this bot actually handles.
const EDIBLE_RE = /(^|_)(bread|apple|carrot|potato|beetroot|melon_slice|cookie|pumpkin_pie|sweet_berries|glow_berries|dried_kelp|cooked_\w+|beef|porkchop|chicken|mutton|rabbit|cod|salmon|mushroom_stew|rabbit_stew|beetroot_soup|honey_bottle)$/;
const NON_EDIBLE_RE = /(raw_copper|raw_iron|raw_gold|spider_eye|poisonous_potato|pufferfish|rotten_flesh)/;

function invHasEdible(inv) {
    if (!inv) return false;
    for (const name of Object.keys(inv)) {
        if ((inv[name] || 0) <= 0) continue;
        if (NON_EDIBLE_RE.test(name)) continue;
        if (EDIBLE_RE.test(name)) return true;
    }
    return false;
}

function isNight(tod) {
    return typeof tod === 'number' && tod > NIGHT_START && tod < NIGHT_END;
}

/**
 * Build the unified world snapshot.
 * PURE: depends only on `t`. No I/O.
 *
 * @param {object} t
 *   vitals:   {x,y,z,hp,food,tod,mob,held,inv}                 (bots/_supervisor/vitals.json shape)
 *   advisory: {risk,directive,hostiles,actionableHostiles,layeredHostiles,nearest,
 *              actionableNearest,dzone,ts}                       (advisory.json shape) — may be null
 *   radar:    {pos,mobs:[{name,d,x,y,z}]}                        (radar.json shape) — may be null
 *   now:      number (ms epoch)                                 (caller-supplied; keeps this pure)
 *   stalledMs:number                                            (how long the body has not progressed)
 *   hasEdible:bool|undefined                                    (override; else derived from inv)
 * @returns {object} worldModel
 */
export function buildWorldModel(t) {
    const v = (t && t.vitals) || {};
    const adv = (t && t.advisory) || null;
    const radar = (t && t.radar) || null;
    const now = (t && typeof t.now === 'number') ? t.now : 0;

    const pos = { x: v.x | 0, y: v.y | 0, z: v.z | 0 };
    const food = (v.food == null) ? 20 : v.food;
    const hp = (v.hp == null) ? 20 : v.hp;
    const tod = (v.tod == null) ? null : v.tod;

    // Mobility: vitals.mob is "STATE/FLAGS" e.g. "FREE/ENC". Split it.
    let mobState = null, enclosed = false;
    if (typeof v.mob === 'string') {
        const parts = v.mob.split('/');
        mobState = parts[0] || null;
        enclosed = /ENC/.test(v.mob);
    }

    const hasEdible = (t && typeof t.hasEdible === 'boolean') ? t.hasEdible : invHasEdible(v.inv);
    const hasPickaxe = !!(v.inv && Object.keys(v.inv).some(n => /pickaxe/.test(n) && v.inv[n] > 0))
        || /pickaxe/.test(v.held || '');

    // Defense posture — the #1 death cause is fighting unarmored (zombies). Count armor pieces
    // and good weapons so the Arbiter can refuse melee when it has no protection.
    const armorRe = /(helmet|chestplate|leggings|boots)$/;
    const armorItems = v.inv ? Object.keys(v.inv).filter(n => armorRe.test(n) && v.inv[n] > 0).length : 0;
    const hasShield = !!(v.inv && v.inv.shield > 0) || /shield/.test(v.held || '');
    const hasGoodWeapon = !!(v.inv && Object.keys(v.inv).some(n => /(iron|diamond|netherite)_sword/.test(n) && v.inv[n] > 0)) || /(iron|diamond|netherite)_sword/.test(v.held || '');
    const weakDefense = armorItems === 0 && !hasShield;   // naked: no armor, no shield

    // Threat model: prefer fresh advisory (it already classifies actionable vs layered/far);
    // fall back to raw radar distances when advisory is missing/stale.
    const advFresh = adv && typeof adv.ts === 'number' && now && (now - adv.ts) <= FRESH_ADVISORY_MS;
    let hostiles = [];
    if (adv && Array.isArray(adv.mobs)) hostiles = adv.mobs;
    else if (radar && Array.isArray(radar.mobs)) hostiles = radar.mobs;

    const actionableHostiles = advFresh && adv.actionableHostiles != null
        ? adv.actionableHostiles
        : hostiles.filter(h => h && h.actionable === true).length;
    const actionableNearest = advFresh ? (adv.actionableNearest ?? null)
        : (hostiles.filter(h => h && h.actionable).map(h => h.d).sort((a, b) => a - b)[0] ?? null);
    const nearest = (adv && adv.nearest != null) ? adv.nearest
        : (hostiles.map(h => h && h.d).filter(x => x != null).sort((a, b) => a - b)[0] ?? null);

    const dzone = (adv && adv.dzone) || null;
    const insideDeathZone = !!(dzone && Math.hypot(pos.x - dzone.cx, pos.z - dzone.cz) <= (dzone.r || 0));

    const stalledMs = (t && typeof t.stalledMs === 'number') ? t.stalledMs : 0;

    return {
        ts: now,
        pos, hp, food, tod, isNight: isNight(tod),
        hasEdible, hasPickaxe,
        held: v.held || null,
        defense: { armorItems, hasShield, hasGoodWeapon, weakDefense },
        mobility: { state: mobState, enclosed },
        threat: {
            count: hostiles.length,
            actionableCount: actionableHostiles,
            actionableNearest,
            nearest,
            actionableClose: actionableNearest != null && actionableNearest <= 8,
            overwhelmed: actionableHostiles >= 3 && actionableNearest != null && actionableNearest <= 10,
            advFresh: !!advFresh,
        },
        hostiles,
        dzone, insideDeathZone,
        directive: adv ? adv.directive : null,
        risk: adv ? adv.risk : null,
        progress: { stalledMs },
        // Derived paralysis signal — the thing the patch layers never named: a bot that is
        // low on food with nothing to eat, or has been unable to make progress for a long
        // time, is NOT "safely holding" — it is stuck. ESCAPE keys off this.
        paralysis: {
            starving: food <= LOW_FOOD && !hasEdible,
            longStall: stalledMs >= 8 * 60 * 1000,           // 8min+ with no progress
            trappedInDeathZone: insideDeathZone && stalledMs >= 4 * 60 * 1000,
        },
        constants: { LOW_FOOD, FRESH_ADVISORY_MS },
    };
}

export const _internal = { invHasEdible, isNight, LOW_FOOD };
