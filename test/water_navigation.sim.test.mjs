import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { safeDig } from '../src/agent/library/skills.js';
import { safeToDigBlock } from '../src/agent/framework/tools/lava_guard.js';
import {
    DEFAULT_LIQUID_COST,
    DESTRUCTIVE_LIQUID_COST,
    MAX_BREATH_STATION_PATH_GAP,
    MAX_BREATH_TO_MINING_TARGET,
    UNDERWATER_DIG_MULTIPLIER,
    UNDERWATER_MINING_BLOCKED_COST,
    adoptUnderwaterMiningBreathPlan,
    adoptUnderwaterMiningPathUpdate,
    beginUnderwaterMiningTask,
    canMineWaterAdjacentWithBreathing,
    canPlanWaterAdjacentWithBreathing,
    clearUnderwaterMiningBreathPlan,
    digBreathingVentWithTimeout,
    digTimeoutForCurrentEnvironment,
    ensureWaterAwareDigTime,
    excludeUnsafeUnderwaterMiningTarget,
    findBreathStation,
    inspectBreathColumn,
    needsBreathBeforeDig,
    nextPlannedBreathStation,
    pathProgressDistance,
    pathStuckProfile,
    planUnderwaterMiningBreathing,
    releaseUnderwaterMiningBreathPlanForTargetDig,
    retainUnderwaterMiningBreathPlanForTargetDig,
    resolveUnderwaterMiningRouteTarget,
    serviceUnderwaterMiningBreath,
    settleForUnderwaterDig,
    shouldAccumulatePathStuck,
    shouldSuppressSwimJumpForUnderwaterDig,
    shouldServiceUnderwaterBreath,
    underwaterMiningStepCost,
} from '../src/agent/framework/tools/water_navigation.js';

const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const block = (name, position, boundingBox = 'empty', extra = {}) => ({
    name,
    position: position.floored(),
    boundingBox,
    type: boundingBox === 'block' ? 1 : 0,
    diggable: true,
    ...extra,
});

function makeBot({
    position = new Vec3(0.5, 20, 0.5),
    cells = new Map(),
    inWater = false,
    skill = '',
    oxygen = 20,
    digTime = 1000,
} = {}) {
    return {
        entity: { position, eyeHeight: 1.62, isInWater: inWater, onGround: true, yaw: 0, effects: {} },
        _currentSkill: skill,
        oxygenLevel: oxygen,
        targetDigBlock: null,
        inventory: { slots: [], items: () => [] },
        game: { gameMode: 'survival' },
        heldItem: null,
        getEquipmentDestSlot: () => 5,
        digTime: () => digTime,
        blockAt(pos) {
            return cells.get(key(pos)) || block('air', pos, 'empty');
        },
        setControlState() {},
        clearControlStates() {},
        async lookAt() {},
        async look() {},
        stopDigging() {},
        tool: { async equipForBlock() {} },
    };
}

function waterColumn(cells, x = 0, z = 0, feetY = 20, height = 2) {
    for (let dy = 0; dy < height; dy++) {
        const p = new Vec3(x, feetY + dy, z);
        cells.set(key(p), block('water', p));
    }
}

test('mineflayer-pathfinder charges liquidCost for every occupied water cell', () => {
    const movements = Object.create(pf.Movements.prototype);
    movements.liquidCost = DEFAULT_LIQUID_COST;
    movements.exclusionStep = () => 0;
    movements.getNumEntitiesAt = () => 0;
    movements.safeOrBreak = (b) => b.safe ? 0 : 100;
    movements.getBlock = (node, dx, dy, dz) => {
        const position = new Vec3(node.x + dx, node.y + dy, node.z + dz);
        if (dy === -1) return { position, physical: true, safe: false, liquid: false };
        if (dy === 0 && dx === 0 && dz === 0) return { position, physical: false, safe: true, liquid: true };
        return { position, physical: false, safe: true, liquid: dy === 0 };
    };
    const neighbors = [];
    movements.getMoveForward(new Vec3(0, 20, 0), { x: 1, z: 0 }, neighbors);
    assert.equal(neighbors[0].cost, 1 + DEFAULT_LIQUID_COST);
});

test('destructive water cost is calibrated against a dry excavation step, not empty land', () => {
    const moveCost = (sourceLiquid) => {
        const movements = Object.create(pf.Movements.prototype);
        movements.liquidCost = DESTRUCTIVE_LIQUID_COST;
        movements.exclusionStep = () => 0;
        movements.getNumEntitiesAt = () => 0;
        movements.safeOrBreak = (b) => b.safe ? 0 : 7;
        movements.getBlock = (node, dx, dy, dz) => {
            const position = new Vec3(node.x + dx, node.y + dy, node.z + dz);
            if (dx === 0 && dy === 0 && dz === 0)
                return { position, physical: false, safe: true, liquid: sourceLiquid };
            if (dy === -1) return { position, physical: true, safe: false, liquid: false };
            if (dx === 1 && dy === 0 && dz === 0)
                return { position, physical: true, safe: false, liquid: false };
            return { position, physical: false, safe: true, liquid: false };
        };
        const neighbors = [];
        movements.getMoveForward(new Vec3(0, 20, 0), { x: 1, z: 0 }, neighbors);
        return neighbors[0].cost;
    };

    const dryTunnelStep = moveCost(false);
    const wetTunnelStep = moveCost(true);
    assert.equal(dryTunnelStep, 8);
    assert.equal(wetTunnelStep, 32);
    assert.ok(wetTunnelStep >= dryTunnelStep * 4);
});

