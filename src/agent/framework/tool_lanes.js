/**
 * Framework v2 — Tool exclusive lanes (blueprint part ③ + §F engineering lesson).
 *
 * WHY THIS EXISTS
 * ---------------
 * Fixed scripted actions (clutch water / MLG, block-bridging, instant bunker,
 * terrain traversal) are SUPPOSED to be foolproof but currently fail because
 * they run as bare async functions that any reflex / interrupt_code poll can
 * yank mid-step. This module gives such an action an EXCLUSIVE LANE:
 *
 *   • Uninterruptible: the lane's fn runs to completion WITHOUT checking
 *     bot.interrupt_code. That is the whole point — the script finishes.
 *   • Preempted only by a higher-priority MUTUALLY-EXCLUSIVE lane (e.g. clutch
 *     water for survival can preempt a dig). "A new exclusive tool always
 *     overrides the previous one" (blueprint §F).
 *   • Generous margins by default (blueprint §F: slower bridging, higher jump
 *     hang-time, post-place confirmation) — fault tolerance over speed.
 *
 * SINGLE-THREAD REALITY (docs/framework-v2-scaffold.md §1)
 * --------------------------------------------------------
 * Node + mineflayer are single-threaded; the bot object is not thread-safe.
 * "Exclusive thread pool" therefore = a cooperative mutex/scheduler on the main
 * event loop. Lanes serialize work that touches the bot. They do NOT create OS
 * threads. Pure computation (x-ray scan, route planning) belongs in a worker,
 * not here.
 *
 * PREEMPTION MODEL
 * ----------------
 * Each conflict domain (move/hand/place/window — see contracts.LANE_CONFLICT)
 * has at most one active holder. Acquiring a lane:
 *   1. Find conflicting active holders (share ≥1 domain).
 *   2. If any has >= priority → QUEUE (wait politely; we don't preempt equals/higher).
 *   3. Else (we outrank all conflicts) → signal preemption to each, take the domains.
 * A preempted lane's fn observes `signal.preempted === true` (cooperative: long
 * scripts may peek at ctx.preempted() to bail cleanly) and its run() rejects with
 * a LanePreempted error after the fn settles or the grace window elapses.
 */

import { LANE_PRIORITY, LANE_CONFLICT } from './contracts.js';

export class LanePreempted extends Error {
    constructor(lane, by) {
        super(`lane ${lane} preempted by ${by}`);
        this.name = 'LanePreempted';
        this.lane = lane;
        this.by = by;
    }
}

/** Does lane `a` preempt lane `b`? Higher priority AND a shared conflict domain. */
export function preempts(a, b) {
    if (a === b) return false;
    const pa = LANE_PRIORITY[a] ?? 0;
    const pb = LANE_PRIORITY[b] ?? 0;
    if (pa <= pb) return false;
    const da = LANE_CONFLICT[a] || [];
    const db = LANE_CONFLICT[b] || [];
    return da.some(d => db.includes(d));
}

/** Do two lanes contend at all (share a conflict domain)? */
function contends(a, b) {
    if (a === b) return true;
    const da = LANE_CONFLICT[a] || [];
    const db = LANE_CONFLICT[b] || [];
    return da.some(d => db.includes(d));
}

/**
 * One running lane occupancy. `ctx` is handed to the fn so a long script can
 * cooperatively check `ctx.preempted()` and bail at a safe point.
 */
class LaneHolder {
    constructor(laneClass, label) {
        this.lane = laneClass;
        this.label = label || laneClass;
        this.startedAt = Date.now();
        this._preempted = false;
        this._preemptedBy = null;
        this._donePromise = new Promise((res) => { this._resolveDone = res; });
    }
    markPreempted(by) {
        if (this._preempted) return;
        this._preempted = true;
        this._preemptedBy = by;
    }
    /** Cooperative check for long scripts: `if (ctx.preempted()) return;` */
    preempted() { return this._preempted; }
}

export class ToolLaneManager {
    constructor(bot, opts = {}) {
        this.bot = bot;
        /** @type {Map<string, LaneHolder>} active holders keyed by laneClass */
        this.active = new Map();
        this.log = opts.log || (() => {});
        // grace window: how long we wait for a preempted fn to settle before we
        // forcibly reject its run() and let the preemptor proceed. Generous so the
        // preempted script can clean up (e.g. retract water).
        this.preemptGraceMs = opts.preemptGraceMs ?? 1500;
        this.history = []; // ring buffer of recent lane events (telemetry)
    }

