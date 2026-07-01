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
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as tq from './task_queue.js';
import * as triggers from './triggers.js';
import { llmGate, llmGateEnabled } from './llm_gate.js';

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
// ── Tunable decision constants (blueprint §spec). Defaults below; overridden by
//    bots/_supervisor/decision-config.json if present. const→let so the loader can
//    patch them. BOM-safe read; missing file is fine (defaults); a PARSE failure is
//    NOT swallowed silently — it's appended to progress.txt (C251 BOM-JSON lesson:
//    a silent JSON catch turned into a 90-min dead-idle death). ──
let WOOD_BUFFER = 8;       // plank-equivalents to keep on hand (table+tools+spares)
let MINE_NIGHT_PICK_BUDGET = 200; // sum of all picks' remaining durability to mine the whole night
let MINE_NIGHT_FOOD = 10;  // min food to commit to mining through the night
let BED_REACH_DIST = 64;   // max dist to a known bed for GO_BED to be affordable
let WOOD_REACH_DIST = 24;  // max dist to a known wood node for WOOD_BUFFER opening
const FOOD_STOCK = 16;     // food level considered "stocked" (not just survival)
// ── ★T-0093/T-0092 tier-chain buffers ("要有富余不是刚够" 从木/食扩到铁/钻). The bot stays
//    committed to a tier's underground venture until it has banked a BUFFER, not the bare minimum,
//    so it升级 once (and brings spares) instead of下地→上浮→再下地 thrashing. const→let so the
//    decision-config loader can patch them later if needed. ──
let IRON_BUFFER = 7;       // ironForArmor (raw_iron+ingot) to stock at the iron tier: 1 pick(3)+1 sword(2)+spares→armor next
let DIAMOND_FLOOR = 3;     // diamonds to bank before GET_DIAMOND is "done" (≥1 diamond pickaxe + spare)
// ── ★T-0092 depth bands (区分采铁 vs 采钻 两个深度目标, 别让 mineDown 用默认 targetY=45 浅带). ──
const IRON_TARGET_Y = 14;  // iron/coal band: y8..y16 sweet spot for iron (1.21 wide-distribution)
const DIAMOND_TARGET_Y = -54; // diamond band: y-54..-59 peak; bedrock at y-64 (1.21) — stay above it

