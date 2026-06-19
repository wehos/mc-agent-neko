/**
 * Framework v2 — Instinct registry (blueprint part ②).
 *
 * An instinct = a condition→behavior reflex: when its `test` holds (a game event
 * OR a world-model field), it `act`s automatically; while acting it may notify
 * the agent LLM, and it may be interrupted by the LLM or a higher-priority
 * instinct.
 *
 * IMPORTANT — relationship to modes.js:
 * The mature reflexes (self_preservation, mobility, edge_unstick, auto_eat,
 * self_defense, item_collecting …) ALREADY LIVE in modes.js with a battle-tested
 * two-phase scheduler (always-observers + interruptible reflexes). We do NOT
 * reimplement them. This module is:
 *   • a CONTRACT + REGISTRY that makes the "condition / behavior / interruptible /
 *     notify-agent" shape explicit and inspectable, and
 *   • the migration target where, step by step (scaffold §S6), modes get wrapped
 *     so their action bodies run on tool lanes (uninterruptible + mutex) and they
 *     read the shared World instead of recomputing.
 *
 * For now it ships the registry + a thin adapter so the kernel can ask "what are
 * my reflexes and which would fire?" without yet moving any behavior out of
 * modes.js. Zero behavior change.
 */

import { getWorld } from './world_model.js';

/** @type {import('./contracts.js').Instinct[]} */
const REGISTRY = [];

/** Register an instinct. Idempotent by name (re-register replaces). */
export function register(instinct) {
    if (!instinct || typeof instinct.name !== 'string' || typeof instinct.test !== 'function' || typeof instinct.act !== 'function') {
        throw new Error('invalid instinct: requires {name, test, act}');
    }
    const i = REGISTRY.findIndex(x => x.name === instinct.name);
    const norm = {
        priority: 50,
        interruptibleBy: 'higher',
        notifyAgent: false,
        ...instinct,
    };
    if (i >= 0) REGISTRY[i] = norm; else REGISTRY.push(norm);
    return norm;
}

export function list() { return REGISTRY.slice().sort((a, b) => b.priority - a.priority); }

/**
 * Which instincts WOULD fire right now (test passes), highest priority first.
 * Read-only — does not act. The kernel uses this to know whether a reflex is
 * about to take the wheel (so it won't also commit an LLM task into the same moment).
 */
export function pending(bot) {
    const world = getWorld(bot);
    const out = [];
    for (const i of REGISTRY) {
        let hit = false;
        try { hit = !!i.test(world, bot); } catch (e) { hit = false; }
        if (hit) out.push(i);
    }
    return out.sort((a, b) => b.priority - a.priority);
}

/**
 * Documentation-only mirror of the modes.js reflexes that ALREADY implement the
 * instinct contract today. Kept here so collaborators see the full reflex set in
 * one place and know what NOT to re-build. As each migrates to a tool-lane-backed
 * `register()` entry (scaffold §S6) it moves from this list into REGISTRY.
 *
 * @type {{name:string, mode:string, role:string}[]}
 */
export const MODE_BACKED_REFLEXES = Object.freeze([
    { name: 'self_preservation', mode: 'self_preservation', role: 'drown/fire/low-hp defense, creeper back-off, night hold (C266 false-cover guard)' },
    { name: 'mobility',          mode: 'mobility',           role: 'FREE/POCKET/ENTOMBED/SWIM/MAROONED state machine; ENTOMBED→dig reflex' },
    { name: 'edge_unstick',      mode: 'edge_unstick',       role: 'step-edge wedge recovery (jump → replan → back-off, C265)' },
    { name: 'self_defense',      mode: 'self_defense',       role: 'melee counter-attack on close hostiles' },
    { name: 'auto_eat',          mode: 'auto_eat',           role: 'eat when hungry (preempts work)' },
    { name: 'item_collecting',   mode: 'item_collecting',    role: 'pick up nearby drops' },
    { name: 'tool_keeper',       mode: 'tool_keeper',        role: 'maintain/equip the right tool' },
    { name: 'torch_placing',     mode: 'torch_placing',      role: 'place torches in the dark' },
    { name: 'threat_radar',      mode: 'threat_radar',       role: 'always-observer: 24b threat scan + combat log' },
    { name: 'reflex_watchdog',   mode: 'reflex_watchdog',    role: 'always-observer: pin detection + forced interrupt' },
]);
