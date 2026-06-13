// shadowArbiter — runs the WorldModel + Arbiter against LIVE telemetry, READ-ONLY.
//
// "影子模式先行" (HANDOFF.md §4 migration): before the Arbiter is ever allowed to touch the
// body, we run it in the shadows next to the live patch-era layers and journal, every tick,
// what it WOULD have decided vs what the bot is ACTUALLY doing. Divergences are the evidence
// that the refactor changes behavior for the better (or surfaces a bug) — captured offline,
// with zero risk to the running bot.
//
// It only READS vitals.json / advisory.json / radar.json / status.json (already maintained by
// the existing system) and APPENDS to decision_trace.jsonl. It sends NO control, runs NO skill,
// never writes inbox/sticky. Safe to start and stop at any time.
//
// Run:  node bots/_supervisor/core/shadowArbiter.mjs           (default 10s cadence)
//       node bots/_supervisor/core/shadowArbiter.mjs 5         (5s cadence)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildWorldModel } from './worldModel.mjs';
import { arbitrate } from './arbiter.mjs';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACE = path.join(DIR, 'decision_trace.jsonl');
const CADENCE_S = Math.max(2, parseInt(process.argv[2] || '10', 10));

function readJson(name) {
    try { return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')); } catch { return null; }
}

// Position-change tracking for stalledMs (the patch layers never measured "how long since the
// body actually moved" as a first-class signal; the Arbiter needs it to detect paralysis).
let lastMovePos = null, lastMoveTs = Date.now();
function updateStall(pos, now) {
    if (!lastMovePos || Math.hypot(pos.x - lastMovePos.x, pos.z - lastMovePos.z) > 2 || Math.abs(pos.y - lastMovePos.y) > 2) {
        lastMovePos = { ...pos }; lastMoveTs = now;
    }
    return now - lastMoveTs;
}

let prevDecision = null;
let lastLoggedMode = null;
let tick = 0;

function step() {
    const now = Date.now();
    const vitals = readJson('vitals.json');
    if (!vitals) return; // no live telemetry yet
    const advisory = readJson('advisory.json');
    const radar = readJson('radar.json');
    const status = readJson('status.json');

    const pos = { x: vitals.x | 0, y: vitals.y | 0, z: vitals.z | 0 };
    const stalledMs = updateStall(pos, now);

    const wm = buildWorldModel({ vitals, advisory, radar, now, stalledMs });
    const decision = arbitrate(wm, prevDecision);
    prevDecision = { mode: decision.mode, sinceTs: decision.sinceTs };

    const actualSkill = vitals.skill || (status && status.lastEvent && status.lastEvent.skill) || null;
    // The headline comparison: what the Arbiter WOULD run vs what the patch layers ARE running.
    const diverges = modeVsSkill(decision.mode, actualSkill, wm);

    const row = {
        ts: new Date(now).toISOString(),
        tick: tick++,
        pos, hp: wm.hp, food: wm.food, tod: wm.tod, night: wm.isNight,
        mob: vitals.mob || null, stalledS: Math.round(stalledMs / 1000),
        arbiter: decision.mode,
        arbiterReason: decision.reason,
        actualSkill,
        diverges,
        threat: { actionable: wm.threat.actionableCount, nearest: wm.threat.nearest, close: wm.threat.actionableClose },
        paralysis: wm.paralysis,
        insideDeathZone: wm.insideDeathZone,
    };
    fs.appendFileSync(TRACE, JSON.stringify(row) + '\n');

    if (decision.mode !== lastLoggedMode || tick % 6 === 0) {
        lastLoggedMode = decision.mode;
        const flag = diverges ? '  ⚠ DIVERGES' : '';
        console.log(`[shadow ${row.ts}] arbiter=${decision.mode} actual=${actualSkill || '-'} food=${wm.food} hp=${wm.hp} stall=${row.stalledS}s${flag}  :: ${decision.reason}`);
    }
}

// Heuristic: does the Arbiter's mode conflict with what the bot is actually doing? The most
// important divergence is ESCAPE-vs-holding: Arbiter says relocate, but the bot is sitting in
// missionNether's KILL-BOX hold (the livelock). That's the signal the refactor would change.
function modeVsSkill(mode, skill, wm) {
    if (mode === 'ESCAPE' && (skill === 'missionNether' || skill === 'prepNether') && (wm.progress.stalledMs || 0) > 4 * 60 * 1000) return true;
    if (mode === 'EAT' && wm.food <= 6 && skill && /mission|prep|branchMine|achieve/.test(skill)) return true;
    return false;
}

console.log(`shadowArbiter: READ-ONLY shadow run, cadence=${CADENCE_S}s, trace -> ${TRACE}`);
console.log('Sends NO control. Ctrl-C to stop.\n');
step();
setInterval(step, CADENCE_S * 1000);