test('tracked pathfinder patch settles only an active underwater mining dig', () => {
    const source = fs.readFileSync(new URL('../patches/mineflayer-pathfinder+2.4.5.patch', import.meta.url), 'utf8');
    assert.match(source, /waterSettleStart/);
    assert.match(source, /bot\._underwaterMiningSettling = true/);
    assert.match(source, /bot\._underwaterMiningCanStartDig/);
    assert.match(source, /bot\._underwaterMiningShouldSettle/);
    assert.match(source, /bot\._underwaterMiningBreathBlocked = true/);
    assert.match(source, /bot\.setControlState\('sneak', true\)/);
    assert.doesNotMatch(source, /bot\.entity\.onGround \|\| bot\.entity\.isInWater/);
});

test('normal goto water remains finite while mining requires a local breathing station', () => {
    const sealedCells = new Map();
    waterColumn(sealedCells);
    sealedCells.set(key(new Vec3(0, 22, 0)), block('stone', new Vec3(0, 22, 0), 'block'));
    sealedCells.set(key(new Vec3(0, 23, 0)), block('stone', new Vec3(0, 23, 0), 'block'));
    const water = sealedCells.get(key(new Vec3(0, 20, 0)));

    const traveler = makeBot({ cells: sealedCells, skill: '' });
    assert.equal(underwaterMiningStepCost(traveler, water), 0, 'ordinary goto keeps finite liquidCost only');

    const miner = makeBot({ cells: sealedCells, skill: 'mineOres' });
    assert.equal(underwaterMiningStepCost(miner, water), UNDERWATER_MINING_BLOCKED_COST);
});

test('ordinary water digs stay afloat while settled underwater mining digs may suppress jump', () => {
    const target = block('oak_log', new Vec3(1, 20, 0), 'block');
    const ordinary = makeBot({ inWater: true });
    ordinary.targetDigBlock = target;
    ordinary._underwaterMiningSettling = true;
    assert.equal(shouldSuppressSwimJumpForUnderwaterDig(ordinary), false,
        'a generic surface or shoreline dig must keep the normal swim reflex');

    const miner = makeBot({ inWater: true, skill: 'mineOres' });
    miner.targetDigBlock = block('iron_ore', target.position, 'block');
    assert.equal(shouldSuppressSwimJumpForUnderwaterDig(miner), true);
    miner._underwaterMiningBreathing = true;
    assert.equal(shouldSuppressSwimJumpForUnderwaterDig(miner), false,
        'active breathing must override stale targetDigBlock state and allow ascent');
    miner._underwaterMiningBreathing = false;
    miner.targetDigBlock = null;
    miner._underwaterMiningSettling = true;
    assert.equal(shouldSuppressSwimJumpForUnderwaterDig(miner), true);
    miner._underwaterMiningSettling = false;
    assert.equal(shouldSuppressSwimJumpForUnderwaterDig(miner), false,
        'travelling between underwater mining cells keeps float movement available');
});

test('a complete underwater mining route preplans breathing holes no more than five path blocks apart', () => {
    const cells = new Map();
    const path = [];
    for (let x = 0; x <= 9; x++) {
        waterColumn(cells, x, 0);
        cells.set(key(new Vec3(x, 19, 0)), block('stone', new Vec3(x, 19, 0), 'block'));
        cells.set(key(new Vec3(x, 22, 0)), block('stone', new Vec3(x, 22, 0), 'block'));
        path.push({ x, y: 20, z: 0 });
    }
    const orePos = new Vec3(10, 20, 0);
    cells.set(key(orePos), block('iron_ore', orePos, 'block'));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', digTime: 800 });
    const plan = planUnderwaterMiningBreathing(bot, path, orePos, { complete: true });

    assert.equal(plan.ok, true);
    assert.equal(plan.policy.maxStationGap, MAX_BREATH_STATION_PATH_GAP);
    assert.equal(plan.policy.maxTargetDistance, MAX_BREATH_TO_MINING_TARGET);
    assert.deepEqual(plan.stations.map(station => station.pathIndex), [0, 5, 9]);
    for (let i = 1; i < plan.stations.length; i++)
        assert.ok(plan.stations[i].pathIndex - plan.stations[i - 1].pathIndex <= 5);
    const last = plan.stations.at(-1);
    assert.ok(Math.hypot(last.feet.x - orePos.x, last.feet.y - orePos.y, last.feet.z - orePos.z) <= 2);
});


