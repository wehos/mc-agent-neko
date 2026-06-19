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
 */

export { clutchWater, retractWater, fallImminent } from './survival_mlg.js';
export { placeUnderFeet, pillarUp } from './bridging.js';
export { sealBunker } from './bunker.js';
export { isLavaAt, landingBelow, safeToDigDown, canClutchWater } from './lava_guard.js';

import { fallImminent } from './survival_mlg.js';
import { safeToDigDown } from './lava_guard.js';

/**
 * Self-describing catalog (for instinct/kernel wiring + collaborator discovery).
 * Each entry: which lane it runs on, what condition would trigger it, what it does.
 */
export const TOOL_CATALOG = Object.freeze([
    { name: 'clutchWater', lane: 'SURVIVAL_MLG', trigger: 'fallImminent(bot)', does: 'place clutch water on landing, then ALWAYS retract; refuses over lava' },
    { name: 'placeUnderFeet', lane: 'LOCOMOTION', trigger: 'bridging/pillar need', does: 'generous block-under-feet (longer jump/settle)' },
    { name: 'pillarUp', lane: 'LOCOMOTION', trigger: 'need to reach higher Y', does: 'repeated generous placeUnderFeet on one lane hold' },
    { name: 'sealBunker', lane: 'PLACEMENT', trigger: 'night/threat dig-in', does: 'seal 4 head-level walls + roof' },
    { name: 'safeToDigDown', lane: '(predicate)', trigger: 'before any digDown', does: 'lava guard — refuse if lava at/under feet' },
]);

/** Predicate helpers re-exported for instinct triggers. */
export const triggers = { fallImminent, safeToDigDown };
