// Offline regression for the mining hazard-detour reflex.
// Run: node bots/_supervisor/test/miningDetour.test.mjs
import {
    corridorSafety,
    orderedMiningDetours,
    selectMiningDetour,
} from '../../../src/agent/framework/tools/mining_detour.js';

let pass = 0, fail = 0;
const check = (name, condition) => {
    if (condition) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}`); }
};

console.log('corridorSafety:');
check('solid dry corridor is safe', corridorSafety({ floorSolid: true }).safe === true);
check('water/lava in corridor is unsafe', corridorSafety({ floorSolid: true, fluidInCorridor: true }).reason === 'fluid-in-corridor');
check('opening a fluid face is unsafe', corridorSafety({ floorSolid: true, fluidWouldEnter: true }).reason === 'fluid-would-enter');
check('cave/ravine drop is unsafe', corridorSafety({ floorSolid: false }).reason === 'no-floor');
check('visited cell is not selected again', corridorSafety({ floorSolid: true, visited: true }).reason === 'visited');

console.log('orderedMiningDetours:');
const turns = orderedMiningDetours(1, 0);
check('+x left is +z', turns[0].dx === 0 && turns[0].dz === 1);
check('+x right is -z', turns[1].dx === 0 && turns[1].dz === -1);
check('+x back is -x', turns[2].dx === -1 && turns[2].dz === 0);

console.log('selectMiningDetour:');
const picked = selectMiningDetour(1, 0, [
    { dx: 0, dz: 1, safe: true, score: 8 },
    { dx: 0, dz: -1, safe: true, score: 4 },
    { dx: -1, dz: 0, safe: true, score: 12 },
]);
check('prefers safe route that stays closest to target', picked && picked.dx === 0 && picked.dz === -1);
const fallback = selectMiningDetour(1, 0, [
    { dx: 0, dz: 1, safe: false, score: 1 },
    { dx: 0, dz: -1, safe: false, score: 1 },
    { dx: -1, dz: 0, safe: true, score: 9 },
]);
check('can back out when both sides are blocked', fallback && fallback.dx === -1 && fallback.dz === 0);
check('returns null when every route is unsafe', selectMiningDetour(1, 0, []) === null);

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  pass=${pass} fail=${fail}`);
if (fail !== 0) throw new Error(`${fail} mining detour regression(s) failed`);
