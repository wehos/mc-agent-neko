import Vec3 from 'vec3';

const WATER_RE = /(?:^|_)water$/;
const LAVA_RE = /(?:^|_)lava$/;
const MINING_TASK_RE = /^(?:mineOres|mineDiamonds|mineDown|branchMine|tunnelToOre|prepNether|missionNether|gatherObsidian)/i;
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
const BREATH_HOLE_BLOCK_DENY_RE = /(?:_bed$|chest|barrel|furnace|smoker|crafting_table|spawner|portal|bedrock|barrier|command_block|end_gateway|end_portal|structure_block|jigsaw)/;
const FALLING_BLOCK_RE = /^(?:sand|red_sand|gravel|anvil|chipped_anvil|damaged_anvil)$|_concrete_powder$/;
const FACE_NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export const DEFAULT_LIQUID_COST = 12;
// A typical dry tunnel step is about 8 (move 1 + stone labor ~7). Adding 24
// makes the equivalent wet excavation about 32, so water is roughly 4x the
// real underground baseline instead of being compared with an empty air step.
export const DESTRUCTIVE_LIQUID_COST = 24;
export const UNDERWATER_DIG_MULTIPLIER = 5;
export const UNDERWATER_MINING_BLOCKED_COST = 100;
export const UNDERWATER_BREATH_THRESHOLD = 16;
export const UNDERWATER_OXYGEN_RESERVE = 5;
export const MAX_OXYGEN_LEVEL = 20;
// Route-level policy: a serviced breathing point at least every five A* path
// blocks, and the final point within two blocks of an underwater mining target.
// The trigger is deliberately early enough that a 500ms control tick cannot skip it.
export const MAX_BREATH_STATION_PATH_GAP = 5;
export const MAX_BREATH_TO_MINING_TARGET = 2;
export const PLANNED_BREATH_TRIGGER_RADIUS = 2.25;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const floorPos = (p) => p && typeof p.floored === 'function'
    ? p.floored()
    : p && typeof p.offset === 'function'
        ? p.offset(0, 0, 0)
        : p;

export function isWaterBlock(block) {
    return !!block && WATER_RE.test(block.name || '');
}

function isAirBlock(block) {
    return !!block && AIR_NAMES.has(block.name || '');
}

function isLavaBlock(block) {
    return !!block && LAVA_RE.test(block.name || '');
}

export function isBotInWater(bot) {
    try {
        if (bot && bot.entity && bot.entity.isInWater) return true;
        const p = bot.entity.position;
        return isWaterBlock(bot.blockAt(p)) || isWaterBlock(bot.blockAt(p.offset(0, 1, 0)));
    } catch (e) {
        return false;
    }
}

export function isBotEyesInWater(bot) {
    try {
        const p = bot.entity.position;
        const eyeHeight = Number.isFinite(bot.entity.eyeHeight) ? bot.entity.eyeHeight : 1.62;
        const eyeBlock = bot.blockAt(p.offset(0, eyeHeight, 0));
        if (eyeBlock) return isWaterBlock(eyeBlock);
        return !!bot.entity.isInWater;
    } catch (e) {
        return !!(bot && bot.entity && bot.entity.isInWater);
    }
}

function hasAquaAffinity(bot) {
    try {
        const slot = bot.getEquipmentDestSlot('head');
        const helmet = bot.inventory && bot.inventory.slots && bot.inventory.slots[slot];
        return !!(helmet && Array.isArray(helmet.enchants)
            && helmet.enchants.some(e => /(?:^|:)aqua_affinity$/i.test((e && e.name) || '')));
    } catch (e) {
        return false;
    }
}

/**
 * Mark a generic collectBlock call as mining even when it was dispatched directly
 * (and therefore has no customSkill name). The returned closure makes nesting safe.
 */
export function beginUnderwaterMiningTask(bot) {
    if (!bot) return () => {};
    bot._underwaterMiningTaskDepth = (bot._underwaterMiningTaskDepth || 0) + 1;
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        bot._underwaterMiningTaskDepth = Math.max(0, (bot._underwaterMiningTaskDepth || 1) - 1);
    };
}

export function isUnderwaterMiningTask(bot) {
    if (!bot) return false;
    if ((bot._underwaterMiningTaskDepth || 0) > 0) return true;
    return MINING_TASK_RE.test(String(bot._currentSkill || ''));
}

