// controlArbiter — the Arbiter wired toward DRIVING the bot (HANDOFF §4 control-runner).
//
// Builds on shadowArbiter: every tick it builds the WorldModel, runs the Arbiter, journals
// decision_trace.jsonl. NEW: it also detects an ACTIONABLE STALL (the bot pinned in the same
// spot+skill while the Arbiter says a mode that should be making progress / escaping) and, when
// run with --live, dispatches ONE narrow, well-tested action to break it. Without --live it is
// pure shadow: it logs "WOULD dispatch ..." and touches nothing.
//
// SAFETY: only the ESCAPE action is wired live so far, because escapePlan carries its own
// travel-budget + cellSafety guards and has broken a real livelock before. WORK-stall (the
// current food-desert / over-gated case) is logged but NOT auto-driven yet. We do not flip a risky action
// live just to look busy; an unfixed stall is logged honestly rather than poked recklessly.
//
// Run:  node bots/_supervisor/core/controlArbiter.mjs           (SHADOW — default, no control)
//       node bots/_supervisor/core/controlArbiter.mjs --live    (dispatch wired actions)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildWorldModel } from './worldModel.mjs';
import { arbitrate } from './arbiter.mjs';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACE = path.join(DIR, 'decision_trace.jsonl');
const INBOX = path.join(DIR, 'inbox.jsonl');
const LIVE = process.argv.includes('--live');
const POLL_MS = 15000;
const STALL_MS = 4 * 60 * 1000;        // pinned this long while Arbiter wants action = actionable stall
const DISPATCH_COOLDOWN_MS = 3 * 60 * 1000;

const rd = (n) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8')); } catch { return null; } };

// Map an Arbiter mode to a concrete supervised action. null = not yet safe to auto-drive.
function actionFor(mode, wm) {
    switch (mode) {
        case 'ESCAPE':
            // escapePlan self-guards (budget + lava + oxygen); proven to break a livelock.
            return { skill: 'escapePlan', args: [{ execute: true }] };
        case 'FORAGE':  // reserved — forage v2 budget-gated; wire once a forage MODE exists
            return null;
        case 'WORK':
            // Driving WORK = mine/gather. Logged, not driven. (next build)
            return null;
        default:
            return null;  // DEFEND/FLEE/EAT/SHELTER handled by tick reflexes + sticky skill for now
    }
}

let prev = null;            // previous Arbiter decision (for hysteresis)
let lastPos = null, lastSkill = null, pinnedSince = Date.now();
let lastDispatch = 0;

function step() {
    const now = Date.now();
    const vitals = rd('vitals.json');
    if (!vitals) return;
    const wm = buildWorldModel({ vitals, advisory: rd('advisory.json'), radar: rd('radar.json'), now, stalledMs: now - pinnedSince });

    // Track pinned duration (pos within 2 + same supervised skill).
    const pos = { x: vitals.x, z: vitals.z };
    if (!lastPos || Math.abs(pos.x - lastPos.x) > 2 || Math.abs(pos.z - lastPos.z) > 2 || vitals.skill !== lastSkill) {
        lastPos = pos; lastSkill = vitals.skill; pinnedSince = now;
    }
    const stalledMs = now - pinnedSince;

    const wm2 = { ...wm, progress: { stalledMs } };
    const dec = arbitrate(wm2, prev);
    prev = { mode: dec.mode, sinceTs: dec.sinceTs };

    const actionableStall = stalledMs >= STALL_MS && ['ESCAPE', 'WORK', 'FORAGE'].includes(dec.mode);
    const action = actionableStall ? actionFor(dec.mode, wm2) : null;

    const row = {
        ts: new Date(now).toISOString(), pos: wm.pos, hp: wm.hp, food: wm.food,
        arbiter: dec.mode, reason: dec.reason, actualSkill: vitals.skill || null,
        stalledMin: +(stalledMs / 60000).toFixed(1), actionableStall,
        action: action ? action.skill : null, live: LIVE,
    };
    fs.appendFileSync(TRACE, JSON.stringify(row) + '\n');

    if (actionableStall) {
        if (!action) {
            console.log(`[control ${row.ts.slice(11, 19)}] STALL ${row.stalledMin}min arbiter=${dec.mode} — NO wired safe action (logged, not driven)`);
        } else if (now - lastDispatch < DISPATCH_COOLDOWN_MS) {
            console.log(`[control] STALL arbiter=${dec.mode} action=${action.skill} — cooldown, skip`);
        } else if (!LIVE) {
            console.log(`[control SHADOW] WOULD dispatch ${action.skill} (arbiter=${dec.mode}, stalled ${row.stalledMin}min) — run with --live to enable`);
            lastDispatch = now;
        } else {
            // LIVE: cancel the stuck skill, then dispatch the action. Bridge re-arms sticky after.
            const ts = new Date(now).toISOString();
            fs.appendFileSync(INBOX, JSON.stringify({ type: 'cancel_skill', reason: `control: stall->${dec.mode}`, ts }) + '\n');
            fs.appendFileSync(INBOX, JSON.stringify({ skill: action.skill, args: action.args }) + '\n');
            console.log(`[control LIVE] dispatched ${action.skill} (arbiter=${dec.mode}, stalled ${row.stalledMin}min)`);
            lastDispatch = now;
        }
    }
}

console.log(`controlArbiter: ${LIVE ? 'LIVE (will dispatch wired actions)' : 'SHADOW (no control)'}, poll ${POLL_MS / 1000}s, stall>=${STALL_MS / 60000}min`);
step();
setInterval(step, POLL_MS);