test('wet A* break nodes are planned as future water instead of dry stone', () => {
    const cells = new Map();
    const path = [];
    for (let x = 0; x <= 4; x++) {
        const feet = new Vec3(x, 20, 0);
        cells.set(key(feet), block('stone', feet, 'block'));
        cells.set(key(feet.offset(0, -1, 0)), block('stone', feet.offset(0, -1, 0), 'block'));
        cells.set(key(feet.offset(0, 1, 0)), block('water', feet.offset(0, 1, 0)));
        cells.set(key(feet.offset(0, 0, 1)), block('water', feet.offset(0, 0, 1)));
        cells.set(key(feet.offset(0, 2, 0)), block('stone', feet.offset(0, 2, 0), 'block'));
        path.push({ x, y: 20, z: 0, toBreak: [feet] });
    }
    const orePos = new Vec3(5, 20, 0);
    cells.set(key(orePos), block('iron_ore', orePos, 'block'));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', digTime: 800 });
    const plan = planUnderwaterMiningBreathing(bot, path, orePos, { complete: true });

    assert.equal(plan.ok, true);
    assert.equal(plan.required, true);
    assert.ok(plan.route.every(node => node.water), 'every water-adjacent break becomes a wet route node');
    assert.deepEqual(plan.stations.map(station => station.pathIndex), [0, 4]);
    assert.ok(plan.stations.every(station => station.requiresOpenedWater));
    assert.equal(nextPlannedBreathStation(bot, plan), null,
        'the executor must not service a future station while its feet cell is still solid');
    const openedFeet = new Vec3(0, 20, 0);
    cells.set(key(openedFeet), block('water', openedFeet));
    assert.equal(nextPlannedBreathStation(bot, plan).pathIndex, 0,
        'the station becomes serviceable once path execution opens the flooded cell');
});
test('sealed intermediate cells are covered by sparse holes at path gaps 5, 4', () => {
    const cells = new Map();
    const path = [];
    for (let x = 0; x <= 9; x++) {
        waterColumn(cells, x, 0);
        cells.set(key(new Vec3(x, 19, 0)), block('stone', new Vec3(x, 19, 0), 'block'));
        cells.set(key(new Vec3(x, 22, 0)), block('stone', new Vec3(x, 22, 0), 'block'));
        cells.set(key(new Vec3(x, 23, 0)), block('stone', new Vec3(x, 23, 0), 'block'));
        path.push({ x, y: 20, z: 0 });
    }
    for (const x of [0, 5, 9]) cells.delete(key(new Vec3(x, 23, 0)));
    const orePos = new Vec3(10, 20, 0);
    cells.set(key(orePos), block('iron_ore', orePos, 'block'));
    const bot = makeBot({ cells, position: new Vec3(3.5, 20, 0.5), inWater: true, skill: 'mineOres', digTime: 800 });
    const plan = adoptUnderwaterMiningBreathPlan(
        bot,
        planUnderwaterMiningBreathing(bot, path, orePos, { complete: true }),
        orePos,
    );

    assert.equal(plan.ok, true);
    assert.deepEqual(plan.stations.map(station => station.pathIndex), [0, 5, 9]);
    assert.ok(underwaterMiningStepCost(bot, cells.get(key(new Vec3(3, 20, 0)))) < UNDERWATER_MINING_BLOCKED_COST,
        'a sealed midpoint is finite because the next planned hole covers it');

    const wetFace = block('stone', new Vec3(4, 20, 0), 'block');
    cells.set(key(wetFace.position), wetFace);
    assert.equal(canMineWaterAdjacentWithBreathing(bot, wetFace), true,
        'execution accepts a wet dig covered by the same planned chain');
    bot._underwaterMiningBreathPlan = null;
    assert.equal(canMineWaterAdjacentWithBreathing(bot, wetFace), false,
        'without the plan, no arbitrary sealed-cell dig is permitted');
});

test('a six-block gap between breathing holes makes the underwater route infeasible', () => {
    const cells = new Map();
    const path = [];
    for (let x = 0; x <= 10; x++) {
        waterColumn(cells, x, 0);
        cells.set(key(new Vec3(x, 19, 0)), block('stone', new Vec3(x, 19, 0), 'block'));
        cells.set(key(new Vec3(x, 22, 0)), block('stone', new Vec3(x, 22, 0), 'block'));
        cells.set(key(new Vec3(x, 23, 0)), block('stone', new Vec3(x, 23, 0), 'block'));
        path.push({ x, y: 20, z: 0 });
    }
    for (const x of [0, 6, 10]) cells.delete(key(new Vec3(x, 23, 0)));
    const orePos = new Vec3(11, 20, 0);
    cells.set(key(orePos), block('iron_ore', orePos, 'block'));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', digTime: 800 });
    const plan = planUnderwaterMiningBreathing(bot, path, orePos, { complete: true });

    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'planned-breathing-hole-gap-too-large');
});


test('a planned vent includes travel distance in its full-bar oxygen proof', () => {
    const cells = new Map();
    const path = [];
    for (let x = 0; x <= 5; x++) {
        waterColumn(cells, x, 0);
        cells.set(key(new Vec3(x, 19, 0)), block('stone', new Vec3(x, 19, 0), 'block'));
        cells.set(key(new Vec3(x, 22, 0)), block('stone', new Vec3(x, 22, 0), 'block'));
        cells.set(key(new Vec3(x, 23, 0)), block('stone', new Vec3(x, 23, 0), 'block'));
        path.push({ x, y: 20, z: 0 });
    }
    cells.delete(key(new Vec3(5, 23, 0)));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', digTime: 1800 });
    const plan = planUnderwaterMiningBreathing(bot, path, new Vec3(6, 20, 0), { complete: true });

    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'first-planned-breathing-hole-exceeds-oxygen-budget');
});
test('a partial route may not stop in sealed water without a breathing station', () => {
    const cells = new Map();
    const path = [];
    for (let x = 0; x <= 3; x++) {
        waterColumn(cells, x, 0);
        cells.set(key(new Vec3(x, 19, 0)), block('stone', new Vec3(x, 19, 0), 'block'));
        cells.set(key(new Vec3(x, 22, 0)), block('stone', new Vec3(x, 22, 0), 'block'));
        cells.set(key(new Vec3(x, 23, 0)), block('stone', new Vec3(x, 23, 0), 'block'));
        path.push({ x, y: 20, z: 0 });
    }
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', digTime: 800 });
    const plan = planUnderwaterMiningBreathing(bot, path, new Vec3(20, 20, 0), { complete: false });

    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'water-segment-without-plannable-breathing-hole');
});

test('a partial wet prefix must end at its own breathing station', () => {
    const cells = new Map();
    const path = [];
    for (let x = 0; x <= 3; x++) {
        waterColumn(cells, x, 0);
        cells.set(key(new Vec3(x, 19, 0)), block('stone', new Vec3(x, 19, 0), 'block'));
        cells.set(key(new Vec3(x, 22, 0)), block('stone', new Vec3(x, 22, 0), 'block'));
        cells.set(key(new Vec3(x, 23, 0)), block('stone', new Vec3(x, 23, 0), 'block'));
        path.push({ x, y: 20, z: 0 });
    }
    cells.delete(key(new Vec3(0, 23, 0)));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', digTime: 800 });
    const plan = planUnderwaterMiningBreathing(bot, path, new Vec3(20, 20, 0), { complete: false });

    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'partial-water-route-not-ending-at-breathing-station');
});