(function loadDecisionConfig() {
    let cfgPath;
    try {
        cfgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../bots/_supervisor/decision-config.json');
    } catch (e) { return; }
    let raw;
    try {
        raw = readFileSync(cfgPath, 'utf8');
    } catch (e) {
        // Missing file is the expected default case — stay on built-in constants.
        return;
    }
    try {
        if (raw && raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip UTF-8 BOM
        const cfg = JSON.parse(raw);
        if (cfg && typeof cfg === 'object') {
            if (Number.isFinite(cfg.woodBuffer)) WOOD_BUFFER = cfg.woodBuffer;
            if (Number.isFinite(cfg.mineNightPickBudget)) MINE_NIGHT_PICK_BUDGET = cfg.mineNightPickBudget;
            if (Number.isFinite(cfg.mineNightFood)) MINE_NIGHT_FOOD = cfg.mineNightFood;
            if (Number.isFinite(cfg.bedReachDist)) BED_REACH_DIST = cfg.bedReachDist;
            if (Number.isFinite(cfg.woodReachDist)) WOOD_REACH_DIST = cfg.woodReachDist;
        }
    } catch (e) {
        // Do NOT swallow: record the parse failure so a bad config is visible, not a silent death.
        try {
            const line = `[${new Date().toISOString()}] world_model.js decision-config.json parse FAILED: ${e && e.message}\n`;
            appendFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../bots/_supervisor/progress.txt'), line);
        } catch (e2) {}
    }
})();

function invCount(bot, re) {
    try { return bot.inventory.items().filter(i => re.test(i.name || '')).reduce((s, i) => s + i.count, 0); } catch (e) { return 0; }
}
/** plank-equivalents on hand: logs count ×4 (each log → 4 planks) + loose planks. */
export function woodUnits(bot) { return invCount(bot, /_log$/) * 4 + invCount(bot, /_planks$/); }
// Smeltable+smelted iron on hand (ingot-equivalents). raw_iron smelts 1:1 → iron_ingot, so both
// count toward what GET_ARMOR can turn into armor pieces (boots4 helmet5 leggings7 chestplate8).
export function ironForArmor(bot) { return invCount(bot, /^raw_iron$/) + invCount(bot, /^iron_ingot$/); }
function hasStoneTierPick(world) { return /stone|iron|diamond|netherite/.test((world.kit && world.kit.pickTier) || ''); }
function diamondsOnHand(bot) { return invCount(bot, /^diamond$/); }
/** Pack is nearly full (≤4 free slots) → time to bank before drops are lost to a full inventory. */
function packNearlyFull(bot) { try { return bot.inventory.emptySlotCount() <= 4; } catch (e) { return false; } }
/**
 * ★T-0093 段2过渡 gate: STONE_KIT_READY = "该下矿了" 的清晰信号 (vs sufficientForUnderground 只判镐).
 * 石剑(防身) + cobble≥8(够补镐/封堵) + 能造/已有炉(furnace 雏形, 冶铁前提). 这是 SIGNAL 不是硬门——
 * 不收紧 sufficientForUnderground (那会回归 T-0088/T-0060 石棺死锁修复); 只喂 tier.nextMilestone +
 * 给监工"石器齐备没"一个可读判据. Lenient (defensive counts).
 */
function stoneKitReady(world, bot) {
    try {
        const hasStoneSword = invCount(bot, /^stone_sword$/) >= 1 || invCount(bot, /^(iron|diamond|netherite)_sword$/) >= 1;
        const cobble = invCount(bot, /^(cobblestone|cobbled_deepslate)$/);
        const planks = invCount(bot, /_planks$/) + invCount(bot, /_log$/) * 4;
        const hasFurnacePath = invCount(bot, /^furnace$/) >= 1 || cobble >= 8;   // 已有炉 或 够8 cobble 造炉
        const stonePickReadyOrRecraftable = /stone|iron|diamond|netherite/.test((world.kit && world.kit.pickTier) || '')
            && ((world.kit && world.kit.picks) || 0) >= 1;
        return !!(hasStoneSword && cobble >= 8 && hasFurnacePath && stonePickReadyOrRecraftable && planks >= 0);
    } catch (e) { return false; }
}
/** True iff an iron+ pickaxe is in the pack (the GET_DIAMOND unlock gate — diamond ore needs iron+). */
function hasIronTierPick(world) { return /iron|diamond|netherite/.test((world.kit && world.kit.pickTier) || ''); }

// ★T-0101/T-0083 FROZEN-ALIVE 互锁破除 — 单一判据,proposeTasks/isGoalDone/isEmergency 三处复用。
//   lethalThreat: 真·环境急症,HOLD 是对的(出洞=送死)——贴脸 creeper<4.5 / 正在挨打 / hp 极危<=4 /
//     swarm 围殴贴脸(closest<3 且 hostiles>=2)。这些情形宁可饿着也得守住(C32 苦力怕贴脸教训)。
//   famineStall: 低血纯粹因 food 见底(<=2)不回血,且 NO LETHAL 急症 → 这不是该原地饿死的避险,
//     是该主动去找食物的僵局。返回 true → HOLD 让位给 GET_FOOD 觅食(觅食自身仍有 feedUp/
//     villageHarvest 的 hostileNear/路径安全 gate,不会无脑冲怪堆)。
//   只在 food<=2 见底时解锁(food>2 常规 HOLD 仍生效,守等回血是对的),避免误伤正常避险。
function lethalEnvThreat(w) {
    const t = w.threat || {}, v = w.vitals || {};
    // ★关键: 用 ACTIONABLE(可达威胁: d<12 且 |dy|<=4,墙外/够不到的怪不算)判 swarm,不是 raw
    //   closest/hostiles。现场实锤 closest=0.4 但那是封箱墙外够不到的怪(actionable=1,creeperDist=9.1)
    //   — 用 raw closest 会把"贴墙够不到的怪"误判成 LETHAL,famineStall 永远不触发 → 修复失效。
    const creeperLethal = Number.isFinite(t.creeperDist) && t.creeperDist < 4.5;
    const swarmPin = (t.actionable || 0) >= 2;     // 2+ 个真·可达威胁围殴 = 别出洞
    return creeperLethal || !!t.takingDamage || (v.hp || 20) <= 4 || swarmPin;
}
function isFamineStall(w) {
    const v = w.vitals || {};
    return !lethalEnvThreat(w) && (v.food || 0) <= 2 && (v.hp || 20) < 10 && !v.canRegen;
}

// ─────────────────────────────────────────────────────────────────────────────
// ★T-0093 北极星 tier 状态机. The decision layer止步于铁 because nothing made the
//   wood→stone→iron→diamond ladder an EXPLICIT state — hasStoneTierPick was a binary
//   "≥stone?" gate, and past stone the only proposal was an open-ended GO_UNDERGROUND@45.
//   computeTier turns the ladder into a first-class field (bot._world.tier) that BOTH the
//   proposer reads (to UNLOCK the next rung) AND telemetry/LLM see (so the overseer doesn't
//   reverse-engineer "what tier is the bot on" from a pile of proposals). Pure: derived from
//   the already-reliable kit.pickTier ordinal + inventory counts; written into bot._world.tier
//   by proposeTasks (which runs right after modes.js rebuilds bot._world, before world_model.json
//   is flushed — so it rides the same 2s telemetry snapshot).
// ─────────────────────────────────────────────────────────────────────────────
const TIER_RANK = Object.freeze({ none: 0, wood: 1, wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 });
/** Map the held best-pick tier name to the coarse tier LEVEL this north-star tracks (wood..diamond). */
function tierLevelFromPick(pickTier) {
    const t = String(pickTier || 'none');
    if (/diamond|netherite/.test(t)) return { level: 'diamond', rank: 4 };
    if (/iron/.test(t)) return { level: 'iron', rank: 3 };
    if (/stone/.test(t)) return { level: 'stone', rank: 2 };
    return { level: 'wood', rank: 1 };   // none/wooden/golden all sit at the wood rung
}
/**
 * Compute the north-star tier state. Level is driven by the held pick (monotone — a
 * pick doesn't un-craft, so tier never silently regresses even when banked materials
 * are spent). progress carries the toward-next-rung counts + the BUFFER targets so
 * telemetry shows "iron 4/7, diamond 0/3" not just a level string.
 * @returns {{level:string,rank:number,nextMilestone:string,progress:{ironBanked:number,diamondBanked:number,ironTarget:number,diamondTarget:number}}}
 */
export function computeTier(world, bot) {
    const w = world || EMPTY_WORLD;
    const { level, rank } = tierLevelFromPick(w.kit && w.kit.pickTier);
    const ironBanked = ironForArmor(bot);
    const diamondBanked = diamondsOnHand(bot);
    const kitReady = stoneKitReady(w, bot);
    let nextMilestone;
    if (rank <= 1) nextMilestone = 'stone tools (BOOTSTRAP_KIT)';
    else if (rank === 2) nextMilestone = kitReady
        ? `descend for iron (STONE_KIT_READY → GO_UNDERGROUND y${IRON_TARGET_Y}, iron ${ironBanked}/${IRON_BUFFER})`
        : `complete stone kit (sword + cobble≥8 + furnace) before mining iron`;
    else if (rank === 3) {
        const armor = (w.vitals && w.vitals.armor) || 0;
        nextMilestone = armor < 4
            ? `iron armor set (GET_IRON_ARMOR_SET, iron ${ironBanked}/${IRON_BUFFER})`
            : `diamonds (GET_DIAMOND, diamond ${diamondBanked}/${DIAMOND_FLOOR})`;
    } else nextMilestone = `diamonds banked (${diamondBanked}/${DIAMOND_FLOOR}) — endgame`;
    return { level, rank, nextMilestone, stoneKitReady: kitReady, progress: { ironBanked, diamondBanked, ironTarget: IRON_BUFFER, diamondTarget: DIAMOND_FLOOR } };
}

/** The wood-buffer target (plank-equivalents) the opening flow stocks to. */
export function woodBufferTarget() { return WOOD_BUFFER; }

/**
 * True iff the go_to_bed_sleep INSTINCT is already driving the bot to/into a bed.
 * Used to suppress the DUSK_GO_BED proposal so the proposer doesn't double-drive
 * sleep against the reflex (blueprint: sleep本能 is execute-first; the task is only
 * a fallback). Reads several known sleep signals defensively.
 */
export function sleepInstinctEngaged(bot) {
    try {
        if (!bot) return false;
        if (bot._sleeping) return true;
        if (bot.isSleeping) return true;
        if (bot._instinctEpisodes && bot._instinctEpisodes['go_to_bed_sleep']) return true;
    } catch (e) {}
    return false;
}

// New (decision-layer) proposal kinds. contracts.js owns the stable cross-layer
// enum; these opening/night kinds are world_model-internal task ids consumed by
// kernelDriver via bot._commitment.skill+args, so they live here as string ids.
const TASK = Object.freeze({
    OPENING_SCOUT: 'OPENING_SCOUT',
    OPENING_VILLAGE: 'OPENING_VILLAGE',
    DUSK_MINE_NIGHT: 'DUSK_MINE_NIGHT',
    DUSK_GO_BED: 'DUSK_GO_BED',
    NIGHT_DIG_ONE: 'NIGHT_DIG_ONE',
    NIGHT_SEAL: 'NIGHT_SEAL',
    // ★T-0097 tier-relapse root-fix: a NIGHT-band productive plan — convert banked iron into an iron
    // pickaxe+sword+shield in place (smelt + craft) instead of mining more loose ore. A proper night
    // plan so it (a) DETHRONES a stale daytime commitment at dusk via the nightPre path, and (b) holds
    // sticky (isGoalDone = an iron-tier pick is in hand) through the smelt→craft phases until done.
    NIGHT_SMELT_IRON: 'NIGHT_SMELT_IRON',
});

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

    // ★危血禁下深矿 (T-0098续 / 06-25T12:31 实锤: hp8 food17 被 GO_UNDERGROUND@45 派 mineDown,
    //   从 y62 下潜 48 层到 y14,全程不回血(food<18=低于 MC 自然回血线),遇地下僵尸 dist1 裸甲一击死).
    //   下深矿要有血量 buffer 应对地下怪偷袭: hp<8 一律危险; hp 8-11 仅在能回血(food>=18,边下边回)放行;
    //   hp>=12 放行。低血不回血时下矿=送死 → gate 关下矿后 GET_FOOD@88/55 接管上浮 feedUp 补食回血,
    //   宁可 idle 等食也不深入送死(keepInv ON,idle 不死)。只 gate 真·下深矿(GO_UNDERGROUND@45/
    //   GET_DIAMOND@46),不动 sufficientForUnderground(本文件:134 警告: 收紧它=回归 T-0088/T-0060 石棺
    //   死锁)、不动地表 smelt/craft(GET_IRON_TOOLS@47=furnace 作业非下矿)。夜 MINE_THROUGH_NIGHT 不在
    //   此 gate(夜决策由 computeNightPlan 的 alreadyDeepEnclosed/FIGHT 链自管,避免破坏夜庇护 fallback)。
    const hpSafeForUnderground = vitals.hp >= 12 || (vitals.hp >= 8 && vitals.food >= 18);

    // ── ★T-0093 NORTH STAR: stamp the explicit tier state onto the world model EVERY pass.
    //    modes.js rebuilds bot._world right before calling proposeTasks, then flushes it to
    //    world_model.json right after — so writing here puts tier on the live telemetry/LLM
    //    snapshot. Also expose it as bot._tier (a namespace modes.js never overwrites) so any
    //    consumer can read it between rebuilds. ──
    const tier = computeTier(w, bot);
    try { if (bot && bot._world) bot._world.tier = tier; } catch (e) {}
    try { if (bot) bot._tier = tier; } catch (e) {}

    // ── ★T-0101/T-0083 FROZEN-ALIVE 互锁破除 (worker-frozen) ──
    //   LETHAL 环境急症 vs 纯饥饿僵局的分诊。背景: HOLD@95 是最高优先级生存承诺,
    //   isGoalDone 要求 "威胁消失 OR hp>=10" 才解除。但 food=0 永不回血(MC food<18 不回血)
    //   → hp 永远卡在 <10 → HOLD 永不 done → bot 守在原地 → 永远走不到 village 吃东西 →
    //   food 永远 0 → FROZEN-ALIVE 死锁(9h 实锤@91,159 food0 hp7,苦力怕远 9.1格够不到).
    //   修: 把 "低血" 拆成两类——
    //     (a) lethalThreat: 真·环境急症,HOLD 是对的(必须守住别送死)——
    //         · 贴脸 creeper (<4.5m): 出洞就被炸(C32 教训,保命第一)
    //         · 正在挨打 (takingDamage): 有怪真打到我了
    //         · hp 极危 (<=4): 一击就死,任何移动都赌命
    //         · swarm 围殴贴脸 (closest<3 且 hostiles>=2): 多怪堵门
    //     (b) famineStall: 低血纯粹因 food 太低不回血,且无上述 LETHAL 急症 → 这不是该
    //         原地饿死的避险,是该主动去找食物的僵局。此时 NOT push HOLD → GET_FOOD@88
    //         升为顶层 emergency 接管,bot 去 village/animal 觅食(觅食本身仍受 feedUp/
    //         villageHarvest 自己的 hostileNear/路径安全 gate 约束,不会无脑冲怪堆)。
    //   "封箱安全(无 LETHAL 威胁) + food=0 = 该去找食物,不是原地饿死" —— 用户核心指令。
    //   判据下沉到模块级 isFamineStall(w)/lethalEnvThreat(w),与 isGoalDone/isEmergency 共用单一真相。
    const famineStall = isFamineStall(w);
    if (threat.actionable > 0 && vitals.hp < 10 && !famineStall) {
        push({ kind: PROPOSAL_KIND.HOLD, priority: 95, skill: 'prepNether',
               rationale: 'under reachable threat at low hp — defend/shelter before any venture' });
    } else if (famineStall) {
        // 饥饿僵局: 不 HOLD,记录决策让 worker 取证可见。GET_FOOD@88 在下方 push,
        //   isEmergency(food<=4 但 villageClose 否决)的 villageClose 例外也在下面破除。
        try { appendFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../bots/_supervisor/progress.txt'),
            `[${new Date().toISOString()}] [proposeTasks] ★famine-forage-unlock: food=${vitals.food} hp=${vitals.hp} canRegen=${vitals.canRegen} creeperD=${threat.creeperDist} closest=${threat.closest} swarm=${threat.hostiles} — NOT HOLD, 让 GET_FOOD 接管去觅食(无 LETHAL 急症)\n`); } catch (e) {}
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

    // 2b) ★T-0069 WHEAT FARM — SUSTAINABLE food production (the self-sufficiency root). feedUp only
    //     CONSUMES existing food sources (hunt/forage/leaf-apples); in a food desert it空转s and the
    //     bot starves on cheat-supply. wheatFarm.js was written for this but was NEVER dispatched
    //     (OPP_WHEAT_FARM is dead code — nothing pushes it; triggers REGISTRY is empty). Wire it as a
    //     real proposer task: when it's day, safe, and we CAN actually farm (seeds in the bag to
    //     sow/keep a plot OR mature wheat already growing nearby to harvest+bake), run one bounded
    //     pass (harvest → bake bread → replant). The skill self-cooldowns (~5min) so unripe plots
    //     don't pin it. @50: a buffer-building task — below crisis food (GET_FOOD@88/55), bootstrap
    //     (90/66) and armor (68); above generic mining (45). It only fires once food isn't critical
    //     (>6) so it never competes with the starve-now path. dynamicBreadTarget gates the dispatch
    //     to a real bread deficit, so a fed bot with a full bread stock won't churn on it.
    const canFarmNow = (invCount(bot, /^wheat_seeds$/) > 0 || invCount(bot, /^wheat$/) >= 3);
    const breadDeficit = invCount(bot, /^bread$/) < dynamicBreadTarget(bot, w);
    if (time.phase === 'day' && !(threat.actionable > 0) && vitals.food > 6 && canFarmNow && breadDeficit
        && (!bot || Date.now() >= (bot._wheatFarmCooldownUntil || 0))) {
        push({ kind: PROPOSAL_KIND.OPP_WHEAT_FARM, priority: 50, skill: 'wheatFarm',
               args: [{ breadTarget: dynamicBreadTarget(bot, w) }],
               rationale: `sustainable food: harvest+bake wheat→bread (target ${dynamicBreadTarget(bot, w)}, have ${invCount(bot, /^bread$/)}) — stop relying on cheat-supply` });
    }

    // 3) Bed (mandatory respawn anchor) — once kit exists.
    if (kit.picks >= 1 && !bedKnown(bot) && !(hasIronTierPick(w) && (vitals.armor || 0) >= 1 && diamondsOnHand(bot) < DIAMOND_FLOOR)) {   // ★T-0092 completion (worker-sync): GET_BED@50 was an UNFULFILLABLE wool-errand (no wool→no bed→bedKnown永false) that OUTRANKED GET_DIAMOND@46, so an iron-tooled+armored bot never descended for diamond. Yield GET_BED exactly when the bot is diamond-ready (mirror the GET_DIAMOND gate) so GET_DIAMOND wins → mineDiamonds descends. Safe: pure re-prioritize, does NOT gate pick/bed-MAKING (keepInventory ON so a delayed respawn-anchor loses nothing).
        push({ kind: PROPOSAL_KIND.GET_BED, priority: 50, skill: 'prepNether',   // ★T-0060 (worker-sync 0701): TRIED @44 (below GO_UNDERGROUND@45) to break the ~1h wool-wander stagnation — REVERTED. Live result: @44 correctly re-routed the commitment GET_BED→GO_UNDERGROUND/mineDown, but mineDown then NO-OP-spun (couldn't descend at the spawn-area spot -15,71) → bot HARD-PINNED ~14min, WORSE than @50's wool-wander (which at least moved + was transition-bounded). ROOT is NOT the GET_BED priority — it's the bot STUCK at a bad spot (unmineable AND wool-less) with the stuck-relocate (migration.stuckTerrain) NOT firing after 77min stall. The real fix is migrate-away-from-stuck-spot + mineDown-relocate-on-no-dig (both decision-layer, attended). Keeping @50 baseline.
               rationale: 'no bed yet — secure wool→bed as respawn anchor (mandatory, blueprint §D.3)' });
    }

    // 3b) ARMOR — close the chronic unarmored-death gap (86% of deaths are unarmored; bot makes an
    //    iron PICKAXE but never armor → a single creeper/stray one-shots it every cycle). Once banked
    //    iron is enough for a piece, smelt+craft+equip iron armor (iron preserves diamonds — user
    //    choice 铁甲留钻石). DAY + safe only (craft at the furnace, never exposed at night). When iron
    //    is short this stays silent and GO_UNDERGROUND mining accumulates more; it re-fires next pass.
    //    @68: above the understocked-wood BOOTSTRAP_KIT (66) — a bot WITH an iron pick + banked iron
    //    but no armor, stuck deep where it can't reach wood, must armor up rather than deadlock forever
    //    on a wood buffer it can't fill underground. Still below noPick BOOTSTRAP_KIT (90) and critical
    //    food (88): get a pickaxe / don't starve first. Above migrate (60) / bed (50) / mining (45).
    if (time.phase === 'day' && !(threat.actionable > 0) && (vitals.armor || 0) < 4 && ironForArmor(bot) >= 4) {
        push({ kind: PROPOSAL_KIND.GET_ARMOR, priority: 68, skill: 'craftArmor',
               rationale: `unarmored (${vitals.armor || 0}/4 pieces) + ${ironForArmor(bot)} iron banked — smelt+craft+equip iron armor (creeper/stray insurance, save diamonds)` });
    }

    // 3c) ★T-0093 TIER CHAIN — the north-star milestones that stop "目的塌缩" after stone tools.
    //     Each rung UNLOCKS only when the lower rung is done, so priority encodes the ladder instead
    //     of the old flat hardcode. ALL of these sit BELOW the survival chain (HOLD@95 / critical
    //     food@88 / night chain@91-94 / MIGRATE@60) — they are day-time progress, never preempt
    //     staying alive. They also yield to an unfinished bootstrap (noPick@90) and to GET_ARMOR@68
    //     (don't chase diamonds unarmored). Only fire on the surface in daylight when safe (the actual
    //     descent happens via mineDown with a tier-correct targetY).
    const tierReady = isBootstrapDone(w, bot) && time.phase === 'day' && !(threat.actionable > 0)
        && (vitals.food >= 8) && surfaceGate.mode !== 'hold';
    if (tierReady) {
        // RUNG 1: stone tier + enough banked iron, but no iron pick yet → smelt then craft iron tools.
        //   Two-state dispatch over EXISTING real skills (no假执行): if raw_iron isn't smelted yet,
        //   run smeltSafe (places furnace + smelts); once ingots are in hand, run craftChain('iron_tier')
        //   (crafts iron pickaxe + sword + shield). @47: just above open-ended GO_UNDERGROUND@45 —
        //   "have the ore in hand, upgrade before diving again" — but below GET_ARMOR@68 and all survival.
        if (tier.rank === 2 && ironForArmor(bot) >= 3 && !hasIronTierPick(w)) {
            const ingots = invCount(bot, /^iron_ingot$/);
            const rawIron = invCount(bot, /^raw_iron$/);
            if (ingots < 3 && rawIron > 0) {
                push({ kind: PROPOSAL_KIND.GET_IRON_TOOLS, priority: 47, skill: 'smeltSafe',
                       args: ['raw_iron', Math.min(rawIron, 5)],
                       rationale: `stone tier + ${rawIron} raw_iron — smelt it (need ingots for an iron pickaxe to unlock diamonds)`,
                       hints: { tier: tier.level, rawIron } });
            } else {
                push({ kind: PROPOSAL_KIND.GET_IRON_TOOLS, priority: 47, skill: 'craftChain',
                       args: ['iron_tier'],
                       rationale: `stone tier + ${ingots} iron ingots — craft iron pickaxe + sword (unlock diamond mining)`,
                       hints: { tier: tier.level, ingots } });
            }
        }
        // RUNG 2: iron pick in hand (diamond mining unlocked) + iron armor on → go GET DIAMONDS.
        //   Requires armor>=4 (GET_ARMOR@68 closes that first) so the bot never strip-mines the
        //   deep diamond band unarmored. @46: above GO_UNDERGROUND@45 so a kitted iron bot heads for
        //   the diamond band on purpose instead of the open-ended shallow descent.
        if (hasIronTierPick(w) && (vitals.armor || 0) >= 1 && diamondsOnHand(bot) < DIAMOND_FLOOR && hpSafeForUnderground) {   // ★T-0092 (worker-sync): armor>=4(full set=24 iron, unreachable since GET_ARMOR yields at <4) → armor>=1(reachable from one craftArmor pass) so an iron-tooled+lightly-armored bot actually commits GET_DIAMOND → mineDiamonds descends to y-52. Still gated on iron pick + hpSafe + mineDiamonds' own pickaxe-guard (can't send a pickless/bare bot deep). NOT >=0.
            // Dispatch the DEDICATED mineDiamonds skill: it water-aware-descends to the diamond band,
            // x-ray finds + vein-follows diamonds, banks each haul, and LOOPS until count is reached —
            // exactly the "在该层定向循环直到挖到目标矿" T-0092 asks for. (Generic mineDown only
            // descends then branch-mines once; mineDiamonds owns the deep-diamond venture.)
            push({ kind: PROPOSAL_KIND.GET_DIAMOND, priority: 46, skill: 'mineDiamonds',
                   args: [DIAMOND_FLOOR],
                   rationale: `iron-tooled + armored — descend to the diamond band (y${DIAMOND_TARGET_Y}) and mine to ${DIAMOND_FLOOR} diamonds`,
                   hints: { tier: tier.level, targetY: DIAMOND_TARGET_Y, diamonds: diamondsOnHand(bot) } });
        }
    }

    // 3d) ★T-0092 BANK GEAR — pack carries diamonds/high-value ore AND is nearly full → run home and
    //     deposit so a death doesn't wipe the investment. Day, safe, not mid-emergency. @58 (above
    //     MIGRATE@60? no — just below: a death-zone migrate still wins; but above GET_BED@50 and the
    //     tier chain): protecting banked diamonds outranks chasing more, but never a survival need.
    //     bankGear itself defers if there's no home anchor or it's unsafe, so this is cheap to propose.
    if (time.phase === 'day' && !(threat.actionable > 0) && diamondsOnHand(bot) >= 1 && packNearlyFull(bot)) {
        push({ kind: PROPOSAL_KIND.BANK_GEAR, priority: 58, skill: 'bankGear',
               rationale: `${diamondsOnHand(bot)} diamond(s) + pack nearly full — bank valuables at home before a death wipes them`,
               hints: { diamonds: diamondsOnHand(bot) } });
    }

    // 4) Migration if the biome is structurally unlivable (no sheep → no bed → death-zone respawn loop).
    if (migration.recommend && time.phase === 'day') {
        // ★C347 (T-0096): STUCK-TERRAIN relocate. migration.stuckTerrain (set in modes.js) means the
        // bot is treading water in locally hostile terrain (aquifer / shattered shallow) — net mining
        // progress ≈0 while it thrashes ENTOMBED/SEALED for minutes. The biome here is LIVABLE
        // (savanna), so migrate.js's own start-gate ("no unlivable evidence — let forageExplore try")
        // would VETO a plain relocate. Pass force:true ONLY for this trigger so the relocate actually
        // happens (the gate still self-protects: migrate.js surfaces first, marches with abort-hp).
        // We keep the maxBlocks short — this is a LOCAL hop to fresh ground, not a cross-continent flee.
        // ★T-0102: woodBarren (pickless + no wood in a tree-sparse but "livable" biome) needs the SAME
        // force:true bypass as stuckTerrain — beach/desert pass badBiome=false so migrate.js's start-gate
        // ("no unlivable evidence") would veto a plain relocate, stranding the bot wood-deadlocked. Use a
        // slightly larger hop for woodBarren (trees can be further than the local stuck-terrain hop).
        // force ONLY when a decision-layer-only trigger (stuck/woodBarren) fires in a biome migrate.js
        // wouldn't independently flee (badBiome=false, not inDeathZone). force bypasses migrate.js's
        // start-gate INCLUDING its night gate, so it must NOT be widened to inDeathZone/badBiome cases
        // (those have their own evidence and a sticky one could night-march). The cooldown-no-op-spin is
        // closed upstream in modes.js (migration.recommend gates non-force triggers on !migrateOnCooldown
        // and is false at dusk/night), so MIGRATE is only ever proposed when it can actually run.
        const forceRelocate = (migration.stuckTerrain || migration.woodBarren) && !migration.badBiome && !migration.inDeathZone;
        const args = forceRelocate
            ? [{ force: true, maxBlocks: migration.woodBarren ? 128 : 96, cooldownMin: 8, settleScore: 8 }]
            : [];
        push({ kind: PROPOSAL_KIND.MIGRATE, priority: 60, skill: 'migrate', args,
               rationale: migration.woodBarren
                   ? `wood-barren: pickless + no wood in tree-sparse '${migration.biome}' — relocate to find trees (first-order bootstrap unlock)`
                   : migration.stuckTerrain
                       ? `stuck-terrain: net mining progress ≈0 + high unstick-thrash in '${migration.biome}' — hop to fresh ground`
                       : `biome '${migration.biome}' unlivable/death-zone — relocate to a temperate biome with animals` });
    }

    // ── ★T-0069 STARVING-NEXT-TO-VILLAGE WAIVER: the OPENING block below is gated on
    //    `!(threat.actionable>0)`, so a single (often UNREACHABLE) hostile suppresses the
    //    VILLAGE_HARVEST proposal — and the bot starves 11b from a village full of food. Live
    //    deadlock: food=0 hp7 + creeper@9.2 (actionable=1, can't reach the enclosed bot) → no
    //    VILLAGE_HARVEST pushed → feedUp空转 in the food desert → creeper-hunger-hold 1199s. When
    //    food is CRITICAL (<=6) and a known village is close, harvesting it is the ONLY food path,
    //    so push it even under an actionable threat — at救命 priority (just under HOLD@95, above
    //    crisis food@88). villageHarvest still hard-defers on hostiles>2 / hp<=4, so this never
    //    walks a one-hp bot into a mob; it only unblocks the village run a stray creeper was vetoing.
    const opening = w.opening || {};
    if (opening.phase === 'VILLAGE_HARVEST' && vitals.food <= 6 && time.phase === 'day'
        && w.landmarks && w.landmarks.village && Number(w.landmarks.village.dist) <= 28) {
        push({ kind: TASK.OPENING_VILLAGE, priority: 89, skill: 'villageHarvest',
               rationale: `STARVING (food=${vitals.food}) next to a known village @${Math.round(w.landmarks.village.dist)}b — harvest it for food now (only reachable food source; villageHarvest self-defers if truly unsafe)` });
    }

    // ── OPENING flow (day, on the surface, nothing actionable): translate the
    //    derived w.opening.phase computed in modes.js into ranked tasks so a bare
    //    bot scouts/buffers/harvests instead of sleepwalking into generic prepNether. ──
    if (time.phase === 'day' && w.pos && w.pos.depthBand === 'surface' && !(threat.actionable > 0)) {
        switch (opening.phase) {
            case 'SCOUT':
                // ★用户spec: 开局无脑找树+村庄优先. SCOUT phase=冷开局(无已知可达wood/village) →
                // 压过 BOOTSTRAP_KIT(noPick=90), 先扫树+村+标landmark+判成本, 再bootstrap. 仅SCOUT态出.
                push({ kind: TASK.OPENING_SCOUT, priority: 92, skill: 'scoutResources',
                       args: [{ need: opening.need }],
                       rationale: `bare opening — scout for ${opening.need || 'resources'} (no known reachable wood/village yet)` });
                break;
            case 'WOOD_BUFFER':
                push({ kind: PROPOSAL_KIND.BOOTSTRAP_KIT, priority: 66, skill: 'prepNether',
                       args: [{ woodTarget: WOOD_BUFFER }],
                       rationale: `wood known but understocked (${woodUnits(bot)}/${WOOD_BUFFER}) — buffer wood before going under`,
                       hints: { woodTarget: WOOD_BUFFER, wood: woodUnits(bot) } });
                break;
            case 'VILLAGE_HARVEST':
                push({ kind: TASK.OPENING_VILLAGE, priority: 67, skill: 'villageHarvest',
                       rationale: 'known nearby village — harvest crops/loot before the kit gets急需' });
                break;
            default: break; // DONE / undefined → no opening proposal
        }
    }

    // ── NIGHT flow (dusk/dawn/night): translate the dusk/night decision computed in
    //    modes.js (computeNightPlan) into ranked tasks. FIGHT/NONE emit nothing — the
    //    self_defense reflex owns combat; NONE means daytime/no night decision. ──
    if (time.phase !== 'day') {
        // ★用户spec: "一到晚上就无脑seal/bootstrap"是错的——夜里夜间决策必须压过白天作业(BOOTSTRAP_KIT 90).
        // 夜间四选一全部 >90(在HOLD 95之下), 按用户序 下矿整晚94>去床93>挖三填一92>seal堡垒91. 只夜出.
        const np = w.nightPlan || {};
        switch (np.decision) {
            case 'SMELT_IRON': {
                // ★T-0097: computeNightPlan chose to LOCK IN banked iron tonight (safe + ≥3 iron + furnace-able
                // + stone pick + no iron pick yet). Two-state dispatch over REAL skills (no假执行), mirroring
                // the daytime GET_IRON_TOOLS rung: if raw_iron isn't smelted yet → smeltSafe (places furnace +
                // smelts); once ≥3 ingots are in hand → craftChain('iron_tier') (iron pickaxe+sword+shield).
                // The commitment (NIGHT_SMELT_IRON) is sticky until hasIronTierPick, and this case re-derives
                // the correct skill each tick, so the smelt→craft hand-off happens automatically. @94 (top of
                // the night-productive band, above DUSK_MINE_NIGHT) — but mutually exclusive with mining anyway,
                // since computeNightPlan returns SMELT_IRON *instead of* MINE_THROUGH_NIGHT.
                const ingots = invCount(bot, /^iron_ingot$/);
                const rawIron = invCount(bot, /^raw_iron$/);
                if (ingots < 3 && rawIron > 0) {
                    push({ kind: TASK.NIGHT_SMELT_IRON, priority: 94, skill: 'smeltSafe',
                           args: ['raw_iron', Math.min(rawIron, 5)],
                           rationale: `night tier lock-in: ${rawIron} raw_iron + no iron pick — smelt it (persistent iron tier; iron sword/shield for night survival)`,
                           hints: { tier: tier.level, rawIron, night: true } });
                } else {
                    push({ kind: TASK.NIGHT_SMELT_IRON, priority: 94, skill: 'craftChain',
                           args: ['iron_tier'],
                           rationale: `night tier lock-in: ${ingots} iron ingots — craft iron pickaxe+sword+shield (persistent tier-up, not a wood relapse)`,
                           hints: { tier: tier.level, ingots, night: true } });
                }
                break;
            }
            case 'MINE_THROUGH_NIGHT':
                push({ kind: TASK.DUSK_MINE_NIGHT, priority: 94, skill: 'mineDown',
                       args: [{ targetY: 12 }],
                       rationale: 'kitted (pick budget + food + fill) — mine through the whole night underground' });
                break;
            case 'GO_BED':
                // Only a FALLBACK: if the go_to_bed_sleep instinct is already driving sleep,
                // don't double-drive it from the proposer.
                if (!sleepInstinctEngaged(bot)) {
                    push({ kind: TASK.DUSK_GO_BED, priority: 93, skill: 'prepNether',
                           rationale: 'known affordable bed in reach — go sleep through the night (instinct fallback)' });
                }
                break;
            case 'DIG_ONE_CAP':
                push({ kind: TASK.NIGHT_DIG_ONE, priority: 92, skill: 'nightShelter',
                       args: ['dig_one'],
                       rationale: 'no bed/mining option — dig a 1-block cap shelter (挖三填一) for the night' });
                break;
            case 'SEAL_FORT':
                push({ kind: TASK.NIGHT_SEAL, priority: 91, skill: 'nightShelter',
                       args: ['seal'],
                       rationale: 'fallback — seal in place / wall off until daybreak' });
                break;
            default: break; // FIGHT / NONE → no proposal (self_defense / daytime)
        }
    }

    // 5) Underground venture — only when the surfaceGate allows / is committed, and the kit is
    //    sufficient. The gate (world-model.md §4) owns yo-yo prevention. ★T-0093: this is no longer
    //    an open-ended "go dig somewhere" — it carries a tier-correct targetY (iron band for a
    //    stone/iron bot still stocking iron; the dedicated GET_DIAMOND@46 owns the diamond band) AND
    //    is bound to an OUTPUT goal in isGoalDone (stock IRON_BUFFER iron), so it stays committed
    //    underground until it has actually mined the iron it descended for — no下地→上浮→再下地 churn.
    if (kit.sufficientForUnderground && surfaceGate.mode !== 'hold' && !threat.actionable && hpSafeForUnderground) {
        push({ kind: PROPOSAL_KIND.GO_UNDERGROUND, priority: 45, skill: 'mineDown',
               args: [{ targetY: IRON_TARGET_Y }],
               rationale: `kitted + gate open — descend to the iron band (y${IRON_TARGET_Y}) and mine iron (have ${ironForArmor(bot)}/${IRON_BUFFER}), stay committed underground`,
               hints: { targetY: IRON_TARGET_Y, tier: tier.level, iron: ironForArmor(bot) } });
    }

    // 6) Sleep is NOT proposed here. ★C331 (用户 architecture directive): "去村庄睡觉是本能"
    //    — sleeping at a known bed/village is an EXECUTE-FIRST INSTINCT (go_to_bed_sleep,
    //    modes.js world_model mode via instinct.runInstinct), NOT a kernel-dispatched idle
    //    task. Reflexes act first and don't wait for the proposer/LLM, so sleep must not be
    //    a Proposal (that would double-handle it). GET_BED (acquiring a bed) stays a task;
    //    USING the bed at night is the instinct's job. See scaffold §3.2.

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
        // Done when fully armored OR no more iron to turn into a piece (cheapest = boots, 4 ingots) —
        // so it crafts all it can afford this pass, then yields to mining to accumulate more iron.
        case PROPOSAL_KIND.GET_ARMOR:     return (w.vitals.armor || 0) >= 4 || ironForArmor(bot) < 4;
        case PROPOSAL_KIND.GET_BED:       return bedKnown(bot);
        case PROPOSAL_KIND.MIGRATE:       return !w.migration.recommend;     // arrived at a livable biome
        // ── ★T-0093 tier chain completion. ──
        // GET_IRON_TOOLS done = an iron+ pickaxe is now in hand (the rung was about crafting it).
        case PROPOSAL_KIND.GET_IRON_TOOLS:   return hasIronTierPick(w);
        // ★T-0097 NIGHT_SMELT_IRON done = same target (an iron-tier pick exists) — holds the night
        // commitment sticky across the smelt→craft hand-off until the iron pickaxe is actually crafted.
        case TASK.NIGHT_SMELT_IRON:          return hasIronTierPick(w) || (invCount(bot, /^raw_iron$/) === 0 && invCount(bot, /^iron_ingot$/) < 3);   // ★FIX (worker-sync 0630 frozen-alive): the sticky NIGHT_SMELT_IRON deadlocked into a smeltSafe no-op spin — chosen at dusk w/ raw_iron≥3, but once the iron was smelted+consumed WITHOUT reaching hasIronTierPick (ingots banked/used, no lasting iron pick), it stayed sticky dispatching smeltSafe('raw_iron',N) at raw_iron=0 → no-op every 1.5s, frozen until watchdog (live: pinned 9min @54,58 mob=FREE/ENC). Release when there's nothing left to smelt OR craft → re-evaluate → mine more iron. Does NOT gate pick-making.
        // GET_IRON_ARMOR_SET done = fully armored OR no iron left to make a piece (mirrors GET_ARMOR).
        case PROPOSAL_KIND.GET_IRON_ARMOR_SET: return (w.vitals.armor || 0) >= 4 || ironForArmor(bot) < 4;
        // ★T-0092 GET_DIAMOND done = banked the DIAMOND_FLOOR buffer (≥1 diamond pick + spare worth).
        //   Stays committed deep until the floor is met → the diamond venture isn't abandoned after
        //   one ore. Survival (HOLD/food/night) still preempts via isEmergency/nightPre, so a deep
        //   commitment never traps the bot through danger.
        case PROPOSAL_KIND.GET_DIAMOND:      return diamondsOnHand(bot) >= DIAMOND_FLOOR;
        // ★T-0092 BANK_GEAR done = the diamonds are off-hand (deposited) OR the pack reopened. Either
        //   way the bank run achieved its purpose; re-fires next time the pack fills with valuables.
        case PROPOSAL_KIND.BANK_GEAR:        return diamondsOnHand(bot) < 1 || !packNearlyFull(bot);
        // ── Night tasks complete at daybreak (the night they covered is over). ──
        case TASK.DUSK_MINE_NIGHT:
        case TASK.DUSK_GO_BED:
        case TASK.NIGHT_DIG_ONE:
        case TASK.NIGHT_SEAL:
            return w.time.phase === 'day';
        // ── Opening tasks. SCOUT is done once both wood + village are known landmarks. ──
        case TASK.OPENING_SCOUT: {
            const lm = (w.landmarks) || {};
            return !!(lm.wood && lm.village);
        }
        case TASK.OPENING_VILLAGE: {
            const lm = (w.landmarks) || {};
            const vDist = lm.village && Number.isFinite(lm.village.dist) ? lm.village.dist : Infinity;
            return ((w.opening && w.opening.phase !== 'VILLAGE_HARVEST') || vDist > 32);
        }
        // SLEEP removed as a proposal (★C331: sleep is an instinct, not a task). Case kept
        // harmless in case a stale commitment references it — treated done at daybreak.
        case PROPOSAL_KIND.SLEEP:         return w.time.phase === 'day';
        // ★T-0101/T-0083: HOLD 平时要求 "威胁消失 OR hp>=10" 才 done。但 famineStall(food<=2 不回血
        //   + 无 LETHAL 急症)时 hp 永远 <10(不回血) → HOLD 永不 done → FROZEN-ALIVE。饥饿僵局下视为
        //   done,释放 sticky HOLD commitment,让 commitGoal 重选 GET_FOOD 去觅食。
        case PROPOSAL_KIND.HOLD:          return isFamineStall(w) || !(w.threat.actionable > 0 && w.vitals.hp < 10);
        // ── Task-queue Phase B opportunistic kinds. One-shot grabs (ore/trader/hunt) are open-ended
        //    while live and removed by their trigger.cond/TTL when the opportunity is consumed; the
        //    village/farm ones mirror their proposer twins / the dynamic bread target. ──
        case PROPOSAL_KIND.OPP_SEIZE_VILLAGE: {
            const lm = (w.landmarks) || {};
            const vDist = lm.village && Number.isFinite(lm.village.dist) ? lm.village.dist : Infinity;
            return vDist > 32;   // out of village reach → consumed
        }
        // ★T-0069: done when the bread target is met OR a fresh post-pass cooldown is active (crops
        //   mature over minutes — a finished pass must NOT stay a sticky head and re-dispatch into
        //   unripe plots; the cooldown lets the goal clear so the bot mines/buffers, then re-fires).
        case PROPOSAL_KIND.OPP_WHEAT_FARM:    return invCount(bot, /^bread$/) >= dynamicBreadTarget(bot, w)
                                                  || (bot && Date.now() < (bot._wheatFarmCooldownUntil || 0));
        case PROPOSAL_KIND.OPP_MINE_VEIN_ORE:
        case PROPOSAL_KIND.OPP_TRADER_LEAD:
        case PROPOSAL_KIND.OPP_HUNT_ANIMAL:   return false;   // removed via cond when the locus vanishes
        case PROPOSAL_KIND.SURVIVAL_NIGHT:    return w.time.phase === 'day';
        // ★T-0093 GO_UNDERGROUND is no longer open-ended ("下地→上浮→再下地" churn fix). It's bound to
        //   an OUTPUT goal: stay committed underground until either (a) the iron buffer is stocked, or
        //   (b) the bot has already upgraded to the iron tier (the venture's purpose — iron — is met).
        //   Surfacing/升级 then re-decides into the next rung (armor / diamond) instead of re-descending
        //   to the same band. The surfaceGate + survival emergencies still own preemption/yo-yo limits.
        case PROPOSAL_KIND.GO_UNDERGROUND:
            return hasIronTierPick(w) || ironForArmor(bot) >= IRON_BUFFER;
        // FORAGE_SURFACE / BUILD_HOME / FREE_PLAY are open-ended → re-decide each idle.
        default: return true;
    }
}

