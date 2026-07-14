// arbiter — the ONE decision-maker (HANDOFF.md §4).
//
// WHY
// The patch-route disease in one sentence: N layers each made a LOCAL, defensible "hold vs
// move" judgment, and nothing owned the GLOBAL objective "make mission progress while
// staying alive." So the local judgments unanimously chose HOLD and the bot livelocked at
// food=4 for hours — every layer locally correct, the emergent whole catastrophic.
//
// The Arbiter replaces that with a SINGLE pure function that reads the one WorldModel and
// picks ONE mode from a small, totally-ordered set. It is the only thing allowed to own the
// "you've been stuck too long — override the holds and ESCAPE" judgment that no patch layer
// had. Hysteresis stops it flip-flopping; every decision is journaled to decision_trace.jsonl
// so the exact (worldModel -> mode) mapping is replayable offline and regression-tested.
//
// arbitrate() is PURE: (worldModel, prevDecision) -> decision. No I/O, no clock. The shadow
// runner does the journaling and the (eventual) body handoff; the Arbiter only decides.

// Modes, highest priority first. Priority is the backbone of conflict resolution: a
// higher-priority mode always preempts a lower one; equal/lower needs hysteresis to switch.
export const MODES = {
    DEFEND:  { p: 6, desc: 'actionable hostile in melee range — fight or active-kite' },
    FLEE:    { p: 5, desc: 'overwhelmed — disengage and sprint to safety' },
    EAT:     { p: 4, desc: 'food low and an edible is in inventory — consume now' },
    ESCAPE:  { p: 3, desc: 'paralyzed (starving+no food / trapped / long stall) — relocate out' },
    SHELTER: { p: 2, desc: 'night and exposed with no safe hold — bunker until dawn' },
    WORK:    { p: 1, desc: 'productive default — mission / prep / gather' },
};

const MIN_DWELL_MS = 20 * 1000;   // don't abandon a mode you just entered for <20s (anti-chatter)

function decide(wm) {
    const t = wm.threat || {};
    const par = wm.paralysis || {};

    // 6/5) Close actionable threat. WHO owns the body depends on whether we can survive the
    // trade. The #1 death cause is fighting zombies UNARMORED — so a naked bot (no armor, no
    // shield) must DISENGAGE (FLEE), not stand and trade hits. Only fight when we have some
    // protection. Health alone never changes ownership of the body.
    const def = wm.defense || {};
    if (t.actionableClose || t.overwhelmed) {
        if (def.weakDefense) {
            return { mode: 'FLEE', reason: `close threat nearest=${t.actionableNearest} but UNARMORED (armor=0,shield=${!!def.hasShield}) — disengage, don't trade hits` };
        }
        if (t.overwhelmed) {
            return { mode: 'FLEE', reason: `overwhelmed: ${t.actionableCount} actionable, nearest=${t.actionableNearest}` };
        }
        return { mode: 'DEFEND', reason: `actionable hostile nearest=${t.actionableNearest} <=8 (armor=${def.armorItems},shield=${!!def.hasShield})` };
    }
    // 4) EAT — if hungry AND we actually have food, eating dominates everything below combat.
    if (wm.food <= (wm.constants?.LOW_FOOD ?? 6) && wm.hasEdible) {
        return { mode: 'EAT', reason: `food=${wm.food} low and hasEdible — consume` };
    }
    // 3) ESCAPE — THE livelock-breaker. Paralysis is a first-class state, not "safe holding".
    //    This is the judgment the patch layers structurally could not make: a low-food/no-food
    //    bot, or one trapped in its death-zone with no progress, must RELOCATE, not hold forever.
    if (par.starving || par.trappedInDeathZone || par.longStall) {
        const why = [
            par.starving && `starving(food=${wm.food},no edible)`,
            par.trappedInDeathZone && `trapped in death-zone ${Math.round((wm.progress.stalledMs || 0) / 1000)}s`,
            par.longStall && `long stall ${Math.round((wm.progress.stalledMs || 0) / 1000)}s`,
        ].filter(Boolean).join(' + ');
        return { mode: 'ESCAPE', reason: why };
    }
    // 2) SHELTER — night + exposed (not enclosed) with hostiles around: bunker rather than work.
    if (wm.isNight && !wm.mobility?.enclosed && (t.count > 0)) {
        return { mode: 'SHELTER', reason: `night, exposed (not enclosed), ${t.count} hostiles near` };
    }
    // 1) WORK — nothing is wrong; make progress.
    return { mode: 'WORK', reason: 'no blocker — make mission progress' };
}

/**
 * Pick the controlling mode. PURE.
 * @param {object} wm   the WorldModel from buildWorldModel()
 * @param {object} prev previous decision {mode, sinceTs} | null
 * @returns {{mode,reason,priority,changedFrom,heldByHysteresis,sinceTs}}
 */
export function arbitrate(wm, prev) {
    const raw = decide(wm);
    const now = wm.ts || 0;
    const prevMode = prev && prev.mode;
    const prevSince = (prev && prev.sinceTs) || 0;

    let mode = raw.mode;
    let heldByHysteresis = false;

    // Hysteresis: if the raw pick is LOWER priority than the mode we're currently in, and we
    // entered the current mode recently (< MIN_DWELL), stay put — unless the current mode's
    // own trigger has clearly lapsed. This prevents 1-tick threat flickers from yanking the
    // bot between DEFEND/WORK every cycle (a failure mode the raw patch layers showed often).
    if (prevMode && prevMode !== raw.mode) {
        const rawP = MODES[raw.mode].p, prevP = MODES[prevMode].p;
        const dwell = now - prevSince;
        if (rawP < prevP && dwell < MIN_DWELL_MS && stillValid(prevMode, wm)) {
            mode = prevMode;
            heldByHysteresis = true;
        }
    }

    return {
        mode,
        reason: heldByHysteresis ? `hold ${mode} (hysteresis ${Math.round((now - prevSince) / 1000)}s<${MIN_DWELL_MS / 1000}s; raw=${raw.mode}:${raw.reason})` : raw.reason,
        priority: MODES[mode].p,
        rawMode: raw.mode,
        changedFrom: (prevMode && prevMode !== mode) ? prevMode : null,
        heldByHysteresis,
        sinceTs: (prevMode === mode) ? prevSince : now,
    };
}

// Is the mode we're currently in still even applicable? Used so hysteresis never pins a mode
// whose premise has fully evaporated (e.g. DEFEND when the hostile is long gone).
function stillValid(mode, wm) {
    const t = wm.threat || {};
    switch (mode) {
        case 'DEFEND': return t.actionableClose;
        case 'FLEE': return t.overwhelmed;
        case 'EAT': return wm.food <= (wm.constants?.LOW_FOOD ?? 6) && wm.hasEdible;
        case 'ESCAPE': return wm.paralysis?.starving || wm.paralysis?.trappedInDeathZone || wm.paralysis?.longStall;
        case 'SHELTER': return wm.isNight;
        default: return true;
    }
}
