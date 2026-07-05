// surviveNow — 灰区指挥官 (session#4 大修 2026-07-05; 对抗评审 19 findings 修订版)
//
// 触发(kernel 钩子, kernel.js SVN_*): hp<12 || food<8 || 同锚>5min(夜间健康驻守豁免)。
// kernel 绕过提案市场强制派发本技能; 激活期间软 hold 全部让位 — 走 execute() 仲裁的由
// arbitration.json kernel:surviveNow 精确行挡下(self_preservation/self_defense 保留
// claimant: 早窗溺水/MLG/战斗营救物理上等不起, 规则3-5 口径; 其 bunkerDown/dig-in 僵局枝
// 已在 modes.js 按 surviveNowActive 压制), 绕过仲裁的直写路径查 bot._surviveNowUntil
// 滚动 30s 心跳戳(modes.js surviveNowActive; 本技能楔死/退出后 ≤30s 全部豁免自动失效)。
//
// 单树决策(用户定序, 首个可行者胜): ⓪满粮低血原地回血(REGEN) ①能吃就吃 ②有盾就打
// ③床可达回床睡 ④粮点觅食 ⑤挖墙转移 ⑥主动求死重置(keepInventory 服务器已 RCON 验证 →
// keepinv.json; 死亡=合法出口, 重生满血满粮, 物品含穿着甲全保留 — 所以不卸甲)。
// 树选中⑤/⑥或平手(≥3 可行)时 LLM 战术官(gpt-5.4-mini, 6s 超时, fail-open 静态序)拍板。
//
// 【最高契约】真实世界增量(血粮涨/位移>=8b/威胁实体消失/入睡/死亡重置)→ truthy 对象;
// 假触发/灰区自行解除 → {noop:true}(kernel SVN 阀中性, 不计连败); 全树零产出 → 诚实
// false(kernel SVN 阀升级冷却 60s*2^n, 不占 _kindCooldownUntil)。
// 热加载红线: 零模块级可变状态 — 全部状态挂 bot._svn* 或 JSON 文件。
import fs from 'fs';
import path from 'path';

const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
// 评审修订: 与 eatPreferred/consume 实际能吃的对齐思路 — 名单仍宽(golden_carrot 等
// consume 按名直吃没问题), 但 cake 只能放置不能手吃, 除名。
const NORMAL_FOOD_RE = /^(bread|cooked_[a-z_]+|baked_potato|apple|golden_apple|carrot|golden_carrot|melon_slice|sweet_berries|glow_berries|dried_kelp|pumpkin_pie|mushroom_stew|beetroot_soup|rabbit_stew|suspicious_stew|honey_bottle)$/;
const JUNK_FOOD_RE = /^(rotten_flesh|spider_eye)$/;
const MAX_MS = 240000;            // 单次派发硬预算 4min (kernel 再派续段)
const HP_FLOOR = 12;              // 与 kernel SVN_HP_FLOOR 同口径
const FOOD_FLOOR = 8;             // 与 kernel SVN_FOOD_FLOOR 同口径

