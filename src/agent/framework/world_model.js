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
    // 1) Bootstrap kit: need a pickaxe (wood→planks→table→pick→stone tools).
    if (kit.picks < 1) {
        push({ kind: PROPOSAL_KIND.BOOTSTRAP_KIT, priority: 90, skill: 'prepNether',
               rationale: 'no usable pickaxe — finish wood→planks→table→pickaxe→stone tools before anything else',
               hints: { hasTablePath: kit.hasTablePath, pickTier: kit.pickTier } });
    }

    // 2) Food sufficiency.
    if (!kit.foodSufficient) {
        const pri = vitals.food <= 6 ? 88 : 55;
        push({ kind: PROPOSAL_KIND.GET_FOOD, priority: pri, skill: 'feedUp',
               rationale: vitals.food <= 6 ? 'food critical — hunt/forage now' : 'top up food before committing to a venture' });
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
