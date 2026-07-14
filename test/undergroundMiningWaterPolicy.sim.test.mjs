// Regression guard for the 2026-07-14 mineOres incident: the common
// pathfinder treated underground water as costly-but-passable, so it walked
// into an aquifer even though safeDig correctly guarded water-adjacent digs.
//
// Run: node test/undergroundMiningWaterPolicy.sim.test.mjs
import process from 'node:process';
import Vec3 from 'vec3';
import {
    applyUndergroundWaterAvoidance,
    isBotInWater,
    shouldAvoidUndergroundWater,
} from '../src/agent/library/navigation_policy.js';

const WATER = 26;
const FLOWING_WATER = 27;
const ids = { water: WATER, flowing_water: FLOWING_WATER };

function makeBot({ skill = 'mineOres', y = 48, foot = 'air', head = 'air' } = {}) {
    const position = new Vec3(0.5, y, 0.5);
    return {
        _currentSkill: skill,
        entity: { position },
        blockAt(p) {
            if (Math.floor(p.y) === Math.floor(y)) return { name: foot };
            if (Math.floor(p.y) === Math.floor(y) + 1) return { name: head };
            return { name: 'air' };
        },
    };
}

let failures = 0;
function check(name, condition) {
    if (condition) console.log(`  OK ${name}`);
    else { console.log(`  FAIL ${name}`); failures++; }
}

console.log('Test 1: underground mining hard-vetoes water');
for (const skill of ['mineOres', 'mineDiamonds', 'branchMine', 'mineDown']) {
    const bot = makeBot({ skill, y: 48 });
    const movements = { blocksToAvoid: new Set() };
    check(`${skill} activates policy`, shouldAvoidUndergroundWater(bot));
    check(`${skill} applies policy`, applyUndergroundWaterAvoidance(movements, bot, n => ids[n]));
    check(`${skill} avoids still water`, movements.blocksToAvoid.has(WATER));
    check(`${skill} avoids flowing water`, movements.blocksToAvoid.has(FLOWING_WATER));
}

console.log('Test 2: surface travel and recovery remain water-capable');
for (const [skill, y] of [['mineOres', 60], ['surfaceUp', 48], ['escapePlan', 48], ['gatherObsidian', 48]]) {
    const bot = makeBot({ skill, y });
    const movements = { blocksToAvoid: new Set() };
    check(`${skill}@${y} does not activate policy`, !shouldAvoidUndergroundWater(bot));
    check(`${skill}@${y} leaves movement unchanged`, !applyUndergroundWaterAvoidance(movements, bot, n => ids[n]) && movements.blocksToAvoid.size === 0);
}

console.log('Test 3: runtime water-entry sensor checks feet and head');
check('dry body is not in water', !isBotInWater(makeBot()));
check('water at feet is detected', isBotInWater(makeBot({ foot: 'water' })));
check('flowing water at head is detected', isBotInWater(makeBot({ head: 'flowing_water' })));

if (failures) {
    console.log(`FAILED: ${failures} assertion(s)`);
    process.exit(1);
}
console.log('ALL PASSED');
