/**
 * Framework v2 — Clutch water / MLG (blueprint §E.2, "highest DNA").
 *
 *   "Always ensure a bucket + water in hand; when fall damage would occur, place
 *    clutch water at script level, and ALWAYS remember to retract the water.
 *    Exception: don't place when there is lava below."
 *
 * This runs on the SURVIVAL_MLG lane (priority 100) — it preempts ANY conflicting
 * lane (dig/locomotion/placement) because surviving the fall comes first. It is
 * uninterruptible: once we commit to the clutch, we see it through AND retract.
 *
 * GENEROUS MARGINS (blueprint §F): we arm early (trigger at a conservative fall
 * distance), look straight down well before impact, and retract only after the
 * bot is verified settled — fault tolerance over optimality.
 *
 * LIVE-VALIDATION NOTE: in-game placement timing (the exact tick to activateItem
 * while falling) can only be tuned against a running server. The control flow
 * here — arm → lava-guard → place → settle → ALWAYS retract — is unit-tested with
 * a mock bot; the falsifiable in-game prediction is logged in CHANGELOG C275.
 */

import { LANE } from '../contracts.js';
import { getLaneManager } from '../tool_lanes.js';
import { canClutchWater } from './lava_guard.js';

const PITCH_DOWN = Math.PI / 2;          // look straight down
const ARM_FALL_BLOCKS = 4;               // start clutch when ≥4 blocks above landing (fall dmg starts >3)
const PLACE_WINDOW_BLOCKS = 3;           // place water when within this many blocks of impact
const MAX_CLUTCH_MS = 6000;              // hard ceiling for the whole clutch

function hasItem(bot, name) {
    try { return bot.inventory.findInventoryItem(name) || null; } catch (e) { return null; }
}

/** Are we in a fall that warrants a clutch right now? */
export function fallImminent(bot) {
    try {
        const e = bot.entity;
        if (!e || e.onGround) return false;
        const vy = e.velocity ? e.velocity.y : 0;
        if (vy > -0.35) return false;                 // not falling fast enough yet
        const lb = canClutchWater(bot).landing;
        return lb && Number.isFinite(lb.dist) && lb.dist >= ARM_FALL_BLOCKS;
    } catch (e) { return false; }
}

/**
 * Perform the clutch. Acquires the SURVIVAL_MLG lane (preempts dig/move), places
 * water on the landing spot, waits for the bot to settle, then ALWAYS retracts.
 * Returns {placed, retracted, reason}.
 */
export async function clutchWater(bot, opts = {}) {
    const lm = getLaneManager(bot, { log: opts.log });
    return lm.runExclusive(LANE.SURVIVAL_MLG, (ctx) => _clutch(bot, ctx, opts), {
        label: 'clutch-water',
        timeoutMs: opts.timeoutMs || MAX_CLUTCH_MS,
        generous: true,
    });
}

async function _clutch(bot, ctx, opts) {
    const log = opts.log || (() => {});
    // 1) Lava guard FIRST — never place over lava (blueprint §E.2 exception).
    const guard = canClutchWater(bot);
    if (!guard.ok) {
        log(`[mlg] no clutch: ${guard.reason}`);
        return { placed: false, retracted: false, reason: guard.reason };
    }
    // 2) Need a water bucket. (Empty bucket can't clutch.)
    const water = hasItem(bot, 'water_bucket');
    if (!water) {
        log('[mlg] no water_bucket in inventory — cannot clutch');
        return { placed: false, retracted: false, reason: 'no water_bucket' };
    }

    // 3) Approach impact: look down, and wait until within the place window. We
    //    do NOT honor interrupt_code here (uninterruptible lane) but we DO bail if
    //    a higher-priority lane preempts us (ctx.preempted()).
    try { await bot.look(bot.entity.yaw, PITCH_DOWN, true); } catch (e) {}
    const start = Date.now();
    while (Date.now() - start < (opts.timeoutMs || MAX_CLUTCH_MS)) {
        if (ctx.preempted()) return { placed: false, retracted: false, reason: 'preempted' };
        const e = bot.entity;
        if (!e) break;
        if (e.onGround) break; // already landed (e.g. shallow) — skip placing
        const lb = canClutchWater(bot);
        if (!lb.ok) return { placed: false, retracted: false, reason: 'lava entered window' };
        if (lb.landing && lb.landing.dist <= PLACE_WINDOW_BLOCKS) break;
        await sleep(30);
    }

    // 4) Place the water (equip → activate). Fire even if we just touched ground a
    //    tick ago — a redundant placement is harmless and we retract anyway.
    let placed = false;
    try {
        await equipHand(bot, 'water_bucket');
        await bot.look(bot.entity.yaw, PITCH_DOWN, true);
        await bot.activateItem();         // places water on the block we're looking at (below)
        placed = true;
        log('[mlg] clutch water placed');
    } catch (e) {
        log(`[mlg] place failed: ${e && e.message}`);
    }

    // 5) Settle: wait until on ground / in water, with a generous window.
    const settleStart = Date.now();
    while (Date.now() - settleStart < 2500) {
        const e = bot.entity;
        if (e && (e.onGround || /water/.test((bot.blockAt(e.position) || {}).name || ''))) break;
        await sleep(40);
    }

    // 6) ALWAYS retract (blueprint: "永远记得收回水"). Even on preemption we try —
    //    leaving water behind floods the worksite. Retract = equip empty bucket,
    //    look at the water source, activate.
    const retracted = await retractWater(bot, log);
    return { placed, retracted, reason: placed ? 'clutched' : 'no-place' };
}

/**
 * Pick the water source back up. Best-effort: looks down at the placed water and
 * activates an empty bucket. Safe to call even if no water is there.
 */
export async function retractWater(bot, log = () => {}) {
    try {
        const bucket = hasItem(bot, 'bucket');
        if (!bucket) { log('[mlg] no empty bucket to retract with'); return false; }
        await equipHand(bot, 'bucket');
        await bot.look(bot.entity.yaw, PITCH_DOWN, true);
        // Aim slightly below feet where the clutch water sits.
        const p = bot.entity.position;
        try { await bot.lookAt(p.offset(0, -1, 0)); } catch (e) {}
        await bot.activateItem();
        log('[mlg] water retracted');
        return true;
    } catch (e) {
        log(`[mlg] retract failed: ${e && e.message}`);
        return false;
    }
}

// ── helpers (kept local so this tool has no skills.js dependency) ──
async function equipHand(bot, name) {
    const item = hasItem(bot, name);
    if (!item) throw new Error(`missing ${name}`);
    await bot.equip(item, 'hand');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
