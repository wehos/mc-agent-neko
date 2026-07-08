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

import { EMPTY_WORLD, PROPOSAL_KIND, foodInstinctsEnabled, hpInstinctsEnabled } from './contracts.js';
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
// ★2026-07-08 两态承诺锁 (opening churn 修): 开局提案 OPENING_SCOUT@92 与 BOOTSTRAP_KIT@90 只差 2,
//   commitGoal 释放(isGoalDone 闪真)后重选会在两者间翻转 → bot 左右乱晃。用户令: 决策进入"进行态"
//   立即抬权焊死。进行态 = bot._commitment.kind 命中某开局 kind → 出表排序前给它 +BOOST, 令重选必再赢
//   同一目标, 不翻给对手。仅影响开局 kind 的相对排名; 失败冷却(上方 cd 过滤)仍能撤下真失败的档 → 不会
//   把坏选择永久焊死。见 docs/ 或 [[chopwood-high-tree-nopick-cliff]]。
const OPENING_COMMIT_BOOST = 8;
// ── ★T-0093/T-0092 tier-chain buffers ("要有富余不是刚够" 从木/食扩到铁/钻). The bot stays
//    committed to a tier's underground venture until it has banked a BUFFER, not the bare minimum,
//    so it升级 once (and brings spares) instead of下地→上浮→再下地 thrashing. const→let so the
//    decision-config loader can patch them later if needed. ──
let IRON_BUFFER = 7;       // ironForArmor (raw_iron+ingot) to stock at the iron tier: 1 pick(3)+1 sword(2)+spares→armor next
let DIAMOND_FLOOR = 3;     // diamonds to bank before the FIRST diamond pickaxe is crafted (≥1 pick + spare)
// ★2026-07-06 用户令 (钻石滚雪球, [[spec-pickaxe-stockpile-redesign]]): 得钻镐后继续高优挖钻到 40 颗
//   (全套钻甲24 + 3钻镐9 + 3备用3 + 余量) 再转杀龙 endgame。GET_DIAMOND 相位化: 无钻镐→DIAMOND_FLOOR
//   够本造首镐; 有钻镐→DIAMOND_SNOWBALL_TARGET 且优先级抬到 endgame 之上 (见 diamondTarget/GET_DIAMOND)。
let DIAMOND_SNOWBALL_TARGET = 40;
// ── ★ENDGAME tunables (post-diamond → Ender Dragon chain, all legit). const→let so the
//    decision-config loader can patch them like the survival buffers above. ──
let OBSIDIAN_TARGET = 14;  // 10 frame minimum + 4 spare to rebuild a ghast-broken portal
let EYE_TARGET_DEFAULT = 14; // eyes of ender to stock: 12 frames + throw-losses (~20% break) + triangulation throws
let BLAZE_ROD_TARGET = 7;  // 7 rods = 14 blaze powder = 14 eyes (matches EYE_TARGET_DEFAULT)
// ── ★T-0092 depth bands (区分采铁 vs 采钻 两个深度目标, 别让 mineDown 用默认 targetY=45 浅带). ──
const IRON_TARGET_Y = 14;  // iron/coal band: y8..y16 sweet spot for iron (1.21 wide-distribution)
const DIAMOND_TARGET_Y = -54; // diamond band: y-54..-59 peak; bedrock at y-64 (1.21) — stay above it
// ── ★P0-1 REPLENISH_KIT 补给不变量 (review-2026-07-04-distance.md 结构洞#1: 木→棍/台→镐链没有
//    一等 kind, 只作为前置 gate 散落在消费技能里; buffer 地下归零 → 消费者集体 yield →
//    BOOTSTRAP_KIT 冷却 162 次 + GET_FOOD 121 次的 36h 轮转风暴)。迟滞防抖: planksEq <TRIGGER
//    触发, >=RELEASE 才释放(isGoalDone), 免得 4↔5 边界抖动轮转。 ──
const REPLENISH_PICKS_MIN = 3;       // 总镐数底线(备镐不变量): <3 触发, >=3 才算 done
                                     // ★2026-07-05 2→3: 实测 2 根石镐(262耐久)撑不到下次补给窗口,
                                     // 镐尽→徒手困地下→SURFACE_RESCUE→再补给, 20-40min/次已复发两轮。
                                     // 技能端 replenishKit.js:85/162/200/211 已同步 3镐/16板口径。
const REPLENISH_PLANKS_TRIGGER = 4;  // planks-equivalent 跌破即触发
const REPLENISH_PLANKS_RELEASE = 64; // 释放需回补到的 buffer (迟滞: 触发<4, 释放>=64)
                                     // ★2026-07-05 用户宽迟滞令: "低于5开始、64才停, 其他资源类推" —
                                     // 窄带(触发≈释放)正是窗口切碎的根源; 宽带让 kind 拿到窗口后
                                     // commitGoal 粘性长期锁定, churn 消失而救命反射仍可打断。
                                     // 64 planksEq = 16 logs ≈ 一组木的一半, 囤积形态以 log 为主(密度4x)。
// ── ★P1-5 BANK_GEAR 提案端停用开关 (review-2026-07-04-distance.md 结构洞#5)。
//    keepInventory=true 下死亡不掉落, "存箱防死丢投资"的前提为假; 实测纯负价值三连:
//      · bankGear RAW 正则 ^diamond$ 把钻石吞进箱, 而 craftChain/endgameNeeds 只数背包不读箱子
//        → mine→bank→re-mine 死环 (GET_DIAMOND_GEAR 永远看不到已入箱的钻);
//      · MAT 表把 cobble 削到 16, 但 ENTER_NETHER 门要 32、GO_END 门要 64 → 存完立刻不达标;
//      · 07-02 实锤: 13 锭铁入家箱后箱子 ghost 蒸发, 库存直接清零。
//    kind/isGoalDone case/技能文件全保留(不删代码), 只门掉 proposeTasks 的 push。
//    重开条件: 服务器 keepInventory 关闭(死亡真掉落)时翻回 true, 且须先修 bankGear 的 RAW/MAT
//    口径(钻石不进 RAW、cobble/logs 保留量对齐 endgame 门槛)再开。 ──
const BANK_GEAR_ENABLED = false;

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
            if (Number.isFinite(cfg.obsidianTarget)) OBSIDIAN_TARGET = cfg.obsidianTarget;
            if (Number.isFinite(cfg.eyeTargetDefault)) EYE_TARGET_DEFAULT = cfg.eyeTargetDefault;
            if (Number.isFinite(cfg.blazeRodTarget)) BLAZE_ROD_TARGET = cfg.blazeRodTarget;
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
/** Carried takeaway rations (safe edibles incl. raw red meat — a hunt's drops count).
 *  ONE predicate for: the dive gates (>=2 to descend), GET_FOOD's re-arm condition,
 *  and isGoalDone(GET_FOOD) — checkpoint #7 caught the gate demanding what no
 *  proposal could supply when these were separate hunger-only checks. */
export function carriedRations(bot) { return invCount(bot, /^(cooked_\w+|bread|apple|baked_potato|carrot|beef|porkchop|mutton)$/); }
// Smeltable+smelted iron on hand (ingot-equivalents). raw_iron smelts 1:1 → iron_ingot, so both
// count toward what GET_ARMOR can turn into armor pieces (boots4 helmet5 leggings7 chestplate8).
export function ironForArmor(bot) { return invCount(bot, /^raw_iron$/) + invCount(bot, /^iron_ingot$/); }
// ★review craftArmor:60/:92 — GET_ARMOR/GET_IRON_ARMOR_SET gate+release on the cheapest MISSING
// piece, not a flat 4. craftArmor crafts cheapest-first (boots 4 → helmet 5 → leggings 7 →
// chestplate 8 ingots), so with k pieces owned the NEXT piece costs COST[k]; the old flat
// `ironForArmor<4` left banked iron in [4, nextCost) holding the goal sticky against a craft
// pass that can afford NOTHING — a hot 2s dispatch-spin above the whole tier/endgame chain.
// vitals.armor already counts held+worn pieces (modes.js armor builder scans inventory AND
// slots 5-8), which is the review-sanctioned approximation; mixed-order sets (e.g. looted
// chestplate first) only make the release EARLIER, never sticky.
const ARMOR_PIECE_COST = [4, 5, 7, 8];   // ingots for the k-th piece, cheapest-first
function ironArmorGoalDone(world, bot) {
    const pieces = Math.min(4, (world.vitals && world.vitals.armor) || 0);
    if (pieces >= 4) return true;
    return ironForArmor(bot) < ARMOR_PIECE_COST[pieces];
}
// ★P0-1 REPLENISH_KIT 口径: 背包内全部镐(含快断的) — 粗基线补给不变量, 与技能端 replenishKit 的
// "总镐数"死契约一致。"有效镐"(耐久<85%)的精细不变量归 kit.picks/TOOL_UPKEEP, 两者分工不冲突。
function totalPicks(bot) { return invCount(bot, /_pickaxe$/); }
// ── ★2026-07-06 用户令 tier 参数化囤镐 ([[spec-pickaxe-stockpile-redesign]]) ──
// "有效镐" = 耐久用量 <85% (镜像 modes.js kit / skills.pickRunway 的 effective 口径 — 快断的不算库存)。
function effectivePicksMatching(bot, re) {
    try {
        return bot.inventory.items().filter(i => {
            if (!re.test(i.name || '')) return false;
            const max = i.maxDurability || 0, used = (typeof i.durabilityUsed === 'number') ? i.durabilityUsed : 0;
            return !max || (used / max) < 0.85;
        }).reduce((s, i) => s + i.count, 0);
    } catch (e) { return 0; }
}
// tier 囤镐计划: 石阶段=沿用总镐>=3 (fodder, plan=null); 铁阶段=囤 4 铁镐(触发 有效铁镐≤1);
// 钻阶段=囤 3 钻镐(触发 有效钻镐<3)。re 指该 tier 镐; target 释放线; triggerFloor 触发线(<它就补)。
// 停造(木/石)由执行端 replenishKit ④ 依 tier 处理 — 这里只管"够不够/该补多少"的提案侧口径。
function pickStockPlan(world) {
    const pt = (world.kit && world.kit.pickTier) || '';
    if (/diamond|netherite/.test(pt)) return { tier: 'diamond', re: /^(diamond|netherite)_pickaxe$/, target: 3, triggerFloor: 3, craft: 'diamond_pickaxe' };
    if (/iron/.test(pt)) return { tier: 'iron', re: /^iron_pickaxe$/, target: 4, triggerFloor: 2, craft: 'iron_pickaxe' };
    return null;   // stone/none: legacy total-picks>=3 fodder floor governs (byte-identical to pre-change)
}
// ★review 2026-07-06: 手头材料能否再造一把本 tier 镐 — 提案触发(_planMat)与 isGoalDone 释放(tierMatShort)
//   共用这一个真相 (否则触发/释放材料口径不一致 → 造到不足 target 又停不下的 5min-cooldown churn, 复现
//   TOOL_UPKEEP 的材料耗尽释放教训)。铁镐: 3 锭, 或 raw_iron+锭>=3 且有燃料(replenishKit ④-pre 冶炼);
//   钻镐: 3 钻。executor(replenishKit ④/④-pre) 的造镐门与此严格同口径。
function pickPlanHasMat(bot, plan) {
    if (!plan) return false;
    if (plan.tier === 'diamond') return invCount(bot, /^diamond$/) >= 3;
    return invCount(bot, /^iron_ingot$/) >= 3
        || (ironForArmor(bot) >= 3 && (invCount(bot, /^coal$/) > 0 || invCount(bot, /^charcoal$/) > 0));
}
// ★P1-4 铁供给断层 (review-2026-07-04 结构洞#4): 剩余缺甲件总成本 = 从已有件数起按 cheapest-first
// 顺序累加还缺的每件 (armor=0 → 4+5+7+8=24; armor=4 → 0)。与 craftArmor 的 cheapest-first 同口径,
// 与 ironArmorGoalDone 的"下一件"口径互补: 那是消费端(craft)释放判据, 这是采集端(挖矿)总需求。
function ironArmorRemainingCost(world) {
    const pieces = Math.min(4, (world.vitals && world.vitals.armor) || 0);
    let cost = 0;
    for (let k = pieces; k < 4; k++) cost += ARMOR_PIECE_COST[k];
    return cost;
}
// ★P1-4 + review OPEN finding gatherObsidian.js:70: portal kit 的铁成本 = (无桶?3:0)+(无打火石?1:0),
// 与 gatherObsidian:44 的 ironShort 完全同口径(空桶也算持有 — 技能会自己装水)。只在 rank-4 卡黑曜石
// 阶段计入(hasDiamondPick && blazeShort>0 && !obsOk — 与 GET_PORTAL_KIT 提案门同一判据), 其余阶段 0。
function portalKitIronCost(bot) {
    const n = endgameNeeds(bot);
    if (!(n.hasDiamondPick && n.blazeShort > 0 && !n.obsOk)) return 0;
    let cost = 0;
    if (invCount(bot, /^(water_)?bucket$/) < 1) cost += 3;      // 桶 = 3 锭
    if (invCount(bot, /^flint_and_steel$/) < 1) cost += 1;      // 打火石 = 1 锭 + 1 flint
    return cost;
}
// ★P1-4 铁需求总口径 = max(缺甲总成本, portal kit 铁成本) — 任务4授权的扩展: 甲齐但 GET_PORTAL_KIT
// 被铁预检挡住时, 同一个 GET_IRON_ARMOR_SET 继续供铁, 复用一个采集 kind 比新造 kind 干净。
// 提案门与 isGoalDone 共用本函数(本文件 house idiom: 一个判据, 两个消费者, 永不打架)。
function ironDemandTotal(world, bot) {
    return Math.max(ironArmorRemainingCost(world), portalKitIronCost(bot));
}
// ★review OPEN gatherObsidian.js:70 铁预检的 flint 侧: 打火石还差时必须有可见的 flint/gravel 来源
// 才放行 GET_PORTAL_KIT (gatherObsidian 自己在 32 格内挖 gravel 摇 flint — 同半径同口径)。
// findBlock 扫描 30s memo 挂 bot._*(热重载红线: 零模块级可变量), 且只在 rank-4 portal-kit 阶段被
// 求值, 代价可控。扫描异常按 false 处理 — 宁可不提案也不派一个注定 false→3-strike→冷却的技能。
// ★评审修正 (2026-07-04): 背包 gravel 不算来源 — gatherObsidian STEP A 的摇 flint 循环只认
// 32 格内的 gravel 方块 (getNearestBlock 找不到即 break, re-place 分支只在挖到过方块后可达),
// 背包 gravel 永远到不了执行端; 且 prepNether capSurplus 把 gravel CAP 到 0, 持有量随时被清成
// 信号抖动。按它放行 = 预检自己造出注定 false→3-strike→5min 的轮转。背包 flint 保留 (STEP A
// 直接跳过挖砾石段, 真同口径)。
function flintSourceSignal(bot) {
    try {
        if (invCount(bot, /^flint$/) >= 1) return true;
        const memo = bot && bot._gravelScanMemo;
        if (memo && Date.now() - memo.at < 30000) return memo.v;
        let v = false;
        try {
            const b = bot && bot.findBlock && bot.findBlock({ matching: (bl) => !!(bl && bl.name === 'gravel'), maxDistance: 32, count: 1 });
            v = !!b;
        } catch (e) { v = false; }
        if (bot) bot._gravelScanMemo = { at: Date.now(), v };
        return v;
    } catch (e) { return false; }
}
// ★节流 progress 观测 helper: 提案端每 2s tick 重算, 裸 log 会刷爆 progress.txt — 按 key 节流
// (state 挂 bot._* 遵守热重载红线)。新提案逻辑的可观测日志统一走这里。
function progressLogThrottled(bot, key, ms, line) {
    try {
        if (!bot) return;
        if (!bot._wmLogAt) bot._wmLogAt = {};
        if (bot._wmLogAt[key] && Date.now() - bot._wmLogAt[key] < ms) return;
        bot._wmLogAt[key] = Date.now();
        appendFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../bots/_supervisor/progress.txt'),
            `[${new Date().toISOString()}] ${line}\n`);
    } catch (e) {}
}
function hasStoneTierPick(world) { return /stone|iron|diamond|netherite/.test((world.kit && world.kit.pickTier) || ''); }
function diamondsOnHand(bot) { return invCount(bot, /^diamond$/); }
// ★2026-07-06 钻石相位目标: 无钻镐 → DIAMOND_FLOOR(够本造首镐即释放); 有钻镐 → DIAMOND_SNOWBALL_TARGET(滚雪球)。
function diamondTarget(bot) { return invCount(bot, /^(diamond|netherite)_pickaxe$/) >= 1 ? DIAMOND_SNOWBALL_TARGET : DIAMOND_FLOOR; }
// ★2026-07-06 钻甲件数(穿戴 slots 5-8 + 背包持有), 供 GET_DIAMOND_ARMOR 提案/isGoalDone。invCount 只数背包不数穿戴, 故单列。
function diamondArmorPieces(bot) {
    try {
        let n = 0;
        const sl = (bot && bot.inventory && bot.inventory.slots) || [];
        for (let i = 5; i <= 8; i++) if (sl[i] && /^diamond_(helmet|chestplate|leggings|boots)$/.test(sl[i].name || '')) n++;
        return n + invCount(bot, /^diamond_(helmet|chestplate|leggings|boots)$/);
    } catch (e) { return 0; }
}
// 钻甲提案门/释放的钻石阈值: 至少够最便宜件(4) + 镐保留(未囤够3钻镐前留9钻给镐)。与 craftArmor{diamond} 的 _matBudget 同口径。
function diamondArmorFloor(bot) { return 4 + (invCount(bot, /^(diamond|netherite)_pickaxe$/) >= 3 ? 0 : 9); }   // ★review: 含 netherite(同 pickStockPlan 口径)
// ★2026-07-06 钻石装备齐(3 有效钻镐 + 4 钻甲) → 雪球停 (别造完装备后还回挖补满 40; 用户令 40=装备+余量, 非常驻40)。
function diamondGearComplete(bot) { return effectivePicksMatching(bot, /^(diamond|netherite)_pickaxe$/) >= 3 && diamondArmorPieces(bot) >= 4; }
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