function prog(line) {
    try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] [surviveNow] ${line}\n`); } catch (e) {}
}

function keepInvVerified() {
    try {
        const j = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'keepinv.json'), 'utf8'));
        return j && j.value === true && Date.now() - j.ts < 86400000;
    } catch (e) { return false; }
}

function spawnKnown() {
    try {
        const j = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'spawn_pos.json'), 'utf8'));
        return j && typeof j.x === 'number';
    } catch (e) { return false; }
}

function readBedAnchor(bot) {
    try {
        const lm = bot._world && bot._world.landmarks;
        if (lm && lm.bed && typeof lm.bed.x === 'number') return lm.bed;
    } catch (e) {}
    try {
        // bed.json 带 src 字段 = 选址锚非真床 (world_model.bedKnown 同口径), 不算
        const j = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json'), 'utf8'));
        if (j && typeof j.x === 'number' && !j.src) return j;
    } catch (e) {}
    return null;
}

function rationCount(bot) {
    try {
        return bot.inventory.items().reduce((s, i) => s + (NORMAL_FOOD_RE.test(i.name || '') ? i.count : 0), 0);
    } catch (e) { return 0; }
}

function snap(bot, ctx) {
    const p = bot.entity.position;
    const hostiles = [];
    try {
        for (const e of Object.values(bot.entities || {})) {
            if (!e || e === bot.entity || !e.position) continue;
            let hostile = false;
            try { hostile = ctx.mc.isHostile(e); } catch (e2) {}
            if (!hostile) continue;
            const d = e.position.distanceTo(p);
            if (d <= 24) hostiles.push({ id: e.id, name: e.name || '?', d: +d.toFixed(1), dy: Math.round(e.position.y - p.y), entity: e });
        }
    } catch (e) {}
    hostiles.sort((a, b) => a.d - b.d);
    let items = [];
    try { items = bot.inventory.items(); } catch (e) {}
    const hp = Math.round(typeof bot.health === 'number' ? bot.health : 20);
    const food = typeof bot.food === 'number' ? bot.food : 20;
    const hasNormal = items.some(i => NORMAL_FOOD_RE.test(i.name || ''));
    const junk = items.some(i => JUNK_FOOD_RE.test(i.name || ''));
    const hasAnyEdible = hasNormal || (junk && (food <= 6 || hp <= 8));
    let offhand = null;
    try { offhand = bot.inventory.slots[45]; } catch (e) {}
    const hasShield = items.some(i => i.name === 'shield') || !!(offhand && offhand.name === 'shield');
    const sword = items.find(i => /_sword$/.test(i.name || ''));
    let tod = 0;
    try { tod = bot.time.timeOfDay; } catch (e) {}
    const night = tod >= 12542 && tod <= 23459;
    let dim = 'overworld';
    try { dim = String(bot.game.dimension || 'overworld'); } catch (e) {}
    const overworld = /overworld/.test(dim);
    const bed = overworld ? readBedAnchor(bot) : null;   // 床在下界/末地会爆炸
    const bedDist = bed ? Math.hypot(p.x - bed.x, p.z - bed.z) : Infinity;
    const mobRaw = (bot._mobility && bot._mobility.state)
        || (bot._world && bot._world.mobility && bot._world.mobility.state) || 'FREE';
    const enclosed = !!((bot._mobility && bot._mobility.enclosed)
        || (bot._world && bot._world.mobility && bot._world.mobility.enclosed));
    const contained = /POCKET|ENTOMBED|MAROONED|SEALED/.test(mobRaw) || enclosed;
    const a = bot._svnAnchor;
    const anchorMin = a ? Math.round((Date.now() - a.since) / 60000) : 0;
    return {
        hp, food, tod, night, day: !night, dim, overworld, hostiles, hasNormal, hasAnyEdible,
        hasShield, sword: sword ? sword.name : null, bed, bedDist, mobState: mobRaw, enclosed,
        contained, anchorMin, pinned: a ? Date.now() - a.since > 300000 : false,
        respawnKnown: !!bed || spawnKnown(),
    };
}

function pushHistory(bot, entry) {
    try {
        if (!Array.isArray(bot._svnHistory)) bot._svnHistory = [];
        bot._svnHistory.push({ t: Date.now(), ...entry });
        if (bot._svnHistory.length > 12) bot._svnHistory.splice(0, bot._svnHistory.length - 12);
    } catch (e) {}
}

function hostileIdsWithin(bot, ctx, range) {
    const ids = new Set();
    try {
        const p = bot.entity.position;
        for (const e of Object.values(bot.entities || {})) {
            if (!e || e === bot.entity || !e.position) continue;
            let hostile = false;
            try { hostile = ctx.mc.isHostile(e); } catch (e2) {}
            if (hostile && e.position.distanceTo(p) <= range) ids.add(e.id);
        }
    } catch (e) {}
    return ids;
}

function deathEligible(bot, ctx, s, failed) {
    if (!keepInvVerified()) {
        // keepinv.json 过期/缺失 = 终止枝静默失效, 必须可见 (评审 P3)
        if (Date.now() - (bot._svnKeepinvWarnAt || 0) > 300000) {
            bot._svnKeepinvWarnAt = Date.now();
            prog('⚠ keepinv.json 过期/缺失 — 求死分支禁用, 树失去有限步终止保证 (值守请 RCON 复验后刷新)');
        }
        return false;
    }
    if (!s.respawnKnown) return false;
    // 评审 P0 修订: 裸计数条款删除 — _svnFails 只作佐证, 必须伴随真实绝境
    // (无食物+粮线以下), 记账永远不能单独解锁求死。
    // 危血近战绝境(死55实录): hp<=5 被近身追猎且无盾 — 蓄意死优于火海轮盘/换血, 同价更稳
    const meleeDoom = s.hp <= 5 && !s.hasShield && s.hostiles.some(h => h.d <= 8);
    const desperate = (s.food <= 4 && !s.hasAnyEdible && (s.night || failed.has('FORAGE'))) || meleeDoom;
    const exhausted = (bot._svnFails || 0) >= 2 && s.food <= 6 && !s.hasAnyEdible
        && (failed.has('RELOCATE') || s.night);
    return desperate || exhausted;
}

function eligibleBranches(bot, ctx, s, failed) {
    const out = [];
    // ⓪ REGEN: 满粮低血且威胁在外 — 自然回血就是正确答案(擦伤灰区), 站桩即产出
    if (!failed.has('REGEN') && s.hp < HP_FLOOR && s.food >= 17
        && !s.hostiles.some(h => h.d <= 16)) out.push('REGEN');
    if (!failed.has('EAT') && s.hasAnyEdible && s.food < 17) out.push('EAT');
    // 无盾门槛收紧(死55实录: hp11 石剑硬换僵尸 3s 掉到 hp4): 无盾只在 hp>=14 且单怪时开打
    if (!failed.has('FIGHT') && s.hostiles.length && s.hostiles[0].d <= 14 && s.hp >= 8
        && (s.hasShield || (s.sword && s.hp >= 14 && s.hostiles.length === 1))) out.push('FIGHT');
    if (!failed.has('BED') && s.night && s.bed && s.bedDist <= 64) out.push('BED');
    if (!failed.has('FORAGE') && s.day && s.overworld && s.food < 12) out.push('FORAGE');
    if (!failed.has('RELOCATE') && (s.contained || s.pinned || s.hostiles.length)) out.push('RELOCATE');
    if (!failed.has('DEATH') && deathEligible(bot, ctx, s, failed)) out.push('DEATH');
    return out;
}

const ACTION_DESC = {
    REGEN: 'stand still in safety and let natural regeneration heal (food is full)',
    EAT: 'eat food from inventory now',
    FIGHT: 'fight the nearby hostiles (shieldFight: shield-raise melee, per-mob-type logic)',
    BED: 'travel to the known bed and sleep through the night (skips night, hostiles gone at dawn)',
    FORAGE: 'daytime food errand via feedUp (eat stock / hunt / harvest, own safety gates)',
    RELOCATE: 'tunnel/climb out of this pocket and relocate >=8 blocks (escapePlan/surfaceUp/moveAway)',
    DEATH: 'deliberate death reset: keepInventory verified ON — respawn at bed/spawn with full hp+food, all items kept',
};

// ── C: LLM 战术官 — arbiter.askLLM 同款一发模式 (直连 chat_model.sendRequest, 绕过
//    promptConvo 冷却; gpt.js API 错误不 reject 而是 resolve 垃圾串 → parse-miss 与
//    非法动作同样负缓存 60s (评审修订), fail-open 到静态序)。 ──
async function tacticalOfficer(bot, ctx, s, eligible, fallback) {
    try {
        if (Date.now() < (bot._svnLlmFailUntil || 0)) return fallback;
        const agent = bot._agent;
        const model = agent && agent.prompter && agent.prompter.chat_model;
        if (!model) return fallback;
        const sys = 'You are the survival tactical officer for a Minecraft bot stuck in a gray-zone stalemate '
            + '(mid-low hp/food + moderate threat; local reflexes deadlocked, you are the single decision maker now). '
            + 'Pick EXACTLY ONE action from eligible_actions. Deliberate death is a legitimate reset (keepInventory verified: '
            + 'respawn full hp+food at bed, items kept) — prefer it over slow starvation when food paths are dead. '
            + 'Prefer the action most likely to BREAK the stalemate this round. '
            + 'Reply ONLY with JSON: {"action":"<name>","why":"<short reason>"}';
        const user = JSON.stringify({
            hp: s.hp, food: s.food, night: s.night, dim: s.dim,
            hostiles: s.hostiles.slice(0, 5).map(h => ({ name: h.name, dist: h.d, dy: h.dy })),
            has_shield: s.hasShield, sword: s.sword, has_food_in_bag: s.hasAnyEdible,
            bed: s.bed ? { dist: Math.round(s.bedDist) } : null,
            mobility: s.mobState, enclosed: s.enclosed, pinned_minutes: s.anchorMin,
            recent_rounds: (bot._svnHistory || []).slice(-5).map(h => ({ pick: h.pick, out: h.out })),
            eligible_actions: eligible.map(a => ({ name: a, does: ACTION_DESC[a] })),
        });
        const call = model.sendRequest([{ role: 'user', content: user }], sys);
        call.catch(() => {});   // 竞速输了的迟到 rejection 不上 unhandledRejection
        const raw = await Promise.race([
            call,
            new Promise((_, rej) => setTimeout(() => rej(new Error('svn-llm timeout 6s')), 6000)),
        ]);
        const m = String(raw).match(/\{[\s\S]*\}/);
        if (m) {
            const j = JSON.parse(m[0]);
            if (j && eligible.includes(j.action)) {
                prog(`战术官: ${j.action} — ${String(j.why || '').slice(0, 140)}`);
                return j.action;
            }
        }
        // parse-miss / 非法动作 = gpt.js 吞错误后的典型形态 — 同样负缓存, 别每轮烧 6s
        bot._svnLlmFailUntil = Date.now() + 60000;
        prog(`战术官回复无法解析(API 错误或幻觉) — 60s 负缓存, 静态序回退 ${fallback}`);
    } catch (e) {
        bot._svnLlmFailUntil = Date.now() + 60000;
        prog(`战术官失效(${(e && e.message) || e}) — 60s 负缓存, 静态序回退 ${fallback}`);
    }
    return fallback;
}

// ── 分支执行器: 返回 truthy 对象 = 真实世界增量, null = 本分支零产出 ──
const EXEC = {
    async REGEN(bot, ctx, s) {
        // 满粮低血: 站桩回血(unstuck 已按 surviveNowActive 让位)。威胁进 16b 即停。
        const hp0 = bot.health;
        const until = Date.now() + 75000;
        while (Date.now() < until && bot.health < HP_FLOOR + 2
            && !bot.interrupt_code && !bot.death_abort) {
            if (hostileIdsWithin(bot, ctx, 16).size) break;
            try { await ctx.skills.wait(bot, 3000); } catch (e) {}
        }
        return bot.health > hp0 ? { regen: Math.round(bot.health - hp0), hp: Math.round(bot.health) } : null;
    },

    async EAT(bot, ctx, s) {
        // 评审修订: 每口按 food delta 判定(consume 失败不 throw 而 return false;
        // eatPreferred 又无条件 return true) — 名单直吃兜底 + 应急垃圾档解锁。
        const f0 = bot.food;
        for (let i = 0; i < 4 && bot.food < 17 && !bot.interrupt_code && !bot.death_abort; i++) {
            const before = bot.food;
            try { await ctx.skills.eatPreferred(bot); } catch (e) {}
            if (bot.food > before) continue;
            const item = (() => {
                try { return bot.inventory.items().find(it => NORMAL_FOOD_RE.test(it.name || '')); } catch (e) { return null; }
            })();
            if (item) { try { await ctx.skills.consume(bot, item.name); } catch (e) {} }
            if (bot.food > before) continue;
            if (bot.food <= 6 || bot.health <= 8) {
                const junk = (() => {
                    try { return bot.inventory.items().find(it => JUNK_FOOD_RE.test(it.name || '')); } catch (e) { return null; }
                })();
                if (junk) { try { await ctx.skills.consume(bot, junk.name); } catch (e) {} }
            }
            if (bot.food <= before) break;   // 本轮所有路径都没吃进 → 停(EAT-VOID 类)
        }
        return bot.food > f0 ? { ate: bot.food - f0, food: bot.food } : null;
    },

    async FIGHT(bot, ctx, s) {
        // 评审修订: 实体 id 集合差判进度 — 只有真正从世界消失的敌对(击杀/烧尽)算 cleared,
        // 踱步出 14b 圈的不算(仍在 bot.entities)。
        const before = hostileIdsWithin(bot, ctx, 14);
        try { await ctx.skills.customSkill(bot, 'shieldFight', 14, 25000); } catch (e) {}
        const alive = new Set();
        try { for (const e of Object.values(bot.entities || {})) { if (e && e.id != null) alive.add(e.id); } } catch (e) {}
        const gone = [...before].filter(id => !alive.has(id));
        return gone.length ? { cleared: gone.length, left: hostileIdsWithin(bot, ctx, 14).size } : null;
    },

    async BED(bot, ctx, s) {
        let r = null;
        try { r = await ctx.skills.customSkill(bot, 'goBedSleep'); } catch (e) {}
        if (r && r.slept) return { slept: true };
        if (r && r.placed) return { placed: true };
        return null;
    },

    async FORAGE(bot, ctx, s) {
        // 评审修订: feedUp 的 {deferred:true}(BOOTSTRAP_KIT 让路) 是零增量真对象 —
        // 只认 food/口粮 delta。_hungerGateHunt 戳 = prepNether 同款的"获准饥饿猎食",
        // 让 feedUp 不再让路。
        const f0 = bot.food, r0 = rationCount(bot);
        try { bot._hungerGateHunt = Date.now(); } catch (e) {}
        try { await ctx.skills.customSkill(bot, 'feedUp', 14); } catch (e) {}
        return (bot.food > f0 || rationCount(bot) > r0)
            ? { food: bot.food, gained: bot.food - f0, rations: rationCount(bot) - r0 } : null;
    },

    async RELOCATE(bot, ctx, s) {
        const start = bot.entity.position.clone();
        bot._plannedNoPickStoneUntil = Date.now() + 180000;   // 求生挖掘不触 bare_stone_alarm
        bot._svnStampedNoPick = true;                          // finally 里只清自己盖的戳
        try { await ctx.skills.customSkill(bot, 'escapePlan', { execute: true }); } catch (e) {}
        let moved = bot.entity.position.distanceTo(start);
        if (moved < 8 && bot.entity.position.y < 55 && !bot.interrupt_code) {
            try { await ctx.skills.customSkill(bot, 'surfaceUp', 63); } catch (e) {}
            moved = bot.entity.position.distanceTo(start);
        }
        // 裸 moveAway 无地形安全门(死55实录: hp4 走 24 格踩进火/岩浆) — 危血不用它;
        // escapePlan/surfaceUp 自带 cellSafety, 保留。
        if (moved < 8 && !bot.interrupt_code && bot.health > 6) {
            try { await ctx.skills.moveAway(bot, 24); } catch (e) {}
            moved = bot.entity.position.distanceTo(start);
        }
        return moved >= 8 ? { moved: Math.round(moved) } : null;
    },

    async DEATH(bot, ctx, s) {
        // keepInventory 已验证(keepinv.json)。评审修订: 不卸甲 — keepInv 下穿着甲原样保留,
        // 卸了反而重生后裸奔(armorManager 只在捡拾时自动穿); 甲只是让死得慢点, 预算兜底。
        // vitalNow 地板: hp<=4 掉血时 self_preservation 会 vital 夺体逃跑 — 拉锯每轮都在
        // 掉血, 有限步内必达出口; 把失体当流程一环不当 bug。
        const t0 = Date.now();
        const died = () => !!(bot.death_abort || (bot._diedAt && bot._diedAt > t0) || bot.health <= 0);
        prog(`★求死重置启动: hp=${s.hp} food=${s.food} night=${s.night} hostiles=${s.hostiles.length} — keepInventory 已验证, 重生=满状态回床`);
        const budget = Date.now() + 120000;
        let stall = 0;
        while (!died() && Date.now() < budget) {
            const h = (() => {
                try {
                    const p = bot.entity.position;
                    let best = null, bd = 33;
                    for (const e of Object.values(bot.entities || {})) {
                        if (!e || e === bot.entity || !e.position) continue;
                        let hostile = false;
                        try { hostile = ctx.mc.isHostile(e); } catch (e2) {}
                        if (!hostile) continue;
                        const d = e.position.distanceTo(p);
                        if (d < bd) { bd = d; best = e; }
                    }
                    return best;
                } catch (e) { return null; }
            })();
            if (h) {
                // 蹭怪: 走贴身站桩不还手
                try { await ctx.skills.goToPosition(bot, h.position.x, h.position.y, h.position.z, 1); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                try { await ctx.skills.wait(bot, 3000); } catch (e) {}
            } else {
                // 无怪: 高台跳落 (致死落差 ≈ hp+3, 加余量)。净空探测排除树叶/藤(评审:
                // 树冠下 surfaceUp 空转); 无净空且已在地表 → 横移几格换柱位再探。
                const p = bot.entity.position;
                const need = Math.ceil(bot.health) + 6;
                let clear = true;
                try {
                    for (let dy = 2; dy <= need + 2; dy++) {
                        const b = bot.blockAt(p.offset(0, dy, 0));
                        if (b && b.boundingBox === 'block' && !/_leaves$|^leaves$|vine|glow_lichen|snow$/.test(b.name || '')) { clear = false; break; }
                    }
                } catch (e) {}
                if (!clear) {
                    stall++;
                    if (bot.entity.position.y < 55 && stall <= 2) {
                        try { await ctx.skills.customSkill(bot, 'surfaceUp', 63); } catch (e) {}
                    } else {
                        try { await ctx.skills.moveAway(bot, 8); } catch (e) {}
                    }
                    if (stall > 6) { prog('求死: 找不到跳落柱位, 交还树'); break; }
                    continue;
                }
                stall = 0;
                try { await ctx.skills.pillarUp(bot, Math.floor(p.y) + need); } catch (e) {}
                try {
                    bot.setControlState('forward', true);
                    await ctx.skills.wait(bot, 800);
                    bot.clearControlStates();
                } catch (e) {}
                try { await ctx.skills.wait(bot, 3000); } catch (e) {}
            }
        }
        if (died()) { prog('求死重置成功 — 重生即满血满粮, 物品保留'); return { died: true }; }
        prog('求死分支预算耗尽未死 (罕见) — 交还树');
        return null;
    },
};

export default async function surviveNow(bot, ctx, opts = {}) {
    if (!bot || !bot.entity) return false;   // 死亡/断线竞态: 无实体不开工(评审 P3)
    const t0 = Date.now();
    const deadline = t0 + MAX_MS;
    // 滚动心跳戳: 楔死后 ≤30s 全部豁免自动失效; 戳的续发以 deadline+30s 封顶。
    // 评审修订: 顺带重申身体令牌 — vital 营救 execute() 会覆盖并释放(→null),
    // currentOwner 回退 kernel:* 家族行会让 sp/sd 非 vital 也能夺体; 令牌空缺时补回。
    const refresh = () => {
        if (Date.now() >= deadline + 30000) return;
        bot._surviveNowUntil = Date.now() + 30000;
        try {
            if (!bot._bodyOwner) bot._bodyOwner = { name: 'kernel:surviveNow', kind: 'SURVIVE_NOW', since: Date.now() };
        } catch (e) {}
    };
    refresh();
    const entryPos = bot.entity.position.clone();
    const anchorOnly = /^anchor/.test(String((opts && opts.reason) || ''));
    const s0 = snap(bot, ctx);
    prog(`激活 reason=${(opts && opts.reason) || '?'} hp=${s0.hp} food=${s0.food} night=${s0.night} `
        + `hostiles=${s0.hostiles.length}${s0.hostiles[0] ? '@' + s0.hostiles[0].d : ''} mob=${s0.mobState} `
        + `bed=${s0.bed ? Math.round(s0.bedDist) + 'b' : '-'} shield=${s0.hasShield} anchor=${s0.anchorMin}min pos=${bot.entity.position.floored()}`);

    // 假触发(仅同锚, 实际无灰): 重置锚 noop 退出 — 冶炼/挂机蹲点不进树。
    // 评审修订: >16b 的敌对视同无(与灰区解除同口径); contained 仍进树(RELOCATE 治它)。
    if (s0.hp >= HP_FLOOR && s0.food >= FOOD_FLOOR && !s0.hostiles.some(h => h.d <= 16) && !s0.contained) {
        bot._svnAnchor = null;
        bot._surviveNowUntil = 0;
        prog('假触发(健康+无近威胁+未被困, 仅同锚) — 重置锚, noop 退出(不计连败)');
        return { noop: true };
    }

    const achievements = [];
    const failed = new Set();
    let liftedClean = false;
    const heartbeat = setInterval(refresh, 8000);
    try {
        let round = 0;
        while (Date.now() < deadline) {
            round++;
            refresh();
            if (bot.death_abort || (bot._diedAt && bot._diedAt > t0)) {
                achievements.push('death-reset');
                prog(`r${round}: 检测到死亡重置 — 收官`);
                break;
            }
            if (bot.interrupt_code) { prog(`r${round}: interrupt — 让位`); break; }
            // 水情让位(评审): 早窗溺水营救(oxygen 9-15)等不起 vitalNow ≤8 地板 — 主动收官,
            // 戳清零后 self_preservation 满权限接管。
            try {
                const wp = bot.entity.position;
                const wf = bot.blockAt(wp), wh = bot.blockAt(wp.offset(0, 1, 0));
                const inWater = /water/.test((wf && wf.name) || '') || /water/.test((wh && wh.name) || '');
                if (inWater && typeof bot.oxygenLevel === 'number' && bot.oxygenLevel <= 15) {
                    prog(`r${round}: 水情(oxygen=${bot.oxygenLevel}) — 提前收官让位营救`);
                    break;
                }
            } catch (e) {}
            const s = snap(bot, ctx);
            const vitalsOk = s.hp >= HP_FLOOR && s.food >= FOOD_FLOOR && !s.hostiles.some(h => h.d <= 16);
            const movedEnough = bot.entity.position.distanceTo(entryPos) >= 8;
            // 灰区解除判定(评审修订): 锚触发的运行必须"真的动过"或"不再被困"才算解,
            // 否则健康被困类(tableRecovery 口袋)会在 r1 空手退出, 锚不清 → 永久复触环。
            if (vitalsOk && (!anchorOnly || movedEnough || !s.contained)) {
                liftedClean = true;
                prog(`r${round}: 灰区解除 hp=${s.hp} food=${s.food} moved=${Math.round(bot.entity.position.distanceTo(entryPos))}b — 收官`);
                break;
            }
            // 苦力怕近身守则: 树自管距离(sp backoff 反射保留 claimant, 但树先手更稳)
            const cr = s.hostiles.find(h => /creeper/i.test(h.name || ''));
            if (cr && cr.d < 7 && cr.entity && cr.entity.isValid !== false) {
                prog(`r${round}: creeper@${cr.d}b — 先拉开距离`);
                try { await ctx.skills.moveAwayFromEntity(bot, cr.entity, 12); } catch (e) {}
                continue;
            }
            const elig = eligibleBranches(bot, ctx, s, failed);
            if (!elig.length) {
                // 自愈型空树(血在回/威胁在外)按 noop 收官, 真绝境空树按诚实零产出
                if (s.food >= 17 && !s.hostiles.some(h => h.d <= 16)) liftedClean = true;
                prog(`r${round}: 全树无可行分支 (failed=${[...failed].join(',') || '-'} food=${s.food} hp=${s.hp}${liftedClean ? ', 自愈型' : ''}) — 退出`);
                break;
            }
            let pick = elig[0];
            if (pick === 'RELOCATE' || pick === 'DEATH' || elig.length >= 3) {
                pick = await tacticalOfficer(bot, ctx, s, elig, pick);
            }
            prog(`r${round}: pick=${pick} elig=[${elig.join(',')}] hp=${s.hp} food=${s.food} host=${s.hostiles.length}`);
            let out = null;
            try {
                out = await EXEC[pick](bot, ctx, s);
            } catch (e) {
                prog(`r${round}: ${pick} 异常 ${(e && e.message) || e}`);
            }
            pushHistory(bot, { pick, out: out ? JSON.stringify(out).slice(0, 80) : null });
            if (out) {
                achievements.push(`${pick}:${JSON.stringify(out)}`);
                failed.clear();   // 有进度 → 局面变了, 全分支重新解锁
                if (out.died) break;
                if (out.slept) { prog('睡过夜 — 局面重置, 交还正常派发'); break; }
            } else {
                failed.add(pick);
            }
        }
    } finally {
        clearInterval(heartbeat);
        bot._surviveNowUntil = 0;
        if (bot._svnStampedNoPick) {
            bot._svnStampedNoPick = false;
            bot._plannedNoPickStoneUntil = 0;   // 只清自己盖的戳(评审: 3min 泄漏会掩蔽真 bug)
        }
        if (bot._bodyOwner && bot._bodyOwner.name === 'kernel:surviveNow' && bot._bodyOwner.kind === 'SURVIVE_NOW') {
            // refresh() 补回的令牌自己收走; kernel 派发时 setBodyOwner 盖的那份由 kernel finally 释放
            try { bot._bodyOwner = null; } catch (e) {}
        }
        try { bot.clearControlStates(); } catch (e) {}
        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    if (achievements.length) {
        prog(`收官(${secs}s): ${achievements.join(' | ')}`);
        return { ok: true, did: achievements };
    }
    if (liftedClean) {
        // 灰区自行解除/自愈型空树: 中性收官 — 锚清零防复触环, 不计连败(评审 P0/P1 修订)
        bot._svnAnchor = null;
        prog(`收官(${secs}s): 灰区自解, noop(不计连败)`);
        return { noop: true };
    }
    prog(`收官(${secs}s): 零产出 — 诚实 false (kernel SVN 阀升级冷却)`);
    return false;
}
