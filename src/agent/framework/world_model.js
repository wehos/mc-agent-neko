/**
 * Framework v2 — World model facade (blueprint part ① + docs/world-model.md).
 *
 * The HEAVY LIFTING already exists: modes.js `world_model` mode recomputes a
 * god-view `bot._world` every 2s and broadcasts it to world_model.json. This
 * facade does NOT recompute that — it READS it and adds the two things the
 * blueprint asks for on top:
 *
 *   1. proposeTasks(world) — the survival fixed-opening flow + resource/threat
 *      driven candidate tasks, decomposed OUT of missionNether's monolith. The
 *      proposer ranks; the kernel (LLM) decides; nobody here executes.
 *   2. mentalState(bot) — idle detection (is the system executing a committed
 *      task?) that survival uses to decide "ask the LLM to free-play" (§B).
 *
 * Plus per-world resource-node registration + a hook to ingest background
 * (x-ray) scan results — those feed instincts/proposer ONLY, never the LLM with
 * precise coords (blueprint §C hard constraint).
 */

import { EMPTY_WORLD, PROPOSAL_KIND } from './contracts.js';

/**
 * Read the single source of truth. Returns the safe EMPTY_WORLD if the
 * world_model mode hasn't produced a model yet (early boot / respawn).
 * @returns {import('./contracts.js').World}
 */
export function getWorld(bot) {
    const w = bot && bot._world;
    if (!w || typeof w !== 'object' || !w.kit) return EMPTY_WORLD;
    return w;
}

/**
 * Mental state = what the system as a whole is doing. A committed task is
 * running iff a supervised skill is executing OR an action is executing.
 * @returns {import('./contracts.js').MentalState}
 */