// ─────────────────────────────────────────────────────────────────────────────
// ★ENDGAME helpers (post-diamond → Ender Dragon, all legit — no server commands).
// ─────────────────────────────────────────────────────────────────────────────
/** Which dimension is the bot in? Regex like realNetherPortal.js:23 — mineflayer may
 *  report 'minecraft:the_nether' / 'the_nether' depending on version. Defensive: an
 *  unreadable bot.game defaults to 'overworld' (the safe/identical-to-today branch). */
export function dimOf(bot) {
    const d = String((bot && bot.game && bot.game.dimension) || 'overworld');
    return /nether/.test(d) ? 'the_nether' : /end/.test(d) ? 'the_end' : 'overworld';
}
/**
 * Lazy-load bots/_supervisor/endgame.json ONCE onto bot._endgame and return it.
 * Skills keep it fresh (they write BOTH the file and bot._endgame via the shared
 * skills.egPatch); a watchdog restart re-loads from file so irreversible milestones
 * (netherEntered/strongholdKnown/portalRoom/endPortalReady/dragonDead) survive restarts
 * and deaths. BOM-safe read; missing file ⇒ {} (the expected fresh-world default).
 * Per HANDOFF red line: state on the bot object + file, ZERO module-level mutables
 * (hot-reload resets module scope). endEntered was dropped (written-never-read; derive
 * the-End presence from bot.game.dimension instead — it can't drift after a respawn).
 * Fields: {netherEntered, netherPortalOverworld:{x,y,z}, netherPortalNether:{x,y,z},
 *          strongholdEst:{x,z}, strongholdKnown, portalRoom:{x,y,z}, framesEmpty,
 *          strongholdDigFails, endPortalReady, dragonDead, ts}
 */
export function endgameState(bot) {
    if (!bot) return {};
    if (bot._endgame && typeof bot._endgame === 'object') return bot._endgame;
    // eg stays null on a TRANSIENT failure (EBUSY/EPERM read error, torn/corrupt JSON mid-write):
    // we must NOT memoize {} then — the early-return above would serve the empty cache for the
    // whole process, hiding strongholdKnown/portalRoom/endPortalReady until a skill re-patches.
    // Only a genuinely ABSENT file (ENOENT = fresh world) caches the {} default; anything else
    // logs (throttled) and retries the read next call.
    let eg = null;
    const warn = (msg) => {
        try {
            if (bot._egReadWarnAt && Date.now() - bot._egReadWarnAt < 60000) return;   // throttle: uncached state retries every ~2s tick
            bot._egReadWarnAt = Date.now();
            appendFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../bots/_supervisor/progress.txt'),
                `[${new Date().toISOString()}] world_model.js endgame.json ${msg}\n`);
        } catch (e2) {}
    };
    try {
        const p = resolve(dirname(fileURLToPath(import.meta.url)), '../../../bots/_supervisor/endgame.json');
        let raw = null;
        try { raw = readFileSync(p, 'utf8'); }
        catch (e) {
            if (e && e.code === 'ENOENT') eg = {};                         // missing file = fresh world (safe to cache)
            else warn(`read FAILED (transient, will retry): ${e && e.message}`);
        }
        if (raw != null) {
            if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);          // strip UTF-8 BOM (C251 lesson)
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') eg = parsed;
            } catch (e) {
                // A CORRUPT endgame.json must be visible, not a silent milestone wipe.
                warn(`parse FAILED (not caching {}, will retry): ${e && e.message}`);
            }
        }
    } catch (e) {}
    if (eg != null) bot._endgame = eg;
    return bot._endgame || eg || {};
}
/**
 * Single source of truth for endgame item shortfalls — shared by computeTier, the
 * proposeTasks gates, and isGoalDone (same idiom as isFamineStall: one predicate,
 * three consumers, so proposer/completion never disagree).
 */
