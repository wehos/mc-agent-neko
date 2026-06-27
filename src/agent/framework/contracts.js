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
 * @property {{picks:number,pickTier:string,hasTablePath:boolean,foodSufficient:boolean,cobbleBuffer:number,torches:number,sufficientForUnderground:boolean,picksBudget:number,canMineWholeNight:boolean}} kit
 * @property {{biome:string,badBiome:boolean,inDeathZone:boolean,recommend:boolean}} migration
 * @property {{mode:'hold'|'committed_underground'|'free',allowSurface:boolean,reason:string,decidedBy:'auto'|'supervisor',until:number}} surfaceGate
 * @property {{decision:'NONE'|'FIGHT'|'MINE_THROUGH_NIGHT'|'GO_BED'|'DIG_ONE_CAP'|'SEAL_FORT'}} nightPlan  夜间决策短路结果 (modes.js computeNightPlan)
 * @property {{phase:'SCOUT'|'WOOD_BUFFER'|'VILLAGE_HARVEST'|'DONE',need:'wood'|'village'|'both'|null,woodTarget:number,villageTarget:any,woodUnits:number}} opening  开局阶段 (modes.js computeOpening)
 * @property {{bed:any,village:any,wood:any,crops:any,chest:any,animal:any,bedReachCost:number|null}} landmarks  C328 扫描器多 kind 输出
 * @property {{dirt:number,cobble:number,planks:number,log:number}} counts  关键物品计数 (夜间/开局派生用)
 * @property {{action:string,reason:string}} recommendation
 * @property {{level:'wood'|'stone'|'iron'|'diamond',rank:number,nextMilestone:string,progress:{ironBanked:number,diamondBanked:number,ironTarget:number,diamondTarget:number}}} tier  ★T-0093 北极星 tier 状态机 (world_model.proposeTasks 写, 喂遥测/LLM)
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
    kit: { picks: 0, pickTier: 'none', hasTablePath: false, foodSufficient: false, cobbleBuffer: 0, torches: 0, sufficientForUnderground: false, picksBudget: 0, canMineWholeNight: false },
    migration: { biome: 'unknown', badBiome: false, inDeathZone: false, recommend: false },
    surfaceGate: { mode: 'free', allowSurface: true, reason: 'no model yet', decidedBy: 'auto', until: 0 },
    nightPlan: { decision: 'NONE' },
    opening: { phase: 'SCOUT', need: 'both', woodTarget: 0, villageTarget: null, woodUnits: 0 },
    landmarks: { bed: null, village: null, wood: null, crops: null, chest: null, animal: null, bedReachCost: null },
    counts: { dirt: 0, cobble: 0, planks: 0, log: 0 },
    recommendation: { action: 'HOLD', reason: 'no model yet' },
    tier: { level: 'wood', rank: 1, nextMilestone: 'stone tools (BOOTSTRAP_KIT)', progress: { ironBanked: 0, diamondBanked: 0, ironTarget: 0, diamondTarget: 0 } },
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
 * @typedef {'BOOTSTRAP_KIT'|'GET_FOOD'|'GET_BED'|'GET_ARMOR'|'GET_IRON_TOOLS'|'GET_IRON_ARMOR_SET'|'GET_DIAMOND'|'BANK_GEAR'|'BUILD_HOME'|'GO_UNDERGROUND'|'MIGRATE'|'HOLD'|'FORAGE_SURFACE'|'SLEEP'|'FREE_PLAY'|'DUSK_MINE_NIGHT'|'DUSK_GO_BED'|'NIGHT_DIG_ONE'|'NIGHT_SEAL'|'OPENING_SCOUT'|'OPENING_VILLAGE'} ProposalKind
 */
