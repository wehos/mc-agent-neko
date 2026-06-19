/**
 * Framework v2 — shared contracts (the single source of truth for cross-layer types).
 *
 * This module has ZERO runtime dependencies and ZERO side effects. Every other
 * framework module (world_model / tool_lanes / instinct / kernel) imports its
 * TYPES from here (JSDoc typedefs) and its CONSTANTS (enums), but NOT each
 * other's implementation. That is what lets the four parts be developed
 * independently and collaboratively — this file is the contract they all sign.
 *
 * See docs/framework-v2-scaffold.md for the prose spec and docs/world-model.md
 * for the World schema + surfaceGate semantics.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Agent mode (survival = the main line; companion = player-interaction first)
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {'survival'|'companion'} AgentMode */
export const AGENT_MODE = Object.freeze({ SURVIVAL: 'survival', COMPANION: 'companion' });

// ─────────────────────────────────────────────────────────────────────────────
// World model (read facade over bot._world — full schema in docs/world-model.md)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} World  The single situational source of truth (bot._world).
 *   See docs/world-model.md §3.1 for the authoritative field list. Re-stated here
 *   only at the top level so consumers have a stable shape to code against.
 * @property {number} ts
 * @property {{tod:number,phase:'day'|'dusk'|'dawn'|'night',isDay:boolean}} time
 * @property {{x:number,y:number,z:number,depthBand:'surface'|'shallow'|'mid'|'deep'}} pos
 * @property {{state:'FREE'|'POCKET'|'ENTOMBED'|'SWIM'|'MAROONED',enclosed:boolean,exits:Array<[number,number]>}} mobility
 * @property {{hp:number,food:number,canRegen:boolean,armor:number}} vitals
 * @property {{hostiles:number,closest:number|null,creeperDist:number|null,phantomNear:boolean,swarm:number,actionable:number,takingDamage:boolean}} threat
 * @property {{overhead:boolean,coverReal:boolean}} cover
 * @property {{picks:number,pickTier:string,hasTablePath:boolean,foodSufficient:boolean,cobbleBuffer:number,torches:number,sufficientForUnderground:boolean}} kit
 * @property {{biome:string,badBiome:boolean,inDeathZone:boolean,recommend:boolean}} migration
 * @property {{mode:'hold'|'committed_underground'|'free',allowSurface:boolean,reason:string,decidedBy:'auto'|'supervisor',until:number}} surfaceGate
 * @property {{action:string,reason:string}} recommendation
 */

/** A safe empty World so consumers never crash before the world_model mode has run once. */
export const EMPTY_WORLD = Object.freeze({
    ts: 0,
    time: { tod: 0, phase: 'day', isDay: true },
    pos: { x: 0, y: 64, z: 0, depthBand: 'surface' },
    mobility: { state: 'FREE', enclosed: false, exits: [] },
    vitals: { hp: 20, food: 20, canRegen: true, armor: 0 },
    threat: { hostiles: 0, closest: null, creeperDist: null, phantomNear: false, swarm: 0, actionable: 0, takingDamage: false },
    cover: { overhead: false, coverReal: false },
    kit: { picks: 0, pickTier: 'none', hasTablePath: false, foodSufficient: false, cobbleBuffer: 0, torches: 0, sufficientForUnderground: false },
    migration: { biome: 'unknown', badBiome: false, inDeathZone: false, recommend: false },
    surfaceGate: { mode: 'free', allowSurface: true, reason: 'no model yet', decidedBy: 'auto', until: 0 },
    recommendation: { action: 'HOLD', reason: 'no model yet' },
});

/**
 * @typedef {Object} MentalState  What the system as a whole is doing right now.
 *   Drives survival's "idle → ask LLM to free-play" gate (blueprint §B).
 * @property {boolean} busy        a committed task / supervised skill is executing
 * @property {string|null} skill   the currently running skill name (bot._currentSkill)
 * @property {number} idleMs       ms since the system last had a committed task
 */

// ─────────────────────────────────────────────────────────────────────────────
// Proposals (world model → kernel → LLM judge). NOT executed by the proposer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * High-level kinds of work the world model can propose. Kept coarse on purpose:
 * the LLM judges among these; exact coordinates/x-ray detail never appear here
 * (blueprint §C hard constraint — don't expose the cheat, don't overload the LLM).
 * @typedef {'BOOTSTRAP_KIT'|'GET_FOOD'|'GET_BED'|'BUILD_HOME'|'GO_UNDERGROUND'|'MIGRATE'|'HOLD'|'FORAGE_SURFACE'|'SLEEP'|'FREE_PLAY'} ProposalKind
 */