/** Emergencies that may PREEMPT a live commitment (else we stay committed). */
function isEmergency(p, world) {
    if (!p) return false;
    // ★T-0101/T-0083: HOLD 平时是 emergency,但 famineStall 下 HOLD 不该再 emergency-preempt
    //   觅食(否则 HOLD 又会从 GET_FOOD/OPENING_VILLAGE 手里抢回身体 → FROZEN-ALIVE 复发)。
    if (p.kind === PROPOSAL_KIND.HOLD) return !isFamineStall(world);         // threat at low hp (除非饥饿僵局)
    // ★T-0101/T-0083 饥饿僵局: 去 village 觅食是唯一食物路径,必须能 preempt 任何 stale commitment
    //   (尤其 stale HOLD)。OPENING_VILLAGE(村近,villageHarvest 自带 hostiles>2/hp<=4 hard-defer)
    //   与 GET_FOOD(村远,feedUp 自带 hostileNear gate)都算救命 emergency,确保 bot 不饿死在原地。
    if (isFamineStall(world)) {
        if (p.kind === TASK.OPENING_VILLAGE || p.kind === PROPOSAL_KIND.GET_FOOD) return true;
    }
    // ★T-0069: GET_FOOD (feedUp) is the starve-now emergency — BUT not when a known village sits
    //   close. feedUp空转s in a food desert, so letting it emergency-preempt the VILLAGE_HARVEST
    //   run (which actually has food: crops + chests) just re-enters the hunger-hold deadlock.
    //   When a village is in reach, harvesting it IS the food path; don't let feedUp steal the body.
    const villageClose = world.landmarks && world.landmarks.village && Number(world.landmarks.village.dist) <= 28;
    if (p.kind === PROPOSAL_KIND.GET_FOOD && world.vitals.food <= 4 && !villageClose) return true; // about to starve, no village
    if (p.kind === PROPOSAL_KIND.MIGRATE && world.migration.inDeathZone) return true;
    return false;
}