/**
 * Mineflayer deliberately calls Block#digTime with inWater=false. Install one
 * idempotent correction so direct digs and pathfinder execution use server time.
 */
export function ensureWaterAwareDigTime(bot) {
    if (!bot) return false;
    // The patched pathfinder consults this immediately before it starts a dig.
    // Planning may use a future breathing point, but execution may never spend
    // oxygen that the current bar cannot actually cover.
    bot._underwaterMiningCanStartDig = (block) => !needsBreathBeforeDig(bot, block);
    if (typeof bot.digTime !== 'function' || bot._waterAwareDigTimeInstalled) return false;
    const originalDigTime = bot.digTime;
    bot._waterAwareOriginalDigTime = originalDigTime;
    bot.digTime = function waterAwareDigTime(block) {
        const base = originalDigTime.call(bot, block);
        if (!Number.isFinite(base) || base <= 0) return base;
        if (!isBotEyesInWater(bot) || hasAquaAffinity(bot)) return base;
        return base * UNDERWATER_DIG_MULTIPLIER;
    };
    bot._waterAwareDigTimeInstalled = true;
    return true;
}

/** Estimate the full server-side time of a dig performed with the miner submerged. */
export function estimateUnderwaterDigMs(bot, block) {
    try {
        if (!bot || !block) return Infinity;
        // Plan for the safe posture this module enforces: feet planted, eyes wet.
        // Calling bot.digTime directly while the live entity is still swimming would
        // include the separate airborne 5x penalty and create a planning deadlock
        // (A* rejects the block before execution gets a chance to settle).
        if (typeof block.digTime === 'function') {
            let tool = bot.heldItem;
            try {
                const best = bot.pathfinder && bot.pathfinder.bestHarvestTool && bot.pathfinder.bestHarvestTool(block);
                if (best) tool = best;
            } catch (e) { /* best available tool is optional */ }
            const type = tool ? tool.type : null;
            let enchants = tool && Array.isArray(tool.enchants) ? [...tool.enchants] : [];
            try {
                const slot = bot.getEquipmentDestSlot('head');
                const helmet = bot.inventory && bot.inventory.slots && bot.inventory.slots[slot];
                if (helmet && Array.isArray(helmet.enchants)) enchants = enchants.concat(helmet.enchants);
            } catch (e) { /* helmet metadata is optional */ }
            const creative = !!(bot.game && bot.game.gameMode === 'creative');
            const base = block.digTime(type, creative, false, false, enchants, bot.entity && bot.entity.effects);
            if (!Number.isFinite(base) || base < 0) return Infinity;
            return hasAquaAffinity(bot) ? base : base * UNDERWATER_DIG_MULTIPLIER;
        }
        const original = bot._waterAwareOriginalDigTime || bot.digTime;
        if (typeof original !== 'function') return Infinity;
        const base = original.call(bot, block);
        if (!Number.isFinite(base) || base < 0) return Infinity;
        return hasAquaAffinity(bot) ? base : base * UNDERWATER_DIG_MULTIPLIER;
    } catch (e) {
        return Infinity;
    }
}

export function underwaterDigBreathBudget(bot, block) {
    const expectedMs = estimateUnderwaterDigMs(bot, block);
    const requiredOxygen = Number.isFinite(expectedMs)
        ? Math.ceil(expectedMs / 1000) + UNDERWATER_OXYGEN_RESERVE
        : Infinity;
    return {
        expectedMs,
        requiredOxygen,
        possible: requiredOxygen <= MAX_OXYGEN_LEVEL,
        availableOxygen: Number.isFinite(bot && bot.oxygenLevel) ? bot.oxygenLevel : null,
    };
}

function hasAdjacentLava(bot, pos) {
    try {
        return FACE_NEIGHBOURS.some(([dx, dy, dz]) => isLavaBlock(bot.blockAt(pos.offset(dx, dy, dz))));
    } catch (e) {
        return true;
    }
}

function hasHorizontalWater(bot, pos) {
    try {
        return [[1, 0], [-1, 0], [0, 1], [0, -1]]
            .some(([dx, dz]) => isWaterBlock(bot.blockAt(pos.offset(dx, 0, dz))));
    } catch (e) {
        return true;
    }
}