export const PROPOSAL_KIND = Object.freeze({
    BOOTSTRAP_KIT: 'BOOTSTRAP_KIT',   // wood→planks→table→pick→stone tools
    GET_FOOD: 'GET_FOOD',
    GET_BED: 'GET_BED',               // wool→bed (respawn anchor, mandatory)
    BUILD_HOME: 'BUILD_HOME',         // bed-centric: chest + roof + food
    GO_UNDERGROUND: 'GO_UNDERGROUND', // gated by surfaceGate / committed venture
    MIGRATE: 'MIGRATE',
    HOLD: 'HOLD',
    FORAGE_SURFACE: 'FORAGE_SURFACE',
    SLEEP: 'SLEEP',
    FREE_PLAY: 'FREE_PLAY',           // idle + nothing pressing → let LLM improvise
});

/**
 * @typedef {Object} Proposal  A candidate task the world model offers the LLM.
 * @property {ProposalKind} kind
 * @property {number} priority         higher = more urgent (proposer's pre-rank)
 * @property {string} rationale        high-level WHY (safe to show the LLM)
 * @property {string} skill            the supervised skill that would execute it (e.g. 'prepNether')
 * @property {any[]} [args]            args forwarded to the skill
 * @property {Object} [hints]          high-level hints for the LLM (NEVER precise coords)
 */

/**
 * @typedef {Object} Decision  The LLM's verdict over proposals (kernel.decide()).
 * @property {Proposal|null} chosen    the proposal to commit to (null = hold/idle)
 * @property {string} reason           the LLM's stated reason (logged, shown to supervisor)
 * @property {boolean} freePlay        true → ignore proposals, let LLM act freely (idle only)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tool lanes (exclusive, uninterruptible; preempted only by higher-prio lane)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mutex lane classes for atomic, scripted, uninterruptible tool runs.
 * Priority numbers (see LANE_PRIORITY) decide preemption. Conflict domains
 * (see LANE_CONFLICT) decide WHETHER two lanes contend at all.
 * @typedef {'SURVIVAL_MLG'|'COMBAT'|'LOCOMOTION'|'DIG'|'PLACEMENT'|'CRAFT'} LaneClass
 */
export const LANE = Object.freeze({
    SURVIVAL_MLG: 'SURVIVAL_MLG',  // clutch water (MLG), anti-drown, fire escape —保命第一
    COMBAT: 'COMBAT',              // block/attack/kite
    LOCOMOTION: 'LOCOMOTION',      // pathfind / terrain traversal / pillar-up
    DIG: 'DIG',                    // mining / tunneling (lava-guard is its precondition)
    PLACEMENT: 'PLACEMENT',        // general building / sealing
    CRAFT: 'CRAFT',                // crafting / smelting (window-open freezes others)
});

/** Higher number preempts lower (when conflict domains overlap). See docs §5. */
export const LANE_PRIORITY = Object.freeze({
    SURVIVAL_MLG: 100,
    COMBAT: 80,
    LOCOMOTION: 60,
    DIG: 50,
    PLACEMENT: 40,
    CRAFT: 30,
});

/**
 * Physical conflict domains. Two lanes contend (one can preempt the other) ONLY
 * if they share at least one domain. 'move' = movement/pathfinder control,
 * 'hand' = held-item slot, 'place' = block placement, 'window' = open container.
 * @type {Record<LaneClass, string[]>}
 */
export const LANE_CONFLICT = Object.freeze({
    SURVIVAL_MLG: ['move', 'place', 'hand'],
    COMBAT: ['move', 'hand'],
    LOCOMOTION: ['move', 'place'],
    DIG: ['move', 'hand'],
    PLACEMENT: ['place', 'hand'],
    CRAFT: ['hand', 'window'],
});

/**
 * @typedef {Object} LaneRunOpts
 * @property {string} [label]        human label for logs/telemetry
 * @property {number} [timeoutMs]    hard ceiling; lane auto-releases on timeout
 * @property {boolean} [generous]    apply extra safety margin (slower, higher tolerance) — default true per blueprint §F
 */

// ─────────────────────────────────────────────────────────────────────────────
// Instinct (reflex contract — thin layer over modes.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Instinct  A condition→behavior reflex (blueprint part ②).
 * @property {string} name
 * @property {number} priority
 * @property {(world:World, bot:any)=>boolean} test   trigger condition (game event OR world-model field)
 * @property {(world:World, bot:any, ctx:any)=>Promise<any>} act  behavior — action bodies MUST run on a tool lane
 * @property {'agent'|'higher'|'none'} interruptibleBy  who may interrupt this reflex
 * @property {boolean} [notifyAgent]  request/notify the agent LLM while acting
 */

// ─────────────────────────────────────────────────────────────────────────────
// Feature flag default
// ─────────────────────────────────────────────────────────────────────────────

/** Framework is OFF by default — the existing missionNether path keeps working
 *  until kernel submodules are filled in. Flip via createFramework({enabled:true})
 *  or env MC_FRAMEWORK_V2=1. */
export const FRAMEWORK_ENABLED_DEFAULT = false;
