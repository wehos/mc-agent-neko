// Offline regression for mineDown pure geometry/safety. Run: node bots/_supervisor/test/mineDown.test.mjs
import { stairCells, stairSafety } from '../skills/mineDown.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

console.log('stairCells:');
const cells = stairCells({ x: 3, y: 80, z: 4 }, 1, 0, 5);
console.log('  ', JSON.stringify(cells));
check('5 cells', cells.length === 5);
check('descends 1 per step', cells.every((c, i) => c.y === 80 - (i + 1)));
check('advances on +x', cells[4].x === 8 && cells[4].z === 4);
check('last cell y=75', cells[4].y === 75);

console.log('stairSafety:');
check('lava near -> unsafe', stairSafety({ feet: 'stone', head: 'stone', floor: 'stone', lavaNear: true }).safe === false);
check('fluid in cell -> unsafe', stairSafety({ feet: 'lava', head: 'air', floor: 'stone' }).safe === false);
check('fluid under floor -> unsafe', stairSafety({ feet: 'air', head: 'air', floor: 'lava' }).safe === false);
check('bedrock -> unsafe', stairSafety({ feet: 'bedrock', head: 'air', floor: 'stone' }).safe === false);
check('plain stone -> safe', stairSafety({ feet: 'stone', head: 'stone', floor: 'stone', lavaNear: false }).safe === true);

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