function hasSolidFloor(bot, pos) {
    try {
        const floor = bot.blockAt(floorPos(pos).offset(0, -1, 0));
        return !!floor && floor.boundingBox === 'block';
    } catch (e) {
        return false;
    }
}

function safeBreathHoleBlock(bot, block) {
    try {
        if (!block || !block.position || block.boundingBox !== 'block' || block.diggable === false) return false;
        const name = block.name || '';
        if (BREATH_HOLE_BLOCK_DENY_RE.test(name) || FALLING_BLOCK_RE.test(name)) return false;
        // Water beside the newly opened cell would immediately flood the pocket.
        if (hasAdjacentLava(bot, block.position) || hasHorizontalWater(bot, block.position)) return false;
        const budget = underwaterDigBreathBudget(bot, block);
        // Two seconds are reserved for rising into the newly opened pocket. A hole
        // that consumes the entire bar is not a breathing solution.
        return budget.possible && budget.requiredOxygen + 2 <= MAX_OXYGEN_LEVEL;
    } catch (e) {
        return false;
    }
}

/**
 * Inspect one water column as a breathing station. A station is usable when the
 * miner can swim directly to air, or when exactly one safe ceiling block with air
 * above it can be removed within a full oxygen bar. Sealed multi-block ceilings are
 * deliberately rejected: they make execution risk unbounded.
 */
export function inspectBreathColumn(bot, feetPos, maxWaterRise = 3) {
    try {
        const feet = floorPos(feetPos);
        if (!feet || !isWaterBlock(bot.blockAt(feet))) return null;
        for (let dy = 1; dy <= maxWaterRise + 1; dy++) {
            const pos = feet.offset(0, dy, 0);
            const current = bot.blockAt(pos);
            if (isWaterBlock(current)) continue;
            if (isAirBlock(current)) {
                return { ok: true, kind: 'open-air', feet, airPos: pos, ventBlock: null, waterRise: dy - 1 };
            }
            const above = bot.blockAt(pos.offset(0, 1, 0));
            if (hasSolidFloor(bot, feet)
                && safeBreathHoleBlock(bot, current) && isAirBlock(above)) {
                const budget = underwaterDigBreathBudget(bot, current);
                return { ok: true, kind: 'one-block-hole', feet, airPos: pos, ventBlock: current, waterRise: dy - 1, budget };
            }
            return null;
        }
    } catch (e) { /* incomplete world data means no station */ }
    return null;
}

/** Find the safest station in the current cell or a face-adjacent water cell. */
export function findBreathStation(bot, originPos, radius = 1) {
    try {
        const origin = floorPos(originPos);
        if (!origin) return null;
        const candidates = [];
        for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
            const distance = Math.abs(dx) + Math.abs(dz);
            if (distance > radius) continue;
            const station = inspectBreathColumn(bot, origin.offset(dx, 0, dz));
            if (station && (station.kind !== 'one-block-hole'
                || station.budget.requiredOxygen + 2 + distance <= MAX_OXYGEN_LEVEL)) {
                candidates.push({ ...station, horizontalDistance: distance });
            }
        }
        candidates.sort((a, b) => {
            const riskA = a.kind === 'open-air' ? 0 : 1;
            const riskB = b.kind === 'open-air' ? 0 : 1;
            return riskA - riskB || a.horizontalDistance - b.horizontalDistance
                || (a.budget ? a.budget.expectedMs : 0) - (b.budget ? b.budget.expectedMs : 0);
        });
        return candidates[0] || null;
    } catch (e) {
        return null;
    }
}

/**
 * Additional A* step cost for a mining task. Normal goto keeps the ordinary finite
 * per-water-cell liquidCost. Mining water is finite only if that exact cell has a
 * nearby breathing station; otherwise 100 makes the edge infeasible.
 */
export function underwaterMiningStepCost(bot, block) {
    if (!isUnderwaterMiningTask(bot) || !isWaterBlock(block)) return 0;
    // A five-block chain means intermediate cells need coverage, not their own
    // ceiling hole. Radius three covers the midpoint between two holes five path
    // blocks apart; the post-A* planner still validates the exact ordered chain.
    const station = findBreathStation(bot, block.position, 3);
    if (!station) return UNDERWATER_MINING_BLOCKED_COST;
    if (station.kind === 'open-air') return station.horizontalDistance * 2;
    return 12 + station.horizontalDistance * 2 + Math.ceil(station.budget.expectedMs / 1000);
}

