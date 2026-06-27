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
// ─────────────────────────────────────────────────────────────────────────────
// EXECUTE-FIRST / ASK-LLM / VETO-SUPPRESS-FOR-CYCLE   (用户 architecture directive)
//
// The user's instinct model — and it CORRECTS the kernel's propose→decide→execute
// order. The right order is:
//   1. An instinct ALWAYS triggers + EXECUTES FIRST (optimistic — a useful/safe
//      reflex must not wait on an LLM round-trip; acting beats deliberating).
//   2. WHILE executing it ASKS the LLM (notifies it + requests a veto), concurrently.
//   3. If the LLM VETOES → the instinct is SUPPRESSED for the rest of THIS CYCLE
//      and its in-flight act is interrupted. It re-arms only when the trigger lapses.
//
// "Cycle" = ONE continuous trigger episode: it begins when `test` first holds and
// ends when `test` goes false again. So a dusk/night "go sleep at the village"
// instinct vetoed tonight won't re-pester THIS night, but a fresh night re-arms it.
// This avoids both (a) waiting for the LLM before acting and (b) nagging the LLM
// every tick after it already said no.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-bot episode state per instinct: { since, vetoed, vetoReason, asked }. */
function episodes(bot) {
    if (!bot._instinctEpisodes) bot._instinctEpisodes = {};
    return bot._instinctEpisodes;
}

/** True while this instinct is vetoed for the CURRENT trigger episode. */
export function isVetoed(bot, name) {
    const e = episodes(bot)[name];
    return !!(e && e.vetoed);
}

/** LLM (or supervisor) veto → suppress this instinct for the rest of the current
 *  episode. The episode (and thus the veto) clears when the trigger lapses. */
export function vetoInstinct(bot, name, reason) {
    const e = episodes(bot)[name];
    if (e) { e.vetoed = true; e.vetoReason = reason || 'llm-veto'; }
    else episodes(bot)[name] = { since: Date.now(), vetoed: true, vetoReason: reason || 'llm-veto', asked: true };
    return true;
}

/**
 * Run ONE instinct under the execute-first / ask-LLM / veto-suppress-cycle contract.
 * Optimistic by design: `act` is launched and NOT awaited here (the caller's tick
 * keeps running); the LLM is asked concurrently and may veto+interrupt.
 *
 * @param {any} bot
 * @param {import('./contracts.js').Instinct & {askLLM?:(w:any,b:any,c:any)=>Promise<{veto:boolean,reason?:string}>}} instinct
 * @param {import('./contracts.js').World} world
 * @param {any} ctx  passed to act/askLLM — should carry {skills, log, interrupt}
 * @returns {{fired:boolean, reason:string, act?:Promise<any>}}
 */
export function runInstinct(bot, instinct, world, ctx) {
    const eps = episodes(bot);
    let hit = false;
    try { hit = !!instinct.test(world, bot); } catch (e) { hit = false; }

    // Episode bookkeeping: a continuous run of test=true is ONE cycle; test=false ends it (re-arm).
    if (!hit) { if (eps[instinct.name]) delete eps[instinct.name]; return { fired: false, reason: 'test-false' }; }
    if (!eps[instinct.name]) eps[instinct.name] = { since: Date.now(), vetoed: false, asked: false };
    const ep = eps[instinct.name];

    // Vetoed earlier this cycle → stay suppressed until the trigger lapses (don't re-fire / re-ask).
    if (ep.vetoed) return { fired: false, reason: `vetoed-this-cycle(${ep.vetoReason})` };

    // In-flight guard: the act is launched not-awaited and the caller ticks every ~2s, so don't
    // stack overlapping acts. One act runs to completion before the next is launched.
    if (ep.acting) return { fired: true, reason: 'already-acting', act: ep.acting };

    // 1) EXECUTE FIRST — launch the act optimistically; do NOT await it.
    const act = Promise.resolve().then(() => instinct.act(world, bot, ctx)).catch(() => {});
    ep.acting = act;
    act.finally(() => { if (ep.acting === act) ep.acting = null; });

    // 2) ASK THE LLM — ONCE per cycle, concurrently with the act (never blocks the act).
    if (instinct.askLLM && !ep.asked) {
        ep.asked = true;
        Promise.resolve().then(() => instinct.askLLM(world, bot, ctx)).then((verdict) => {
            if (verdict && verdict.veto) {
                vetoInstinct(bot, instinct.name, verdict.reason);
                // 3) interrupt the in-flight act so the bot stops the vetoed behavior NOW.
                try { if (ctx && typeof ctx.interrupt === 'function') ctx.interrupt(verdict.reason); } catch (e) {}
            }
        }).catch(() => {});
    }
    return { fired: true, reason: ep.asked ? 'acting+asked-llm' : 'acting', act };
}

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