export function endgameNeeds(bot) {
    // ★review :279 — computeTier + proposeTasks + isGoalDone all recompute this on the SAME ~2s
    // decide tick (up to 4x, 7 invCount regex scans each). Memoize on the bot for 1s (state on
    // bot._* per the HANDOFF red line — no module-level mutables): one compute per tick shared by
    // every consumer; the TTL is well under the 2s tick so cross-tick reads always recompute.
    const memo = bot && bot._egNeedsMemo;
    if (memo && (Date.now() - memo.at) < 1000) return memo.v;
    const eyes = invCount(bot, /^ender_eye$/), pearls = invCount(bot, /^ender_pearl$/),
          powder = invCount(bot, /^blaze_powder$/), rods = invCount(bot, /^blaze_rod$/);
    const eg = endgameState(bot);
    // Portal already lit ⇒ no more eyes needed; frames counted ⇒ only fill the empties (+2 slack).
    const eyeTarget = eg.endPortalReady ? 0
        : (Number.isFinite(eg.framesEmpty) ? Math.min(EYE_TARGET_DEFAULT, eg.framesEmpty + 2) : EYE_TARGET_DEFAULT);
    const eyesShort = Math.max(0, eyeTarget - eyes);
    const craftable = Math.min(pearls, powder + rods * 2);                    // eyes we could craft right now
    const blazeShort = Math.max(0, eyesShort - (powder + rods * 2));          // blaze-side shortfall (held eyes count via eyesShort)
    const pearlsShort = Math.max(0, eyesShort - pearls);
    const hasDiamondPick = invCount(bot, /^(diamond|netherite)_pickaxe$/) >= 1;
    const obsOk = invCount(bot, /^obsidian$/) >= 10 && invCount(bot, /^flint_and_steel$/) >= 1;
    const v = { eyes, pearls, powder, rods, eyeTarget, eyesShort, craftable, blazeShort, pearlsShort, hasDiamondPick, obsOk };
    if (bot) bot._egNeedsMemo = { at: Date.now(), v };
    return v;
}

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
    // 饥饿惰性 (用户定调 2026-07-08): 默认 (MC_FOOD_INSTINCTS off) 饥饿不驱动任何行为 —
    //   饥荒僵局不成立, 常规防御 HOLD 照常生效, 也不写 famine-forage-unlock 日志。饿死无所谓。
    if (!foodInstinctsEnabled()) return false;
    const v = w.vitals || {};
    return !lethalEnvThreat(w) && (v.food || 0) <= 2 && (v.hp || 20) < 10 && !v.canRegen;
}
// ★2026-07-06 oracle 制导采矿: ore-oracle 的最近矿坐标 (新鲜 <10min 且平距 <250 才可用;
//   缺失/陈旧 → null, 调用方回退盲挖)。key ∈ {iron, coal, diamonds}。
function oracleOreTarget(w, key, yMax = Infinity) {
    try {
        const oo = w && w.oracleOres;
        if (!(oo && Array.isArray(oo[key]) && oo[key].length && Date.now() - (oo.ts || 0) < 600000)) return null;
        // yMax: 夜挖只要地下带目标 (山面矿=夜间地表裸采) — 列表按距排序, 取首个达标者
        const c0 = oo[key].find(c => c && c.y <= yMax);
        if (!c0) return null;
        // 距离闸用扫描原点 botPos (RESCAN_DIST=48 内与真位等效): w.vitals 不带坐标
        const bp = oo.botPos || c0;
        if (Math.hypot(c0.x - bp.x, c0.z - bp.z) >= 250) return null;
        return c0;
    } catch (e) { return null; }
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
    // ★ENDGAME telemetry inputs (cheap invCounts; also drive the rank>=4 ladder below).
    const n = endgameNeeds(bot);
    const eg = endgameState(bot);
    const dim = dimOf(bot);
    const obsidian = invCount(bot, /^obsidian$/);
    let nextMilestone;
    let outLevel = level, outRank = rank;
    if (rank <= 1) nextMilestone = 'stone tools (BOOTSTRAP_KIT)';
    else if (rank === 2) nextMilestone = kitReady
        ? `descend for iron (STONE_KIT_READY → GO_UNDERGROUND y${IRON_TARGET_Y}, iron ${ironBanked}/${IRON_BUFFER})`
        : `complete stone kit (sword + cobble≥8 + furnace) before mining iron`;
    else if (rank === 3) {
        const armor = (w.vitals && w.vitals.armor) || 0;
        nextMilestone = armor < 4
            ? `iron armor set (GET_IRON_ARMOR_SET, iron ${ironBanked}/${IRON_BUFFER})`
            : `diamond pickaxe (GET_DIAMOND_GEAR, diamond ${diamondBanked}/${DIAMOND_FLOOR})`;
    } else {
        // ── ★ENDGAME first-match ladder (rank>=4). Checked top-down, HIGHEST first, so
        //    consumed items can't silently regress past an irreversible eg flag. Ranks 10/11
        //    ride irreversible endgame.json flags; ranks 5-9 are capability-derived and MAY
        //    regress if items are lost — intended (losing your pick reopens lower rungs).
        //    eg.strongholdKnown pins rank>=9 so thrown/broken eyes never bounce the bot back
        //    to the nether unless eyesShort>0 reopens resupply via the proposal gates
        //    (framesEmpty makes the reopened eyeTarget small). ──
        if (eg.dragonDead) {
            outRank = 11; outLevel = 'dragon_slain';
            nextMilestone = 'ENDER DRAGON SLAIN — GG, free play';
        } else if (dim === 'the_end') {
            outRank = 10; outLevel = 'the_end';
            nextMilestone = 'destroy end crystals then slay the dragon (SLAY_DRAGON)';
        } else if (n.eyesShort === 0 || eg.strongholdKnown) {
            outRank = 9; outLevel = 'eyes_ready';
            nextMilestone = `locate stronghold + fill frames (GO_END, eyes ${n.eyes}/${n.eyeTarget})`;
        } else if (n.blazeShort === 0 && n.pearlsShort === 0) {
            outRank = 8; outLevel = 'pearls_done';
            nextMilestone = `craft eyes of ender (CRAFT_EYES, ${n.eyes}/${n.eyeTarget})`;
        } else if (n.blazeShort === 0) {
            outRank = 7; outLevel = 'blaze_done';
            nextMilestone = `night-hunt endermen for pearls (HUNT_PEARLS, short ${n.pearlsShort})`;
        } else if (dim === 'the_nether') {
            outRank = 6; outLevel = 'nether';
            nextMilestone = `farm blaze rods (GET_BLAZE_RODS, rods ${n.rods}/${BLAZE_ROD_TARGET})`;
        } else if (n.obsOk) {
            outRank = 5; outLevel = 'nether_ready';
            nextMilestone = 'build + enter the nether portal (ENTER_NETHER)';
        } else {
            outRank = 4; outLevel = 'diamond';
            nextMilestone = `portal kit (GET_PORTAL_KIT, obsidian ${obsidian}/10, flint_and_steel ${invCount(bot, /^flint_and_steel$/)}/1)`;
        }
    }
    return { level: outLevel, rank: outRank, nextMilestone, stoneKitReady: kitReady,
             progress: { ironBanked, diamondBanked, ironTarget: IRON_BUFFER, diamondTarget: DIAMOND_FLOOR,
                         // ★ENDGAME additive telemetry-only keys (extra keys optional in the typedef):
                         rods: n.rods, powder: n.powder, pearls: n.pearls, eyes: n.eyes,
                         eyeTarget: n.eyeTarget, obsidian, dim } };
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

    // ── ★ENDGAME dimension guard: ALL overworld-semantic proposals (opening/night/bed/armor/
    //    tier-chain/food/wheat/migrate/underground/bank) are ANDed with `overworld` so they are
    //    suppressed in the nether/End (time.phase still ticks overworld time there; feedUp/landmark
    //    logic flails off-overworld). In the overworld `overworld===true` → behavior byte-identical
    //    to today. FREE_PLAY stays dimension-agnostic; HOLD@95 is ALSO overworld-gated (review
    //    :441) — its TRIGGER is entity-derived but its dispatch skill prepNether is one of the
    //    very overworld-semantic skills this guard exists to suppress. ──
    const dim = dimOf(bot);
    const overworld = dim === 'overworld';

    // ── ★2026-07-08 用户令: 临时禁用「饥饿/种田/食物」本能 (乱逛源) ──────────────────────
    //    foodInstincts=false 时不 push 任何主动觅食(GET_FOOD/feedUp)、种麦(OPP_WHEAT_FARM/
    //    wheatFarm)、村庄采集(OPENING_VILLAGE/villageHarvest) 提案 —— 这些正是"接到命令后到处
    //    乱逛"的来源。保命(HP)链、夜链、tier 链、auto_eat 补血分支均不受影响。
    //    回头恢复: 设 MC_FOOD_INSTINCTS=1 重启。见 contracts.foodInstinctsEnabled /
    //    docs/food-instincts-disabled.md。
    const foodInstincts = foodInstinctsEnabled();
    const hpInstincts = hpInstinctsEnabled();   // ★2026-07-09 hp 侧同构闸 (narrow: 只熔断"因低血"任务闸/求生派发, 威胁触发战斗自保保留)

    // ★危血禁下深矿 (T-0098续 / 06-25T12:31 实锤: hp8 food17 被 GO_UNDERGROUND@45 派 mineDown,
    //   从 y62 下潜 48 层到 y14,全程不回血(food<18=低于 MC 自然回血线),遇地下僵尸 dist1 裸甲一击死).
    //   下深矿要有血量 buffer 应对地下怪偷袭: hp<8 一律危险; hp 8-11 仅在能回血(food>=18,边下边回)放行;
    //   hp>=12 放行。低血不回血时下矿=送死 → gate 关下矿后 GET_FOOD@88/55 接管上浮 feedUp 补食回血,
    //   宁可 idle 等食也不深入送死(keepInv ON,idle 不死)。只 gate 真·下深矿(GO_UNDERGROUND@45/
    //   GET_DIAMOND@46),不动 sufficientForUnderground(本文件:134 警告: 收紧它=回归 T-0088/T-0060 石棺
    //   死锁)、不动地表 smelt/craft(GET_IRON_TOOLS@47=furnace 作业非下矿)。夜 MINE_THROUGH_NIGHT 不在
    //   此 gate(夜决策由 computeNightPlan 的 alreadyDeepEnclosed/FIGHT 链自管,避免破坏夜庇护 fallback)。
    // ★2026-07-09 用户令: 双闸全 OFF 时 hp/food 不再阻挡下矿 (因低血/因饿不打断任务, 死了拉倒); 任一闸开恢复原安全门。
    const hpSafeForUnderground = (!hpInstincts && !foodInstincts) || vitals.hp >= 12 || (vitals.hp >= 8 && vitals.food >= 18);

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
    // ★review :441 — `overworld &&`: dispatching prepNether (bed/portal/surface semantics) in the
    // nether/End at hp<10 flails off-dimension, and its 3x false returns would cool HOLD down for
    // 5 minutes exactly mid-crisis. Off-overworld the dimension's primary skill (blazeRods /
    // slayDragon) carries its own retreat/eat/bunker logic and the reflex modes still run between
    // dispatches — suppressing the proposal is the smaller correct change vs inventing a new skill.
    if (overworld && threat.actionable > 0 && vitals.hp < 10 && !famineStall) {
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
    //    `overworld &&` (review :611/:441 follow-through): this push was the one opening proposal
    //    MISSING the ★ENDGAME dimension gate its own comment above claims — a nether/End bot
    //    whose wood dipped under the buffer re-proposed BOOTSTRAP_KIT@66 (skill=prepNether),
    //    outranking GET_BLAZE_RODS/SLAY_DRAGON and flailing wood-gathering in a dimension with
    //    no logs. Off-overworld the primary in-dimension skills need no wood/pick to proceed.
    // ★2026-07-09 用户令 "prepNether 退役": BOOTSTRAP_KIT 提案停用 — 不再自主派 prepNether 冷开局
    //   凑木→板→台→镐→石器。bot 之后靠 admin 指令驱动起步。回床 (GET_BED) / 低血防御 (HOLD) 保留。
    //   ★恢复方法: 取消下面 push 的注释即可 (prepNether.js:944 的 goals[] 也需一并复活)。
    // if (overworld && !isBootstrapDone(w, bot)) {
    //     const noPick = kit.picks < 1;
    //     push({ kind: PROPOSAL_KIND.BOOTSTRAP_KIT, priority: noPick ? 90 : 64, skill: 'prepNether',
    //            rationale: noPick
    //                ? 'no usable pickaxe — finish wood→planks→table→pickaxe→stone tools before anything else'
    //                : `kit started but understocked (wood ${woodUnits(bot)}/${WOOD_BUFFER}, tier ${kit.pickTier}) — stock wood + upgrade to stone tools, don't wander off`,
    //            hints: { hasTablePath: kit.hasTablePath, pickTier: kit.pickTier, wood: woodUnits(bot) } });
    // }

    // 1b) ★SARCOPHAGUS RESCUE (checkpoint #16, 14:20Z live): sealed deep with no pick AND no
    //     wood — BOOTSTRAP_KIT@90's prepNether needs local wood/table that y<50 stone never has
    //     (BOOTSTRAP_KIT/GET_BED/GET_FOOD 3-kind cooldown storm at y=42). surfaceUp owns the
    //     pickless ascent (NO_PICK_BREACHABLE hand-breach + pillarUp + ensureEmergencyPick);
    //     wood/food/table all live on the surface. Day/dawn only — a night ascent surfaces
    //     into mobs, the night chain owns those hours (sealed waiting beats climbing blind).
    if (overworld && Math.round(bot.entity.position.y) < 50 && kit.picks < 1
        && woodUnits(bot) === 0 && time.phase !== 'night' && time.phase !== 'dusk') {
        push({ kind: PROPOSAL_KIND.SURFACE_RESCUE, priority: 92, skill: 'surfaceUp', args: [63],
               rationale: 'sarcophagus: y<50, no pick, no wood — hand-breach to the surface (wood/food/table all live up there)' });
    }

    // 1c) ★P0-1 REPLENISH_KIT — 消耗品基线补给的一等 kind (review-2026-07-04 结构洞#1)。
    //     与三个既有邻居的分工(全部保留, 各管一段, 不互相替代):
    //       · SURFACE_RESCUE@92: y<50 + 无镐 + 无木的石棺急救 — 徒手破顶专用, 仍最高优先接管;
    //       · BOOTSTRAP_KIT@90/66: 冷开局 wood→table→pick→stone-tier 主链 — 但 prepNether 的
    //         wood-first 被 true-surface 门锁死(地下/半掩体时诚实 false → 3-strike → 5min 冷却,
    //         36h 轮转风暴的元凶), 而 replenishKit(并行 agent 在写, kind/skill 名是死契约)自己会
    //         上浮补货, 不受该门锁 — 这正是"修复型 kind"的意义;
    //       · TOOL_UPKEEP@47: 用手头现有材料恢复 sufficientForUnderground 不变量 — 材料没了它就
    //         静默不提案, REPLENISH_KIT 补的正是它要的材料(planks/备镐)。
    //     触发刻意不看 y/enclosed/threat(技能自己上浮+自带安全 gate), 只看 overworld+白天+buffer
    //     破底(总镐<2 或 planksEq<4)。释放走 isGoalDone 的迟滞口径(镐>=2 且 planksEq>=8)。
    //     priority: 镐=0 时 67 — 压过 understocked BOOTSTRAP_KIT@66(noPick BOOTSTRAP_KIT@90 仍
    //     先行, 其 prepNether 被 true-surface 门 3-strike 冷却后本 kind 顶上接管, 不再空转轮转);
    //     否则 63 — 高于 GET_FOOD@55, 低于 BOOTSTRAP_KIT@66(buffer 未破底时不抢班)。
    // ★2026-07-05 夜间口袋组装: 白天门放宽 — 夜里满兜板材(≥4)或石料(≥3)而缺镐/缺台时,
    // 合成不需要阳光 (技能端 ①.5开拔/②砍木 自带夜跳过, ⓪清囊/③板/③.5台床/③.6棍/④镐/⑧
    // 熟食夜里全能跑)。实录 11:34: planks16+stick11 夜里干坐, 台/床/镐全欠着等日出。
    const _nightAssembly = time.phase !== 'day'
        && (woodUnits(bot) >= 1 || invCount(bot, /^cobblestone$/) >= 3)
        && (totalPicks(bot) < REPLENISH_PICKS_MIN || !invCount(bot, /^crafting_table$/));
    // ★2026-07-06 tier 参数化 ([[spec-pickaxe-stockpile-redesign]]): 除总镐 fodder 底线外, 铁/钻阶段
    //   还要囤够本 tier 镐 (铁 4 / 钻 3, 触发线见 pickStockPlan)。tier 短缺也触发本 kind, 由 replenishKit ④
    //   就地用手头 ingot/diamond 造对应镐 (缺料由采矿链补)。priority: picks==0 仍 67(脱困急态, 压过 farm@65),
    //   否则 62 (囤备镐属日间 chore, 让位 farm@65/补木@64 — 用户令 白天 farm>镐>装备)。
    const _plan = pickStockPlan(w);
    // 只在 replenishKit ④ 能真正造出该 tier 镐时才让 tier 短缺触发本 kind (免"提了却造不动"→3-strike 冷却churn)。
    //   ★review 修: 铁镐口径含燃料 (raw_iron 无煤无锭 → 造不出, pickPlanHasMat 与 executor/释放门同真相)。
    const _planMat = pickPlanHasMat(bot, _plan);
    const _tierShort = _plan && _planMat && effectivePicksMatching(bot, _plan.re) < _plan.triggerFloor;
    if (overworld && (time.phase === 'day' || _nightAssembly)
        && (totalPicks(bot) < REPLENISH_PICKS_MIN || _tierShort || woodUnits(bot) < REPLENISH_PLANKS_TRIGGER)) {
        const pk = totalPicks(bot), pe = woodUnits(bot);
        const _pri = pk === 0 ? 67 : 62;
        const _tierTag = _plan ? ` ${_plan.tier}镐=${effectivePicksMatching(bot, _plan.re)}/${_plan.target}` : '';
        progressLogThrottled(bot, 'replenishKit', 60000,
            `[proposeTasks] ★REPLENISH_KIT-propose: picks=${pk}/${REPLENISH_PICKS_MIN}${_tierTag} planksEq=${pe}/${REPLENISH_PLANKS_RELEASE} pri=${_pri} y=${Math.round(bot.entity.position.y)}${_nightAssembly ? ' [夜间口袋组装]' : ''} — 补给基线破底, 派 replenishKit(修复型: 不看深度, 技能自己上浮)`);
        push({ kind: PROPOSAL_KIND.REPLENISH_KIT, priority: _pri, skill: 'replenishKit',
               rationale: `supply baseline broken (picks ${pk}/${REPLENISH_PICKS_MIN}${_tierTag}, planksEq ${pe}/${REPLENISH_PLANKS_RELEASE})${_nightAssembly ? ' — night pocket-assembly (craft-only, chop steps self-skip)' : ' — surface + restock wood/spare pick before every consumer yields'}`,
               hints: { picks: pk, planksEq: pe } });
    }

    // 2) Food: stock to a BUFFER, not just survival (user #5: stockpile meat).
    //    (overworld-only: feedUp flails in the nether/End; the endgame skills self-feed there.)
    //    ★ration-aware (checkpoint #7 closed d4b8d1d's structural hole: the dive gate demands
    //    >=2 CARRIED rations but the old hunger-only condition here meant food>=16 + rations<2
    //    proposed NOTHING that could open it — a latent deadlock the commit message promised
    //    away without code. Now low carried rations alone re-arms GET_FOOD at modest priority,
    //    and hunting kills naturally bank the raw meat that counts as rations.)
    const rationsNow = carriedRations(bot);
    // ★night mirror (checkpoint #13 storm): feedUp's own roam guard refuses to hunt at
    // night/dusk BY DESIGN (`isNight() || hostileNear()` → honest false), so proposing
    // GET_FOOD on the exposed surface then = 3 strikes + 5-min cooldown every expiry, all
    // night (observed 12:26Z: food=8, rations=0, 'guard stop night=true' x3). At night only
    // propose when feedUp CAN act in place: a carried ration to eat (real progress) —
    // otherwise nightShelter's raw-meat fallback owns night hunger (food<8 eats raw meat).
    const nightExposed = (time.phase === 'night' || time.phase === 'dusk') && overworld && Math.round(bot.entity.position.y) >= 50;
    const canEatInPlace = rationsNow >= 1 && vitals.food < 20;
    // ★2026-07-05 用户令: "不要一直去杀肉, 遇到牲畜顺手收就行, farm 以小麦面包为主" —
    // 囤肉档(@55/@35)只在面包经济未建立时放行 (无面包且无 farm 锚); 危机档(@88 food≤6)
    // 永远在。顺手收由 OPP animal splice + 路过击杀天然覆盖。
    const _breadStaple = invCount(bot, /^bread$/) >= 1 || !!(w.farm && Number.isFinite(w.farm.x));
    if (foodInstincts && overworld && (vitals.food < FOOD_STOCK || !kit.foodSufficient || rationsNow < 2)
        && (!nightExposed || canEatInPlace)
        && (vitals.food <= 6 || !_breadStaple)) {
        const pri = vitals.food <= 6 ? 88 : (vitals.food < 12 ? 55 : 35);
        push({ kind: PROPOSAL_KIND.GET_FOOD, priority: pri, skill: 'feedUp',
               rationale: vitals.food <= 6 ? 'food critical — hunt/forage now'
                   : vitals.food >= FOOD_STOCK && rationsNow < 2
                       ? `hunger fine but only ${rationsNow} carried ration(s) — hunt a takeaway buffer (dive gate needs 2)`
                       : `stock food to ${FOOD_STOCK} (now ${vitals.food}) — keep a meat buffer, don't run lean` });
    }

    // 2b) ★T-0069 WHEAT FARM — SUSTAINABLE food production (the self-sufficiency root). feedUp only
    //     CONSUMES existing food sources (hunt/forage/leaf-apples); in a food desert it空转s and the
    //     bot starves on cheat-supply. wheatFarm.js was written for this but was NEVER dispatched
    //     (OPP_WHEAT_FARM is dead code — nothing pushes it; triggers REGISTRY is empty). Wire it as a
    //     real proposer task: when it's day, safe, and we CAN actually farm (seeds in the bag to
    //     sow/keep a plot OR mature wheat already growing nearby to harvest+bake), run one bounded
    //     pass (harvest → bake bread → replant). The skill self-cooldowns (~5min) so unripe plots
    //     don't pin it. ★2026-07-06 用户令 @50→@65 ([[spec-pickaxe-stockpile-redesign]]): 白天 farm(小麦流)
    //     >囤镐>装备 — 面包经济优先。现居 noPick BOOTSTRAP_KIT(90)/危机食物(88)/囤镐-无镐(67) 之下, 囤镐-备镐
    //     (62)/补木(64)/装备(58)/挖矿(45) 之上。注意: 这里 farm 专指小麦流, 捕猎(GET_FOOD@88/55/35) 不在此列。
    //     It only fires once food isn't critical (>6). dynamicBreadTarget gates the dispatch to a real
    //     bread deficit, so a fed bot with a full bread stock won't churn on it.
    // ★2026-07-05 用户四连问修复: 旧 canFarmNow=(有种或有麦) — 种子播完(=0)后提案永不再触发,
    // 已播的地永远没人回来收 (巡回断链根因)。熟期巡逻分支: farm.json 锚存在且播种超 22min
    // (小麦熟期量级) → 即使零种零麦也派 wheatFarm 回去收割 (技能端 0 步会走回锚点)。
    const farmRipe = !!(w.farm && Number.isFinite(w.farm.x) && (w.farm.sownAt || 0) > 0
        && (Date.now() - w.farm.sownAt) > 22 * 60 * 1000);
    const canFarmNow = (invCount(bot, /^wheat_seeds$/) > 0 || invCount(bot, /^wheat$/) >= 3 || farmRipe);
    const breadDeficit = invCount(bot, /^bread$/) < dynamicBreadTarget(bot, w);
    // ★review 修 (farm 50→65 越过 MIGRATE@60): 死区/不宜居/卡地形/无木生物群系(migration.recommend)时
    //   farm 必须让位迁移 — 否则揣着种子的 bot 会在该逃离的地形上原地种田而非撤离。加 !migration.recommend 门。
    if (foodInstincts && overworld && time.phase === 'day' && !migration.recommend && !(threat.actionable > 0) && vitals.food > 6 && canFarmNow && breadDeficit
        && (!bot || Date.now() >= (bot._wheatFarmCooldownUntil || 0))) {
        push({ kind: PROPOSAL_KIND.OPP_WHEAT_FARM, priority: 65, skill: 'wheatFarm',
               args: [{ breadTarget: dynamicBreadTarget(bot, w) }],
               rationale: `sustainable food: harvest+bake wheat→bread (target ${dynamicBreadTarget(bot, w)}, have ${invCount(bot, /^bread$/)}) — stop relying on cheat-supply` });
    }

    // 3) Bed (mandatory respawn anchor) — once kit exists. (overworld-only: no beds off-overworld — they explode.)
    if (overworld && kit.picks >= 1 && !bedKnown(bot) && !(hasIronTierPick(w) && (vitals.armor || 0) >= 1 && diamondsOnHand(bot) < DIAMOND_FLOOR)) {   // ★T-0092 completion (worker-sync): GET_BED@50 was an UNFULFILLABLE wool-errand (no wool→no bed→bedKnown永false) that OUTRANKED GET_DIAMOND@46, so an iron-tooled+armored bot never descended for diamond. Yield GET_BED exactly when the bot is diamond-ready (mirror the GET_DIAMOND gate) so GET_DIAMOND wins → mineDiamonds descends. Safe: pure re-prioritize, does NOT gate pick/bed-MAKING (keepInventory ON so a delayed respawn-anchor loses nothing).
        // ★T-0110 (worker-frozen 0701): RE-ENABLE the @44 yield the T-0060 note below deferred. That
        // note's exact blocker — "@44 → GO_UNDERGROUND → mineDown NO-OP-spun → HARD-PINNED, because the
        // stuck-relocate wasn't firing; real fix = migrate-away-from-stuck-spot + mineDown-relocate-on-
        // no-dig" — is NOW BUILT and live: the kernelDriver NO-OP-SPIN escape relocates on any churn,
        // and migrate minForceAdvance guarantees the relocate actually moves. So when stone-kit-ready +
        // still PRE-iron (no iron pick, none banked), drop GET_BED below GO_UNDERGROUND@45 so the bot
        // DESCENDS for iron instead of an unfulfillable wool-wander that blocks the entire mining chain
        // (GET_BED@50 > GET_IRON_TOOLS@47 > GO_UNDERGROUND@45 = a bedless/woolless bot never mines).
        // A bad descent spot now triggers escape→migrate. Full @50 returns once iron tooling is underway;
        // keepInventory ON so the deferred respawn anchor loses nothing. (T-0060 baseline below, superseded.)
        // Condition = simply "no iron pickaxe yet" (stone-tier). Deliberately NOT stoneKitReady — that
        // requires cobble>=8, which drops below 8 the moment the bot seals a night bunker, flipping the
        // yield off exactly when it's needed (live: stoneKitReady=false after a NIGHT_SEAL spent cobble).
        // Throughout stone-tier, mining iron beats a wool-errand the bot usually can't fulfil anyway.
        const preIronDescend = !hasIronTierPick(w);
        push({ kind: PROPOSAL_KIND.GET_BED, priority: preIronDescend ? 44 : 50, skill: 'prepNether',
               rationale: preIronDescend ? 'no bed, but stone-kit-ready + pre-iron — DESCEND for iron first (bed deferred; keepInv ON), yield to GO_UNDERGROUND@45' : 'no bed yet — secure wool→bed as respawn anchor (mandatory, blueprint §D.3)' });
    }

    // 3b) ARMOR — close the chronic unarmored-death gap (86% of deaths are unarmored; bot makes an
    //    iron PICKAXE but never armor → a single creeper/stray one-shots it every cycle). Once banked
    //    iron is enough for a piece, smelt+craft+equip iron armor (iron preserves diamonds — user
    //    choice 铁甲留钻石). DAY + safe only (craft at the furnace, never exposed at night). When iron
    //    is short this stays silent and GO_UNDERGROUND mining accumulates more; it re-fires next pass.
    //    ★2026-07-06 用户令降级 ([[spec-pickaxe-stockpile-redesign]]): 68→58。用户明确取舍"白天 farm>镐>
    //    装备", 接受随之升高的裸甲死亡率。装备现居 farm(65)/囤镐(67/62)/补木(64)/迁移(60) 之下, 仍在 noPick
    //    BOOTSTRAP_KIT(90)/危机食物(88) 与 GET_FOOD-buffer(55)/tier挖矿(45-47) 之间。旧"@68 压 understocked
    //    BOOTSTRAP_KIT(66) 防深地无木死锁"的安全阀已撤: 深地脱困由会自上浮的 REPLENISH_KIT→surfaceUp 兜底
    //    (surfaceUp 分腿爬+横向迂回+徒手破顶, 见 skills/surfaceUp.js), 与装备排位无关。
    //    ★review craftArmor:60: gate on ironArmorGoalDone (cheapest-MISSING-piece affordability),
    //    not a flat iron>=4 — proposing a craft pass that can't afford the next piece (boots
    //    owned + 4 iron, helmet costs 5) just spun craftArmor at @68 above the whole chain.
    //    Proposer gate and isGoalDone share the ONE predicate (the file's house idiom).
    // ★2026-07-05 无镐让位 (实录 05:04: 全镐耗尽时 GET_ARMOR@68 一分压过 REPLENISH@67,
    // craftArmor 抢走白天窗口徒手 7.5s/块凿石找炉位反复失败, 补镐链被压制到 3-strike 冷却
    // 才轮上)。无镐=补给紧急态: picks>0 才许提甲件。
    if (overworld && time.phase === 'day' && !(threat.actionable > 0) && !ironArmorGoalDone(w, bot)
        && (kit.picks || 0) > 0) {
        push({ kind: PROPOSAL_KIND.GET_ARMOR, priority: 58, skill: 'craftArmor',
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
        && (!foodInstincts || vitals.food >= 8) && surfaceGate.mode !== 'hold';
    if (overworld && tierReady) {
        // RUNG 1: stone tier + enough banked iron, but no iron pick yet → smelt then craft iron tools.
        //   Two-state dispatch over EXISTING real skills (no假执行): if raw_iron isn't smelted yet,
        //   run smeltSafe (places furnace + smelts); once ingots are in hand, run craftChain('iron_tier')
        //   (crafts iron pickaxe + sword + shield). @47: just above open-ended GO_UNDERGROUND@45 —
        //   "have the ore in hand, upgrade before diving again" — but below GET_ARMOR@68 and all survival.
        // RUNG 0.9 (2026-07-06 用户令 oracle挖铁): 首铁空档 — 石器级 + 铁不足 3 + oracle 有目标
        //   → 日间制导首铁行 (夜挖 MINE_THROUGH_NIGHT 只覆盖夜; 此前首铁靠 GO_UNDERGROUND 盲逛)。
        //   同 kind GET_IRON_TOOLS: isGoalDone=hasIronTierPick, 承诺贯穿 采→熔→锻 三态切换。
        if (tier.rank === 2 && ironForArmor(bot) < 3 && !hasIronTierPick(w)) {
            // ironDeep 优先且 args 必须带 yMax(实录 19:17: 提案看 ironDeep 但技能没收到 yMax,
            // 自读 iron[0]=y62-93 山面铁 → 崖壁啃石 0 进账 + 190s 磨断仅剩两把镐)
            const firstIronTgt = oracleOreTarget(w, 'ironDeep');
            if (firstIronTgt) {
                push({ kind: PROPOSAL_KIND.GET_IRON_TOOLS, priority: 47, skill: 'mineOres',
                       args: [{ ore: 'iron', count: 4, maxMs: 240000, yMax: 50 }],
                       rationale: `stone tier + only ${ironForArmor(bot)} iron — ORACLE first-iron run @${firstIronTgt.x},${firstIronTgt.y},${firstIronTgt.z} (unlock iron pickaxe)`,
                       hints: { tier: tier.level, iron: ironForArmor(bot), oracle: true } });
            }
        }
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
        // RUNG 1.5: ★P1-4 铁库存回补 — GET_IRON_ARMOR_SET 从幽灵 kind 复活为真提案 (review 结构洞#4:
        //   它已有 isGoalDone case/DAY_ERRANDS 条目/rank3 milestone 点名, 唯独 proposeTasks 零 push)。
        //   断层: 铁镐到手后 isGoalDone(GO_UNDERGROUND) 恒真(hasIronTierPick 短路), IRON_BUFFER=7 只够
        //   工具, 而 ENTER_NETHER/GO_END/HUNT_PEARLS 三门都要 armor>=4(成套=24 锭) — "为甲采铁"无人
        //   认领, 段6→段8 长期卡死。语义 = 采集端(mineDown 下铁带), 与 GET_ARMOR@68(消费端: 冶炼+
        //   craft+穿)形成 采集→锻造 接力而非互抢: 两者可同刻提案, @68 恒赢 → 有铁先锻造; 锻不动了
        //   (ironArmorGoalDone: 铁不够下一件, GET_ARMOR 静默)本 kind @46.5 才接管下地补铁; 攒够
        //   ironDemandTotal 即 done 释放 → GET_ARMOR@68 接棒。口径 ironDemandTotal = max(缺甲总成本,
        //   portal kit 铁成本) — 甲齐但 GET_PORTAL_KIT 被 3e 的铁预检挡住时本 kind 继续供铁(任务4
        //   授权扩展), 闭环不留"甲齐缺桶铁"的死角。
        //   @46.5: TOOL_UPKEEP@47 之下(先保镐再采矿)、GET_DIAMOND@46 之上(先甲后钻 — GET_DIAMOND 只要
        //   armor>=1 但 ENTER_NETHER 要 4)。下矿三重门与 GO_UNDERGROUND@45/GET_DIAMOND@46 同款
        //   (sufficientForUnderground/hpSafeForUnderground/口粮>=2), 新 kind 不绕开危血禁下矿(:450)
        //   与 dive-ration(:917) 两个既有不变量; day/safe/surfaceGate 由外层 tierReady 已保证。
        if (hasIronTierPick(w) && ironForArmor(bot) < ironDemandTotal(w, bot)
            && kit.sufficientForUnderground && hpSafeForUnderground
            && (!foodInstincts || carriedRations(bot) >= 2 || vitals.food >= 16)) {   // ★2026-07-06 satiety 档: 贫瘠世界口粮存不下来, 满腹+灰区兜底+keepInv 等效(夜挖门同理)
            const demand = ironDemandTotal(w, bot);
            // ★2026-07-06 用户令 (oracle视角挖铁): ore-oracle 已扫铁坐标 → mineOres 直奔;
            //   oracle 缺失/陈旧才回退盲挖 mineDown 铁带。kind/isGoalDone 簿记不变。
            const ironTgt = oracleOreTarget(w, 'ironDeep') || oracleOreTarget(w, 'iron', 50);   // 地下带优先(山面铁=崖壁啃石磨镐, 19:17 实录)
            progressLogThrottled(bot, 'ironArmorSet', 120000,
                `[proposeTasks] ★GET_IRON_ARMOR_SET-propose: iron=${ironForArmor(bot)}/${demand} (armor=${vitals.armor || 0}/4 缺甲成本=${ironArmorRemainingCost(w)} portal铁=${portalKitIronCost(bot)}) — ${ironTgt ? `ORACLE直奔 ${ironTgt.x},${ironTgt.y},${ironTgt.z}` : `盲挖铁带 y${IRON_TARGET_Y}`} (pri=46.5)`);
            push({ kind: PROPOSAL_KIND.GET_IRON_ARMOR_SET, priority: 46.5,
                   skill: ironTgt ? 'mineOres' : 'mineDown',
                   args: ironTgt ? [{ ore: 'iron', count: Math.max(4, demand - ironForArmor(bot)), maxMs: 300000, yMax: 50 }] : [{ targetY: IRON_TARGET_Y }],
                   rationale: `iron restock: ${ironForArmor(bot)}/${demand} iron banked for armor ${vitals.armor || 0}/4${portalKitIronCost(bot) > 0 ? ' + portal kit' : ''} — ${ironTgt ? `oracle-guided mineOres to ${ironTgt.x},${ironTgt.y},${ironTgt.z}` : `descend to the iron band (y${IRON_TARGET_Y})`}`,
                   hints: { iron: ironForArmor(bot), demand, armor: vitals.armor || 0, targetY: ironTgt ? ironTgt.y : IRON_TARGET_Y, oracle: !!ironTgt } });
        }
        // RUNG 2: iron pick in hand (diamond mining unlocked) + iron armor on → go GET DIAMONDS.
        //   Requires armor>=4 (GET_ARMOR@68 closes that first) so the bot never strip-mines the
        //   deep diamond band unarmored. @46: above GO_UNDERGROUND@45 so a kitted iron bot heads for
        //   the diamond band on purpose instead of the open-ended shallow descent.
        if (hasIronTierPick(w) && (vitals.armor || 0) >= 1 && diamondsOnHand(bot) < diamondTarget(bot) && !diamondGearComplete(bot) && hpSafeForUnderground
            && kit.sufficientForUnderground
            && (!foodInstincts || invCount(bot, /^(cooked_\w+|bread|apple|baked_potato|carrot|beef|porkchop|mutton)$/) >= 2 || vitals.food >= 16)) {   // ★2026-07-06 satiety 档(贫瘠世界口粮存不下, 满腹+灰区兜底+keepInv 等效); ★T-0092 (worker-sync): armor>=4(full set=24 iron, unreachable since GET_ARMOR yields at <4) → armor>=1(reachable from one craftArmor pass) so an iron-tooled+lightly-armored bot actually commits GET_DIAMOND → mineDiamonds descends to y-52. NOT >=0. ★tool-budget: also gated on kit.sufficientForUnderground (spare-with-table or field-recraft kit) like GO_UNDERGROUND — the skill-side pick guard is the LAST line, not the plan; TOOL_UPKEEP@47 restores the invariant first. ★dive rations (task #9): >=2 carried edibles or GET_FOOD stocks first — the y12 famine surfacing (checkpoint #6) ate the whole night's descent.
            // Dispatch the DEDICATED mineDiamonds skill: it water-aware-descends to the diamond band,
            // x-ray finds + vein-follows diamonds, banks each haul, and LOOPS until count is reached —
            // exactly the "在该层定向循环直到挖到目标矿" T-0092 asks for. (Generic mineDown only
            // descends then branch-mines once; mineDiamonds owns the deep-diamond venture.)
            // ★2026-07-06 优先级反倒挂: 46→46.75 (压过 ARMOR_SET@46.5) — 实录两把铁镐都被
            //   46.5 派去挖甲铁, 耗尽在石头上, 钻石线永远等不到活的铁镐。钻镐(1561 耐久)
            //   到手后甲铁自然接棒, 顺序反转是使命最优。
            // ★2026-07-06 钻石相位优先级 ([[spec-pickaxe-stockpile-redesign]]): 无钻镐 @46.75(挖够 DIAMOND_FLOOR
            //   造首镐); 有钻镐 @54 — 压过 endgame 链(52-53), 让 bot 先滚雪球到 DIAMOND_SNOWBALL_TARGET(40) 再进
            //   下界杀龙 (用户令 "得钻镐后优先继续挖钻")。仍让位 farm@65(仅真缺面包才抢)/装备@58 之上/survival。
            const _diaTgt = diamondTarget(bot);
            push({ kind: PROPOSAL_KIND.GET_DIAMOND, priority: invCount(bot, /^(diamond|netherite)_pickaxe$/) >= 1 ? 54 : 46.75, skill: 'mineDiamonds',
                   args: [_diaTgt],
                   rationale: `iron-tooled + armored — descend to the diamond band (y${DIAMOND_TARGET_Y}) and mine to ${_diaTgt} diamonds`,
                   hints: { tier: tier.level, targetY: DIAMOND_TARGET_Y, diamonds: diamondsOnHand(bot), target: _diaTgt } });
        }
    }

    // 3d) ★T-0092 BANK GEAR — pack carries diamonds/high-value ore AND is nearly full → run home and
    //     deposit so a death doesn't wipe the investment. Day, safe, not mid-emergency. @58 (above
    //     MIGRATE@60? no — just below: a death-zone migrate still wins; but above GET_BED@50 and the
    //     tier chain): protecting banked diamonds outranks chasing more, but never a survival need.
    //     bankGear itself defers if there's no home anchor or it's unsafe, so this is cheap to propose.
    //     ★P1-5 停用: BANK_GEAR_ENABLED=false 门掉 push(理由/重开条件见文件顶部常量注释 —
    //     keepInventory=true 下"死丢投资"前提为假, 且实测吞钻石/削 cobble/ghost 箱蒸发铁, 纯负价值)。
    if (BANK_GEAR_ENABLED && overworld && time.phase === 'day' && !(threat.actionable > 0) && diamondsOnHand(bot) >= 1 && packNearlyFull(bot)) {
        push({ kind: PROPOSAL_KIND.BANK_GEAR, priority: 58, skill: 'bankGear',
               rationale: `${diamondsOnHand(bot)} diamond(s) + pack nearly full — bank valuables at home before a death wipes them`,
               hints: { diamonds: diamondsOnHand(bot) } });
    } else if (!BANK_GEAR_ENABLED && overworld && diamondsOnHand(bot) >= 1 && packNearlyFull(bot)) {
        // ★P1-5 观测: 本会触发的 BANK_GEAR 被停用门吞掉 — 10min 节流留痕, 验证停用生效 + 背包压力可见。
        progressLogThrottled(bot, 'bankGearOff', 600000,
            `[proposeTasks] ★BANK_GEAR-disabled: would-fire (diamonds=${diamondsOnHand(bot)} packNearlyFull) — suppressed by BANK_GEAR_ENABLED=false (keepInventory=true 存箱前提为假)`);
    }

    // 3e) ── ★ENDGAME chain (post-diamond → Ender Dragon, all legit — docs/HANDOFF.md cold goal). ──
    //     Rides the same endgameNeeds/endgameState/dimOf truth as computeTier + isGoalDone, so the
    //     proposer, the tier ladder and completion can never disagree. All @52: above GET_BED@50 /
    //     tier-chain@45-47, below BANK_GEAR@58 / MIGRATE@60 / GET_ARMOR@68 and ALL survival/night —
    //     endgame progress never preempts staying alive. Stage exclusivity is gate-driven (obsOk /
    //     blazeShort / eyesShort flip stages); push order breaks @52 ties in ladder order.
    {
        const eneeds = endgameNeeds(bot);
        const eg = endgameState(bot);
        const swords = invCount(bot, /^(iron|diamond|netherite)_sword$/);
        const fillBlocks = invCount(bot, /^(cobblestone|cobbled_deepslate)$/);
        // ★review :591 finish-vs-resupply: with the stronghold KNOWN and enough eyes in hand to
        // plausibly fill the remaining frames (eg.framesEmpty once counted; else worst-case 12,
        // capped by eyeTarget), FINISHING must outrank restocking — GET_PORTAL_KIT/ENTER_NETHER
        // are pushed first and would win the stable-sort @52 tie, sending the bot on a full
        // obsidian re-mine + nether roundtrip while 12 eyes sit in the pack (a normal state:
        // ~20% throw breakage keeps blazeShort>0 until framesEmpty is measured). Priority
        // ladder: GO_END 53 (finish now) > ENTER_NETHER 52.5 (reuse persisted portal) > @52
        // resupply pushes — resupply stays proposed as the fallback when GO_END's gear gates
        // (food/armor/sword/cobble) fail.
        const framesNeed = Number.isFinite(eg.framesEmpty) ? eg.framesEmpty : 12;
        const canFinishNow = !!eg.strongholdKnown && eneeds.eyes >= Math.min(framesNeed, eneeds.eyeTarget);
        // GET_DIAMOND_GEAR — rank 3→4 bridge (banked diamonds → diamond pickaxe via craftChain).
        //   Only fires once rank-3's GET_DIAMOND has banked its floor, so ranks 1-4 are undisturbed.
        if (overworld && tierReady && hasIronTierPick(w) && diamondsOnHand(bot) >= DIAMOND_FLOOR && !eneeds.hasDiamondPick) {
            push({ kind: PROPOSAL_KIND.GET_DIAMOND_GEAR, priority: 52, skill: 'craftChain',
                   args: ['diamond_tier'],
                   rationale: `${diamondsOnHand(bot)} diamonds banked + no diamond pickaxe — craft diamond pick(+sword) (obsidian needs a diamond pick)`,
                   hints: { diamonds: diamondsOnHand(bot) } });
        }
        // GET_DIAMOND_ARMOR — ★2026-07-06 钻石滚雪球攒够后 → 全套钻甲 (endgame 生存升级, 用户令 40钻=钻甲24+3钻镐9+3余)。
        //   @53: 压过 endgame@52(先穿甲再进下界), 让位钻石雪球 GET_DIAMOND@54(先攒够钻)与囤钻镐 REPLENISH@62(先囤3钻镐)。
        //   craftArmor{tier:diamond} 自带 9 钻镐保留额; 门 diamondArmorFloor 同口径。日间安全站桩(craftChain 自放台)。
        if (overworld && tierReady && eneeds.hasDiamondPick && diamondArmorPieces(bot) < 4
            && diamondsOnHand(bot) >= diamondArmorFloor(bot)) {
            push({ kind: PROPOSAL_KIND.GET_DIAMOND_ARMOR, priority: 53, skill: 'craftArmor',
                   args: [{ tier: 'diamond' }],
                   rationale: `diamond snowball — craft+equip full diamond armor (${diamondArmorPieces(bot)}/4 pieces, ${diamondsOnHand(bot)} diamonds)`,
                   hints: { pieces: diamondArmorPieces(bot), diamonds: diamondsOnHand(bot) } });
        }
        // GET_PORTAL_KIT — obsidian×OBSIDIAN_TARGET + flint_and_steel (gatherObsidian: lava pool +
        //   water bucket, gravel→flint). hpSafeForUnderground: lava work at low hp is suicide.
        //   Mutually exclusive with ENTER_NETHER via obsOk.
        //   ★review OPEN finding gatherObsidian.js:70 铁预检 — 技能入口硬性要求 桶3锭+打火石1锭
        //   (已持有的不计, 空桶也算)且打火石还需 flint/gravel 来源; 提案门不预检就派 = 注定
        //   false→3-strike→5min 冷却→重派循环(endgame 阶段原本无补铁提案)。与技能 :44 的 ironShort
        //   完全同口径: 需求 = portalKitIronCost, 库存 = ironForArmor(铁锭+raw, raw 1:1 冶炼)。
        //   flint 侧: 已有打火石 || (背包 flint/gravel 或 32 格内 gravel — flintSourceSignal, 与技能
        //   getNearestBlock('gravel',32) 同半径)。挡住时节流打点, 缺口由 RUNG 1.5 GET_IRON_ARMOR_SET
        //   @46.5 的 ironDemandTotal(含 portal 铁成本)接管补铁 → 铁到位后本门自然放行。
        if (overworld && tierReady && eneeds.hasDiamondPick && eneeds.blazeShort > 0 && !eneeds.obsOk && hpSafeForUnderground) {
            const portalIronNeed = portalKitIronCost(bot);
            const portalIronOk = ironForArmor(bot) >= portalIronNeed;
            const portalFlintOk = invCount(bot, /^flint_and_steel$/) >= 1 || flintSourceSignal(bot);
            if (portalIronOk && portalFlintOk) {
                push({ kind: PROPOSAL_KIND.GET_PORTAL_KIT, priority: 52, skill: 'gatherObsidian',
                       args: [{ obsidianTarget: OBSIDIAN_TARGET, maxMs: 480000 }],
                       rationale: `portal kit: obsidian ${invCount(bot, /^obsidian$/)}/10 + flint_and_steel ${invCount(bot, /^flint_and_steel$/)}/1 — mine a lava pool with the diamond pick`,
                       hints: { obsidian: invCount(bot, /^obsidian$/), target: OBSIDIAN_TARGET } });
            } else {
                progressLogThrottled(bot, 'portalKitBlock', 300000,
                    `[proposeTasks] ★GET_PORTAL_KIT-precheck-block: ironNeed=${portalIronNeed} have=${ironForArmor(bot)} flintOk=${portalFlintOk} — 不提案(免 3-strike 冷却循环), 补铁归 GET_IRON_ARMOR_SET@46.5 (review gatherObsidian.js:70)`);
            }
        }
        // ENTER_NETHER — build/light/walk the legit portal (realNetherPortal). Gear gates
        //   (food/armor/sword/bridging cobble) keep an underprepared bot out of the nether.
        //   ★review :598/:600 — building consumed the 10 obsidian, so gating re-entry on obsOk
        //   alone forced a full lava-pool re-mine after every nether death even though the lit
        //   portal still stands. A persisted eg.netherPortalOverworld (stamped by realNetherPortal
        //   on light/reuse) also opens the gate: the skill walks back to the anchor and re-enters
        //   for free. @52.5 in that case so it outranks GET_PORTAL_KIT's earlier @52 push (else
        //   the re-mine wins the tie anyway); a dead anchor fails failed:true → 3x kernel
        //   cooldown suppresses ENTER_NETHER → GET_PORTAL_KIT takes over (self-healing).
        if (overworld && tierReady && eneeds.hasDiamondPick && eneeds.blazeShort > 0
            && (eneeds.obsOk || !!eg.netherPortalOverworld)
            && (!foodInstincts || vitals.food >= 12) && (vitals.armor || 0) >= 4 && swords >= 1 && fillBlocks >= 32) {
            push({ kind: PROPOSAL_KIND.ENTER_NETHER, priority: (!eneeds.obsOk && eg.netherPortalOverworld) ? 52.5 : 52, skill: 'realNetherPortal',
                   args: [],
                   rationale: `portal kit ready (obsidian≥10 + flint_and_steel) + geared — build, light and walk the nether portal (blaze rods short ${eneeds.blazeShort})`,
                   hints: { blazeShort: eneeds.blazeShort } });
        }
        // GET_BLAZE_RODS — in-nether: the ONLY live proposal there besides HOLD@95 (the overworld
        //   guard suppresses every overworld-semantic kind). The skill's own phases flip farm→exit
        //   once rods*2+powder+eyes >= eyeEquivTarget; done_when = back in the overworld (covers
        //   both the success-exit walk-out AND a death-respawn).
        if (dim === 'the_nether' && !eg.dragonDead) {
            push({ kind: PROPOSAL_KIND.GET_BLAZE_RODS, priority: 52, skill: 'blazeRods',
                   args: [{ rodTarget: BLAZE_ROD_TARGET, eyeEquivTarget: eneeds.eyeTarget, maxMs: 480000 }],
                   rationale: `in the nether — find a fortress and farm blazes (rods ${eneeds.rods}/${BLAZE_ROD_TARGET}), then exit via the portal`,
                   hints: { rods: eneeds.rods, rodTarget: BLAZE_ROD_TARGET } });
        }
        // HUNT_PEARLS — overworld NIGHT enderman hunt. @94.5 sits ABOVE the whole night chain
        //   (91-94, else GO_BED@93 sleeps through every hunting night) and BELOW HOLD@95. It is a
        //   first-class night plan (isNightPlan) so (a) it dethrones a stale daytime commitment at
        //   dusk via the nightPre path and (b) once committed the !isNightPlan guard stops
        //   GO_BED/SEAL from re-flipping it.
        if (overworld && time.phase !== 'day' && eneeds.blazeShort === 0 && eneeds.pearlsShort > 0
            && (vitals.armor || 0) >= 4 && (!foodInstincts || vitals.food >= 12) && (!hpInstincts || vitals.hp >= 14)
            && !(threat.actionable > 0 && vitals.hp < 10)) {
            push({ kind: PROPOSAL_KIND.HUNT_PEARLS, priority: 94.5, skill: 'enderPearls',
                   args: [{ pearlTarget: eneeds.pearlsShort + eneeds.pearls, maxMs: 360000 }],
                   rationale: `night + blaze rods done — hunt endermen under 2-high cover for pearls (short ${eneeds.pearlsShort})`,
                   hints: { pearls: eneeds.pearls, pearlsShort: eneeds.pearlsShort } });
        }
        // CRAFT_EYES — blaze_rod→blaze_powder→ender_eye batches. Day + safe (crafting is a
        //   stand-still window). Releases to resupply stages when nothing is left to convert.
        if (overworld && time.phase === 'day' && !(threat.actionable > 0) && eneeds.eyesShort > 0 && eneeds.craftable > 0) {
            push({ kind: PROPOSAL_KIND.CRAFT_EYES, priority: 52, skill: 'craftEyes',
                   args: [{ eyeTarget: eneeds.eyeTarget }],
                   rationale: `craft eyes of ender ${eneeds.eyes}/${eneeds.eyeTarget} (can craft ${eneeds.craftable} now: pearls ${eneeds.pearls}, powder ${eneeds.powder}, rods ${eneeds.rods})`,
                   hints: { eyes: eneeds.eyes, eyeTarget: eneeds.eyeTarget, craftable: eneeds.craftable } });
        }
        // GO_END — eye-throw triangulation → travel → dig to stronghold → fill frames → walk in.
        //   One sticky commitment; setupEndPortal is phase-aware + resumable from persisted eg
        //   state (strongholdKnown && eyes>0 lets a partially-stocked bot resume after eye losses).
        if (overworld && tierReady && (eneeds.eyesShort === 0 || (eg.strongholdKnown && eneeds.eyes > 0))
            && (!foodInstincts || vitals.food >= 14) && (vitals.armor || 0) >= 4 && swords >= 1 && fillBlocks >= 64) {
            // @53 when canFinishNow (see the :591 ladder above): finish with the eyes in hand
            // instead of losing the @52 push-order tie to a resupply roundtrip.
            push({ kind: PROPOSAL_KIND.GO_END, priority: canFinishNow ? 53 : 52, skill: 'setupEndPortal',
                   args: [{ maxMs: 480000 }],
                   rationale: eg.strongholdKnown
                       ? `stronghold known — return, fill the frames (eyes ${eneeds.eyes}/${eneeds.eyeTarget}) and enter the End`
                       : `eyes stocked ${eneeds.eyes}/${eneeds.eyeTarget} — triangulate the stronghold, activate the portal, enter the End`,
                   hints: { eyes: eneeds.eyes, strongholdKnown: !!eg.strongholdKnown } });
        }
        // SLAY_DRAGON — effectively the sole proposal in the End besides HOLD@95; @60 keeps it
        //   under HOLD@95 and crisis food@88 for safety symmetry.
        if (dim === 'the_end' && !eg.dragonDead) {
            push({ kind: PROPOSAL_KIND.SLAY_DRAGON, priority: 60, skill: 'slayDragon',
                   args: [{ maxMs: 600000 }],
                   rationale: 'in the End — destroy the end crystals (bow first, pillar the caged ones) then melee the perched dragon',
                   hints: {} });
        }
    }

    // 4) Migration if the biome is structurally unlivable (no sheep → no bed → death-zone respawn loop).
    //    (overworld-only: migration landmarks/biome logic is overworld-semantic.)
    if (overworld && migration.recommend && time.phase === 'day') {
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
    if (foodInstincts && overworld && opening.phase === 'VILLAGE_HARVEST' && vitals.food <= 6 && time.phase === 'day'
        && w.landmarks && w.landmarks.village && Number(w.landmarks.village.dist) <= 28) {
        push({ kind: TASK.OPENING_VILLAGE, priority: 89, skill: 'villageHarvest',
               rationale: `STARVING (food=${vitals.food}) next to a known village @${Math.round(w.landmarks.village.dist)}b — harvest it for food now (only reachable food source; villageHarvest self-defers if truly unsafe)` });
    }

    // ── OPENING flow (day, on the surface, nothing actionable): translate the
    //    derived w.opening.phase computed in modes.js into ranked tasks so a bare
    //    bot scouts/buffers/harvests instead of sleepwalking into generic prepNether. ──
    if (overworld && time.phase === 'day' && w.pos && w.pos.depthBand === 'surface' && !(threat.actionable > 0)) {
        switch (opening.phase) {
            case 'SCOUT':
                // ★用户spec: 开局无脑找树+村庄优先. SCOUT phase=冷开局(无已知可达wood/village) →
                // 压过 BOOTSTRAP_KIT(noPick=90), 先扫树+村+标landmark+判成本, 再bootstrap. 仅SCOUT态出.
                push({ kind: TASK.OPENING_SCOUT, priority: 92, skill: 'scoutResources',
                       args: [{ need: opening.need }],
                       rationale: `bare opening — scout for ${opening.need || 'resources'} (no known reachable wood/village yet)` });
                break;
            case 'WOOD_BUFFER':
                // ★2026-07-09 用户令 "prepNether 退役": WOOD_BUFFER 态的 BOOTSTRAP_KIT 提案一并停用。
                // push({ kind: PROPOSAL_KIND.BOOTSTRAP_KIT, priority: 64, skill: 'prepNether',
                //        args: [{ woodTarget: WOOD_BUFFER }],
                //        rationale: `wood known but understocked (${woodUnits(bot)}/${WOOD_BUFFER}) — buffer wood before going under`,
                //        hints: { woodTarget: WOOD_BUFFER, wood: woodUnits(bot) } });
                break;
            case 'VILLAGE_HARVEST':
                // ★2026-07-08 用户令: 食物本能禁用时不派村庄采集 (foodInstincts gate)。
                if (foodInstincts) push({ kind: TASK.OPENING_VILLAGE, priority: 67, skill: 'villageHarvest',
                       rationale: 'known nearby village — harvest crops/loot before the kit gets急需' });
                break;
            default: break; // DONE / undefined → no opening proposal
        }
    }

    // ── NIGHT flow (dusk/dawn/night): translate the dusk/night decision computed in
    //    modes.js (computeNightPlan) into ranked tasks. FIGHT/NONE emit nothing — the
    //    self_defense reflex owns combat; NONE means daytime/no night decision. ──
    if (overworld && time.phase !== 'day') {
        // ★用户spec: "一到晚上就无脑seal/bootstrap"是错的——夜里夜间决策必须压过白天作业(BOOTSTRAP_KIT 90).
        // 夜间任务全部 >90(在HOLD 95之下): MINE@94 / SMELT@94 / GO_BED@93 / DIG_ONE@92 / SEAL@91. 只夜出.
        // ★注 (2026-07-08 respec): computeNightPlan 每 tick 只返回【一个】决策, 夜内先后由 modes.js 的【链序】定,
        //   不是这里的优先级数字 (数字只保证整个夜带 >白天90 且 <HOLD95). 用户令链序:
        //   近床≤15 > [炼铁·保留] > 下矿 > 挖三填一(就地|≤15格找地) > 黄昏远床 > SEAL_FORT(裸hold). 详见 modes.js computeNightPlan.
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
            case 'MINE_THROUGH_NIGHT': {
                // ★2026-07-06 用户令 (前期公式化: 夜里 oracle 直奔高优矿): 铁缺口未平时夜挖
                //   优先 oracle 制导采铁 (mineOres), 铁齐/oracle 缺失才回退盲挖 y12。
                //   评审 P1: mineOres 采铁需石镐+ (木镐 bot 秒拒 3 振 → 连坐冷却整个 kind 含
                //   mineDown 回退) — 无石镐+夜里只走 mineDown。评审 P2: 夜里只接受地下带目标
                //   (y<=50) — 山面铁(y87)会把密封楼梯换成夜间地表裸采。
                // ★2026-07-06 夜钻优先 (镐#3 夜铁行 10min 磨死实录): 铁镐在世+钻<3 → 夜里
                //   直接 mineDiamonds — 镐的寿命用在唯一非它不可的地方(钻矿), 铁 gap 让位
                //   (与日间 GET_DIAMOND@46.75 同一反倒挂逻辑)。
                if (hasIronTierPick(w) && diamondsOnHand(bot) < diamondTarget(bot) && !diamondGearComplete(bot)) {
                    const _nTgt = diamondTarget(bot);   // ★相位: 无钻镐→3(造首镐), 有钻镐→40(夜里也滚雪球)
                    push({ kind: TASK.DUSK_MINE_NIGHT, priority: 94, skill: 'mineDiamonds',
                           args: [_nTgt],
                           rationale: `night DIAMOND rush — iron pick alive, spend it on diamond ore before it wears (${diamondsOnHand(bot)}/${_nTgt})` });
                    break;
                }
                const nightHasStonePick = invCount(bot, /(stone|iron|diamond|netherite)_pickaxe$/) >= 1;
                const nightNeedIron = !hasIronTierPick(w) || ironForArmor(bot) < ironDemandTotal(w, bot);
                // ironDeep = 扫描器分层的地下带(y<=50)最近名单 (iron top-24 在山顶可能全是山面铁);
                // 旧格式无 ironDeep 时回退 iron+yMax 过滤
                const nightIronTgt = (nightNeedIron && nightHasStonePick)
                    ? (oracleOreTarget(w, 'ironDeep') || oracleOreTarget(w, 'iron', 50)) : null;
                if (nightIronTgt) {
                    push({ kind: TASK.DUSK_MINE_NIGHT, priority: 94, skill: 'mineOres',
                           args: [{ ore: 'iron', count: 12, maxMs: 480000, yMax: 50 }],
                           rationale: `kitted night mining — ORACLE-guided iron run @${nightIronTgt.x},${nightIronTgt.y},${nightIronTgt.z} (iron gap first, then diamonds)` });
                } else {
                    push({ kind: TASK.DUSK_MINE_NIGHT, priority: 94, skill: 'mineDown',
                           args: [{ targetY: 12 }],
                           rationale: 'kitted (pick budget + food + fill) — mine through the whole night underground' });
                }
                break;
            }
            case 'GO_BED':
                // Only a FALLBACK: if the go_to_bed_sleep instinct is already driving sleep,
                // don't double-drive it from the proposer.
                // ★checkpoint #12 rewiring: this used to dispatch prepNether, whose night
                // decision-layer early-returns BY DESIGN — the kernel counted the yield as
                // failure, 3-struck the kind into 5-min cooldowns all night, and with a
                // village bed 2.5b away NOBODY actually slept (the bot kited zombies in the
                // open — two deaths that night). goBedSleep is the dedicated executor:
                // walk→hostile-check→sleep→hold; honest false falls through to the
                // NIGHT_DIG_ONE/NIGHT_SEAL shelter fallbacks.
                if (!sleepInstinctEngaged(bot)) {
                    push({ kind: TASK.DUSK_GO_BED, priority: 93, skill: 'goBedSleep',
                           rationale: 'known affordable bed in reach — go sleep through the night (skip to dawn)' });
                }
                break;
            case 'DIG_ONE_CAP':
                push({ kind: TASK.NIGHT_DIG_ONE, priority: 92, skill: 'nightShelter',
                       args: ['dig_one'],
                       rationale: 'no bed/mining option — dig a 1-block cap shelter (挖三填一) for the night' });
                break;
            case 'SEAL_FORT':
                // ★SURFACE WALL-BOX DISABLED (user 2026-07-07, docs/shelter-mechanism-disabled.md):
                //   we still dispatch nightShelter('seal') and keep NIGHT_SEAL@91 (priority must stay
                //   above daytime BOOTSTRAP_KIT@90 so the bot HOLDS at night, not wander), but the skill's
                //   'seal' mode no longer builds the wall ring — it holds in place instead (the box kept
                //   leaving the bot standing OUTSIDE its own walls). See nightShelter.js SURFACE_SEAL_DISABLED.
                push({ kind: TASK.NIGHT_SEAL, priority: 91, skill: 'nightShelter',
                       args: ['seal'],
                       rationale: 'hold in place until daybreak (surface wall-box disabled — no seal built)' });
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
    // ★dive ration gate (task #9 third knife; checkpoint #6: the y12 dive died of famine —
    // food 20→8 underground with ZERO carried rations, feedUp has no underground plan, the
    // bot survived on rotten flesh and surfaced at dawn empty-handed. Deep trips must CARRY
    // food like they carry torches: >=2 edible items or don't start the descent — GET_FOOD
    // @higher priority then stocks up first.)
    if (overworld && kit.sufficientForUnderground && surfaceGate.mode !== 'hold' && !threat.actionable && hpSafeForUnderground
        && (!foodInstincts || carriedRations(bot) >= 2 || vitals.food >= 16)) {   // ★2026-07-06 satiety 档 (同 GET_DIAMOND/GET_IRON_ARMOR_SET/夜挖门)
        push({ kind: PROPOSAL_KIND.GO_UNDERGROUND, priority: 45, skill: 'mineDown',
               args: [{ targetY: IRON_TARGET_Y }],
               rationale: `kitted + gate open — descend to the iron band (y${IRON_TARGET_Y}) and mine iron (have ${ironForArmor(bot)}/${IRON_BUFFER}), stay committed underground`,
               hints: { targetY: IRON_TARGET_Y, tier: tier.level, iron: ironForArmor(bot) } });
    }

    // 5b) ★TOOL-BUDGET UPKEEP (2026-07-02 断镐夜困 root fix): kit.sufficientForUnderground
    //     (modes.js:4959 — spare-pick-with-carried-table OR field-recraft kit) used to be ONLY a
    //     refusal gate: it blocked GO_UNDERGROUND/GET_DIAMOND but nothing ever RESTORED it, and
    //     dig paths that bypass the gate (achieve xray staircases) ground the lone pick to dust.
    //     This proposal is the restore half: while the invariant is broken and the materials are
    //     on hand, craft exactly the missing pieces (spare stone pick / carried table / sticks)
    //     via craftChain's array-preset form. @47: outranks the descents it protects
    //     (GET_DIAMOND@46, GO_UNDERGROUND@45), yields to bed/food/night/armor. Zero materials →
    //     not proposed (BOOTSTRAP_KIT's wood buffer + surface foraging own restocking); crafting
    //     failure → craftChain returns false → normal 3x/5min cooldown, no livelock.
    if (overworld && kit.picks >= 1 && !kit.sufficientForUnderground && !threat.actionable) {
        const cobbleCt = invCount(bot, /^(cobblestone|cobbled_deepslate)$/);
        const sticksCt = invCount(bot, /^stick$/);
        const tableCarried = invCount(bot, /^crafting_table$/) >= 1;
        const wants = [];
        if (!tableCarried) wants.push(['crafting_table', 1]);
        if (sticksCt < 4) wants.push(['stick', 1]);                       // 1 craft = 4 sticks
        const durableStonePlus = /stone|iron|diamond|netherite/.test(kit.pickTier || '');
        if (!durableStonePlus || kit.picks < 2) wants.push(['stone_pickaxe', 1]);
        const needsCobble = wants.some(([n]) => n === 'stone_pickaxe');
        // Affordability must match the ACTUAL craft cost or the proposal burns an honest
        // 3x/5min cooldown on an unaffordable craft (live 2026-07-02 01:48: woodUnits>=2
        // passed with 2 planks while the wanted crafting_table alone costs 4 — craftChain
        // rightly failed 3x). Sum the plank-equivalents of what's actually wanted:
        // table=4 planks, stick craft=2 planks, pick handle covered by the stick want.
        const woodNeed = wants.reduce((s, [n]) => s + (n === 'crafting_table' ? 4 : n === 'stick' ? 2 : 0), 0);
        const materialsOk = (!needsCobble || cobbleCt >= 3) && woodUnits(bot) >= Math.max(2, woodNeed);
        if (wants.length && materialsOk) {
            push({ kind: PROPOSAL_KIND.TOOL_UPKEEP, priority: 47, skill: 'craftChain',
                   args: [wants],
                   rationale: `tool budget broken (picks=${kit.picks} tier=${kit.pickTier} table=${tableCarried ? 'yes' : 'NO'}) — craft ${wants.map(w2 => w2[0]).join('+')} so a pick snapping deep never strands the bot`,
                   hints: { picksBudget: kit.picksBudget, wants: wants.map(w2 => w2[0]) } });
        }
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

    // ── ★NIGHT-ERRAND GATE (checkpoint #2, 2026-07-02: two cooldown storms in 20min — GET_BED/
    //    BOOTSTRAP_KIT/OPENING_VILLAGE/OPP_WHEAT_FARM/MIGRATE dispatched at night each yield/no-op
    //    BY DESIGN (prepNether's decision-layer night early-return, villageHarvest/wheatFarm night
    //    defers, migrate's night gate), each burned 3 strikes → the kernel rotated SIX kinds into
    //    5-min cooldowns and idled in the roulette, with the cooldowns bleeding into dawn recovery.
    //    If the skills won't act at night on the exposed surface, don't PROPOSE them there — the
    //    night chain (DUSK_*/NIGHT_*) + HOLD + GET_FOOD own that state. Underground bots (y<50)
    //    keep the errands: sealed night mining/crafting is real work the early-returns don't block. ──
    try {
        // ★phase-boundary interlock (checkpoint #13 dusk storm): the night-chain selector at
        // :827 engages at `phase !== 'day'` (dusk included) but this strip only fired at
        // strict 'night' — in the dusk window BOOTSTRAP_KIT/GET_BED were proposed while their
        // executors' own night checks (timeOfDay-based, dusk counts as night) refused BY
        // DESIGN → 3 quick strikes each, every single dusk. dawn intentionally NOT included:
        // errands there predate this gate and dawn is the recovery window.
        if ((time.phase === 'night' || time.phase === 'dusk') && overworld && Math.round(bot.entity.position.y) >= 50) {
            const DAY_ERRANDS = new Set([
                PROPOSAL_KIND.BOOTSTRAP_KIT, PROPOSAL_KIND.GET_BED, PROPOSAL_KIND.GET_ARMOR,
                PROPOSAL_KIND.GET_IRON_TOOLS, PROPOSAL_KIND.GET_IRON_ARMOR_SET,
                PROPOSAL_KIND.GET_DIAMOND_GEAR, PROPOSAL_KIND.GET_DIAMOND_ARMOR, PROPOSAL_KIND.BUILD_HOME,
                PROPOSAL_KIND.OPENING_SCOUT, PROPOSAL_KIND.OPENING_VILLAGE,
                PROPOSAL_KIND.OPP_WHEAT_FARM, PROPOSAL_KIND.OPP_SEIZE_VILLAGE, PROPOSAL_KIND.MIGRATE,
                // ★P0-1 REPLENISH_KIT: 提案端本就 day-only(白天门), 进这个集合只为下面的 commitment
                // 释放条款 — 白天承诺的地表补货跨入 dusk 时立即让位夜链, 不把 replenishKit 派进黑夜
                // 的地表砍树(与 BOOTSTRAP_KIT 同性质的日间差事)。
                PROPOSAL_KIND.REPLENISH_KIT,
            ]);
            // ★TOOL_UPKEEP is NOT a day errand (checkpoint #13, 2026-07-02 night: pick wore to 82%
            // at dusk, the gate stripped the restock proposal, the spare-pick craft later FAILED
            // 'no reachable table', the pick died, and BOOTSTRAP_KIT spun on 'no usable pickaxe'
            // all night). This gate exists for skills that early-return at night — craftChain has
            // no night early-return (crafts in place in seconds), its own gate already requires
            // !threat.actionable, and at @47 it only wins ticks the night chain (91-94) isn't
            // claiming. A pick crafted in a cooldown gap is exactly what keeps dawn productive.
            for (let i = out.length - 1; i >= 0; i--) if (DAY_ERRANDS.has(out[i].kind)) out.splice(i, 1);
            // ★release a held day-errand commitment too (12:56Z live: the strip blocks NEW
            // proposals but a commitment held from before dusk keeps re-dispatching its skill
            // into the night refusal — 3 wasted strikes + cooldown every dusk. Releasing here
            // hands the night chain the body immediately; the kind re-proposes at dawn.)
            try { if (bot._commitment && DAY_ERRANDS.has(bot._commitment.kind)) bot._commitment = null; } catch (e) {}
        }
    } catch (e) {}

    // ── ★KERNEL DISPATCH-FAILURE COOLDOWN filter: kernel._commit stamps bot._kindCooldownUntil[kind]
    //    after DISPATCH_FAIL_LIMIT consecutive customSkill failures (missing skill file / hard false),
    //    and nulls the livelocked bot._commitment. Filtering the kind HERE (the shared proposal source
    //    for BOTH modes.js commitGoal and the kernel) is what makes the release stick — otherwise
    //    modes.js:~5159 would re-commit the suppressed kind 2s later. FREE_PLAY never dispatches a
    //    skill so it never gains a cooldown entry → the list can never go empty. Expired entries are
    //    deleted so the kind naturally re-proposes. No bot._kindCooldownUntil (framework off / shadow /
    //    never failed) → pure no-op. ──
    try {
        const cd = bot && bot._kindCooldownUntil;
        if (cd) {
            const now = Date.now();
            // ★review :611 off-overworld cooldown cap: GET_BLAZE_RODS (nether) / SLAY_DRAGON (End)
            // are each the SOLE dispatchable proposal in their dimension (the overworld guard
            // suppresses everything else but FREE_PLAY, which maps to chosen:null), so the kernel's
            // 5-min dispatch cooldown would park the bot completely idle in a hostile dimension
            // with only reflex modes running. Clamp the primary kind's suppression to ≤60s there:
            // retries stay spaced (no hot 2s spin) but never a 5-minute stand-down among ghasts/
            // endermen. Clamping the stored value is idempotent and visible to modes.js's
            // commitGoal pass too (both read the same bot._kindCooldownUntil).
            const primaryKind = dim === 'the_nether' ? PROPOSAL_KIND.GET_BLAZE_RODS
                              : dim === 'the_end' ? PROPOSAL_KIND.SLAY_DRAGON : null;
            if (primaryKind && cd[primaryKind] && cd[primaryKind] > now + 60000) cd[primaryKind] = now + 60000;
            for (let i = out.length - 1; i >= 0; i--) {
                const u = cd[out[i].kind];
                if (u && now < u) out.splice(i, 1);
                else if (u) delete cd[out[i].kind];
            }
        }
    } catch (e) {}

    // ★2026-07-08 两态承诺锁 (进行态抬权): 若已承诺某开局 kind (OPENING_SCOUT / BOOTSTRAP_KIT /
    //   OPENING_VILLAGE) 且它仍在表内(未被上面的失败冷却撤下), 排序前给它 +OPENING_COMMIT_BOOST。
    //   → 承诺释放后的重选必再选中同一 kind, 消除 SCOUT@92↔BOOTSTRAP@90 的 2 分翻转。放在冷却过滤之后:
    //   真失败被冷却撤下的 kind 不在 out 里 → find 不中 → 抬不了权 → 不会把坏选择永久焊死(逃逸保留)。
    // ★★DAY-ONLY 门 (2026-07-08 夜链 respec 评审补): 此抬权只为消【日间】SCOUT↔BOOTSTRAP churn
    //   (OPENING_SCOUT 本就日间限). 但 BOOTSTRAP_KIT@90(noPick) 无相位门, 夜里也在表内 —— 若在此
    //   抬到 98, commitGoal 的 nightPre (只在 night plan.priority > livePri 时夺权; 夜带顶格 94) 就【永远
    //   夺不回】, 一个夜幕降临时还在 bootstrap 的无镐 bot 会整夜跑 prepNether 黑灯砍树, 正好击穿
    //   "SEAL_FORT@91 必须压过 BOOTSTRAP_KIT@90" 这条夜链红线. 故仅白天抬权; 黄昏/夜里不抬 → 夜链照常夺权.
    try {
        const _cc = bot && bot._commitment && bot._commitment.kind;
        if (time.phase === 'day' && (_cc === TASK.OPENING_SCOUT || _cc === PROPOSAL_KIND.BOOTSTRAP_KIT || _cc === TASK.OPENING_VILLAGE)) {
            const _p = out.find(o => o.kind === _cc);
            if (_p) _p.priority += OPENING_COMMIT_BOOST;
        }
    } catch (e) {}

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

/** Bootstrap = pickaxe + stone-tier + a wood buffer (user #3 don't-stop-at-2-logs).
 *  ★FALSE-BLOCKER FIX (worker-frozen 0701, T-0110): once pick+stone-tier are secured, the
 *  wood-buffer sub-goal must NOT pin the bot when wood is UNREACHABLE in place (no tree ≤
 *  woodReachDist; nearest known landmark 40b+ away). Live: 41min+ frozen-alive @88,65 —
 *  BOOTSTRAP_KIT@66 stayed sticky (isGoalDone=false on wood 0/8) while prepNether no-op'd
 *  every 1.5s (SKIP wood buffer: no cheap tree within 18b), starving MIGRATE@60/tier-chain.
 *  Fresh spawns near trees keep woodKnownReach=true → still stock wood to the buffer.
 *  Stone-kit-ready + wood UNSTOCKABLE-in-place → bootstrap DONE so the sticky commitment
 *  releases and commitGoal re-selects MIGRATE(force,stuckTerrain) / GO_UNDERGROUND — both
 *  beat standing frozen (relocate to trees, or descend for iron with the 2 stone picks). */
function isBootstrapDone(world, bot) {
    if (!(world.kit.picks >= 1) || !hasStoneTierPick(world)) return false;
    if (woodUnits(bot) >= WOOD_BUFFER) return true;
    const woodReachable = !!(world.landmarks && world.landmarks.woodKnownReach);
    return !woodReachable; // stone-kit-ready but wood unstockable in place → don't pin, let MIGRATE/descend win
}

/** Has the committed goal of `kind` been satisfied? (Completion criteria.) */
export function isGoalDone(kind, world, bot) {
    const w = world || EMPTY_WORLD;
    switch (kind) {
        case PROPOSAL_KIND.BOOTSTRAP_KIT: return isBootstrapDone(w, bot);
        // ★SARCOPHAGUS RESCUE done = surface band regained OR a usable pick appeared
        // (either way BOOTSTRAP_KIT@90 takes over the kit chain from here).
        case PROPOSAL_KIND.SURFACE_RESCUE:
            return (bot ? Math.round(bot.entity.position.y) : 63) >= 55 || (w.kit && w.kit.picks >= 1);
        // ★ration-aware (checkpoint #7): done = hunger stocked AND >=2 takeaway rations
        // carried (the dive gate's requirement — hunting kills bank the raw meat that
        // counts). Food deserts stay bounded: dry feedUp runs return false → 3-strike
        // cooldown releases the commitment as before.
        case PROPOSAL_KIND.GET_FOOD:      return (w.vitals.food >= FOOD_STOCK) && carriedRations(bot) >= 2;
        // Done when fully armored OR banked iron can't afford the cheapest MISSING piece (see
        // ironArmorGoalDone — a flat `<4` livelocked at e.g. boots owned + 4 iron, helmet costs 5).
        case PROPOSAL_KIND.GET_ARMOR:     return ironArmorGoalDone(w, bot);
        case PROPOSAL_KIND.GET_BED:       return bedKnown(bot);
        // ★tool-budget: done when the descent invariant is restored; ALSO release when the
        // materials ran out mid-craft (the gate stops proposing then — a held commitment
        // would starve the chain waiting on cobble/wood that mining/foraging must supply).
        case PROPOSAL_KIND.TOOL_UPKEEP:
            return !!(w.kit && w.kit.sufficientForUnderground)
                || invCount(bot, /^(cobblestone|cobbled_deepslate)$/) < 3 || woodUnits(bot) < 2;
        // ★P0-1 REPLENISH_KIT done = 补给基线的迟滞释放: 总镐数>=2 且 planksEq>=8。触发是 <2/<4
        // (proposeTasks 1c) — 触发↔释放刻意不对称(planks <4 触发但 >=8 才放手), 与 GET_FOOD 的
        // FOOD_STOCK buffer 同思路: 补到有富余再走, 防 4↔5 边界抖动的提案轮转。
        case PROPOSAL_KIND.REPLENISH_KIT: {
            // ★2026-07-06 tier 参数化释放: fodder 底线(总镐>=3) + 木料 buffer + tier 镐达标(铁>=4/钻>=3)。
            //   tier 达标用 target(释放线, 与触发线 triggerFloor 迟滞不对称: 铁 ≤1 触发但 >=4 才放手)。
            const plan = pickStockPlan(w);
            // ★review 修: tier 达标 OR 手头材料已不够再造一把本 tier 镐 → 释放 (与触发 _planMat 同真相的负命题)。
            //   否则 executor 造到材料耗尽仍不足 target, isGoalDone 永假 → commitGoal '(holding commitment)'
            //   反复重派 → 5min 冷却 churn, 抢走采矿的身体。释放后身体回采矿(去补锭/钻), 缺口自然补齐。
            const tierOk = !plan || effectivePicksMatching(bot, plan.re) >= plan.target || !pickPlanHasMat(bot, plan);
            return totalPicks(bot) >= REPLENISH_PICKS_MIN && tierOk && woodUnits(bot) >= REPLENISH_PLANKS_RELEASE;
        }
        case PROPOSAL_KIND.MIGRATE:       return !w.migration.recommend;     // arrived at a livable biome
        // ── ★T-0093 tier chain completion. ──
        // GET_IRON_TOOLS done = an iron+ pickaxe is now in hand (the rung was about crafting it).
        case PROPOSAL_KIND.GET_IRON_TOOLS:   return hasIronTierPick(w);
        // ★T-0097 NIGHT_SMELT_IRON done = same target (an iron-tier pick exists) — holds the night
        // commitment sticky across the smelt→craft hand-off until the iron pickaxe is actually crafted.
        case TASK.NIGHT_SMELT_IRON:          return hasIronTierPick(w) || (invCount(bot, /^raw_iron$/) === 0 && invCount(bot, /^iron_ingot$/) < 3);   // ★FIX (worker-sync 0630 frozen-alive): the sticky NIGHT_SMELT_IRON deadlocked into a smeltSafe no-op spin — chosen at dusk w/ raw_iron≥3, but once the iron was smelted+consumed WITHOUT reaching hasIronTierPick (ingots banked/used, no lasting iron pick), it stayed sticky dispatching smeltSafe('raw_iron',N) at raw_iron=0 → no-op every 1.5s, frozen until watchdog (live: pinned 9min @54,58 mob=FREE/ENC). Release when there's nothing left to smelt OR craft → re-evaluate → mine more iron. Does NOT gate pick-making.
        // ★P1-4 GET_IRON_ARMOR_SET 复活后语义 = 采集端(下铁带补铁库存), done 与提案门(RUNG 1.5)共用
        // ironDemandTotal = max(缺甲总成本, portal kit 铁成本): 铁攒够总需求即释放(demand=0 时恒真,
        // 覆盖"甲齐且 portal kit 无缺"), → GET_ARMOR@68 接棒锻造。不再 mirrors GET_ARMOR 的
        // ironArmorGoalDone("cheapest-next-piece"消费口径) — 采集端用它会攒够 4 锭就撒手, 永远到
        // 不了成套 24 锭(结构洞#4 的另一半: 采集↔消费两端口径必须分开)。
        case PROPOSAL_KIND.GET_IRON_ARMOR_SET: return ironForArmor(bot) >= ironDemandTotal(w, bot);
        // ★T-0092 GET_DIAMOND done = banked the DIAMOND_FLOOR buffer (≥1 diamond pick + spare worth).
        //   Stays committed deep until the floor is met → the diamond venture isn't abandoned after
        //   one ore. Survival (HOLD/food/night) still preempts via isEmergency/nightPre, so a deep
        //   commitment never traps the bot through danger.
        case PROPOSAL_KIND.GET_DIAMOND:      return diamondsOnHand(bot) >= diamondTarget(bot) || diamondGearComplete(bot);   // ★相位: 无钻镐→3(造首镐); 有钻镐→40(滚雪球) 或 装备齐即停(免回挖)
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
            // ★2026-07-08 两态承诺锁 (硬化释放): 前瞻态(未承诺 SCOUT)保持原判据 — 字节一致。
            //   进行态(已承诺 SCOUT)不因 lm.wood&&lm.village 闪真而释放(该判据会抖 → SCOUT↔BOOTSTRAP
            //   翻转根因之一); 改认更稳的 phase 信号: computeOpening 真正离开 SCOUT 相(找到可达 wood /
            //   近村庄 / bootstrap 完成)才 done。phase 仍 SCOUT=继续侦察(正确); 若 scout 真失败, 上游
            //   3-strike 派发冷却会撤下 SCOUT 提案 → 不会永久焊死。
            const committedToScout = !!(bot && bot._commitment && bot._commitment.kind === TASK.OPENING_SCOUT);
            if (committedToScout) return !!(w.opening && w.opening.phase && w.opening.phase !== 'SCOUT');
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
        // ── ★ENDGAME chain completion (one-liners over endgameNeeds/endgameState/dimOf — the
        //    proposer gates and completion share one truth, so a released goal is never re-gated
        //    open by a disagreeing predicate). ──
        // Done = diamond pick in hand OR the materials were lost (material-lost release mirrors
        // GET_ARMOR). Belt-and-braces with craftChain's zero-craft→false return (review :934):
        // a fully futile dispatch now trips the kernel's 3x/5-min cooldown, and this release
        // covers the diamonds-spent/lost path the cooldown can't see.
        case PROPOSAL_KIND.GET_DIAMOND_GEAR: return invCount(bot, /^(diamond|netherite)_pickaxe$/) >= 1 || diamondsOnHand(bot) < DIAMOND_FLOOR;
        // ★钻甲 done = 4 件钻甲齐 OR 钻石不够下一件+镐保留 (材料短缺释放, 镜像 GET_ARMOR — 缺口归钻石雪球补)。
        case PROPOSAL_KIND.GET_DIAMOND_ARMOR: return diamondArmorPieces(bot) >= 4 || diamondsOnHand(bot) < diamondArmorFloor(bot);
        case PROPOSAL_KIND.GET_PORTAL_KIT:   { const n = endgameNeeds(bot); return n.obsOk || dimOf(bot) !== 'overworld' || n.blazeShort === 0; }
        case PROPOSAL_KIND.ENTER_NETHER:     return dimOf(bot) === 'the_nether';
        // Success-exit AND death-respawn both land in the overworld; in-nether it holds sticky
        // through the skill's internal farm→exit phases.
        case PROPOSAL_KIND.GET_BLAZE_RODS:   return dimOf(bot) === 'overworld';
        // Night over (daybreak) releases like the other night kinds.
        case PROPOSAL_KIND.HUNT_PEARLS:      return endgameNeeds(bot).pearlsShort === 0 || w.time.phase === 'day';
        // Nothing left to convert → release to the resupply stages (mirrors GET_ARMOR).
        case PROPOSAL_KIND.CRAFT_EYES:       { const n = endgameNeeds(bot); return n.eyesShort === 0 || n.craftable === 0; }
        case PROPOSAL_KIND.GO_END:           return dimOf(bot) === 'the_end' || !!endgameState(bot).dragonDead;
        // Death→overworld respawn releases; GO_END then recommits re-entry via the persisted portalRoom.
        case PROPOSAL_KIND.SLAY_DRAGON:      return !!endgameState(bot).dragonDead || dimOf(bot) !== 'the_end';
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
        || kind === TASK.NIGHT_SMELT_IRON    // ★T-0097: night iron-conversion is a first-class night plan
        || kind === PROPOSAL_KIND.HUNT_PEARLS;   // ★ENDGAME: night enderman hunt @94.5 — dusk-dethrones a stale daytime commitment; once committed the !isNightPlan guard stops GO_BED/SEAL re-flips
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
        // ★2026-07-06 (oracle评审 P2): skill 与 args 必须原子同刷 — 同一 kind 现在会在
        //   mineOres{ore,count}/mineDown{targetY} 间按 oracle 新鲜度切换, 只刷 args 会让
        //   '(holding commitment)' 回退用旧 skill 配新 args (mineDown 收到 {ore:'iron'} →
        //   targetY 默认 45, 挖错带)。
        if (bot && bot._commitment) {
            bot._commitment.args = (match.args || c.args || []);
            if (match.skill) bot._commitment.skill = match.skill;
        }
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
        // ★2026-07-05 用户宽迟滞令: "低于5个面包开始觅食, 一直到64个才停"。粘性状态机:
        // bread<5 挂 engage 旗 → 目标 64; >=64 摘旗 → 目标回 5 (不再提案)。farm 为主粮
        // (面包), 肉降级为顺手收 — GET_FOOD 囤肉档同步被 bread/farm 门压制。
        // canFarm 门保留但放宽: 有 farm.json 锚也算 (熟期巡逻要能派收获)。
        const canFarm = invCount(bot, /^wheat_seeds$/) > 0 || invCount(bot, /^wheat$/) >= 3
            || !!(w.farm && Number.isFinite(w.farm.x));
        if (!canFarm) return 0;
        const breadStock = invCount(bot, /^bread$/);
        if (breadStock < 5) bot._breadEngaged = true;
        else if (breadStock >= 64) bot._breadEngaged = false;
        return bot._breadEngaged ? 64 : 5;
    } catch (e) { return 0; }
}

/** Cheap check whether a bed/respawn anchor is known. Defensive — reads files the
 *  supervisor maintains; absence ≠ error. */
function bedKnown(bot) {
    try {
        if (bot && bot._world && bot._world.kit && bot._world.kit.hasBed) return true;
    } catch (e) {}
    // ★checkpoint#25 P1-B: kit.hasBed is written by NOBODY (grep across src: this read is the
    // single hit), so bedKnown() was恒假 — GET_BED@50 kept proposing/churning forever even with a
    // REAL bed already known (live 06:19: setBed logged spawnSet=true; landmarks counts.bed=2 with
    // bed@56,67,160), and the committed GET_BED could never isGoalDone(:1082). Truth lives in two
    // places this now reads:
    //   1) bot._world.landmarks.bed — modes.js C328 landmark memory (nearest-known real *_bed block
    //      ever scanned, persisted to landmarks.json across respawn/restart; 'bed' is a persistent
    //      kind, so non-null exactly when counts.bed>0 — both checked defensively).
    //   2) bots/_supervisor/bed.json WITHOUT a src field — setBed.js:225 writes {x,y,z,t} (no src)
    //      ONLY after placing+activating a real bed ("Respawn point set"). The src:'auto-site-select'
    //      (setBed.js:84) and src:'migrate' (migrate.js:482) writes are HOME-ANCHOR site picks made
    //      BEFORE any bed exists — those must NOT count, or GET_BED would stop proposing a bed the
    //      bot never actually built.
    // The night GO_BED chain (computeNightPlan's bedAffordable/_bedLm) already reads landmarks
    // directly and is untouched — this only fixes the GET_BED proposal gate (:578) + goal-done.
    try {
        const lm = bot && bot._world && bot._world.landmarks;
        if (lm && (lm.bed || (lm.counts && Number(lm.counts.bed) > 0))) return true;
    } catch (e) {}
    // ★perf 2026-07-09: this bed.json read used to hit disk on EVERY ~2s decide-tick whenever no
    // bed landmark was known yet (the churny early/mid-game state) — reached from the sync
    // proposeTasks/isGoalDone(GET_BED) chain, so it can't be awaited. It is the credible source of
    // the documented ~515ms world_model frame-stall (a slow read under Windows AV / a concurrent
    // supervisor rewrite blocks the whole tick). Memoize the disk result on bot._bedFileMemo with a
    // short TTL: the "real placed bed" flag flips at most once per life, and a freshly-placed bed is
    // caught earlier+in-memory by the landmarks check above (modes.js C328), so 10s is plenty fresh.
    // Path resolved via import.meta.url (matching endgameState above) instead of the old cwd-relative
    // 'bots/_supervisor/bed.json' — robust if cwd ever isn't the project root.
    try {
        const now = Date.now();
        const memo = bot && bot._bedFileMemo;
        if (memo && (now - memo.t) < 10000) return memo.v;
        let v = false;
        try {
            const p = resolve(dirname(fileURLToPath(import.meta.url)), '../../../bots/_supervisor/bed.json');
            const bj = JSON.parse(readFileSync(p, 'utf8'));
            if (bj && typeof bj.x === 'number' && !bj.src) v = true;   // spawn anchored by a real placed bed
        } catch (e) {}
        if (bot) bot._bedFileMemo = { t: now, v };
        return v;
    } catch (e) {}
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
