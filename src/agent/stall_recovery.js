export const STALL_INTENT = Object.freeze({
    MOVE: 'MOVE',
    DIG: 'DIG',
    INTERACT: 'INTERACT',
    WAIT: 'WAIT',
    HOLD: 'HOLD',
    WORK: 'WORK',
    COMBAT: 'COMBAT',
    TRANSITION: 'TRANSITION',
});

let leaseSequence = 0;

function leaseIsFresh(lease, now) {
    if (!lease || !Object.values(STALL_INTENT).includes(lease.intent)) return false;
    const timeoutMs = Number.isFinite(lease.timeoutMs) ? lease.timeoutMs : 15000;
    return now - (lease.updatedAt || lease.startedAt || 0) <= timeoutMs;
}

/**
 * Declare what kind of body progress an operation currently owns. Leases expire so
 * a crashed or interrupted skill cannot suppress recovery forever. Nested leases
 * restore their parent when they finish (digDown -> shaft detour -> digDown).
 */
export function beginStallIntent(bot, intent, owner, options = {}) {
    if (!bot || !Object.values(STALL_INTENT).includes(intent)) return null;
    const now = options.now ?? Date.now();
    const token = {
        id: ++leaseSequence,
        intent,
        owner: owner || 'anonymous',
        startedAt: now,
        updatedAt: now,
        timeoutMs: options.timeoutMs ?? 15000,
        progressKey: options.progressKey ?? null,
    };
    const handle = { token, previous: bot._stallIntent || null };
    bot._stallIntent = token;
    return handle;
}

export function touchStallIntent(bot, handle, progressKey, now = Date.now()) {
    if (!bot || !handle || bot._stallIntent?.id !== handle.token.id) return false;
    bot._stallIntent.updatedAt = now;
    if (progressKey !== undefined) bot._stallIntent.progressKey = progressKey;
    return true;
}

export function endStallIntent(bot, handle) {
    if (!bot || !handle || bot._stallIntent?.id !== handle.token.id) return false;
    bot._stallIntent = handle.previous || null;
    return true;
}

/** Pure classification used by the live mode and simulations. */
export function classifyStallSnapshot(snapshot, now = Date.now()) {
    const explicit = leaseIsFresh(snapshot.explicitIntent, now) ? snapshot.explicitIntent : null;
    if (explicit) {
        return {
            intent: explicit.intent,
            owner: explicit.owner,
            progressKey: explicit.progressKey,
            source: 'lease',
        };
    }
    if (snapshot.sleeping) {
        return { intent: STALL_INTENT.WAIT, owner: snapshot.actionLabel || 'sleep', source: 'derived' };
    }
    if (snapshot.windowOpen || snapshot.usingItem) {
        return { intent: STALL_INTENT.INTERACT, owner: snapshot.actionLabel || 'interaction', source: 'derived' };
    }
    // A pathfinder dig is still DIG, not generic movement. pf_dig_watchdog owns
    // its timeout and can reason about the target block; moveAway cannot.
    if (snapshot.digging || snapshot.bodyDigLocked) {
        return { intent: STALL_INTENT.DIG, owner: snapshot.actionLabel || snapshot.currentSkill || 'dig', source: 'derived' };
    }
    if (snapshot.pathing || snapshot.movementControl || snapshot.bodyMoveLocked) {
        return { intent: STALL_INTENT.MOVE, owner: snapshot.actionLabel || snapshot.currentSkill || 'movement', source: 'derived' };
    }
    if (snapshot.actionExecuting || snapshot.currentSkill) {
        return { intent: STALL_INTENT.WORK, owner: snapshot.actionLabel || snapshot.currentSkill, source: 'derived' };
    }
    return { intent: STALL_INTENT.HOLD, owner: 'idle', source: 'derived' };
}

function controlActive(bot) {
    try {
        return ['forward', 'back', 'left', 'right', 'jump', 'sprint']
            .some(control => bot.getControlState && bot.getControlState(control));
    } catch (e) {
        return false;
    }
}

export function observeStallContext(agent, now = Date.now()) {
    const bot = agent?.bot;
    if (!bot) return { intent: STALL_INTENT.HOLD, watchMovement: false, recovery: 'none', key: 'missing-bot' };
    const actionLabel = agent.actions?.currentActionLabel || '';
    const currentSkill = bot._currentSkill || '';
    const snapshot = {
        explicitIntent: bot._stallIntent,
        sleeping: !!bot.isSleeping,
        windowOpen: !!bot.currentWindow,
        usingItem: !!(bot.isUsingHeldItem || bot.usingHeldItem),
        digging: !!bot.targetDigBlock,
        bodyDigLocked: !!(bot._bodyDigLockUntil && now < bot._bodyDigLockUntil),
        pathing: !!(bot.pathfinder?.isMoving && bot.pathfinder.isMoving()),
        movementControl: controlActive(bot),
        bodyMoveLocked: !!(bot._bodyMoveLockUntil && now < bot._bodyMoveLockUntil),
        actionExecuting: !!agent.actions?.executing,
        actionLabel,
        currentSkill,
    };
    const classified = classifyStallSnapshot(snapshot, now);
    const mobility = bot._mobility?.state || '';
    const confined = /ENTOMBED|POCKET|SEALED/.test(mobility);
    const goalKey = bot._lastPathGoalAt || 0;
    return {
        ...classified,
        mobility,
        watchMovement: classified.intent === STALL_INTENT.MOVE,
        recovery: confined ? 'yield-confinement' : 'cancel-and-replan',
        key: `${classified.intent}:${classified.owner || '-'}:${goalKey}`,
    };
}

export function recoveryDisplacement(start, end) {
    if (!start || !end) return 0;
    return Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
}

export function recoveryMovedEnough(start, end, minimum = 1.5) {
    return recoveryDisplacement(start, end) >= minimum;
}
