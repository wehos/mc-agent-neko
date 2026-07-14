// Offline regression for forageExplore pure gate/bearing. Run: node bots/_supervisor/test/forageExplore.test.mjs
import { exploreReady, exploreBearing } from '../skills/forageExplore.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

console.log('exploreReady (health-independent travel gate):');
const oldFoodInstincts = process.env.MC_FOOD_INSTINCTS;
delete process.env.MC_FOOD_INSTINCTS;
check('hp=3 -> GO when daylight/calm', exploreReady({ isNight: false, hp: 3, food: 10 }).ok === true);
check('night -> refuse', exploreReady({ isNight: true, hp: 20, food: 20 }).ok === false);
process.env.MC_FOOD_INSTINCTS = '1';
check('food=6 -> refuse (too low to travel far)', exploreReady({ isNight: false, hp: 20, food: 6 }).ok === false);
check('actionable close -> refuse', exploreReady({ isNight: false, hp: 20, food: 20, actionableClose: true }).ok === false);
check('healthy daylight -> GO', exploreReady({ isNight: false, hp: 20, food: 20 }).ok === true);
check('hp=14 food=10 boundary -> GO', exploreReady({ isNight: false, hp: 14, food: 10 }).ok === true);
if (oldFoodInstincts == null) delete process.env.MC_FOOD_INSTINCTS; else process.env.MC_FOOD_INSTINCTS = oldFoodInstincts;

console.log('exploreBearing (head away from death-zone):');
const b = exploreBearing({ x: 4, z: 3 }, { cx: -1, cz: -32 });
console.log('  ', JSON.stringify(b));
check('bearing points +x+z away from death-zone (-1,-32)', b.x > 0 && b.z > 0);
check('bearing is unit-ish', Math.abs(Math.hypot(b.x, b.z) - 1) < 0.01);
check('no dzone -> default +x', exploreBearing({ x: 0, z: 0 }, null).x === 1);

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
