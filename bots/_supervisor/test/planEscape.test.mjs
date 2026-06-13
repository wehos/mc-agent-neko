// Offline regression test for the pure planEscape() decision function.
// Run: node bots/_supervisor/test/planEscape.test.mjs
// Zero live risk — no bot, no I/O. Proves the planner breaks the livelock fixture.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { planEscape, tunnelPath, cellSafety } from '../skills/escapePlan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

// ---- Case 1: the captured live livelock -----------------------------------
{
    const fx = JSON.parse(readFileSync(path.join(here, 'fixtures', 'livelock-9-52-11.json'), 'utf8'));
    const state = {
        pos: { x: fx.vitals.x, y: fx.vitals.y, z: fx.vitals.z },
        hostiles: fx.mobs,
        dzone: fx.advisory.dzone,
        food: fx.vitals.food,
        hp: fx.vitals.hp,
        hasPickaxe: /pickaxe/.test(fx.vitals.held) || (fx.vitals.inv && fx.vitals.inv.iron_pickaxe > 0),
        hasEdible: false,
        tod: fx.vitals.tod,
    };
    const plan = planEscape(state);
    console.log('\nCase 1 — livelock-9-52-11:');
    console.log('  plan:', JSON.stringify(plan));
    check('action is relocate_surface', plan.action === 'relocate_surface', `got ${plan.action}`);
    check('heading x is positive (away from death-zone & mob cluster, east)', plan.heading && plan.heading.x > 0, JSON.stringify(plan.heading));
    check('heading z is positive (north-east, away from SW trap)', plan.heading && plan.heading.z > 0, JSON.stringify(plan.heading));
    check('target moves away from death-zone center', plan.target && Math.hypot(plan.target.x - fx.advisory.dzone.cx, plan.target.z - fx.advisory.dzone.cz) > Math.hypot(fx.vitals.x - fx.advisory.dzone.cx, fx.vitals.z - fx.advisory.dzone.cz), JSON.stringify(plan.target));
    check('flags.starving true', plan.flags && plan.flags.starving === true);
    check('flags.insideDeathZone true', plan.flags && plan.flags.insideDeathZone === true);
    check('waypoints chained (>=3 legs of <=12b)', plan.waypoints && plan.waypoints.length >= 3, `${plan.waypoints && plan.waypoints.length} legs`);
    check('flags.night false (tod=2413 is day)', plan.flags && plan.flags.night === false);
}

// ---- Case 2: actionable hostile in melee range -> defer to combat ----------
{
    const plan = planEscape({
        pos: { x: 0, y: 64, z: 0 },
        hostiles: [{ name: 'zombie', x: 3, y: 64, z: 2, d: 3.6, actionable: true }],
        dzone: { cx: 0, cz: 0, r: 28, n: 10 },
        food: 4, hp: 12, hasPickaxe: true, hasEdible: false, tod: 1000,
    });
    console.log('\nCase 2 — close actionable hostile:');
    console.log('  plan:', JSON.stringify(plan));
    check('action is defer (does not override combat/flee)', plan.action === 'defer', `got ${plan.action}`);
}

// ---- Case 3: well-fed, not in death-zone -> no escape needed ---------------
{
    const plan = planEscape({
        pos: { x: 200, y: 70, z: 200 },
        hostiles: [],
        dzone: { cx: 0, cz: 0, r: 28, n: 10 },
        food: 18, hp: 20, hasPickaxe: true, hasEdible: true, tod: 6000,
    });
    console.log('\nCase 3 — healthy, far from trap:');
    console.log('  plan:', JSON.stringify(plan));
    check('action is none', plan.action === 'none', `got ${plan.action}`);
}

// ---- Case 4: has edible food while low -> eat, not relocate ----------------
{
    const plan = planEscape({
        pos: { x: 5, y: 50, z: 5 },
        hostiles: [], dzone: null,
        food: 4, hp: 15, hasPickaxe: true, hasEdible: true, tod: 1000,
    });
    console.log('\nCase 4 — low food but HAS edible:');
    console.log('  plan:', JSON.stringify(plan));
    check('action is none (eat instead of relocate)', plan.action === 'none', `got ${plan.action}`);
}

// ---- Case 5: tunnelPath geometry (the dig executor's cell sequence) --------
{
    console.log('\nCase 5 — tunnelPath ENE heading:');
    const heading = { x: 0.72, z: 0.69 };
    const cells = tunnelPath({ x: 9, y: 52, z: -11 }, heading, 20);
    console.log('  first 4 cells:', JSON.stringify(cells.slice(0, 4)));
    console.log('  last cell:', JSON.stringify(cells[cells.length - 1]));
    check('produces 20 cells', cells.length === 20, `${cells.length}`);
    check('every cell stays at feet y=52', cells.every(c => c.y === 52));
    check('each step moves exactly 1 block (no teleport/no stall)', cells.every((c, i) => {
        const prev = i === 0 ? { x: 9, z: -11 } : cells[i - 1];
        const d = Math.abs(c.x - prev.x) + Math.abs(c.z - prev.z);
        return d === 1 || d === 2; // 1 (axis) or 2 (diagonal step)
    }));
    check('net heading is +x+z (ENE)', cells[cells.length - 1].x > 9 && cells[cells.length - 1].z > -11);
}

// ---- Case 6: cellSafety lava/floor gating ---------------------------------
{
    console.log('\nCase 6 — cellSafety:');
    check('lava adjacent -> unsafe', cellSafety({ feet: 'stone', head: 'stone', floor: 'stone', lavaAdjacent: true }).safe === false);
    check('dig cell is lava -> unsafe', cellSafety({ feet: 'lava', head: 'air', floor: 'stone', lavaAdjacent: false }).safe === false);
    check('floor is lava -> unsafe', cellSafety({ feet: 'air', head: 'air', floor: 'lava', lavaAdjacent: false }).safe === false);
    check('bedrock head -> unsafe', cellSafety({ feet: 'stone', head: 'stone', floor: 'stone', lavaAdjacent: false, headUnbreakable: true }).safe === false);
    const ok = cellSafety({ feet: 'stone', head: 'stone', floor: 'stone', lavaAdjacent: false });
    check('solid stone cell with solid floor -> safe, no floor needed', ok.safe === true && ok.needFloor === false);
    const gap = cellSafety({ feet: 'stone', head: 'stone', floor: 'cave_air', lavaAdjacent: false });
    check('air floor -> safe but needFloor (place cobble)', gap.safe === true && gap.needFloor === true);
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