/** A dusk/night shelter-or-mine plan. These ONLY appear in the proposal list once
 *  computeNightPlan() fired (i.e. it IS dusk/night), so "a night plan is present" is
 *  itself the night signal. */
function isNightPlan(kind) {
    return kind === PROPOSAL_KIND.DUSK_MINE_NIGHT || kind === PROPOSAL_KIND.DUSK_GO_BED
        || kind === PROPOSAL_KIND.NIGHT_DIG_ONE || kind === PROPOSAL_KIND.NIGHT_SEAL
        || kind === TASK.NIGHT_SMELT_IRON;   // ★T-0097: night iron-conversion is a first-class night plan
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
        // ★T-0081: DUSK/NIGHT plan must DETHRONE a stale NON-night commitment. A daytime task
        // committed before dusk (migrate/scout/bootstrap) holds until isGoalDone — e.g. MIGRATE
        // is "done" only on arriving at a livable biome, so a long march blocks straight through
        // the night while the bot runs exposed and prepNether's legacy fallback steals the night
        // with an expensive seal. isEmergency doesn't cover night plans, so add a narrow rule:
        // if the live commitment is NOT itself a night plan, a night-plan proposal that OUTRANKS
        // it preempts. Outranks-check keeps a genuine emergency (HOLD@95) above the night chain
        // (@91-94); once we ARE on a night plan the !isNightPlan guard stops any re-flip (the
        // chain holds till daybreak via isGoalDone), so no dig_one↔seal yo-yo.
        // ★REGRESSION GUARD (live thrash: feedUp↔nightShelter flip every 1.5s, bot frozen+starving
        // food=1 at night): a night plan must NOT preempt an EMERGENCY commitment. GET_FOOD@88 (food<=4)
        // sits BELOW NIGHT_SEAL@91, so the raw outranks-check below would let the night plan dethrone the
        // food emergency — then isEmergency re-preempts back to GET_FOOD next tick → infinite 2-skill
        // thrash, nothing completes. Emergencies (starving / death-zone migrate / HOLD) own the bot until
        // resolved; night plans only dethrone a NON-emergency, non-night daytime task (the original
        // stale-migrate case: a plain relocate is not isEmergency unless inDeathZone, so it still yields).
        let nightPre = null;
        const cIsEmergency = isEmergency({ kind: c.kind }, w);
        if (!isNightPlan(c.kind) && !cIsEmergency) {
            const livePri = ((proposals || []).find(p => p.kind === c.kind) || {}).priority ?? 50;
            nightPre = (proposals || []).find(p => isNightPlan(p.kind) && (p.priority || 0) > livePri);
        }
        const pre = emergency || nightPre;
        if (pre) {
            // ★ MUST transparently forward the chosen proposal's args into the commitment,
            //   else kernelDriver reads c.args===undefined and nightShelter never gets its
            //   'dig_one'/'seal' mode (挖三填一 silently fails). Default to [] so downstream
            //   spreads/indexes are safe.
            bot._commitment = { kind: pre.kind, skill: pre.skill, args: (pre.args || []), since: Date.now() };
            return { ...pre, committed: true, preemptedFrom: c.kind };
        }
        const live = (proposals || []).find(p => p.kind === c.kind);
        const match = live
            || { kind: c.kind, skill: c.skill, args: (c.args || []), priority: 50, rationale: '(holding commitment)' };
        // Keep bot._commitment.args fresh from the live proposal (it may have re-derived
        // args this tick), else preserve the committed args. Never drop to undefined.
        if (bot && bot._commitment) bot._commitment.args = (match.args || c.args || []);
        return { ...match, committed: true };
    }

    // No commitment, or it's done → commit to the new top-ranked goal.
    if (top) {
        if (bot) bot._commitment = { kind: top.kind, skill: top.skill, args: (top.args || []), since: Date.now() };
        return { ...top, committed: true };
    }
    if (bot) bot._commitment = null;
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// TASK QUEUE (framework-v2 Phase A/B) — design docs/framework-v2-task-queue.md
// commitQueue() is the SUPERSET of commitGoal(): same HEAD-selection (emergency/nightPre/
// stickiness, ALL stabilized fixes preserved verbatim) but it keeps the FULL ranked backlog in
// bot._taskQueue (the old model dropped non-head proposals). In SHADOW (opts.live=false) it builds
// the queue + computes the head for parity logging but does NOT write bot._commitment (commitGoal
// stays authoritative). In LIVE (opts.live=true) it writes the head snapshot to bot._commitment.
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Resolve a task's concrete {skill,args} at dispatch (opp tasks late-bind via resolve()). */
function resolvedSkillArgs(t, w, bot) {
    if (t && typeof t.resolve === 'function') {
        try { const r = t.resolve(w, bot); if (r && r.skill) return { skill: r.skill, args: Array.isArray(r.args) ? r.args : (r.args != null ? [r.args] : []), priority: r.priority }; } catch (e) {}
    }
    return { skill: t.skill, args: Array.isArray(t.args) ? t.args : (t.args != null ? [t.args] : []), priority: t.priority };
}