export function mentalState(bot) {
    const skill = (bot && bot._currentSkill) || null;
    // supervised_skill lives on the agent; action_manager.executing on agent.actions.
    // We read defensively because this module must not hard-couple to agent internals.
    let busy = !!skill;
    try {
        const agent = bot && bot._agent;
        if (agent) {
            if (agent.supervised_skill) busy = true;
            if (agent.actions && agent.actions.executing) busy = true;
        }
    } catch (e) {}
    if (!bot._mentalIdleSince) bot._mentalIdleSince = Date.now();
    if (busy) bot._mentalIdleSince = Date.now();
    const idleMs = busy ? 0 : (Date.now() - bot._mentalIdleSince);
    return { busy, skill, idleMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stockpile targets + inventory helpers (user obs #3 don't-stop-at-2-logs, #5
// don't-forget-to-stock-meat). A goal isn't "done" at the bare minimum — it's
// done when there's a BUFFER, so the bot doesn't immediately re-enter the chore.
// ─────────────────────────────────────────────────────────────────────────────
const WOOD_BUFFER = 8;     // plank-equivalents to keep on hand (table+tools+spares)
const FOOD_STOCK = 16;     // food level considered "stocked" (not just survival)

function invCount(bot, re) {
    try { return bot.inventory.items().filter(i => re.test(i.name || '')).reduce((s, i) => s + i.count, 0); } catch (e) { return 0; }
}
/** plank-equivalents on hand: logs count ×4 (each log → 4 planks) + loose planks. */
function woodUnits(bot) { return invCount(bot, /_log$/) * 4 + invCount(bot, /_planks$/); }
function hasStoneTierPick(world) { return /stone|iron|diamond|netherite/.test((world.kit && world.kit.pickTier) || ''); }

// ─────────────────────────────────────────────────────────────────────────────
// proposeTasks — survival fixed-opening flow (blueprint §D), as ranked Proposals.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate ranked candidate tasks from the world model. Coarse, high-level, and
 * coordinate-free (safe to show the LLM). The first unmet step of the fixed
 * opening dominates; survival also surfaces safety/food/migration when relevant.
 *
 * NOTE: this is the SEAT where missionNether's hardcoded decisions migrate to.
 * In migration step S3 we run this in shadow (log what we'd propose vs what
 * missionNether actually does) before the kernel acts on it.
 *
 * @param {import('./contracts.js').World} world
 * @param {any} [bot]
 * @returns {import('./contracts.js').Proposal[]} sorted desc by priority
 */
export function proposeTasks(world, bot) {
    const w = world || EMPTY_WORLD;
    const out = [];
    const push = (p) => out.push(p);

    const { vitals, threat, kit, time, migration, surfaceGate, mobility } = w;

    // ── Safety first (these are also handled by instincts; here they bias the
    //    proposal set so the LLM doesn't commit to mining while under threat). ──
    if (threat.actionable > 0 && vitals.hp < 10) {
        push({ kind: PROPOSAL_KIND.HOLD, priority: 95, skill: 'prepNether',
               rationale: 'under reachable threat at low hp — defend/shelter before any venture' });
    }

    // ── Fixed opening flow (blueprint §D): first unmet prerequisite dominates. ──
    // 1) Bootstrap kit: wood→planks→table→pickaxe→stone tools — AND a wood buffer
    //    (user #3: don't stop at 2 logs). Not "done" until pick + stone tier + buffer.
    if (!isBootstrapDone(w, bot)) {
        const noPick = kit.picks < 1;
        push({ kind: PROPOSAL_KIND.BOOTSTRAP_KIT, priority: noPick ? 90 : 66, skill: 'prepNether',
               rationale: noPick
                   ? 'no usable pickaxe — finish wood→planks→table→pickaxe→stone tools before anything else'
                   : `kit started but understocked (wood ${woodUnits(bot)}/${WOOD_BUFFER}, tier ${kit.pickTier}) — stock wood + upgrade to stone tools, don't wander off`,
               hints: { hasTablePath: kit.hasTablePath, pickTier: kit.pickTier, wood: woodUnits(bot) } });
    }

    // 2) Food: stock to a BUFFER, not just survival (user #5: stockpile meat).
    if (vitals.food < FOOD_STOCK || !kit.foodSufficient) {
        const pri = vitals.food <= 6 ? 88 : (vitals.food < 12 ? 55 : 35);
        push({ kind: PROPOSAL_KIND.GET_FOOD, priority: pri, skill: 'feedUp',
               rationale: vitals.food <= 6 ? 'food critical — hunt/forage now'
                   : `stock food to ${FOOD_STOCK} (now ${vitals.food}) — keep a meat buffer, don't run lean` });
    }

    // 3) Bed (mandatory respawn anchor) — once kit exists.
    if (kit.picks >= 1 && !bedKnown(bot)) {
        push({ kind: PROPOSAL_KIND.GET_BED, priority: 50, skill: 'prepNether',
               rationale: 'no bed yet — secure wool→bed as respawn anchor (mandatory, blueprint §D.3)' });
    }

    // 4) Migration if the biome is structurally unlivable (no sheep → no bed → death-zone respawn loop).
    if (migration.recommend && time.phase === 'day') {
        push({ kind: PROPOSAL_KIND.MIGRATE, priority: 60, skill: 'migrate',
               rationale: `biome '${migration.biome}' unlivable/death-zone — relocate to a temperate biome with animals` });
    }

    // 5) Underground venture — only when the surfaceGate allows / is committed,
    //    and the kit is sufficient. The gate (world-model.md §4) owns yo-yo prevention.
    if (kit.sufficientForUnderground && surfaceGate.mode !== 'hold' && !threat.actionable) {
        push({ kind: PROPOSAL_KIND.GO_UNDERGROUND, priority: 45, skill: 'missionNether',
               rationale: 'kitted + gate open — descend to mine iron/diamond, stay committed underground' });
    }

    // 6) Sleep habit near surface at night (proposed; LLM decides; instincts keep safe).
    if ((time.phase === 'night' || time.phase === 'dusk') && w.pos.depthBand === 'surface' && bedKnown(bot)) {
        push({ kind: PROPOSAL_KIND.SLEEP, priority: 40, skill: 'prepNether',
               rationale: 'night near surface with a bed — sleeping skips the night safely (good habit, §D.6)' });
    }

    // ── Nothing pressing + idle → let the LLM free-play (§B). Lowest priority. ──
    push({ kind: PROPOSAL_KIND.FREE_PLAY, priority: 1, skill: '',
           rationale: 'no pressing survival need — open to improvisation' });

    out.sort((a, b) => b.priority - a.priority);
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commitment ("承诺计划") — the #1 root fix (decision-speed / don't-yo-yo).
// proposeTasks RANKS; commitGoal STICKS to one goal until it's actually DONE, so
// the bot doesn't get pulled off bootstrap by every feedUp/roam impulse. Only a
// genuine emergency (critical food / reachable threat at low hp / migration need)
// preempts a live commitment. This is the seat that replaces missionNether's
// food-gate tangle (CHANGELOG C276/C273): commit, then SUPPRESS wander (the
// suppression hooks into the skills are S4.3).
// ─────────────────────────────────────────────────────────────────────────────

/** Bootstrap = pickaxe + stone-tier + a wood buffer (user #3 don't-stop-at-2-logs). */
function isBootstrapDone(world, bot) {
    return (world.kit.picks >= 1) && hasStoneTierPick(world) && woodUnits(bot) >= WOOD_BUFFER;
}

/** Has the committed goal of `kind` been satisfied? (Completion criteria.) */
export function isGoalDone(kind, world, bot) {
    const w = world || EMPTY_WORLD;
    switch (kind) {
        case PROPOSAL_KIND.BOOTSTRAP_KIT: return isBootstrapDone(w, bot);
        case PROPOSAL_KIND.GET_FOOD:      return (w.vitals.food >= FOOD_STOCK);
        case PROPOSAL_KIND.GET_BED:       return bedKnown(bot);
        case PROPOSAL_KIND.MIGRATE:       return !w.migration.recommend;     // arrived at a livable biome
        case PROPOSAL_KIND.SLEEP:         return w.time.phase === 'day';
        case PROPOSAL_KIND.HOLD:          return !(w.threat.actionable > 0 && w.vitals.hp < 10);
        // GO_UNDERGROUND / FORAGE_SURFACE / BUILD_HOME / FREE_PLAY are open-ended → re-decide each idle.
        default: return true;
    }
}

/** Emergencies that may PREEMPT a live commitment (else we stay committed). */
function isEmergency(p, world) {
    if (!p) return false;
    if (p.kind === PROPOSAL_KIND.HOLD) return true;                          // threat at low hp
    if (p.kind === PROPOSAL_KIND.GET_FOOD && world.vitals.food <= 4) return true; // about to starve
    if (p.kind === PROPOSAL_KIND.MIGRATE && world.migration.inDeathZone) return true;
    return false;
}

/**
 * Pick the goal to ACT on: sticky over proposeTasks. Maintains bot._commitment
 * across ticks. Returns the chosen Proposal annotated with {committed:true}.
 * @returns {(import('./contracts.js').Proposal & {committed:boolean})|null}
 */
export function commitGoal(bot, proposals, world) {
    const w = world || (bot && bot._world) || EMPTY_WORLD;
    const top = proposals && proposals[0];
    const c = bot && bot._commitment;

    // Keep the current commitment if it's still pending and no emergency overrides it.
    // Scan ALL proposals for an emergency (a critical one need not be top-ranked —
    // e.g. food=4 GET_FOOD@88 sits under BOOTSTRAP_KIT@90 but must still preempt).
    if (c && !isGoalDone(c.kind, w, bot)) {
        const emergency = (proposals || []).find(p => p.kind !== c.kind && isEmergency(p, w));
        if (emergency) {
            bot._commitment = { kind: emergency.kind, skill: emergency.skill, since: Date.now() };
            return { ...emergency, committed: true, preemptedFrom: c.kind };
        }
        const match = (proposals || []).find(p => p.kind === c.kind)
            || { kind: c.kind, skill: c.skill, priority: 50, rationale: '(holding commitment)' };
        return { ...match, committed: true };
    }

    // No commitment, or it's done → commit to the new top-ranked goal.
    if (top) {
        if (bot) bot._commitment = { kind: top.kind, skill: top.skill, since: Date.now() };
        return { ...top, committed: true };
    }
    if (bot) bot._commitment = null;
    return null;
}

/** Cheap check whether a bed/respawn anchor is known. Defensive — reads files the
 *  supervisor maintains; absence ≠ error. */
function bedKnown(bot) {
    try {
        if (bot && bot._world && bot._world.kit && bot._world.kit.hasBed) return true;
    } catch (e) {}
    // bed.json is written by the supervisor when a bed is placed; treat any
    // readable record as "known". Kept lenient so a missing file just means "no bed".
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-world resource nodes + background scan ingestion (coords stay internal).
// ─────────────────────────────────────────────────────────────────────────────

function nodes(bot) {
    if (!bot._resourceNodes) bot._resourceNodes = new Map();
    return bot._resourceNodes;
}

/** Register a resource-rich point (per-world). Precise coords stay HERE — used by
 *  instincts/proposer, never surfaced to the LLM (blueprint §C). */
export function registerResourceNode(bot, kind, pos) {
    const id = `${kind}@${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
    nodes(bot).set(id, { id, kind, pos: { x: pos.x, y: pos.y, z: pos.z }, depleted: false, ts: Date.now() });
    return id;
}

/** Mark a node depleted → proposer will favor seeking a new one. */
export function markDepleted(bot, nodeId) {
    const n = nodes(bot).get(nodeId);
    if (n) n.depleted = true;
}

/** Nearest non-depleted node of a kind (for instincts/proposer; not for LLM). */
export function nearestNode(bot, kind) {
    const p = bot && bot.entity && bot.entity.position;
    if (!p) return null;
    let best = null, bestD = Infinity;
    for (const n of nodes(bot).values()) {
        if (n.depleted || (kind && n.kind !== kind)) continue;
        const d = Math.hypot(n.pos.x - p.x, n.pos.y - p.y, n.pos.z - p.z);
        if (d < bestD) { bestD = d; best = n; }
    }
    return best;
}

/**
 * Ingest a background scan result (x-ray-level allowed per blueprint §C). The
 * result feeds the world model / instincts ONLY. High-level summary may reach
 * the LLM via proposal `hints`; precise coordinates never do.
 * @param {any} scanResult  { nodes: [{kind,pos}], ... }
 */
export function ingestScan(bot, scanResult) {
    if (!scanResult || !Array.isArray(scanResult.nodes)) return;
    for (const n of scanResult.nodes) {
        if (n && n.kind && n.pos) registerResourceNode(bot, n.kind, n.pos);
    }
}