    _record(ev) {
        this.history.push({ t: Date.now(), ...ev });
        if (this.history.length > 200) this.history.shift();
    }

    /** Snapshot for telemetry / world_model.json. */
    snapshot() {
        const out = {};
        for (const [lane, h] of this.active) out[lane] = { label: h.label, ms: Date.now() - h.startedAt, preempted: h._preempted };
        return out;
    }

    /**
     * Run `fn` on an exclusive lane. Resolves with fn's return; rejects with
     * LanePreempted if a higher-priority conflicting lane takes over, or with
     * fn's own error.
     *
     * @param {import('./contracts.js').LaneClass} laneClass
     * @param {(ctx:{preempted:()=>boolean, bot:any})=>Promise<any>} fn
     * @param {import('./contracts.js').LaneRunOpts} [opts]
     */
    async runExclusive(laneClass, fn, opts = {}) {
        if (!(laneClass in LANE_PRIORITY)) {
            throw new Error(`unknown lane class: ${laneClass}`);
        }
        const label = opts.label || laneClass;

        // 1) Resolve contention. Block (queue) while a conflicting holder we do
        //    NOT outrank is active. Preempt the ones we do outrank.
        // Loop because while we await a settle, the field can change.
        for (let guard = 0; guard < 1000; guard++) {
            const blockers = [];
            const preemptable = [];
            for (const [otherLane, holder] of this.active) {
                if (!contends(laneClass, otherLane)) continue;
                if (preempts(laneClass, otherLane)) preemptable.push(holder);
                else blockers.push(holder); // equal or higher prio → we wait
            }
            if (blockers.length === 0) {
                // We outrank (or don't conflict with) everything active → preempt & go.
                for (const h of preemptable) {
                    h.markPreempted(label);
                    this._record({ ev: 'preempt', lane: h.lane, by: label });
                    this.log(`[tool_lanes] ${label} preempts ${h.lane} (${h.label})`);
                }
                break;
            }
            // Wait for the nearest blocker to finish, then re-evaluate.
            this._record({ ev: 'queue', lane: laneClass, behind: blockers.map(b => b.lane) });
            await Promise.race(blockers.map(b => b._donePromise)).catch(() => {});
        }

        // 2) Take the lane.
        const holder = new LaneHolder(laneClass, label);
        this.active.set(laneClass, holder);
        this._record({ ev: 'acquire', lane: laneClass, label });

        const ctx = { preempted: () => holder.preempted(), bot: this.bot };

        // 3) Run fn, racing against (a) preemption grace and (b) optional timeout.
        let timeoutHandle = null, graceHandle = null;
        try {
            const racers = [Promise.resolve().then(() => fn(ctx))];
            if (opts.timeoutMs) {
                racers.push(new Promise((_, rej) => {
                    timeoutHandle = setTimeout(() => rej(new Error(`lane ${laneClass} timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
                }));
            }
            // Preemption: once marked, give the fn a grace window to settle, then bail.
            racers.push(new Promise((_, rej) => {
                const check = () => {
                    if (holder._preempted) {
                        graceHandle = setTimeout(() => rej(new LanePreempted(laneClass, holder._preemptedBy)), this.preemptGraceMs);
                    } else if (this.active.get(laneClass) === holder) {
                        graceHandle = setTimeout(check, 100);
                    }
                };
                check();
            }));
            const result = await Promise.race(racers);
            return result;
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (graceHandle) clearTimeout(graceHandle);
            if (this.active.get(laneClass) === holder) this.active.delete(laneClass);
            holder._resolveDone();
            this._record({ ev: 'release', lane: laneClass, label, ms: Date.now() - holder.startedAt, preempted: holder._preempted });
        }
    }

    /** Is a lane (or any lane in its conflict domain) currently held? */
    isBusy(laneClass) {
        if (this.active.has(laneClass)) return true;
        for (const other of this.active.keys()) if (contends(laneClass, other)) return true;
        return false;
    }
}

/** Get-or-create the per-bot lane manager. */
export function getLaneManager(bot, opts) {
    if (!bot._toolLanes) bot._toolLanes = new ToolLaneManager(bot, opts);
    return bot._toolLanes;
}