/** HEAD selection = commitGoal's logic, applied to the queue. H = current active head (sticky). */
function pickHead(q, H, w, bot) {
    if (H && !isGoalDone(H.kind, w, bot)) {
        const emergency = q.find(t => t.kind !== H.kind && isEmergency({ kind: t.kind }, w));
        let nightPre = null;
        const hIsEmergency = isEmergency({ kind: H.kind }, w);
        if (!isNightPlan(H.kind) && !hIsEmergency) {
            const livePri = (q.find(t => t.kind === H.kind) || {}).priority ?? 50;
            nightPre = q.find(t => isNightPlan(t.kind) && (t.priority || 0) > livePri);
        }
        return emergency || nightPre || H;
    }
    // H done or absent → highest effective-priority queued task
    const eff = (t) => (t.position === 'head' ? 100000 : t.position === 'tail' ? -100000 : 0) + (t.priority || 0);
    return q.slice().sort((a, b) => eff(b) - eff(a))[0] || null;
}

/** Put head at index 0 (status active); order the rest by effective priority desc. */
function sortQueue(q, head) {
    if (!head) return;
    for (const t of q) { if (t.status === 'active' && t !== head) t.status = 'queued'; }
    if (head.status !== 'active') { head.status = 'active'; head.since = Date.now(); }
    const eff = (t) => (t.position === 'head' ? 100000 : t.position === 'tail' ? -100000 : 0) + (t.priority || 0);
    q.sort((a, b) => { if (a === head) return -1; if (b === head) return 1; return eff(b) - eff(a); });
}

