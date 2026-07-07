/**
 * Framework v2 — Tool catalog. The lane-backed, uninterruptible atomic operations
 * the blueprint (§E/§F) says "should be foolproof": clutch water (MLG), bridging,
 * instant bunker, plus the lava guard that gates digging.
 *
 * Each tool acquires its own lane internally (via getLaneManager / runExclusive),
 * so callers just `await tools.clutchWater(bot)` — they don't manage lanes. The
 * mutex table (contracts.LANE_PRIORITY/CONFLICT) decides preemption.
 *
 * MIGRATION STATUS (scaffold §S2): these are built + unit-tested in isolation.
 * Wiring them into the live reflex/skill callers (so a fall auto-triggers
 * clutchWater) is S2b/S5 and is gated behind the framework flag — importing this
 * module changes NO behavior on its own.
 *
 * EXCEPTION (2026-07-07 用户令 岩浆和水裁判 试装): the READ-ONLY dig judge
 * `safeToDigBlock` (lava+water) is now wired LIVE into the ore/block collector's
 * dig primitive (src/agent/library/skills.js `safeDig`), independent of the flag.
 * It is a pure predicate that only makes the collector SKIP a fluid-plugging block;
 * off-switch env MC_DIG_FLUID_GUARD=0.
 */

export { clutchWater, retractWater, fallImminent } from './survival_mlg.js';
export { placeUnderFeet, pillarUp } from './bridging.js';
export { sealBunker } from './bunker.js';
export { isLavaAt, isWaterAt, landingBelow, fluidAdjacent, safeToDigDown, safeToDigDownFluid, safeToDigBlock, canClutchWater } from './lava_guard.js';

import { fallImminent } from './survival_mlg.js';
import { safeToDigDown, safeToDigBlock } from './lava_guard.js';

/**
 * Self-describing catalog (for instinct/kernel wiring + collaborator discovery).
 * Each entry: which lane it runs on, what condition would trigger it, what it does.
 */
export const TOOL_CATALOG = Object.freeze([
    { name: 'clutchWater', lane: 'SURVIVAL_MLG', trigger: 'fallImminent(bot)', does: 'place clutch water on landing, then ALWAYS retract; refuses over lava' },
    { name: 'placeUnderFeet', lane: 'LOCOMOTION', trigger: 'bridging/pillar need', does: 'generous block-under-feet (longer jump/settle)' },
    { name: 'pillarUp', lane: 'LOCOMOTION', trigger: 'need to reach higher Y', does: 'repeated generous placeUnderFeet on one lane hold' },
    { name: 'sealBunker', lane: 'PLACEMENT', trigger: 'night/threat dig-in', does: '挖三填一: pin+mode-guard, dig down 3, cap overhead (rotate-in-place); pocket→cap-only' },
    { name: 'safeToDigDown', lane: '(predicate)', trigger: 'before any digDown', does: 'lava guard — refuse if lava at/under feet' },
    { name: 'safeToDigDownFluid', lane: '(predicate)', trigger: 'before any digDown', does: 'lava+water guard — refuse if either fluid at/under feet (aquifer too)' },
    { name: 'safeToDigBlock', lane: '(predicate)', trigger: 'before breaking an ore/collect block (LIVE in skills.safeDig)', does: '岩浆/水裁判 — refuse if breaking floods the pocket: lava any depth, water underground' },
]);

/** Predicate helpers re-exported for instinct triggers. */
export const triggers = { fallImminent, safeToDigDown, safeToDigBlock };