test('an interrupted mining route resumes forward on the same target and never turns back for a missed hole', () => {
    const cells = new Map();
    const path = [];
    for (let x = 0; x <= 9; x++) {
        waterColumn(cells, x, 0);
        cells.set(key(new Vec3(x, 19, 0)), block('stone', new Vec3(x, 19, 0), 'block'));
        cells.set(key(new Vec3(x, 22, 0)), block('stone', new Vec3(x, 22, 0), 'block'));
        path.push({ x, y: 20, z: 0 });
    }
    const orePos = new Vec3(10, 20, 0);
    cells.set(key(orePos), block('iron_ore', orePos, 'block'));
    const bot = makeBot({ cells, position: new Vec3(0.5, 20, 0.5), inWater: true, skill: 'mineOres', digTime: 800 });
    const plan = adoptUnderwaterMiningBreathPlan(
        bot,
        planUnderwaterMiningBreathing(bot, path, orePos, { complete: true }),
        orePos,
    );
    bot._underwaterMiningServicedBreathStations = new Set([plan.stations[0].id]);
    bot.entity.position = new Vec3(5.5, 20, 0.5);
    assert.equal(nextPlannedBreathStation(bot, plan).pathIndex, 5, 'resume projects to the next forward station');
    assert.deepEqual(resolveUnderwaterMiningRouteTarget(bot), { x: 10, y: 20, z: 0 });

    bot._underwaterMiningServicedBreathStations.clear();
    plan.cursor = 1;
    plan.projectedPathIndex = 0;
    bot.entity.position = new Vec3(8.5, 20, 0.5);
    const missed = nextPlannedBreathStation(bot, plan);
    assert.equal(missed.pathIndex, 5);
    assert.equal(missed.missed, true, 'executor must replan from here instead of swimming backward');
});

test('an emitted path update replaces the preview breathing schedule', () => {
    const cells = new Map();
    const preview = [];
    const actual = [];
    for (let i = 0; i <= 4; i++) {
        for (const [x, z] of [[i, 0], [0, i]]) {
            waterColumn(cells, x, z);
            cells.set(key(new Vec3(x, 19, z)), block('stone', new Vec3(x, 19, z), 'block'));
            cells.set(key(new Vec3(x, 22, z)), block('stone', new Vec3(x, 22, z), 'block'));
        }
        preview.push({ x: i, y: 20, z: 0 });
        actual.push({ x: 0, y: 20, z: i });
    }
    const previewTarget = new Vec3(5, 20, 0);
    const actualTarget = new Vec3(0, 20, 5);
    cells.set(key(previewTarget), block('iron_ore', previewTarget, 'block'));
    cells.set(key(actualTarget), block('iron_ore', actualTarget, 'block'));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', digTime: 800 });
    adoptUnderwaterMiningBreathPlan(
        bot,
        planUnderwaterMiningBreathing(bot, preview, previewTarget, { complete: true }),
        previewTarget,
    );

    const plan = adoptUnderwaterMiningPathUpdate(
        bot,
        { status: 'success', path: actual },
        actualTarget,
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.targetKey, key(actualTarget));
    assert.ok(plan.route.every(node => node.position.x === 0));
    assert.equal(plan.route.at(-1).position.z, 4,
        'the exact emitted route replaces the earlier preview route');
});

test('clearing a route schedule preserves the sticky target and serviced breathing holes', () => {
    const target = new Vec3(8, 20, 0);
    const cells = new Map([[key(target), block('iron_ore', target, 'block')]]);
    const bot = makeBot({ cells, skill: 'mineOres' });
    bot._underwaterMiningRouteTarget = { position: target, key: key(target), updatedAt: Date.now() };
    bot._underwaterMiningServicedBreathStations = new Set(['0,20,0']);
    bot._underwaterMiningBreathPlan = { ok: true, targetKey: key(target), stations: [] };
    bot._underwaterMiningBreathBlocked = true;

    assert.equal(clearUnderwaterMiningBreathPlan(bot), true);
    assert.equal(bot._underwaterMiningBreathPlan, null);
    assert.equal(bot._underwaterMiningBreathBlocked, false);
    assert.deepEqual(resolveUnderwaterMiningRouteTarget(bot), target);
    const currentGoal = new Vec3(20, 20, 0);
    assert.deepEqual(resolveUnderwaterMiningRouteTarget(bot, currentGoal), currentGoal,
        'a new mining skill goal overrides the previous collect target');
    assert.deepEqual([...bot._underwaterMiningServicedBreathStations], ['0,20,0']);
});

test('the final breath plan survives navigation only until its matching target dig returns', () => {
    const target = new Vec3(8, 20, 0);
    const other = block('stone', new Vec3(7, 20, 0), 'block');
    const bot = makeBot({ skill: 'mineOres' });
    bot._underwaterMiningBreathPlan = { ok: true, targetKey: key(target), stations: [], route: [] };

    assert.equal(retainUnderwaterMiningBreathPlanForTargetDig(bot), true);
    assert.equal(releaseUnderwaterMiningBreathPlanForTargetDig(bot, other), false);
    assert.ok(bot._underwaterMiningBreathPlan, 'intermediate corridor digs keep target coverage');
    assert.equal(releaseUnderwaterMiningBreathPlanForTargetDig(bot, block('iron_ore', target, 'block')), true);
    assert.equal(bot._underwaterMiningBreathPlan, null);
});