/**
 * Reconcile the task queue from the fresh proposal ranking + preserved opportunistic tasks.
 * @param {object} opts {live:boolean} — live writes bot._commitment; shadow only builds the queue.
 * @returns {{head:Task|null, hsnap:object|null}}
 */
export function commitQueue(bot, proposals, world, opts = {}) {
    const w = world || (bot && bot._world) || EMPTY_WORLD;
    const live = !!opts.live;
    const insertAllowed = !!opts.insert;   // taskqInsert flag — backlog + opportunistic survive
    if (!bot._taskQueue) bot._taskQueue = tq.makeQueue();
    const q = bot._taskQueue;

    // 0. continuity: seed the active head from the existing commitment on first run.
    let H = q.find(t => t.status === 'active') || null;
    if (!H && bot._commitment && bot._commitment.kind) {
        const seed = tq.makeTask({ kind: bot._commitment.kind, skill: bot._commitment.skill, args: bot._commitment.args, priority: 50, source: 'proposer' }, Date.now());
        seed.status = 'active'; seed.since = bot._commitment.since || Date.now();
        q.unshift(seed); H = seed;
    }

    // ★OPP NO-PROGRESS BACKSTOP (general anti-freeze): an opportunistic head whose skill no-ops on an
    //   unreachable/stale/empty locus re-dispatches every ~1.5s → the bot freezes (live: ore@y58 / a
    //   bogus y21 village both pinned the bot 450s). The per-opp gates+TTLs catch most, but this is the
    //   universal guard: if an OPP_* head has been active >12s with the bot essentially not moving, drop
    //   it (the _oppXSeen cooldown then blocks re-insert). Movement resets the timer, so a genuinely
    //   PROGRESSING opp (mining a vein, walking to a village) is never cut off. Only fires on OPP_ tasks,
    //   which never exist when taskqInsert is OFF → Phase A parity is unaffected.
    try {
        if (H && /^OPP_/.test(H.kind) && bot.entity && bot.entity.position) {
            const p = bot.entity.position;
            const tr = bot._oppHeadTrack || (bot._oppHeadTrack = {});
            if (tr.id !== H.id) { tr.id = H.id; tr.x = p.x; tr.y = p.y; tr.z = p.z; tr.since = Date.now(); }
            else if (Math.hypot(p.x - tr.x, p.y - tr.y, p.z - tr.z) > 1.5) { tr.x = p.x; tr.y = p.y; tr.z = p.z; tr.since = Date.now(); }
            else if (Date.now() - tr.since > 12000) { tq.remove(q, H.id); H = null; tr.id = null; }
        }
    } catch (e) {}

    // 1. RE-SEED proposer tasks (dedup by kind, refresh priority+args). FREE_PLAY only when queue
    //    would otherwise be empty (mirrors commitGoal's top=FREE_PLAY fallback).
    const proposerKinds = new Set();
    const nonFreeProposals = (proposals || []).filter(p => p.kind !== PROPOSAL_KIND.FREE_PLAY);
    for (const p of nonFreeProposals) {
        proposerKinds.add(p.kind);
        tq.enqueueByPriority(q, tq.makeTask({ kind: p.kind, skill: p.skill, args: p.args, priority: p.priority, rationale: p.rationale, source: 'proposer', position: 'priority' }, Date.now()));
    }
    // remove proposer tasks whose proposal vanished — unless it's the sticky active head not yet done.
    for (let i = q.length - 1; i >= 0; i--) {
        const t = q[i];
        if (t.source !== 'proposer') continue;
        if (!proposerKinds.has(t.kind)) {
            if (t === H && !isGoalDone(t.kind, w, bot)) continue;   // stickiness: hold the live head
            q.splice(i, 1);
        }
    }
    // FREE_PLAY only if queue empty
    if (!q.length) {
        const fp = (proposals || []).find(p => p.kind === PROPOSAL_KIND.FREE_PLAY);
        if (fp) tq.enqueueByPriority(q, tq.makeTask({ kind: fp.kind, skill: fp.skill, args: fp.args, priority: fp.priority, rationale: fp.rationale, source: 'proposer' }, Date.now()));
    }

    // 2. opportunistic/llm tasks: drop those whose insert flag is off (shadow purity) or whose
    //    trigger.cond is now false (the opportunity passed).
    for (let i = q.length - 1; i >= 0; i--) {
        const t = q[i];
        if (t.source !== 'opportunistic' && t.source !== 'llm') continue;
        if (!insertAllowed) { if (t !== H) q.splice(i, 1); continue; }
        try { if (t.trigger && typeof t.trigger.cond === 'function' && !t.trigger.cond(w, bot)) { if (t !== H) q.splice(i, 1); } } catch (e) {}
    }

    // 3. HEAD selection (preserved commitGoal logic) + 4. sort.
    const head = pickHead(q, H, w, bot);
    sortQueue(q, head);

    // 5. write head snapshot (telemetry always; bot._commitment only when LIVE).
    let hsnap = null;
    if (head) {
        const ra = resolvedSkillArgs(head, w, bot);
        hsnap = { kind: head.kind, skill: ra.skill, args: ra.args, since: head.since || Date.now(), id: head.id };
    }
    try { if (bot._world) bot._world.taskQueue = q.map(tq.slim); } catch (e) {}
    if (live && bot) bot._commitment = hsnap;
    return { head, hsnap };
}

