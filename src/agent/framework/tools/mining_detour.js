/**
 * Pure helpers for bounded mining detours.
 *
 * Mining executors remain responsible for reading blocks and moving the bot. These
 * helpers only classify a one-step corridor and choose among already-probed
 * cardinal alternatives, which keeps the reflex deterministic and offline-testable.
 */

/** Is a proposed 1x2 mining corridor safe to enter? */
export function corridorSafety({
    floorSolid = false,
    fluidInCorridor = false,
    fluidWouldEnter = false,
    unbreakable = false,
    visited = false,
    targetAhead = false,
    otherOreAhead = false,
} = {}) {
    if (visited) return { safe: false, reason: 'visited' };
    if (fluidInCorridor) return { safe: false, reason: 'fluid-in-corridor' };
    if (fluidWouldEnter) return { safe: false, reason: 'fluid-would-enter' };
    if (!floorSolid) return { safe: false, reason: 'no-floor' };
    if (unbreakable) return { safe: false, reason: 'unbreakable' };
    if (otherOreAhead && !targetAhead) return { safe: false, reason: 'other-ore-ahead' };
    return { safe: true, reason: 'ok' };
}

/** Left, right, then back relative to a cardinal heading. */
export function orderedMiningDetours(dx, dz) {
    if (Math.abs(dx) + Math.abs(dz) !== 1)
        throw new Error(`mining detour heading must be cardinal, got ${dx},${dz}`);
    return [
        { dx: -dz, dz: dx, turn: 'left' },
        { dx: dz, dz: -dx, turn: 'right' },
        { dx: -dx, dz: -dz, turn: 'back' },
    ];
}

/**
 * Pick a safe probed detour. Lower score wins (normally remaining distance to the
 * mining target); left/right/back is the deterministic tie-break.
 */
export function selectMiningDetour(dx, dz, probes = []) {
    const rank = new Map(orderedMiningDetours(dx, dz)
        .map((d, i) => [`${d.dx},${d.dz}`, i]));
    return probes
        .filter(p => p && p.safe && rank.has(`${p.dx},${p.dz}`))
        .sort((a, b) => (Number(a.score) - Number(b.score))
            || (rank.get(`${a.dx},${a.dz}`) - rank.get(`${b.dx},${b.dz}`)))[0] || null;
}
