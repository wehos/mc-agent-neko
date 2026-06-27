// triggers.js — framework-v2: TRIGGER LIFECYCLE for queued strategic tasks (design §3).
//
// Lifts instinct.js's "execute-first / ask-LLM / veto-suppress-for-cycle" contract from the REFLEX
// layer up to the TASK layer, generalising the lifecycle from a "continuous test window" into a
// scoped LIFECYCLE-KEY so "once per night / independent next night" emerges arithmetically.
//
// This module owns ONLY the lifecycle bookkeeping + the TriggerSpec registry + per-bot episode
// state (bot._triggerState). It is the SINGLE owner of the cancel ledger (llm_gate.js delegates
// cancellation here, never keeps its own store — design §2.3 conflict resolution). It imports
// NOTHING from world_model.js (world_model imports THIS), so there is no cycle; predicates that
// need isGoalDone (stillValid/reevaluateHead) live in world_model.js instead.
//
// NOTE: Date.now() is fine here — this is live bot runtime, not a workflow script.

// ── TriggerSpec registry (one per task-kind that wants lifecycle semantics) ──────────────
// TriggerSpec = { id, lifecycleScope, condition(world,bot), lifecycleKey(world,bot), resolve(world,bot) }
const REGISTRY = new Map();

export function registerTrigger(spec) {
    if (!spec || !spec.id) return;
    REGISTRY.set(spec.id, spec);
}
export function getTrigger(id) { return REGISTRY.get(id) || null; }
export function allTriggers() { return Array.from(REGISTRY.values()); }

// ── per-bot episode state (lazy, in-memory; mirrors bot._instinctEpisodes) ───────────────
export function triggerState(bot, id) {
    if (!bot._triggerState) bot._triggerState = {};
    if (!bot._triggerState[id]) {
        bot._triggerState[id] = {
            firedKey: null,            // last lifecycle-key actually fired (dedup: same key won't refire)
            llmCancelledFor: new Set(),// lifecycle-keys the LLM cancelled (suppress only those keys)
            cooldownUntil: 0,          // Date.now() ms brake (carries _villageHarvestCooldownUntil-style)
            since: 0,
        };
    }
    return bot._triggerState[id];
}

// ── lifecycle-key — the heart of "once-per-night / next-night-independent" (design §3.1) ──
// The codebase reads bot.time.timeOfDay (wraps to 0 each dawn → would collapse every night to the
// same key — fatal). So bot._nightSeq (a monotonic counter incremented on the day→dusk edge in
// modes.js) is AUTHORITATIVE; bot.time.age is only an optional optimisation if this mineflayer
// build genuinely populates it monotonically.
export function nightSeq(bot) {
    try {
        const age = bot.time && typeof bot.time.age === 'number' ? bot.time.age : 0;
        if (age > 0) return Math.floor(age / 24000);
        return (bot._nightSeq | 0);
    } catch (e) { return (bot._nightSeq | 0); }
}

/** Compute a trigger's current lifecycle-key from the world. null = scope says N/A right now. */
export function lifecycleKey(trigger, world, bot) {
    try {
        if (typeof trigger.lifecycleKey === 'function') return trigger.lifecycleKey(world, bot);
        switch (trigger.lifecycleScope) {
            case 'night': {
                const ph = world && world.time && world.time.phase;
                if (ph !== 'dusk' && ph !== 'night') return null;
                return `night#${nightSeq(bot)}`;
            }
            case 'once': return 'once';
            case 'persistent': return `p#${Math.floor(Date.now() / 2000)}`; // changes each tick → no dedup
            // encounter / node keys must be supplied by the spec's lifecycleKey() (entity/landmark id)
            default: return null;
        }
    } catch (e) { return null; }
}

// ── firing logic (design §3.2) ───────────────────────────────────────────────────────────
/** Should this trigger FIRE (i.e. (re)enqueue its task) right now? */
export function shouldFire(trigger, world, bot) {
    try {
        const st = triggerState(bot, trigger.id);
        if (Date.now() < st.cooldownUntil) return false;                 // time-window brake
        if (typeof trigger.condition === 'function' && !trigger.condition(world, bot)) return false;
        const key = lifecycleKey(trigger, world, bot);
        if (key == null) return false;                                   // scope N/A (e.g. not night)
        if (st.llmCancelledFor.has(key)) return false;                   // LLM cancelled THIS episode
        if (st.firedKey === key) return false;                           // already fired THIS episode
        return true;
    } catch (e) { return false; }
}

/** Record a successful fire (task actually enqueued/committed). */
export function markFired(bot, trigger, world) {
    try {
        const st = triggerState(bot, trigger.id);
        const key = lifecycleKey(trigger, world, bot);
        if (key != null) { st.firedKey = key; st.since = Date.now(); }
    } catch (e) {}
}

/** LLM cancel path (stubbed: llm_gate delegates here). Suppresses ONLY this lifecycle-key. */
export function cancelTrigger(bot, id, key, reason) {
    try {
        const st = triggerState(bot, id);
        if (key != null) st.llmCancelledFor.add(key);
    } catch (e) {}
}

export function isCancelled(bot, id, key) {
    try { return triggerState(bot, id).llmCancelledFor.has(key); } catch (e) { return false; }
}

/** Set a time-window cooldown brake (carries the villageHarvest-cooldown idiom into the layer). */
export function setCooldown(bot, id, ms) {
    try { triggerState(bot, id).cooldownUntil = Date.now() + ms; } catch (e) {}
}

// ── GC — re-arm by dropping keys no longer live (design §3.2 GC; mirrors instinct.js:128) ──
// liveKeysByTrigger: { [triggerId]: Set<key> } of currently-valid keys (landmarks/entities present).
// For encounter/node scopes, any cancelled/fired key NOT in the live set is dropped → re-arms.
export function gcKeys(bot, liveKeysByTrigger) {
    try {
        if (!bot._triggerState) return;
        for (const id of Object.keys(bot._triggerState)) {
            const tr = REGISTRY.get(id);
            if (!tr) continue;
            const scope = tr.lifecycleScope;
            if (scope !== 'encounter' && scope !== 'node') continue;     // night/once/persistent are bounded
            const live = (liveKeysByTrigger && liveKeysByTrigger[id]) || new Set();
            const st = bot._triggerState[id];
            if (st.firedKey != null && !live.has(st.firedKey)) st.firedKey = null;
            for (const k of Array.from(st.llmCancelledFor)) { if (!live.has(k)) st.llmCancelledFor.delete(k); }
        }
    } catch (e) {}
}