/**
 * Splice an opportunistic task into the queue (design §5). Gated by the trigger lifecycle
 * (shouldFire) + the per-spec cond. Dedup by kind#locus so two veins coexist but one vein
 * never double-enqueues. position 'head' raises interrupt_code for ≤1s preemption.
 */
export function spliceOpportunistic(bot, spec) {
    try {
        if (!bot._taskQueue) bot._taskQueue = tq.makeQueue();
        const q = bot._taskQueue;
        const w = (bot && bot._world) || EMPTY_WORLD;
        const trigger = {
            source: 'opportunistic',
            cond: spec.cond || null,
            lifecycle: spec.lifecycle || 'one_shot',
            episodeId: spec.episodeId || null,
            vetoedUntil: 0,
            until: spec.until || 0,
            lifecycleScope: spec.lifecycleScope || 'node',
        };
        const t = tq.makeTask({ kind: spec.kind, skill: spec.skill, args: spec.args, resolve: spec.resolve, priority: spec.priority, position: spec.position || 'priority', source: 'opportunistic', rationale: spec.rationale, locus: spec.locus, trigger }, Date.now());
        // dedup: if already queued/active, just refresh (no double-insert)
        if (tq.find(q, t.id)) { return tq.find(q, t.id); }
        // NOTE: position only affects QUEUE order — it NEVER raises bot.interrupt_code here. In SHADOW
        // (taskqLive OFF) the queue is observe-only and must not perturb the live commitGoal-dispatched
        // skill; in LIVE (Phase C) the kernelDriver head-change interrupt-watcher detects the new head and
        // raises interrupt_code itself. Raising it here would leak behaviour into the shadow.
        if (spec.position === 'head') tq.enqueueHead(q, t);
        else if (spec.position === 'before-current') { const h = tq.peekHead(q); if (h) tq.insertBefore(q, h.id, t); else tq.enqueueHead(q, t); }
        else if (spec.position === 'tail') tq.enqueueTail(q, t);
        else tq.enqueueByPriority(q, t);
        return t;
    } catch (e) { return null; }
}

