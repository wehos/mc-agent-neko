import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';
import fs from 'fs';
import Vec3 from 'vec3';
// Framework v2 lava_guard — pure read predicate (no lane, no flag), safe to call
// from a reflex. Wires the blueprint §E.2 "never clutch over lava" guard into the
// live MLG reflex below (the inline floor-scan skipped lava: boundingBox 'empty'≠'block').
import { canClutchWater } from './framework/tools/lava_guard.js';

const FAMINE_FOOD_RE = /cooked_|_bread|^bread$|apple|golden_apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|melon_slice|sweet_berries|_stew|rabbit|baked_|rotten_flesh|spider_eye/;
const NORMAL_FOOD_RE = /cooked_|_bread|^bread$|apple|golden_apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|melon_slice|sweet_berries|_stew|rabbit|baked_/;

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

function famineBodyFreeze(agent, owner) {
    const bot = agent && agent.bot;
    if (!bot || !bot.entity) return false;
    // ★C228: yield to an explicitly-dispatched recovery VENTURE (③ missionNether's FAMINE
    // backoff dispatches forageExplore to walk OUT of a food desert). The skill-name allowlist
    // below CANNOT see it — a nested customSkill leaves bot._currentSkill = the sticky
    // ('missionNether'), so the freeze pinned the body and the dispatched forage couldn't move
    // → permanent absorbing-state freeze at food0/hp10 (the multi-hour lock). While the venture
    // flag is fresh the mover owns the body (forageExplore carries its own night/hostile/hp-abort
    // gates — proper exit, not a hole). Same flag-yield mechanism as C225's noRegenSafeAirHold.
    if (Date.now() < (bot._recoveryVentureUntil || 0)) return false;
    if (bot.food > 0 && !(bot.food <= 2 && bot.health <= 8)) return false;
    const skill = bot._currentSkill || '';
    // Food-acquisition / escape skills MUST be allowed to move the body even at food=0 — else
    // the freeze has no exit and the bot soft-locks forever (C210). forage carries its own
    // travel-budget safety gate (won't march into deep water / far targets at low food), so
    // whitelisting it here is the freeze's proper exit, not a hole. escapePlan likewise owns
    // movement authority when breaking a trap.
    if (/feedUp|surfaceUp|consume|auto_eat|forage|forageExplore|migrate|escapePlan|digReset/i.test(skill)) return false;
    const edible = bot.inventory && bot.inventory.items().some(i => i && i.name && FAMINE_FOOD_RE.test(i.name));
    if (edible) return false;
    const p = bot.entity.position;
    const feet = bot.blockAt(p) || { name: 'air' };
    const head = bot.blockAt(p.offset(0, 1, 0)) || { name: 'air' };
    if (/water|lava|fire/.test(feet.name || '') || /water|lava|fire/.test(head.name || '')) return false;
    if (!bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.25) return false;
    if (Date.now() - (bot.lastDamageTime || 0) < 4000) return false;
    const hostile = Object.values(bot.entities || {}).some(e =>
        e && e !== bot.entity && e.position && mc.isHostile(e) && e.position.distanceTo(p) < 12);
    if (hostile) return false;
    try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
    try { bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop(); } catch (e) {}
    try { bot.clearControlStates(); } catch (e) {}
    if (Date.now() - (bot._lastFamineFreezeLogAt || 0) > 15000) {
        bot._lastFamineFreezeLogAt = Date.now();
        try {
            fs.appendFileSync('bots/_supervisor/progress.txt',
                `[${new Date().toISOString()}] [${owner}] FAMINE body freeze: food=${bot.food} hp=${Math.round(bot.health)} pos=${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} skill=${skill || '-'}\n`);
        } catch (e) {}
    }
    return true;
}

// ★C332 (T-0063, combat reflex arbitration / 反射冲突下沉): "拿着剑都杀不死贴脸僵尸" 的真根不是
// "没换剑"(attackEntity/defendSelf/shieldFight 都已装剑) 而是 self_preservation 的 SURFACE-SWIM 反射
// (优先级高于 self_defense) 在水边把战斗碎片化——events 'Fighting zombie!' 被 'In water — getting
// out' 反复抢控制, 每次脱困又 equipForBlock 把剑顶成镐 → 战斗拿不到持续输出 → 自掉 3×1HP 僵尸杀不死。
// 单点 resolve(用户: 门要加公共入口不是单个调用方): 贴脸非 creeper 怪 + 能赢这一仗时, 让"整理性"环境
// 脱困反射(浅水游上岸 / POCKET 步出)统一 defer 给 self_defense。
// ★SCOPE 铁律 — 绝不压过 LETHAL 环境急症: 调用方只在 NON-lethal 分支(y≥55 浅水 swim-to-shore)询问本门;
// 真溺水(deep/out-of-air, drowning&&y<55)、岩浆、窒息分支照旧最高优先(claude-C 的 T-0049/T-0056 反射
// 保持权威)——环境杀得比怪快的场合必须环境反射赢。本门只抑制"怪在脸上时去岸边/挪窝"这类非致命脱困。
function combatHasPriority(bot) {
    try {
        if (!bot || !bot.entity) return false;
        if (bot.health <= 6) return false;                                   // 危血 — 让 flee/seal 赢, 别站撸
        const hasWeapon = bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name) && !/pickaxe/.test(i.name));
        if (!hasWeapon) return false;                                        // 裸手 — 别站撸送命
        const p = bot.entity.position;
        let near = 0, ptBlank = false;
        for (const e of Object.values(bot.entities || {})) {
            if (!(e && e.position && mc.isHostile(e) && !/creeper/i.test(e.name || ''))) continue;
            const d = e.position.distanceTo(p);
            if (d < 8) near++;
            if (d < 3.2) ptBlank = true;                                     // 进近战臂展 = 有仗要打
        }
        if (!ptBlank) return false;                                         // 没怪在脸上 — 无战斗可护, 照常脱困
        if (near >= 3) return false;                                        // 被围(3+) — 脱困优先于站撸(与 self_defense swarmed 门一致)
        return true;
    } catch (e) { return false; }
}

// ★C353 (T-0063, worker-combat 06-27): RANGED-UNREACHABLE-TRAP — disengage 杀不死的"够不到的远程怪"。
// 真根(监工实锤): bot 困封闭口袋(mobility=POCKET/ENTOMBED, enclosed=true, exits=[])时, 墙外一只
// 远程骷髅在 self_defense range 内 → self_defense 每 tick execute shieldFight → ranged 分支
// goToPosition 朝怪靠近, 但被墙堵死(path 不通秒回 catch) → 距离永远 d>3.2 靠不近 → 对着够不到
// 的怪空挥, 怪血不掉 → 'Fighting skeleton!' ×10/3s 疯刷。而 self_defense(modes idx 2398) 在
// mobility(2948) 之前, 它 active=true → ModeController `if(mode.active) break` 跳过 mobility →
// POCKET 脱困反射(pillar/dig-up)永远不触发 → 三重互锁(战斗占身体 / 脱困派不出 / food0 饿着)永久卡死。
// 修: self_defense 入口检测此陷阱 → 不 engage, 让位 mobility 脱困 + kernelDriver GET_FOOD。
// ★disengage ≠ 不防御 (C32/C284 安全铁律): 只对"远程射手(skeleton/stray/pillager) + bot 被封闭困住
//   + 该怪不在真贴脸臂展(≥2.5b, 即隔着墙够不到)"放手。任何近战怪(zombie/spider/husk…)或真贴脸(<2.5b)
//   的怪仍照打 — 那些是 bot 出得了手、打得死的, 放手 = 被磨杀。creeper 始终走 self_pres 不受此影响。
// 判据全部来自 bot 自有信号(_mobility 状态机 + 实体距离), 零额外探测成本。
function rangedUnreachableTrap(bot) {
    try {
        if (!bot || !bot.entity) return false;
        const mob = (bot._mobility && bot._mobility.state) || '';
        const enclosed = !!(bot._mobility && bot._mobility.enclosed);
        const noExit = !!(bot._mobility && Array.isArray(bot._mobility.exits) && bot._mobility.exits.length === 0);
        // 完全封闭(无水平出口的口袋 + 顶上也封 / 活埋 / 封室): bot 隔着墙, 横挥够不到墙另一侧的任何怪 —
        // 哪怕实体距离 d=0.4(贴在墙背面)也打不到(实锤 06-27: skeleton d=0.4 @墙外, 'Fighting' 疯刷血不掉)。
        // 这种状态下"真贴脸射手用近战打断"的假设失效(bot 出不去, 挥到的是墙)。
        const fullyBoxed = /ENTOMBED|SEALED/.test(mob) || (enclosed && noExit) || (mob === 'POCKET' && noExit);
        // 必须先"被困"才考虑 disengage(开阔地能追上去打, 不放手)。被困 = 封闭环境 或 困态状态机。
        const trapped = enclosed || /POCKET|ENTOMBED|SEALED/.test(mob);
        if (!trapped) return false;
        const p = bot.entity.position;
        const RANGED = /skeleton|stray|pillager/i;          // 射手 — 隔墙也能射 bot, 但 bot 横挥够不到它
        let sawRanged = false, meleeReachable = false;
        for (const e of Object.values(bot.entities || {})) {
            if (!(e && e.position && mc.isHostile(e))) continue;
            const n = (e.name || '').toLowerCase();
            if (/creeper/.test(n)) continue;                // creeper 归 self_pres, 不在此门
            const d = e.position.distanceTo(p);
            if (d >= 12) continue;                          // 太远不算威胁(超 self_defense 索敌)
            if (RANGED.test(n)) {
                // 完全封闭 → 任何距离的射手都够不到(隔墙, 实锤 d=0.4 也打不到); 半困(有出口) → 只把非贴脸
                // (≥2.5b)的算够不到, 真贴脸(<2.5b)的可能挪一步近战打断, 留给 self_defense。
                if (fullyBoxed || d >= 2.5) sawRanged = true;
                else meleeReachable = true;
            } else {
                // 近战怪(zombie/spider/husk…): 真贴脸 <2.5b 默认打(墙可能薄/有缝, 保命优先, C32/C284),
                // 半困(非完全封闭)时臂展内 <4.5b 也打(能挪过去近战)。
                // ★C354 (T-0063): fullyBoxed(exits=[] 真封闭)且 bot 最近 >4s 未受伤 = 怪隔墙够不到 bot
                // (hp 不掉实证), bot 也够不到怪 → 不算 meleeReachable, 放手让 rangedUnreachableTrap→true、
                // POCKET 脱困/觅食接管。否则隔墙近战怪 d=0.4 让 meleeReachable 永真, bot 困口袋空打骷髅
                // 饿死(实锤 06-27 91,53,160 跨多天)。真受伤(墙薄怪真打到)时仍按贴脸算, 还手保命。
                const recentlyHurtBM = (Date.now() - (bot.lastDamageTime || 0)) < 4000;
                if ((d < 2.5 && (!fullyBoxed || recentlyHurtBM)) || (d < 4.5 && !fullyBoxed)) meleeReachable = true;
            }
        }
        // 只有"够不到的远程射手存在 且 无任何能近战打到的目标"才放手脱困觅食。
        return sawRanged && !meleeReachable;
    } catch (e) { return false; }
}

// ★C341 (T-0074): SEALED-ROOM detection. The mobility state machine reads any adjacent walkable air as
// an `exit` → a bot boxed into a 3x3 cobble room (interior air, but EVERY wall solid, no way out) is
// mislabeled FREE → no escape reflex fires → it sits trapped forever WITH a pickaxe in the bag (用户实锤:
// claude-A 的 bunker 把她封进 3x3x2 cobble 密室). ENTOMBED only covers the 1x1 point-blank case (head
// solid); a roomy seal has air to stand in, so it never triggers. Distinguish a sealed room from genuine
// open space by a BOUNDED flood-fill of the reachable air: if the flood EXHAUSTS within a small cap (fully
// walled, no exit), it's sealed; if it spills past the cap (a tunnel to a cave / the open surface / a
// chimney to sky), it's free. No per-cell sky probe needed — any opening lets the flood escape past the
// cap. Cheap, and the caller only runs it when locally FREE/POCKET *and* covered-above (the only state
// that can BE a sealed room), so it costs ~0 in the open. Returns {sealed, cells}.
function detectSealedRoom(bot) {
    try {
        if (!bot || !bot.entity) return { sealed: false };
        const solid = (b) => b && b.boundingBox === 'block';
        const start = bot.entity.position.floored();
        const stand = (q) => {                 // a cell the body can occupy: feet+head non-solid, non-lava
            const f = bot.blockAt(q), h = bot.blockAt(q.offset(0, 1, 0));
            if (solid(f) || solid(h)) return false;
            if (/lava/.test((f && f.name) || '') || /lava/.test((h && h.name) || '')) return false;
            return true;
        };
        if (!stand(start)) return { sealed: false };
        const CAP = 130;                       // > CAP reachable cells ⇒ "open enough", not a trap
        const seen = new Set([`${start.x},${start.y},${start.z}`]);
        const q = [start];
        let head = 0;
        while (head < q.length) {
            if (seen.size > CAP) return { sealed: false };          // flood spilled out → open
            const c = q[head++];
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
                const n = c.offset(dx, dy, dz);
                const k = `${n.x},${n.y},${n.z}`;
                if (seen.has(k)) continue;
                if (stand(n)) { seen.add(k); q.push(n); }
            }
        }
        return { sealed: true, cells: seen.size };                 // flood exhausted within cap + covered ⇒ sealed
    } catch (e) { return { sealed: false }; }
}

function lowHpNoRegenContainedHold(bot) {
    if (!bot || !bot.entity) return null;
    // ★RECOVERY-SKILL EXIT: a deliberately-dispatched escape/relocate/forage skill MUST be able
    // to move even at low hp — otherwise this hold vetoes ALL supervisor-skill movement (incl.
    // the very food-seeking that would save the bot), and a food-starved bot FAMINE-holds to a
    // permanent stall (the multi-hour hp7/food4 lock). These skills carry their own per-step
    // hp-abort / safety gates, so this is the hold's proper exit, not a hole.
    // ★T-0101/T-0083 FROZEN-ALIVE 互锁破除 (worker-frozen): feedUp/villageHarvest 加入放行白名单。
    //   旧注释自相矛盾("feedUp keep their low-hp conservatism")——但 feedUp/villageHarvest 正是
    //   解 food=0 的唯一觅食路径,被这个 hold 挡住移动 = 死锁的核心(9h 实锤)。决策层(world_model
    //   isFamineStall)已改派它们去 village 觅食,这里必须放行让它们移动。它们自带 hostileNear/
    //   hp gate + villageHarvest hard-defers on hostiles>2/hp<=4,不会无脑冲怪堆(C32 安全约束保留)。
    //   且本函数 149-151/174 行已对 water/lava/fire/坠落/被弹/贴脸 creeper 返回 null(那些 LETHAL
    //   情形不进入此 hold)→ 放行觅食只发生在"封箱安全但食料切れ"的正确场景。
    if (/forageExplore|escapePlan|digReset|feedUp|villageHarvest/i.test(bot._currentSkill || '')) return null;
    if (!(bot.health <= 8 && bot.food < 18)) return null;
    const hasNormalFood = bot.inventory && bot.inventory.items().some(i => i && i.name && NORMAL_FOOD_RE.test(i.name));
    if (hasNormalFood) return null;
    const p = bot.entity.position;
    const feet = bot.blockAt(p) || { name: 'air' };
    const head = bot.blockAt(p.offset(0, 1, 0)) || { name: 'air' };
    if (/water|lava|fire/.test(feet.name || '') || /water|lava|fire/.test(head.name || '')) return null;
    if (!bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.25) return null;
    if (Date.now() - (bot.lastDamageTime || 0) < 4000) return null;

    let covered = false;
    try {
        for (let dy = 2; dy <= 6; dy++) {
            const b = bot.blockAt(p.offset(0, dy, 0));
            if (b && b.boundingBox === 'block') { covered = true; break; }
        }
    } catch (e) {}
    const mob = bot._mobility ? (bot._mobility.state || '') : '';
    const enclosed = !!(bot._mobility && bot._mobility.enclosed);
    if (!(/MAROONED|POCKET|ENTOMBED/.test(mob) || enclosed || covered)) return null;

    let closest = Infinity;
    let closestName = null;
    for (const e of Object.values(bot.entities || {})) {
        if (!(e && e !== bot.entity && e.position && mc.isHostile(e))) continue;
        const d = e.position.distanceTo(p);
        if (d < closest) {
            closest = d;
            closestName = e.name || 'hostile';
        }
    }
    if (closestName && (closest < 4.25 || (/creeper/i.test(closestName) && closest < 5.5))) return null;
    return { mob, enclosed, covered, closest, closestName };
}

// ★T-0101/T-0083 FROZEN-ALIVE 互锁破除 (worker-frozen) — 反射层这一端。
//   决策层(world_model.js isFamineStall)已破 HOLD@95 与 villageClose 否决,改派 GET_FOOD/
//   villageHarvest 去 village 觅食;kernelDriver reflexBusy 也已放行。但 self_preservation 反射
//   仍会每拍 execute 一个 hold(wait)抢占身体 → 派发的觅食 skill 跑不动(worker-food 9h 实锤:
//   "打破日志疯刷但 bot 从不真走")。所以反射层也必须在饥饿僵局+觅食 skill 运行时让位。
//   判据与 world_model.js / kernelDriver.js 同口径(单一真相):低血纯因 food 见底(<=2)不回血
//   + 无 LETHAL 急症(贴脸 creeper<4.5 / 正在挨打 / hp 极危<=4 / swarm 围殴贴脸)。
//   ★安全约束(C32): LETHAL 急症一律压制——不放行,仍守 hold/backoff(出洞撞 creeper 送死)。
//   ★只在觅食 skill(feedUp/villageHarvest/forageExplore)真在跑时让位,空 commitment 不让位
//   (否则 bot 干站着,反射该接管避险)。
function famineForageActive(bot) {
    try {
        if (!bot || !bot.entity) return false;
        const cur = bot._currentSkill || '';
        if (!/feedUp|villageHarvest|forageExplore/i.test(cur)) return false;
        const hp = bot.health != null ? bot.health : 20;
        const food = bot.food != null ? bot.food : 20;
        if (!(food <= 2 && hp < 10)) return false;
        // food<18 = 无自然回血(canRegen=false 的近似:这里直接用 food<18)。food<=2 已远低于此。
        // LETHAL 环境急症检测(就近实测,不依赖 bot._world 新鲜度)。
        if (Date.now() - (bot.lastDamageTime || 0) < 2500) return false;       // 正在挨打
        if (hp <= 4) return false;                                             // hp 极危
        const p = bot.entity.position;
        let creeperD = Infinity, actionable = 0;
        for (const e of Object.values(bot.entities || {})) {
            if (!(e && e !== bot.entity && e.position && mc.isHostile(e))) continue;
            const d = e.position.distanceTo(p);
            if (/creeper/i.test(e.name || '') && d < creeperD) creeperD = d;
            // 可达威胁(与 world_model 4521 同口径: d<12 且 |dy|<=4),墙外/够不到的怪不算 LETHAL。
            if (d < 12 && Math.abs(e.position.y - p.y) <= 4) actionable++;
        }
        if (creeperD < 4.5) return false;                                       // 贴脸苦力怕
        if (actionable >= 2) return false;                                     // swarm 真·可达围殴
        return true;
    } catch (e) { return false; }
}

function tableRecoveryHold(bot) {
    if (!bot || !bot.entity) return null;
    let isNight = false;
    try {
        const t = bot.time && bot.time.timeOfDay;
        isNight = t >= 13000 && t <= 23000;
    } catch (e) {}
    if (bot.health < 14 || bot.food < 14) return null;
    const mob = bot._mobility ? (bot._mobility.state || '') : '';
    const enclosed = !!(bot._mobility && bot._mobility.enclosed);
    if (!(/POCKET|ENTOMBED/.test(mob) || enclosed)) return null;
    const counts = {};
    try {
        for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count;
    } catch (e) {}
    const planksMax = Math.max(0, ...Object.keys(counts).filter(k => k.endsWith('_planks')).map(k => counts[k] || 0));
    const logs = Object.keys(counts).filter(k => k.endsWith('_log')).reduce((s, k) => s + (counts[k] || 0), 0);
    if ((counts.crafting_table || 0) > 0 || planksMax >= 4 || logs > 0) return null;
    let progressFresh = false;
    try {
        const p = 'bots/_supervisor/progress.txt';
        const stat = fs.statSync(p);
        if (Date.now() - stat.mtimeMs < 90000) {
            const len = Math.min(8192, stat.size);
            const fd = fs.openSync(p, 'r');
            try {
                const buf = Buffer.alloc(len);
                fs.readSync(fd, buf, 0, len, stat.size - len);
                progressFresh = /TABLE (gate|recovery) for /.test(buf.toString('utf8'));
            } finally {
                fs.closeSync(fd);
            }
        }
    } catch (e) {}
    if (!progressFresh) return null;
    let raw = 0, actionable = null, layered = 0, nearest = Infinity;
    try {
        const a = JSON.parse(fs.readFileSync('bots/_supervisor/advisory.json', 'utf8'));
        if (a && Date.now() - a.ts < 45000 && typeof a.actionableHostiles === 'number') {
            raw = typeof a.hostiles === 'number' ? a.hostiles : 0;
            actionable = a.actionableHostiles;
            layered = typeof a.layeredHostiles === 'number' ? a.layeredHostiles : 0;
            nearest = typeof a.nearest === 'number' ? a.nearest : Infinity;
        }
    } catch (e) {}
    if (actionable == null) {
        actionable = 0;
        const p = bot.entity.position;
        for (const e of Object.values(bot.entities || {})) {
            if (!(e && e !== bot.entity && e.position && mc.isHostile(e))) continue;
            const d = e.position.distanceTo(p);
            if (d >= 16) continue;
            raw++;
            if (d < nearest) nearest = d;
            const dy = Math.abs(e.position.y - p.y);
            const ranged = /skeleton|stray|pillager|witch|blaze|ghast/i.test(e.name || '');
            if (d < 4.25 || (/creeper/i.test(e.name || '') && d < 5.5) || dy < 5 || (ranged && dy < 8)) actionable++;
            else layered++;
        }
    }
    if (actionable > 0) return null;
    return { raw, actionable, layered, nearest, mob, enclosed, isNight };
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        nearbyHostiles: function (bot) {
            try {
                return Object.values(bot.entities).filter(e => {
                    if (!(e && e !== bot.entity && e.position && mc.isHostile(e))) return false;
                    if (e.position.distanceTo(bot.entity.position) >= 10) return false;
                    // ★REACHABILITY 过滤 (怪窝实拍: 荫蔽破碎地形里怪挂在崖上/坑底,80%的
                    // "威胁"物理够不到bot(y71骷髅 vs y62bot 整夜零命中),却让 sp 永久占
                    // 身体,凿崖/作业层结构性饿死——act_trace 全天 20/20 帧 self_preservation,
                    // y 零爬升。近战怪隔≥5格高差打不到人,不算威胁;远程怪(skeleton/stray/
                    // pillager/witch)保留(箭/药水越高差)。绕路下来的近战怪 |dy|<5 时自然
                    // 回到威胁集,响应只延迟几秒。creeper 走 nearestCreeper 不受影响。)
                    if (/skeleton|stray|pillager|witch|blaze|ghast/.test((e.name || '').toLowerCase())) return true;
                    return Math.abs(e.position.y - bot.entity.position.y) < 5;
                });
            } catch (e) { return []; }
        },
        // Nearest CREEPER within range — the one mob you must NEVER bunker/melee next to
        // (it detonates). Wider scan than nearbyHostiles so the back-off reflex fires
        // EARLY (before it's in blast range) and preempts the night-shelter/flee branches.
        nearestCreeper: function (bot, range = 11) {
            try {
                let best = null, bd = range;
                for (const e of Object.values(bot.entities)) {
                    if (!e || !e.position || !e.name || !e.name.toLowerCase().includes('creeper')) continue;
                    const d = e.position.distanceTo(bot.entity.position);
                    if (d < bd) { bd = d; best = e; }
                }
                return best;
            } catch (e) { return null; }
        },
        creeperBackoffTarget: function (bot) {
            const cr = this.nearestCreeper(bot, 12);
            if (!cr) return null;
            const d = cr.position.distanceTo(bot.entity.position);
            const bunkerHold = this.coveredNightHoldStatus(bot);
            if (bunkerHold.hold && d > 3.6) return null;
            const swarmClose = this.nearbyHostiles(bot).some(e => e.position && e.position.distanceTo(bot.entity.position) < 8);
            if (this.isDay(bot)) {
                // Hysteresis: the backoff loop exits at >9m, so re-entering at 11m
                // produces day-long body theft around harmless distant creepers.
                return d <= (bot.health < 12 || swarmClose ? 10 : 8.25) ? cr : null;
            }
            return d <= (swarmClose ? 11 : 9.5) ? cr : null;
        },
        hasOverheadCover: function (bot, minDy = 2, maxDy = 6) {
            try {
                const p = bot.entity.position;
                for (let dy = minDy; dy <= maxDy; dy++) {
                    const b = bot.blockAt(p.offset(0, dy, 0));
                    // ★C296: LEAVES/VINES are NOT cover — a jungle/forest canopy has boundingBox==='block'
                    // but leaves the ground open to mobs. Counting it made the bot "dwell" sheltered-but-
                    // exposed under canopies at night and die (用户实拍: 夜里愣在树冠下不挖三填一). Only a
                    // real solid roof counts (matches missionNether C281 + prepNether C296).
                    if (b && b.boundingBox === 'block' && !/_leaves$|^leaves$|vine|mangrove_roots|azalea/.test(b.name || '')) return true;
                }
            } catch (e) {}
            return false;
        },
        // ★T-0067 REAL SEAL CHECK — the close-body "are we actually boxed in?" test that the
        // staying-sealed hold MUST use instead of the loose hasOverheadCover(2,6). The loose
        // check only asks "is there ONE solid block somewhere 2-6 above us" — it says nothing
        // about the FOUR WALLS, so a bot under an open-sided ledge (or any spot with a roof but
        // no walls) reported "covered → staying sealed", stood still, and let a zombie walk
        // straight in and melee it to death (06-25 死亡: 假"Covered staying sealed" → 僵尸贴脸
        // 群杀). A real night box = the exact thing the seal layer builds (modes.js cap + 4 walls
        // feet+head): a CLOSE roof (dy=2, immediately overhead — not 6 blocks up) AND every one
        // of the 4 cardinal sides blocked at BOTH feet- and head-level so nothing can path in.
        // Returns true only when that box is genuinely closed → no false bunker, no station-
        // keeping while exposed. Leaves/vines never count as roof or wall (canopy ≠ shelter).
        sealedNightBox: function (bot) {
            try {
                const p = bot.entity.position;
                const solidBlock = (b) => b && b.boundingBox === 'block' && !/_leaves$|^leaves$|vine|mangrove_roots|azalea/.test(b.name || '');
                // CLOSE roof: a block right on top of us (dy=2), or one block higher (dy=3) for a
                // slightly tall box. NOT the loose 2-6 — a roof 6 blocks up with open sides is not
                // a sealed box, it's a ledge the swarm walks under.
                const roof = solidBlock(bot.blockAt(p.offset(0, 2, 0))) || solidBlock(bot.blockAt(p.offset(0, 3, 0)));
                if (!roof) return false;
                // FOUR WALLS — every cardinal direction must be blocked at BOTH feet (dy=0) and
                // head (dy=1) level. One open side = a mob can walk in and melee → not sealed.
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    if (!solidBlock(bot.blockAt(p.offset(dx, 0, dz)))) return false;
                    if (!solidBlock(bot.blockAt(p.offset(dx, 1, dz)))) return false;
                }
                return true;
            } catch (e) { return false; }
        },
        coveredNightHoldStatus: function (bot) {
            const status = {
                hold: false, covered: false, coverReal: false, recentDamage: false,
                hostiles: 0, closest: Infinity, creeperDist: Infinity
            };
            try {
                if (!bot || !bot.entity || this.isDay(bot)) return status;
                const p = bot.entity.position;
                const feet = bot.blockAt(p) || { name: 'air' };
                const head = bot.blockAt(p.offset(0, 1, 0)) || { name: 'air' };
                if (/water|lava|fire/.test(feet.name || '') || /water|lava|fire/.test(head.name || '')) return status;
                status.covered = this.hasOverheadCover(bot, 2, 6);   // loose telemetry: a roof somewhere 2-6 above
                // ★T-0067: the HOLD decision must use the REAL seal (close roof + 4 walls), NOT the
                // loose overhead. A roof-but-open-sided ledge made the bot report "covered → staying
                // sealed", stand still, and get walked into & meleed dead. Only a genuinely closed box
                // earns a passive hold; otherwise fall through so the seal/flee branches keep working.
                status.coverReal = this.sealedNightBox(bot);
                if (!status.coverReal) return status;
                status.recentDamage = Date.now() - (bot.lastDamageTime || 0) < 4000;
                const hs = this.nearbyHostiles(bot);
                status.hostiles = hs.length;
                for (const h of hs) {
                    if (!h || !h.position) continue;
                    const d = h.position.distanceTo(p);
                    if (d < status.closest) status.closest = d;
                }
                const cr = this.nearestCreeper(bot, 12);
                if (cr && cr.position) status.creeperDist = cr.position.distanceTo(p);
                // A sealed/covered night bunker is safer than opening the body and running.
                // Only recent damage or a point-blank creeper is allowed to break the hold.
                // This is threat arbitration, not a generic night curfew: quiet enclosed
                // mines are already exempted by shouldNightShelter and should keep working.
                const threatPressure = status.hostiles > 0 || Number.isFinite(status.creeperDist);
                let hold = threatPressure && !status.recentDamage && status.creeperDist > 3.6;
                // ★C266 FALSE-BUNKER / PHANTOM guard (death evidence 06:34: "covered night hold"
                // while a phantom swooped hp 12→3 to death). hasOverheadCover() only requires ONE
                // block 2-6 above — that does NOT stop an aerial/angled attacker (phantom swoops in
                // diagonally; arrows come through gaps). The hold then sat PASSIVELY (wait 3000) as
                // HP bled out, never noticing the shelter was a lie. Mechanism fix: track HP across
                // the hold session — if we keep NET-LOSING HP while supposedly sheltered, the cover
                // is ineffective → break the hold so the bot actively defends/relocates (dig-in for
                // a REAL roof) instead of dying still. General (covers phantoms, through-gap arrows,
                // any false bunker), non-cheat. Phantoms recur here: no bed (snowy_taiga, no sheep)
                // → can't sleep → phantoms every few nights.
                const nowT = Date.now();
                if (hold) {
                    if (typeof bot._coverHoldHp !== 'number' || nowT - (bot._coverHoldAt || 0) > 12000) {
                        bot._coverHoldHp = bot.health; bot._coverHoldAt = nowT;   // (re)start session
                    }
                    if (bot.health <= bot._coverHoldHp - 2) {        // net HP loss while "sheltered" = false bunker
                        hold = false;
                        status.coverIneffective = true;
                    } else {
                        bot._coverHoldAt = nowT;                                 // session still working
                        if (bot.health > bot._coverHoldHp) bot._coverHoldHp = bot.health;   // track regen
                    }
                } else {
                    bot._coverHoldHp = null; bot._coverHoldAt = 0;
                }
                // ★C351 (T-0101): FOOD-CRISIS escape — a sealed box stops mobs but NOT starvation.
                // The hold above never checked food, so food≤2 + sealed = the bot dwells boxed-in
                // FOREVER, GET_FOOD suppressed, starving with no exit (live 06-27: hp5/food0 boxed-in
                // 跨多夜 pos 钉死 91,53,160, 28× "staying boxed in"/10min — worker-death's hunger-hold
                // fix修了反射hold路径却漏了THIS night-hold路径). When food is critical AND we've held
                // sealed past a grace window (the night/food isn't coming to us), break the hold so
                // GET_FOOD/forage runs — a forage gamble beats starving still. STILL gated by the
                // point-blank creeper guard (creeperDist>3.6, already in `hold`) so we never break a
                // sealed box into a creeper's face (C32 lesson). food>4 (ate something) re-arms it.
                if (hold && bot.food <= 2) {
                    if (!bot._foodHoldAt) bot._foodHoldAt = nowT;
                    else if (nowT - bot._foodHoldAt > 25000 && status.creeperDist > 3.6) { hold = false; status.foodCrisisBreak = true; }
                } else if (bot.food > 4) {
                    bot._foodHoldAt = 0;
                }
                status.hold = hold;
            } catch (e) {}
            return status;
        },
        // SMART ESCAPE ROUTING (uses the world block-scan — don't flee blindly!). The naive
        // "sprint opposite the mob centroid" kept running the bot INTO water (drown/slow) or
        // INTO another mob cluster just off-axis — that's how the zombie swarms cornered it.
        // Instead, sample candidate landing spots in a ring around us and SCORE each by:
        //   + distance from the nearest hostile (get away from the swarm)
        //   − running toward any cluster (heavy penalty per mob near the candidate)
        //   − water at/around the spot (never flee into/along water)
        //   − height change (don't leap into pits)
        // Returns the best standable spot (solid ground + 2 air) to path to, or null if none
        // scan up — caller then falls back to the simple away-vector.
        safeFleeTarget: function (bot) {
            try {
                const WSET = ['water', 'flowing_water'];
                const LAVA = ['lava', 'flowing_lava'];
                const isAirish = (b) => b && (b.name === 'air' || b.name === 'cave_air' || b.name.includes('grass') || b.name === 'fern' || b.name.includes('snow'));
                const isSolid = (b) => b && b.boundingBox === 'block' && !WSET.includes(b.name) && !LAVA.includes(b.name);
                const mobs = Object.values(bot.entities).filter(e => e && e.position && mc.isHostile(e) && e.position.distanceTo(bot.entity.position) < 22);
                if (mobs.length === 0) return null;
                const p = bot.entity.position.floored();
                let best = null, bestScore = -1e9;
                const DIRS = 10;
                for (let a = 0; a < DIRS; a++) {
                    const ang = (a / DIRS) * Math.PI * 2;
                    const ux = Math.cos(ang), uz = Math.sin(ang);
                    for (const dist of [6, 11]) {
                        const ddx = Math.round(ux * dist), ddz = Math.round(uz * dist);
                        // Find a standable spot in this column (first solid from top with 2 air above).
                        let cand = null;
                        for (let dy = 3; dy >= -4; dy--) {
                            const g = bot.blockAt(p.offset(ddx, dy, ddz));
                            if (!g) continue;
                            if (isSolid(g)) {
                                const a1 = bot.blockAt(p.offset(ddx, dy + 1, ddz));
                                const a2 = bot.blockAt(p.offset(ddx, dy + 2, ddz));
                                if (isAirish(a1) && isAirish(a2)) cand = p.offset(ddx, dy + 1, ddz);
                                break; // first solid top in column
                            }
                        }
                        if (!cand) continue;
                        let score = 0, minMob = 1e9, closeMobs = 0;
                        for (const m of mobs) {
                            const d = m.position.distanceTo(cand);
                            if (d < minMob) minMob = d;
                            if (d < 6) closeMobs++;
                        }
                        score += minMob * 3;            // farther from nearest threat = better
                        score -= closeMobs * 30;        // NEVER flee into a cluster
                        // water scoring: normally AVOID (drowned ambush / slow), but vs an
                        // angry ENDERMAN water is the sanctuary — it takes damage in water
                        // and will not pursue (死276+今日复发,激怒小黑追杀连击,走位甩不掉
                        // 瞬移;人类标准操作=跳水). Invert the water term in that case.
                        let water = 0;
                        for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
                            const f = bot.blockAt(cand.offset(ox, 0, oz));
                            const u = bot.blockAt(cand.offset(ox, -1, oz));
                            if (f && WSET.includes(f.name)) water += 2;
                            if (u && WSET.includes(u.name)) water += 1;
                        }
                        const endermanClose = mobs.some(m => /enderman/i.test(m.name || '') && m.position.distanceTo(bot.entity.position) < 8);
                        // 死278十分钟后就教了课: 水甩掉了 enderman 但溺尸在水里接锅(hp3 两下
                        // 带走)。水庇护只在该片水没有 drowned 时成立。
                        const drownedNearCand = mobs.some(m => /drowned/i.test(m.name || '') && m.position.distanceTo(cand) < 10);
                        score += (endermanClose && !drownedNearCand) ? water * 20 : -water * 15;   // enderman→water sanctuary (unless drowned); else avoid
                        score -= Math.abs((cand.y) - p.y) * 2; // prefer level ground
                        if (score > bestScore) { bestScore = score; best = cand; }
                    }
                }
                return best;
            } catch (e) { return null; }
        },
        shouldFlee: function (bot) {
            const hostiles = this.nearbyHostiles(bot);
            // RANGED THREAT (check FIRST — skeletons shoot from beyond the 10-block melee
            // bubble, so the nearbyHostiles check below would return false and we'd just stand
            // and get plinked from 14+ blocks: the repeated "shot by Skeleton" deaths). If a
            // skeleton/stray is within 16, we've been hit recently, and we have no shield to
            // block arrows → FLEE so the dispatch's run-fallback can 蛇皮走位 toward cover.
            const _hurt = Date.now() - bot.lastDamageTime < 3000;
            const _shield0 = bot.inventory.items().some(i => i.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');
            if (this.coveredNightHoldStatus(bot).hold) return false;
            // ★POINT-BLANK EXCEPTION (death #263, must beat the ranged-flee check below):
            // ONE non-creeper hostile already inside melee reach while we hold a weapon →
            // do NOT flee/wall — return false so self_defense takes it. At 1.6-4b a
            // skeleton beats every other option: walls don't block point-blank arrows,
            // shaft terrain blocks flight, and standing passive = shot dead (the #263
            // tape: 20s jittering in a 1-block box, sword in bag, never drawn). Melee
            // knockback interrupts the bow cycle — that duel is winnable at ANY hp.
            // Strictly ONE attacker <4.5b with no second hostile inside 8b: against a
            // pack, fleeing/walling is still right.
            {
                const _HR0 = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|vindicator|cave_spider/i;
                const _near8 = Object.values(bot.entities).filter(e =>
                    e && e.position && e.name && _HR0.test(e.name) && e.position.distanceTo(bot.entity.position) < 8);
                if (_near8.length === 1 && !/creeper/i.test(_near8[0].name)
                    && _near8[0].position.distanceTo(bot.entity.position) < 4.5
                    && bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name))) return false;
            }
            if (!_shield0 && _hurt && Object.values(bot.entities).some(e => e && e.position && /skeleton|stray/i.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 16)) return true;
            if (hostiles.length === 0) return false;
            // CREEPER: never let one get close — meleeing it = it explodes = death.
            // Always back away from a creeper within 6 (shieldFight also avoids, but
            // fleeing here is higher priority so we disengage before it detonates).
            if (hostiles.some(e => (e.name || '').toLowerCase().includes('creeper') && e.position.distanceTo(bot.entity.position) < 8)) return true;
            const hasWeapon = bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name));
            const hasShield = bot.inventory.items().some(i => i.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');
            const recentlyHurt = Date.now() - bot.lastDamageTime < 3000;
            // ★HEALTHY-UNARMED BOOTSTRAP EXIT (fix: respawn-unarmed perpetual dig-in livelock).
            // A fresh respawn carries no weapon. Fleeing / "digging in" forever vs a single melee
            // mob at full hp means the bot can NEVER chop wood and craft a sword — it just spams
            // "Outmatched — digging in!" ~3x/second, gets anchored→MAROONED, and stays locked until
            // it dies, respawns unarmed, and repeats (the whole multi-hour stall). At hp>=16 facing
            // exactly ONE non-ranged, non-creeper mob, do NOT flee: let the bot move and bootstrap
            // (or punch it). One melee mob can't kill a full-hp bot before it acts. Ranged/creeper/
            // swarm/low-hp/recently-hurt-by-skeleton are all handled above and still flee.
            if (!hasWeapon && bot.health >= 16 && hostiles.length === 1
                && !/skeleton|stray|creeper|witch|ghast|blaze|pillager/i.test(hostiles[0].name || '')) return false;
            // With a sword AND shield we can actually WIN (block arrows/hits, close,
            // strike) — don't flee, let self_defense's shieldFight take it. Only flee
            // when truly outmatched: critically low, or genuinely swarmed (3+).
            if (hasWeapon && hasShield) return bot.health < 7 || hostiles.length >= 3;
            // No shield: stay conservative (can't block arrows) — flee if can't win.
            const cantWin = !hasWeapon || bot.health < 14 || hostiles.length >= 2;
            const closest = Math.min(...hostiles.map(e => e.position.distanceTo(bot.entity.position)));
            return cantWin && (recentlyHurt || bot.health < 14 || closest < 5);
        },
        isDay: function (bot) { try { return !bot.time || bot.time.timeOfDay < 13000 || bot.time.timeOfDay > 23000; } catch (e) { return true; } },
        // ★SMART FLEE MOVE (fixes "逃跑乱跳卡台阶/树"): the old raw flee held jump=true every tick
        // → on jungle terraces/dug steps/trees the bot bounced erratically and snagged. A human
        // runs flat, hops ONLY a real 1-block step in front, and STEERS AROUND a 2-block obstacle
        // (tree/wall) instead of ramming it. Face target, forward+sprint always; jump only on a
        // foot-blocked-but-head-clear step; if foot+head both blocked, turn ~60° aside (don't ram).
        fleeMove: async function (bot, target) {
            // Run toward `target` (an away-from-threat point) but go AROUND obstacles, don't ram
            // them. (用户诊断: 前方上方树叶挡住,bot 一根筋直冲撞树叶卡死/原地挥手,而不是向左绕。)
            // The OLD logic only handled a FOOT block (foot-blocked→hop, foot+head→turn) and MISSED
            // the "head blocked, foot clear" case (overhanging leaves/branch) → it fell through to
            // jump=false and rammed straight into the canopy and snagged. NEW: probe the straight
            // heading, then fan out ±45°/±90°, and take the first heading whose HEAD is clear (a
            // blocked head = tree/leaves/wall — walking into it just snags). Jump ONLY for a real
            // 1-block step (foot blocked, head clear); never on flat ground (kills the乱跳). Steering
            // by choosing the heading (not look(yaw+offset) every tick) avoids fighting lookAt.
            const me = bot.entity.position;
            let dx = (target.x + 0.5) - me.x, dz = (target.z + 0.5) - me.z;
            const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
            const sol = (b) => b && b.boundingBox === 'block';
            // ★WATER-BLIND FLEE killed twice (198+202, same shape: night kite "Can't seal →
            // running" steered INTO a river — water probes as "clear" since it's not solid —
            // where the bot is slow and drowned mobs own the fight; caught at 1.5 blocks).
            // A fleeing human never jumps into water with melee mobs behind. Treat watery
            // headings (1 and 2 cells out) as BLOCKED in the fan-out; only swim if EVERY
            // heading is wet (peninsula/island — then water genuinely beats the swarm).
            const wet = (b) => b && /water/.test(b.name || '');
            // drop probe: >3 blocks of air under the 1-cell-ahead landing spot = a ledge
            // (death 214: hp6 night flee off an 18-block cave drop — the foot/head/water
            // probes never looked DOWN; #17's ledge logic lived in the old flee path only).
            const droppy = (ux, uz) => {
                for (let dd = 1; dd <= 4; dd++) {
                    const b = bot.blockAt(me.offset(ux * 1.6, -dd, uz * 1.6));
                    if (b && (b.boundingBox === 'block' || /water/.test(b.name || ''))) return false; // floor (or water cushion) within 4
                }
                return true;
            };
            const probe = (ux, uz) => ({
                foot: sol(bot.blockAt(me.offset(ux * 1.1, 0, uz * 1.1))),
                head: sol(bot.blockAt(me.offset(ux * 1.1, 1, uz * 1.1))),
                water: wet(bot.blockAt(me.offset(ux * 1.1, 0, uz * 1.1))) || wet(bot.blockAt(me.offset(ux * 2.2, 0, uz * 2.2)))
                    || wet(bot.blockAt(me.offset(ux * 1.1, -1, uz * 1.1))),
                drop: droppy(ux, uz),
            });
            let hx = dx, hz = dz, needJump = true;   // boxed-in fallback: jump + push straight
            let _found = false;
            // ★C334-A (T-0068 "逃怪缺翻越地形脱离"): 旧扇形只搜前向 ±90° 弧[0,±45,±90]——若前向被
            // 2 格墙/台地挡满(U 形角落), 5 个朝向全 head-blocked → fallback 直冲撞墙 → 被地形逼角
            // 无限 kite till dawn 甩不掉群(今日多条夜群杀死)。修: 扇形扩到【全 360°】(加 ±135°,180°),
            // 被前向逼角时能向后/绕行找到任意开口脱离, 而非撞死墙角。偏好序不变(away 方向 0/±45/±90
            // 先试, 背向 ±135/180 只在前向弧全堵=真逼角时才用——first-match 保证仅最后兜底), 故正常逃
            // 仍优先远离威胁, 只有走投无路才回绕。dry/wet 两遍+跌落守卫保留。
            const _FAN = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, 3 * Math.PI / 4, -3 * Math.PI / 4, Math.PI];
            for (const pass = { dry: true }, arr = [true, false]; arr.length && !_found;) {
                pass.dry = arr.shift();
                for (const a of _FAN) {
                    const ca = Math.cos(a), sa = Math.sin(a);
                    const ux = dx * ca - dz * sa, uz = dx * sa + dz * ca;   // rotate desired heading by a
                    const p = probe(ux, uz);
                    if (!p.head && !p.drop && (!pass.dry || !p.water)) { hx = ux; hz = uz; needJump = p.foot; _found = true; break; }   // head clear + no ledge (+dry on first pass) → run
                }
            }
            // ★C334-A 真逼角(全 360° head 全堵/全 droppy)+有镐 → "翻越"=向 away 方向凿穿头层 1 格开口
            // (旧 fallback 只撞墙)。让被 2 格墙完全箱住的 bot 自己挖出逃生口而非原地被压死。一次一格,
            // 数拍凿通; 无镐则退回撞墙 fallback(总比不动强)。掘进方向=最贴近 away 的朝向(dx,dz)。
            if (!_found) {
                try {
                    const hasPick = bot.inventory.items().some(i => /_pickaxe$/.test(i.name || ''));
                    // 凿出 1x2 通道: 脚层优先(挡住行走的是脚层), 脚层已空才凿头层 → 两拍开一个可通行的口。
                    const footB = bot.blockAt(me.offset(dx * 1.1, 0, dz * 1.1));
                    const headB = bot.blockAt(me.offset(dx * 1.1, 1, dz * 1.1));
                    const tgt = (footB && footB.boundingBox === 'block') ? footB
                        : ((headB && headB.boundingBox === 'block') ? headB : null);
                    if (hasPick && tgt && bot.canDigBlock && bot.canDigBlock(tgt)) {
                        try { await bot.lookAt(tgt.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                        try { await bot.dig(tgt); } catch (e) {}
                    }
                } catch (e) {}
            }
            try { await bot.lookAt(me.offset(hx * 4, 1.6, hz * 4), true); } catch (e) {}
            try {
                bot.setControlState('forward', true);
                bot.setControlState('sprint', true);
                bot.setControlState('jump', needJump);
                bot.setControlState('left', false); bot.setControlState('right', false); bot.setControlState('back', false); // clear stray strafe (skel weave), keep forward/sprint
            } catch (e) { try { bot.setControlState('jump', true); } catch (e2) {} }
        },
        shouldNightShelter: function (bot) {
            // ★PROACTIVE NIGHT INSTINCT (用户诊断: bot 没夜晚意识——天黑还慢悠悠挖,直到被怪偷袭
            // 致死;要"入夜主动转生存,而不是等到遇到怪再反应"). The OLD code required a mob to be
            // ALREADY near (`hostiles.length===0 → return false`) = purely REACTIVE → mobs spawn
            // in the dark and ambush before we'd ever detect them. NOW: at NIGHT on the EXPOSED
            // surface, shelter REGARDLESS of whether a mob is visible yet. This is a reflex (fires
            // EVERY tick) so it also triggers mid-operation — the resource-layer holeUpAtNight only
            // checked at task boundaries and missed nightfall during a long chop/mine (the
            // "挖着挖着天黑被偷袭" window). Underground (y<50) is already safe; daytime handled by isDay.
            if (this.isDay(bot)) return false;
            if (bot.entity.position.y < 50) return false;
            // ★ENCLOSED override (用户: "全知视角判断是否处在封闭地穴——是的话夜里不需要
            // 停"。y<50 是"地下=安全"的代理变量,漏掉了 y≥50 的崖体隧道/封闭洞——bot 在
            // 全实心包围里被当地表暴露,整夜蹲坑停工。状态机的 enclosed(3x3列探测)直接
            // 回答这个问题: 封闭=夜晚白天没区别,继续干活。近身威胁仍由 shouldFlee/
            // bunkerDown 的怪压分支兜底——enclosed 只豁免"无怪也要预防性蹲坑"。)
            if (bot._mobility && bot._mobility.enclosed) return false;
            // ★GEAR-AWARE (用户: 有铁剑+盾却被僵尸打死). The unconditional `return true` made
            // self_preservation bunker/flee EVERY night → self_defense (lower priority) never got
            // to fight → an EQUIPPED bot never used its sword+shield, just fled, and when the
            // bunker couldn't seal (water edge) it got caught by the swarm and died. Now mirror
            // shouldFlee's win-condition: if we can WIN (sword + shield + decent HP, not a 3+
            // swarm) DON'T shelter — let self_defense stand and kill the mobs (a human with iron
            // sword+shield drops 1-2 zombies trivially). Only bunker when NAKED/weak/swarmed
            // (the early-game case the night instinct was actually for).
            const hasSword = bot.inventory.items().some(i => /_sword$/.test(i.name));
            const hasShield = bot.inventory.items().some(i => i.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');
            const hostiles = this.nearbyHostiles(bot);
            const swarm = hostiles.length;
            // ★C284 SINGLE-MELEE-MOB FINISHER (death_log 取证: 18/45 死=单个近战怪, 80% 死时手里没剑,
            // 78% 死在 self_preservation 中, 29 个近战死里 20 个在夜里). 机理: 下面的 canWin 要求
            // 有盾,但 bot 无铁→无盾,于是每晚面对一个僵尸都去 BUNKER 而不是砍死它——挖洞比"木剑
            // 4 下"更慢更脆,封不住时手握填充块(非剑)被打死(=那 80% 空手). 单个僵尸/尸壳/蜘蛛贴脸
            // 根本不需要盾(盾是防箭/防群的): 木剑几下解决. 所以当恰好 1 个可达、非苦力怕、非远程
            // 的怪已经 point-blank(<4.5格)、我们有剑且非危血时, 别 shelter——让位给 self_defense 的
            // point-blank 路径(任何血量在<4.5格都开打)去收尾. 砍死后下一拍正常 shelter(不抖动: 击杀
            // 是决定性的、直接移除威胁). 苦力怕/远程/成群/极低血 仍照常 bunker.
            const _RANGED = /skeleton|stray|witch|ghast|blaze|pillager/i;
            const _me = bot.entity.position;
            const _closest = swarm ? Math.min(...hostiles.map(e => e.position.distanceTo(_me))) : 99;
            const soloMeleeFinisher = hasSword && swarm === 1 && _closest < 4.5
                && !/creeper/i.test(hostiles[0].name || '')
                && !_RANGED.test(hostiles[0].name || '')
                && bot.health >= 8;
            if (soloMeleeFinisher) return false;
            const canWin = hasSword && hasShield && bot.health >= 8 && swarm < 3;
            return !canWin;
        },
        // EMERGENCY BUNKER (shared by night-shelter AND the outmatched-at-night flee):
        // dig DOWN into solid ground and seal, breaking all contact with a mob swarm.
        // In this mob-dense water world, surface-fleeing just runs into MORE mobs and
        // eventually gets cornered/killed — digging down + capping is the only reliable
        // escape. Robust at a water edge (dig 4 to get below the water table into solid
        // rock; cap the head; seal open sides; blockless L-niche fallback when naked).
        bunkerDown: async function (agent) {
            const bot = agent.bot;
            // ★OSCILLATION BREAKER (the 300ms "securing ↔ Can't seal ↔ running" thrash,
            // 03:47, 13min of standstill): with NO mobs around, a failed bunker re-fired
            // every mode tick, and each refire's interrupt starved the skill layer
            // (prepNether's own hole-up never got 2 consecutive seconds to run; progress
            // froze). After a no-mob failure, COOL DOWN 45s: the skill layer has a full
            // dug-in implementation (bare-hand capable) — let it work. Under actual mob
            // pressure the cooldown does not apply (kiting/sealing stays available).
            if (Date.now() < (this.bunkerCooldownUntil || 0)) {
                // during cooldown only a TRUE close threat (<5b, or creeper <8b) re-opens
                // bunkering; loitering mobs that can't reach us don't get to keep
                // preempting the escape work (the chimney-top 1.5h "one swing then stop").
                // ★C316-A (T-0050/#118): a RANGED attacker (skeleton/stray/witch/pillager) at
                // 5-15b is NOT "loitering" — it shoots from distance and KITES, so it never
                // walks into the <5b melee window. The old gate let a skeleton at 6b whittle the
                // bot for 47s during the no-mob seal-fail cooldown (self_defense fought it while
                // bunkering stayed suppressed) until a husk closed to <5b — too late, husk killed
                // her mid-reseal (#118, full iron armor, NO shield → canWin false → should've
                // sealed). Treat a ranged hostile within its engagement range as a live threat
                // that re-opens bunkering so we seal AWAY from the arrows instead of trading hits.
                const _RANGED_RE = /skeleton|stray|witch|pillager|ghast|blaze|drowned/i;
                const _ranged = this.nearbyHostiles(bot).some(e => e && e.position && _RANGED_RE.test(e.name || '')
                    && e.position.distanceTo(bot.entity.position) < 15);
                // ★T-0067 — STANDDOWN LEAK FIX: the no-mob seal-fail standdown handed the night to
                // the skill-layer dig-in for 45s, but if dig-in never built a real box and a MELEE
                // mob then closed in, the old gate only re-opened bunkering at <5b — by then the
                // zombie was already meleeing (实测: standdown → mob 9.6m→1.8m→死, never re-sealed).
                // Give a proper lead time: while we are NOT inside a real sealed box, any melee
                // hostile within 9b re-opens bunkering so we can wall/flee BEFORE it reaches us.
                // If we ARE genuinely boxed in (coverReal), keep the cooldown so the escape work is
                // not preempted (preserves the C18 chimney-top "let it run" lesson).
                const _sealedNow = this.sealedNightBox(bot);
                const _meleeApproaching = !_sealedNow && !this.isDay(bot)
                    && this.nearbyHostiles(bot).some(e => e && e.position && !_RANGED_RE.test(e.name || '')
                        && e.position.distanceTo(bot.entity.position) < 9);
                const _close = this.nearbyHostiles(bot).some(e => e.position && e.position.distanceTo(bot.entity.position) < 5)
                    || this.nearestCreeper(bot, 8) || _ranged || _meleeApproaching;
                if (!_close) return;
            }
            // ★ALREADY-IN-A-CAVE: NO self-sealing (用户: "夜里在矿底下能不能别再封路了?
            // 封路后就出不来" — the bot sealed itself inside a deep cliff hole at night,
            // then spent the whole next day bare-hand chewing its own caps back out,
            // re-sealing them again each dusk: a self-built tomb-door loop). If there is
            // already NATURAL cover overhead (solid blocks within 5 above head height)
            // and no hostile within 6, we are in a cave/pit — the terrain IS the bunker.
            // Stay put; do not place a single block.
            try {
                const pC = bot.entity.position;
                let covered = false;
                for (let dyC = 2; dyC <= 6; dyC++) {
                    const bC = bot.blockAt(pC.offset(0, dyC, 0));
                    if (bC && bC.boundingBox === 'block') { covered = true; break; }
                }
                const nightHold = this.coveredNightHoldStatus(bot);
                const quietCovered = covered && !this.nearbyHostiles(bot).some(e => e.position && e.position.distanceTo(pC) < 6);
                if (nightHold.hold || quietCovered) {
                    // DWELL, don't fast-return: an instant return re-fires the mode every
                    // ~300ms ("Nightfall securing" spam round 3) and the interrupt storm
                    // starves every other system. We're sheltered — sit 5s per pass.
                    if (Date.now() - (this._nightDwellAt || 0) > 30000) {
                        this._nightDwellAt = Date.now();
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [self_preservation] night bunker dwell: covered=true hold=${nightHold.hold} hp=${Math.round(bot.health)} food=${bot.food} hostiles=${this.nearbyHostiles(bot).length} closest=${Number.isFinite(nightHold.closest) ? nightHold.closest.toFixed(1) : '-'} creeper=${Number.isFinite(nightHold.creeperDist) ? nightHold.creeperDist.toFixed(1) : '-'}\n`);
                        } catch (e) {}
                    }
                    await new Promise(r => setTimeout(r, 5000));
                    return;
                }
            } catch (e) {}
            const OPENISH = ['air', 'cave_air', 'water', 'flowing_water', 'short_grass', 'tall_grass'];
            // ANY placeable solid we carry — CRUCIALLY including planks/logs/wood. A fresh
            // respawn is wood-only (no stone/dirt yet); the old list omitted wood, so
            // fillerOf() returned nothing → the bot couldn't cap/wall its shelter → it just
            // spammed "digging in" and bled out to a single zombie. A human walls up with
            // whatever's in hand — so do we: planks and logs seal a bunker just fine.
            // ★C280: +red_sand|red_sandstone|sandstone — BADLANDS' abundant block. Without it
            // the bot dug 163 red_sand yet fillerOf()=undefined → couldn't seal → died 3× to
            // melee mobs in the open on one night (2026-06-20). terracotta was already in.
            const FILL_RE = /cobblestone|cobbled|deepslate|^dirt$|andesite|diorite|granite|^stone$|tuff|gravel|^sand$|red_sand|sandstone|netherrack|_planks$|_log$|_wood$|^planks$|hyphae|^mud$|^clay$|terracotta|^dirt_path$|coarse_dirt|rooted_dirt|mossy/;
            // Gravity blocks (sand/red_sand/gravel) fall when capping over air → can drop on the
            // bot and suffocate. Prefer a non-gravity block for placement; gravity only as fallback.
            const GRAVITY_FILL = /^(sand|red_sand|gravel)$/;
            const fillerOf = () => {
                const c = world.getInventoryCounts(bot);
                const all = Object.keys(c).filter(n => c[n] > 0 && FILL_RE.test(n));
                return all.find(n => !GRAVITY_FILL.test(n)) || all[0];
            };
            try { bot.clearControlStates(); } catch (e) {}
            // ★ STEP ONTO DRY LAND FIRST (the human move at a water edge). The endless
            // "Can't seal" came from trying to dig DOWN where we stand — but the spawn is a
            // water edge, so the block below is water and digDown can't descend → never seals.
            // A human just steps a couple blocks onto solid ground and digs there. If our feet
            // aren't over diggable solid ground, scan ≤5 blocks for the nearest dry, solid,
            // standable spot and walk to it before digging. (Digging gives the dirt we cap with
            // — no pre-stocked blocks needed.)
            const _isWater = (b) => b && /water/.test(b.name || '');
            const _AIR = ['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'snow'];
            const _diggableUnderFeet = () => { const below = bot.blockAt(bot.entity.position.offset(0, -1, 0)); return below && below.boundingBox === 'block' && !_isWater(below); };
            if (!_diggableUnderFeet()) {
                // ★INSTANT-BUNKER reach (user-requested): the water-edge spawn often has NO dry
                // ground within a few blocks — the old ≤5 scan failed, so the naked bot couldn't
                // dig+cap and bled out / ran into the swarm. Widen to ≤14 AND prefer DIRT-FAMILY
                // ground (grass/dirt/sand/gravel) — the only blocks a TOOL-LESS bot can dig to
                // yield its OWN cap material (the whole point of the instant bunker: mine your
                // ceiling as you descend, zero pre-stocked blocks). Stone is useless naked (digs
                // to nothing). Pick the nearest dirt-family standable spot; fall back to nearest
                // any-solid only if no dirt exists. Reaching diggable dirt is what makes the
                // dig-2-and-cap below reliably seal a naked respawn at this spawn.
                const DIRT_RE = /grass_block|^dirt$|coarse_dirt|rooted_dirt|dirt_path|podzol|mycelium|^mud$|^clay$|^sand$|red_sand|gravel|moss_block|snow_block|farmland/;
                const p0 = bot.entity.position.floored();
                let bestDirt = null, bdDirt = 1e9, bestAny = null, bdAny = 1e9;
                // ★Under an ACTIVE swarm, DON'T commit to a long relocate — walking 14 blocks
                // through zombies to find dirt got the naked bot cornered and killed (death rate
                // DOUBLED when this was unconditional ≤14). Keep it LOCAL (≤5) under threat so we
                // fail fast to kite/run; only search WIDE when the area is clearish (dusk, getting
                // ahead of night) where reaching dirt to instant-bunker is actually safe.
                const _HRE = /zombie|skeleton|spider|creeper|witch|drowned|husk|stray|enderman|slime|phantom|pillager|vindicator|silverfish/i;
                const _swarm = Object.values(bot.entities).filter(e => e && e.position && e.name && _HRE.test(e.name) && e.position.distanceTo(bot.entity.position) < 10).length;
                const R = _swarm >= 2 ? 5 : 14;
                for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
                    const d2 = dx * dx + dz * dz; if (d2 < 1) continue;
                    for (let dy = 3; dy >= -4; dy--) {
                        const g = bot.blockAt(p0.offset(dx, dy, dz));
                        if (!g) continue;
                        if (g.boundingBox === 'block' && !_isWater(g)) {   // first solid top in column
                            const a1 = bot.blockAt(p0.offset(dx, dy + 1, dz)), a2 = bot.blockAt(p0.offset(dx, dy + 2, dz));
                            if (a1 && _AIR.includes(a1.name) && a2 && _AIR.includes(a2.name)) {
                                const spot = p0.offset(dx, dy + 1, dz);
                                if (DIRT_RE.test(g.name)) { if (d2 < bdDirt) { bestDirt = spot; bdDirt = d2; } }
                                else if (d2 < bdAny) { bestAny = spot; bdAny = d2; }
                            }
                            break;
                        }
                    }
                }
                const best = bestDirt || bestAny;   // dirt first (diggable naked) → any solid fallback
                if (best) { try { await skills.goToPosition(bot, best.x, best.y, best.z, 0); } catch (e) {} }
            }
            const y0 = Math.floor(bot.entity.position.y);
            // SPEED MATTERS: under a swarm we lose ~1hp per dig-tick, so get SEALED ASAP.
            // Dig just 2 down (bot ends 2 below the surface, out of melee reach from above)
            // then IMMEDIATELY cap the opening. 2-deep+capped is fully safe (mobs can't path
            // in or hit down a 1-wide capped shaft); digging 4 took too long and the bot
            // bled out at ~hp6 mid-dig. Deeper/side-sealing happens AFTER we're capped.
            for (let d = 0; d < 2 && Math.floor(bot.entity.position.y) > y0 - 2; d++) {
                const before = Math.floor(bot.entity.position.y);
                try { await skills.digDown(bot, 1); } catch (e) {}
                if (Math.floor(bot.entity.position.y) >= before) break; // couldn't descend (water/lava/stuck) — stop
            }
            let p = bot.entity.position.floored();
            // CAP FIRST (highest priority — this is what actually stops the swarm). FASTEST
            // possible: ≤4 tries 60ms apart, RE-READING our position each pass (a 3-4 mob swarm
            // knocks the bot around mid-place), stop the instant the head is covered. The old
            // 6×150ms (~0.9s) was too slow — at ~1hp/tick under a swarm the naked bot bled out
            // before the cap landed (the recurring "Can't seal here" → 连死). Speed = survival.
            for (let i = 0; i < 4; i++) {
                const head2 = bot.blockAt(p.offset(0, 2, 0));
                if (head2 && !OPENISH.includes(head2.name)) break;
                const f = fillerOf(); if (!f) break;
                try { await skills.placeBlock(bot, f, p.x, p.y + 2, p.z, 'bottom', true); } catch (e) {}
                await new Promise(r => setTimeout(r, 60));
                p = bot.entity.position.floored();
            }
            // Now (sealed/safer) dig 2 more down for water-table robustness, re-capping if the
            // descent reopened the head. Skip if we couldn't descend at all (hit water/rock).
            for (let d = 0; d < 2 && Math.floor(bot.entity.position.y) > y0 - 4; d++) {
                const before = Math.floor(bot.entity.position.y);
                try { await skills.digDown(bot, 1); } catch (e) {}
                if (Math.floor(bot.entity.position.y) >= before) break;
            }
            p = bot.entity.position.floored();
            for (let i = 0; i < 4; i++) {   // re-cap after deepening — same fast cadence as above
                const head2 = bot.blockAt(p.offset(0, 2, 0));
                if (head2 && !OPENISH.includes(head2.name)) break;
                const f = fillerOf(); if (!f) break;
                try { await skills.placeBlock(bot, f, p.x, p.y + 2, p.z, 'bottom', true); } catch (e) {}
                await new Promise(r => setTimeout(r, 60));
                p = bot.entity.position.floored();
            }
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                for (const dy of [0, 1]) {
                    const c = bot.blockAt(p.offset(dx, dy, dz));
                    if (c && OPENISH.includes(c.name)) {
                        const f = fillerOf(); if (!f) break;
                        try { await skills.placeBlock(bot, f, p.x + dx, p.y + dy, p.z + dz, 'bottom', true); } catch (e) {}
                    }
                }
            }
            const headOpen = () => { const h = bot.blockAt(bot.entity.position.offset(0, 2, 0)); return !h || OPENISH.includes(h.name); };
            if (headOpen() && !fillerOf()) {
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const pp = bot.entity.position.floored();
                    const roof = bot.blockAt(pp.offset(dx, 2, dz));
                    if (!roof || OPENISH.includes(roof.name)) continue;
                    for (let step = 1; step <= 2; step++) {
                        const q = bot.entity.position.floored();
                        for (const cell of [q.offset(dx, 1, dz), q.offset(dx, 0, dz)]) {
                            const b = bot.blockAt(cell);
                            if (b && !OPENISH.includes(b.name)) { try { await bot.dig(b); } catch (e) {} }
                        }
                        try { await skills.goToPosition(bot, q.x + dx, q.y, q.z + dz, 0); } catch (e) {}
                    }
                    break;
                }
            }
            // DID WE ACTUALLY SEAL? A fresh respawn is naked — no pickaxe, so digDown hits
            // stone it CAN'T break ("Don't have right tools to break stone"), and it often has
            // no placeable block either. Then every dig+cap above is a no-op: the bot stands in
            // a half-dug hole and the swarm whittles it to death while it spams "digging in"
            // (exactly the loop we kept seeing). Per the user's rule — "判断形势：打不过就
            // 一直跑或者造避难所" — building the shelter is plan A; if we COULDN'T build it,
            // plan B is to RUN, not stand here and bleed out.
            const headBlocked = () => { const h = bot.blockAt(bot.entity.position.offset(0, 2, 0)); return h && !OPENISH.includes(h.name); };
            // ★WATER-EDGE FALLBACK — build UP when we can't dig DOWN. This is THE fix for the
            // endless "bunkering → can't seal → running" thrash that got the bot killed ~1/min:
            // it's a WATER WORLD and the spawn is a water edge, so digging down just floods and
            // never seals. So pillar UP on our own blocks (2 high) and box ourselves in (cap +
            // 4 walls) = a sealed platform that zombies/skeletons/creepers can't reach. A naked
            // respawn has dirt from digging; works anywhere we have filler.
            if (!headBlocked() && fillerOf()) {
                for (let up = 0; up < 2 && fillerOf(); up++) {
                    const fb = fillerOf();
                    try { await skills.placeBlockUnderFeet(bot, fb, { retries: 1, settleMs: 160 }); } catch (e) { try { bot.setControlState('jump', false); } catch (e2) {} }
                    await new Promise(r => setTimeout(r, 160));
                }
                const q = bot.entity.position.floored();
                for (let i = 0; i < 4; i++) {                       // cap head
                    const h2 = bot.blockAt(q.offset(0, 2, 0));
                    if (h2 && !OPENISH.includes(h2.name)) break;
                    const f = fillerOf(); if (!f) break;
                    try { await skills.placeBlock(bot, f, q.x, q.y + 2, q.z, 'bottom', true); } catch (e) {}
                    await new Promise(r => setTimeout(r, 140));
                }
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { // wall 4 sides (feet+head)
                    for (const dy of [0, 1]) {
                        const c = bot.blockAt(q.offset(dx, dy, dz));
                        if (c && OPENISH.includes(c.name)) { const f = fillerOf(); if (!f) break; try { await skills.placeBlock(bot, f, q.x + dx, q.y + dy, q.z + dz, 'bottom', true); } catch (e) {} }
                    }
                }
            }
            if (!headBlocked()) {
                const nightHold = this.coveredNightHoldStatus(bot);
                if (nightHold.hold) {
                    if (Date.now() - (this._coveredSealFailHoldAt || 0) > 12000) {
                        this._coveredSealFailHoldAt = Date.now();
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [self_preservation] covered seal-fail hold: hp=${Math.round(bot.health)} food=${bot.food} hostiles=${nightHold.hostiles} closest=${Number.isFinite(nightHold.closest) ? nightHold.closest.toFixed(1) : '-'} creeper=${Number.isFinite(nightHold.creeperDist) ? nightHold.creeperDist.toFixed(1) : '-'}\n`);
                        } catch (e) {}
                    }
                    try { bot.clearControlStates(); } catch (e) {}
                    await new Promise(r => setTimeout(r, 3000));
                    return;
                }
                // seal failed with no mobs in sight → back off 45s (see cooldown at entry)
                // instead of kiting nothing / re-firing every tick.
                if (this.nearbyHostiles(bot).length === 0 && !this.nearestCreeper(bot, 12)) {
                    this.bunkerCooldownUntil = Date.now() + 45000;
                    say(agent, 'Can\'t seal here, no mobs — standing down, skill-layer dig-in owns it.');
                    return;
                }
                // ★WITH-MOB oscillation breaker (the C18 gap): mobs present + seal fails +
                // the kite exits instantly on a concurrent interrupt → re-fire every tick,
                // and EACH refire preempts whatever escape work (ceiling chew / pillar) was
                // running — "does one swing then stops" for 1.5h on a chimney top. If we
                // fail to seal at the SAME spot 3 times running, the environment hasn't
                // changed: cool down 30s so the skill layer gets a contiguous window.
                // self_defense / point-blank reflexes are untouched by this cooldown.
                {
                    const pk = `${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.z)}`;
                    if (this._sealFailPos === pk) this._sealFailN = (this._sealFailN || 0) + 1;
                    else { this._sealFailPos = pk; this._sealFailN = 1; }
                    if (this._sealFailN >= 3) {
                        this._sealFailN = 0;
                        this.bunkerCooldownUntil = Date.now() + 30000;
                        say(agent, 'Can\'t seal here (3x) — standing down 30s, let the escape work run.');
                        return;
                    }
                }
                say(agent, 'Can\'t seal here — running from the swarm.');
                // Sprint directly AWAY from the hostiles' centroid, re-aiming each hop as they
                // move. Bounded (~12 hops) so it can never become its own loop; breaks the
                // instant we lose contact. Running relocates us — onto diggable dirt or out of
                // the spawn pocket — so the NEXT self_preservation tick may bunker successfully,
                // or the supervised grind resumes once we're clear. Staying ALIVE + moving beats
                // dying in place. Eat while moving to regen.
                //
                // INTERRUPT DISCIPLINE (do NOT reset interrupt_code inside this loop): when the
                // flee fails and the bot DIES mid-run, the executor requests a stop; the OLD code
                // reset interrupt_code every hop, which FOUGHT that stop, so "stop within 10s" was
                // refused and the whole agent process got KILLED ("Code execution refused stop
                // after 10 seconds") → restart → ~15s offline = churn by another name (a self-
                // inflicted death gap). Same class as the death_abort lesson: never battle the
                // stop. So: consume our own mode-activation interrupt ONCE on entry, then bail the
                // instant a NEW interrupt (death / respawn / framework stop) arrives.
                // ★KITE UNTIL DAWN (the human move — user: "真人遇险能一直灵活走位逃跑到天亮").
                // We CAN'T seal here (water edge). The OLD code ran 12 hops then RETURNED, so the
                // dispatch re-ran bunkerDown → tried to seal again → failed → ran again: that
                // pause-to-re-dig = standing still = caught and killed (the whole "bunkering ↔
                // Can't seal ↔ running" thrash). A human doesn't keep re-trying to dig in — they
                // just KEEP MOVING (flexible footwork toward the safest open ground, juking
                // skeletons) until DAWN, when the mobs burn. So: loop the WHOLE night, never
                // returning to re-bunker; exit only at daybreak (or interrupt/death/water).
                // Watchdog discipline: honor interrupt; say() periodically so agent.err stays
                // fresh (the freeze-watchdog's alive signal during this long loop).
                try { bot.interrupt_code = false; } catch (e) {}
                for (let kited = 0; kited < 4000 && !this.isDay(bot); kited++) {
                    if (bot.interrupt_code || bot.health <= 0) break;     // real stop / death — return promptly
                    // Only bail to the swim reflex if we're ACTUALLY DROWNING (low O2). Do NOT
                    // bail on merely standing in a shallow water-edge tile — that made the kite
                    // exit instantly at the water-edge spawn → re-bunker → kite → exit → a new
                    // thrash. safeFleeTarget already steers toward DRY land, so just keep kiting
                    // (wade out toward the dry target) unless we're truly going under.
                    if (bot.oxygenLevel !== undefined && bot.oxygenLevel <= 6) break;
                    const hs = this.nearbyHostiles(bot);
                    const cr = this.nearestCreeper(bot, 12);
                    if (hs.length === 0 && !cr) { try { bot.clearControlStates(); } catch (e) {} await new Promise(r => setTimeout(r, 1000)); continue; } // no mob → stop & keep watch (do NOT return = bunker-thrash)
                    // ★Do NOT clearControlStates here. The old per-iteration clear stopped forward/
                    // sprint right before fleeMove's lookAt(await) ran with forward=false — a stutter
                    // every cycle that cut average speed so a plain zombie caught the naked bot (died
                    // to mobs=1). Keep forward+sprint CONTINUOUS (like the creeper reflex that "sustains
                    // fine"); fleeMove just re-aims + manages jump. Strafe keys are cleared inside fleeMove.
                    const safe = this.safeFleeTarget(bot);
                    const skel = Object.values(bot.entities).some(e => e && e.position && /skeleton|stray/i.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 16);
                    if (safe && skel) {
                        for (let s = 0; s < 3; s++) {                      // 蛇皮走位: weave toward safe ground, dodging arrows
                            if (bot.interrupt_code || bot.health <= 0 || this.nearbyHostiles(bot).length === 0) break;
                            try { await bot.lookAt(safe.offset(0.5, 0, 0.5), true); } catch (e) {}
                            try { bot.clearControlStates(); } catch (e) {}
                            bot.setControlState('forward', true);
                            bot.setControlState('sprint', true);
                            bot.setControlState(s % 2 === 0 ? 'left' : 'right', true);
                            bot.setControlState('jump', s % 2 === 0);
                            await new Promise(r => setTimeout(r, 220));
                        }
                        try { bot.clearControlStates(); } catch (e) {}
                    } else if (safe) {
                        // RAW sprint toward the safe spot (NOT goToPosition): pathfinder sets/
                        // checks interrupt_code and is slow to start, which broke the kite after
                        // ~1 iteration every time (Kiting count stayed 0 = never sustained → it
                        // returned → re-bunker thrash). Raw control keeps us continuously moving,
                        // like the creeper reflex (which sustains fine).
                        await this.fleeMove(bot, safe);   // smart: hop steps, steer around trees/walls, no乱跳
                        await new Promise(r => setTimeout(r, 200));   // keep moving — no clear (continuous sprint)
                    } else {
                        // No scanned-safe spot — sprint directly away from the swarm centroid.
                        let cx = 0, cz = 0; for (const e of hs) { cx += e.position.x; cz += e.position.z; } cx /= (hs.length || 1); cz /= (hs.length || 1);
                        const me = bot.entity.position;
                        let dx = me.x - cx, dz = me.z - cz; const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
                        await this.fleeMove(bot, me.offset(dx * 4, 0, dz * 4));   // smart: away from swarm, hop/steer not乱跳
                        await new Promise(r => setTimeout(r, 200));   // keep moving — no clear (continuous sprint)
                    }
                    const food = bot.inventory.items().find(i => /cooked_|_bread|^bread$|^apple$|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|cod|salmon|_stew|baked_|rabbit/.test(i.name));
                    if (food && bot.food < 20) { try { await skills.consume(bot, food.name); } catch (e) {} }
                    if (kited % 8 === 7) { try { say(agent, 'Kiting the swarm till dawn…'); } catch (e) {} } // agent.err heartbeat (watchdog alive-signal)
                }
                try { bot.clearControlStates(); } catch (e) {}
                return;   // dawn / clear / interrupt — exit; the grind resumes by daylight
            }
            // Sealed OK — wait for daylight (bounded ~9 min), eating to regen meanwhile.
            // INTERRUPT DISCIPLINE (★the watchdog killer): action_manager.stop() calls
            // requestInterrupt() every 300ms (setting interrupt_code=true) and force-kills
            // the WHOLE process if our handler doesn't RETURN within 10s. mode handlers are
            // NOT auto-injected with interrupt checks (only LLM code is, via coder.js), so we
            // must honor it ourselves. The OLD loop RESET interrupt_code every 3s → it never
            // returned on a death/stop → "Code execution refused stop after 10s. Killing
            // process." → restart → ~15s offline = churn. Fix: consume our own activation
            // interrupt ONCE, then BREAK the instant a new one arrives (death/stop). Don't
            // reset inside. (If self_pres merely re-activates we just exit the wait and
            // re-evaluate next tick — safe; being killed mid-wait is not.)
            try { bot.interrupt_code = false; } catch (e) {}
            for (let w = 0; w < 110 && !this.isDay(bot); w++) {
                if (bot.interrupt_code || bot.health <= 0) break;   // real stop / death — return promptly, never refuse
                const food = bot.inventory.items().find(i => /cooked_|_bread|^bread$|^apple$|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|baked_|_stew/.test(i.name));
                if (food && bot.food < 20) { try { await skills.consume(bot, food.name); } catch (e) {} }
                if (w % 10 === 0) {
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [self_preservation] sealed night hold: w=${w} hp=${Math.round(bot.health)} food=${bot.food}\n`);
                    } catch (e) {}
                }
                await skills.wait(bot, 3000);
            }
        },
        update: async function (agent) {
            const bot = agent.bot;
            if (famineBodyFreeze(agent, 'self_preservation')) return;
            // ★YIELD TO THE MARCH (the 60s act_trace tape: sp's night-bunker dwell held
            // `active` continuously, and the scheduler's active-break meant the MAROONED
            // march NEVER got a turn — right diagnosis, starved reaction. While the
            // mobility machine says we're entrapped, bunkering/fleeing are meaningless
            // (the terrain is the enemy); sp only keeps the body for a CLOSE threat.)
            if (bot._mobility && /MAROONED|ENTOMBED/.test(bot._mobility.state)) {
                const closeThreat = this.nearbyHostiles(bot).some(e => e.position && e.position.distanceTo(bot.entity.position) < 6);
                if (!closeThreat) return;
            }
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            const WSET = ['water', 'flowing_water'];
            const feetWater = WSET.includes(block.name);
            const headWater = WSET.includes(blockAbove.name);
            // ===== MLG WATER-BUCKET CLUTCH (highest-priority reflex) =================
            // Falling toward a fatal drop? If we carry a water bucket, slap water on the
            // block we're about to hit so we land in it and take ZERO fall damage — the
            // classic clutch a human does. This is the payoff of keeping a bucket after a
            // fall death (the adaptive prep). Fires before the water/hostile branches because
            // a long fall kills faster than anything. Re-fires each tick as we approach the
            // floor, so timing self-corrects; we scoop the water back after landing to keep
            // the bucket reusable.
            const _vy = bot.entity.velocity ? bot.entity.velocity.y : 0;
            if (!bot.entity.onGround && _vy < -0.45 && !feetWater && !headWater) {
                let drop = 0, floor = null;
                for (let d = 1; d <= 24; d++) {
                    const b = bot.blockAt(bot.entity.position.offset(0, -d, 0));
                    if (!b) continue;
                    if (WSET.includes(b.name)) { floor = null; break; }   // water below — already safe, no clutch
                    if (b.boundingBox === 'block') { drop = d; floor = b; break; }
                }
                if (floor && drop >= 4) {
                    const wb = bot.inventory.items().find(i => i.name === 'water_bucket');
                    // ★S2b (framework lava_guard, blueprint §E.2): never clutch over lava.
                    // The floor-scan above stops at boundingBox==='block', but LAVA's
                    // boundingBox is 'empty' → it scans THROUGH lava and locks onto the
                    // solid block beneath it, then places water there while the bot drops
                    // into the lava on the way down. canClutchWater reads the first
                    // non-air block by NAME, so it refuses correctly when lava is below.
                    const cw = canClutchWater(bot);
                    if (wb && !cw.ok && /lava/.test(cw.reason || '')) {
                        say(agent, 'No clutch — lava below');
                        try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [mlg] clutch vetoed — lava below (S2b lava_guard)\n`); } catch (e) {}
                    } else if (wb) {
                        execute(this, agent, async () => {
                            say(agent, 'MLG water clutch!');
                            try { await bot.equip(wb, 'hand'); } catch (e) {}
                            try { await bot.look(bot.entity.yaw, -Math.PI / 2, true); } catch (e) {} // straight down
                            try { bot.activateItem(); } catch (e) {}                                  // place water below
                            for (let w = 0; w < 8 && !bot.entity.onGround; w++) await new Promise(r => setTimeout(r, 120));
                            // landed — PAUSE a beat before scooping (用户: 队友在看,瞬间收水
                            // 像闪现挂; 顿1.8s让人看清"垫水→落水→收水"的完整机制), then scoop
                            // the water back so we keep the bucket for next time.
                            await new Promise(r => setTimeout(r, 1800));
                            try {
                                const src = world.getNearestBlock(bot, 'water', 4);
                                if (src) { await bot.lookAt(src.position.offset(0.5, 0.5, 0.5), true); bot.activateItem(); }
                            } catch (e) {}
                        });
                        return;
                    }
                }
            }
            if (feetWater || headWater) {
                // ===== SWIMMING INSTINCT (hardcoded reflex, not a skill) ==========
                // The bot is in water. Three regimes, by situation:
                // ★Trigger EARLY (≤14, not ≤8). y51 deep-water deaths kept recurring (the death-
                // spiral IGNITER: drown underground with gear →裸装重生 → 连死): escaping a flooded
                // aquifer means chewing through rock toward the dug tunnel, which takes seconds. At
                // oxy≤8 there isn't enough air left to finish — by the time the reflex fired the bot
                // was already committed to dying. ≤14 ~doubles the escape window. Only affects y<55
                // deep water (the mining case); surface/river swims use the y≥55 branch, unaffected.
                const drowning = bot.oxygenLevel !== undefined && bot.oxygenLevel <= 14;
                const y0 = Math.floor(bot.entity.position.y);
                // Only defer to the pathfinder when it is ACTIVELY moving (a real path is
                // executing). A goal that's set-but-stuck must NOT block the swim reflex,
                // or the bot bobs in place forever behind a dead goal.
                const pathing = bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving();
                if (drowning && y0 < 55) {
                    // DEEP & out of air (flooded tunnel / aquifer): no shore to swim to.
                    // The OLD code only towered straight UP toward the distant surface —
                    // fatal at e.g. y-13 (76 blocks of rock to chew through while drowning),
                    // and it spun 11× "escaping up" while a cave spider finished us off. The
                    // air we actually need is the TUNNEL WE JUST DUG IN FROM — usually 2-3
                    // blocks HORIZONTALLY, not 76 up. So: seek the NEAREST reachable air
                    // pocket (biased horizontal, must have a solid floor to stand on) and
                    // path to it (pathfinder digs the short route). Tower-up only as a last
                    // resort when we're fully sealed in water/rock with no air anywhere near.
                    say(agent, 'Drowning — heading for air!');
                    execute(this, agent, async () => {
                        const AIRSET = ['air', 'cave_air', 'void_air'];
                        const isAirN = (b) => b && AIRSET.includes(b.name);
                        const nearestAir = () => {
                            const p = bot.entity.position.floored();
                            let best = null, bd = 1e9; const R = 6;
                            for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) for (let dy = R; dy >= -3; dy--) {
                                const d2 = dx * dx + dy * dy * 1.5 + dz * dz; // bias horizontal (cheaper/safer to reach than digging up)
                                if (d2 < 1 || d2 >= bd) continue;
                                const b = bot.blockAt(p.offset(dx, dy, dz));
                                if (isAirN(b)) {
                                    const below = bot.blockAt(p.offset(dx, dy - 1, dz));
                                    if (below && below.boundingBox === 'block') { best = p.offset(dx, dy, dz); bd = d2; } // standable air = our tunnel
                                }
                            }
                            return best;
                        };
                        for (let i = 0; i < 10 && (bot.oxygenLevel === undefined || bot.oxygenLevel < 16); i++) {
                            if (bot.interrupt_code) break;
                            const air = nearestAir();
                            if (air) {
                                try { await skills.goToPosition(bot, air.x, air.y, air.z, 0); } catch (e) {}
                                const hb = bot.blockAt(bot.entity.position.offset(0, 1, 0));
                                if (isAirN(hb) && bot.entity.onGround) break; // reached the air pocket
                            } else {
                                // ★C313-A (T-0049): in a DEEP water body the surface is >6b up, OUTSIDE
                                // nearestAir's R=6 box → air==null → this branch ran dig+pillar, which is
                                // far too slow IN WATER → she drowned (#116: y50 in open water, surface
                                // ~y63, "heading for air" never reached it). If the column above is open
                                // WATER (not sealed rock), just SWIM STRAIGHT UP — water lets you rise
                                // freely while jump is held; pillaring is only for rock-enclosure.
                                const upB = bot.blockAt(bot.entity.position.offset(0, 2, 0));
                                if (upB && /water/.test(upB.name || '')) {
                                    try { await bot.look(bot.entity.yaw, -1.45, false); } catch (e) {}
                                    bot.setControlState('forward', false);
                                    bot.setControlState('jump', true);
                                    await new Promise(r => setTimeout(r, 400));
                                } else {
                                    // Fully enclosed in ROCK — last resort: dig straight up + pillar.
                                    const head = bot.blockAt(bot.entity.position.offset(0, 2, 0));
                                    if (head && !['air', 'cave_air', 'water', 'flowing_water'].includes(head.name)) {
                                        // ★C314 (T-0056): equip a PICKAXE before the emergency seal-break. Bare-hand/
                                        // sword on stone is ~7.5s/block (see L1178) → a 7-block ceiling = 50s+, longer
                                        // than the drowning window (death 22:38 @y51 coveredAbove=7: said "heading for
                                        // air" but 70s wasn't enough to chew out → drowned). A pickaxe is ~3-4× faster,
                                        // making the rock-seal break feasible in time. Matches the equip-first pattern
                                        // every other dig site uses (1210/1845/1971/2282); only this drowning branch
                                        // omitted it. equipForBlock is a no-op if we hold no pickaxe → never worse.
                                        try { if (bot.tool && bot.tool.equipForBlock) await bot.tool.equipForBlock(head); } catch (e) {}
                                        try { await bot.dig(head); } catch (e) {}
                                    }
                                    try { await skills.pillarUp(bot, Math.floor(bot.entity.position.y) + 2); } catch (e) {}
                                    bot.setControlState('jump', true);
                                    await new Promise(r => setTimeout(r, 300));
                                }
                            }
                        }
                        try { bot.clearControlStates(); } catch (e) {}
                    });
                }
                else if (pathing && !drowning) {
                    // Deliberately swimming somewhere under pathfinder control (e.g.
                    // crossing a river toward a goal). Don't hijack — just hold jump so we
                    // ride the SURFACE instead of sinking and bleeding oxygen mid-crossing.
                    bot.setControlState('jump', true);
                }
                else if (y0 >= 55 && !combatHasPriority(bot)) {
                    // ★C332 (T-0063): when a killable non-creeper mob is point-blank and we can win,
                    // DON'T hijack to swim-to-shore — that higher-priority preempt is what shredded
                    // 'Fighting zombie!' with 'In water — getting out' and lost the fight. Let
                    // self_defense (lower priority, runs once we yield) stand in the shallows and kill
                    // it; the swim reflex re-engages the moment the mob is dead (combatHasPriority→false).
                    // SURFACE / OPEN WATER (lake, river, shallow pool) or idle-bobbing.
                    // This is the instinct the bot lacked: it used to float in place at a
                    // lake surface (blockAbove=air, so the old check never even fired) until
                    // night + mobs killed it. Now: SWIM to the nearest dry land and climb
                    // out, holding jump the whole way so we never sink or drown. Gated to
                    // y>=55 (near surface, where a shore is actually reachable) so it can't
                    // hijack a CONTROLLED DEEP DIVE — underground, mineDiamonds seals/dodges
                    // aquifers itself; yanking the bot "to shore" from y40 (no shore exists)
                    // would just tower it back up and undo the descent.
                    say(agent, 'In water — getting out.');
                    execute(this, agent, async () => {
                        // ★trace (the #264-family hang has never been pinned down: the
                        // execute wedges somewhere in here while the bot floats. Cheap
                        // breadcrumbs to progress.txt so the NEXT float tells us WHERE.)
                        const _tr = (s) => { try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [swim] ${s}\n`); } catch (e) {} };
                        _tr(`enter y=${Math.floor(bot.entity.position.y)}`);
                        const isWater = (b) => b && WSET.includes(b.name);
                        const AIRY = ['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern'];
                        const isAir = (b) => b && AIRY.includes(b.name);
                        const FILL = ['dirt', 'cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'stone', 'tuff', 'terracotta', 'sandstone', 'red_sandstone', 'netherrack', 'deepslate', 'gravel', 'sand', 'red_sand'];   // ★C280 +terracotta/sandstone/red_sand (badlands); gravity blocks last
                        const filler = () => { const c = world.getInventoryCounts(bot); return FILL.find(n => (c[n] || 0) > 0) || Object.keys(c).find(n => /_planks$|_log$/.test(n) && c[n] > 0); };
                        const inWaterNow = () => isWater(bot.blockAt(bot.entity.position)) || isWater(bot.blockAt(bot.entity.position.offset(0, 1, 0)));
                        const findShore = () => {
                            const p = bot.entity.position.floored();
                            let best = null, bd = 1e9; const R = 20;
                            for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
                                const d2 = dx * dx + dz * dz; if (d2 < 2 || d2 >= bd) continue;
                                for (let dy = 3; dy >= -5; dy--) {
                                    const g = bot.blockAt(p.offset(dx, dy, dz));
                                    if (!g) continue;
                                    if (g.boundingBox === 'block' && !WSET.includes(g.name)) {
                                        const a1 = bot.blockAt(p.offset(dx, dy + 1, dz)), a2 = bot.blockAt(p.offset(dx, dy + 2, dz));
                                        if (isAir(a1) && isAir(a2)) { best = p.offset(dx, dy + 1, dz); bd = d2; }
                                        break;
                                    }
                                }
                            }
                            return best;
                        };
                        // ★FIX: the old code swam toward findShore's target forever — when the bank
                        // was unreachable (across deep water / behind a wall) it bobbed in place 80
                        // iters, re-fired, and NEVER got out ("swimming to shore" spam, water-locked).
                        // It only pillared when NO shore was found. Now: if we're NOT getting closer
                        // to the shore (stuck) OR there's no shore, and we carry blocks (we hoard
                        // dirt), PILLAR UP out of the water — the 100%-reliable escape. We have 40
                        // dirt; build a tower under our feet until we're standing dry. Swim only
                        // when we're actually making progress toward a reachable bank.
                        try { bot.interrupt_code = false; } catch (e) {}
                        let lastDist = 1e9, stall = 0, exploreTicks = 0, exploreYaw = bot.entity.yaw;
                        for (let i = 0; i < 80; i++) {
                            if (bot.interrupt_code || bot.health <= 0) { _tr(`exit@${i} interrupt=${!!bot.interrupt_code}`); break; }
                            if (!inWaterNow() && bot.entity.onGround) { _tr(`exit@${i} OUT ok`); break; }
                            if (i % 10 === 0) _tr(`i=${i} pos=${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)} stall=${stall}`);
                            const target = findShore();
                            let stuck = false;
                            if (target) {
                                const pp = bot.entity.position;
                                const d = Math.hypot((target.x + 0.5) - pp.x, (target.z + 0.5) - pp.z);
                                if (d >= lastDist - 0.15) stall++; else stall = 0; // not getting closer
                                lastDist = d;
                                if (stall >= 3) stuck = true;
                            }
                            const f = filler();
                            // ★C318-A (T-0049, deaths #121/#122/#125): the stall>=3 pillar gate is
                            // DEFEATED by bobbing at a water EDGE — she oscillates y61↔63 trying to
                            // jump-climb onto the bank, `d` to shore wobbles so stall keeps resetting
                            // <3, pillar never fires, and she wedges (jump-fail) at the edge for 5min
                            // until a skeleton/drowning kills her (live -98,46: [swim] i=0..70 + edge_
                            // unstick wedged jump-fail, never OUT). FORCE the 100%-reliable pillar-up
                            // after ~6s still-in-water regardless of stall/target — swimming-to-shore
                            // has demonstrably failed by then, and pillaring up always clears the edge.
                            if ((!target || stuck || i >= 30) && f) {
                                // PILLAR UP — jump + place a block under our feet, rise out of water.
                                bot.setControlState('forward', false);
                                try { await skills.placeBlockUnderFeet(bot, f, { retries: 1, settleMs: 160 }); } catch (e) { try { bot.setControlState('jump', false); } catch (e2) {} }
                                await new Promise(r => setTimeout(r, 160));
                                stall = 0; lastDist = 1e9;
                            } else if (target && !stuck) {
                                try { await bot.lookAt(target.offset(0.5, 0, 0.5), true); } catch (e) {}
                                bot.setControlState('forward', true);
                                bot.setControlState('sprint', true);
                                bot.setControlState('jump', true);             // ride the surface
                                await new Promise(r => setTimeout(r, 220));
                            } else {
                                // ★C346 (T-0091): VERTICAL-EXIT topology. When the ONLY opening is
                                // one air cell straight overhead and all four horizontal neighbors
                                // are water, no shore exists to swim to and (empty pack) we can't
                                // pillar — the old explore below would swim+rotate horizontally
                                // FOREVER, bobbing y60↔62.7, never climbing the hole (live 2026-06-
                                // 24 @51,62,2: "In water — getting out" ×∞, 15min+ pin, 2 kicks
                                // couldn't break it). Detect the hole and climb it: look straight up
                                // + hold jump so buoyancy lifts the body into the single-cell air
                                // exit. (mobility's SWIM_STUCK escalation backstops this after 12s;
                                // here the instinct self-rescues immediately when the hole exists.)
                                const m2 = bot.entity.position.floored();
                                const aboveB = bot.blockAt(m2.offset(0, 2, 0));
                                const ringB = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => bot.blockAt(m2.offset(dx, 1, dz)));
                                const verticalExit = isAir(aboveB) && ringB.every(b => isWater(b) || !b);
                                if (verticalExit) {
                                    bot.setControlState('forward', true);   // seat the body under the hole
                                    bot.setControlState('sprint', false);
                                    try { await bot.look(bot.entity.yaw, -1.45, true); } catch (e) {}
                                    bot.setControlState('jump', true);
                                    await new Promise(r => setTimeout(r, 320));
                                    bot.setControlState('forward', false);
                                    stall = 0; lastDist = 1e9;
                                } else {
                                    // ★FIX(water-lock + EMPTY inventory): no shore within R, OR stuck
                                    // against an obstacle, AND no block to pillar with. The old code
                                    // just bobbed in place ("stay afloat") → naked water-edge respawn
                                    // never escaped, collected 0 wood, deadlocked forever. A water body
                                    // is FINITE: COMMIT to a heading and swim hard (forward+sprint+jump
                                    // to ride the surface); whenever we stall, rotate the heading ~72°
                                    // to work around walls / out of a cove. This escapes any water-lock
                                    // with ZERO blocks — the instinct must not depend on carried filler.
                                    exploreTicks++;
                                    if (exploreTicks % 6 === 0) { exploreYaw += Math.PI / 2.5; stall = 0; lastDist = 1e9; }
                                    try { await bot.look(exploreYaw, -0.05, true); } catch (e) {}
                                    bot.setControlState('forward', true);
                                    bot.setControlState('sprint', true);
                                    bot.setControlState('jump', true);             // ride the surface, don't sink
                                    await new Promise(r => setTimeout(r, 220));
                                }
                            }
                        }
                        try { bot.clearControlStates(); } catch (e) {}
                    });
                }
                else {
                    // DEEP (y<55), in water, oxygen still OK, no active path: a controlled
                    // dive is in progress (mineDiamonds handling the aquifer) or we're in a
                    // cave pool. Don't hijack — just hold jump so we don't passively sink and
                    // start drowning; if oxygen does run out the drowning branch above fires.
                    bot.setControlState('jump', true);
                }
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))
                || (blockAbove.boundingBox === 'block' && blockAbove.name !== 'lava')
                || (block.boundingBox === 'block' && block.name !== 'lava')) {
                // (third clause: FEET wedged in a solid block — doesn't suffocate but
                // freezes all movement; seen entombed in a cliff alcove, pathfinder
                // half-dug nook + interrupt storm. Dig free exactly like a head wedge.)
                execute(this, agent, async () => {
                    // ANY solid block in the bot's HEAD space = suffocation in progress.
                    // Originally this branch only matched sand/gravel (falling columns) —
                    // death #262 (blackbox): head wedged into plain stone during a
                    // dig-to-surface stair climb, self_preservation was ACTIVE but this
                    // branch didn't match, and the bot stood still holding a stone pickaxe
                    // while 2dmg/1.2s ground 7hp to 0 in 3.6s. Generalized: head block is
                    // solid → equip the right tool FIRST (bare-hand stone is 7.5s/block,
                    // far slower than suffocation kills; with the pick it's 0.6s) → dig the
                    // head space clear, eating a falling column if one feeds it. Then a
                    // best-effort step aside (swallow PathfindingFailed so it never
                    // thrashes).
                    // ★STEP-OUT FIRST (death #271: wedged into own placed cobble, bare-hand
                    // dig is 7.5s/block but suffocation kills in ~6s at hp10 — digging
                    // CANNOT win without a pick. Walking out of the cell stops the damage
                    // in ~0.5s. Try a quick sidestep toward any open neighbor BEFORE
                    // committing to the dig.)
                    {
                        const m0 = bot.entity.position.floored();
                        for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                            const a1 = bot.blockAt(m0.offset(sx, 0, sz)), a2 = bot.blockAt(m0.offset(sx, 1, sz));
                            const ok = (b) => !b || b.boundingBox !== 'block';
                            if (!ok(a1) || !ok(a2)) continue;
                            const fl = bot.blockAt(m0.offset(sx, -1, sz));
                            if (!fl || fl.boundingBox !== 'block') continue;
                            try { await bot.lookAt(m0.offset(sx + 0.5, 1.6, sz + 0.5), true); } catch (e) {}
                            bot.setControlState('forward', true); bot.setControlState('sprint', true);
                            await new Promise(r => setTimeout(r, 700));
                            try { bot.clearControlStates(); } catch (e) {}
                            break;
                        }
                    }
                    for (let i = 0; i < 8; i++) {
                        // head first (suffocation damage), then feet (movement lock)
                        const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
                        const feet = bot.blockAt(bot.entity.position);
                        const tgt = (head && head.boundingBox === 'block') ? head
                            : (feet && feet.boundingBox === 'block') ? feet : null;
                        if (!tgt) break;
                        try { await bot.tool.equipForBlock(tgt); } catch (e) {}
                        try { await bot.dig(tgt); } catch (e) { break; }
                        await new Promise(r => setTimeout(r, 200)); // let the next block fall in
                    }
                    try { await skills.moveAway(bot, 1); } catch (e) {}
                });
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, 'I\'m on fire!');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                    });
                }
                else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                            return;
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            if (success) say(agent, 'Found some water, ahhhh that\'s better!');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    });
                }
            }
            // ★T-0101/T-0083 FROZEN-ALIVE 互锁破除 — 反射层让位 gate。放在所有真·物理急症
            //   (MLG水桶/淹水/坠落/suffocation/lava/fire,均在此之上的 if/else-if 分支)之后,
            //   但在所有"避险但非急症"的 hold/backoff/flee(covered night hold / creeper hunger-hold /
            //   flee,均在此之下)之前。当饥饿僵局(food<=2 不回血 + 无 LETHAL 急症)且决策层已派觅食
            //   skill(feedUp/villageHarvest/forageExplore)在跑时,self_preservation 反射 NOT 抢身体——
            //   不 execute hold,直接 return,把身体让给觅食 skill 走向 village/食物源。这破除 worker-food
            //   实锤的"打破日志疯刷但 bot 从不真走"(反射每拍 hold 抵消觅食移动)。LETHAL 急症仍由
            //   famineForageActive 内部排除(creeper<4.5/挨打/hp<=4/swarm)→ 那些情形不让位,继续守 hold。
            else if (famineForageActive(bot)) {
                if (Date.now() - (this._famineForageYieldAt || 0) > 10000) {
                    this._famineForageYieldAt = Date.now();
                    try {
                        const p = bot.entity.position.floored();
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [self_preservation] ★famine-forage yield: food=${bot.food} hp=${Math.round(bot.health)} pos=${p.x},${p.y},${p.z} skill=${bot._currentSkill || '-'} — 让位给觅食 skill(无 LETHAL 急症),不抢身体\n`);
                    } catch (e) {}
                }
                return;   // 不 execute hold,把身体让给正在跑的觅食 skill
            }
            else if (this.coveredNightHoldStatus(bot).hold) {
                const hold0 = this.coveredNightHoldStatus(bot);
                if (Date.now() - (this._coveredNightHoldSayAt || 0) > 15000) {
                    this._coveredNightHoldSayAt = Date.now();
                    // ★T-0067: hold now requires sealedNightBox (real roof + 4 walls), so this is a
                    // GENUINE sealed box — the old "Covered ... staying sealed" fired on a loose roof
                    // with open sides and the bot stood still while a zombie walked in (06-25 死亡).
                    say(agent, `Real-sealed night hold (${hold0.hostiles} mob, nearest ${Number.isFinite(hold0.closest) ? hold0.closest.toFixed(1) : '-'}m) — staying boxed in.`);
                }
                execute(this, agent, async () => {
                    try { bot.clearControlStates(); } catch (e) {}
                    try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [self_preservation] covered night hold: hp=${Math.round(bot.health)} food=${bot.food} hostiles=${hold0.hostiles} closest=${Number.isFinite(hold0.closest) ? hold0.closest.toFixed(1) : '-'} creeper=${Number.isFinite(hold0.creeperDist) ? hold0.creeperDist.toFixed(1) : '-'}\n`);
                    } catch (e) {}
                    await skills.wait(bot, 3000);
                });
            }
            else if (this.creeperBackoffTarget(bot)) {
                // ===== CREEPER REFLEX (highest-priority hostile response) =============
                // A creeper is the ONE mob you must never bunker or melee beside: stopping
                // to dig a shelter (or trading blows) lets it close to ~3 blocks, fuse, and
                // detonate — which is exactly how we kept dying ("blown up by Creeper"). The
                // night-shelter / flee branches below would do precisely the wrong thing, so
                // this preempts them. The ONLY correct reflex is to put DISTANCE between us:
                // sprint directly away from the creeper until it's >9 blocks (fuse resets and
                // it stops tracking). No digging, no fighting — just back off. Watchdog
                // discipline: honor a real interrupt/death so we never refuse stop (churn).
                const cr0 = this.creeperBackoffTarget(bot) || this.nearestCreeper(bot);
                const cr0Dist = cr0 && cr0.position ? cr0.position.distanceTo(bot.entity.position) : Infinity;
                const hasNormalFood = bot.inventory.items().some(i => i && i.name && NORMAL_FOOD_RE.test(i.name));
                const lowHpNoRegenNoFood = bot.health <= 8 && bot.food < 18 && !hasNormalFood;
                const coveredOrEnclosed = (bot._mobility && bot._mobility.enclosed) || this.hasOverheadCover(bot, 2, 6);
                const hungryNoFoodCovered = bot.food <= 8 && !hasNormalFood && coveredOrEnclosed;
                if ((lowHpNoRegenNoFood || hungryNoFoodCovered) && coveredOrEnclosed && cr0Dist > 5.5) {
                    // ★停滞打破 (worker-death 06-26 实锤: bot 在此 hold 冻 150min @91,159 food=0 hp7,
                    //   苦力怕 6.2格静止不动). "no-calorie-burning hold" 假设威胁会过去/食物会来,但 food=0
                    //   永不回血 + 静止远苦力怕(>5.5格)不走 = 永久停滞(进度归零本身即罪). 修: 白天连续
                    //   hold >90s = 死锁非避险,打破 → fall-through 到下方 backoff(sprint away 远离苦力怕,
                    //   food 已0烧不掉更多/hp 饥饿在 normal 不致死),离开后 creeperBackoffTarget→null,
                    //   kernelDriver 接管派 feedUp 求食. 夜间(!isDay)仍 hold 等天亮(夜出送死),天亮再打破——
                    //   昼夜不对称: 夜避险 vs 昼必须 productive 求食.
                    if (this.isDay(bot)) {
                        if (!this._creeperHungerHoldSince) this._creeperHungerHoldSince = Date.now();
                    } else { this._creeperHungerHoldSince = 0; }   // 夜间重置,只累计白天连续 hold
                    const _hungerHoldStuck = this._creeperHungerHoldSince && (Date.now() - this._creeperHungerHoldSince > 90000);
                    if (!_hungerHoldStuck) {
                        if (Date.now() - (this._creeperCoveredLowHpHoldAt || 0) > 5000) {
                            this._creeperCoveredLowHpHoldAt = Date.now();
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [self_preservation] creeper covered hunger hold: cdist=${cr0Dist.toFixed(1)} hp=${Math.round(bot.health)} food=${bot.food} enclosed=${!!(bot._mobility && bot._mobility.enclosed)} covered=${this.hasOverheadCover(bot, 2, 6)} lowHp=${lowHpNoRegenNoFood} — no calorie-burning backoff\n`);
                            } catch (e) {}
                        }
                        execute(this, agent, async () => {
                            try { bot.clearControlStates(); } catch (e) {}
                            try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                            await skills.wait(bot, 2000);
                        });
                        return;
                    }
                    // 白天 hold >90s → 打破停滞,记录一次,fall through 到下方 creeper backoff(sprint away)
                    if (Date.now() - (this._creeperHungerHoldBreakAt || 0) > 30000) {
                        this._creeperHungerHoldBreakAt = Date.now();
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [self_preservation] ★creeper hunger hold 打破(白天停滞${Math.round((Date.now() - this._creeperHungerHoldSince) / 1000)}s): food=${bot.food} hp=${Math.round(bot.health)} cdist=${cr0Dist.toFixed(1)} — food=0永不回血,弃hold,backoff离开停滞点+让kernelDriver派feedUp求食\n`);
                        } catch (e) {}
                    }
                    // fall through ↓ (不 return → 进入下方 backoff sprint-away)
                }
                const tableHold = tableRecoveryHold(bot);
                if (tableHold && cr0Dist > 5.5) {
                    if (Date.now() - (this._creeperTableRecoveryHoldAt || 0) > 5000) {
                        this._creeperTableRecoveryHoldAt = Date.now();
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [self_preservation] creeper table-recovery hold: cdist=${cr0Dist.toFixed(1)} raw16=${tableHold.raw} layered16=${tableHold.layered} day=${!tableHold.isNight} — suppress raw backoff for advisory-nonactionable layered threat\n`);
                        } catch (e) {}
                    }
                    execute(this, agent, async () => {
                        try { bot.clearControlStates(); } catch (e) {}
                        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                        await skills.wait(bot, 2000);
                    });
                    return;
                }
                say(agent, `Creeper ${Math.round(cr0.position.distanceTo(bot.entity.position))}m — backing off!`);
                execute(this, agent, async () => {
                    try { bot.interrupt_code = false; } catch (e) {}   // consume activation interrupt once
                    // FAST raw sprint (NOT pathfinder — a creeper fuses in ~1.5s; goToPosition's
                    // startup latency got us blown up). safeFleeTarget = direction hint (away from
                    // ALL mobs + water); ledge-check so we don't sprint off a cliff.
                    // ★UNIFIED WITH KITE: a lone short 14-iter backoff (then return) let the broader
                    // zombie/skeleton swarm kill us between re-fires (the "Creeper backing off"
                    // thrash, hp→2). So in DAY we back off until the creeper is clear then resume;
                    // at NIGHT we MERGE into kite-till-dawn — keep moving from creeper+swarm
                    // continuously until daybreak, never returning to re-thrash.
                    let lastRunPos = bot.entity.position.clone();
                    let stuckRun = 0;
                    let sideFlip = 1;
                    let lastWedgeLog = 0;
                    for (let i = 0; i < 4000; i++) {
                        if (bot.interrupt_code || bot.health <= 0) break;
                        if (bot.oxygenLevel !== undefined && bot.oxygenLevel <= 6) break; // drowning → swim reflex
                        const c = this.nearestCreeper(bot, 12);
                        const swarm = this.nearbyHostiles(bot).length > 0;
                        const me = bot.entity.position;
                        if (this.isDay(bot)) { if (!c || c.position.distanceTo(me) > 9) break; }  // day: clear of creeper → resume
                        else if (!c && !swarm) break;                                            // night: only stop when fully clear
                        try { bot.clearControlStates(); } catch (e) {}
                        const safe = this.safeFleeTarget(bot);
                        let dx, dz;
                        if (safe) { dx = (safe.x + 0.5) - me.x; dz = (safe.z + 0.5) - me.z; }
                        else if (c) { dx = me.x - c.position.x; dz = me.z - c.position.z; }
                        else { const hs = this.nearbyHostiles(bot); let sx = 0, sz = 0; for (const e of hs) { sx += e.position.x; sz += e.position.z; } sx /= (hs.length || 1); sz /= (hs.length || 1); dx = me.x - sx; dz = me.z - sz; }
                        const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
                        if (stuckRun >= 8) {
                            // Raw creeper backoff can wedge on cliff/step lips: it keeps
                            // forward+jump+sprint in the same cell until the fuse catches up.
                            // Rotate sideways first; if point-blank and still wedged, stop
                            // "running" and attempt an emergency seal/pillar instead.
                            const odx = dx, odz = dz;
                            dx = -odz * sideFlip; dz = odx * sideFlip;
                            if (i % 12 === 0) sideFlip *= -1;
                            if (Date.now() - lastWedgeLog > 1500) {
                                lastWedgeLog = Date.now();
                                try {
                                    fs.appendFileSync('bots/_supervisor/progress.txt',
                                        `[${new Date().toISOString()}] [self_preservation] creeper backoff wedged: stuck=${stuckRun} pos=${Math.floor(me.x)},${Math.floor(me.y)},${Math.floor(me.z)} cdist=${c ? c.position.distanceTo(me).toFixed(1) : '-'} rotate=${dx.toFixed(2)},${dz.toFixed(2)}\n`);
                                } catch (e) {}
                            }
                            if (stuckRun >= 16 && c && c.position.distanceTo(me) < 5) {
                                try { bot.clearControlStates(); } catch (e) {}
                                try {
                                    fs.appendFileSync('bots/_supervisor/progress.txt',
                                        `[${new Date().toISOString()}] [self_preservation] creeper backoff failed point-blank — emergency bunker fallback\n`);
                                } catch (e) {}
                                await this.bunkerDown(agent);
                                break;
                            }
                        }
                        try { await bot.lookAt(me.offset(dx * 4, 0, dz * 4), true); } catch (e) {}
                        const inspectRunDir = (rx, rz) => {
                            try {
                                const fwd = bot.entity.position.offset(rx, 0, rz).floored();
                                const foot = bot.blockAt(fwd);
                                const head = bot.blockAt(fwd.offset(0, 1, 0));
                                const bad = (b) => b && /water|lava|fire|cactus|magma/.test(b.name || '');
                                let drop = 5;
                                for (let d = 0; d <= 4; d++) {
                                    const b = bot.blockAt(fwd.offset(0, -d, 0));
                                    if (b && b.boundingBox === 'block') { drop = d; break; }
                                }
                                return { fwd, foot, head, drop, hazard: bad(foot) || bad(head) };
                            } catch (e) { return { fwd: null, foot: null, head: null, drop: 5, hazard: true }; }
                        };
                        const creeperCorridorRisk = (rx, rz, target) => {
                            try {
                                const p0 = bot.entity.position;
                                for (const e of Object.values(bot.entities || {})) {
                                    if (!e || !e.position || !/creeper/i.test(e.name || '')) continue;
                                    const d0 = e.position.distanceTo(p0);
                                    if (d0 > 24) continue;
                                    const vx = e.position.x - p0.x;
                                    const vz = e.position.z - p0.z;
                                    const h = Math.hypot(vx, vz);
                                    if (h < 0.001) return { risk: true, name: e.name || 'creeper', d: d0, toward: 1, projected: 0 };
                                    const toward = (rx * vx + rz * vz) / h;
                                    let projected = d0;
                                    for (const step of [2, 4, 6]) {
                                        const px = p0.x + rx * step;
                                        const pz = p0.z + rz * step;
                                        projected = Math.min(projected, Math.hypot(e.position.x - px, e.position.z - pz));
                                    }
                                    if (e === target) {
                                        if (d0 <= 5.5 && toward > -0.1) return { risk: true, name: e.name || 'creeper', d: d0, toward, projected };
                                        if (d0 > 5.5 && d0 < 10 && toward > 0.25) return { risk: true, name: e.name || 'creeper', d: d0, toward, projected };
                                        continue;
                                    }
                                    if ((d0 < 18 && toward > 0.15) || projected < 7.5) {
                                        return { risk: true, name: e.name || 'creeper', d: d0, toward, projected };
                                    }
                                }
                            } catch (e) {}
                            return { risk: false };
                        };
                        const rotate = (rx, rz, a) => {
                            const ca = Math.cos(a), sa = Math.sin(a);
                            return [rx * ca - rz * sa, rx * sa + rz * ca];
                        };
                        const maxDrop = bot.health <= 8 ? 1 : 2;
                        let runDir = null;
                        let runInfo = null;
                        let runRisk = null;
                        for (const a of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
                            const [tx, tz] = rotate(dx, dz, a);
                            const info = inspectRunDir(tx, tz);
                            const risk = creeperCorridorRisk(tx, tz, c);
                            if (!info.hazard && info.drop <= maxDrop && !risk.risk) {
                                runDir = [tx, tz];
                                runInfo = info;
                                break;
                            } else if (!info.hazard && info.drop <= maxDrop && !runRisk) {
                                runRisk = risk;
                            }
                        }
                        if (!runDir) {
                            try { bot.clearControlStates(); } catch (e) {}
                            const bad = inspectRunDir(dx, dz);
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [self_preservation] creeper backoff gated: pos=${Math.floor(me.x)},${Math.floor(me.y)},${Math.floor(me.z)} cdist=${c ? c.position.distanceTo(me).toFixed(1) : '-'} drop=${bad.drop} hp=${Math.round(bot.health)} food=${bot.food} risk=${runRisk && runRisk.risk ? `${runRisk.name}@${runRisk.d.toFixed(1)} proj=${runRisk.projected.toFixed(1)} toward=${runRisk.toward.toFixed(2)}` : 'cliff'}; emergency bunker/hold\n`);
                            } catch (e) {}
                            await this.bunkerDown(agent);
                            break;
                        }
                        dx = runDir[0]; dz = runDir[1];
                        const ledge = runInfo.drop > 1;                     // cautious walk only on a small step-down
                        try { await bot.lookAt(me.offset(dx * 4, 0, dz * 4), true); } catch (e) {}
                        bot.setControlState('forward', true);
                        bot.setControlState('sprint', !ledge);
                        bot.setControlState('jump', !ledge);
                        await new Promise(r => setTimeout(r, 160));
                        const nowPos = bot.entity.position.clone();
                        const moved = Math.hypot(nowPos.x - lastRunPos.x, nowPos.z - lastRunPos.z);
                        if (moved < 0.12 && (c || swarm)) stuckRun++;
                        else stuckRun = 0;
                        lastRunPos = nowPos;
                        if (i % 10 === 9) { try { say(agent, 'Kiting creeper+swarm till dawn…'); } catch (e) {} } // agent.err heartbeat (watchdog alive-signal)
                    }
                    try { bot.clearControlStates(); } catch (e) {}
                });
            }
            else if (this.shouldNightShelter(bot)) {
                if (Date.now() - (this._lastNightfallSayAt || 0) > 30000) {
                    this._lastNightfallSayAt = Date.now();
                    say(agent, 'Nightfall — securing till dawn (proactive, before mobs swarm).');
                }
                execute(this, agent, () => this.bunkerDown(agent));
            }
            else if (this.shouldFlee(bot)) {
                // THREAT RETREAT — "judge you can't win, then run." Count nearby
                // hostiles and check for a weapon; if we're outmatched (no weapon /
                // low health / 2+ mobs) FLEE decisively and KEEP fleeing every tick
                // until clear, rather than trading one step for a hit and getting
                // caught (the old single moveAway let zombies catch up). Staying
                // ALIVE preserves the inventory so the re-entrant achieve run can
                // resume — far better than dying and rebuilding from nothing.
                const hostiles = this.nearbyHostiles(bot);
                const noRegenHold = lowHpNoRegenContainedHold(bot);
                if (noRegenHold) {
                    if (Date.now() - (this._noRegenFleeHoldAt || 0) > 5000) {
                        this._noRegenFleeHoldAt = Date.now();
                        try {
                            const p = bot.entity.position.floored();
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [self_preservation] no-regen flee hold: food=${bot.food} hp=${Math.round(bot.health || 0)} pos=${p.x},${p.y},${p.z} mob=${noRegenHold.mob || '-'} enclosed=${noRegenHold.enclosed} covered=${noRegenHold.covered} closest=${noRegenHold.closestName || '-'}@${Number.isFinite(noRegenHold.closest) ? noRegenHold.closest.toFixed(1) : '-'} — no bunkerDown/dig\n`);
                        } catch (e) {}
                    }
                    execute(this, agent, async () => {
                        try { bot.clearControlStates(); } catch (e) {}
                        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                        try { bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop(); } catch (e) {}
                        await skills.wait(bot, 2500);
                    });
                    return;
                }
                say(agent, `Outmatched (${hostiles.length} mob, hp ${Math.round(bot.health)}) — digging in!`);
                execute(this, agent, async () => {
                    // ★UNDERGROUND RANGED WALL-OFF (deaths 196+197, same shape twice: cave
                    // "fall" with a skeleton ~8 blocks — arrow KNOCKBACK near mining shafts.
                    // Strafing/fleeing underground = getting knocked into a hole; pathfind-
                    // aware flee can't help because knockback ignores paths.) The human move:
                    // slam a 2-high block wall between you and the archer FIRST — arrows AND
                    // knockback vanish — then seal calmly. Bounded ~1s, only fires deep
                    // (y<60) with an actual skeleton/stray in range and a block in the bag.
                    try {
                        const me2 = bot.entity.position;
                        // 泛化 (223: 家底洞穴4怪窝,僵尸1.3格贴脸 — 原版只防骷髅): underground +
                        // outmatched → wall vs the NEAREST hostile of ANY type before sealing.
                        // Works on zombie pursuit and creeper LoS the same as arrows.
                        const HO2 = /zombie|skeleton|stray|creeper|spider|husk|drowned|witch|pillager|vindicator/i;
                        const skel2 = Object.values(bot.entities)
                            .filter(e => e && e.position && HO2.test(e.name || '') && e.position.distanceTo(me2) < 12)
                            .sort((a, b) => a.position.distanceTo(me2) - b.position.distanceTo(me2))[0];
                        if (skel2 && me2.y < 60) {
                            const mat = bot.inventory.items().find(i => /^(cobblestone|cobbled_deepslate|dirt|andesite|diorite|granite|tuff|netherrack)$/.test(i.name));
                            if (mat) {
                                let ddx = skel2.position.x - me2.x, ddz = skel2.position.z - me2.z;
                                const L = Math.hypot(ddx, ddz) || 1;
                                ddx = Math.round(ddx / L); ddz = Math.round(ddz / L);
                                const base = me2.floored().offset(ddx, 0, ddz);
                                for (const c of [base, base.offset(0, 1, 0)]) {
                                    const wb = bot.blockAt(c);
                                    if (wb && (wb.name === 'air' || wb.name === 'cave_air')) {
                                        try { await skills.placeBlock(bot, mat.name, c.x, c.y, c.z, 'bottom', true); } catch (e) {}
                                    }
                                }
                                say(agent, 'Walled off the archer.');
                            }
                        }
                    } catch (e) {}
                    // Outmatched = we can't win. Surface-fleeing in this mob-dense world just
                    // runs into MORE mobs and gets cornered — it killed us at hp1 in BROAD
                    // DAYLIGHT (skeletons/spiders/zombies in shade don't all burn off). The
                    // ONE reliable escape is to dig DOWN and seal, breaking all contact. At
                    // night bunkerDown also waits out the dark; in daytime its wait-loop is a
                    // no-op, so it just digs in, seals, and returns fast — then the grind
                    // resumes underground (where we want to be mining anyway). Eat first if
                    // we can, to start regen while we dig.
                    const food = bot.inventory.items().find(i => /cooked_|_bread|^bread$|apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|melon_slice|sweet_berries|_stew|rabbit|baked_/.test(i.name));
                    if (food && bot.food < 20) { try { await skills.consume(bot, food.name); } catch (e) {} }
                    await this.bunkerDown(agent);
                });
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'unstuck',
        description: 'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        step_prev_location: null,
        step_prev_time: 0,
        step_guard_until: 0,
        step_skip_key: null,
        step_skip_first_at: 0,
        step_skip_count: 0,
        step_skip_last_log_at: 0,
        update: async function (agent) {
            const bot = agent.bot;
            if (famineBodyFreeze(agent, 'unstuck')) {
                this.prev_location = null;
                this.stuck_time = 0;
                this.step_prev_location = null;
                return;
            }
            const containedHold = lowHpNoRegenContainedHold(bot);
            if (containedHold) {
                try {
                    bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null);
                    bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop();
                    bot.clearControlStates();
                } catch (e) {}
                this.prev_location = null;
                this.stuck_time = 0;
                this.prev_dig_block = null;
                this.step_prev_location = null;
                if (Date.now() - (bot._lastUnstuckContainedHoldAt || 0) > 15000) {
                    bot._lastUnstuckContainedHoldAt = Date.now();
                    const p = bot.entity.position.floored();
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [unstuck] no-regen contained hold: food=${bot.food} hp=${Math.round(bot.health || 0)} pos=${p.x},${p.y},${p.z} mob=${containedHold.mob || '-'} enclosed=${containedHold.enclosed} covered=${containedHold.covered} closest=${containedHold.closestName || '-'}@${Number.isFinite(containedHold.closest) ? containedHold.closest.toFixed(1) : '-'} — suppress moveAway/GoalInvert\n`);
                    } catch (e) {}
                }
                return;
            }
            const tableHold = tableRecoveryHold(bot);
            if (tableHold) {
                try {
                    bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null);
                    bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop();
                    bot.clearControlStates();
                } catch (e) {}
                this.prev_location = null;
                this.stuck_time = 0;
                this.prev_dig_block = null;
                this.step_prev_location = null;
                if (Date.now() - (bot._lastUnstuckTableRecoveryHoldAt || 0) > 15000) {
                    bot._lastUnstuckTableRecoveryHoldAt = Date.now();
                    const p = bot.entity.position.floored();
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [unstuck] table recovery hold: pos=${p.x},${p.y},${p.z} mob=${tableHold.mob || '-'} raw16=${tableHold.raw} layered16=${tableHold.layered} day=${!tableHold.isNight} — suppress GoalInvert/step-edge until actionable threat\n`);
                    } catch (e) {}
                }
                return;
            }
            const pathingNow = !!(bot && bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving());
            const mobilityWorkNow = !!(bot && bot._mobility && /MAROONED|POCKET|ENTOMBED/.test(bot._mobility.state || ''));
            if (agent.isIdle() && !pathingNow && !mobilityWorkNow) {
                this.prev_location = null;
                this.stuck_time = 0;
                this.step_prev_location = null;
                return; // don't get stuck when idle
            }
            const now = Date.now();
            try {
                const cs = bot.controlState || {};
                const p = bot.entity.position;
                if (!this.step_prev_location) {
                    this.step_prev_location = p.clone();
                    this.step_prev_time = now;
                } else if (now - this.step_prev_time >= 700) {
                    const moved = p.distanceTo(this.step_prev_location);
                    const skill = bot._currentSkill || '';
                    const yaw = bot.entity.yaw || 0;
                    const snapDir = (rx, rz) => {
                        if (!Number.isFinite(rx) || !Number.isFinite(rz) || Math.hypot(rx, rz) < 0.08) return null;
                        return Math.abs(rx) >= Math.abs(rz)
                            ? [Math.sign(rx) || 1, 0]
                            : [0, Math.sign(rz) || 1];
                    };
                    const candidates = [];
                    const addDir = (dir, source) => {
                        if (!dir) return;
                        const [cx, cz] = dir;
                        if (candidates.some(c => c.dx === cx && c.dz === cz)) return;
                        candidates.push({ dx: cx, dz: cz, source });
                    };
                    if (pathingNow && bot._lastPathGoalInfo && Date.now() - (bot._lastPathGoalAt || 0) < 10000) {
                        const g = bot._lastPathGoalInfo;
                        if (typeof g.x === 'number' && typeof g.z === 'number') addDir(snapDir(g.x - p.x, g.z - p.z), 'path-goal');
                        if (g.entity && g.entity.pos) addDir(snapDir(g.entity.pos.x - p.x, g.entity.pos.z - p.z), 'path-entity');
                        if (g.goal && typeof g.goal.x === 'number' && typeof g.goal.z === 'number') addDir(snapDir(g.goal.x - p.x, g.goal.z - p.z), 'path-inner-goal');
                    }
                    addDir(snapDir(p.x - this.step_prev_location.x, p.z - this.step_prev_location.z), 'recent-motion');
                    addDir(snapDir(-Math.sin(yaw), Math.cos(yaw)), 'yaw');
                    for (const d0 of [[1, 0], [0, 1], [-1, 0], [0, -1]]) addDir(d0, 'fallback');
                    let dx = candidates[0] ? candidates[0].dx : 1;
                    let dz = candidates[0] ? candidates[0].dz : 0;
                    let dirSource = candidates[0] ? candidates[0].source : 'default';
                    const cell = p.floored();
                    let targetCell, frontFoot, frontHead, frontAbove, frontBelow;
                    const refreshStepProbe = () => {
                        targetCell = cell.offset(dx, 0, dz);
                        frontFoot = bot.blockAt(targetCell);
                        frontHead = bot.blockAt(targetCell.offset(0, 1, 0));
                        frontAbove = bot.blockAt(targetCell.offset(0, 2, 0));
                        frontBelow = bot.blockAt(targetCell.offset(0, -1, 0));
                    };
                    refreshStepProbe();
                    const ownHead = bot.blockAt(cell.offset(0, 1, 0));
                    const ownAbove = bot.blockAt(cell.offset(0, 2, 0));
                    const solid = (b) => b && b.boundingBox === 'block';
                    const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow']);
                    const open = (b) => !b || b.boundingBox === 'empty' || PASSABLE.has(b.name || '');
                    const bad = (b) => b && /water|lava|fire|cactus|magma/.test(b.name || '');
                    const stationStep = (b) => b && /crafting_table|furnace|blast_furnace|smoker|chest|barrel|bed|anvil|enchanting_table|grindstone|stonecutter|loom|cartography_table|smithing_table|fletching_table|lectern|composter/i.test(b.name || '');
                    const hasPick = () => bot.inventory && bot.inventory.items().some(it => /_pickaxe$/.test(it.name || ''));
                    const clearableStepRoof = (b) => {
                        if (!b || b.boundingBox !== 'block') return false;
                        if (bad(b) || stationStep(b) || /bedrock|obsidian|end_portal|nether_portal/.test(b.name || '')) return false;
                        const stony = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|cobble/.test(b.name || '');
                        return !stony || hasPick();
                    };
                    const isStepLikeNow = () => solid(frontFoot) && open(frontHead) && open(frontAbove) && open(ownHead) && !stationStep(frontFoot) && !bad(frontFoot) && !bad(frontHead) && !bad(frontAbove);
                    if (!isStepLikeNow()) {
                        for (const c of candidates) {
                            dx = c.dx; dz = c.dz; dirSource = c.source;
                            refreshStepProbe();
                            if (isStepLikeNow()) break;
                        }
                    }
                    const stepLike = isStepLikeNow();
                    const wantsForward = !!(cs.forward || pathingNow || mobilityWorkNow || /surfaceUp|feedUp|chopWood|branchMine/.test(skill));
                    // Step-edge assist is specifically for traversal stalls. The hard
                    // guard is active digging/mining, not the surrounding skill name:
                    // surfaceUp/branchMine are exactly where one-block lip stalls recur.
                    const hasBodyWork = !!(bot.targetDigBlock || bot._mineMotionActiveDig || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil));
                    const blockName = (b) => b ? `${b.name}@${b.position.x},${b.position.y},${b.position.z}` : 'null';
                    const famineCriticalNoStep = (() => {
                        try {
                            if (!(bot.food <= 2 && bot.health <= 6)) return false;
                            const edible = bot.inventory && bot.inventory.items().some(i => i && i.name && FAMINE_FOOD_RE.test(i.name));
                            if (edible) return false;
                            const feetNow = bot.blockAt(cell);
                            const headNow = bot.blockAt(cell.offset(0, 1, 0));
                            if (bad(feetNow) || bad(headNow)) return false;
                            if (!bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.25) return false;
                            if (Date.now() - (bot.lastDamageTime || 0) < 4000) return false;
                            return true;
                        } catch (e) { return false; }
                    })();
                    const stepSkipReason = () => {
                        if (!wantsForward || moved >= 0.12 || hasBodyWork || now <= this.step_guard_until) return null;
                        if (famineCriticalNoStep) return 'famine-hold';
                        if (!solid(frontFoot)) return 'front-not-step';
                        if (stationStep(frontFoot)) return 'front-functional-station';
                        if (!open(frontHead)) return 'target-foot-blocked';
                        if (!open(frontAbove)) return 'target-head-blocked';
                        if (!open(ownHead)) return 'own-head-blocked';
                        if (bad(frontFoot) || bad(frontHead) || bad(frontAbove)) return 'hazard';
                        return null;
                    };
                    const skipReason = stepSkipReason();
                    if (skipReason) {
                        const skipKey = `${skipReason}:${targetCell.x},${targetCell.y},${targetCell.z}:${blockName(frontFoot)}:${blockName(frontHead)}:${blockName(frontAbove)}`;
                        const repeatedSkip = this.step_skip_key === skipKey && now - (this.step_skip_first_at || 0) < 20000;
                        this.step_skip_key = skipKey;
                        this.step_skip_first_at = repeatedSkip ? this.step_skip_first_at : now;
                        this.step_skip_count = repeatedSkip ? (this.step_skip_count || 0) + 1 : 1;
                        const structuralBlock = /target-foot-blocked|target-head-blocked|own-head-blocked|own-above-blocked|front-functional-station/.test(skipReason);
                        const guardMs = structuralBlock && this.step_skip_count >= 2 ? Math.min(15000, 2500 * this.step_skip_count) : 2500;
                        this.step_guard_until = now + guardMs;
                        if (guardMs > 2500 && now - (this.step_skip_last_log_at || 0) > 10000) {
                            this.step_skip_last_log_at = now;
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [step-edge] structural skip backoff reason=${skipReason} count=${this.step_skip_count} guard=${Math.ceil(guardMs / 1000)}s target=${targetCell.x},${targetCell.y},${targetCell.z} step=${frontFoot ? frontFoot.name : 'null'} foot=${frontHead ? frontHead.name : 'null'} head=${frontAbove ? frontAbove.name : 'null'} skill=${skill || '-'}\n`);
                            } catch (e) {}
                        }
                        try {
                            fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                                ts: new Date().toISOString(),
                                event: 'step_edge.skip',
                                pos: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) },
                                skill: bot._currentSkill || null,
                                mob: bot._mobility ? bot._mobility.state : null,
                                data: {
                                    reason: skipReason,
                                    moved: +moved.toFixed(3),
                                    dir: [dx, dz],
                                    dirSource,
                                    candidateDirs: candidates,
                                    pathGoal: bot._lastPathGoalInfo || null,
                                    targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                                    step: blockName(frontFoot),
                                    targetFoot: blockName(frontHead),
                                    targetHead: blockName(frontAbove),
                                    ownHead: blockName(ownHead),
                                    ownAbove: blockName(ownAbove),
                                    skipCount: this.step_skip_count,
                                    guardMs,
                                },
                            }) + '\n');
                        } catch (e) {}
                    }
                    if (wantsForward && stepLike && moved < 0.12 && !hasBodyWork && !famineCriticalNoStep && now > this.step_guard_until) {
                        this.step_guard_until = now + 3000;
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [step-edge] assist begin moved=${moved.toFixed(2)} dir=${dx},${dz}/${dirSource} target=${targetCell.x},${targetCell.y},${targetCell.z} step=${frontFoot ? frontFoot.name : 'null'} foot=${frontHead ? frontHead.name : 'null'} head=${frontAbove ? frontAbove.name : 'null'} below=${frontBelow ? frontBelow.name : 'null'} skill=${skill || '-'}\n`);
                        } catch (e) {}
                        execute(this, agent, async () => {
                            const exact = () => {
                                const q = bot.entity.position;
                                return { x: +q.x.toFixed(3), y: +q.y.toFixed(3), z: +q.z.toFixed(3) };
                            };
                            const envSnap = () => {
                                const c = bot.entity.position.floored();
                                const out = [];
                                for (let dy = -1; dy <= 2; dy++) {
                                    for (let dz0 = -1; dz0 <= 1; dz0++) {
                                        for (let dx0 = -1; dx0 <= 1; dx0++) {
                                            const b = bot.blockAt(c.offset(dx0, dy, dz0));
                                            out.push({
                                                d: [dx0, dy, dz0],
                                                n: b ? b.name : null,
                                                bb: b ? b.boundingBox : null,
                                            });
                                        }
                                    }
                                }
                                return out;
                            };
                            const motionLog = (event, data = {}) => {
                                try {
                                    fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                                        ts: new Date().toISOString(),
                                        event,
                                        pos: exact(),
                                        skill: bot._currentSkill || null,
                                        mob: bot._mobility ? bot._mobility.state : null,
                                        env: envSnap(),
                                        data,
                                    }) + '\n');
                                } catch (e) {}
                            };
                            const centerOnCurrentCell = async () => {
                                const c = bot.entity.position.floored();
                                const center = c.offset(0.5, 0.05, 0.5);
                                const dist = Math.hypot(bot.entity.position.x - center.x, bot.entity.position.z - center.z);
                                if (dist < 0.24) return;
                                try {
                                    await bot.lookAt(center.offset(0, 1.45, 0), true);
                                    bot.setControlState('sprint', false);
                                    bot.setControlState('jump', false);
                                    bot.setControlState('forward', true);
                                    await new Promise(r => setTimeout(r, Math.min(260, Math.max(120, dist * 420))));
                                } finally {
                                    try { bot.clearControlStates(); } catch (e) {}
                                }
                            };
                            try {
                                bot._bodyMoveLockOwner = 'unstuck:step-edge';
                                bot._bodyMoveLockUntil = Date.now() + 2800;
                                const start = bot.entity.position.clone();
                                const freshCell = bot.entity.position.floored();
                                const freshTarget = freshCell.offset(dx, 0, dz);
                                const freshStep = bot.blockAt(freshTarget);
                                const freshFoot = bot.blockAt(freshTarget.offset(0, 1, 0));
                                const freshHead = bot.blockAt(freshTarget.offset(0, 2, 0));
                                const freshOwnHead = bot.blockAt(freshCell.offset(0, 1, 0));
                                let freshOwnAbove = bot.blockAt(freshCell.offset(0, 2, 0));
                                if (!open(freshOwnAbove)) {
                                    const clearable = clearableStepRoof(freshOwnAbove);
                                    motionLog('step_edge.own_above_notch.begin', {
                                        clearable,
                                        dir: [dx, dz],
                                        targetCell: { x: freshTarget.x, y: freshTarget.y, z: freshTarget.z },
                                        block: blockName(freshOwnAbove),
                                    });
                                    let notchOk = false;
                                    let notchErr = null;
                                    if (clearable) {
                                        try {
                                            bot._bodyDigLockOwner = 'unstuck:step-edge-own-above-notch';
                                            bot._bodyDigLockUntil = Date.now() + 5200;
                                            try { bot.clearControlStates(); } catch (e) {}
                                            try { if (bot.tool && bot.tool.equipForBlock) await bot.tool.equipForBlock(freshOwnAbove); } catch (e) {}
                                            try { await bot.lookAt(freshOwnAbove.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                                            await Promise.race([
                                                bot.dig(freshOwnAbove, true),
                                                new Promise((_, rej) => setTimeout(() => rej(new Error('own-above-notch-timeout')), 4800)),
                                            ]);
                                            await new Promise(r => setTimeout(r, 120));
                                            freshOwnAbove = bot.blockAt(freshCell.offset(0, 2, 0));
                                            notchOk = open(freshOwnAbove);
                                        } catch (e) {
                                            notchErr = e && e.message ? e.message : String(e);
                                        } finally {
                                            try { bot.clearControlStates(); } catch (e) {}
                                            if (bot._bodyDigLockOwner === 'unstuck:step-edge-own-above-notch') {
                                                bot._bodyDigLockOwner = null;
                                                bot._bodyDigLockUntil = 0;
                                            }
                                        }
                                    }
                                    motionLog('step_edge.own_above_notch.end', {
                                        ok: notchOk,
                                        error: notchErr,
                                        after: blockName(freshOwnAbove),
                                        dir: [dx, dz],
                                        targetCell: { x: freshTarget.x, y: freshTarget.y, z: freshTarget.z },
                                    });
                                }
                                if (!(solid(freshStep) && open(freshFoot) && open(freshHead) && open(freshOwnHead) && open(freshOwnAbove))
                                    || stationStep(freshStep) || bad(freshStep) || bad(freshFoot) || bad(freshHead)) {
                                    motionLog('step_edge.skip', {
                                        reason: stationStep(freshStep) ? 'functional-station-before-press' : 'stale-or-invalid-before-press',
                                        dir: [dx, dz],
                                        targetCell: { x: freshTarget.x, y: freshTarget.y, z: freshTarget.z },
                                        step: blockName(freshStep),
                                        targetFoot: blockName(freshFoot),
                                        targetHead: blockName(freshHead),
                                        ownHead: blockName(freshOwnHead),
                                        ownAbove: blockName(freshOwnAbove),
                                    });
                                    return;
                                }
                                motionLog('step_edge.begin', {
                                    dir: [dx, dz],
                                    dirSource,
                                    candidateDirs: candidates,
                                    pathGoal: bot._lastPathGoalInfo || null,
                                    targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                                    step: blockName(frontFoot),
                                    targetFoot: blockName(frontHead),
                                    targetHead: blockName(frontAbove),
                                    ownHead: blockName(ownHead),
                                    ownAbove: blockName(ownAbove),
                                });
                                try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                                await centerOnCurrentCell();
                                let maxY = bot.entity.position.y;
                                const targetDistFrom = (q) => Math.hypot(q.x - (targetCell.x + 0.5), q.z - (targetCell.z + 0.5));
                                const roseEnoughAt = (q) => Math.floor(q.y) > cell.y || q.y > start.y + 0.72;
                                const settledInTarget = (q) => Math.floor(q.x) === targetCell.x && Math.floor(q.z) === targetCell.z && targetDistFrom(q) <= 0.9;
                                const stepSucceeded = (q) => roseEnoughAt(q) && settledInTarget(q);
                                for (let attempt = 0; attempt < 2; attempt++) {
                                    const c = bot.entity.position.floored();
                                    const tgt = c.offset(dx + 0.5, 1.15, dz + 0.5);
                                    await bot.lookAt(tgt, true);
                                    bot.setControlState('sprint', false);
                                    bot.setControlState('forward', true);
                                    bot.setControlState('jump', true);
                                    const t0 = Date.now();
                                    while (Date.now() - t0 < 820) {
                                        if (bot.entity.position.y > maxY) maxY = bot.entity.position.y;
                                        const cur = bot.entity.position;
                                        if (stepSucceeded(cur)) break;
                                        await new Promise(r => setTimeout(r, 40));
                                    }
                                    try { bot.clearControlStates(); } catch (e) {}
                                    await new Promise(r => setTimeout(r, 120));
                                    const cur = bot.entity.position;
                                    if (stepSucceeded(cur)) break;
                                }
                                let end = bot.entity.position.clone();
                                let ok = stepSucceeded(end);
                                if (!ok && roseEnoughAt(end) && !settledInTarget(end)) {
                                    motionLog('step_edge.edge_miss', {
                                        dir: [dx, dz],
                                        targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                                        at: { x: +end.x.toFixed(3), y: +end.y.toFixed(3), z: +end.z.toFixed(3) },
                                        floor: { x: Math.floor(end.x), y: Math.floor(end.y), z: Math.floor(end.z) },
                                        targetDist: +targetDistFrom(end).toFixed(3),
                                        recovery: 'center-press',
                                    });
                                    try {
                                        await bot.lookAt(targetCell.offset(0.5, 1.15, 0.5), true);
                                        bot.setControlState('sprint', false);
                                        bot.setControlState('jump', false);
                                        bot.setControlState('forward', true);
                                        await new Promise(r => setTimeout(r, 420));
                                    } finally {
                                        try { bot.clearControlStates(); } catch (e) {}
                                    }
                                    await new Promise(r => setTimeout(r, 120));
                                    end = bot.entity.position.clone();
                                    ok = stepSucceeded(end);
                                }
                                let notch = null;
                                if (!ok) {
                                    const c2 = bot.entity.position.floored();
                                    const t2 = c2.offset(dx, 0, dz);
                                    const step2 = bot.blockAt(t2);
                                    const below2 = bot.blockAt(t2.offset(0, -1, 0));
                                    const stonyStep = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/.test((step2 && step2.name) || '');
                                    const hasPick2 = () => bot.inventory.items().some(it => /_pickaxe$/.test(it.name || ''));
                                    const canNotch = step2 && step2.boundingBox === 'block'
                                        && below2 && below2.boundingBox === 'block'
                                        && !/bedrock|water|lava|fire|cactus|magma/.test(step2.name || '')
                                        && (!stonyStep || hasPick2());
                                    if (canNotch) {
                                        notch = {
                                            block: blockName(step2),
                                            below: blockName(below2),
                                            targetCell: { x: t2.x, y: t2.y, z: t2.z },
                                        };
                                        motionLog('step_edge.notch.begin', { dir: [dx, dz], ...notch });
                                        try {
                                            bot._bodyDigLockOwner = 'unstuck:step-edge-notch';
                                            bot._bodyDigLockUntil = Date.now() + 5000;
                                            try { bot.clearControlStates(); } catch (e) {}
                                            try { await bot.tool.equipForBlock(step2); } catch (e) {}
                                            try { await bot.lookAt(step2.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                                            await Promise.race([
                                                bot.dig(step2, true),
                                                new Promise((_, rej) => setTimeout(() => rej(new Error('notch-timeout')), 4500)),
                                            ]);
                                            await new Promise(r => setTimeout(r, 120));
                                            const afterStep = bot.blockAt(t2);
                                            notch.after = blockName(afterStep);
                                            if (!afterStep || afterStep.boundingBox !== 'block') {
                                                try { await bot.lookAt(t2.offset(0.5, 1.25, 0.5), true); } catch (e) {}
                                                bot.setControlState('sprint', false);
                                                bot.setControlState('jump', false);
                                                bot.setControlState('forward', true);
                                                await new Promise(r => setTimeout(r, 520));
                                                try { bot.clearControlStates(); } catch (e) {}
                                                await new Promise(r => setTimeout(r, 120));
                                                end = bot.entity.position.clone();
                                                ok = Math.hypot(end.x - (t2.x + 0.5), end.z - (t2.z + 0.5)) < 0.95
                                                    && end.y >= start.y - 0.35;
                                            }
                                            notch.ok = ok;
                                        } catch (e) {
                                            notch.error = e.message;
                                            try { bot.clearControlStates(); } catch (e2) {}
                                        } finally {
                                            if (bot._bodyDigLockOwner === 'unstuck:step-edge-notch') {
                                                bot._bodyDigLockOwner = null;
                                                bot._bodyDigLockUntil = 0;
                                            }
                                        }
                                        motionLog('step_edge.notch.end', {
                                            dir: [dx, dz],
                                            ...notch,
                                            end: { x: +end.x.toFixed(3), y: +end.y.toFixed(3), z: +end.z.toFixed(3) },
                                        });
                                    }
                                }
                                motionLog('step_edge.end', {
                                    ok,
                                    dir: [dx, dz],
                                    start: { x: +start.x.toFixed(3), y: +start.y.toFixed(3), z: +start.z.toFixed(3) },
                                    end: { x: +end.x.toFixed(3), y: +end.y.toFixed(3), z: +end.z.toFixed(3) },
                                    maxRise: +(maxY - start.y).toFixed(3),
                                    targetDist: +targetDistFrom(end).toFixed(3),
                                    settledInTarget: settledInTarget(end),
                                    notch,
                                });
                                try {
                                    fs.appendFileSync('bots/_supervisor/progress.txt',
                                        `[${new Date().toISOString()}] [step-edge] assist end ok=${ok} y=${start.y.toFixed(2)}→${end.y.toFixed(2)} dist=${targetDistFrom(end).toFixed(2)} settled=${settledInTarget(end)}${notch ? ' notch=' + (notch.ok ? 'ok' : 'fail') : ''}\n`);
                                } catch (e) {}
                            } catch (e) {
                                try { bot.clearControlStates(); } catch (e2) {}
                                motionLog('step_edge.end', { ok: false, error: e.message, dir: [dx, dz] });
                            } finally {
                                if (bot._bodyMoveLockOwner === 'unstuck:step-edge') {
                                    bot._bodyMoveLockOwner = null;
                                    bot._bodyMoveLockUntil = 0;
                                }
                            }
                        });
                    }
                    this.step_prev_location = p.clone();
                    this.step_prev_time = now;
                }
            } catch (e) {}
            const cur_dig_block = bot.targetDigBlock;
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance && cur_dig_block == this.prev_dig_block) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            const max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            if (this.stuck_time > max_stuck_time) {
                say(agent, 'I\'m stuck!');
                this.stuck_time = 0;
                execute(this, agent, async () => {
                    // With smart timeout (10s if stuck, 60s if moving), give it 65s total
                    const crashTimeout = setTimeout(() => { 
                        agent.cleanKill("Got stuck and couldn't get unstuck") 
                    }, 65000); // 65 seconds to allow pathfinding timeout to work
                    try {
                        await skills.moveAway(bot, 5);
                        clearTimeout(crashTimeout);
                        say(agent, 'I\'m free.');
                    } catch (err) {
                        clearTimeout(crashTimeout);
                        say(agent, `Failed to get unstuck: ${err.message}. May be trapped in water or impassable terrain.`);
                        // Don't crash immediately, let agent try to handle the situation
                    }
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
            this.step_prev_location = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: false, // off: conflicts with self_defense (caused flee/fight thrash and paralysis). Retreat is handled by self_preservation at low health.
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            // Balance survival vs. getting work done (like a player):
            // - normally only clear CLOSE threats (<=5) so we don't abandon mining/
            //   chopping to chase every distant mob (that paralysis stopped all
            //   resource gathering).
            // - if we were just hit (skeleton arrow / zombie), expand to 12 and
            //   fight back so ranged/sneaky attackers don't get free damage.
            // isClearPath intentionally removed so corner/behind-block mobs count.
            const bot = agent.bot;
            const recentlyHurt = Date.now() - bot.lastDamageTime < 2500;
            const range = recentlyHurt ? 12 : 5;
            // EXCLUDE creepers — meleeing one = it detonates = death ("Fighting creeper!"
            // was a suicidal conflict with self_preservation's back-off reflex). Creepers are
            // handled ONLY by self_pres (sprint to >9 blocks). self_defense never engages them.
            const enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity) && !/creeper/i.test(entity.name || ''), range);
            // Only STAND AND FIGHT when we can actually win: a weapon in hand and
            // health > 12. Otherwise self_preservation (checked first, higher
            // priority) flees. Never trade blows barehanded or while low — that
            // "fight to the death" is exactly what got the bot killed repeatedly.
            const hasWeapon = bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name));
            const hasShield = bot.inventory.items().some(i => i.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');
            const swarmed = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), 6) &&
                Object.values(bot.entities).filter(e => e && mc.isHostile(e) && e.position && e.position.distanceTo(bot.entity.position) < 8).length >= 3;
            // With a shield we can fight even at lower HP (block negates the hits); the
            // shieldFight skill closes on the enemy under guard then strikes — the real
            // counter to skeletons. Without a shield, only fight when healthy (>12).
            const minHp = hasShield ? 8 : 12;
            // ★EXCEPTION — point-blank ranged enemy: the hp gate is BACKWARDS for a
            // skeleton inside melee reach. Death #263 (blackbox): hp4, skeleton at
            // 1.6-4b in a dug shaft — self_defense refused (4<12), self_preservation
            // walled (useless point-blank), terrain blocked flight; the bot jittered
            // in a 1-block box for 20s and was shot dead WITH a sword in the bag.
            // Point-blank, melee IS the best (often only) move: bow draw has ~0.5s
            // windup and sword knockback interrupts the firing cycle, so a wooden
            // sword wins that duel at any hp. Same logic for any non-creeper hostile
            // already in our face: it's hitting us regardless — hit back.
            const pointBlank = enemy && enemy.position &&
                enemy.position.distanceTo(bot.entity.position) < 4.5;
            // ★C353 (T-0063): DISENGAGE the unreachable ranged trap. If we're boxed in a closed pocket
            // and the only threat is a wall-blocked skeleton/stray/pillager we can never melee, stop
            // whiffing at it — return so mobility's POCKET escape (idx 2948, otherwise starved by our
            // active=true break) and the kernel's GET_FOOD can take the wheel. Re-arms the instant a
            // melee/point-blank mob shows up or we break out of the pocket (rangedUnreachableTrap→false).
            if (rangedUnreachableTrap(bot)) {
                try {
                    if (!this._lastTrapLog || Date.now() - this._lastTrapLog > 8000) {
                        this._lastTrapLog = Date.now();
                        const p = bot.entity.position.floored();
                        fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [self_defense] DISENGAGE ranged-unreachable-trap mob=${bot._mobility ? bot._mobility.state : '-'} enclosed=${!!(bot._mobility && bot._mobility.enclosed)} pos=${p.x},${p.y},${p.z} — yield to escape/food\n`);
                    }
                } catch (e) {}
                return;
            }
            if (enemy && hasWeapon && !swarmed && (bot.health > minHp || pointBlank)) {
                say(agent, `Fighting ${enemy.name}!`);
                execute(this, agent, async () => {
                    if (hasShield) { try { await skills.customSkill(bot, 'shieldFight', range); } catch (e) { await skills.defendSelf(bot, range); } }
                    else await skills.defendSelf(bot, range);
                });
            }
        }
    },
    {
        name: 'threat_radar',
        description: 'See hostiles BEFORE they see us (24-block scan); flight-record every engagement.',
        interrupts: [],
        on: true,
        active: false,
        always: true,   // pure observer: must tick even while a sticky skill is executing
        last_tick: 0, known: {}, engaged: false, lastHp: 20, logSize: 0,
        update: async function (agent) {
            // ★威胁雷达+战斗黑匣子 (用户: ①索敌必须永远比怪先知道 ②怪一注意到就进详细
            // 日志模式,事后能还原图景). 24格扫描(超过怪16格仇恨半径=先手知情);任何敌对
            // 进入16格=交战,1Hz连拍快照进 combat_log.jsonl: 自身pos/hp/速度/手持/onGround
            // +全部敌对的名字/距离/坐标+受击事件 — 死因复盘从"遗体照片"升级为"全程录像"。
            const bot = agent.bot;
            const now = Date.now();
            if (now - this.last_tick < 1000) return;
            this.last_tick = now;
            // ★DEV CHEAT CHANNEL (validation): always-on (works under any sticky incl. kernelDriver) — chat
            // each /command line from cheat.txt, then clear it. Lets the supervisor force time/give/setblock
            // to fast-validate new behaviors in-game (validation-not-mock, just faster than natural cycles).
            try {
                const _cf = 'bots/_supervisor/cheat.txt';
                if (fs.existsSync(_cf)) {
                    const _cmds = fs.readFileSync(_cf, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
                    if (_cmds.length) {
                        try { fs.writeFileSync(_cf, ''); } catch (e) {}   // clear FIRST → never re-run a command
                        (async () => { for (const c of _cmds) { try { bot.chat(c); } catch (e) {} await new Promise(r => setTimeout(r, 150)); } })();
                    }
                }
            } catch (e) {}
            const HR = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|phantom|slime|enderman|pillager|vindicator|silverfish|cave_spider/i;
            let mobs = [];
            try {
                const me = bot.entity.position;
                mobs = Object.values(bot.entities)
                    .filter(e => e && e.position && e.name && HR.test(e.name) && e.position.distanceTo(me) < 24)
                    .map(e => ({ id: e.id, name: e.name, d: +e.position.distanceTo(me).toFixed(1), x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) }));
            } catch (e) { return; }
            // god's-eye feed: latest 24-block radar snapshot for the overseer process
            // (bots/_supervisor/overseer.mjs). Overwritten every 5s — cheap, and gives
            // the risk engine live mob positions even when nothing is engaged yet.
            if (!this.lastSnap || now - this.lastSnap > 5000) {
                this.lastSnap = now;
                try {
                    const p = bot.entity.position;
                    fs.writeFileSync('bots/_supervisor/radar.json', JSON.stringify({
                        ts: now, pos: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], mobs,
                    }));
                } catch (e) {}
            }
            const W = (rec) => {
                try {
                    if (this.logSize === 0) { try { this.logSize = fs.statSync('bots/_supervisor/combat_log.jsonl').size; } catch (e) { this.logSize = 1; } }
                    if (this.logSize > 20 * 1024 * 1024) { try { fs.renameSync('bots/_supervisor/combat_log.jsonl', 'bots/_supervisor/combat_log.jsonl.1'); } catch (e) {} this.logSize = 1; }
                    const line = JSON.stringify(rec) + '\n';
                    fs.appendFileSync('bots/_supervisor/combat_log.jsonl', line);
                    this.logSize += line.length;
                } catch (e) {}
            };
            // 雷达: 新接触即记录 (先手知情)
            for (const m of mobs) {
                if (!this.known[m.id]) {
                    this.known[m.id] = now;
                    W({ t: new Date().toISOString(), ev: 'radar_contact', mob: m.name, d: m.d, at: [m.x, m.y, m.z] });
                }
            }
            for (const k of Object.keys(this.known)) { if (!mobs.some(m => m.id == k)) delete this.known[k]; }
            // 交战判定: 16格内有敌对(怪的仇恨半径) 或 本tick掉血
            const near = mobs.filter(m => m.d <= 16);
            const hurt = bot.health < this.lastHp - 0.4;
            if (hurt) {
                W({ t: new Date().toISOString(), ev: 'HURT', dmg: +(this.lastHp - bot.health).toFixed(1), hp: +bot.health.toFixed(1), mobs });
            }
            this.lastHp = bot.health;
            if (near.length || hurt) {
                if (!this.engaged) { this.engaged = true; W({ t: new Date().toISOString(), ev: 'ENGAGE' }); }
                const me = bot.entity.position, v = bot.entity.velocity || {};
                W({
                    t: new Date().toISOString(), ev: 'tick',
                    pos: [+me.x.toFixed(1), +me.y.toFixed(1), +me.z.toFixed(1)],
                    hp: +bot.health.toFixed(1), food: bot.food,
                    held: (bot.heldItem && bot.heldItem.name) || 'empty',
                    ground: !!bot.entity.onGround,
                    vy: +(v.y || 0).toFixed(2),
                    act: (bot.modes && bot.modes.behavior_log ? '' : '') || (agent.actions && agent.actions.currentActionLabel) || '',
                    mobs,
                });
            } else if (this.engaged && mobs.every(m => m.d > 20)) {
                this.engaged = false;
                W({ t: new Date().toISOString(), ev: 'DISENGAGE', hp: +bot.health.toFixed(1) });
            }
        }
    },
    {
        name: 'reflex_watchdog',
        description: 'Force-release a wedged self_preservation execute (taking damage, standing still, reflex locked).',
        interrupts: [],
        on: true,
        active: false,
        always: true,   // pure supervisor: must tick even while everything else is wedged
        lastPos: null, lastMove: 0, lastHp: 20, hurtAt: 0, releasedAt: 0,
        update: async function (agent) {
            // ★Death #264 (blackbox): bot floated DEAD STILL at y61 surface water for 30+s
            // and drowned at full daylight, zero mobs — act showed self_preservation active
            // the whole time, yet the (fully capable) y>=55 swim-to-shore branch never ran.
            // Mechanism: an earlier execute() (pathfinder await that never resolves) leaves
            // the mode active=true forever, and the scheduler's !mode.active gate means NO
            // new emergency can ever be handled. This is the mirror image of the blackbox
            // scheduler trap: there a mode never STARTED, here one never ENDS.
            // Detector: taking damage + hasn't moved 0.5 blocks in 8s + self_preservation
            // active = the life-saving reflex itself is wedged. Release: interrupt flag +
            // clear controls + pathfinder.setGoal(null) (the actual key for a hung
            // goToPosition promise). If still wedged 20s later, force active=false so the
            // scheduler can re-enter the correct branch — a re-entry race beats dying still.
            const bot = agent.bot;
            const now = Date.now();
            try {
                const p = bot.entity.position;
                // ★C346 (T-0091): lastMove must measure HORIZONTAL displacement only. The old
                // 3D distanceTo>0.5 was DEFEATED by a SWIM piston-bob: a bot at a head-hole +
                // all-water topology jumps up into the hole and falls back, y oscillating 60↔62.7
                // (Δy≈2.7 > 0.5) every tick → lastMove reset EVERY frame → frozen(8s)/idleWedge(30s)/
                // waterThreat(6s) NEVER trip → 15min+ pin, two kicks couldn't break it (live
                // 2026-06-24 @51,62,2 mob=SWIM, "In water — getting out" ×∞). Vertical bob is NOT
                // progress; net horizontal motion is. (Legit vertical work — pillaring, a mining
                // shaft — isn't a stall: those advance the goal and don't sit healthy-still; this
                // gate only feeds the wedge detectors, so ignoring Δy can only ADD coverage, never
                // mis-flag real progress. The 0.5 threshold already tolerated normal jump/step Δy.)
                const dxz = this.lastPos ? Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z) : Infinity;
                if (!this.lastPos || dxz > 0.5) { this.lastPos = p.clone(); this.lastMove = now; }
                if (bot.health < this.lastHp - 0.4) this.hurtAt = now;
                this.lastHp = bot.health;
                // ★C287 SUFFOCATION SELF-RESCUE (always-on — T-0006: badlands bunkerDown digs DOWN
                // in sand → the unsupported red_sand column above the 1-wide shaft collapses onto the
                // head; death_log ×3 all coveredAbove+hostile0, hp 11→5.5→0 in 5s). The head-dig
                // reflex lives in self_preservation(1136)/mobility(ENTOMBED) — both NON-always-on, so
                // while bunkerDown's 5s night-dwell holds self_preservation ACTIVE, ModeController
                // (modes.js:61 `!mode.active` gate + `if active break`) SKIPS their update → the
                // reflex can't fire for ~5s → 2hp/s suffocation kills. This supervisor is always-on,
                // so it catches it in ~1 tick. Head solid (not water=drowning / lava=fire, handled
                // elsewhere) + just took damage + no melee mob in our face = suffocating → unstick the
                // execute holding the body (so it can't re-bury) and dig the head clear NOW (bounded,
                // so a hung dig can never wedge the supervisor itself).
                try {
                    const sp0 = bot.entity.position;
                    const headB = bot.blockAt(sp0.offset(0, 1, 0));
                    const solidHead = headB && headB.boundingBox === 'block' && !/water|lava/.test(headB.name || '');
                    const recentlyHurt = now - this.hurtAt < 2500;
                    const meleeAdj = Object.values(bot.entities || {}).some(e => e && e.position && mc.isHostile(e)
                        && !/skeleton|stray/i.test(e.name || '') && e.position.distanceTo(sp0) < 2.5);
                    if (solidHead && recentlyHurt && !meleeAdj && now - (this._suffocAt || 0) > 1500) {
                        this._suffocAt = now;
                        for (const mn of ['self_preservation', 'mobility']) { const m = modes_list.find(x => x.name === mn); if (m) m.active = false; }
                        try { bot.interrupt_code = true; } catch (e) {}
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [reflex_watchdog] ★SUFFOCATION self-rescue: head=${headB.name} hp=${Math.round(bot.health)} pos=${Math.floor(sp0.x)},${Math.floor(sp0.y)},${Math.floor(sp0.z)} — dig out NOW (always-on, bunker dwell can't gate this)\n`);
                        } catch (e) {}
                        try { await bot.tool.equipForBlock(headB); } catch (e) {}
                        try {
                            await Promise.race([
                                bot.dig(headB, true),
                                new Promise((_, rej) => setTimeout(() => rej(new Error('suffoc-dig-timeout')), 3000)),
                            ]);
                        } catch (e) { try { bot.stopDigging(); } catch (_) {} }
                        return;
                    }
                } catch (e) {}
                // ★PIN-BREAKER (layer-independent): pinned within ~10b for 15+ min means
                // SOME long loop (any layer — prepNether night-hold, chopWood, a skill
                // await) is holding control while making zero progress. Fire a forced
                // interrupt once a minute: every well-behaved loop honors interrupt_code
                // and returns, control flows back to missionNether's top-of-loop where
                // the BREAKOUT last-resort lives. (The mission-layer stagnation timer
                // could never fire while a child loop held the stack — same trap as the
                // chopWood deep-dig; an always-mode is the only layer that sees it all.)
                if (!this.pinAnchor || bot.entity.position.distanceTo(this.pinAnchor) > 10) {
                    // Moved out of the pin zone — the wedge/livelock broke. Clear the kick
                    // counter and persistent-pin escalation flags so the next pin gets a fresh
                    // window (and a fresh, un-backed-off cadence).
                    this.pinAnchor = bot.entity.position.clone(); this.pinAt = now; this.pinKick = 0; this.pinKickCount = 0;
                    try { bot._persistentPinKicks = 0; bot._persistentPinSince = 0; } catch (e) {}
                } else if (now - this.pinAt > 5 * 60 * 1000
                           // ★BACKOFF (livelock fix, C2xx): the kick used to fire every 60s
                           // forever. When the underlying pin can't be broken by a forced
                           // interrupt (food desert / no wood — C229/C233), re-kicking every
                           // minute is pure churn: cancel→bridge re-arms the SAME sticky in 8s→
                           // re-deadlock→kick again, stacking with reconnect storms. Grow the
                           // interval with each ineffective kick (1m→2m→4m→8m cap) so the reflex
                           // CONVERGES instead of spinning; once kicks prove useless we escalate
                           // to a signal (see the kick block below). The counter resets the
                           // instant the bot leaves the pin zone, so a kick that DOES work pays
                           // no backoff penalty next time.
                           && now - (this.pinKick || 0) > Math.min(60000 * Math.pow(2, this.pinKickCount || 0), 8 * 60 * 1000)) {
                    // ★BUNKER EXEMPTION (idle-wedge 同款,pin-breaker 漏了这层 — 实拍: 夜间
                    // 蹲坑驻留>5min 被判 pinned,每60s强拆一次,bot被踢到夜间地表乱跑,撞上
                    // enderman 拉响 risk83。正当夜蹲(夜间+头顶有盖)的"钉住"是庇护不是死锁。)
                    let nightBunker = false;
                    let coveredNow = false;
                    const tP = (bot.time && bot.time.timeOfDay) || 0;
                    for (let dyP = 1; dyP <= 6; dyP++) {
                        const bP = bot.blockAt(bot.entity.position.offset(0, dyP, 0));
                        if (bP && bP.boundingBox === 'block') { coveredNow = true; break; }
                    }
                    // ★C302 (T-0022): the geometric 6-block overhead probe MISSES sealed bunkers whose cap
                    // isn't directly within 6 blocks overhead (off-axis seal, or the probe lands in a
                    // transient pre-seal tick) → coveredNow=false → nightBunker=false → the pin-breaker
                    // KICKS the bot out of a legit night shelter (live: tod~19500 night, "dug-in bunker
                    // SEALED y=70", hp20/food20, yet kick #1 — the cancel-skill night hazard, occ=20). The
                    // mobility state-machine's `enclosed` is a more robust "surrounded" signal than the
                    // probe; an enclosed bot at night is sheltered (mobs can't reach) and the ENTOMBED
                    // reflex owns digging out — the pin-breaker kick wouldn't help anyway. Dawn flips tP
                    // out of range → kicking resumes if still stuck, so this stays bounded.
                    const enclosedReflex = !!(bot._mobility && bot._mobility.enclosed);
                    if (tP >= 12000 && tP <= 23500 && (coveredNow || enclosedReflex)) nightBunker = true;
                    let lowFoodShelter = false;
                    let famineHold = false;
                    let noRegenLowHpHold = false;
                    let bodyBudgetContainedHold = false;
                    let tableRecoveryHold = false;
                    let nightStandDownHold = false;
                    let killBoxLowFoodHold = false;
                    let closestHostile = Infinity;
                    let closestCreeper = Infinity;
                    try {
                        const normalEdible = bot.inventory.items().some(i => i && i.name && NORMAL_FOOD_RE.test(i.name));
                        const emergencyEdible = bot.inventory.items().some(i => i && i.name && /rotten_flesh|spider_eye/.test(i.name));
                        const edible = normalEdible || emergencyEdible;
                        for (const e of Object.values(bot.entities || {})) {
                            if (!(e && e.position && e.name && /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i.test(e.name))) continue;
                            const d = e.position.distanceTo(bot.entity.position);
                            if (d < closestHostile) closestHostile = d;
                            if (/creeper/i.test(e.name) && d < closestCreeper) closestCreeper = d;
                        }
                        const hostileNear = closestHostile < 12;
                        const pointBlankHostile = closestHostile < 4.25 || closestCreeper < 5.5;
                        lowFoodShelter = coveredNow && bot.food < 12 && !edible && !hostileNear;
                        const pNow = bot.entity.position;
                        const feetNow = bot.blockAt(pNow) || { name: 'air' };
                        const headNow = bot.blockAt(pNow.offset(0, 1, 0)) || { name: 'air' };
                        const fluidNow = /water|lava|fire/.test(feetNow.name || '') || /water|lava|fire/.test(headNow.name || '');
                        const fallingNow = !bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.25;
                        famineHold = bot.food <= 2 && bot.health <= 6 && !edible && !hostileNear && !fluidNow && !fallingNow;
                        const prepBackoff = (bot._prepLowHpNoFoodUntil && now < bot._prepLowHpNoFoodUntil)
                            || (bot._prepNoFoodSurfaceBackoffUntil && now < bot._prepNoFoodSurfaceBackoffUntil);
                        noRegenLowHpHold = bot.health < 14 && bot.food < 18 && !normalEdible
                            && !!prepBackoff && !hostileNear && !fluidNow && !fallingNow;
                        const enclosedNow = !!(bot._mobility && bot._mobility.enclosed);
                        const containedMob = !!(bot._mobility && /POCKET|MAROONED|ENTOMBED/.test(bot._mobility.state || ''));
                        bodyBudgetContainedHold = bot.health <= 8 && bot.food <= 6 && !normalEdible
                            && (coveredNow || enclosedNow || containedMob) && !pointBlankHostile && !fluidNow && !fallingNow;
                        let progressTail = '';
                        let progressFresh = false;
                        let progressAgeMs = Infinity;
                        try {
                            const progressFile = 'bots/_supervisor/progress.txt';
                            const stat = fs.statSync(progressFile);
                            progressAgeMs = now - stat.mtimeMs;
                            progressFresh = progressAgeMs < 90000;
                            const len = Math.min(8192, stat.size);
                            const fd = fs.openSync(progressFile, 'r');
                            try {
                                const buf = Buffer.alloc(len);
                                fs.readSync(fd, buf, 0, len, stat.size - len);
                                progressTail = buf.toString('utf8');
                            } finally {
                                fs.closeSync(fd);
                            }
                        } catch (e) {}
                        killBoxLowFoodHold = progressFresh
                            && /\[mission\] ★KILL-BOX gated: low-food pocket recovery/.test(progressTail)
                            && ((bot._currentSkill || '') === 'missionNether' || /==== missionNether START/.test(progressTail))
                            && bot.food <= 6
                            && !normalEdible
                            && (coveredNow || enclosedNow || containedMob)
                            && !pointBlankHostile
                            && !fluidNow
                            && !fallingNow;
                        if (bot.health >= 14 && bot.food >= 14 && !fluidNow && !fallingNow) {
                            const tableProgressHold = progressFresh && /TABLE (gate|recovery) for /.test(progressTail);
                            const progressSaysNoActionable = /TABLE gate for [^\n]*actionable12=0/.test(progressTail)
                                || /TABLE recovery for [^\n]*daylight safe window/.test(progressTail);
                            const missionOwnsProgress = /==== prepNether START|\[mission\] not kitted .*prepNether|TABLE (gate|recovery) for /.test(progressTail);
                            tableRecoveryHold = tableProgressHold
                                && ((bot._currentSkill || '') === 'missionNether' || missionOwnsProgress)
                                && (progressSaysNoActionable || closestHostile >= 16);
                        }
                        // ★C306 (T-0022): the FATAL gap behind death #106. A HEALTHY bot deliberately
                        // standing still at NIGHT (table-recovery, or can't-seal-no-cover-material, or a
                        // night stand-down) STOPS writing progress.txt — nothing happens while it waits for
                        // dawn — so after 90s every progressFresh-gated hold (tableRecoveryHold etc.) drops
                        // and the pin-breaker KICKS it out of its night hold → cancel missionNether → C292
                        // marooned road-out pillars it onto a ledge → fatal FALL (16:05 → death #106). At
                        // night a healthy, unthreatened, standing-still bot IS doing the right thing. Exempt
                        // with a LONGER staleness tolerance (idle holds don't log), hard-gated on healthy +
                        // no actionable hostile + not fluid/falling. Dawn flips tP out of the night window →
                        // kicking resumes if still pinned → bounded to at most one night.
                        const nightNow = tP >= 12000 && tP <= 23500;
                        const nightHoldSig = /night stand-down|★NIGHT 入夜|hole up|dug-in bunker|spawn-proof|TABLE (gate|recovery) for|bunker (already )?(covered|SEALED|veto|unsealed)/.test(progressTail);
                        const nightNoActionable = /actionable12=0|actionable=0|night stand-down/.test(progressTail) || closestHostile >= 12;
                        nightStandDownHold = nightNow && nightHoldSig && nightNoActionable
                            && progressAgeMs < 8 * 60000
                            && bot.health >= 14 && closestHostile >= 6
                            && !fluidNow && !fallingNow;
                    } catch (e) {}
                    const activeBodyWork = !!(bot.targetDigBlock || bot._mineMotionActiveDig || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil));
                    const activeEscapeWork = /surfaceUp|feedUp/.test(bot._currentSkill || '');
                    if ((nightBunker || lowFoodShelter || famineHold || noRegenLowHpHold || bodyBudgetContainedHold || tableRecoveryHold || nightStandDownHold || killBoxLowFoodHold) && !activeBodyWork && !activeEscapeWork) {
                        // Legit sheltering is deliberate immobility, not a stale stack.
                        // Reset the pin window so dawn/food recovery gets a fresh grace
                        // period instead of being kicked immediately by old shelter time.
                        if (killBoxLowFoodHold && now - (bot._lastPinKillBoxLowFoodExemptAt || 0) > 60000) {
                            bot._lastPinKillBoxLowFoodExemptAt = now;
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [reflex_watchdog] pinned kill-box low-food hold exempt: food=${bot.food} hp=${Math.round(bot.health || 0)} mob=${bot._mobility ? bot._mobility.state : '-'} enclosed=${!!(bot._mobility && bot._mobility.enclosed)} closestHostile=${Number.isFinite(closestHostile) ? closestHostile.toFixed(1) : 'none'} — no forced interrupt\n`);
                            } catch (e) {}
                        }
                        if (bodyBudgetContainedHold && now - (bot._lastPinBodyBudgetExemptAt || 0) > 60000) {
                            bot._lastPinBodyBudgetExemptAt = now;
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [reflex_watchdog] pinned body-budget contained hold exempt: food=${bot.food} hp=${Math.round(bot.health || 0)} mob=${bot._mobility ? bot._mobility.state : '-'} enclosed=${!!(bot._mobility && bot._mobility.enclosed)} covered=${coveredNow} — no forced interrupt\n`);
                            } catch (e) {}
                        }
                        if (tableRecoveryHold && now - (bot._lastPinTableRecoveryExemptAt || 0) > 60000) {
                            bot._lastPinTableRecoveryExemptAt = now;
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [reflex_watchdog] pinned table recovery hold exempt: food=${bot.food} hp=${Math.round(bot.health || 0)} mob=${bot._mobility ? bot._mobility.state : '-'} closestHostile=${Number.isFinite(closestHostile) ? closestHostile.toFixed(1) : 'none'} — no forced interrupt\n`);
                            } catch (e) {}
                        }
                        if (nightStandDownHold && now - (bot._lastPinNightStandDownExemptAt || 0) > 60000) {
                            bot._lastPinNightStandDownExemptAt = now;
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [reflex_watchdog] ★C306 pinned NIGHT stand-down hold exempt: hp=${Math.round(bot.health || 0)} food=${bot.food} tod=${tP} closestHostile=${Number.isFinite(closestHostile) ? closestHostile.toFixed(1) : 'none'} mob=${bot._mobility ? bot._mobility.state : '-'} — no forced interrupt (death#106 fix; dawn lifts)\n`);
                            } catch (e) {}
                        }
                        this.pinAnchor = bot.entity.position.clone();
                        this.pinAt = now;
                        this.pinKick = 0;
                        this.pinKickCount = 0;
                        try { bot._persistentPinKicks = 0; bot._persistentPinSince = 0; } catch (e) {}
                    }
                    if (!nightBunker && !lowFoodShelter && !famineHold && !noRegenLowHpHold && !bodyBudgetContainedHold && !tableRecoveryHold && !nightStandDownHold && !killBoxLowFoodHold && !activeBodyWork && !activeEscapeWork) {
                        this.pinKick = now;
                        this.pinKickCount = (this.pinKickCount || 0) + 1;
                        const kicks = this.pinKickCount;
                        if (kicks <= 3) {
                            // Early kicks: a forced interrupt often DOES break a merely-stuck
                            // loop (a hung await returns to missionNether's top-of-loop BREAKOUT).
                            // Give it a few tries — but already at the backed-off cadence above.
                            say(agent, `Pinned 15min+ — kicking the stack (forced interrupt, kick #${kicks}).`);
                        } else {
                            // ★ESCALATE (livelock fix): the kick has fired 4+ times and the bot is
                            // STILL pinned in the same 10-block box — the interrupt is NOT breaking
                            // this. Repeating it forever is exactly the per-minute livelock the user
                            // reported. Stop the chatty per-kick narration; raise ONE loud
                            // persistent-pin signal a higher layer (overseer / supervisor) can act on
                            // — the real fix for an unbreakable pin is a RELOCATING recovery venture
                            // (forageExplore / escapePlan) that walks the bot out of the box, which
                            // the reflex layer doesn't dispatch itself. Meanwhile the interrupt keeps
                            // firing only at the 8-min backed-off cadence, so the reflex stops
                            // churning cancel→re-arm against the bridge's sticky loop.
                            bot._persistentPinKicks = kicks;
                            if (!bot._persistentPinSince) bot._persistentPinSince = this.pinAt;
                            const pinMin = Math.round((now - this.pinAt) / 60000);
                            say(agent, `PERSISTENT PIN — ${kicks} kicks ineffective over ${pinMin}min; the forced interrupt can't break this (needs a relocating recovery venture).`);
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [reflex_watchdog] ★PERSISTENT PIN — ${kicks} kicks ineffective, pinned ${pinMin}min hp=${Math.round(bot.health || 0)} food=${bot.food} skill=${bot._currentSkill || '-'} mob=${bot._mobility ? bot._mobility.state : '-'} — kick alone won't break it; escalate: dispatch a relocating recovery (forageExplore/escapePlan)\n`);
                            } catch (e) {}
                        }
                        try { bot.interrupt_code = true; } catch (e) {}
                        try { bot._chopGen = (bot._chopGen || 0) + 1; } catch (e) {}
                        try { bot._supervisorCancelAt = Date.now(); } catch (e) {}
                        try { bot.pathfinder.setGoal(null); } catch (e) {}
                        try { bot.clearControlStates(); } catch (e) {}
                        // ★C285 MARCH WEDGE BREAKER (取证 2026-06-20: bot 冻在 MAROONED 25min+,
                        // act_trace ctrl/dig 全空,mission 永远 "standing down: march owns body").
                        // 机理: 身体冻结但 mob 状态卡在 MAROONED/ENTOMBED/POCKET——要么 mobility
                        // execute 卡 await 把 mode.active latch 住(ModeController 就跳过它的 update),
                        // 要么 st 因 sticky(refreshing noPath)反复锁住而 march 零位移. 上面的 kick 只
                        // 置 interrupt_code 取消 SKILL,这个 wedged 的 MODE 状态它碰不到 → 身体继续冻.
                        // reflex_watchdog 是 always-on(ModeController:54 确认 active 时仍每拍跑),且
                        // this.pinAt 是与 mobility 状态无关的"位置冻结>10b 计时"(working march 一直在动
                        // → pinAt 不断重置 → 不会误伤). 所以在这里(已确认真冻 5min+ 且非任何 legit hold)
                        // 强制 unstick: 解 mobility mode 的 active latch + mob 态 →FREE + 清 march 字段,
                        // 让下一拍 mobility 从头重算. 这是任意成因 wedge 的通用兜底(25min 进程重启之前).
                        try {
                            if (bot._mobility && /MAROONED|ENTOMBED|POCKET/.test(bot._mobility.state || '')) {
                                const mobMode = modes_list.find(m => m.name === 'mobility');
                                if (mobMode) {
                                    mobMode.active = false;                 // unstick a latched execute
                                    mobMode.maroonedAt = 0; mobMode.noPathTimes = [];
                                    mobMode.lastState = 'FREE';
                                    try { mobMode.regAnchor = bot.entity.position.clone(); mobMode.regAt = now; } catch (e) {}
                                }
                                bot._mobility = { ...bot._mobility, state: 'FREE' };
                                bot._marchDir = null; bot._marchFails = 0; bot._maroonedMarchOrigin = null;
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [reflex_watchdog] ★MARCH WEDGE BREAKER: pinned ${Math.round((now - this.pinAt) / 60000)}min in contained state — force mob→FREE + unstick mobility mode (kick alone leaves the march wedged)\n`);
                            }
                        } catch (e) {}
                    }
                }
                const sp = modes_list.find(m => m.name === 'self_preservation');
                if (!sp || !sp.active) { this.releasedAt = 0; return; }
                const beingHurt = now - this.hurtAt < 2500;
                const frozen = now - this.lastMove > 8000;
                // ★IN-WATER variant (death #268): floating dead-still while two drowned
                // closed from 4.5b to 2.1b — hp wasn't actively dropping, so the
                // being-hurt gate never opened, and the final hit was lethal. In water
                // there is NO legitimate stand-still-while-locked state (bunkering is
                // impossible in water), so a closing hostile + frozen reflex = wedged.
                let waterThreat = false;
                try {
                    const WS = ['water', 'flowing_water'];
                    const inWater = WS.includes((bot.blockAt(p) || {}).name) || WS.includes((bot.blockAt(p.offset(0, 1, 0)) || {}).name);
                    if (inWater && now - this.lastMove > 6000) {
                        const HRW = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
                        waterThreat = Object.values(bot.entities).some(e =>
                            e && e.position && e.name && HRW.test(e.name) && e.position.distanceTo(p) < 8);
                    }
                } catch (e) {}
                // ★IDLE-WEDGE variant (3rd form, caught live by act_trace: act=
                // self_preservation pinned for minutes with ZERO keys pressed and zero
                // movement — an execute hanging on an await with no control output,
                // while no damage and no water meant neither earlier detector fired).
                // sp active + 30s still + every control key off = wedged, period.
                let idleWedge = false;
                try {
                    if (now - this.lastMove > 30000) {
                        const cs = bot.controlState || {};
                        // no keys at all = wedged; ALSO jump-only with zero displacement
                        // (the lake-float form: swim branch holds jump to stay afloat
                        // while its shore-swim execute hangs — real swimming always has
                        // forward; bobbing in place for 30s+ is never legitimate)
                        const horiz = ['forward', 'back', 'left', 'right', 'sprint'].some(k => cs[k]);
                        idleWedge = !horiz;   // with or without jump — 30s still + no horizontal intent = wedged
                        // ★BUNKER EXEMPTION (the watchdog-vs-bunker death spiral, 300ms
                        // "securing ↔ releasing" pairs flooding agent.err: a NIGHT bunker
                        // wait IS still + keyless + sp-active — that's what sheltering
                        // looks like. Releasing it re-fires bunkerDown, which gets
                        // released again: an interrupt storm that froze EVERYTHING,
                        // act_trace included. Covered overhead at night = legitimate.)
                        if (idleWedge) {
                            const t = (bot.time && bot.time.timeOfDay) || 0;
                            if (t >= 12000 && t <= 23500) {
                                for (let dyB = 1; dyB <= 6; dyB++) {
                                    const bB = bot.blockAt(bot.entity.position.offset(0, dyB, 0));
                                    if (bB && bB.boundingBox === 'block') { idleWedge = false; break; }
                                }
                            }
                        }
                    }
                } catch (e) {}
                if (!(beingHurt && frozen) && !waterThreat && !idleWedge) return;
                if (!this.releasedAt) {
                    this.releasedAt = now;
                    say(agent, 'Reflex wedged while taking damage — force releasing!');
                    try { bot.interrupt_code = true; } catch (e) {}
                    try { bot.clearControlStates(); } catch (e) {}
                    try { bot.pathfinder.setGoal(null); } catch (e) {}
                    // ★C311-A (T-0049): a WATER wedge force-released here only CLEARED controls — she
                    // then floated PASSIVE in deep water and kept drowning (deaths #112/#114/#115 are all
                    // "drowning" paired with this exact "Reflex wedged" line). Clearing ≠ escaping. When
                    // the wedge is in water, actively SWIM UP: hold jump + look up until she surfaces
                    // (bounded ~4s, then release jump) so she reaches air instead of drowning where freed.
                    try {
                        const _wsN = (q) => ['water', 'flowing_water'].includes((bot.blockAt(q) || {}).name);
                        if (_wsN(p) || _wsN(p.offset(0, 1, 0))) {
                            (async () => {
                                try {
                                    bot.setControlState('jump', true);
                                    try { await bot.look(bot.entity.yaw, -1.4, false); } catch (e) {}
                                    const _t0 = Date.now();
                                    while (Date.now() - _t0 < 4000) {
                                        const _pp = bot.entity.position.floored();
                                        if (!_wsN(_pp) && !_wsN(_pp.offset(0, 1, 0))) break;
                                        await new Promise(r => setTimeout(r, 120));
                                    }
                                } finally { try { bot.setControlState('jump', false); } catch (e) {} }
                            })();
                        }
                    } catch (e) {}
                } else if (now - this.releasedAt > 20000) {
                    this.releasedAt = 0;
                    say(agent, 'Reflex still wedged — hard reset.');
                    try { bot.pathfinder.setGoal(null); } catch (e) {}
                    try { bot.clearControlStates(); } catch (e) {}
                    sp.active = false;
                }
            } catch (e) {}
        }
    },
    {
        name: 'mobility',
        description: 'Continuous god-view modeling of the bot\'s freedom of movement; instant dig-out when entombed.',
        interrupts: ['all'],
        on: true,
        active: false,
        lastEval: 0, lastState: '', stateSince: 0,
        update: async function (agent) {
            // ★机动性状态机 (用户: "bot应该通过上帝视角时刻对周围环境程序化建模,维护
            // 一个状态机" — 活埋事故的机理: 身体两格是空气(窒息反射不触发)但四面+顶
            // 全实心(一切移动失败),这个状态在bot的认知里根本不存在,于是它"转身但出
            // 不去"几小时。blockAt 就是零成本上帝视角 — 每2秒分类:
            //   FREE     有≥1个可走出口(2高空间+4内落脚)     → 正常
            //   POCKET   无水平出口但头顶开(可垫/可跳)        → 60s未变则垫/挖上
            //   ENTOMBED 出口零且头顶实心(活埋)               → 立即挖,不等任何计时
            //   SWIM     在水里                                → 交给游泳本能
            // 状态写 bot._mobility(vitals广播给监工),变化记 progress。)
            const bot = agent.bot;
            const now = Date.now();
            if (now - this.lastEval < 2000) return;
            this.lastEval = now;
            // ★MAROONED detection inputs (用户: "FREE只管了最小的——寻路找不到路径持续
            // 原地打转怎么判?" 答案=bot自己已有的两个信号流的交集):
            //   ① pathfinder 失败流: path_update 事件里 noPath/timeout 的滚动计数
            //   ② 净位移锚: 离锚>20格才重锚 — 微观晃动骗不过(watchdog v2 同款搬进bot)
            // FREE(局部能动) + 锚定>8min(宏观没动) + 10min内寻路失败≥4 = MAROONED
            if (!this._pathHooked) {
                this._pathHooked = true;
                this.noPathTimes = [];
                try {
                    bot.on('path_update', (r) => {
                        try { if (r && (r.status === 'noPath' || r.status === 'timeout')) { this.noPathTimes.push(Date.now()); if (this.noPathTimes.length > 50) this.noPathTimes.shift(); } } catch (e) {}
                    });
                } catch (e) {}
            }
            let st;
            try {
                const m = bot.entity.position.floored();
                const solid = (b) => b && b.boundingBox === 'block';
                const exits = [];
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    if (solid(bot.blockAt(m.offset(dx, 0, dz))) || solid(bot.blockAt(m.offset(dx, 1, dz)))) continue;
                    let floor = false;
                    for (let dd = 1; dd <= 4; dd++) { const fb = bot.blockAt(m.offset(dx, -dd, dz)); if (solid(fb) || /water/.test((fb && fb.name) || '')) { floor = true; break; } }
                    if (floor) exits.push([dx, dz]);
                }
                const upOpen = !solid(bot.blockAt(m.offset(0, 2, 0)));
                const inWater = /water/.test((bot.blockAt(m) || {}).name || '') || /water/.test((bot.blockAt(m.offset(0, 1, 0)) || {}).name || '');
                // ★C231: sky-visibility probe (3x3 cols up 36) — authoritative "truly covered above"
                // signal. Computed BEFORE state so an OPEN-SKY ledge/pillar (no walkable exits because
                // neighbors are drops, but sky visible) is NOT mislabeled POCKET. Live bug: bot at open
                // y94 surface → exits=0 + upOpen → POCKET → bogus pillar/dig-up reflex + enclosed→surfaceUp
                // competing with the famine VENTURE → stuck. POCKET now requires upOpen AND enc(covered);
                // upOpen but sky-visible ⇒ FREE (exposed ledge, can travel). !upOpen ⇒ ENTOMBED (unchanged).
                let enc = true;
                try {
                    const mP = bot.entity.position.floored();
                    outer:
                    for (const ddx of [-4, 0, 4]) {
                        for (const ddz of [-4, 0, 4]) {
                            let covered = false;
                            for (let dy = 2; dy <= 36; dy++) {
                                const cb = bot.blockAt(mP.offset(ddx, dy, ddz));
                                if (cb && cb.boundingBox === 'block') { covered = true; break; }
                            }
                            if (!covered) { enc = false; break outer; }
                        }
                    }
                } catch (e) { enc = false; }
                st = inWater ? 'SWIM' : (exits.length ? 'FREE' : ((upOpen && enc) ? 'POCKET' : (upOpen ? 'FREE' : 'ENTOMBED')));
                // ★C346 (T-0091): SWIM_STUCK sub-state. Plain SWIM hands the body to the swim
                // instinct (self_preservation in-water branch) and walks away. But the
                // "head-hole + all-water" topology (only exit is one air cell straight up, all
                // four horizontal neighbors water, no shore within R=20, EMPTY inventory so the
                // instinct's pillar gate `&& f` is false) leaves the instinct piston-bobbing
                // forever — it only swims horizontally + rotates yaw, never climbs the vertical
                // hole. Model it: if we've been SWIM with <1b net HORIZONTAL displacement for
                // ≥12s, escalate to SWIM_STUCK so a dedicated vertical-escape reflex (below) owns
                // it instead of the topology-blind instinct. (Anchor on horizontal only — the
                // y-bob is exactly the false motion the old 3D anchor was fooled by.)
                if (st === 'SWIM') {
                    const sp2 = bot.entity.position;
                    // ★SUBMERGED-TRAP (T-0096 续 / 溺死实锤 06-25T11:29 @235,51: 自己挖矿钻进一个被
                    // 实心石从上方封死的灌水水袋(enc=true 全程),困 y49-56 上下 bob 13min 后溺死).
                    // 机理: `inWater` 在上面的 st 三元里短路掉了 ENTOMBED——水袋本质是"灌了水的活埋",
                    // 唯一出路是像 ENTOMBED 一样朝干侧挖穿石头,但它被判成 SWIM 交给"游泳找岸"反射:
                    // findShore 在封顶水袋里返回 null、pillar 柱上撞石头天花板、vertical-exit 要头顶
                    // air(这里是石)、SWIM_STUCK 升级又被水平晃动(徒劳找岸 >1b/拍)反复清零 anchor →
                    // 全失效空转到淹死。修: enc(3x3 列上探 36 格全实心=水与天空隔离=封顶水牢) 时,
                    // 水平晃动不再清零,困 ≥12s 直接升 ENTOMBED,复用其 AQUIFER-AWARE 轮转 dig-out
                    // (避 floody 朝向、挖穿干侧、向上兜底"air is above water")——那段正是为含水层写的。
                    // 边界: 开放湖/河/海 enc=false 走原 SWIM/SWIM_STUCK 不变; 头顶有竖井时 (0,0) 列
                    // 见天 → enc=false → 自动让位 SWIM_STUCK 爬竖井; 受控深潜瞬时穿水踩不到 12s 门。
                    if (enc) {
                        if (!this._submTrapAt) this._submTrapAt = now;
                        else if (now - this._submTrapAt > 12000) st = 'ENTOMBED';
                        // keep horizontal anchor fresh so surfacing into open water doesn't instantly SWIM_STUCK
                        this._swimAnchor = sp2.clone(); this._swimAnchorAt = now;
                    } else {
                        this._submTrapAt = 0;
                        if (!this._swimAnchor || Math.hypot(sp2.x - this._swimAnchor.x, sp2.z - this._swimAnchor.z) > 1.0) {
                            this._swimAnchor = sp2.clone(); this._swimAnchorAt = now;   // made real horizontal headway → reset
                        } else if (now - (this._swimAnchorAt || now) > 12000) {
                            st = 'SWIM_STUCK';
                        }
                    }
                } else { this._swimAnchor = null; this._swimAnchorAt = 0; this._submTrapAt = 0; }
                // ★C341 (T-0074): SEALED-ROOM override. Locally FREE/POCKET (interior air to move in) but
                // covered above (enc) — the ONLY situation that can be a walled-in room. Flood-fill the
                // reachable air; if fully bounded (no exit, no chimney to sky), it's a sealed room → escalate
                // to SEALED so the dig-out reflex below mines through the nearest wall. Structural + immediate
                // (unlike MAROONED's 90s timer) — a sealed bot must dig NOW, not wait. Runs only here (FREE/
                // POCKET + enc) so it's free in the open. Takes precedence over the FREE→MAROONED escalation.
                // FREE only (NOT POCKET): a sealed ROOM has interior air → horizontal exits → FREE; a
                // POCKET (no horizontal exits, upOpen) has its own pillar/dig-up reflex, leave it alone.
                // ★DAYLIGHT-ONLY (live regression 12:10 @tod15206: dug OUT of the night bunker into the
                // dark → hp20→4→dead). At NIGHT a small enclosed space IS the shelter (C336 bunker seals
                // ON PURPOSE) — unsealing it = exposure death, the exact opposite of survival. SEALED escape
                // directly opposes the night-bunker, so gate it to DAYLIGHT: by day a seal is a trap to break
                // out of; a genuine night trap simply waits till dawn (matches the ticket's "next-day chew-out").
                const _todMob = (() => { try { return bot.time.timeOfDay; } catch (e) { return 0; } })();
                const _isNightMob = _todMob >= 13000 && _todMob <= 23000;
                if (st === 'FREE' && enc && !inWater && !_isNightMob) {
                    let _sr = false;
                    try { _sr = detectSealedRoom(bot).sealed; } catch (e) {}
                    // ★STUCK-DEBOUNCE (C341 daytime FP fix): a MINING bot is constantly in transiently-bounded
                    // pockets (dig a chamber → flood momentarily <CAP → "sealed") and advances through them; the
                    // raw check fired SEALED↔FREE every 10-30s underground (live 12:36-42, 7×), making it dig
                    // toward the anchor instead of mining = wander/churn. A REAL trap (the ticket's walled-in
                    // room) is PERSISTENT + the bot can't move. So only escalate when the sealed condition has
                    // held ~10s AND the bot barely moved (<3b) — mining moves on, a trap doesn't. (Distinct from
                    // MAROONED's 90s: a true seal must still be escaped fast, just not flapped on every pocket.)
                    const _pp = bot.entity.position;
                    if (!_sr) { this._sealedSince = 0; this._sealedAnchor = null; }
                    else if (!this._sealedSince || (this._sealedAnchor && _pp.distanceTo(this._sealedAnchor) > 3)) {
                        this._sealedSince = now; this._sealedAnchor = _pp.clone();   // newly sealed / moved (mining) → (re)start timer
                    } else if (now - this._sealedSince > 10000) {
                        st = 'SEALED';                                               // bounded + stuck ≥10s = genuine trap
                    }
                }
                // regional entrapment check (only escalates FREE — the others have own reflexes)
                const p = bot.entity.position;
                if (!this.regAnchor || p.distanceTo(this.regAnchor) > 20) { this.regAnchor = p.clone(); this.regAt = now; }
                if (st === 'FREE') {
                    // ★CLIMBING heartbeat (凿崖让步: chopWood dig-staircase 是垂直工程,水平
                    // 位移小,正好踩 MAROONED 判定(90s没挪20格)——行军插队把凿崖斩在半路,
                    // FREE窗口(~2min)<凿崖启动(3-4min)=结构性饿死。爬山=有目的工程不是被困:
                    // 心跳2分钟内 → 重置锚,不判。)
                    if (bot._climbingAt && now - bot._climbingAt < 120000) { this.regAnchor = bot.entity.position.clone(); this.regAt = now; }
                    // ★夜间封顶让位 (worker-death 06-26 反射互绞修): prepNether 建夜庇护时 set bot._nightSealingUntil.
                    // mobility MAROONED 会把"站着封顶"误判为"被困"抢身体挖路,中断 prepNether 的 digDown(实锤: 25次
                    // 封顶失败 dugOk=false + 同刻 [mobility] MAROONED dig-timeout = 反射互绞,夜死最大头真根因,非
                    // "无参考面"表象). 封顶活跃(信号 12s 新鲜)时重置锚不升 MAROONED,让封顶独占身体(类比上面 climbing
                    // heartbeat). 仅 FREE(有出口=非困死)让位; 真困走 ENTOMBED/SEALED(st!='FREE',根本不进此分支)
                    // 不受影响; 信号 12s 过期+夜间双门,封顶 skill 不活跃/天亮即恢复正常脱困。
                    if (_isNightMob && bot._nightSealingUntil && now < bot._nightSealingUntil) { this.regAnchor = bot.entity.position.clone(); this.regAt = now; }
                    // speedrun-grade thresholds (用户: "8分钟你要上天吧" — 正确。代价分析:
                    // 误判 MAROONED 无害(行军=朝锚挖几格路,顺路),漏判昂贵(原地空转分钟级)
                    // → 阈值激进: 90秒没挪出20格 + 3分钟内寻路失败≥3 = 困,开挖。人类试三
                    // 个方向走不通也就这个耗时。)
                    const noPathRecent = (this.noPathTimes || []).filter(t => now - t < 180000).length;
                    if (now - this.regAt > 90 * 1000 && noPathRecent >= 3) st = 'MAROONED';
                    // ★STICKY MAROONED (打转机理之一: 行军挖出20格→重锚FREE→寻路依然全堵
                    // →90s后再判MAROONED→方向已被清,重选可能反向→挖回去 = FREE↔MAROONED
                    // 振荡。修: 退出不光看位移,还要寻路真恢复;且最短驻留3分钟——因为移动
                    // 独占门拦掉任务层寻路后 noPath 信号断流,纯信号判定会被自己饿死。)
                    else if (this.lastState === 'MAROONED'
                        && ((this.noPathTimes || []).some(t => now - t < 120000)
                            || now - (this.maroonedAt || 0) < 180000)) st = 'MAROONED';
                    if (st === 'MAROONED' && this.lastState !== 'MAROONED') {
                        this.maroonedAt = now;
                        try { bot._maroonedMarchOrigin = p.clone(); } catch (e) {}
                    }
                }
                // ★C285: the MARCH WEDGE BREAKER was MOVED to reflex_watchdog (always-on) — see
                // its pin-kick block. Putting it here (in the mobility mode's own update) was
                // unreliable: ModeController breaks the mode loop when ANY mode is active, and a
                // wedged mobility execute would skip its own update entirely, so a breaker living
                // here can't fire exactly when it's needed. reflex_watchdog ticks every frame
                // regardless and owns position-freeze detection (pinAt) immune to st flicker.
                if (st !== this.lastState) {
                    this.lastState = st; this.stateSince = now;
                    // ★C347 (T-0096): UNSTICK-EVENT LEDGER. Every fresh entry into an entrapment state
                    // (ENTOMBED/SEALED/MAROONED/SWIM_STUCK/POCKET) stamps a timestamp. The migration
                    // decision below reads this ledger: high-frequency thrashing that persists for
                    // minutes — while net mining progress is ~0 — is the "treading-water in bad local
                    // terrain" the biome-only migrate.recommend can't see (savanna passes badBiome).
                    if (/ENTOMBED|SEALED|MAROONED|SWIM_STUCK|POCKET/.test(st)) {
                        bot._stuckEvents = (bot._stuckEvents || []).filter(t => now - t < 600000);   // 10min rolling window
                        bot._stuckEvents.push(now);
                        if (bot._stuckEvents.length > 200) bot._stuckEvents.shift();
                    }
                    if (st !== 'MAROONED') { bot._marchDir = null; bot._marchFails = 0; bot._maroonedMarchOrigin = null; }   // fresh heading next entrapment
                    // ★C347 (T-0096): clear the rotating dig-out bearing state when leaving ENTOMBED/SEALED so
                    // a fresh entrapment starts from the anchor bearing (not a stale wet-wall pointer).
                    if (st !== 'ENTOMBED') { bot._entombDir = null; bot._entombAnchor = null; bot._entombDirIdx = 0; bot._entombStuckBursts = 0; }
                    if (st !== 'SEALED') { bot._sealedAnchorPos = null; bot._sealedDirIdx = 0; bot._sealedStuckBursts = 0; }
                    try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [mobility] → ${st}${exits.length ? ' exits=' + JSON.stringify(exits) : ''}\n`); } catch (e) {}
                }
                // ★ENCLOSED 正交属性 (用户: "全知视角判断自己是否处在封闭地穴(与地面联通
                // 很远)——是的话夜里就不需要停下来"。夜门们用 tod+y≥50 当"夜间暴露"的代理
                // 变量是错的: 崖体隧道里的 bot 是封闭环境,夜晚白天没区别,却被停工/蹲坑/
                // 驻留。判定: 3x3采样网格(间隔4格,覆盖±4格),每列向上探35格,全部有实心
                // = 与开放天空隔离(开口至少在远处/高处)。进入需连续2次评定(防单格屋檐误
                // 判),退出即时(怀疑暴露就按暴露处理,保守方向不对称)。每2s一评,~315次
                // blockAt,毫秒级。消费方: sp蹲坑/prepNether夜hold/chopWood NIGHT-BAIL。)
                // enc computed above (moved before state determination for the C231 POCKET sky-check)
                this._encStreak = enc ? (this._encStreak || 0) + 1 : 0;
                const enclosed = this._encStreak >= 2;
                if (enclosed !== this._lastEnc) {
                    this._lastEnc = enclosed;
                    try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [mobility] enclosed → ${enclosed}\n`); } catch (e) {}
                }
                bot._mobility = { state: st, since: this.stateSince, exits, enclosed };
            } catch (e) { return; }
            if (famineBodyFreeze(agent, 'mobility')) return;
            // ★C294: terracotta + sandstone are PICK-REQUIRED (badlands/mesa terrain) but were absent
            // here, so canMarchDig() read them as bare-handable → a pickless MAROONED bot endlessly
            // bare-handed terracotta@y60 ("Digging aborted" ×∞, never escaping) instead of turning to
            // dig the HAND-DIGGABLE red_sand all around it (live 2026-06-20: sealed in a terracotta
            // pocket with 283 red_sand it never touched; deaths 53→79 night death-loop). Treating them
            // as stony makes the march TURN AWAY from terracotta toward an escapable (red_sand/open)
            // bearing — the precise fix for the badlands-pocket no-pick seal.
            const STONY_MOBILITY = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble|terracotta|sandstone/;
            const hasPick = () => bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
            const normalEdibleHeld = () => {
                try { return bot.inventory.items().some(i => i && i.name && NORMAL_FOOD_RE.test(i.name)); }
                catch (e) { return false; }
            };
            const noRegenSafeAirHold = () => {
                const nowHold = Date.now();
                if (!(bot.health < 14 && bot.food < 18) || normalEdibleHeld()) return null;
                // ★C225: yield to an explicitly-dispatched recovery VENTURE (forageExplore/escapePlan
                // travelling to food). The skill-name allowlist (survivalSkill below) can't see it —
                // nested customSkill leaves bot._currentSkill = the sticky ('missionNether'), so the
                // hold froze the body and the dispatched forage couldn't move (live: hp9 food17 POCKET,
                // deadlock-breaker fired forageExplore but this hold pinned it → permanent no-regen
                // freeze). The dispatcher sets _recoveryVentureUntil; while fresh, the venture owns
                // movement (it carries its own night/hostile/hp-abort gates — proper exit, not a hole).
                if (nowHold < (bot._recoveryVentureUntil || 0)) return null;
                const prepLow = Math.max(0, (bot._prepLowHpNoFoodUntil || 0) - nowHold);
                const prepSurface = Math.max(0, (bot._prepNoFoodSurfaceBackoffUntil || 0) - nowHold);
                const isNight = (() => { try { const t = bot.time && bot.time.timeOfDay; return t >= 12000 && t <= 23500; } catch (e) { return false; } })();
                const skill = bot._currentSkill || '';
                const survivalSkill = /prepNether|feedUp|consume|auto_eat/i.test(skill);
                const bodyBudgetHold = bot.health <= 8 && bot.food <= 6;
                if (!bodyBudgetHold && !prepLow && !prepSurface && !isNight && !survivalSkill) return null;
                const p = bot.entity.position;
                const feet = bot.blockAt(p) || { name: 'air' };
                const head = bot.blockAt(p.offset(0, 1, 0)) || { name: 'air' };
                if (feet.boundingBox === 'block' || head.boundingBox === 'block') return null;
                if (/water|lava|fire/.test(feet.name || '') || /water|lava|fire/.test(head.name || '')) return null;
                if (!bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.25) return null;
                const hostile = Object.values(bot.entities || {}).some(e =>
                    e && e !== bot.entity && e.position && mc.isHostile(e) &&
                    e.position.distanceTo(p) < (/creeper/i.test(e.name || '') ? 5.5 : 4.25));
                if (hostile) return null;
                return { prepLow, prepSurface, isNight, skill, bodyBudgetHold, pos: p };
            };
            const heldIsPick = () => !!(bot.heldItem && /_pickaxe$/.test(bot.heldItem.name));
            const plannedNoPickStone = () => Date.now() < (bot._mobilityPlannedNoPickStoneUntil || 0);
            const invCounts = () => {
                try {
                    const out = {};
                    for (const it of bot.inventory.items()) out[it.name] = (out[it.name] || 0) + it.count;
                    return out;
                } catch (e) { return {}; }
            };
            const reachableCraftingTable = () => {
                try {
                    const c = invCounts();
                    if ((c.crafting_table || 0) > 0) return true;
                    const near = world.getNearestBlock(bot, 'crafting_table', 4);
                    return !!(near && bot.entity.position.distanceTo(near.position) <= 4.5);
                } catch (e) {
                    return false;
                }
            };
            const hasTableMaterials = (c) => Object.keys(c || {}).some(n => /_planks$/.test(n) && c[n] >= 4);
            const emergencyPickBlocked = (why, reason, extra = '') => {
                const now = Date.now();
                bot._emergencyPickBlockedUntil = now + 10000;
                if (now - (bot._lastEmergencyPickBlockedLogAt || 0) > 10000) {
                    bot._lastEmergencyPickBlockedLogAt = now;
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [mobility] emergency pick blocked (${why}): ${reason}${extra ? ' ' + extra : ''}\n`);
                    } catch (e) {}
                }
                return false;
            };
            const ensureEmergencyPick = async (why = '') => {
                if (hasPick()) return true;
                if (Date.now() < (bot._emergencyPickBlockedUntil || 0)) return false;
                const c = invCounts();
                const plankName = Object.keys(c).find(n => /_planks$/.test(n) && c[n] >= 3);
                let recipe = null;
                if ((c.cobblestone || 0) >= 3 && (c.stick || 0) >= 2) recipe = 'stone_pickaxe';
                else if (plankName && (c.stick || 0) >= 2) recipe = 'wooden_pickaxe';
                if (!recipe) return false;
                if (!reachableCraftingTable()) {
                    if (!hasTableMaterials(c)) {
                        return emergencyPickBlocked(why, `${recipe} needs reachable crafting_table`, `cobble=${c.cobblestone || 0} stick=${c.stick || 0} table=${c.crafting_table || 0}`);
                    }
                    try {
                        const madeTable = await (skills.craftRecipeLocal || skills.craftRecipe)(bot, 'crafting_table', 1);
                        if (madeTable === false || !reachableCraftingTable()) {
                            return emergencyPickBlocked(why, `${recipe} cannot place/reach crafting_table`, `planks=${plankName ? c[plankName] : 0}`);
                        }
                    } catch (e) {
                        return emergencyPickBlocked(why, `crafting_table prep failed: ${e && e.message ? e.message : String(e)}`);
                    }
                }
                try {
                    fs.appendFileSync('bots/_supervisor/progress.txt',
                        `[${new Date().toISOString()}] [mobility] emergency pick craft (${why}): ${recipe}\n`);
                } catch (e) {}
                try {
                    const craftLocal = skills.craftRecipeLocal || skills.craftRecipe;
                    const ok = await Promise.race([
                        craftLocal(bot, recipe, 1),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('emergency-pick-timeout')), 12000)),
                    ]);
                    if (ok === false) emergencyPickBlocked(why, `${recipe} craft returned false`);
                } catch (e) {
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [mobility] emergency pick failed (${why}): ${e && e.message ? e.message : String(e)}\n`);
                    } catch (_) {}
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                }
                return hasPick();
            };
            const ensurePickForStone = async (block, why = '') => {
                if (!block || !STONY_MOBILITY.test(block.name || '')) return true;
                if (!hasPick()) await ensureEmergencyPick(why);
                // Sealed inside an enclosed cavity with no pick = trapped: allow bare-hand stone
                // breakout (slow, no drop, but the block disappears and the bot escapes). Without
                // this the reflex gates every direction (all stone) and the bot rots sealed-in
                // (observed: 1.5h frozen at y79, POCKET no-pick stone gate looping). breakBlockAt/
                // bot.dig now permit bounded bare-hand stone; only obsidian/bedrock stay refused.
                if (!hasPick()) return plannedNoPickStone() || !!(bot._mobility && bot._mobility.enclosed);
                if (heldIsPick()) return true;
                const pick = bot.inventory.items().find(it => /_pickaxe$/.test(it.name));
                try { if (pick) await skills.equip(bot, pick.name); } catch (e) {}
                await new Promise(r => setTimeout(r, 80));
                if (heldIsPick()) return true;
                try { await bot.tool.equipForBlock(block); } catch (e) {}
                await new Promise(r => setTimeout(r, 80));
                if (heldIsPick()) return true;
                try {
                    fs.appendFileSync('bots/_supervisor/progress.txt',
                        `[${new Date().toISOString()}] [mobility] stone dig blocked (${why}): ${block.name} @${block.position.x},${block.position.y},${block.position.z} held=${bot.heldItem ? bot.heldItem.name : 'empty'}\n`);
                } catch (e) {}
                return false;
            };
            const guardedDig = async (block, why = '') => {
                if (!block) return false;
                const owner = `mobility:${why || 'dig'}`;
                const acquire = async () => {
                    const t0 = Date.now();
                    while (Date.now() - t0 < 900) {
                        const busy = bot.targetDigBlock || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil);
                        if (!busy || bot._bodyDigLockOwner === owner) {
                            bot._bodyDigLockOwner = owner;
                            bot._bodyDigLockUntil = Date.now() + 6000;
                            return true;
                        }
                        await new Promise(r => setTimeout(r, 80));
                    }
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [mobility] dig slot busy (${why}) target=${block.name}@${block.position.x},${block.position.y},${block.position.z} heldBy=${bot._bodyDigLockOwner || 'targetDigBlock'}\n`);
                    } catch (e) {}
                    return false;
                };
                if (!(await acquire())) return false;
                try {
                    for (let n = 0; n < 2; n++) {
                        const fresh = bot.blockAt(block.position);
                        if (!fresh || fresh.boundingBox !== 'block') return true;
                        if (!(await ensurePickForStone(fresh, why))) return false;
                        if (!STONY_MOBILITY.test(fresh.name || '')) { try { await bot.tool.equipForBlock(fresh); } catch (e) {} }
                        try { bot.clearControlStates(); } catch (e) {}
                        try { await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                        // ★DIG TIMEOUT must scale with ACTUAL dig time (C223). A fixed 5000ms aborts
                        // any dig slower than 5s — but bare-hand stone is ~7.5s (deepslate ~16.5s).
                        // Since C221 opened bare-hand stone digging to escape entombment, this fixed
                        // timeout SILENTLY DEFEATED it: every bare-hand stone dig hit 5s → stopDigging
                        // → "Digging aborted" → 0 progress → re-fire → PERMANENT entombment (act_trace:
                        // bot dug seq 126→129 on the SAME stone block, ok:false ms:5005 each, never
                        // broke free). Scale the cutoff to the block's real digTime×1.4 + 1.5s (cap 20s)
                        // and extend the body-dig lock to match so no other owner steals the slot mid-dig.
                        let digMs = 5000;
                        try {
                            const ht = bot.heldItem ? bot.heldItem.type : null;
                            const dt = fresh.digTime(ht);
                            if (Number.isFinite(dt) && dt > 0) digMs = Math.min(20000, Math.round(dt * 1.4) + 1500);
                        } catch (e) {}
                        bot._bodyDigLockUntil = Date.now() + digMs + 2000;
                        try {
                            await Promise.race([
                                bot.dig(fresh, true),
                                new Promise((_, rej) => setTimeout(() => rej(new Error('dig-timeout')), digMs)),
                            ]);
                            return true;
                        } catch (e) {
                            try { bot.stopDigging(); } catch (_) {}
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] dig retry ${n} (${why}) ${fresh.name}@${fresh.position.x},${fresh.position.y},${fresh.position.z}: ${e && e.message ? e.message : String(e)}\n`);
                            } catch (_) {}
                            await new Promise(r => setTimeout(r, 140));
                        }
                    }
                    return false;
                } finally {
                    if (bot._bodyDigLockOwner === owner) {
                        bot._bodyDigLockOwner = null;
                        bot._bodyDigLockUntil = 0;
                    }
                }
            };
            // ── reactions ──
            if (st === 'SWIM_STUCK') {
                // ★C346 (T-0091): the swim instinct piston-bobs forever in a "head-hole + all-
                // water" topology — the only exit is one air cell straight up, all 4 horizontal
                // neighbors are water, no shore in range, and (when the pack is empty) it can't
                // pillar either, so it just jump-bobs y60↔62.7 with zero net horizontal motion
                // (live 2026-06-24 @51,62,2). The instinct is topology-blind to a VERTICAL exit;
                // model it here and climb out vertically instead of swimming in circles.
                execute(this, agent, async () => {
                    try { bot.interrupt_code = false; } catch (e) {}
                    const WS2 = ['water', 'flowing_water'];
                    const isWater2 = (b) => b && WS2.includes(b.name || '');
                    const isAir2 = (b) => b && ['air', 'cave_air', 'void_air'].includes(b.name || '');
                    const FILL2 = ['dirt', 'cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'stone', 'tuff', 'gravel', 'sand', 'red_sand', 'sandstone', 'netherrack', 'deepslate'];
                    const filler2 = () => { try { const c = world.getInventoryCounts(bot); return FILL2.find(n => (c[n] || 0) > 0) || Object.keys(c).find(n => /_planks$|_log$/.test(n) && c[n] > 0); } catch (e) { return null; } };
                    if (Date.now() - (bot._lastSwimStuckSayAt || 0) > 15000) { bot._lastSwimStuckSayAt = Date.now(); say(agent, 'Water-locked — climbing the vertical exit.'); }
                    const m2 = bot.entity.position.floored();
                    // VERTICAL-EXIT topology: air directly overhead (the one hole) + all four
                    // horizontal neighbors at head height are water (no shore to swim to).
                    const above = bot.blockAt(m2.offset(0, 2, 0));
                    const headRing = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => bot.blockAt(m2.offset(dx, 1, dz)));
                    const verticalExit = isAir2(above) && headRing.every(b => isWater2(b) || !b);
                    const f2 = filler2();
                    if (verticalExit && f2) {
                        // have blocks → pillar the feet straight up into the hole (100% reliable).
                        try { await bot.look(bot.entity.yaw, -1.4, false); } catch (e) {}
                        bot.setControlState('forward', false);
                        try { await skills.placeBlockUnderFeet(bot, f2, { retries: 2, settleMs: 180 }); } catch (e) { try { bot.setControlState('jump', false); } catch (e2) {} }
                        await new Promise(r => setTimeout(r, 200));
                    } else if (verticalExit) {
                        // EMPTY pack, no shore: water buoyancy + held jump + look-up lets the body
                        // rise into a single-cell air hole. Hold jump and grind up; re-evaluated
                        // each tick, leaves SWIM_STUCK the instant onGround in the hole.
                        try { await bot.look(bot.entity.yaw, -1.45, false); } catch (e) {}
                        bot.setControlState('forward', true);   // a touch of forward bias seats the body under the hole
                        bot.setControlState('jump', true);
                        await new Promise(r => setTimeout(r, 700));
                        try { bot.setControlState('forward', false); } catch (e) {}
                        // if we surfaced (head now air + onGround), release
                        const hb = bot.blockAt(bot.entity.position.offset(0, 1, 0));
                        if (isAir2(hb) && bot.entity.onGround) { try { bot.clearControlStates(); } catch (e) {} }
                    } else {
                        // Not a clean vertical hole. If we carry blocks, pillar up anyway (always
                        // escapes water). Otherwise swim hard toward the NEAREST solid block (a
                        // water body is finite; commit to a heading) — the EMPTY-pack last resort,
                        // mirrors the instinct's explore but state-driven so the bob can't resume.
                        if (f2) {
                            try { await bot.look(bot.entity.yaw, -1.4, false); } catch (e) {}
                            bot.setControlState('forward', false);
                            try { await skills.placeBlockUnderFeet(bot, f2, { retries: 2, settleMs: 180 }); } catch (e) {}
                            await new Promise(r => setTimeout(r, 200));
                        } else {
                            // find nearest solid (non-water) block in a 12-radius shell, swim at it.
                            let tgt = null, bd = 1e9;
                            for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
                                const d2 = dx * dx + dz * dz; if (d2 < 1 || d2 >= bd) continue;
                                for (let dy = 2; dy >= -3; dy--) {
                                    const g = bot.blockAt(m2.offset(dx, dy, dz));
                                    if (g && g.boundingBox === 'block' && !WS2.includes(g.name)) { tgt = m2.offset(dx, dy + 1, dz); bd = d2; break; }
                                }
                            }
                            if (tgt) { try { await bot.lookAt(tgt.offset(0.5, 0, 0.5), true); } catch (e) {} }
                            else { try { await bot.look((this._swimExploreYaw = (this._swimExploreYaw || bot.entity.yaw) + Math.PI / 2.5), -0.05, true); } catch (e) {} }
                            bot.setControlState('forward', true);
                            bot.setControlState('sprint', true);
                            bot.setControlState('jump', true);   // ride the surface, don't sink
                            await new Promise(r => setTimeout(r, 320));
                            try { bot.clearControlStates(); } catch (e) {}
                        }
                    }
                    // re-anchor the SWIM_STUCK timer so a single escape burst that DID move us
                    // doesn't immediately re-flag; the state machine re-evaluates from scratch.
                    try { this._swimAnchor = bot.entity.position.clone(); this._swimAnchorAt = Date.now(); } catch (e) {}
                    try { bot._mobility = { ...(bot._mobility || {}), state: 'SWIM_STUCK', since: this.stateSince }; } catch (e) {}
                });
            } else if (st === 'ENTOMBED') {
                // instant dig-out, reflex priority — no stagnation timer, no material
                // gate (entombed = the gate's exception BY DEFINITION). Head toward the
                // anchor; one 2-cell column per execute burst, state re-evaluated next tick.
                execute(this, agent, async () => {
                    const tableHold = tableRecoveryHold(bot);
                    if (tableHold) {
                        try {
                            bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null);
                            bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop();
                            bot.clearControlStates();
                        } catch (e) {}
                        if (Date.now() - (bot._lastEntombedTableRecoveryGateAt || 0) > 15000) {
                            bot._lastEntombedTableRecoveryGateAt = Date.now();
                            const p = bot.entity.position.floored();
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] ENTOMBED table recovery hold pos=${p.x},${p.y},${p.z} raw16=${tableHold.raw} layered16=${tableHold.layered} nearest=${Number.isFinite(tableHold.nearest) ? tableHold.nearest.toFixed(1) : '-'} day=${!tableHold.isNight} — hold shaft while prepNether owns surface recovery\n`);
                            } catch (e) {}
                        }
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'ENTOMBED', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    const noRegenHold = noRegenSafeAirHold();
                    if (noRegenHold) {
                        try {
                            if (!/feedUp|surfaceUp|consume|auto_eat/i.test(bot._currentSkill || '')) {
                                bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null);
                                bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop();
                                bot.clearControlStates();
                            }
                        } catch (e) {}
                        if (Date.now() - (bot._lastEntombedNoRegenGateAt || 0) > 15000) {
                            bot._lastEntombedNoRegenGateAt = Date.now();
                            try {
                                const p = noRegenHold.pos.floored();
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] ENTOMBED no-regen safe-air gate food=${bot.food} hp=${Math.round(bot.health || 0)} prepLow=${Math.ceil(noRegenHold.prepLow / 1000)}s surface=${Math.ceil(noRegenHold.prepSurface / 1000)}s night=${noRegenHold.isNight} pos=${p.x},${p.y},${p.z} skill=${noRegenHold.skill || '-'} — hold air pocket, no blind dig\n`);
                            } catch (e) {}
                        }
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'ENTOMBED', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    say(agent, 'Entombed — digging out!');
                    let bx = 96, bz = -34;
                    try { const bj = JSON.parse(fs.readFileSync('bots/_supervisor/bed.json', 'utf8')); if (typeof bj.x === 'number') { bx = bj.x; bz = bj.z; } } catch (e) {}
                    // ghost-bed guard: 距床>60(缰绳外)=床大概率已无效(死276后 bed.json 还是
                    // 崖壁区老坐标,挖出方向被幽灵床带偏) → spawn_pos 兜底(真锚)
                    try { if (Math.hypot(bx - bot.entity.position.x, bz - bot.entity.position.z) > 60) { const sj = JSON.parse(fs.readFileSync('bots/_supervisor/spawn_pos.json', 'utf8')); if (typeof sj.x === 'number') { bx = sj.x; bz = sj.z; } } } catch (e) {}
                    const me = bot.entity.position;
                    const m2 = me.floored();
                    // ★C347 (T-0096): AQUIFER-AWARE ROTATING DIG-OUT. The old code dug ONE fixed
                    // anchor-bearing column every burst. In a savanna-shallow AQUIFER that's a death
                    // loop: break the anchor-side wall → water from the breach + neighbors floods the
                    // cell → re-seals → next tick re-evaluates ENTOMBED → dig the SAME refilling water
                    // wall again (live 06-25: 229× "Entombed/Sealed" in 69min, mining-signal ~0). Two
                    // fixes: (1) NEVER tunnel toward a cell whose dig opens onto water/lava — that just
                    // floods us; skip those bearings. (2) When the anchor bearing is blocked (water or
                    // no net progress), ROTATE through all four horizontals + straight UP, so we punch
                    // out the DRY side of the pocket instead of grinding the wet one forever. UP is
                    // tried last-resort: in an aquifer the dry escape is usually a horizontal land cell,
                    // but if every horizontal is water, mining up reaches air/surface.
                    const anchorSx = Math.abs(bx - me.x) > Math.abs(bz - me.z) ? (Math.sign(bx - me.x) || 1) : 0;
                    const anchorSz = anchorSx === 0 ? (Math.sign(bz - me.z) || 1) : 0;
                    // candidate bearings: anchor-first, then rotate; [0,0]=straight up
                    const bearings = [[anchorSx, anchorSz], [anchorSz, -anchorSx], [-anchorSz, anchorSx], [-anchorSx, -anchorSz], [0, 0]];
                    const isWet = (c) => { const b = bot.blockAt(c); return !!(b && /water|lava/.test(b.name || '')); };
                    // a bearing is FLOODY if the column we'd open (foot+head) OR what lies just beyond
                    // it is water — digging it only lets water in. Reject those outright.
                    const floodyBearing = (dx, dz) => {
                        if (dx === 0 && dz === 0) return isWet(m2.offset(0, 2, 0)) || isWet(m2.offset(0, 3, 0));
                        return isWet(m2.offset(dx, 0, dz)) || isWet(m2.offset(dx, 1, dz)) || isWet(m2.offset(dx * 2, 0, dz)) || isWet(m2.offset(dx * 2, 1, dz));
                    };
                    // net-progress rotation: if we haven't moved >1.5b since the last burst, advance the
                    // bearing pointer so we stop grinding a wall that won't open (refilling water / bedrock-
                    // backed). Persisted on bot so it survives the per-burst execute re-entry.
                    const _ep = me;
                    if (!bot._entombDir || !bot._entombAnchor || _ep.distanceTo(bot._entombAnchor) > 1.5) {
                        // moved >1.5b since last burst (or first entry) → re-anchor, keep the current bearing pointer
                        bot._entombAnchor = _ep.clone(); if (!bot._entombDir) bot._entombDirIdx = 0; bot._entombStuckBursts = 0;
                    } else {
                        bot._entombStuckBursts = (bot._entombStuckBursts || 0) + 1;
                        if (bot._entombStuckBursts >= 2) { bot._entombDirIdx = ((bot._entombDirIdx || 0) + 1) % bearings.length; bot._entombStuckBursts = 0; }
                    }
                    // pick the first NON-FLOODY bearing starting at the current pointer; if all four
                    // horizontals flood, fall through to UP ([0,0], never floody unless capped by water).
                    let chosen = null;
                    for (let k = 0; k < bearings.length; k++) {
                        const idx = ((bot._entombDirIdx || 0) + k) % bearings.length;
                        const [dx, dz] = bearings[idx];
                        if (!floodyBearing(dx, dz)) { chosen = [dx, dz]; bot._entombDirIdx = idx; break; }
                    }
                    if (!chosen) chosen = [0, 0];   // everything wet → dig up regardless, air is above water
                    bot._entombDir = chosen;
                    const [sx, sz] = chosen;
                    const cells = (sx === 0 && sz === 0)
                        ? [m2.offset(0, 2, 0), m2.offset(0, 3, 0)]   // straight up: clear head + above-head
                        : [m2.offset(sx, 1, sz), m2.offset(sx, 0, sz)];
                    for (const c of cells) {
                        const b = bot.blockAt(c);
                        if (b && b.boundingBox === 'block' && !/bedrock|water|lava/.test(b.name)) {
                            await guardedDig(b, 'ENTOMBED');
                        }
                    }
                    if (sx === 0 && sz === 0) {
                        // dig-up step: jump into the cleared column
                        try { await bot.lookAt(m2.offset(0.5, 2.4, 0.5), true); } catch (e) {}
                        bot.setControlState('jump', true);
                        bot.setControlState('forward', false);
                    } else {
                        try { await bot.lookAt(m2.offset(sx + 0.5, 1.6, sz + 0.5), true); } catch (e) {}
                        bot.setControlState('forward', true);
                    }
                    await new Promise(r => setTimeout(r, 600));
                    try { bot.clearControlStates(); } catch (e) {}
                });
            } else if (st === 'SEALED') {
                // ★C341 (T-0074): walled into a room with interior air — mine OUT through the nearest wall
                // toward the home anchor, then step into the breach. Re-evaluated each tick; the moment a
                // wall is breached the flood spills and st leaves SEALED (→ FREE). Mirrors the ENTOMBED
                // dig-out but the adjacent cell toward the anchor may be room-interior AIR, so scan a few
                // cells for the first solid wall before digging. guardedDig material-gates + reach-handles.
                execute(this, agent, async () => {
                    try { bot.interrupt_code = false; } catch (e) {}
                    if (Date.now() - (bot._lastSealedSayAt || 0) > 20000) { bot._lastSealedSayAt = Date.now(); say(agent, 'Sealed in a room — mining out!'); }
                    let bx = 96, bz = -34;
                    try { const bj = JSON.parse(fs.readFileSync('bots/_supervisor/bed.json', 'utf8')); if (typeof bj.x === 'number') { bx = bj.x; bz = bj.z; } } catch (e) {}
                    try { if (Math.hypot(bx - bot.entity.position.x, bz - bot.entity.position.z) > 60) { const sj = JSON.parse(fs.readFileSync('bots/_supervisor/spawn_pos.json', 'utf8')); if (typeof sj.x === 'number') { bx = sj.x; bz = sj.z; } } } catch (e) {}
                    const me = bot.entity.position;
                    const anchorSx = Math.abs(bx - me.x) > Math.abs(bz - me.z) ? (Math.sign(bx - me.x) || 1) : 0;
                    const anchorSz = anchorSx === 0 ? (Math.sign(bz - me.z) || 1) : 0;
                    const m2 = me.floored();
                    // ★C347 (T-0096): AQUIFER-AWARE SEALED dig-out (mirrors the ENTOMBED fix). The old code
                    // ground the anchor bearing's wall (then any wall) with no water-avoidance and no
                    // rotation — in a flooded room the breach floods, re-seals, and we re-mine the same
                    // wet wall forever ("Sealed in a room — mining out!" 229× in the live loop). Skip
                    // bearings whose breach opens onto water; rotate the chosen bearing when no net
                    // progress so we punch out the DRY wall instead of the refilling one.
                    const isWet = (c) => { const b = bot.blockAt(c); return !!(b && /water|lava/.test(b.name || '')); };
                    const bearings = [[anchorSx, anchorSz], [anchorSz, -anchorSx], [-anchorSz, anchorSx], [-anchorSx, -anchorSz]];
                    // probe up to 3 cells along a bearing for the first solid wall; FLOODY if that wall
                    // (or what's beyond it) is water — opening it just lets the room re-flood.
                    const wallAlong = (dx, dz) => {
                        for (let step = 1; step <= 3; step++) {
                            for (const c of [m2.offset(dx * step, 1, dz * step), m2.offset(dx * step, 0, dz * step)]) {
                                const b = bot.blockAt(c);
                                if (b && /water|lava/.test(b.name || '')) return { floody: true };   // hit water before a dry wall
                                if (b && b.boundingBox === 'block' && !/bedrock/.test(b.name || '')) {
                                    const beyond = bot.blockAt(c.offset(dx, 0, dz));
                                    return { floody: !!(beyond && /water|lava/.test(beyond.name || '')), cell: c, block: b };
                                }
                            }
                        }
                        return null;   // all air for 3 cells along this bearing → not a wall to breach
                    };
                    const _sp = me;
                    if (!bot._sealedAnchorPos || _sp.distanceTo(bot._sealedAnchorPos) > 1.5) {
                        bot._sealedAnchorPos = _sp.clone(); bot._sealedStuckBursts = 0;
                    } else {
                        bot._sealedStuckBursts = (bot._sealedStuckBursts || 0) + 1;
                        if (bot._sealedStuckBursts >= 2) { bot._sealedDirIdx = ((bot._sealedDirIdx || 0) + 1) % bearings.length; bot._sealedStuckBursts = 0; }
                    }
                    let dug = false, sx = anchorSx, sz = anchorSz;
                    // try bearings from the current pointer, dig the first DRY breachable wall
                    for (let k = 0; k < bearings.length && !dug; k++) {
                        const idx = ((bot._sealedDirIdx || 0) + k) % bearings.length;
                        const [dx, dz] = bearings[idx];
                        const w = wallAlong(dx, dz);
                        if (w && !w.floody && w.block) {
                            await guardedDig(w.block, 'SEALED'); dug = true; sx = dx; sz = dz; bot._sealedDirIdx = idx;
                            // clear the rest of the 2-high column at that wall cell
                            const other = w.cell.y === m2.y + 1 ? bot.blockAt(w.cell.offset(0, -1, 0)) : bot.blockAt(w.cell.offset(0, 1, 0));
                            if (other && other.boundingBox === 'block' && !/bedrock|water|lava/.test(other.name || '')) { try { await guardedDig(other, 'SEALED'); } catch (e) {} }
                        }
                    }
                    // every horizontal bearing is wet or air-only → mine straight UP toward the surface/air
                    if (!dug) {
                        for (const c of [m2.offset(0, 2, 0), m2.offset(0, 3, 0)]) {
                            const b = bot.blockAt(c);
                            if (b && b.boundingBox === 'block' && !/bedrock|water|lava/.test(b.name || '')) { await guardedDig(b, 'SEALED-up'); dug = true; }
                        }
                        if (dug) { sx = 0; sz = 0; }
                    }
                    if (sx === 0 && sz === 0) {
                        try { await bot.lookAt(m2.offset(0.5, 2.4, 0.5), true); } catch (e) {}
                        bot.setControlState('jump', true);
                    } else {
                        try { await bot.lookAt(m2.offset(sx + 0.5, 1.6, sz + 0.5), true); } catch (e) {}
                        bot.setControlState('forward', true);
                    }
                    await new Promise(r => setTimeout(r, 500));
                    try { bot.clearControlStates(); } catch (e) {}
                });
            } else if (st === 'MAROONED') {
                // ★ENGINEERED MARCH — locally free but every pathfind dead-ends (shattered
                // cliff/lake terrain): stop asking the planner, BUILD the road. Locked
                // heading toward the anchor; per segment: clear the 2-high cell ahead
                // (material-gated: no-pick never bare-hands stone), bridge a gap
                // (place into the NEIGHBOR cell at foot height, body-clearance checked,
                // no self-place race), step in. ~6 cells per burst, state re-evaluated
                // between bursts; >20 blocks of net displacement re-anchors to FREE.
                execute(this, agent, async () => {
                    // ★C285 consume the activation interrupt ONCE on entry (same discipline as
                    // 826/891/1283): the seg loop below honors `if(bot.interrupt_code)break`, so a
                    // watchdog "Pinned — kicking the stack" forced interrupt that set interrupt_code
                    // would otherwise break EVERY seg the instant the march starts → march runs but
                    // digs/moves nothing → the 25min body-freeze. Clear once here; new interrupts
                    // (death/real stop) set AFTER this still break the loop promptly.
                    try { bot.interrupt_code = false; } catch (e) {}
                    const noEdible = !bot.inventory.items().some(i => FAMINE_FOOD_RE.test(i.name || ''));
                    if (bot.food <= 6 && noEdible) {
                        try { bot.clearControlStates(); } catch (e) {}
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [mobility] MAROONED famine gate food=${bot.food} hp=${Math.round(bot.health || 0)} — release to feedUp, no road dig\n`);
                        } catch (e) {}
                        this.lastState = 'FREE';
                        this.stateSince = Date.now();
                        this.regAnchor = bot.entity.position.clone();
                        this.regAt = Date.now();
                        this.maroonedAt = 0;
                        bot._marchDir = null;
                        bot._marchFails = 0;
                        bot._maroonedMarchOrigin = null;
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'FREE', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    say(agent, 'Marooned — engineering a road out.');
                    try { if (!bot._maroonedMarchOrigin) bot._maroonedMarchOrigin = bot.entity.position.clone(); } catch (e) {}
                    // ★LOCKED MARCH DIRECTION (用户实拍"左挖一下右挖一下像无头苍蝇": 旧版每
                    // burst 重算方向,而"距锚<25反向"的翻转边界正好骑在 bot 的徘徊半径上 —
                    // 每轮翻一次=方向振荡。修: 方向第一次算好就挂 bot._marchDir 锁死,全程
                    // 不重算;只有该方向连续2个burst位移<2格(真走不动)才右转90°。)
                    if (!bot._marchDir) {
                        // ★MARCH TOWARD A TREE first (宏观钟摆机理: "距床<25反向开拓"把行军
                        // 派进东侧迷宫,>25又派回——25格边界两侧反复横跳;而锚区整体是寻路孤岛
                        // (树全在崖顶,11棵拉黑,任务层在哪都 noPath 累积),MAROONED 必然复发,
                        // 行军成了无目的钟摆。人类被困+缺木头不会盲目开拓——朝看得见的树修路。
                        // 拉黑树="寻路不可达",行军不用寻路,修路恰恰可达。y差>6的崖顶冠不追
                        // (水平行军够不着),无低位树才回退朝床/背床。)
                        try { bot._marchTargetY = null; } catch (e) {}   // C307-A(T-0039): reset elevation target each fresh direction lock; set below only if a log is targeted
                        const me0 = bot.entity.position;
                        let ux = null, uz = null;
                        try {
                            const logIds = Object.values(bot.registry.blocksByName)
                                .filter(b => /_log$/.test(b.name)).map(b => b.id);
                            const hits = bot.findBlocks({ matching: logIds, maxDistance: 64, count: 8 });
                            const reachable = (hits || []).filter(p => Math.abs(p.y - me0.y) <= 6)
                                .sort((a, b) => me0.distanceTo(a) - me0.distanceTo(b));
                            if (reachable.length) {
                                ux = reachable[0].x - me0.x; uz = reachable[0].z - me0.z;
                                try { bot._marchTargetY = reachable[0].y; } catch (e) {}   // C307-A(T-0039): remember log elevation so the seg loop stair-climbs to it
                                say(agent, `March target: log @${reachable[0].x},${reachable[0].y},${reachable[0].z}`);
                            }
                        } catch (e) {}
                        if (ux === null) {
                            let bx = 96, bz = -34;
                            try { const bj = JSON.parse(fs.readFileSync('bots/_supervisor/bed.json', 'utf8')); if (typeof bj.x === 'number') { bx = bj.x; bz = bj.z; } } catch (e) {}
                            // ghost-bed guard: 距床>60=床大概率已无效(死276后 bed.json 还是崖壁区
                            // 老坐标,行军被幽灵床带偏朝东远离 spawn 的树) → spawn_pos 兜底
                            try { if (Math.hypot(bx - me0.x, bz - me0.z) > 60) { const sj = JSON.parse(fs.readFileSync('bots/_supervisor/spawn_pos.json', 'utf8')); if (typeof sj.x === 'number') { bx = sj.x; bz = sj.z; } } } catch (e) {}
                            const dHome = Math.hypot(bx - me0.x, bz - me0.z);
                            ux = (bx - me0.x); uz = (bz - me0.z);
                            if (dHome < 25) { ux = -ux; uz = -uz; }
                        }
                        const sx0 = Math.abs(ux) > Math.abs(uz) ? Math.sign(ux) || 1 : 0;
                        bot._marchDir = [sx0, sx0 === 0 ? Math.sign(uz) || 1 : 0];
                        bot._marchFails = 0;
                    }
                    const [sx, sz] = bot._marchDir;
                    const _mStart = bot.entity.position.clone();
                    const _origin = bot._maroonedMarchOrigin || _mStart;
                    const _foodTight = bot.food <= 10 && noEdible;
                    const _maxSeg = _foodTight ? 2 : 6;
                    const FILLR = /^dirt$|cobblestone|cobbled|granite|andesite|diorite|^stone$|tuff|gravel|_planks$|_log$/;
                    const canMarchDig = (b) => b
                        && b.boundingBox === 'block'
                        && !/bedrock|water|lava/.test(b.name)
                        && (hasPick() || !STONY_MOBILITY.test(b.name));
                    for (let seg = 0; seg < _maxSeg; seg++) {
                        if (bot.interrupt_code || bot.health <= 0) break;
                        const m2 = bot.entity.position.floored();
                        let stoneBlocked = null;
                        // ★C307-A (T-0039): STAIR-CLIMB toward an ELEVATED target (log on a hillside).
                        // The old march only cleared the 2-high cell AHEAD at the SAME level, so on
                        // rising terrain it tunnelled HORIZONTALLY under an elevated log (e.g. target
                        // dy+3) and never reached it → keystone wood deadlock (and the same horizontal-
                        // only road-out that fall-killed #106 chasing an elevated target). When the
                        // locked target is above us and the foot-ahead is a solid STEP whose head/above
                        // can be cleared, climb the step instead of tunnelling under it.
                        const _tgtY = bot._marchTargetY;
                        if (Number.isFinite(_tgtY) && _tgtY > m2.y + 0.5) {
                            const _footAhead = bot.blockAt(m2.offset(sx, 0, sz));
                            const _stepSolid = _footAhead && _footAhead.boundingBox === 'block' && !/bedrock|water|lava/.test(_footAhead.name || '');
                            if (_stepSolid) {
                                let _climbBlocked = false;
                                // clear head-ahead (dy1), above-ahead (dy2) and own-above (dy2) so there is room to rise onto the step
                                for (const c of [m2.offset(sx, 1, sz), m2.offset(sx, 2, sz), m2.offset(0, 2, 0)]) {
                                    const b = bot.blockAt(c);
                                    if (b && b.boundingBox === 'block' && !/bedrock|water|lava/.test(b.name)) {
                                        if (!canMarchDig(b)) { _climbBlocked = true; break; }
                                        await guardedDig(b, 'MAROONED-climb');
                                    }
                                }
                                if (!_climbBlocked) {
                                    try { await bot.lookAt(m2.offset(sx + 0.5, 1.2, sz + 0.5), true); } catch (e) {}
                                    bot.setControlState('forward', true);
                                    bot.setControlState('jump', true);
                                    await new Promise(r => setTimeout(r, 420));
                                    try { bot.clearControlStates(); } catch (e) {}
                                    if (bot.entity.position.floored().y > m2.y) continue;   // rose a level → re-evaluate from higher up
                                }
                            }
                        }
                        // clear the 2-high cell ahead
                        for (const c of [m2.offset(sx, 1, sz), m2.offset(sx, 0, sz)]) {
                            const b = bot.blockAt(c);
                            if (b && b.boundingBox === 'block' && !/bedrock|water|lava/.test(b.name)) {
                                if (!canMarchDig(b)) { stoneBlocked = b; break; }
                                await guardedDig(b, 'MAROONED');
                            }
                        }
                        if (stoneBlocked) {
                            if (!hasPick() && await ensureEmergencyPick('MAROONED-gate')) {
                                stoneBlocked = null;
                                continue;
                            }
                            try { bot.clearControlStates(); } catch (e) {}
                            try { bot._maroonedNoPickBlockedAt = Date.now(); } catch (e) {}
                            const nearbyLog = (() => {
                                try {
                                    const names = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
                                    for (const n of names) {
                                        const id = bot.registry && bot.registry.blocksByName[n] ? bot.registry.blocksByName[n].id : null;
                                        if (id == null) continue;
                                        const hits = bot.findBlocks({ matching: id, maxDistance: 16, count: 1 }) || [];
                                        if (hits.length) return { name: n, pos: hits[0] };
                                    }
                                } catch (e) {}
                                return null;
                            })();
                            if (!hasPick() && nearbyLog) {
                                try {
                                    fs.appendFileSync('bots/_supervisor/progress.txt',
                                        `[${new Date().toISOString()}] [mobility] MAROONED no-pick stone gate but ${nearbyLog.name} nearby @${nearbyLog.pos.x},${nearbyLog.pos.y},${nearbyLog.pos.z} — handoff to chopWood\n`);
                                } catch (e) {}
                                try { bot._maroonedWoodHandoffUntil = Date.now() + 120000; } catch (e) {}
                                try { bot._mobility = { ...(bot._mobility || {}), state: 'FREE', since: Date.now() }; } catch (e) {}
                                this.lastState = 'FREE';
                                this.regAnchor = bot.entity.position.clone();
                                this.regAt = Date.now();
                                this.maroonedAt = 0;
                                bot._marchDir = null;
                                bot._marchFails = 0;
                                break;
                            }
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] MAROONED no-pick stone gate: ${stoneBlocked.name} @${stoneBlocked.position.x},${stoneBlocked.position.y},${stoneBlocked.position.z}\n`);
                            } catch (e) {}
                            bot._marchDir = [-sz, sx];
                            bot._marchFails = 0;
                            await new Promise(r => setTimeout(r, 1200));
                            break;
                        }
                        // bridge: require a confirmed safe landing before walking. The old
                        // code checked for floor within 3, attempted a bridge if absent, but
                        // walked even when placement failed; on cliff-top MAROONED marches
                        // that became a fatal fall path.
                        const safeLandingAhead = () => {
                            for (let dd = 1; dd <= 2; dd++) {
                                const fb = bot.blockAt(m2.offset(sx, -dd, sz));
                                if (fb && /water|lava/.test(fb.name || '')) return false;
                                if (fb && fb.boundingBox === 'block') return true;
                            }
                            return false;
                        };
                        let floorOK = safeLandingAhead();
                        if (!floorOK) {
                            const fill = bot.inventory.items().find(it => FILLR.test(it.name));
                            const bp = bot.entity.position;
                            let placedBridge = false;
                            if (fill && Math.hypot(bp.x - (m2.x + sx + 0.5), bp.z - (m2.z + sz + 0.5)) >= 0.85) {
                                let ref = bot.blockAt(m2.offset(sx, -1, sz)), face = Vec3 ? new Vec3(0, 1, 0) : null;
                                if (!(ref && ref.boundingBox === 'block')) { ref = bot.blockAt(m2.offset(0, -1, 0)); face = Vec3 ? new Vec3(sx, 0, sz) : null; }
                                if (ref && ref.boundingBox === 'block' && face) {
                                    try { await bot.equip(fill, 'hand'); } catch (e) {}
                                    try { await bot.placeBlock(ref, face); placedBridge = true; } catch (e) {}
                                }
                            }
                            await new Promise(r => setTimeout(r, 120));
                            floorOK = placedBridge && safeLandingAhead();
                        }
                        if (!floorOK) {
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] MAROONED ledge veto dir=${sx},${sz} at ${m2.x},${m2.y},${m2.z} — rotate, no blind step\n`);
                            } catch (e) {}
                            bot._marchDir = [-sz, sx];
                            bot._marchFails = 0;
                            break;
                        }
                        try { await bot.lookAt(m2.offset(sx + 0.5, 1.6, sz + 0.5), true); } catch (e) {}
                        bot.setControlState('forward', true);
                        await new Promise(r => setTimeout(r, 260));
                        try { bot.clearControlStates(); } catch (e) {}
                    }
                    // heading review: rotate 90° only after 2 consecutive dead bursts
                    const burstMoved = bot.entity.position.distanceTo(_mStart);
                    const originMoved = bot.entity.position.distanceTo(_origin);
                    const releaseDist = _foodTight ? 10 : 22;
                    if (originMoved >= releaseDist) {
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [mobility] MAROONED release: moved ${originMoved.toFixed(1)}b from march origin food=${bot.food} maxSeg=${_maxSeg} — re-anchor FREE\n`);
                        } catch (e) {}
                        this.lastState = 'FREE';
                        this.stateSince = Date.now();
                        this.regAnchor = bot.entity.position.clone();
                        this.regAt = Date.now();
                        this.maroonedAt = 0;
                        bot._marchDir = null;
                        bot._marchFails = 0;
                        bot._maroonedMarchOrigin = null;
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'FREE', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    if (burstMoved < 2) {
                        bot._marchFails = (bot._marchFails || 0) + 1;
                        if (bot._marchFails >= 2) { bot._marchDir = [-sz, sx]; bot._marchFails = 0; }   // rotate 90°
                    } else bot._marchFails = 0;
                });
            } else if (st === 'POCKET' && now - this.stateSince > 30000) {
                // stuck in a roofless pit >60s: dig a step-out toward the anchor side
                execute(this, agent, async () => {
                    const noRegenHold = noRegenSafeAirHold();
                    if (noRegenHold) {
                        try {
                            if (!/feedUp|surfaceUp|consume|auto_eat/i.test(bot._currentSkill || '')) {
                                bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null);
                                bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop();
                                bot.clearControlStates();
                            }
                        } catch (e) {}
                        if (Date.now() - (bot._lastPocketNoRegenGateAt || 0) > 15000) {
                            bot._lastPocketNoRegenGateAt = Date.now();
                            try {
                                const p = noRegenHold.pos.floored();
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] POCKET no-regen gate food=${bot.food} hp=${Math.round(bot.health || 0)} bodyBudget=${!!noRegenHold.bodyBudgetHold} prepLow=${Math.ceil(noRegenHold.prepLow / 1000)}s surface=${Math.ceil(noRegenHold.prepSurface / 1000)}s night=${noRegenHold.isNight} pos=${p.x},${p.y},${p.z} skill=${bot._currentSkill || '-'} — hold, no step-out dig\n`);
                            } catch (e) {}
                        }
                        this.stateSince = Date.now();
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'POCKET', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    const noEdible = !bot.inventory.items().some(i => FAMINE_FOOD_RE.test(i.name || ''));
                    const isNight = (() => { try { const t = bot.time && bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } })();
                    const actionableHostileNear = (() => {
                        try {
                            const me = bot.entity.position;
                            const hostile = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
                            return Object.values(bot.entities || {}).some(e => {
                                if (!(e && e.position && e.name && hostile.test(e.name))) return false;
                                const d = e.position.distanceTo(me);
                                const dy = Math.abs(e.position.y - me.y);
                                return d <= 12 && dy <= 4;
                            });
                        } catch (e) {
                            return false;
                        }
                    })();
                    // ★T-0101/T-0083: 饥饿觅食 skill 在跑且无 LETHAL 急症时,不 hold pocket——
                    //   让 mobility step-out + 觅食移动通过(否则封箱 POCKET 把觅食又卡死,FROZEN-ALIVE 复发)。
                    if (!isNight && bot.food <= 6 && noEdible && !actionableHostileNear && !famineForageActive(bot)) {
                        try { bot.clearControlStates(); } catch (e) {}
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [mobility] POCKET low-food daylight gate food=${bot.food} hp=${Math.round(bot.health || 0)} — hold pocket, no step-out dig without food signal\n`);
                        } catch (e) {}
                        this.stateSince = Date.now();
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'POCKET', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    if (isNight && bot.food <= 6 && noEdible) {
                        try { bot.clearControlStates(); } catch (e) {}
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [mobility] POCKET famine-night gate food=${bot.food} hp=${Math.round(bot.health || 0)} — hold bunker, no step-out dig\n`);
                        } catch (e) {}
                        this.stateSince = Date.now();
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'POCKET', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    say(agent, 'Pocketed — carving a step out.');
                    // C305-A (T-0036): the old carve scanned ONLY head-level (dy+1) neighbors to
                    // dig. Live failure: bot dug itself into a 1-deep FOOT-slot (neighbor foot=dy0
                    // stone walls, neighbor head=dy1 ALL air after she cleared them) — head-only
                    // scan found nothing solid to dig → loop no-op → "carving a step out" spun
                    // ~4min/2.15s with zero motion until pathfinder/mining happened to dislodge her.
                    // She just needed to JUMP onto the adjacent step (foot solid + head air = a
                    // climbable 1-block step that regains surface level). Now: A) climb-out first
                    // (jump-forward onto a clear step, no digging, instant), B) dig a step-out
                    // (foot OR head wall, not head-only) only when no ready climb exists.
                    const m2 = bot.entity.position.floored();
                    const enclosedTrapped = !!(bot._mobility && bot._mobility.enclosed);
                    const _pPassable = (b) => !b || (b.boundingBox !== 'block' && !/water|lava/.test(b.name || ''));
                    const _pSolid = (b) => !!(b && b.boundingBox === 'block');
                    const _pDiggable = (b) => _pSolid(b) && !/bedrock|water|lava/.test(b.name || '');
                    // Skip no-pick stone ONLY when NOT enclosed (bare-hand stone is slow/no-drop, not
                    // worth it for a normal step-out). When ENCLOSED (sealed in a cavity) the bot MUST
                    // dig out even bare-handed (ensurePickForStone permits enclosed no-pick stone).
                    const _pNoPickGated = (b) => (!hasPick() && STONY_MOBILITY.test(b.name || '') && !enclosedTrapped);
                    let _pActed = false;
                    // A) CLIMB OUT — regains surface height, no block-breaking. The foot-slot case the
                    //    old head-only carve missed: neighbor foot is a solid STEP, neighbor head+above
                    //    are air, own head has room → jump-forward onto the step.
                    if (_pPassable(bot.blockAt(m2.offset(0, 2, 0)))) {
                        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                            const bFoot = bot.blockAt(m2.offset(dx, 0, dz));
                            const bHead = bot.blockAt(m2.offset(dx, 1, dz));
                            const bAbove = bot.blockAt(m2.offset(dx, 2, dz));
                            if (_pSolid(bFoot) && !/water|lava/.test(bFoot.name || '') && _pPassable(bHead) && _pPassable(bAbove)) {
                                try {
                                    await bot.lookAt(m2.offset(dx, 1, dz).offset(0.5, 0.4, 0.5), true);
                                    bot.setControlState('forward', true);
                                    bot.setControlState('jump', true);
                                    await new Promise(r => setTimeout(r, 500));
                                } finally { try { bot.clearControlStates(); } catch (e) {} }
                                try {
                                    fs.appendFileSync('bots/_supervisor/progress.txt',
                                        `[${new Date().toISOString()}] [mobility] POCKET step-up climb dir=${dx},${dz} onto ${bFoot.name} y=${Math.floor(bot.entity.position.y)}\n`);
                                } catch (e) {}
                                _pActed = true;
                                break;
                            }
                        }
                    }
                    // B) DIG a step-out — no ready climb → open a passage by digging the blocking wall.
                    //    Consider BOTH foot (dy0) and head (dy1) neighbor cells (old code dug head only);
                    //    require a floor below the target so we don't open into a void/hazard.
                    if (!_pActed) {
                        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                            const bFoot = bot.blockAt(m2.offset(dx, 0, dz));
                            const bHead = bot.blockAt(m2.offset(dx, 1, dz));
                            const bFloor = bot.blockAt(m2.offset(dx, -1, dz));
                            if (!_pSolid(bFloor) || /water|lava/.test(bFloor.name || '')) continue;
                            const wall = _pDiggable(bFoot) ? bFoot : (_pDiggable(bHead) ? bHead : null);
                            if (!wall) continue;
                            if (_pNoPickGated(wall)) {
                                try { bot._pocketNoPickBlockedAt = Date.now(); } catch (e) {}
                                try {
                                    fs.appendFileSync('bots/_supervisor/progress.txt',
                                        `[${new Date().toISOString()}] [mobility] POCKET no-pick stone gate: ${wall.name} @${wall.position.x},${wall.position.y},${wall.position.z}\n`);
                                } catch (e) {}
                                continue;
                            }
                            await guardedDig(wall, 'POCKET');
                            // clear the OTHER cell of the 2-tall passage so she can actually walk in
                            const other = wall === bFoot ? bot.blockAt(m2.offset(dx, 1, dz)) : bot.blockAt(m2.offset(dx, 0, dz));
                            if (_pDiggable(other) && !_pNoPickGated(other)) { try { await guardedDig(other, 'POCKET'); } catch (e) {} }
                            try {
                                await bot.lookAt(m2.offset(dx, 1, dz).offset(0.5, 0, 0.5), true);
                                bot.setControlState('forward', true);
                                await new Promise(r => setTimeout(r, 350));
                            } finally { try { bot.clearControlStates(); } catch (e) {} }
                            _pActed = true;
                            break;
                        }
                    }
                });
            }
        }
    },
    {
        name: 'mine_motion_audit',
        description: 'Telemetry: wraps dig/placeBlock with structured operation logs for cave movement debugging.',
        interrupts: [],
        on: true,
        active: false,
        always: true,
        update: async function (agent) {
            const bot = agent.bot;
            const AUDIT_VERSION = 3;
            if (!bot || (bot._mineMotionAuditPatched && (bot._mineMotionAuditVersion || 1) >= AUDIT_VERSION)) return;
            bot._mineMotionAuditPatched = true;
            bot._mineMotionAuditVersion = AUDIT_VERSION;
            bot._mineMotionSeq = bot._mineMotionSeq || 0;
            const file = 'bots/_supervisor/mine_motion.jsonl';
            const posObj = (p) => p ? ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }) : null;
            const exactPos = () => {
                const p = bot.entity && bot.entity.position;
                return p ? { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)), z: Number(p.z.toFixed(3)) } : null;
            };
            const blockObj = (b) => b ? ({
                name: b.name,
                position: posObj(b.position),
                boundingBox: b.boundingBox,
            }) : null;
            const blockAt = (p) => {
                try { return blockObj(bot.blockAt(p)); } catch (e) { return null; }
            };
            const envSnap = () => {
                const m = bot.entity && bot.entity.position && bot.entity.position.floored();
                if (!m) return [];
                const cells = [];
                for (const dy of [-1, 0, 1, 2]) {
                    for (const dz of [-1, 0, 1]) {
                        for (const dx of [-1, 0, 1]) {
                            const b = bot.blockAt(m.offset(dx, dy, dz));
                            cells.push({ d: [dx, dy, dz], n: b ? b.name : 'unknown', bb: b ? b.boundingBox : '?' });
                        }
                    }
                }
                return cells;
            };
            const supportObj = () => {
                try {
                    const m = bot.entity && bot.entity.position && bot.entity.position.floored();
                    if (!m) return { stable: false, block: null };
                    const b = bot.blockAt(m.offset(0, -1, 0));
                    const bad = b && /water|lava|fire|cactus|magma/.test(b.name || '');
                    return { stable: !!(b && b.boundingBox === 'block' && !bad), block: blockObj(b) };
                } catch (e) {
                    return { stable: false, block: null, error: e.message };
                }
            };
            const write = (event, data = {}) => {
                try {
                    fs.appendFileSync(file, JSON.stringify({
                        ts: new Date().toISOString(),
                        event,
                        seq: data.seq,
                        pos: exactPos(),
                        foot: blockAt(bot.entity.position),
                        head: blockAt(bot.entity.position.offset(0, 1, 0)),
                        above: blockAt(bot.entity.position.offset(0, 2, 0)),
                        held: bot.heldItem ? bot.heldItem.name : 'empty',
                        hp: Math.round(bot.health || 0),
                        food: bot.food,
                        skill: bot._currentSkill || null,
                        mob: bot._mobility ? bot._mobility.state : null,
                        data,
                    }) + '\n');
                } catch (e) {}
            };
            const stony = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/;
            const heldIsPick = () => !!(bot.heldItem && /_pickaxe$/.test(bot.heldItem.name));
            const pickItem = () => bot.inventory.items().find(it => /_pickaxe$/.test(it.name));
            const delay = (ms) => new Promise(r => setTimeout(r, ms));
            const isStonyBlock = (block) => !!(block && stony.test(block.name || ''));
            const itemName = (item) => typeof item === 'string' ? item : (item && item.name);
            const isWaterBlock = (block) => !!(block && /^(flowing_)?water$/.test(block.name || ''));
            const inWaterNow = () => isWaterBlock(bot.blockAt(bot.entity.position))
                || isWaterBlock(bot.blockAt(bot.entity.position.offset(0, 1, 0)));
            const activeStonyDig = () => {
                const d = bot._mineMotionActiveDig;
                if (!d || !d.stony) return null;
                if (Date.now() - d.startedAt > 15000) { bot._mineMotionActiveDig = null; return null; }
                return d;
            };
            const waitForStonyDig = async (event, seq, data = {}) => {
                let d = activeStonyDig();
                if (!d) return true;
                write(event + '.deferred', { seq, activeDig: d, ...data });
                const until = Date.now() + 9000;
                while ((d = activeStonyDig()) && Date.now() < until) await delay(50);
                if (!activeStonyDig()) return true;
                write(event + '.blocked', { seq, activeDig: activeStonyDig(), ...data });
                return false;
            };
            const ensurePickForDig = async (block, seq) => {
                if (!block || !stony.test(block.name || '')) return true;
                // ★MASTER dig gate (wraps bot.dig — ALL digging passes here). No-pick stone is
                // normally refused unless a planned breach window is open. EXCEPTION: when sealed
                // inside an enclosed cavity (bot._mobility.enclosed), allow bare-hand stone — the
                // bot MUST be able to dig out of its own cobble bunker even pickless, or it rots
                // sealed forever (observed 1.5h). This is the lowest gate; without it the higher
                // breakBlockAt/surfaceUp/POCKET-reflex fixes are all still blocked here.
                if (!pickItem()) return (Date.now() < (bot._plannedNoPickStoneUntil || 0)) || !!(bot._mobility && bot._mobility.enclosed);
                if (heldIsPick()) return true;
                try { await bot.equip(pickItem(), 'hand'); } catch (e) {}
                await new Promise(r => setTimeout(r, 80));
                if (heldIsPick()) return true;
                try { await bot.tool.equipForBlock(block); } catch (e) {}
                await new Promise(r => setTimeout(r, 80));
                if (heldIsPick()) return true;
                write('dig.blocked', { seq, target: blockObj(block), reason: 'stony-without-held-pick' });
                return false;
            };
            const originalDig = bot.dig.bind(bot);
            bot.dig = async (block, ...args) => {
                const seq = ++bot._mineMotionSeq;
                const startedAt = Date.now();
                const support = supportObj();
                write('dig.begin', { seq, target: blockObj(block), args, support, env: envSnap() });
                if (!support.stable) {
                    write('dig.unsupported_before', { seq, target: blockObj(block), args, support, env: envSnap() });
                }
                if (!(await ensurePickForDig(block, seq))) {
                    const err = new Error(`stone dig blocked without held pick: ${block ? block.name : 'unknown'}`);
                    write('dig.end', { seq, ok: false, ms: Date.now() - startedAt, target: blockObj(block), error: err.message, env: envSnap() });
                    throw err;
                }
                bot._mineMotionActiveDig = { seq, stony: isStonyBlock(block), target: blockObj(block), startedAt };
                try {
                    const result = await originalDig(block, ...args);
                    write('dig.end', { seq, ok: true, ms: Date.now() - startedAt, target: blockObj(block), env: envSnap() });
                    return result;
                } catch (e) {
                    write('dig.end', { seq, ok: false, ms: Date.now() - startedAt, target: blockObj(block), error: e.message, env: envSnap() });
                    throw e;
                } finally {
                    if (bot._mineMotionActiveDig && bot._mineMotionActiveDig.seq === seq) bot._mineMotionActiveDig = null;
                }
            };
            const originalEquip = bot.equip.bind(bot);
            bot.equip = async (item, destination, ...args) => {
                const name = itemName(item);
                const hand = !destination || destination === 'hand';
                if (hand && name && !/_pickaxe$/.test(name) && activeStonyDig()) {
                    const seq = ++bot._mineMotionSeq;
                    if (!(await waitForStonyDig('equip', seq, { item: name, destination }))) {
                        throw new Error(`equip ${name} blocked during stony dig`);
                    }
                }
                return await originalEquip(item, destination, ...args);
            };
            const originalPlaceBlock = bot.placeBlock.bind(bot);
            bot.placeBlock = async (referenceBlock, faceVector, ...args) => {
                const seq = ++bot._mineMotionSeq;
                const startedAt = Date.now();
                const placeAt = referenceBlock && referenceBlock.position && faceVector
                    ? referenceBlock.position.offset(faceVector.x, faceVector.y, faceVector.z)
                    : null;
                write('place.begin', {
                    seq,
                    reference: blockObj(referenceBlock),
                    face: faceVector ? { x: faceVector.x, y: faceVector.y, z: faceVector.z } : null,
                    placeAt: posObj(placeAt),
                    args,
                    env: envSnap(),
                });
                if (inWaterNow()) {
                    const err = new Error('place blocked while swimming');
                    write('place.blocked', {
                        seq,
                        reason: 'in-water',
                        placeAt: posObj(placeAt),
                        placeBlock: blockObj(placeAt ? bot.blockAt(placeAt) : null),
                        env: envSnap(),
                    });
                    write('place.end', { seq, ok: false, ms: Date.now() - startedAt, placeAt: posObj(placeAt), error: err.message, env: envSnap() });
                    throw err;
                }
                if (!(await waitForStonyDig('place', seq, { placeAt: posObj(placeAt) }))) {
                    const err = new Error('place blocked during stony dig');
                    write('place.end', { seq, ok: false, ms: Date.now() - startedAt, placeAt: posObj(placeAt), error: err.message, env: envSnap() });
                    throw err;
                }
                try {
                    const result = await originalPlaceBlock(referenceBlock, faceVector, ...args);
                    write('place.end', { seq, ok: true, ms: Date.now() - startedAt, placeAt: posObj(placeAt), env: envSnap() });
                    return result;
                } catch (e) {
                    write('place.end', { seq, ok: false, ms: Date.now() - startedAt, placeAt: posObj(placeAt), error: e.message, env: envSnap() });
                    throw e;
                }
            };
            write('audit.installed', {});
        }
    },
    {
        name: 'act_trace',
        description: 'Telemetry: 1Hz dump of control states + current action — the missing "what keys is it pressing" feed.',
        interrupts: [],
        on: true,
        active: false,
        always: true,   // pure observer
        lastW: 0, sz: 0,
        update: async function (agent) {
            // ★监控系统自身的盲区修复 (用户: "你的监控与纠错系统也存在系统问题"——
            // bot 原地蹦跶 8 小时,我用死后黑匣子猜了 4 个机理全错,因为根本看不见
            // "它正在按什么键、哪个 action 在按"。这是行为心电图: 1Hz 落盘控制状态/
            // 当前动作/寻路状态/挖掘目标,任何"反复做 X"的怪行为直接读出主使者。)
            const bot = agent.bot;
            const now = Date.now();
            if (now - this.lastW < 1000) return;
            this.lastW = now;
            try {
                const cs = bot.controlState || {};
                const p = bot.entity.position;
                const line = JSON.stringify({
                    t: new Date().toISOString().slice(11, 19),
                    pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
                    g: bot.entity.onGround ? 1 : 0,
                    ctrl: ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].filter(k => cs[k]).join(',') || '-',
                    act: (agent.actions && agent.actions.currentActionLabel) || '-',
                    path: (bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()) ? 1 : 0,
                    dig: (bot.targetDigBlock && bot.targetDigBlock.name) || '-',
                }) + '\n';
                if (this.sz === 0) { try { this.sz = fs.statSync('bots/_supervisor/act_trace.jsonl').size; } catch (e) { this.sz = 1; } }
                if (this.sz > 10 * 1024 * 1024) { try { fs.renameSync('bots/_supervisor/act_trace.jsonl', 'bots/_supervisor/act_trace.jsonl.1'); } catch (e) {} this.sz = 1; }
                fs.appendFileSync('bots/_supervisor/act_trace.jsonl', line);
                this.sz += line.length;
            } catch (e) {}
        }
    },
    {
        name: 'motion_quality',
        description: 'Telemetry: movement+action QUALITY — air-swing rate, edge-stall ms, cross-efficiency. Lets us verify locomotion fixes with numbers, not eyeballs.',
        interrupts: [],
        on: true,
        active: false,
        always: true,   // pure observer
        installed: false,
        lastW: 0, sz: 0,
        swings: [], hits: [],
        lastPos: null, stallStart: 0, edgeStallMs: 0,
        winStart: 0, _disp: 0, _elapsed: 0,
        update: async function (agent) {
            // ★走位质量心电图 (用户第三视角实拍: bot 卡台阶边、对空挥、跨地形难). act_trace
            // 记"按了什么键"但看不出"挥了却没打中(空挥)"或"想走却没位移(卡边)"。这里一次性
            // 包裹 bot.attack 计挥击、监听 entityHurt 计命中,5s 汇总: 空挥率 / 台阶卡死 ms /
            // 平均移动速度(跨地形效率)。修完 locomotion 用数字验证,而非肉眼"感觉好点了"。
            const bot = agent.bot;
            const now = Date.now();
            if (!this.installed && bot && bot.entity) {
                this.installed = true;
                try {
                    const self = this;
                    const origAttack = bot.attack.bind(bot);
                    bot.attack = function (entity, ...rest) {
                        try { self.swings.push({ t: Date.now(), id: entity && entity.id }); } catch (e) {}
                        return origAttack(entity, ...rest);
                    };
                    bot.on('entityHurt', (e) => {
                        try { if (e && e !== bot.entity) self.hits.push({ t: Date.now(), id: e.id }); } catch (er) {}
                    });
                } catch (e) {}
                this.winStart = now;
            }
            if (now - this.lastW < 1000) return;
            this.lastW = now;
            try {
                const cs = bot.controlState || {};
                const p = bot.entity.position;
                const moving = (bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()) || !!cs.forward;
                // ★edgeStall must measure ONLY a real travel WEDGE (trying to walk, zero horizontal
                // progress, NOT digging). The raw "horizontal d<0.1 while moving" conflated 3 things:
                // (a) real step-wedge [the bug], (b) vertical mining (digDown — x/z static by design),
                // (c) destructive-path dig-through (pathfinder mines the block in its way). (b)+(c)
                // are PROGRESS, not stalls — excluding targetDigBlock leaves only (a), the metric we
                // verify edge_unstick against. (Mirrors edge_unstick's own targetDigBlock gate.)
                if (this.lastPos) {
                    const d = Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z);
                    if (moving && d < 0.1 && !bot.targetDigBlock) { if (!this.stallStart) this.stallStart = now; this.edgeStallMs = now - this.stallStart; }
                    else { this.stallStart = 0; this.edgeStallMs = 0; }
                    this._disp += d; this._elapsed += 1;
                }
                this.lastPos = { x: p.x, z: p.z };

                if (now - this.winStart >= 5000) {
                    const since = this.winStart;
                    const swings = this.swings.filter(s => s.t >= since);
                    let air = 0;
                    for (const s of swings) {
                        const hit = this.hits.some(h => h.id === s.id && h.t >= s.t - 50 && h.t <= s.t + 700);
                        if (!hit) air++;
                    }
                    const crossEff = this._elapsed ? +(this._disp / this._elapsed).toFixed(2) : 0; // avg blocks/sec
                    const line = JSON.stringify({
                        t: new Date().toISOString().slice(11, 19),
                        swings: swings.length,
                        airSwings: air,
                        airRate: swings.length ? +(air / swings.length).toFixed(2) : 0,
                        edgeStallMs: this.edgeStallMs,
                        crossEff,
                        path: moving ? 1 : 0,
                        act: (agent.actions && agent.actions.currentActionLabel) || '-',
                        mob: (bot._mobility && bot._mobility.state) || '-',
                    }) + '\n';
                    this.swings = this.swings.filter(s => s.t >= now - 10000);
                    this.hits = this.hits.filter(h => h.t >= now - 10000);
                    this._disp = 0; this._elapsed = 0; this.winStart = now;
                    if (this.sz === 0) { try { this.sz = fs.statSync('bots/_supervisor/motion_quality.jsonl').size; } catch (e) { this.sz = 1; } }
                    if (this.sz > 10 * 1024 * 1024) { try { fs.renameSync('bots/_supervisor/motion_quality.jsonl', 'bots/_supervisor/motion_quality.jsonl.1'); } catch (e) {} this.sz = 1; }
                    fs.appendFileSync('bots/_supervisor/motion_quality.jsonl', line);
                    this.sz += line.length;
                }
            } catch (e) {}
        }
    },
    {
        name: 'edge_unstick',
        description: 'Recovery reflex for the step-stall the user reported for a week: when the pathfinder WANTS to travel but the body is wedged against a 1-2 block step (zero horizontal progress), jump to mount it like a human; if still wedged, drop the path so the caller replans. Closes the loop motion_quality only measured.',
        interrupts: [],
        on: true,
        active: false,
        always: true,   // continuous low-level reflex — sets control states, never takes over execution
        lastTick: 0, lastPos: null, wedgeStart: 0, jumpUntil: 0, lastReset: 0, resetStreak: 0, lastJumpLogAt: 0, jumpCount: 0,
        update: async function (agent) {
            // ★用户第三视角实拍+怒斥(观察一周,喊修4-5次未果): bot 上 1 格台阶"有时卡住",2 格更久。
            // 取证(motion_quality.jsonl): edgeStallMs>1000 历史 1609 次,最严重 path=1 crossEff=0 楔死
            // 20822ms / 18389ms(含 self_preservation 中)。机理: prismarine-physics stepHeight=0.6,
            // bot 走路登不上整 1 格,必须靠 pathfinder 主动 jump;角落/斜approach/raw控制时 jump 没排上
            // 或错时 → 顶着台阶 d≈0 楔死。motion_quality 只测不动(纯observer,注释自陈"修完用数字验证")
            // → 缺的就是这个恢复反射。人类做法=遇台阶就跳;跳不出(墙/角)就换路。stepHeight 不动(真人
            // 不能不跳滑上整格=作弊感),只补"跳"这个人类动作。
            const bot = agent.bot;
            const now = Date.now();
            if (now - this.lastTick < 250) return;   // ~4Hz: 够快反应,够轻
            this.lastTick = now;
            const releaseJump = () => { if (this.jumpUntil) { this.jumpUntil = 0; try { bot.setControlState('jump', false); } catch (e) {} } };
            try {
                if (!bot || !bot.entity || !bot.entity.position) return;
                // ★CAPPED-HEAD BREAKER (用户 2026-06-20 实拍: 脚底薄水+头顶一块土+面前台阶,
                // self_preservation 原地狂跳想出水却被头顶封住,出不来). 独立于下面所有门控(尤其
                // SWIM 的 early-return)运行 —— 只要 bot 想上升(按jump/在水里/寻路在走)却被头顶一块
                // 可破实心块封住且~静止,就破掉它(土/沙/砾石徒手秒破;陶瓦/石头需镐;破不动则不动)。
                // 这是"破块"能力,self_preservation/mobility 的水逃/挖反射都不具备 → 必须独立兜底。
                {
                    const _solid = (b) => b && b.boundingBox === 'block';
                    const p0 = bot.entity.position, fl0 = p0.floored();
                    const moved0 = this._chLastPos ? Math.hypot(p0.x - this._chLastPos.x, p0.z - this._chLastPos.z) : 1;
                    this._chLastPos = { x: p0.x, y: p0.y, z: p0.z };
                    let wantsUp = false;
                    try { wantsUp = !!(bot.entity.controlState && bot.entity.controlState.jump); } catch (e) {}
                    if (!wantsUp) { try { wantsUp = !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()); } catch (e) {} }
                    if (!wantsUp) { try { wantsUp = /water/.test((bot.blockAt(fl0) || {}).name || ''); } catch (e) {} }
                    const cap0 = bot.blockAt(fl0.offset(0, 2, 0));
                    if (!this._chDigBusy && wantsUp && _solid(cap0) && moved0 < 0.06 && !bot.targetDigBlock) {
                        if (!this._chStuckSince) this._chStuckSince = now;
                        const hasPick0 = (() => { try { return bot.inventory.items().some(i => /_pickaxe$/.test(i.name || '')); } catch (e) { return false; } })();
                        const hard0 = (b) => /stone|deepslate|terracotta|andesite|diorite|granite|tuff|_ore$|obsidian|cobble|basalt|blackstone|netherrack|end_stone|prismarine|brick|concrete|amethyst|copper/.test((b && b.name) || '');
                        const keep0 = (b) => /bedrock|barrier|chest|furnace|crafting_table|_bed$|door|sign|portal|spawner|enchanting/.test((b && b.name) || '');
                        if (now - this._chStuckSince > 900 && now - (this._chLastBreakAt || 0) > 700 && !keep0(cap0) && (!hard0(cap0) || hasPick0)) {
                            this._chLastBreakAt = now; this._chDigBusy = true;
                            const ob0 = cap0;
                            (async () => { try { await bot.dig(ob0, true); } catch (e) {} finally { this._chDigBusy = false; this._chStuckSince = 0; } })();
                            if (now - (this._chLogAt || 0) > 8000) { this._chLogAt = now; try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [edge_unstick] capped-head break ${ob0.name}@${ob0.position.x},${ob0.position.y},${ob0.position.z} (jump/swim/path blocked)\n`); } catch (e) {} }
                        }
                    } else if (!(wantsUp && _solid(cap0) && moved0 < 0.06)) { this._chStuckSince = 0; }
                }
                // 介入条件 = "想动却动不了"。寻路器在走是权威信号,但★用户 2026-06-20 实拍证明
                // 不够: bot 脚底薄水+头顶土块,self_preservation 原地狂跳想出水却被头顶封住,pathfinder
                // 没在走 → 旧门控漏掉 → headroom-break 永不触发。所以放宽: 按着 jump(想上升)或在水里
                // (想出水)也算"想动",让 headroom-break/replan 在 self_preservation 等驱动下也能解困。
                // 仍靠下面 600ms 零水平位移的 wedge 判定区分真楔死 vs 正常移动,不误伤。
                const pfMoving = !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving());
                let jumpPressed = false; try { jumpPressed = !!(bot.entity.controlState && bot.entity.controlState.jump); } catch (e) {}
                let inWater = false; try { const _fb = bot.blockAt(bot.entity.position.floored()); inWater = /water/.test((_fb && _fb.name) || ''); } catch (e) {}
                const moving = pfMoving || jumpPressed || inWater;
                if (!moving) { this.wedgeStart = 0; this.lastPos = null; this.resetStreak = 0; releaseJump(); return; }
                // 别跟有意的静止打架: 正在挖块/游泳/被困(POCKET/ENTOMBED 有各自反射)
                if (bot.targetDigBlock) { this.wedgeStart = 0; this.lastPos = null; releaseJump(); return; }
                const mob = (bot._mobility && bot._mobility.state) || '';
                if (mob === 'SWIM' || mob === 'POCKET' || mob === 'ENTOMBED') { this.wedgeStart = 0; this.lastPos = null; releaseJump(); return; }
                const p = bot.entity.position;
                if (this.lastPos) {
                    const d = Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z);
                    if (d < 0.05) { if (!this.wedgeStart) this.wedgeStart = now; }
                    else { this.wedgeStart = 0; this.resetStreak = 0; releaseJump(); }   // 在前进 → 清零
                }
                this.lastPos = { x: p.x, y: p.y, z: p.z };
                if (!this.wedgeStart) return;
                const stalled = now - this.wedgeStart;
                const solid = (b) => b && b.boundingBox === 'block';
                // 楔住 ≥600ms + 在地面 + 头顶有空间可起跳 → 跳(人遇台阶就跳)。不分析具体朝向几何:
                // 多余的跳无害(原地一跳),关键是覆盖所有 step/角落;头顶实心(overSelf)才不跳(只会顶头)。
                if (stalled >= 600 && bot.entity.onGround) {
                    const overSelf = bot.blockAt(p.floored().offset(0, 2, 0));
                    if (!solid(overSelf)) {
                        this.jumpUntil = now + 450;
                        try { bot.setControlState('jump', true); } catch (e) {}
                        this.jumpCount = (this.jumpCount || 0) + 1;
                        // throttled positive-verification log (jumps are normally silent to avoid spam):
                        // proves the reflex is firing on real wedges and how often.
                        if (now - this.lastJumpLogAt > 15000) {
                            this.lastJumpLogAt = now;
                            try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [edge_unstick] step-jump #${this.jumpCount} (wedged ${Math.round(stalled)}ms) @${p.x.toFixed(1)},${Math.round(p.y)},${p.z.toFixed(1)}\n`); } catch (e) {}
                        }
                    }
                }
                if (this.jumpUntil && now > this.jumpUntil) releaseJump();
                // ★HEADROOM-BREAK (用户 2026-06-20 实拍: "她头顶有一个方块,通道不够跳起来过去"):
                // 楔住的不是普通台阶 —— 头顶有块(overSelf 实心→上面的 jump 分支被跳过,永远不跳)或
                // 台阶上方天花板太低,跳也钻不过去。跳永远解不了,要**破掉那个挡住爬升的块**(土/沙/砾石
                // 徒手秒破;陶瓦/石头/无镐则破不动→落到下面 replan 重路)。精确 gate: 必须"前方有台阶
                // (脚位实心)+爬升被头顶/台阶顶天花板挡住"才破,不乱挖普通隧道顶。busy-guard 异步挖。
                if (stalled >= 900 && bot.entity.onGround && !this._digBusy) {
                    const fl = p.floored();
                    const hasPick = (() => { try { return bot.inventory.items().some(i => /_pickaxe$/.test(i.name || '')); } catch (e) { return false; } })();
                    const hard = (b) => /stone|deepslate|terracotta|andesite|diorite|granite|tuff|_ore$|obsidian|cobble|basalt|blackstone|netherrack|end_stone|prismarine|brick|concrete|amethyst|copper/.test((b && b.name) || '');
                    const keep = (b) => /bedrock|barrier|chest|furnace|crafting_table|_bed$|door|sign|portal|spawner|enchanting/.test((b && b.name) || '');
                    const breakable = (b) => solid(b) && !keep(b) && (!hard(b) || hasPick);
                    const overSelf2 = bot.blockAt(fl.offset(0, 2, 0));
                    let obstr = null;
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        const fFoot = bot.blockAt(fl.offset(dx, 0, dz));
                        if (!solid(fFoot)) continue;                       // 需前方脚位有台阶(实心)
                        if (breakable(overSelf2)) { obstr = overSelf2; break; }   // 头顶挡住起跳
                        const fCeil = bot.blockAt(fl.offset(dx, 2, dz));
                        if (breakable(fCeil)) { obstr = fCeil; break; }    // 台阶上方天花板挡住钻过
                    }
                    if (obstr) {
                        this._digBusy = true;
                        const ob = obstr;
                        (async () => {
                            try { await bot.dig(ob, true); } catch (e) {}
                            finally { this._digBusy = false; this.wedgeStart = 0; }
                        })();
                        if (now - (this.lastBreakLogAt || 0) > 8000) {
                            this.lastBreakLogAt = now;
                            try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [edge_unstick] headroom-break ${ob.name}@${ob.position.x},${ob.position.y},${ob.position.z} (wedged ${Math.round(stalled)}ms, low-ceiling step)\n`); } catch (e) {}
                        }
                    }
                }
                // 升级: 跳了还楔死(墙/角陷阱/错路). 第1次 replan 丢当前路径让寻路重算;但 live 实测
                // (07:13 @-35.5,48): 同一处重算又选同样堵死路线→原地弹跳 5×replan/20s。所以**再楔
                // (resetStreak≥2)就物理后退+侧移脱离楔死几何**,让下一次重算从不同位置出发选不同路线。
                // 后退方向=bot 来时的已知可通行地(它正朝前楔住),低风险;600ms 后清控制让寻路/march 接管。
                if (stalled >= 2200 && now - this.lastReset > 2500) {
                    this.lastReset = now;
                    this.resetStreak = (this.resetStreak || 0) + 1;
                    releaseJump();
                    try { bot.pathfinder.stop(); } catch (e) {}
                    if (this.resetStreak >= 2) {
                        try {
                            bot.clearControlStates();
                            bot.setControlState('back', true);
                            bot.setControlState(this.resetStreak % 2 ? 'left' : 'right', true);
                            setTimeout(() => { try { bot.clearControlStates(); } catch (e) {} }, 600);
                        } catch (e) {}
                    }
                    try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [edge_unstick] wedged ${Math.round(stalled)}ms (jump-fail, replan #${this.resetStreak}${this.resetStreak >= 2 ? ' +back-off relocate' : ''}) @${p.x.toFixed(1)},${Math.round(p.y)},${p.z.toFixed(1)}\n`); } catch (e) {}
                    this.wedgeStart = 0;
                }
            } catch (e) {}
        }
    },
    {
        name: 'world_model',
        description: 'Phase-2 READ-ONLY central WORLD MODEL (docs/world-model.md): god-view aggregation of situational truth — time/mobility/threat/vitals/kit/cover/surfaceGate — into bot._world, broadcast to world_model.json. Single source of truth for the LLM supervisor + all layers. Phase 2 computes+broadcasts ONLY; changes NO behavior (the surfaceGate is advisory here, wired to act in Phase 3+).',
        interrupts: [],
        on: true,
        active: false,
        always: true,   // pure observer in Phase 2
        lastEval: 0, lastWrite: 0, lastHp: null, hpDropAt: 0,
        update: async function (agent) {
            const bot = agent.bot;
            const now = Date.now();
            if (now - this.lastEval < 2000) return;
            this.lastEval = now;
            try {
                if (!bot || !bot.entity || !bot.entity.position) return;
                const p = bot.entity.position;
                const m = p.floored();
                const solid = (b) => b && b.boundingBox === 'block';
                // --- time ---
                const tod = (bot.time && bot.time.timeOfDay) ?? 0;
                const isNight = tod >= 13000 && tod < 23000;
                const isDusk = tod >= 12000 && tod < 13000;
                const isDawn = tod >= 23000;
                const phase = isNight ? 'night' : (isDusk ? 'dusk' : (isDawn ? 'dawn' : 'day'));
                // --- vitals ---
                const hp = Math.round(bot.health ?? 0);
                const food = bot.food ?? 0;
                let armor = 0;
                try { for (const it of bot.inventory.items()) { if (/_helmet$|_chestplate$|_leggings$|_boots$/.test(it.name || '')) armor++; } } catch (e) {}
                try { const sl = bot.inventory.slots || []; for (let i = 5; i <= 8; i++) { const s = sl[i]; if (s && /_helmet$|_chestplate$|_leggings$|_boots$/.test(s.name || '')) armor++; } } catch (e) {}
                let normalEdible = false;
                try { normalEdible = bot.inventory.items().some(i => i && i.name && NORMAL_FOOD_RE.test(i.name)); } catch (e) {}
                const canRegen = food >= 18;
                if (this.lastHp === null) this.lastHp = hp;
                if (hp < this.lastHp) this.hpDropAt = now;
                this.lastHp = hp;
                const takingDamage = (now - (bot.lastDamageTime || 0) < 4000) || (now - this.hpDropAt < 4000);
                // --- threat ---
                let hostiles = 0, closest = Infinity, creeperDist = Infinity, swarm = 0, phantomNear = false, actionable = 0;
                try {
                    for (const id in bot.entities) {
                        const e = bot.entities[id];
                        if (!e || e === bot.entity || !e.position || !mc.isHostile(e)) continue;
                        const d = e.position.distanceTo(p);
                        if (d < 16) hostiles++;
                        if (d < closest) closest = d;
                        if (/creeper/.test(e.name || '') && d < creeperDist) creeperDist = d;
                        if (/phantom/.test(e.name || '') && d < 16) phantomNear = true;
                        if (d < 10) swarm++;
                        if (d < 12 && Math.abs(e.position.y - p.y) <= 4) actionable++;   // reachable/level threat (C34 spirit)
                    }
                } catch (e) {}
                // --- mobility (★Phase-3: SELF-computed so the model never shows "?" when the
                // mobility interrupt mode is starved during a self_preservation hold — an always:true
                // observer must not depend on a starvable interrupt mode for a core field. MAROONED
                // needs pathfinder-failure history the mobility mode owns → defer to it for that.) ---
                let mob;
                try {
                    const exits = [];
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        if (solid(bot.blockAt(m.offset(dx, 0, dz))) || solid(bot.blockAt(m.offset(dx, 1, dz)))) continue;
                        let floor = false;
                        for (let dd = 1; dd <= 4; dd++) { const fb = bot.blockAt(m.offset(dx, -dd, dz)); if (solid(fb) || /water/.test((fb && fb.name) || '')) { floor = true; break; } }
                        if (floor) exits.push([dx, dz]);
                    }
                    const upOpen = !solid(bot.blockAt(m.offset(0, 2, 0)));
                    const inWater = /water/.test((bot.blockAt(m) || {}).name || '') || /water/.test((bot.blockAt(m.offset(0, 1, 0)) || {}).name || '');
                    let enc = true;
                    encScan:
                    for (const ddx of [-4, 0, 4]) {
                        for (const ddz of [-4, 0, 4]) {
                            let cov = false;
                            for (let dy = 2; dy <= 36; dy++) { const cb = bot.blockAt(m.offset(ddx, dy, ddz)); if (cb && cb.boundingBox === 'block') { cov = true; break; } }
                            if (!cov) { enc = false; break encScan; }
                        }
                    }
                    let st = inWater ? 'SWIM' : (exits.length ? 'FREE' : ((upOpen && enc) ? 'POCKET' : (upOpen ? 'FREE' : 'ENTOMBED')));
                    if (bot._mobility && bot._mobility.state === 'MAROONED') st = 'MAROONED';
                    mob = { state: st, enclosed: enc, exits };
                } catch (e) { mob = bot._mobility || { state: '?', enclosed: false, exits: [] }; }
                // --- cover --- (real roof = solid CLOSE above; blocks aerial/phantom, vs the loose 2-6 "overhead")
                let overhead = false;
                // ★C296: leaves/vines are NOT a roof (jungle/forest canopy ≠ shelter) — exclude them so
                // the world model doesn't report cover.overhead/coverReal under foliage, which made the
                // bunker layer skip digging in and the bot dwell exposed-but-"covered" at night (用户实拍).
                const roofSolid = (b) => solid(b) && !/_leaves$|^leaves$|vine|mangrove_roots|azalea/.test((b && b.name) || '');
                try { for (let dy = 2; dy <= 6; dy++) { if (roofSolid(bot.blockAt(m.offset(0, dy, 0)))) { overhead = true; break; } } } catch (e) {}
                const coverReal = roofSolid(bot.blockAt(m.offset(0, 2, 0))) || roofSolid(bot.blockAt(m.offset(0, 3, 0)));
                // --- kit ---
                let picks = 0; let bestTier = 0;
                const tierRank = { wooden: 1, stone: 2, golden: 1, iron: 3, diamond: 4, netherite: 5 };
                const tierName = ['none', 'wooden', 'stone', 'iron', 'diamond', 'netherite'];
                try {
                    for (const it of bot.inventory.items()) {
                        if (!/_pickaxe$/.test(it.name)) continue;
                        const max = it.maxDurability || 0;
                        const used = (typeof it.durabilityUsed === 'number') ? it.durabilityUsed : 0;
                        if (!max || (used / max) < 0.85) picks++;   // effective picks (mirror vitals pickFx)
                        const t = tierRank[(it.name.split('_')[0])] || 0;
                        if (t > bestTier) bestTier = t;
                    }
                } catch (e) {}
                let counts = {}; try { counts = world.getInventoryCounts(bot); } catch (e) {}
                const planksMax = Math.max(0, ...Object.keys(counts).filter(k => k.endsWith('_planks')).map(k => counts[k] || 0));
                const logs = Object.keys(counts).filter(k => k.endsWith('_log')).reduce((s, k) => s + (counts[k] || 0), 0);
                let tableNear = false; try { tableNear = !!world.getNearestBlock(bot, 'crafting_table', 4); } catch (e) {}
                const hasTablePath = (counts['crafting_table'] || 0) > 0 || tableNear || planksMax >= 4 || logs > 0;
                const cobble = counts['cobblestone'] || 0;
                const torches = counts['torch'] || 0;
                const foodSufficient = food >= 14 || normalEdible;
                // ★镐够本下矿: ≥1 有效镐 且 (有备镐 或 能就地补镐) — 不在"最后一把镐"红线(memory resource-floor)
                // ★C290 (bare-kit-gate, T-0025): a SINGLE WOODEN pick is NOT enough to venture under-
                // ground — it snaps in ~59 uses, and the bot ends up pickless in a cramped pocket
                // where it can't even PLACE a table to re-craft (live 2026-06-20: wooden pick broke at
                // y35, MAROONED, had cobble14+stick9+table2 but "★C258 table unplaceable in pocket" →
                // "NO KNOWN WAY to obtain stone_pickaxe" → re-deadlock, the recurring tomb). hasTablePath
                // is a LIE underground (tables won't place in 1-wide shafts). Align the descent gate with
                // isBootstrapDone (which already requires stone-tier): require a DURABLE pick (stone+) OR
                // a spare (picks>=2), so one breaking underground never strands the bot. A lone wooden
                // pick now keeps the bot on the SURFACE (where tables DO place) to craft stone tools first.
                const durablePick = bot.inventory.items().some(it => /^(stone|iron|diamond|netherite)_pickaxe$/.test(it.name || ''));
                // ★RECOVERY-KIT GATE (resource-floor root fix, T-0060 石棺死锁): the comment above
                // PROMISES "spare pick OR 能就地补镐(can-recraft-in-place)" but the gate only ever checked
                // the pick — a bot with ONE durable pick + no wood descended, wore it out deep, and could
                // NOT craft a replacement (no carried table, no planks for sticks underground; a far
                // surface table is useless deep) → the recurring no-pick tomb. Add the missing half:
                // to keep mining deep on a LONE pick the bot must be able to recraft one WITHOUT surfacing
                // — cobble (gathered free underground) + sticks(or planks for them) + a CARRIED table (or
                // enough planks to make one; tableNear is a lie deep). Crucially this closes the gate while
                // the pick STILL WORKS and wood is merely low, so the bot surfaces to restock WITH a pick
                // (can dig back up) instead of getting stranded pickless. A real spare (picks>=2) still
                // passes outright (existing allowance).
                const sticks = counts['stick'] || 0;
                const carriedTable = (counts['crafting_table'] || 0) > 0;
                const woodForRecraft = planksMax + logs * 4;                 // planks on hand + logs→4 planks each
                const planksToRecraft = (carriedTable ? 0 : 4) + (sticks >= 2 ? 0 : 2);  // table (if none) + sticks (if none)
                const canRecraftPick = cobble >= 3 && woodForRecraft >= planksToRecraft;
                // ★T-0088/T-0012 BYPASS GAP (tier-wood relapse smoking gun, 06-25): the old tail was
                // `(picks >= 2 || canRecraftPick)` — a raw picks>=2 count bypassed the can-recraft check.
                // But N picks ALL break: a bot descended with 4 (worn) stone picks + 136 cobble + 2 planks
                // + NO table, ground every pick to dust underground (tool_keeper couldn't recraft — a stone
                // pick needs a 3x3 table and 2 planks can't build one), went pickless → tier relapsed to
                // wood → enclosed石棺. A spare only protects you if you can MAKE the NEXT one once it wears:
                // that means a CARRIED TABLE (turn mined cobble+sticks into picks anywhere) — not just a
                // count. So the spare allowance now also requires carriedTable; without it, fall through to
                // canRecraftPick (which already demands enough wood to BUILD a table). Healthy bots are
                // unaffected: 2+ picks WITH a carried table still pass; a table-less bot that can craft one
                // (≥4 planks / a log) passes via canRecraftPick; only "multi-pick + no table + no wood to
                // make one" is now correctly gated to surface for wood FIRST (resource-floor kit, T-0060).
                const sufficientForUnderground = picks >= 1 && (durablePick || picks >= 2) && ((picks >= 2 && carriedTable) || canRecraftPick);
                // --- depth band ---
                const y = Math.round(p.y);
                const depthBand = y >= 62 ? 'surface' : (y >= 40 ? 'shallow' : (y >= 16 ? 'mid' : 'deep'));
                // --- migration (coarse) ---
                let inDeathZone = false, biome = 'unknown';
                try {
                    const adv = JSON.parse(fs.readFileSync('bots/_supervisor/advisory.json', 'utf8'));
                    if (adv && adv.dzone) inDeathZone = Math.hypot(p.x - adv.dzone.cx, p.z - adv.dzone.cz) <= (adv.dzone.r || 0);
                } catch (e) {}
                try { biome = world.getBiomeName(bot); } catch (e) {}
                // recommend migration when the biome itself is unlivable (snowy/frozen/ice → no land
                // animals → no sheep → no bed → respawn forever returns to the death-zone; THE unlock
                // is migrating to a temperate biome with sheep, see migrate.js/C263) OR inside the
                // death cluster.
                const badBiome = /snow|frozen|ice|ocean|deep_/i.test(biome || '');
                // ★C347 (T-0096): STUCK-TERRAIN RELOCATE. The biome-only recommend can't see "net
                // progress ≈ 0 because local terrain (aquifer / shattered shallow) keeps interrupting
                // mining" — savanna passes badBiome=false so the bot grinds the same wet pocket for
                // hours (live 06-25: 229 ENTOMBED/SEALED unstick events in 69min, raw_iron 0/7,
                // mining-signal ~0, migrate.recommend stayed false). Add a third trigger orthogonal to
                // biome: a HIGH unstick frequency that PERSISTS while NET mining progress stalls.
                //   net-progress proxy = raw_iron count + whether we've reached the deep iron band (y<16).
                //   Tracked across ticks on bot; when it climbs we reset the stall clock (real progress
                //   → don't relocate). When unstick-thrash is high AND the proxy hasn't moved for ~8min,
                //   recommend relocate so the decision layer (MIGRATE) moves the bot to fresh ground
                //   instead of treading water. Gated to NON-deep bands: a bot that actually descended to
                //   y<16 is mining, not stuck on the surface aquifer.
                let stuckTerrain = false;
                try {
                    const rawIron = (counts['raw_iron'] || 0) + (counts['iron_ore'] || 0) + (counts['deepslate_iron_ore'] || 0);
                    const reachedDeep = y < 16;
                    const progressProxy = rawIron + (reachedDeep ? 100 : 0);   // descending to the iron band counts as progress
                    const recentStuck = (bot._stuckEvents || []).filter(t => now - t < 480000).length;   // unstick events in last 8min
                    if (!bot._netProg || progressProxy > bot._netProg.proxy) {
                        bot._netProg = { proxy: progressProxy, since: now };   // progress climbed → reset the stall clock
                    }
                    const stalledMs = now - (bot._netProg.since || now);
                    // ≥12 unstick events in 8min (thrash) + proxy flat ≥8min + not already in the deep
                    // mining band + on the surface/shallow/mid where relocating actually helps.
                    // Latch for ~5min once tripped so the MIGRATE commitment isn't yanked away mid-walk
                    // by the rolling window briefly dipping under threshold (migrate.js needs a stable
                    // recommend to finish the relocate); cleared when it actually reaches a fresh spot.
                    const rawTrip = recentStuck >= 12 && stalledMs >= 480000 && !reachedDeep && y >= 30;
                    if (rawTrip && now - (bot._stuckTerrainLatchAt || 0) > 300000) {
                        bot._stuckTerrainLatchAt = now;
                        bot._stuckTerrainOrigin = { x: Math.round(p.x), z: Math.round(p.z) };
                    }
                    // active while latched AND we haven't yet travelled clear of the stuck origin (>32b)
                    if (bot._stuckTerrainLatchAt && now - bot._stuckTerrainLatchAt < 300000) {
                        const o = bot._stuckTerrainOrigin;
                        const movedClear = o && Math.hypot(p.x - o.x, p.z - o.z) > 32;
                        if (movedClear || reachedDeep) {
                            // relocated to fresh ground (or finally descended) → drop the latch + reset clocks
                            bot._stuckTerrainLatchAt = 0; bot._stuckEvents = []; bot._netProg = { proxy: progressProxy, since: now };
                        } else {
                            stuckTerrain = true;
                        }
                    }
                } catch (e) {}
                const migration = { biome, badBiome, inDeathZone, stuckTerrain, recommend: badBiome || inDeathZone || stuckTerrain };
                // --- surfaceGate (AUTO; supervisor override read from advisory.surfaceGate) ---
                let gateMode = 'free', gateReason = 'safe day', decidedBy = 'auto', gateUntil = 0;
                try {
                    const adv = JSON.parse(fs.readFileSync('bots/_supervisor/advisory.json', 'utf8'));
                    const sg = adv && adv.surfaceGate;
                    if (sg && sg.mode === 'committed_underground' && (!sg.until || now < sg.until)) {
                        gateMode = 'committed_underground'; gateReason = sg.reason || 'supervisor commit'; decidedBy = 'supervisor'; gateUntil = sg.until || 0;
                    }
                } catch (e) {}
                if (decidedBy === 'auto') {
                    if (isNight || isDusk) { gateMode = 'hold'; gateReason = 'night/dusk'; }
                    else if (actionable > 0) { gateMode = 'hold'; gateReason = `actionable threat x${actionable}`; }
                    // ★C289: a PICKLESS bot (picks==0) must NOT be held underground — surfacing to
                    // get wood→pick is its only escape from the resource floor. Live 2026-06-20 (T-0012
                    // catch-22): y60 pocket, daylight, 0 pick/wood/table, surfaceGate held "kit
                    // insufficient (picks)" → she never surfaced to get the wood that makes the pick →
                    // permanent deadlock. hold should block going DOWN (deep-mine — already gated by
                    // sufficientForUnderground in proposeTasks), NOT going UP. So free a 0-pick bot to
                    // surface (this branch only reached when it's already day + no actionable threat).
                    // A bot WITH a pick but under-kitted (picks>=1) keeps the normal hold.
                    else if (!sufficientForUnderground) {
                        if (picks === 0) { gateMode = 'free'; gateReason = 'bootstrap: surface for wood→pick'; }
                        else { gateMode = 'hold'; gateReason = 'kit insufficient (picks)'; }
                    }
                    else if (!foodSufficient) { gateMode = 'hold'; gateReason = 'low food'; }
                    else { gateMode = 'free'; gateReason = 'safe day, kitted'; }
                }
                const allowSurface = gateMode === 'free';
                // --- recommendation ---
                let action;
                if (gateMode === 'committed_underground') action = 'GO_UNDERGROUND';
                else if (actionable > 0 && hp < 10) action = 'FLEE';
                else if (gateMode === 'hold') action = 'HOLD';
                else if (migration.recommend && phase === 'day') action = 'MIGRATE';
                else if (!foodSufficient) action = 'FORAGE_SURFACE';
                else if (picks === 0) action = 'FORAGE_SURFACE';   // ★C289 bootstrap: surface for wood→pick, never auto-descend pickless
                else action = 'GO_UNDERGROUND';
                // ★C328 (用户架构批评"世界模型对资源把握差"): RESOURCE/LANDMARK MEMORY. The world model
                // had ZERO spatial memory — no village/bed/water tracking — so the bot kept "forgetting"
                // a village with beds ~30b away (用户实证: 附近村庄有床却不知道/不用). Scan key landmarks on
                // a throttle, accumulate them in a PERSISTENT store (landmarks.json, survives respawn/
                // restart), and surface nearest-known to bot._world.landmarks so skills (C327 sleep) + the
                // proposer can navigate BACK to remembered resources instead of only live-sensing 24b.
                try {
                    if (!bot._landmarks) { try { bot._landmarks = JSON.parse(fs.readFileSync('bots/_supervisor/landmarks.json', 'utf8')); } catch (e) { bot._landmarks = {}; } }
                    if (!bot._lastLmScan || now - bot._lastLmScan > 12000) {
                        bot._lastLmScan = now;
                        let dirty = false;
                        const reg = (kind, x, y, z, meta) => {
                            const key = `${kind}@${Math.round(x)},${Math.round(y)},${Math.round(z)}`;
                            if (!bot._landmarks[key]) { bot._landmarks[key] = { kind, x: Math.round(x), y: Math.round(y), z: Math.round(z), ts: now, seen: now, meta: meta || null }; dirty = true; }
                            else { bot._landmarks[key].seen = now; if (meta) bot._landmarks[key].meta = meta; }
                        };
                        try { for (const bp of bot.findBlocks({ matching: (b) => b && /_bed$/.test(b.name || ''), maxDistance: 48, count: 16 })) reg('bed', bp.x, bp.y, bp.z); } catch (e) {}
                        try { for (const e of Object.values(bot.entities || {})) { if (e && /villager/.test(e.name || '') && e.position) reg('village', e.position.x, e.position.y, e.position.z); } } catch (e) {}
                        try { for (const bp of bot.findBlocks({ matching: (b) => b && /^(crafting_table|furnace|bell)$/.test(b.name || ''), maxDistance: 48, count: 8 })) { const bn = bot.blockAt(bp); reg(bn && bn.name === 'bell' ? 'village' : ((bn && bn.name) || 'craft'), bp.x, bp.y, bp.z); } } catch (e) {}
                        // ★opening-spec C328 multi-kind: the scanner only knew bed/village/craft. The
                        // OPENING decision (SCOUT/WOOD_BUFFER/VILLAGE_HARVEST) needs to remember WOOD
                        // (nearest tree for the bootstrap pick), CROPS/FARMLAND (village food), CHESTS
                        // (loot/storage), and ANIMALS (cow/pig/sheep/chicken → meat+wool→bed). Register
                        // each as a distinct landmark kind so _nearLm('wood'|'crops'|'chest'|'animal')
                        // can navigate the bot BACK to bootstrap resources instead of dead-reckoning.
                        try { for (const bp of bot.findBlocks({ matching: (b) => b && /_log$/.test(b.name || ''), maxDistance: 32, count: 8 })) reg('wood', bp.x, bp.y, bp.z); } catch (e) {}
                        try { for (const bp of bot.findBlocks({ matching: (b) => b && /^(hay_block|wheat|carrots|potatoes|beetroots|farmland)$/.test(b.name || ''), maxDistance: 32, count: 8 })) reg('crops', bp.x, bp.y, bp.z); } catch (e) {}
                        try { for (const bp of bot.findBlocks({ matching: (b) => b && /^(chest|barrel)$/.test(b.name || ''), maxDistance: 48, count: 8 })) reg('chest', bp.x, bp.y, bp.z); } catch (e) {}
                        try { for (const e of Object.values(bot.entities || {})) { if (e && /^(cow|pig|sheep|chicken|mooshroom)$/.test(e.name || '') && e.position) reg('animal', e.position.x, e.position.y, e.position.z, (e.name || '')); } } catch (e) {}
                        // ★task-queue Phase B opportunistic detection sources (design §5.3): ORE veins (iron/
                        //   diamond, near-range so the bot only grabs what it'd pass; meta=subtype for collectBlock
                        //   + pick-tier gate) and WANDERING TRADER (kill for lead/栓绳). Scanned here so
                        //   bot._world.landmarks.{ore,trader} exist for spliceOpportunistic.
                        try { for (const bp of bot.findBlocks({ matching: (b) => b && /(^|_)(iron|diamond)_ore$/.test(b.name || ''), maxDistance: 16, count: 12 })) { const bn = bot.blockAt(bp); reg('ore', bp.x, bp.y, bp.z, /diamond/.test((bn && bn.name) || '') ? 'diamond' : 'iron'); } } catch (e) {}
                        try { for (const e of Object.values(bot.entities || {})) { if (e && /^(wandering_trader|trader_llama)$/.test(e.name || '') && e.position) reg('trader', e.position.x, e.position.y, e.position.z, e.name); } } catch (e) {}
                        if (dirty) { try { fs.writeFileSync('bots/_supervisor/landmarks.json', JSON.stringify(bot._landmarks)); } catch (e) {} }
                    }
                } catch (e) {}
                // ★TRANSIENT freshness (task-queue Phase C opp-completion): ore/animal/trader/crops get
                //   CONSUMED (mined vein / killed mob / despawned trader). Their landmark lingers in
                //   bot._landmarks with a stale `seen`, so without a freshness filter an OPP task's cond
                //   stays true forever → infinite re-dispatch on a dead locus (villageHarvest-pin class).
                //   C328 re-scans every 12s, so a present resource is re-seen ≤12s ago; drop transient
                //   landmarks not re-seen in 25s = consumed/gone. Persistent kinds (bed/village/wood/chest)
                //   are unaffected (they don't deplete that fast).
                const _TRANSIENT_LM = /^(ore|animal|trader|crops)$/;
                // ★T-0055 (wood landmark 可达性盲): optional yBand={below,above} filters landmarks whose
                //   base y is outside [botY-below, botY+above] — a cheap reachability proxy (mirror of
                //   migrate.js:226 reachableTrees). Without it, _nearLm('wood') returns the nearest tree by
                //   3D dist, which can still be a plateau-top / water-far-side trunk we CAN'T reach (dy huge
                //   but 3D dist <woodReachDist), so opening flips _woodKnownReach=true → WOOD_BUFFER ↔
                //   chop-fail thrash forever. yBand is opt-in: callers that pass nothing keep the old
                //   behavior exactly (zero regression for bed/village/chest/etc.).
                const _nearLm = (kind, yBand) => { let best = null, bd = Infinity; for (const k in (bot._landmarks || {})) { const n = bot._landmarks[k]; if (kind && n.kind !== kind) continue; if (_TRANSIENT_LM.test(n.kind) && (now - (n.seen || 0)) > 25000) continue; if (yBand) { const dy = n.y - p.y; if (dy > (yBand.above || 0) || dy < -(yBand.below || 0)) continue; } const d = Math.hypot(n.x - p.x, n.y - p.y, n.z - p.z); if (d < bd) { bd = d; best = { x: n.x, y: n.y, z: n.z, dist: +d.toFixed(1), meta: n.meta || null, age: now - (n.seen || 0) }; } } return best; };
                const _lmCounts = (() => { const c = {}; for (const k in (bot._landmarks || {})) { const kd = bot._landmarks[k].kind; c[kd] = (c[kd] || 0) + 1; } return c; })();
                // ─────────────────────────────────────────────────────────────────────────────
                // ★ FRAMEWORK-V2 DECISION PREDICATES (纯本能 / 确定性 / 无 LLM): compute the night-
                // plan + opening intent HERE as world-model OUTPUTS so proposeTasks degrades to a
                // pure translator (modes.js owns "how a human reasons", the proposer just labels it).
                // None of this touches the保命反射 instinct modes — these are read-only derivations
                // feeding bot._world.{nightPlan,opening} and the extended kit/landmarks. ──────────
                const _nowDec = now;
                const readDecisionConfig = () => {
                    const DEFAULTS = { woodBuffer: 8, mineNightPickBudget: 200, mineNightFood: 10, bedReachDist: 64, woodReachDist: 24,
                        // ── task-queue migration flags (framework-v2 Phase A/B/C; all default OFF = Phase A shadow) ──
                        taskqInsert: false,   // Phase B: backlog + opportunistic tasks survive in the shadow queue
                        taskqLive: false,     // Phase C: kernelDriver dispatches the QUEUE HEAD instead of bot._commitment
                        llmGate: false };     // LLM ask-on-trigger gate (default OFF = pure instinct)
                    try {
                        if (this._decCfg && (_nowDec - (this._decCfgAt || 0) < 8000)) return this._decCfg;
                        let cfg = DEFAULTS;
                        try {
                            let raw = fs.readFileSync('bots/_supervisor/decision-config.json', 'utf8');
                            if (raw && raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);   // ★BOM-safe (memory: BOM→silent JSON.parse kill)
                            const parsed = JSON.parse(raw);
                            cfg = Object.assign({}, DEFAULTS, parsed && typeof parsed === 'object' ? parsed : {});
                        } catch (e) {
                            // ENOENT → silently use defaults; a PARSE error is a real misconfig — never swallow it (memory: BOM-kill)
                            if (e && e.code !== 'ENOENT') {
                                try { fs.appendFileSync('bots/_supervisor/events.log', `[${new Date().toISOString()}] decision-config parse FAILED (${e.message}) — using defaults\n`); } catch (_e) {}
                            }
                        }
                        this._decCfg = cfg; this._decCfgAt = _nowDec;
                        return cfg;
                    } catch (e) { return DEFAULTS; }
                };
                const cfg = readDecisionConfig();
                // pick durability budget: Σ(maxDurability − durabilityUsed) over ALL pickaxes (not the
                // effective-pick count) — the night-mine gate is about whether the TOTAL remaining pick
                // life can outlast a full night underground, so a fresh+worn pair still counts.
                let picksBudget = 0;
                try {
                    for (const it of bot.inventory.items()) {
                        if (!/_pickaxe$/.test(it.name || '')) continue;
                        const mx = it.maxDurability || 0;
                        const ud = (typeof it.durabilityUsed === 'number') ? it.durabilityUsed : 0;
                        picksBudget += Math.max(0, mx - ud);
                    }
                } catch (e) {}
                const dirtCt = counts.dirt || 0;
                const canMineWholeNight = picksBudget >= cfg.mineNightPickBudget && sufficientForUnderground && food >= cfg.mineNightFood && (cobble + dirtCt) >= 4;
                // gravity-pit trap (mirror prepNether C334): digging into a sand/red_sand/gravel column
                // collapses onto the head → suffocation. Below dy-1/dy-2 (dug) + dy+2 (drops into head gap).
                const _GRAV_DEC = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$/;
                const _gravityPitTrap = () => {
                    try {
                        const b1 = bot.blockAt(m.offset(0, -1, 0));
                        const b2 = bot.blockAt(m.offset(0, -2, 0));
                        const ab = bot.blockAt(m.offset(0, 2, 0));
                        return [b1, b2, ab].some(b => b && _GRAV_DEC.test(b.name || ''));
                    } catch (e) { return false; }
                };
                // DIG_ONE_CAP viability: ≥1 pick, OR bare-hand-diggable floor (dirt/gravel) underfoot;
                // never in a gravity column; never below y16 (deep — DIG_ONE is a shallow night-shelter).
                let _floorBareDig = false;
                try { const fb = bot.blockAt(m.offset(0, -1, 0)); _floorBareDig = !!(fb && /^(dirt|coarse_dirt|grass_block|gravel|sand|red_sand)$/.test(fb.name || '')); } catch (e) {}
                const digOneViable = (picks >= 1 || _floorBareDig) && !_gravityPitTrap() && y > 16;
                // landmark navigation costs (manhattan-ish straight-line; bedReachCost surfaced for skills)
                const _bedLm = _nearLm('bed');
                const _bedReachCost = _bedLm ? _bedLm.dist : null;
                const bedAffordable = !!_bedLm && _bedLm.dist <= cfg.bedReachDist && !inDeathZone && actionable === 0 && hp >= 10;
                // FIGHT (commitToFight): a melee-able, point-blank NON-creeper threat we can win — sword
                // in hand, hp headroom, not boxed in (enclosed → can't kite, prefer seal). creeper is
                // excluded (it suicides on contact → the defense reflex layer kites it, not us).
                const hasSwordDec = (() => { try { return bot.inventory.items().some(i => /_sword$/.test(i.name || '')); } catch (e) { return false; } })();
                const _creeperPB = Number.isFinite(creeperDist) && creeperDist < 3.2;
                const _meleePB = Number.isFinite(closest) && closest < 3.2;
                const commitToFight = _meleePB && !_creeperPB && hasSwordDec && hp > 12 && !(mob && mob.enclosed);  // ★hp>6→>12: 死亡数据(45死)实锤 hp6 提交melee=自杀(zombie 2下打死);低血该封顶/逃不该挥剑
                // ── computeNightPlan(): short-circuit priority chain (user spec, verbatim order):
                //    FIGHT > MINE_THROUGH_NIGHT > GO_BED > DIG_ONE_CAP > SEAL_FORT ; non-night → NONE.
                // ★ALREADY-SAFE-UNDERGROUND: the strict picksBudget≥200 gate above is for the DUSK choice
                // "should I descend to mine all night". A bot ALREADY deep+enclosed with a pickaxe is already
                // mining safely — it must KEEP MINING, not surface-bootstrap (can't, at night) nor shelter
                // (already covered). Live fix: committed BOOTSTRAP_KIT stalled the bot at y50 all night trying
                // to reach the surface for wood; MINE_THROUGH_NIGHT here keeps it productively descending.
                const alreadyDeepEnclosed = (y < 50 || (mob && mob.enclosed)) && picks >= 1 && food > 6;
                // ★TIER LOCK-IN (T-0097, tier-relapse root-fix): if we're safely settled at stone tier with
                // BANKABLE iron but no iron pick yet, spend the night CONVERTING it (smelt → craft iron
                // pickaxe+sword+shield) instead of mining MORE loose ore. Why this must be a NIGHT decision
                // (not the day-only GET_IRON_TOOLS@47 rung): the bot mines through the night (nightPlan=
                // MINE_THROUGH_NIGHT), accumulating raw_iron it can't convert until dawn — and commitGoal
                // makes the MINE commitment sticky, so no proposal can preempt it mid-night. So raw_iron
                // rode as droppable ore until a pre-dawn death / pick-break wiped it (实锤 06-25: held
                // raw_iron×7 at night 10:40, dead 10:42, iron gone → never a persistent tier-up). Converting
                // here (1) locks banked iron into a PERSISTENT iron pickaxe (tier up, not relapse to wood),
                // and (2) yields an iron sword+shield — a big upgrade over the stone sword that keeps losing
                // to the skeleton swarms that dominate the death log. Smelt+craft are IN-PLACE (no surfacing),
                // so they're valid underground at night. Gate hard: only when SAFE (no reachable threat) and
                // the conversion is actually achievable in place — a stone+ pick to keep mining after, ≥3
                // iron (ingots, or raw_iron with fuel + a furnace-or-cobble to smelt), a table path, food
                // headroom, and not stuck (ENTOMBED/POCKET can't stand at a furnace). Sits ABOVE mining in
                // the chain (FIGHT > SMELT_IRON > MINE) — lock the iron in before grinding out more.
                const _hasIronPickDec = ((counts.iron_pickaxe || 0) + (counts.diamond_pickaxe || 0) + (counts.netherite_pickaxe || 0)) > 0;
                const _ironIngotsDec = counts.iron_ingot || 0;
                const _rawIronDec = counts.raw_iron || 0;
                const _fuelDec = (counts.coal || 0) + (counts.charcoal || 0);
                const _canSmeltHere = (counts.furnace || 0) >= 1 || cobble >= 8;   // smeltSafe places a carried furnace, else craft one from cobble
                const _ironConvAchievable = _ironIngotsDec >= 3 || (_rawIronDec >= 3 && _fuelDec >= 1 && _canSmeltHere);
                const _stuckMob = /ENTOMBED|POCKET/.test(mob || '');
                // an iron pickaxe needs 2 sticks for the handle — require sticks on hand OR a plank/log
                // source to craft them, else we'd smelt the ore then stall stickless at the craft step.
                const _stickPathDec = (counts.stick || 0) >= 2 || planksMax >= 2 || logs >= 1;
                const smeltIronWarranted = !_hasIronPickDec && durablePick && _ironConvAchievable && _stickPathDec
                    && actionable === 0 && food > 6 && hasTablePath && !_stuckMob;
                const computeNightPlan = () => {
                    if (phase !== 'dusk' && phase !== 'night') return { decision: 'NONE' };
                    if (commitToFight) return { decision: 'FIGHT', reason: `point-blank melee d=${Number.isFinite(closest) ? closest.toFixed(1) : '?'}` };
                    if (smeltIronWarranted) return { decision: 'SMELT_IRON', reason: `${_ironIngotsDec >= 3 ? _ironIngotsDec + ' ingots' : _rawIronDec + ' raw_iron'} + no iron pick — lock in iron tier (persistent + iron sword/shield)`, targetY: y };
                    if (canMineWholeNight) return { decision: 'MINE_THROUGH_NIGHT', reason: `pickBudget=${picksBudget}>=${cfg.mineNightPickBudget}`, targetY: 12 };
                    if (alreadyDeepEnclosed) return { decision: 'MINE_THROUGH_NIGHT', reason: `already deep/enclosed y=${y} pick=${picks} — keep mining, don't surface-bootstrap`, targetY: 12 };
                    if (bedAffordable) return { decision: 'GO_BED', reason: `bed@${_bedReachCost}b`, target: _bedLm };
                    if (digOneViable) return { decision: 'DIG_ONE_CAP', reason: `dig-one shelter y=${y}` };
                    return { decision: 'SEAL_FORT', reason: 'seal in place (fallback)' };
                };
                const nightPlan = computeNightPlan();
                // ── computeOpening(): bootstrap-phase intent (SCOUT/WOOD_BUFFER/VILLAGE_HARVEST/DONE).
                const woodUnits = Math.floor(((planksMax || 0) + (logs || 0)) / 4);
                let bootstrapDone = false;
                try { bootstrapDone = (typeof isBootstrapDone === 'function') ? !!isBootstrapDone(bot) : (sufficientForUnderground && foodSufficient); }
                catch (e) { bootstrapDone = sufficientForUnderground && foodSufficient; }
                // ★T-0055: opening decisions must use a REACHABLE tree, not just the nearest visible one.
                //   _woodLmReach applies the y-band reachability proxy (base y within step-up/dig-down range
                //   of our standing level, mirror of migrate.js:226: below 6 / above 2). _woodLm (no band)
                //   is kept for telemetry only so the snapshot can still show "a tree exists nearby" even
                //   when it's out of reach. The WOOD_BUFFER/SCOUT gates below key off _woodLmReach so a
                //   plateau-top / water-far-side trunk no longer flips _woodKnownReach=true (the
                //   WOOD_BUFFER ↔ chop-fail thrash root).
                const _woodLmAny = _nearLm('wood');
                const _woodLmReach = _nearLm('wood', { below: 6, above: 2 });
                const _woodLm = _woodLmReach || _woodLmAny;   // prefer a reachable tree as the WOOD_BUFFER target
                const _villLm = _nearLm('village');
                const _woodKnownReach = !!_woodLmReach && _woodLmReach.dist <= cfg.woodReachDist;
                const computeOpening = () => {
                    if (bootstrapDone) return { phase: 'DONE', need: null, woodTarget: null, villageTarget: null, woodUnits };
                    const day = phase === 'day';
                    // VILLAGE_HARVEST: a near, known village we haven't urgently-kit-gated away from.
                    // ★ANTI-FREEZE (T-villageHarvest pin): skip while a fresh harvest cooldown is set —
                    // villageHarvest stamps bot._villageHarvestCooldownUntil after each pass, so an
                    // EXHAUSTED/empty village doesn't keep re-proposing → no-op re-dispatch → frozen.
                    const _villCooldown = (() => { try { return Date.now() < (bot._villageHarvestCooldownUntil || 0); } catch (e) { return false; } })();
                    if (_villLm && _villLm.dist < 32 && !_villCooldown && !(picks === 0 && woodUnits < 1)) {
                        return { phase: 'VILLAGE_HARVEST', need: 'village', woodTarget: _woodLm, villageTarget: _villLm, woodUnits };
                    }
                    // WOOD_BUFFER: wood is known/reachable but we're short of the buffer → go top it up.
                    if (woodUnits < cfg.woodBuffer && _woodKnownReach) {
                        return { phase: 'WOOD_BUFFER', need: 'wood', woodTarget: _woodLm, villageTarget: _villLm, woodUnits };
                    }
                    // SCOUT: bare, daylight, on the surface, no known reachable wood/village → go explore.
                    if (day && y >= 55 && !_woodKnownReach && !(_villLm && _villLm.dist < 32)) {
                        const need = (!_woodLm && !_villLm) ? 'both' : (!_woodLm ? 'wood' : 'village');
                        return { phase: 'SCOUT', need, woodTarget: _woodLm, villageTarget: _villLm, woodUnits };
                    }
                    // default while bootstrapping but conditions for an explicit phase aren't met
                    return { phase: woodUnits < cfg.woodBuffer ? 'WOOD_BUFFER' : 'DONE', need: woodUnits < cfg.woodBuffer ? 'wood' : null, woodTarget: _woodLm, villageTarget: _villLm, woodUnits };
                };
                const opening = computeOpening();
                bot._world = {
                    ts: now,
                    time: { tod, phase, isDay: !isNight && !isDusk },
                    pos: { x: Math.round(p.x), y, z: Math.round(p.z), depthBand },
                    mobility: { state: mob.state, enclosed: !!mob.enclosed, exits: mob.exits || [] },
                    vitals: { hp, food, canRegen, armor },
                    threat: { hostiles, closest: Number.isFinite(closest) ? +closest.toFixed(1) : null, creeperDist: Number.isFinite(creeperDist) ? +creeperDist.toFixed(1) : null, phantomNear, swarm, actionable, takingDamage },
                    cover: { overhead, coverReal },
                    kit: { picks, pickTier: tierName[bestTier] || 'none', hasTablePath, foodSufficient, cobbleBuffer: cobble, torches, sufficientForUnderground, picksBudget, canMineWholeNight },
                    migration,
                    surfaceGate: { mode: gateMode, allowSurface, reason: gateReason, decidedBy, until: gateUntil },
                    recommendation: { action, reason: gateReason },
                    nightPlan,   // ★framework-v2 deterministic night decision (FIGHT/MINE_THROUGH_NIGHT/GO_BED/DIG_ONE_CAP/SEAL_FORT/NONE)
                    opening,     // ★framework-v2 deterministic opening intent (SCOUT/WOOD_BUFFER/VILLAGE_HARVEST/DONE)
                    landmarks: { bed: _bedLm, village: _villLm, wood: _woodLmAny, woodReach: _woodLmReach, woodKnownReach: _woodKnownReach, crops: _nearLm('crops'), chest: _nearLm('chest'), animal: _nearLm('animal'), ore: _nearLm('ore'), trader: _nearLm('trader'), bedReachCost: _bedReachCost, counts: _lmCounts },   // ★C328 resource memory (multi-kind + Phase B ore/trader); ★T-0055 wood split into wood(any, telemetry) vs woodReach(y-band reachable, decision)
                };
                // ── S4.1/4.3 COMMITMENT (decision-speed / don't-yo-yo, user #1): compute the
                //    sticky committed goal as a world-model OUTPUT so ALL layers read it (the
                //    blueprint's "world model propose → layers consume"). commitGoal holds the
                //    goal until done; skills (feedUp/forageExplore) read bot._commitment and
                //    defer while BOOTSTRAP_KIT is committed (the suppress hooks). No kernel
                //    takeover needed — this runs in the always-on world_model mode. ──
                // ★_nightSeq — monotonic night counter, +1 on the day→dusk edge. AUTHORITATIVE night
                //   clock for the task-queue trigger lifecycle: bot.time.timeOfDay wraps to 0 each dawn
                //   so it CANNOT key "once-per-night/next-night-independent" episodes (design §3.1).
                try {
                    const _ph = bot._world.time.phase;
                    if (bot._lastPhaseSeen === 'day' && _ph === 'dusk') bot._nightSeq = (bot._nightSeq | 0) + 1;
                    bot._lastPhaseSeen = _ph;
                } catch (e) {}
                try {
                    if (!this._fw) this._fw = await import('./framework/index.js');
                    const props = this._fw.proposeTasks(bot._world, bot);
                    const committed = this._fw.commitGoal(bot, props, bot._world);   // mutates bot._commitment (authoritative Phase A/B)
                    bot._world.commitment = committed ? { kind: committed.kind, skill: committed.skill, rationale: committed.rationale, preemptedFrom: committed.preemptedFrom || null } : null;
                    // ── TASK QUEUE (framework-v2 Phase A/B, design docs/framework-v2-task-queue.md) ──
                    //   Build the queue from the SAME proposals. SHADOW (taskqLive=false): commitGoal stays
                    //   authoritative (wrote bot._commitment above); commitQueue only fills bot._taskQueue +
                    //   the head it computes is logged for PARITY (kernel._shadowObserve). taskqInsert lets
                    //   the backlog + opportunistic tasks survive in the shadow queue. taskqLive (Phase C,
                    //   default OFF) hands dispatch to the queue head (overwrites bot._commitment). Flags via
                    //   decision-config.json → flip needs only a watchdog-restart, no code redeploy.
                    try {
                        const taskqLive = !!(cfg && cfg.taskqLive);
                        const taskqInsert = !!(cfg && cfg.taskqInsert);
                        this._fw.commitQueue(bot, props, bot._world, { live: taskqLive, insert: taskqInsert });
                        // ── Phase B OPPORTUNISTIC INSERTION (design §5; gated by taskqInsert, default OFF) ──
                        //   Splices opportunistic tasks (ore/trader/village/animal/wheat-farm) into the
                        //   queue. ALL ≤87 (under the survival chain). Behind the flag = zero behaviour
                        //   change until flipped; until taskqLive, these live in the SHADOW queue only.
                        if (taskqInsert && this._fw.spliceOpportunistic) try {
                            const Wd = bot._world, lm = Wd.landmarks || {}, mb = Wd.mobility || {};
                            const globalOk = !/ENTOMBED|POCKET|MAROONED|SEALED|SWIM/.test(mb.state || '')
                                && !((Wd.threat.actionable | 0) > 0 && Wd.vitals.hp < 10)
                                && now >= (bot._recoveryVentureUntil || 0);
                            const isNightNowB = Wd.time.phase === 'dusk' || Wd.time.phase === 'night';
                            const emergNow = (Wd.vitals.food <= 4) || ((Wd.threat.actionable | 0) > 0 && Wd.vitals.hp < 10) || (Wd.migration && Wd.migration.inDeathZone);
                            const fresh = (set, key) => { bot[set] = bot[set] || {}; return now >= (bot[set][key] || 0); };
                            const stamp = (set, key, ttl) => { bot[set] = bot[set] || {}; bot[set][key] = now + ttl; };
                            // ★OPP cond builder (fixes the unreachable-ore no-op FREEZE: live -38,73 pinned 450s
                            //   while collectBlock re-dispatched on iron@y58 it couldn't reach). The old conds
                            //   checked the NEAREST landmark (so any ore nearby kept a DEAD task alive). This
                            //   checks (a) a hard TTL — a stuck opp task auto-expires, the _oppXSeen cooldown
                            //   then blocks re-insert, so a no-op can't freeze the bot past ttlMs; and (b) the
                            //   bot's distance to THIS task's OWN locus — drop once we've moved away / mined it out.
                            const condFor = (loc, dropDist, ttlMs) => { const exp = now + ttlMs, lx = loc.x, ly = loc.y, lz = loc.z; return (w, b) => { try { if (Date.now() > exp) return false; const p = b.entity.position; return Math.hypot(p.x - lx, p.y - ly, p.z - lz) <= dropDist; } catch (e) { return false; } }; };
                            const C = counts || {};
                            const meatStock = (C.cooked_beef || 0) + (C.cooked_porkchop || 0) + (C.cooked_mutton || 0) + (C.cooked_chicken || 0) + (C.bread || 0);
                            if (globalOk) {
                                // #4 TRADER → kill for lead @87 head (毫不犹豫). night only if point-blank.
                                const tr = lm.trader;
                                if (tr && tr.dist <= 24 && (!isNightNowB || tr.dist <= 4)) {
                                    const k = `tr@${tr.x},${tr.y},${tr.z}`;
                                    if (fresh('_oppTraderSeen', k)) { this._fw.spliceOpportunistic(bot, { kind: 'OPP_TRADER_LEAD', priority: 87, position: 'head', skill: 'attackNearest', args: [tr.meta || 'wandering_trader', true], locus: tr, rationale: '毫不犹豫杀流浪商人取栓绳', lifecycle: 'encounter', cond: condFor(tr, 28, 45000) }); stamp('_oppTraderSeen', k, 7200000); }
                                }
                                // #1 ORE → mine vein @86 (diamond head / iron priority). pick-tier hard gate.
                                const ore = lm.ore;
                                // ★dist≤8 (was 16): only fire when the bot is RIGHT AT the vein (genuinely passing
                                //   it underground), so collectBlock can actually reach it — a far/buried ore the
                                //   bot can't tunnel to was the no-op-freeze source. condFor drops at >12 / 45s TTL.
                                if (ore && ore.dist <= 8 && this._fw.pickTierSatisfies(bot, ore.meta) && !emergNow) {
                                    const isDia = /diamond/.test(ore.meta || '');
                                    const ironNightOk = !isNightNowB || ((Wd.kit && Wd.kit.picks >= 1) && (y < 50 || mb.enclosed));
                                    if (isDia || ironNightOk) { const k = `or@${ore.x},${ore.y},${ore.z}`; if (fresh('_oppOreSeen', k)) { this._fw.spliceOpportunistic(bot, { kind: 'OPP_MINE_VEIN_ORE', priority: 86, position: isDia ? 'head' : 'priority', skill: 'collectBlock', args: [ore.meta, 64, null, true], locus: ore, rationale: `路过${ore.meta}矿脉立即挖`, lifecycle: 'node', cond: condFor(ore, 12, 45000) }); stamp('_oppOreSeen', k, 1800000); } }
                                }
                                // #2 VILLAGE → seize (always wheat) @76 before-current. day, non-emergency, cooldown, no-pick/no-wood guard.
                                // ★vil.y>=55 + age<15s + bot near-surface: village landmarks PERSIST (navigation anchors,
                                //   not transient-filtered), so 554 accumulated entries include BOGUS/stale ones — a y21
                                //   "village" (mis-scanned / never re-seen) made villageHarvest no-op-freeze the bot deep
                                //   underground. Require a SURFACE village (y>=55) that was FRESHLY re-seen (age<15s = the
                                //   bot is actually at a live village now) AND the bot itself near-surface.
                                const vil = lm.village;
                                if (vil && vil.dist < 32 && vil.y >= 55 && (vil.age || 0) < 15000 && y >= 50 && !isNightNowB && !emergNow && now >= (bot._villageHarvestCooldownUntil || 0) && !(((Wd.kit && Wd.kit.picks) || 0) === 0 && woodUnits < 1)) {
                                    this._fw.spliceOpportunistic(bot, { kind: 'OPP_SEIZE_VILLAGE', priority: 76, position: 'before-current', skill: 'villageHarvest', args: [{ priorityCrop: 'wheat' }], locus: vil, rationale: '路过村庄夺取(永远囤小麦)', lifecycle: 'encounter', cond: condFor(vil, 34, 30000) });
                                }
                                // #3 ANIMAL → cost/benefit → push-current or tail. day-gated.
                                const an = lm.animal;
                                if (an && an.dist <= 24 && !isNightNowB && !emergNow) {
                                    const fd = Wd.vitals.food, sheep = /sheep/.test(an.meta || '');
                                    const benefit = (fd <= 6 ? 100 : fd < 12 ? 50 : 20) * (meatStock < 4 ? 1.0 : 0.3) + (sheep && !lm.bed ? 60 : 0);
                                    const cost = an.dist * 2 + ((Wd.threat.actionable | 0) > 0 ? 40 : 0) + (Wd.vitals.hp < 10 ? 50 : 0);
                                    const score = benefit - cost;
                                    if (score > 0) { const k = `an@${Math.round(an.x)},${Math.round(an.z)}`; if (fresh('_oppHuntSeen', k)) { const pri = Math.max(30, Math.min(72, Math.round(30 + score))); const cur = bot._commitment; const pushable = cur && pri > 50 && !/^(NIGHT_|DUSK_|HOLD|GET_FOOD|MIGRATE|OPP_MINE)/.test(cur.kind || ''); this._fw.spliceOpportunistic(bot, { kind: 'OPP_HUNT_ANIMAL', priority: pri, position: pushable ? 'before-current' : 'tail', skill: 'attackNearest', args: [(an.meta || 'cow').replace(/[^a-z_]/g, ''), true], locus: an, rationale: `猎${an.meta}(score=${Math.round(score)})`, lifecycle: 'encounter', cond: condFor(an, 28, 30000) }); stamp('_oppHuntSeen', k, 300000); } }
                                }
                                // #5 WHEAT FARM → @40 tail. bedKnown + day + safe + breadStock<dynamicTarget + cooldown.
                                if (lm.bed && !isNightNowB && !emergNow && now >= (bot._wheatFarmCooldownUntil || 0)) {
                                    const target = this._fw.dynamicBreadTarget(bot, Wd);
                                    if ((C.bread || 0) < target) { this._fw.spliceOpportunistic(bot, { kind: 'OPP_WHEAT_FARM', priority: 40, position: 'tail', skill: 'wheatFarm', args: [{ breadTarget: target }], locus: lm.bed, rationale: `种麦烤面包到${target}`, lifecycle: 'persistent-recurring', cond: condFor(lm.bed, 99999, 120000) }); }
                                }
                            }
                        } catch (eo) {}
                    } catch (e2) {}
                } catch (e) {}
                // ★C331 (用户 architecture directive): GO-TO-BED-SLEEP as an INSTINCT under the
                // execute-first / ask-LLM / veto-suppress-for-cycle contract (framework instinct.runInstinct).
                // "去村庄睡觉是本能,本能总是先触发执行,再在执行过程中询问llm,如果llm否决了,本周期内不再触发。"
                // Sleeping at a KNOWN bed/village (C328 landmark memory) is a reflex that ACTS first; the
                // LLM may veto (via !vetoInstinct), which suppresses it for this trigger episode (this night).
                try {
                    if (this._fw && this._fw.instinct && this._fw.instinct.runInstinct) {
                        if (!this._goSleepInstinct) this._goSleepInstinct = {
                            name: 'go_to_bed_sleep', priority: 60,
                            test: (w, b) => { try { const t = w && w.time; if (!t || (t.phase !== 'dusk' && t.phase !== 'night')) return false; if (w.threat && (w.threat.actionable | 0) > 0) return false; if (w.vitals && w.vitals.hp < 6) return false; const lm = w.landmarks || {}; return !!(lm.bed || lm.village); } catch (e) { return false; } },
                            act: async (w, b, c) => {
                                const lm = (w && w.landmarks) || {}; const tgt = lm.bed || lm.village; if (!tgt) return;
                                const hp = b.entity.position;
                                if (Math.hypot(hp.x - tgt.x, hp.z - tgt.z) > 2.5 && !b.interrupt_code) { try { await c.skills.goToPosition(b, tgt.x, tgt.y, tgt.z, 2); } catch (e) {} }
                                if (b.interrupt_code) return;
                                const bed = b.findBlock({ matching: (bl) => bl && /_bed$/.test(bl.name || ''), maxDistance: 6 });
                                if (bed && w.time && w.time.phase === 'night' && b.entity.position.distanceTo(bed.position) <= 2.6) { try { await b.sleep(bed); } catch (e) {} }
                            },
                            askLLM: async (w, b, c) => { try { c.notify && c.notify('[本能] 去睡觉执行中:夜间往已知床/村庄睡(跳过危险夜)。如不该睡(关键作业中)请否决: !vetoInstinct("go_to_bed_sleep")'); } catch (e) {} return { veto: false }; },
                        };
                        this._fw.instinct.runInstinct(bot, this._goSleepInstinct, bot._world, {
                            skills,
                            // ★SILENT notify (用户: "LLM全程不出声 / s4先不管"): the ask-LLM half of the
                            // mechanism is WIRED but DORMANT — it logs the veto-request to a file instead
                            // of openChat (no bot speech, no LLM invocation yet). When S4 turns the LLM on,
                            // route this to the kernel/prompter; for now the instinct just executes (纯本能)
                            // and the !vetoInstinct command stays available for when the LLM is live.
                            notify: (m) => { try { fs.appendFileSync('bots/_supervisor/instinct.log', `[${new Date().toISOString()}] ${m}\n`); } catch (e) {} },
                            interrupt: () => { try { bot.interrupt_code = true; } catch (e) {} },
                        });
                    }
                } catch (e) {}
                if (now - this.lastWrite >= 2000) {
                    this.lastWrite = now;
                    try { fs.writeFileSync('bots/_supervisor/world_model.json', JSON.stringify(bot._world)); } catch (e) {}
                }
            } catch (e) {}
        }
    },
    {
        name: 'bare_stone_alarm',
        description: 'Alert the supervisor the moment the bot digs stone bare-handed.',
        interrupts: [],
        on: true,
        active: false,
        always: true,   // pure observer
        lastAlert: 0,
        update: async function (agent) {
            // 用户实拍怒斥"你见过哪个人类玩家这样挖石头的?" — bare-hand stone digging is
            // 5-10x slower AND drops nothing, so it's ALWAYS a planning bug upstream
            // (lost pick + material-blind dig call). Alert instantly via ALERTS.txt (the
            // [ALERT] monitor tails it) so the supervisor sees the state within seconds,
            // with position + target so the offending code path can be hunted down.
            const bot = agent.bot;
            const tgt = bot.targetDigBlock;
            if (!tgt || !tgt.name) return;
            const held = bot.heldItem;
            if (held && /_pickaxe$/.test(held.name)) return;
            if (!/stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/.test(tgt.name)) return;
            if (bot._plannedNoPickStoneUntil && Date.now() < bot._plannedNoPickStoneUntil) return;
            // REGIONAL dedupe: a legit NOPICK climb chews stone for many minutes in one
            // area — per-block 30s dedupe pushed 5+ alerts per climb (pure noise once
            // the supervisor knows). One alert per ~16-block region per 10 minutes; a
            // NEW region still alerts immediately (that's the signal that matters).
            const rk = `${Math.round(tgt.position.x / 16)},${Math.round(tgt.position.z / 16)}`;
            if (!this.regions) this.regions = {};
            if (this.regions[rk] && Date.now() - this.regions[rk] < 600000) return;
            this.regions[rk] = Date.now();
            this.lastAlert = Date.now();
            try { bot.interrupt_code = true; } catch (e) {}
            try { bot._chopGen = (bot._chopGen || 0) + 1; } catch (e) {}
            try { bot._supervisorCancelAt = Date.now(); } catch (e) {}
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
            try { bot.clearControlStates(); } catch (e) {}
            try {
                const p = bot.entity.position;
                fs.appendFileSync('ALERTS.txt',
                    `[${new Date().toISOString()}] BARE-HAND STONE DIG: ${tgt.name} @${tgt.position.x},${tgt.position.y},${tgt.position.z} held=${held ? held.name : 'empty'} botY=${Math.floor(p.y)}\n`);
            } catch (e) {}
        }
    },
    {
        name: 'tool_keeper',
        description: 'Watch held tool durability every few seconds; craft a spare BEFORE it snaps.',
        // 'all': same scheduler trap as the combat blackbox — with interrupts:[] this mode
        // NEVER ran while a sticky skill was executing (the agent is never idle), so both
        // pickaxes ground to dust mid-dig with 200 cobblestone in the bag (01:34, deaths
        // stayed 261 but kit hit zero). It must be allowed to interrupt: a 2s craft pause
        // every ~250 dig-uses is exactly what a human does mid-mining.
        interrupts: ['all'],
        on: true,
        active: false,
        last_check: 0,
        update: async function (agent) {
            // ★人类的耐久感是 TICK 级反射,不是任务边界策略 (用户怒斥"连看耐久度都没有"——
            // 备镐规则确实写过,但挂在 prepNether 边界,镐总在边界之间的长挖掘里磨断,检查
            // 永远慢半拍,且查时常没料。人类每挥几下瞄一眼耐久条 → 放①层,5s一查,磨损>80%
            // 且无健康同类备件 → 用随身料(圆石+棍+手持工作台)当场补造,2秒换不死一把镐)。
            const bot = agent.bot;
            if (bot.health <= 10 && bot.food < 18) return;
            if (Date.now() - this.last_check < 5000) return;
            this.last_check = Date.now();
            const held = bot.heldItem;
            if (!held || !/_pickaxe$|_axe$|_shovel$/.test(held.name)) return;
            const max = held.maxDurability || 0;
            const used = (typeof held.durabilityUsed === 'number') ? held.durabilityUsed : 0;
            if (!max || used / max < 0.8) return;
            const cls = held.name.split('_').pop();   // pickaxe / axe / shovel
            const healthySpare = bot.inventory.items().some(i =>
                i.slot !== held.slot && i.name.endsWith('_' + cls)
                && (!i.maxDurability || ((typeof i.durabilityUsed === 'number' ? i.durabilityUsed : 0) / i.maxDurability) < 0.5));
            if (healthySpare) return;
            const c = {};
            for (const it of bot.inventory.items()) c[it.name] = (c[it.name] || 0) + it.count;
            const stone = (c.cobblestone || 0) + (c.cobbled_deepslate || 0) + (c.blackstone || 0);
            if (stone >= 3 && (c.stick || 0) >= 2) {
                const planks = Object.entries(c).reduce((s, [n, v]) => s + (n.endsWith('_planks') ? v : 0), 0);
                const logs = Object.entries(c).reduce((s, [n, v]) => s + (/_log$/.test(n) ? v : 0), 0);
                let tableNearby = false; try { tableNearby = !!world.getNearestBlock(bot, 'crafting_table', 4); } catch (e) {}
                // ★T-0012/T-0088 (tier-wood relapse smoking gun, 06-25): a stone pickaxe needs a 3x3 grid
                // (a crafting table). With NO carried/nearby table AND <4 planks + 0 logs, this craft CANNOT
                // succeed — but the old code still emitted "crafting a spare" then silently swallowed the
                // failure, hiding the drain: held pick snaps → next pick becomes held → wears → same false
                // log → all N picks ground to dust → pickless石棺 → tier relapses to wood (live: 4 stone
                // picks drained underground with 136 cobble + 2 planks, just short of a table). Don't lie:
                // when recraft is impossible, emit an HONEST throttled event so the deadlock is VISIBLE
                // (botwatch/overseer can catch it) — the decision layer's canRecraftPick→FORAGE_SURFACE
                // already owns the actual recovery (surface for wood).
                const canGetTable = (c.crafting_table || 0) > 0 || tableNearby || planks >= 4 || logs >= 1;
                if (!canGetTable) {
                    if (Date.now() - (this._noTableWarnAt || 0) > 30000) {
                        this._noTableWarnAt = Date.now();
                        say(agent, `${held.name} at ${Math.round(used / max * 100)}% wear + NO craft table (planks=${planks} logs=${logs}) — can't recraft underground, need surface wood (pick-drain → tier-wood relapse risk).`);
                    }
                    return;
                }
                execute(this, agent, async () => {
                    const cnt = () => bot.inventory.items().filter(i => i.name.endsWith('_' + cls)).reduce((s, i) => s + i.count, 0);
                    const before = cnt();
                    say(agent, `${held.name} at ${Math.round(used / max * 100)}% wear — crafting a spare before it snaps.`);
                    // crafting needs a table: if none in the bag/nearby, build one from planks
                    // (and planks from logs) first — the mid-dig rebuild case after a death wipe.
                    try {
                        if (!c.crafting_table && !tableNearby) {
                            if (planks < 4 && logs >= 1) { try { await skills.craftRecipe(bot, 'oak_planks', 1); } catch (e) {} }
                            try { await skills.craftRecipe(bot, 'crafting_table', 1); } catch (e) {}
                        }
                        // ★T-0079: recraft via craftRecipeLocal (not craftRecipe) — it places the CARRIED
                        // table at arm's reach (works in 1-wide shafts where craftRecipe's getNearestFreeSpace
                        // fails) AND reclaims it after, so the carried table cycles WITH the bot instead of
                        // being stranded at each mining face → the next deep recraft still has a table →
                        // breaks the perpetual-pickless wood-relapse churn (keystone). Falls back to a nearby
                        // table if one's in reach; only the table WE placed from carry is reclaimed.
                        await skills.craftRecipeLocal(bot, 'stone_' + cls, 1);
                    } catch (e) {}
                    // ★verify, don't assume: a swallowed craft error used to read as success. If the spare
                    // count didn't rise, say so plainly so the pick-drain isn't masked by a hopeful log.
                    if (cnt() <= before) say(agent, `spare ${cls} craft FAILED (still ${before}) — no reachable table; surface wood needed before the pick snaps.`);
                });
            }
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                });
            }
        }
    },
    {
        name: 'auto_eat',
        description: 'Eat food when hungry to keep health regenerating.',
        // 'all': third member of the scheduler-trap family (threat_radar, tool_keeper) —
        // with interrupts:[] this never ran while a sticky skill executed, so the bot
        // starved to food=0 WITH food in the bag. Hunger-bled hp was the shared root
        // cause of deaths #260 (6.8hp vs zombie) and #262 (7hp vs suffocation): regen
        // stops below food 18, so every scratch becomes permanent. Eating is a 1.6s
        // pause — a human eats mid-mining without thinking about it.
        interrupts: ['all'],
        on: true,
        active: false,
        last_eat: 0,
        update: async function (agent) {
            const bot = agent.bot;
            if (bot.food <= 17 && Date.now() - this.last_eat > 8000) {
                let food = bot.inventory.items().find(i => /cooked_|_bread|^bread$|apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|melon_slice|sweet_berries|_stew|rabbit|baked_/.test(i.name));
                // EMERGENCY TIER — rotten flesh / raw meats / spider eye. The hp3/food0
                // deadlock (post-#267): feedUp found no animals all day, but the bot HAD
                // killed zombies whose flesh it refused to eat because the regex above
                // doesn't match it. A human at food<=6 eats rotten flesh without blinking
                // (80% hunger-effect chance, ~zero real danger; it's the classic MC
                // famine food). Raw meat/fish are even safer. Only at food<=6 so we never
                // pick junk over real food.
                // ★C315-A (T-0046): the emergency tier was gated food<=6, but a LOW-HP bot at food
                // 15-17 holding ONLY rotten_flesh can't regen (regen needs food>=18) yet won't touch
                // the famine food (food>6) → hp frozen (live: hp4/food16 deadlock, rotten_flesh in bag,
                // stuck 12min). When hp is low AND food<18 (regen-blocked) AND no normal food, eat the
                // emergency food to reach the regen threshold — a brief hunger effect beats bleeding out.
                if (!food && (bot.food <= 6 || (bot.health <= 12 && bot.food < 18))) {
                    food = bot.inventory.items().find(i => /rotten_flesh|^beef$|^porkchop$|^chicken$|^mutton$|^rabbit$|^cod$|^salmon$|spider_eye/.test(i.name));
                }
                if (food) {
                    this.last_eat = Date.now();
                    execute(this, agent, async () => { try { await skills.consume(bot, food.name); } catch (e) {} });
                }
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby uncollected items, even mid-task (gated safe).',
        // ★用户要求(2026-06-19): "周围有还没捡干净的物品时,捡一下"。原 interrupts:['action:followPlayer']
        // 只在跟随玩家(idle)时跑——Neko 常驻 sticky missionNether,所以它几乎从不触发,打怪/挖矿/死亡
        // 残留的掉落物没人捡。改 'all'(同 auto_eat/tool_keeper 的 scheduler-trap 家族修法)让作业中也捡。
        // 已有节流: 2s notice-wait + isClearPath + empty_inv_slots>1 + prev_item 去重。
        interrupts: ['all'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            const bot = agent.bot;
            // ★安全 gate (消费世界模型 bot._world): 别为捡东西破掉保命/掩护。
            //   ① 战斗/受击中不分心捡; ② 夜间已真封顶(coverReal)时不破掩护出去捡。
            const w = bot._world;
            if (w && w.threat && (w.threat.actionable > 0 || w.threat.takingDamage)) { this.noticed_at = -1; return; }
            if (w && w.time && !w.time.isDay && w.cover && w.cover.coverReal) { this.noticed_at = -1; return; }
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item', 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                agent.bot.lookAt(entity.position.offset(0, height, 0));
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

async function execute(mode, agent, func, timeout=-1) {
    if (agent.self_prompter.isActive())
        agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    mode.active = true;
    let code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
        await func();
    }, { timeout });
    mode.active = false;
    
    // Only log mode completion for non-interrupted actions or when there's meaningful output
    if (!code_return.interrupted) {
        const outputPreview = code_return.message ? code_return.message.substring(0, 100) : '';
        console.log(`Mode ${mode.name} finished: ${outputPreview}`);
    }

    let should_reprompt = 
        interrupted_action && // it interrupted a previous action
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        !code_return.interrupted; // this mode action was not interrupted by something else

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let role = convoManager.inConversation() ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage(role, `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}.
        Your behavior log: ${logs}\nRespond accordingly.`);
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        // always-on observers (e.g. threat_radar) run every tick regardless of what the
        // agent is executing — they only record, never act, so they bypass the
        // idle/interruptible gate and the active-mode break below. Without this, a
        // sticky skill keeps the agent non-idle ~100% of the time and the combat
        // blackbox only catches stray frames between skills.
        for (let mode of modes_list) {
            if (mode.always && mode.on && !mode.active) {
                try { await mode.update(_agent); } catch (e) {}
            }
        }
        for (let mode of modes_list) {
            if (mode.always) continue;
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                await mode.update(_agent);
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}
