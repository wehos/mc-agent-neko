// Offline regression for forageBudget — the gate that prevents the C210 death (marching the
// last food away to an unreachable target). Pure, zero live risk.
// Run: node bots/_supervisor/test/forage.test.mjs

import { forageBudget } from '../skills/forage.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

console.log('forageBudget:');
// THE C210 case: food=2, salmon ~40 blocks away IN WATER -> must REFUSE (this killed the bot).
const c210 = forageBudget(2, 40, true);
check('C210 case (food=2, d=40, water) -> REFUSE', c210.go === false, JSON.stringify(c210));

// food=2, even a close water target -> refuse (below water floor 8).
check('food=2 close water -> refuse (floor)', forageBudget(2, 6, true).go === false);

// Healthy buffer, near land animal -> go.
check('food=14, d=10 land -> go', forageBudget(14, 10, false).go === true);

// Moderate buffer, near land animal -> go.
check('food=9, d=12 land -> go', forageBudget(9, 12, false).go === true);

// Moderate buffer but FAR land target that would dip below 2 -> refuse.
check('food=6, d=60 land -> refuse (cost too high)', forageBudget(6, 60, false).go === false, JSON.stringify(forageBudget(6, 60, false)));

// Land floor is lower (5) than water floor (8): food=6 near land ok, near water refused.
check('food=6, d=8 land -> go', forageBudget(6, 8, false).go === true);
check('food=6, d=8 water -> refuse (below water floor 8)', forageBudget(6, 8, true).go === false);

// Good buffer can afford a reasonable water trip.
check('food=16, d=12 water -> go', forageBudget(16, 12, true).go === true, JSON.stringify(forageBudget(16, 12, true)));

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
