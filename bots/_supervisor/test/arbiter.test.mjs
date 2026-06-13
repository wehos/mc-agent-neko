// Offline regression test for the WorldModel + Arbiter refactor core.
// Run: node bots/_supervisor/test/arbiter.test.mjs
// Zero live risk — pure functions, no bot. Proves the Arbiter breaks the livelock that the
// patch layers (C42–C207) sat in for hours.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildWorldModel } from '../core/worldModel.mjs';
import { arbitrate, MODES } from '../core/arbiter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}
const NOW = 1781347510378; // fixed clock (pure: never call Date.now in tests)

// ---- Case 1: THE livelock fixture -> must choose ESCAPE, not WORK/hold -----
{
    const fx = JSON.parse(readFileSync(path.join(here, 'fixtures', 'livelock-9-52-11.json'), 'utf8'));
    const wm = buildWorldModel({
        vitals: fx.vitals,
        advisory: { ...fx.advisory, mobs: fx.mobs, ts: NOW },
        now: NOW,
        stalledMs: 2 * 60 * 60 * 1000, // bot held here 2h+
    });
    const dec = arbitrate(wm, null);
    console.log('\nCase 1 — livelock fixture (the 2h hold):');
    console.log('  worldModel.paralysis:', JSON.stringify(wm.paralysis));
    console.log('  worldModel.threat:', JSON.stringify(wm.threat));
    console.log('  decision:', JSON.stringify(dec));
    check('mode is ESCAPE (patch layers chose HOLD here)', dec.mode === 'ESCAPE', `got ${dec.mode}`);
    check('paralysis.starving true', wm.paralysis.starving === true);
    check('paralysis.trappedInDeathZone true', wm.paralysis.trappedInDeathZone === true);
    check('insideDeathZone true', wm.insideDeathZone === true);
    check('threat.actionableClose false (mobs far/layered)', wm.threat.actionableClose === false);
    check('hasEdible false (only materials in inv)', wm.hasEdible === false);
}

// ---- Case 2: priority ordering -------------------------------------------
function wmOf(over) {
    return buildWorldModel({
        vitals: { x: 0, y: 64, z: 0, hp: 18, food: 18, tod: 6000, mob: 'FREE', inv: {}, ...(over.vitals || {}) },
        advisory: { ts: NOW, actionableHostiles: 0, actionableNearest: null, nearest: null, mobs: [], dzone: null, ...(over.advisory || {}) },
        now: NOW,
        stalledMs: over.stalledMs || 0,
        hasEdible: over.hasEdible,
    });
}
{
    console.log('\nCase 2 — priority ordering:');
    // Armored close threat -> DEFEND (can survive the trade). Beats starving.
    const defend = arbitrate(wmOf({ advisory: { actionableHostiles: 1, actionableNearest: 3.5, mobs: [{ name: 'zombie', d: 3.5, actionable: true }] }, vitals: { food: 4, inv: { iron_chestplate: 1, iron_helmet: 1 } } }), null);
    check('ARMORED close actionable -> DEFEND (beats starving)', defend.mode === 'DEFEND', `got ${defend.mode}`);

    // UNARMORED close threat -> FLEE (the #1 death cause: don't trade hits naked).
    const naked = arbitrate(wmOf({ advisory: { actionableHostiles: 1, actionableNearest: 3.5, mobs: [{ name: 'zombie', d: 3.5, actionable: true }] }, vitals: { food: 18, inv: {} } }), null);
    check('UNARMORED close actionable -> FLEE (no naked zombie-trading)', naked.mode === 'FLEE', `got ${naked.mode}`);

    const flee = arbitrate(wmOf({ advisory: { actionableHostiles: 4, actionableNearest: 9, mobs: [] } }), null);
    check('many actionable closing -> FLEE', flee.mode === 'FLEE', `got ${flee.mode}`);

    const eat = arbitrate(wmOf({ vitals: { food: 4 }, hasEdible: true }), null);
    check('low food + has edible -> EAT', eat.mode === 'EAT', `got ${eat.mode}`);

    const escape = arbitrate(wmOf({ vitals: { food: 4 }, hasEdible: false }), null);
    check('low food + no edible -> ESCAPE', escape.mode === 'ESCAPE', `got ${escape.mode}`);

    const shelter = arbitrate(wmOf({ vitals: { tod: 18000, mob: 'FREE' }, advisory: { mobs: [{ name: 'zombie', d: 14 }], actionableHostiles: 0 } }), null);
    check('night + exposed + hostiles -> SHELTER', shelter.mode === 'SHELTER', `got ${shelter.mode}`);

    const work = arbitrate(wmOf({}), null);
    check('healthy daylight -> WORK', work.mode === 'WORK', `got ${work.mode}`);
}

// ---- Case 3: hysteresis — a 1-tick threat flicker doesn't yank a fresh mode --
{
    console.log('\nCase 3 — hysteresis:');
    // We just entered DEFEND 5s ago; the threat momentarily reads as gone (raw=WORK), but
    // DEFEND is still valid (actionableClose) -> hold DEFEND, don't flap to WORK.
    const ARMORED = { iron_chestplate: 1, iron_helmet: 1, iron_sword: 1 };
    const prev = { mode: 'DEFEND', sinceTs: NOW - 5000 };
    const wmStillThreat = wmOf({ advisory: { actionableHostiles: 1, actionableNearest: 5, mobs: [{ name: 'zombie', d: 5, actionable: true }] }, vitals: { inv: ARMORED } });
    const held = arbitrate(wmStillThreat, prev);
    check('recently-entered DEFEND holds (no chatter)', held.mode === 'DEFEND', `got ${held.mode}`);

    // After the threat truly evaporates AND dwell elapsed, it releases to WORK.
    const prevOld = { mode: 'DEFEND', sinceTs: NOW - 30000 };
    const wmClear = wmOf({ vitals: { inv: ARMORED } });
    const released = arbitrate(wmClear, prevOld);
    check('stale DEFEND with no threat releases to WORK', released.mode === 'WORK', `got ${released.mode}`);

    // Higher-priority always preempts immediately, even within dwell (armored -> DEFEND).
    const prevWork = { mode: 'WORK', sinceTs: NOW - 1000 };
    const wmDanger = wmOf({ advisory: { actionableHostiles: 1, actionableNearest: 3, mobs: [{ name: 'creeper', d: 3, actionable: true }] }, vitals: { inv: ARMORED } });
    const preempt = arbitrate(wmDanger, prevWork);
    check('higher-priority DEFEND preempts fresh WORK immediately', preempt.mode === 'DEFEND', `got ${preempt.mode}`);
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