/** World-model validity of a task that just returned to the head (design §3.4). Ignores the
 *  firedKey dedup (THIS task IS that fire) but respects condition + goal-done + cancel ledger. */
export function stillValid(task, world, bot) {
    try {
        if (isGoalDone(task.kind, world, bot)) return false;
        const tr = task.trigger || {};
        if (typeof tr.cond === 'function' && !tr.cond(world, bot)) return false;
        if (tr.until && Date.now() < 0) return false; // (until handled via cooldown elsewhere)
        return true;
    } catch (e) { return true; }
}

/** Re-evaluate the head before re-dispatch (design §3.4): world validity + (stubbed) LLM gate +
 *  dynamic re-resolve. Returns {keep, reason, task?}. */
export async function reevaluateHead(task, world, bot) {
    if (!task) return { keep: false, reason: 'no-task' };
    if (!stillValid(task, world, bot)) return { keep: false, reason: 'world-invalidated' };
    if (llmGateEnabled()) {
        const verdict = await llmGate(task, world, bot, 'head-return-reeval');
        if (verdict && !verdict.proceed && verdict.cancel) return { keep: false, reason: 'llm-cancel' };
    }
    const ra = resolvedSkillArgs(task, world, bot);
    if (!ra.skill) return { keep: false, reason: 'resolve-empty' };
    return { keep: true, reason: 'revalidated', task: { ...task, skill: ra.skill, args: ra.args, priority: ra.priority ?? task.priority } };
}

/** Does the held pick tier satisfy mining an ore subtype? cobble/coal need stone+; iron needs
 *  stone+; diamond needs iron+. (mirrors collectBlock PICK_REQ gate skills.js:888.) */
export function pickTierSatisfies(bot, oreMeta) {
    try {
        const items = bot.inventory.items();
        const tierOf = (n) => /netherite/.test(n) ? 5 : /diamond/.test(n) ? 4 : /iron/.test(n) ? 3 : /stone/.test(n) ? 2 : /(wooden|golden)/.test(n) ? 1 : 0;
        const best = items.filter(i => /_pickaxe$/.test(i.name || '')).reduce((m, i) => Math.max(m, tierOf(i.name)), 0);
        if (/diamond/.test(oreMeta || '')) return best >= 3;   // diamond ore needs iron+
        return best >= 2;                                       // iron ore needs stone+
    } catch (e) { return false; }
}

/** Dynamic stop for the wheat-farm bread accumulation (design §5.3 #5B). Returns target bread count. */
export function dynamicBreadTarget(bot, world) {
    try {
        const w = world || (bot && bot._world) || EMPTY_WORLD;
        // ★T-0069 bed-gate removal: the old `if(!bedKnown) return 0` was a HARD second gate that
        // killed the wheat-farm entirely during bootstrap (no bed yet → target 0 → OPP_WHEAT_FARM
        // isGoalDone=bread>=0 instantly true → never dispatched). The bed is a respawn-anchor
        // doctrine, not a FARMING precondition — you can till+sow+harvest+bake with zero bed. The
        // real precondition is having something to farm WITH: seeds in the bag (to sow/keep a plot)
        // OR mature wheat already growing nearby (to harvest+bake). Without either, the skill no-ops,
        // so a 0 target there just avoids a pointless dispatch — but a bed is no longer required.
        const canFarm = invCount(bot, /^wheat_seeds$/) > 0 || invCount(bot, /^wheat$/) >= 3;
        if (!canFarm) return 0;                                        // no seeds & no wheat → nothing to bake
        const breadStock = invCount(bot, /^bread$/);
        const armor = (w.vitals && w.vitals.armor) || 0;
        const pickTier = (w.kit && w.kit.pickTier) || 'none';
        const wood = woodUnits(bot);
        let base = 6;
        if (armor < 4) base += 4;                                       // pre-armor: bread is staple → stock more
        else if (/iron|diamond|netherite/.test(pickTier)) base -= 2;    // late: other food plentiful
        if (wood < WOOD_BUFFER || ((w.kit && w.kit.picks) || 0) < 1) base -= 3; // bootstrap unfinished
        if (w.migration && w.migration.recommend) base = Math.min(base, 2);     // about to relocate
        let freeSlots = 0; try { freeSlots = bot.inventory.emptySlotCount(); } catch (e) { freeSlots = 9; }
        if (freeSlots < 6) base = Math.min(base, breadStock);          // pack nearly full → stop hoarding
        if ((w.vitals && w.vitals.food || 20) < 8) base += 2;          // hungry now → bake a couple more
        return Math.max(0, Math.min(base, 14));                        // never hoard > 14
    } catch (e) { return 0; }
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