const stationId = (station) => station && station.feet
    ? `${station.feet.x},${station.feet.y},${station.feet.z}`
    : null;
const targetKey = (target) => target
    ? `${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}`
    : null;
const nodePosition = (node) => new Vec3(Math.floor(node.x), Math.floor(node.y), Math.floor(node.z));

function prefixPathDistance(nodes) {
    const prefix = [0];
    for (let i = 1; i < nodes.length; i++) {
        const a = nodes[i - 1].position;
        const b = nodes[i].position;
        prefix.push(prefix[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    return prefix;
}

function stationTargetDistance(station, target) {
    if (!station || !station.feet || !target) return Infinity;
    return Math.hypot(
        station.feet.x - Math.floor(target.x),
        station.feet.y - Math.floor(target.y),
        station.feet.z - Math.floor(target.z),
    );
}

/**
 * Convert one A* result into an explicit future breathing-hole schedule. Local
 * step checks answer whether a hole is possible; this route-level pass proves the
 * holes form a survivable chain before execution enters the water.
 */
export function planUnderwaterMiningBreathing(bot, path, miningTarget = null, {
    complete = true,
    maxStationGap = MAX_BREATH_STATION_PATH_GAP,
    maxTargetDistance = MAX_BREATH_TO_MINING_TARGET,
} = {}) {
    if (!isUnderwaterMiningTask(bot)) return { ok: true, required: false, stations: [], route: [] };
    const route = (Array.isArray(path) ? path : []).map((node, pathIndex) => {
        const position = nodePosition(node);
        return { pathIndex, position, water: isWaterBlock(bot.blockAt(position)) };
    });
    if (!route.some(node => node.water)) return { ok: true, required: false, stations: [], route };

    const stations = [];
    const ids = new Set();
    const add = (candidate, node) => {
        const id = stationId(candidate);
        if (!id || ids.has(id)) return;
        ids.add(id);
        const serviced = !!(bot._underwaterMiningServicedBreathStations
            && bot._underwaterMiningServicedBreathStations.has(id));
        stations.push({ ...candidate, id, pathIndex: node.pathIndex, serviced });
    };

    for (let start = 0; start < route.length;) {
        if (!route[start].water) { start++; continue; }
        let end = start;
        while (end + 1 < route.length && route[end + 1].water) end++;
        const segment = route.slice(start, end + 1);
        // Planned holes sit on the path itself. Cells between them may be sealed;
        // they are traversal work covered by the previous/next serviced pocket.
        const candidates = segment.map(node => inspectBreathColumn(bot, node.position));
        const prefix = prefixPathDistance(segment);
        const finalIndex = segment.length - 1;
        const endsUnderwater = complete && end === route.length - 1;
        const viable = candidates.map((candidate, index) => candidate ? index : -1).filter(index => index >= 0);
        if (viable.length === 0) {
            if (!endsUnderwater && prefix[finalIndex] <= maxStationGap) { start = end + 1; continue; }
            return {
                ok: false,
                required: true,
                reason: 'water-segment-without-plannable-breathing-hole',
                failedAt: segment[0].position,
                stations,
                route,
            };
        }

        // Reach the first available hole from the full-air entry, then greedily
        // take the furthest reachable future hole. On a one-dimensional path this
        // maximizes progress without sacrificing any later option.
        let last = viable[0];
        if (prefix[last] > maxStationGap) return {
            ok: false,
            required: true,
            reason: 'first-planned-breathing-hole-too-far',
            failedAt: segment[last].position,
            stations,
            route,
        };
        add(candidates[last], segment[last]);
        while (prefix[finalIndex] - prefix[last] > maxStationGap) {
            const reachable = viable.filter(index => index > last && prefix[index] - prefix[last] <= maxStationGap);
            if (!reachable.length) return {
                ok: false,
                required: true,
                reason: 'planned-breathing-hole-gap-too-large',
                failedAt: segment[last].position,
                stations,
                route,
            };
            last = reachable[reachable.length - 1];
            add(candidates[last], segment[last]);
        }

        if (endsUnderwater) {
            const target = miningTarget || segment[finalIndex].position;
            let finalStation = [...stations].reverse().find(station => station.pathIndex >= start);
            if (!finalStation || stationTargetDistance(finalStation, target) > maxTargetDistance) {
                const targetSafe = viable.filter(index => index >= last
                    && prefix[index] - prefix[last] <= maxStationGap
                    && stationTargetDistance(candidates[index], target) <= maxTargetDistance);
                if (targetSafe.length) {
                    last = targetSafe[targetSafe.length - 1];
                    add(candidates[last], segment[last]);
                }
                finalStation = [...stations].reverse().find(station => station.pathIndex >= start);
            }
            if (!finalStation || stationTargetDistance(finalStation, target) > maxTargetDistance) return {
                ok: false,
                required: true,
                reason: 'final-breathing-hole-too-far-from-mining-target',
                failedAt: segment[finalIndex].position,
                target,
                stations,
                route,
            };
        }
        start = end + 1;
    }

    return {
        ok: true,
        required: true,
        stations: stations.sort((a, b) => a.pathIndex - b.pathIndex),
        route,
        cursor: 0,
        projectedPathIndex: 0,
        policy: { maxStationGap, maxTargetDistance },
    };
}

/** Preserve target and opened holes across an interrupted/restarted mining call. */
export function adoptUnderwaterMiningBreathPlan(bot, plan, miningTarget = null) {
    if (!bot || !plan || !plan.ok) return plan;
    const old = bot._underwaterMiningBreathPlan;
    const key = targetKey(miningTarget);
    plan.targetKey = key;
    plan.cursor = 0;
    plan.projectedPathIndex = 0;
    plan.generation = old && old.targetKey === key ? (old.generation || 0) + 1 : 1;
    bot._underwaterMiningBreathPlan = plan;
    if (miningTarget) bot._underwaterMiningRouteTarget = {
        position: { x: Math.floor(miningTarget.x), y: Math.floor(miningTarget.y), z: Math.floor(miningTarget.z) },
        key,
        updatedAt: Date.now(),
    };
    return plan;
}

export function resolveUnderwaterMiningRouteTarget(bot, fallback = null, ttlMs = 300000) {
    const sticky = bot && bot._collectSticky && bot._collectSticky.pos;
    if (sticky) return sticky;
    const remembered = bot && bot._underwaterMiningRouteTarget;
    if (remembered && Date.now() - remembered.updatedAt <= ttlMs) {
        try {
            const p = new Vec3(remembered.position.x, remembered.position.y, remembered.position.z);
            const live = bot.blockAt(p);
            if (live && live.boundingBox === 'block') return remembered.position;
        } catch (e) { /* stale target falls through */ }
    }
    return fallback;
}

/**
 * Advance monotonically along the planned route. A missed point is never selected
 * behind the bot: the caller stops and replans from the current water cell instead.
 */
export function nextPlannedBreathStation(bot, plan, triggerRadius = PLANNED_BREATH_TRIGGER_RADIUS) {
    if (!plan || !plan.ok || !Array.isArray(plan.stations) || !isBotInWater(bot)) return null;
    const p = bot.entity.position;
    if (Array.isArray(plan.route) && plan.route.length) {
        let nearest = plan.projectedPathIndex || 0;
        let nearestDistance = Infinity;
        for (const node of plan.route) {
            const d = Math.hypot(p.x - (node.position.x + 0.5), p.y - node.position.y, p.z - (node.position.z + 0.5));
            if (d < nearestDistance) { nearestDistance = d; nearest = node.pathIndex; }
        }
        plan.projectedPathIndex = Math.max(plan.projectedPathIndex || 0, nearest);
    }
    while (plan.cursor < plan.stations.length) {
        const station = plan.stations[plan.cursor];
        const serviced = station.serviced
            || !!(bot._underwaterMiningServicedBreathStations
                && bot._underwaterMiningServicedBreathStations.has(station.id));
        if (serviced) { plan.cursor++; continue; }
        if (plan.projectedPathIndex > station.pathIndex + 1) return { ...station, missed: true };
        const center = station.feet.offset(0.5, 0, 0.5);
        if (Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z) <= triggerRadius) return station;
        return null;
    }
    return null;
}

export function markPlannedBreathStationServiced(bot, station) {
    const id = stationId(station);
    if (!bot || !id) return false;
    if (!(bot._underwaterMiningServicedBreathStations instanceof Set))
        bot._underwaterMiningServicedBreathStations = new Set();
    bot._underwaterMiningServicedBreathStations.add(id);
    station.serviced = true;
    const plan = bot._underwaterMiningBreathPlan;
    if (plan && plan.stations && plan.stations[plan.cursor] && plan.stations[plan.cursor].id === id) plan.cursor++;
    return true;
}

function plannedBreathingCoverage(bot, plan, maxGap = MAX_BREATH_STATION_PATH_GAP) {
    if (!plan || !plan.ok || !Array.isArray(plan.route) || !plan.route.length
        || !Array.isArray(plan.stations) || !plan.stations.length) return null;
    const p = bot.entity.position;
    let currentOffset = 0;
    let nearestDistance = Infinity;
    for (let i = 0; i < plan.route.length; i++) {
        const node = plan.route[i];
        const distance = Math.hypot(
            p.x - (node.position.x + 0.5),
            p.y - node.position.y,
            p.z - (node.position.z + 0.5),
        );
        if (distance < nearestDistance) { nearestDistance = distance; currentOffset = i; }
    }
    const prefix = prefixPathDistance(plan.route);
    const currentPathIndex = plan.route[currentOffset].pathIndex;
    const candidates = [];
    for (const station of plan.stations) {
        const stationOffset = plan.route.findIndex(node => node.pathIndex === station.pathIndex);
        if (stationOffset < 0 || Math.abs(prefix[stationOffset] - prefix[currentOffset]) > maxGap) continue;
        const serviced = station.serviced
            || !!(bot._underwaterMiningServicedBreathStations
                && bot._underwaterMiningServicedBreathStations.has(station.id));
        // A serviced point may cover us from behind. An unopened point must be on
        // the remaining forward route; an old missed hole can never pull us back.
        if (!serviced && station.pathIndex < currentPathIndex) continue;
        const live = inspectBreathColumn(bot, station.feet);
        if (live) candidates.push({ ...station, ...live, serviced,
            routeDistance: Math.abs(prefix[stationOffset] - prefix[currentOffset]) });
    }
    candidates.sort((a, b) => a.routeDistance - b.routeDistance
        || Number(b.serviced) - Number(a.serviced) || a.pathIndex - b.pathIndex);
    return candidates[0] || null;
}

/**
 * Exception to pathfinder's blanket dontCreateFlow guard. It is intentionally
 * narrow: only an active miner already in water, covered by the route's five-block
 * breathing chain, may remove a reachable wet face that fits in one bar. Lava is absolute.
 */
export function canMineWaterAdjacentWithBreathing(bot, block, maxReach = 4.6) {
    try {
        if (!isUnderwaterMiningTask(bot) || !isBotInWater(bot)
            || !block || !block.position || block.boundingBox !== 'block') return false;
        const eye = bot.entity.position.offset(0, Number.isFinite(bot.entity.eyeHeight) ? bot.entity.eyeHeight : 1.62, 0);
        if (eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > maxReach) return false;
        let touchesWater = false;
        for (const [dx, dy, dz] of FACE_NEIGHBOURS) {
            const adjacent = bot.blockAt(block.position.offset(dx, dy, dz));
            if (isLavaBlock(adjacent)) return false;
            if (isWaterBlock(adjacent)) touchesWater = true;
        }
        if (!touchesWater || !underwaterDigBreathBudget(bot, block).possible) return false;
        if (!hasSolidFloor(bot, bot.entity.position)) return false;
        return !!findBreathStation(bot, bot.entity.position, 1)
            || !!plannedBreathingCoverage(bot, bot._underwaterMiningBreathPlan);
    } catch (e) {
        return false;
    }
}

export function shouldServiceUnderwaterBreath(bot, threshold = UNDERWATER_BREATH_THRESHOLD) {
    if (!isUnderwaterMiningTask(bot) || !isBotEyesInWater(bot)
        || !Number.isFinite(bot && bot.oxygenLevel)) return false;

    // Once a block started with enough oxygen for its full estimated duration, do
    // not interrupt it at the generic refill threshold: Minecraft resets partial
    // breaking progress. Unsafe starts are rejected immediately instead.
    if (bot.targetDigBlock) {
        const p = bot.targetDigBlock.position;
        const key = `${bot.targetDigBlock.name || ''}@${p ? `${p.x},${p.y},${p.z}` : '?'}`;
        if (!bot._underwaterMiningDigCommit || bot._underwaterMiningDigCommit.key !== key) {
            const budget = underwaterDigBreathBudget(bot, bot.targetDigBlock);
            bot._underwaterMiningDigCommit = {
                key,
                safe: budget.possible && bot.oxygenLevel >= budget.requiredOxygen,
            };
        }
        if (bot._underwaterMiningDigCommit.safe) return false;
    } else {
        bot._underwaterMiningDigCommit = null;
    }

    const station = findBreathStation(bot, bot.entity.position, 1);
    const stationThreshold = station && station.kind === 'one-block-hole'
        ? station.budget.requiredOxygen + 2 + station.horizontalDistance
        : threshold;
    return bot.oxygenLevel <= Math.max(threshold, stationThreshold);
}

export function needsBreathBeforeDig(bot, block) {
    if (!isUnderwaterMiningTask(bot) || !isBotEyesInWater(bot)) return false;
    const budget = underwaterDigBreathBudget(bot, block);
    if (!budget.possible) return true;
    return budget.availableOxygen != null && budget.availableOxygen < budget.requiredOxygen;
}

async function moveToBreathStation(bot, station, maxMs = 1800) {
    const target = station.feet.offset(0.5, 0, 0.5);
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxMs) {
        const p = bot.entity.position;
        if (Math.hypot(p.x - target.x, p.z - target.z) < 0.7) return true;
        try { await bot.lookAt(target.offset(0, 1, 0), true); } catch (e) { /* best effort */ }
        try { bot.setControlState('forward', true); } catch (e) { /* best effort */ }
        try { bot.setControlState('jump', true); } catch (e) { /* best effort */ }
        await sleep(60);
    }
    const p = bot.entity.position;
    return Math.hypot(p.x - target.x, p.z - target.z) < 0.9;
}

/**
 * Pause the current mining route, reach its local station, open at most one safe
 * ceiling block, refill oxygen, then return so the caller can resume the same goal.
 */
export async function serviceUnderwaterMiningBreath(bot, { station: preferredStation = null, stationRadius = 1, maxMs = 6500 } = {}) {
    if (!isUnderwaterMiningTask(bot) || !isBotInWater(bot)) return { ok: false, reason: 'not-underwater-mining' };
    bot._underwaterMiningBreathBlocked = false;
    let station = null;
    if (preferredStation && preferredStation.feet) {
        const refreshed = inspectBreathColumn(bot, preferredStation.feet);
        if (refreshed) station = { ...preferredStation, ...refreshed, id: preferredStation.id || stationId(refreshed) };
        else return { ok: false, reason: 'planned-breathing-station-became-invalid' };
    }
    if (!station) station = findBreathStation(bot, bot.entity.position, stationRadius);
    if (!station) station = plannedBreathingCoverage(bot, bot._underwaterMiningBreathPlan);
    if (!station) return { ok: false, reason: 'no-breathing-station' };

    const startedAt = Date.now();
    bot._underwaterMiningBreathing = true;
    try {
        try { if (typeof bot.stopDigging === 'function') bot.stopDigging(); } catch (e) { /* best effort */ }
        if (!await moveToBreathStation(bot, station)) return { ok: false, reason: 'breathing-station-unreachable', station };
        try { bot.setControlState('forward', false); } catch (e) { /* stop horizontal drift before settling */ }

        if (station.ventBlock) {
            if (!await settleForUnderwaterDig(bot) && !bot.entity.onGround)
                return { ok: false, reason: 'no-floor-for-safe-breathing-hole', station };
            const liveVent = bot.blockAt(station.ventBlock.position);
            if (!isAirBlock(liveVent)) {
                if (!safeBreathHoleBlock(bot, liveVent)) return { ok: false, reason: 'breathing-hole-became-unsafe', station };
                const budget = underwaterDigBreathBudget(bot, liveVent);
                // This check runs after movement to the station, so the live oxygen
                // level already includes travel. Keep two seconds only for rising into air.
                const riseReserve = 2;
                if (Number.isFinite(bot.oxygenLevel) && bot.oxygenLevel < budget.requiredOxygen + riseReserve)
                    return { ok: false, reason: 'insufficient-oxygen-to-open-hole', station, budget };
                try { if (bot.tool && bot.tool.equipForBlock) await bot.tool.equipForBlock(liveVent); } catch (e) { /* dig may still work */ }
                ensureWaterAwareDigTime(bot);
                const timeoutMs = Math.min(30000, Math.ceil(estimateUnderwaterDigMs(bot, liveVent) * 1.35) + 750);
                try {
                    await Promise.race([
                        bot.dig(liveVent),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('breathing-hole-timeout')), timeoutMs)),
                    ]);
                } catch (e) {
                    return { ok: false, reason: e.message || 'breathing-hole-dig-failed', station };
                }
            }
        }

        try { if (typeof bot.look === 'function') await bot.look(bot.entity.yaw || 0, -1.45, false); } catch (e) { /* best effort */ }
        try { bot.setControlState('forward', false); } catch (e) { /* best effort */ }
        try { bot.setControlState('jump', true); } catch (e) { /* best effort */ }
        while (Date.now() - startedAt < maxMs) {
            const eyesClear = !isBotEyesInWater(bot);
            const oxygenFull = !Number.isFinite(bot.oxygenLevel) || bot.oxygenLevel >= 19;
            if (eyesClear && oxygenFull) {
                bot._underwaterMiningLastBreathAt = Date.now();
                markPlannedBreathStationServiced(bot, station);
                return { ok: true, station };
            }
            await sleep(50);
        }
        return { ok: false, reason: 'oxygen-refill-timeout', station };
    } finally {
        bot._underwaterMiningBreathing = false;
        try { if (typeof bot.clearControlStates === 'function') bot.clearControlStates(); } catch (e) { /* best effort */ }
    }
}