test('open air makes a mining water cell finite, and a one-block hole is finite but dearer', () => {
    const openCells = new Map();
    waterColumn(openCells);
    const openBot = makeBot({ cells: openCells, skill: 'mineOres' });
    const water = openCells.get(key(new Vec3(0, 20, 0)));
    const openStation = inspectBreathColumn(openBot, water.position);
    assert.equal(openStation.kind, 'open-air');
    assert.equal(underwaterMiningStepCost(openBot, water), 0);

    const holeCells = new Map();
    waterColumn(holeCells);
    holeCells.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    holeCells.set(key(new Vec3(0, 22, 0)), block('stone', new Vec3(0, 22, 0), 'block'));
    const holeBot = makeBot({ cells: holeCells, skill: 'mineOres', digTime: 1000 });
    const station = findBreathStation(holeBot, water.position);
    assert.equal(station.kind, 'one-block-hole');
    const holeCost = underwaterMiningStepCost(holeBot, holeCells.get(key(water.position)));
    assert.ok(holeCost > 0 && holeCost < UNDERWATER_MINING_BLOCKED_COST);
});

test('multi-block sealed ceilings and too-slow breathing holes are infeasible', () => {
    const sealed = new Map();
    waterColumn(sealed);
    sealed.set(key(new Vec3(0, 22, 0)), block('stone', new Vec3(0, 22, 0), 'block'));
    sealed.set(key(new Vec3(0, 23, 0)), block('stone', new Vec3(0, 23, 0), 'block'));
    const sealedBot = makeBot({ cells: sealed, skill: 'mineOres' });
    assert.equal(findBreathStation(sealedBot, new Vec3(0, 20, 0)), null);

    const slow = new Map();
    waterColumn(slow);
    slow.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    slow.set(key(new Vec3(0, 22, 0)), block('obsidian', new Vec3(0, 22, 0), 'block'));
    const slowBot = makeBot({ cells: slow, skill: 'mineOres', digTime: 2800 });
    assert.equal(findBreathStation(slowBot, new Vec3(0, 20, 0)), null, 'vent plus rise reserve exceeds one oxygen bar');

    const flooded = new Map();
    waterColumn(flooded);
    flooded.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    flooded.set(key(new Vec3(0, 22, 0)), block('stone', new Vec3(0, 22, 0), 'block'));
    flooded.set(key(new Vec3(1, 22, 0)), block('water', new Vec3(1, 22, 0)));
    const floodedBot = makeBot({ cells: flooded, skill: 'mineOres' });
    assert.equal(findBreathStation(floodedBot, new Vec3(0, 20, 0)), null, 'lateral water would flood the opened hole');

    const valuable = new Map();
    waterColumn(valuable);
    valuable.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    valuable.set(key(new Vec3(0, 22, 0)), block('diamond_ore', new Vec3(0, 22, 0), 'block', {
        canHarvest: () => false,
    }));
    const underTooled = makeBot({ cells: valuable, skill: 'mineOres' });
    underTooled.heldItem = { name: 'stone_pickaxe', type: 274 };
    assert.equal(findBreathStation(underTooled, new Vec3(0, 20, 0)), null,
        'an unharvestable ore ceiling is preserved instead of consumed as a vent');
});

test('underwater dig timing matches the server penalty and installs only once', () => {
    const cells = new Map();
    waterColumn(cells);
    const bot = makeBot({ cells, inWater: true, digTime: 120 });
    assert.equal(ensureWaterAwareDigTime(bot), true);
    assert.equal(ensureWaterAwareDigTime(bot), false);
    const ore = block('iron_ore', new Vec3(1, 20, 0), 'block');
    assert.equal(bot.digTime(ore), 120 * UNDERWATER_DIG_MULTIPLIER);
    assert.equal(digTimeoutForCurrentEnvironment(bot, ore, 500), 1560);
});

test('oxygen budget requests a refill and rejects a block longer than one full bar', () => {
    const cells = new Map();
    waterColumn(cells);
    const target = block('iron_ore', new Vec3(1, 20, 0), 'block');
    const low = makeBot({ cells, inWater: true, skill: 'mineOres', oxygen: 8, digTime: 1000 });
    assert.equal(needsBreathBeforeDig(low, target), true);
    low.oxygenLevel = 20;
    assert.equal(needsBreathBeforeDig(low, target), false);

    const impossible = makeBot({ cells, inWater: true, skill: 'mineOres', oxygen: 20, digTime: 4000 });
    assert.equal(needsBreathBeforeDig(impossible, target), true);
});

test('breathing trigger starts early enough to open a vent but never resets a safely committed dig', () => {
    const cells = new Map();
    waterColumn(cells);
    cells.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    cells.set(key(new Vec3(0, 22, 0)), block('stone', new Vec3(0, 22, 0), 'block'));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', oxygen: 17, digTime: 2000 });
    assert.equal(shouldServiceUnderwaterBreath(bot), true, '10s vent + reserves triggers at oxygen 17, not 16');

    const target = block('iron_ore', new Vec3(1, 20, 0), 'block');
    bot.targetDigBlock = target;
    bot.oxygenLevel = 16;
    bot.digTime = () => 1000;
    assert.equal(shouldServiceUnderwaterBreath(bot), false, 'a dig started with its full budget is allowed to finish');

    bot._underwaterMiningDigCommit = null;
    bot.oxygenLevel = 8;
    assert.equal(shouldServiceUnderwaterBreath(bot), true, 'an unsafe dig start is paused for air');
});