export const PROPOSAL_KIND = Object.freeze({
    BOOTSTRAP_KIT: 'BOOTSTRAP_KIT',   // wood→planks→table→pick→stone tools
    GET_FOOD: 'GET_FOOD',
    GET_ARMOR: 'GET_ARMOR',           // smelt iron → craft+equip iron armor (裸甲被秒, 留钻石)
    GET_BED: 'GET_BED',               // wool→bed (respawn anchor, mandatory)
    BUILD_HOME: 'BUILD_HOME',         // bed-centric: chest + roof + food
    // ── ★T-0093 北极星 tier 链 (石器后目的不再塌缩). 按 tier 解锁: BOOTSTRAP(石)done→GET_IRON_TOOLS;
    //    铁镐到手→GET_DIAMOND. 全部压在生存链(HOLD/GET_FOOD/MIGRATE/夜链)之下. ──
    GET_IRON_TOOLS: 'GET_IRON_TOOLS', // 攒够 raw_iron → 冶炼+造铁镐/铁剑 (tier: stone→iron 的工具门槛)
    GET_IRON_ARMOR_SET: 'GET_IRON_ARMOR_SET', // 整套铁甲 (GET_ARMOR 的"成套"升级目标, 非单件)
    GET_DIAMOND: 'GET_DIAMOND',       // ★T-0092 深挖钻石带 (targetY≈-54) → 攒够 DIAMOND_FLOOR
    BANK_GEAR: 'BANK_GEAR',           // ★T-0092 背包有高价值矿且将满 → 回家入库 (bankGear, 死不丢投资)
    GO_UNDERGROUND: 'GO_UNDERGROUND', // gated by surfaceGate / committed venture
    MIGRATE: 'MIGRATE',
    HOLD: 'HOLD',
    FORAGE_SURFACE: 'FORAGE_SURFACE',
    SLEEP: 'SLEEP',
    FREE_PLAY: 'FREE_PLAY',           // idle + nothing pressing → let LLM improvise
    // ── 夜间决策 (computeNightPlan → proposeTasks 翻译) ──
    DUSK_MINE_NIGHT: 'DUSK_MINE_NIGHT', // MINE_THROUGH_NIGHT: 镐预算足够整夜下挖 (mineDown targetY:12)
    DUSK_GO_BED: 'DUSK_GO_BED',         // GO_BED: 已知床且可达, 回床睡 (prepNether 兜底)
    NIGHT_DIG_ONE: 'NIGHT_DIG_ONE',     // DIG_ONE_CAP: 挖三填一封顶过夜 (nightShelter 'dig_one')
    NIGHT_SEAL: 'NIGHT_SEAL',           // SEAL_FORT: 原地封堡兜底 (nightShelter 'seal')
    // ── 开局 (computeOpening → proposeTasks 翻译) ──
    OPENING_SCOUT: 'OPENING_SCOUT',     // SCOUT: 裸态白天侦察资源 (scoutResources)
    OPENING_VILLAGE: 'OPENING_VILLAGE', // VILLAGE_HARVEST: 已知村庄就近采集 (villageHarvest)
    // ── 机会主义插入 (task-queue Phase B: spliceOpportunistic → 队列, 全部 ≤87 在生存链下) ──
    OPP_TRADER_LEAD: 'OPP_TRADER_LEAD',     // @87 流浪商人 → 杀取栓绳 (attackNearest)
    OPP_MINE_VEIN_ORE: 'OPP_MINE_VEIN_ORE', // @86 路过铁/钻矿脉 → 立即挖 (collectBlock veinFollow)
    OPP_SEIZE_VILLAGE: 'OPP_SEIZE_VILLAGE', // @76 路过村庄 → 夺取(永远囤小麦) (villageHarvest)
    OPP_HUNT_ANIMAL: 'OPP_HUNT_ANIMAL',     // @30-72 动态 动物 → 成本/收益打分 (attackNearest)
    OPP_WHEAT_FARM: 'OPP_WHEAT_FARM',       // @40 有床后 → 种麦批量面包 动态停止 (wheatFarm)
    SURVIVAL_NIGHT: 'SURVIVAL_NIGHT',       // (Phase C+ 可选) 单夜保命 trigger 动态 resolve 成下地/床/挖三填一/seal
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