/** Give a submerged miner one bounded second to plant its feet before starting. */
export async function settleForUnderwaterDig(bot, maxMs = 1000) {
    if (!isBotEyesInWater(bot) || !bot || !bot.entity || bot.entity.onGround) return false;
    bot._underwaterMiningSettling = true;
    try {
        const feet = bot.entity.position.floored();
        const floor = bot.blockAt(feet.offset(0, -1, 0));
        if (!floor || floor.boundingBox !== 'block') return false;
        const startedAt = Date.now();
        while (!bot.entity.onGround && isBotEyesInWater(bot) && Date.now() - startedAt < maxMs) {
            try { bot.setControlState('jump', false); } catch (e) { /* best effort */ }
            try { bot.setControlState('sneak', true); } catch (e) { /* best effort */ }
            await sleep(50);
        }
        return !!bot.entity.onGround;
    } catch (e) {
        return false;
    } finally {
        bot._underwaterMiningSettling = false;
        try { bot.setControlState('sneak', false); } catch (e) { /* best effort */ }
        try { bot.setControlState('jump', false); } catch (e) { /* best effort */ }
    }
}

export function digTimeoutForCurrentEnvironment(bot, block, baselineMs, capMs = 60000) {
    if (!isBotEyesInWater(bot) || !bot || typeof bot.digTime !== 'function') return baselineMs;
    try {
        const expectedMs = bot.digTime(block);
        if (!Number.isFinite(expectedMs) || expectedMs <= 0) return baselineMs;
        return Math.min(capMs, Math.max(baselineMs, Math.ceil(expectedMs * 1.35) + 750));
    } catch (e) {
        return baselineMs;
    }
}

export function pathStuckProfile(bot, baseTimeoutMs = 3000) {
    if (isBotInWater(bot)) {
        return { medium: 'water', radius: 0.5, timeoutMs: Math.max(baseTimeoutMs, 8000) };
    }
    return { medium: 'land', radius: 1.5, timeoutMs: baseTimeoutMs };
}

export function pathProgressDistance(from, to, medium = 'land') {
    if (!from || !to) return 0;
    if (medium === 'water') return Math.hypot(to.x - from.x, to.z - from.z);
    if (typeof to.distanceTo === 'function') return to.distanceTo(from);
    return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
}

export function shouldAccumulatePathStuck(bot, distance, profile) {
    if (bot && bot.targetDigBlock) return false;
    return distance < profile.radius;
}