test('breathing service opens one overhead hole, refills, and preserves the mining task', async () => {
    const cells = new Map();
    waterColumn(cells);
    cells.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    const ventPos = new Vec3(0, 22, 0);
    cells.set(key(ventPos), block('dirt', ventPos, 'block'));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', oxygen: 16, digTime: 800 });
    const targetTool = { name: 'iron_pickaxe', type: 257, metadata: 0 };
    const ventTool = { name: 'iron_shovel', type: 256, metadata: 0 };
    bot.heldItem = targetTool;
    bot.tool.equipForBlock = async () => { bot.heldItem = ventTool; };
    bot.equip = async (item) => { bot.heldItem = item; };
    const controls = [];
    bot.setControlState = (name, value) => {
        controls.push([name, value]);
        if (name === 'jump' && value && cells.get(key(ventPos))?.name === 'air') {
            bot.entity.position = new Vec3(0.5, 21, 0.5);
            bot.entity.isInWater = false;
            bot.oxygenLevel = 20;
        }
    };
    bot.dig = (target) => {
        cells.set(key(target.position), block('air', target.position));
        return Promise.resolve();
    };

    const result = await serviceUnderwaterMiningBreath(bot, { maxMs: 1000 });
    assert.equal(result.ok, true);
    assert.equal(cells.get(key(ventPos)).name, 'air');
    assert.equal(bot._currentSkill, 'mineOres');
    assert.equal(bot._underwaterMiningBreathing, false);
    assert.equal(bot.heldItem, targetTool, 'the original ore tool is restored after opening a dirt vent');
    assert.ok(controls.some(([name, value]) => name === 'jump' && value));
});

test('breathing service reaches the planned station height in the same water column', async () => {
    const cells = new Map();
    waterColumn(cells, 0, 0, 20);
    const bot = makeBot({
        cells,
        position: new Vec3(0.5, 17, 0.5),
        inWater: true,
        skill: 'mineOres',
        oxygen: 20,
    });
    const station = inspectBreathColumn(bot, new Vec3(0, 20, 0));
    bot.setControlState = (name, value) => {
        if (name === 'jump' && value && bot.entity.position.y < 21)
            bot.entity.position = bot.entity.position.offset(0, 1, 0);
    };

    const result = await serviceUnderwaterMiningBreath(bot, { station, maxMs: 200 });
    assert.equal(result.ok, true);
    assert.ok(bot.entity.position.y >= 19.5,
        'matching x/z at the wrong elevation is not considered arrival');
});

test('breathing service releases sneak before rising from a lower station', async () => {
    const cells = new Map();
    waterColumn(cells, 0, 0, 20, 1);
    const bot = makeBot({
        cells,
        position: new Vec3(0.5, 22, 0.5),
        inWater: true,
        skill: 'mineOres',
        oxygen: 10,
    });
    const station = inspectBreathColumn(bot, new Vec3(0, 20, 0));
    let sneaking = false;
    const controls = [];
    bot.setControlState = (name, value) => {
        controls.push([name, value]);
        if (name === 'sneak') sneaking = value;
        if (name === 'sneak' && value) bot.entity.position = new Vec3(0.5, 20, 0.5);
        if (name === 'jump' && value && !sneaking) {
            bot.entity.position = new Vec3(0.5, 21, 0.5);
            bot.entity.isInWater = false;
            bot.oxygenLevel = 20;
        }
    };

    const result = await serviceUnderwaterMiningBreath(bot, { station, maxMs: 200 });
    assert.equal(result.ok, true);
    const release = controls.findIndex(([name, value]) => name === 'sneak' && value === false);
    const ascent = controls.findIndex(([name, value]) => name === 'jump' && value === true);
    assert.ok(release >= 0 && ascent > release, 'downward swim is released before refill ascent');
});

test('the oxygen refill window starts after a slow breathing vent is opened', async () => {
    const cells = new Map();
    waterColumn(cells);
    cells.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    const ventPos = new Vec3(0, 22, 0);
    cells.set(key(ventPos), block('stone', ventPos, 'block'));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', oxygen: 16, digTime: 800 });
    bot.dig = async (target) => {
        await new Promise(resolve => setTimeout(resolve, 120));
        cells.set(key(target.position), block('air', target.position));
    };
    bot.setControlState = (name, value) => {
        if (name === 'jump' && value && cells.get(key(ventPos))?.name === 'air') {
            bot.entity.position = new Vec3(0.5, 21, 0.5);
            bot.entity.isInWater = false;
            bot.oxygenLevel = 20;
        }
    };

    const result = await serviceUnderwaterMiningBreath(bot, { maxMs: 50 });
    assert.equal(result.ok, true, 'vent dig time does not consume the separate refill window');
});

test('a timed-out breathing vent actively aborts the underlying dig', async () => {
    const bot = makeBot({ inWater: true, skill: 'mineOres' });
    let stopped = false;
    bot.dig = () => new Promise(() => {});
    bot.stopDigging = () => { stopped = true; };

    const result = await digBreathingVentWithTimeout(
        bot,
        block('stone', new Vec3(0, 22, 0), 'block'),
        20,
    );
    assert.deepEqual(result, { ok: false, reason: 'breathing-hole-timeout' });
    assert.equal(stopped, true);
});

