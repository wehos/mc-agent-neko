// Regression guard for the 2026-07-14 mineOres incident: the common
// pathfinder treated underground water as costly-but-passable, so it walked
// into an aquifer even though safeDig correctly guarded water-adjacent digs.
//
// Run: node test/undergroundMiningWaterPolicy.sim.test.mjs
import process from 'node:process';
import { readFileSync } from 'node:fs';
import Vec3 from 'vec3';
import {
    applyUndergroundWaterAvoidance,
    createUndergroundWaterGuard,
    findNearbyDryStandPositions,
    isBotInWater,
    isUndergroundMiningWaterSafetyError,
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
    const movements = { blocksToAvoid: new Set(), blocksCantBreak: new Set() };
    check(`${skill} activates policy`, shouldAvoidUndergroundWater(bot));
    check(`${skill} applies policy`, applyUndergroundWaterAvoidance(movements, bot, n => ids[n]));
    check(`${skill} avoids still water`, movements.blocksToAvoid.has(WATER));
    check(`${skill} avoids flowing water`, movements.blocksToAvoid.has(FLOWING_WATER));
    check(`${skill} cannot break still water`, movements.blocksCantBreak.has(WATER));
    check(`${skill} cannot break flowing water`, movements.blocksCantBreak.has(FLOWING_WATER));
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

console.log('Test 4: an initial-water recovery arms after reaching dry ground');
{
    let foot = 'water';
    const bot = makeBot({ foot });
    bot.blockAt = (p) => Math.floor(p.y) === 48 ? { name: foot } : { name: 'air' };
    const guard = createUndergroundWaterGuard(bot);
    check('guard records an initial-water start', guard.startedInWater && !guard.armed);
    check('initial water remains recovery-only', guard.observe() === 'initial-water');
    foot = 'air';
    check('first dry observation arms the guard', guard.observe() === 'armed' && guard.armed);
    check('dry travel remains allowed after arming', guard.observe() === 'dry');
    foot = 'water';
    check('later water contact is a new entry', guard.observe() === 'entered');
}

console.log('Test 5: a route crossing below Y55 activates the guard');
{
    const bot = makeBot({ y: 60 });
    const guard = createUndergroundWaterGuard(bot);
    check('guard begins disabled above cutoff', !guard.enabled && guard.observe() === 'disabled');
    bot.entity.position.y = 54;
    check('dry descent arms the guard', guard.observe() === 'armed' && guard.enabled && guard.armed);
}
{
    const bot = makeBot({ y: 60 });
    let foot = 'air';
    bot.blockAt = (p) => Math.floor(p.y) === Math.floor(bot.entity.position.y) ? { name: foot } : { name: 'air' };
    const guard = createUndergroundWaterGuard(bot);
    bot.entity.position.y = 54;
    foot = 'water';
    check('wet descent is rejected as a new entry', guard.observe() === 'entered');
}

console.log('Test 6: water recovery only targets dry standable columns');
{
    const bot = makeBot();
    const good = new Vec3(2, 48, 0);
    const caveAir = new Vec3(1, 48, 0);
    const wetHead = new Vec3(3, 48, 0);
    const noFloor = new Vec3(4, 48, 0);
    bot.findBlocks = ({ matching }) => [noFloor, wetHead, good, caveAir]
        .filter(p => matching({ name: p === caveAir ? 'cave_air' : 'air' }));
    bot.blockAt = (p) => {
        if (p.x === wetHead.x && p.y === wetHead.y + 1) return { name: 'water', boundingBox: 'empty' };
        if (p.x === noFloor.x && p.y === noFloor.y - 1) return { name: 'air', boundingBox: 'empty' };
        if (p.y === 47) return { name: 'stone', boundingBox: 'block' };
        if (p.x === caveAir.x) return { name: 'cave_air', boundingBox: 'empty' };
        return { name: 'air', boundingBox: 'empty' };
    };
    const positions = findNearbyDryStandPositions(bot);
    check('plain air and cave_air dry columns remain', positions.length === 2 && positions.includes(good) && positions.includes(caveAir));
}

console.log('Test 7: mining callers distinguish fatal water safety failures');
for (const name of [
    'UndergroundMiningWaterEntry',
    'UndergroundMiningStillInWater',
    'UndergroundMiningNoDryExit',
]) {
    const error = new Error(name);
    error.name = name;
    check(`${name} is safety-fatal`, isUndergroundMiningWaterSafetyError(error));
}
for (const name of ['PathfindingFailed', 'UndergroundMiningWaterPolicyArmed']) {
    const error = new Error(name);
    error.name = name;
    check(`${name} remains ordinary control flow`, !isUndergroundMiningWaterSafetyError(error));
}

console.log('Test 8: water safety checks stay wired through navigation and mineOres');
{
    const skillsSource = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const mineOresSource = readFileSync(new URL('../bots/_supervisor/skills/mineOres.js', import.meta.url), 'utf8');
    const descentSource = readFileSync(new URL('../bots/_supervisor/skills/descentOreSweep.js', import.meta.url), 'utf8');
    check('pseudo-success path reuses the success-boundary water observer',
        /Goal reached[\s\S]{0,500}observeWaterAtSuccess\(\)/.test(skillsSource));
    check('policy arming performs a fresh guarded route selection',
        /waterPolicyArmed[\s\S]{0,2500}path\.water_policy_replan/.test(skillsSource));
    check('goToPosition rethrows water safety failures',
        /export async function goToPosition[\s\S]{0,3000}isUndergroundMiningWaterSafetyError\(err\)\) throw err/.test(skillsSource));
    check('mineOres rethrows water safety failures', mineOresSource.includes('rethrowWaterSafetyError'));
    check('live ore approach rethrows water safety failures',
        descentSource.includes('skills.isUndergroundMiningWaterSafetyError(e)'));
}

if (failures) {
    console.log(`FAILED: ${failures} assertion(s)`);
    process.exit(1);
}
console.log('ALL PASSED');