test('a planned breathing hole checks live oxygen after arrival and keeps a rise reserve', async () => {
    const cells = new Map();
    waterColumn(cells);
    cells.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    const ventPos = new Vec3(0, 22, 0);
    cells.set(key(ventPos), block('stone', ventPos, 'block'));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', oxygen: 10, digTime: 800 });
    const station = inspectBreathColumn(bot, new Vec3(0, 20, 0));
    let dug = false;
    bot.dig = () => { dug = true; return Promise.resolve(); };

    const result = await serviceUnderwaterMiningBreath(bot, { station, maxMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'insufficient-oxygen-to-open-hole');
    assert.equal(dug, false, 'never begin the vent when there is no oxygen left to rise into it');
});


test('breathing service never digs valuable ore after vent tool selection fails', async () => {
    const cells = new Map();
    waterColumn(cells);
    cells.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    const ventPos = new Vec3(0, 22, 0);
    const ironPick = { name: 'iron_pickaxe', type: 257 };
    cells.set(key(ventPos), block('diamond_ore', ventPos, 'block', {
        canHarvest: type => type === ironPick.type,
    }));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', oxygen: 20, digTime: 800 });
    bot.heldItem = { name: 'stone_pickaxe', type: 274 };
    bot.pathfinder = { bestHarvestTool: () => ironPick };
    const station = inspectBreathColumn(bot, new Vec3(0, 20, 0));
    let dug = false;
    bot.tool.equipForBlock = async () => { throw new Error('tool switch failed'); };
    bot.dig = () => { dug = true; return Promise.resolve(); };

    const result = await serviceUnderwaterMiningBreath(bot, { station, maxMs: 100 });
    assert.equal(result.reason, 'breathing-hole-would-waste-ore');
    assert.equal(dug, false);
});
test('breathing service refuses sealed water instead of improvising a risky tunnel', async () => {
    const cells = new Map();
    waterColumn(cells);
    cells.set(key(new Vec3(0, 22, 0)), block('stone', new Vec3(0, 22, 0), 'block'));
    cells.set(key(new Vec3(0, 23, 0)), block('stone', new Vec3(0, 23, 0), 'block'));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', oxygen: 16 });
    assert.deepEqual(await serviceUnderwaterMiningBreath(bot), { ok: false, reason: 'no-breathing-station' });
});

test('fluid guard and pathfinder break gate share the breathing-station contract', () => {
    const targetPos = new Vec3(1, 20, 0);
    const target = block('iron_ore', targetPos, 'block');
    const open = new Map();
    waterColumn(open);
    open.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    const wetMiner = makeBot({ cells: open, inWater: true, skill: 'mineOres' });
    assert.deepEqual(safeToDigBlock(wetMiner, target), { ok: true });
    assert.equal(canMineWaterAdjacentWithBreathing(wetMiner, target), true);

    const sealed = new Map(open);
    sealed.set(key(new Vec3(0, 22, 0)), block('stone', new Vec3(0, 22, 0), 'block'));
    sealed.set(key(new Vec3(0, 23, 0)), block('stone', new Vec3(0, 23, 0), 'block'));
    const sealedMiner = makeBot({ cells: sealed, inWater: true, skill: 'mineOres' });
    assert.equal(safeToDigBlock(sealedMiner, target).hazard, 'water');
    assert.equal(canMineWaterAdjacentWithBreathing(sealedMiner, target), false);

    const dryMiner = makeBot({ position: new Vec3(0.5, 20, -0.5), cells: open, skill: 'mineOres' });
    assert.equal(safeToDigBlock(dryMiner, target).hazard, 'water');
});

test('the Movements exception permits only a wet miner with a breathing station', () => {
    const targetPos = new Vec3(1, 20, 0);
    const target = { ...block('stone', targetPos, 'block'), type: 1 };
    const open = new Map();
    waterColumn(open);
    open.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    open.set(key(new Vec3(1, 19, 0)), block('stone', new Vec3(1, 19, 0), 'block'));
    const movementFor = (bot) => {
        const movements = Object.create(pf.Movements.prototype);
        movements.bot = bot;
        movements.canDig = true;
        movements.dontCreateFlow = true;
        movements.dontMineUnderFallingBlock = false;
        movements.blocksCantBreak = new Set();
        movements.exclusionBreak = () => 0;
        movements.getNumEntitiesAt = () => 0;
        movements.getBlock = (pos, dx, dy, dz) => {
            const adjacent = bot.blockAt(pos.offset(dx, dy, dz));
            return { ...adjacent, liquid: /water|lava/.test(adjacent.name || ''), canFall: false };
        };
        return movements;
    };
    const wetMiner = makeBot({ cells: open, inWater: true, skill: 'mineOres' });
    assert.equal(movementFor(wetMiner).safeToBreak(target), true);
    const wetTraveler = makeBot({ cells: open, inWater: true, skill: '' });
    assert.equal(movementFor(wetTraveler).safeToBreak(target), false);
});

test('A* planning accepts a future wet dig without applying the bot current reach', () => {
    const cells = new Map();
    waterColumn(cells, 7, 0);
    cells.set(key(new Vec3(7, 19, 0)), block('stone', new Vec3(7, 19, 0), 'block'));
    const future = block('stone', new Vec3(8, 20, 0), 'block');
    cells.set(key(future.position), future);
    const bot = makeBot({ cells, position: new Vec3(0.5, 20, 0.5), inWater: true, skill: 'mineOres' });

    assert.equal(canPlanWaterAdjacentWithBreathing(bot, future), false,
        'a future submerged dig without footing is not executable');
    cells.set(key(future.position.offset(0, -1, 0)), block('stone', future.position.offset(0, -1, 0), 'block'));
    assert.equal(canPlanWaterAdjacentWithBreathing(bot, future), true);
    assert.equal(canMineWaterAdjacentWithBreathing(bot, future), false,
        'execution still enforces the live 4.6-block reach');
});

test('lava remains an absolute veto even beside a valid breathing station', () => {
    const cells = new Map();
    waterColumn(cells);
    cells.set(key(new Vec3(2, 20, 0)), block('lava', new Vec3(2, 20, 0)));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres' });
    const target = block('iron_ore', new Vec3(1, 20, 0), 'block');
    assert.equal(safeToDigBlock(bot, target).hazard, 'lava');
    assert.equal(canMineWaterAdjacentWithBreathing(bot, target), false);
});

test('water uses a slower progress window and active digging never counts as stuck', () => {
    const bot = makeBot({ inWater: true });
    const profile = pathStuckProfile(bot, 3000);
    assert.deepEqual(profile, { medium: 'water', radius: 0.5, timeoutMs: 8000 });
    assert.equal(pathProgressDistance(new Vec3(0, 20, 0), new Vec3(0, 21, 0), profile.medium), 1);
    assert.equal(shouldAccumulatePathStuck(bot, 1, profile), false,
        'real vertical swimming resets the water stuck timer');
    assert.ok(pathProgressDistance(new Vec3(0, 20, 0), new Vec3(0, 20.2, 0), profile.medium) < profile.radius,
        'ordinary sub-block bobbing remains below the progress threshold');
    assert.equal(shouldAccumulatePathStuck(bot, 0.1, profile), true);
    bot.targetDigBlock = block('stone', new Vec3(1, 20, 0), 'block');
    assert.equal(shouldAccumulatePathStuck(bot, 0, profile), false);
});

test('safeDig refuses to dig after a refill moves an approach-disabled miner out of reach', async () => {
    const cells = new Map();
    const path = [];
    for (let x = 0; x <= 5; x++) {
        waterColumn(cells, x, 0);
        cells.set(key(new Vec3(x, 19, 0)), block('stone', new Vec3(x, 19, 0), 'block'));
        if (x < 5) {
            cells.set(key(new Vec3(x, 22, 0)), block('stone', new Vec3(x, 22, 0), 'block'));
            cells.set(key(new Vec3(x, 23, 0)), block('stone', new Vec3(x, 23, 0), 'block'));
        }
        path.push({ x, y: 20, z: 0 });
    }
    const targetPos = new Vec3(-1, 20, 0);
    const target = block('iron_ore', targetPos, 'block');
    cells.set(key(targetPos), target);
    cells.set(key(targetPos.offset(0, -1, 0)), block('stone', targetPos.offset(0, -1, 0), 'block'));
    const bot = makeBot({ cells, inWater: true, skill: 'mineOres', oxygen: 2, digTime: 1000 });
    adoptUnderwaterMiningBreathPlan(
        bot,
        planUnderwaterMiningBreathing(bot, path, targetPos, { complete: false }),
        targetPos,
    );
    let dug = false;
    bot.dig = async () => { dug = true; };
    bot.setControlState = (name, value) => {
        if (name === 'forward' && value && bot.entity.position.x < 5)
            bot.entity.position = new Vec3(5.5, 20, 0.5);
        if (name === 'jump' && value && bot.entity.position.x >= 5) {
            bot.entity.position = new Vec3(5.5, 21, 0.5);
            bot.entity.isInWater = false;
            bot.oxygenLevel = 20;
        }
    };

    assert.equal(await safeDig(bot, target, { approach: false, equip: false }), 'underwater-unsafe');
    assert.equal(dug, false, 'successful refill must not bypass the live reach proof');
});

test('safeDig does not force ordinary submerged collection to settle on a floor', async () => {
    const cells = new Map();
    waterColumn(cells);
    const target = block('oak_log', new Vec3(1, 20, 0), 'block');
    cells.set(key(target.position), target);
    const bot = makeBot({ cells, inWater: true });
    bot.entity.onGround = false;
    let dug = false;
    bot.dig = async () => { dug = true; };
    const previousGuard = process.env.MC_DIG_FLUID_GUARD;
    process.env.MC_DIG_FLUID_GUARD = '0';
    try {
        assert.equal(await safeDig(bot, target, { approach: false, equip: false }), 'ok');
    } finally {
        if (previousGuard === undefined) delete process.env.MC_DIG_FLUID_GUARD;
        else process.env.MC_DIG_FLUID_GUARD = previousGuard;
    }
    assert.equal(dug, true);
});

test('a direct collect scope is recognized as mining and is cleaned up', () => {
    const bot = makeBot();
    const endNonMining = beginUnderwaterMiningTask(bot, false);
    assert.equal(bot._underwaterMiningTaskDepth, undefined, 'logs/workstations do not enter underwater mining mode');
    endNonMining();
    const end = beginUnderwaterMiningTask(bot);
    assert.equal(bot._underwaterMiningTaskDepth, 1);
    bot._underwaterMiningBreathPlan = { ok: true, targetKey: '1,2,3' };
    end();
    end();
    assert.equal(bot._underwaterMiningTaskDepth, 0);
    assert.equal(bot._underwaterMiningBreathPlan, null, 'ending a task releases any retained target plan');
});

test('an unsafe underwater collect target is excluded once and releases its sticky lock', () => {
    const target = block('iron_ore', new Vec3(4, 20, 2), 'block');
    const bot = makeBot();
    bot._collectSticky = { pos: target.position, at: Date.now() };

    const excluded = excludeUnsafeUnderwaterMiningTarget(bot, target);
    assert.deepEqual(excluded, [target.position]);
    assert.equal(bot._collectSticky, null);
    assert.equal(excludeUnsafeUnderwaterMiningTarget(bot, target, excluded), excluded);
    assert.equal(excluded.length, 1, 'retry handling must not accumulate duplicate exclusions');
});

test('a submerged miner settles onto an immediate floor before digging', async () => {
    const cells = new Map();
    waterColumn(cells);
    cells.set(key(new Vec3(0, 19, 0)), block('stone', new Vec3(0, 19, 0), 'block'));
    const bot = makeBot({ cells, inWater: true });
    bot.entity.onGround = false;
    bot.setControlState = (name, value) => {
        if (name === 'sneak' && value) bot.entity.onGround = true;
    };
    assert.equal(await settleForUnderwaterDig(bot, 100), true);
    assert.equal(bot._underwaterMiningSettling, false);
});
