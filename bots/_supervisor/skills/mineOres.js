// mineOres — oracle 制导矿石远征 (2026-07-06 用户令: "oracle视角挖铁应该非常快, 1h 怎么可能")
// ore-oracle 已把 iron/coal 与 diamonds 一并扫出 (bot._world.oracleOres.{iron,coal});
// 本技能泛化 mineDiamonds 的直奔模式: 地表走到目标柱 → mineDown 密封下潜到矿层 →
// collectBlock 脉络跟采(x-ray 64 格) → 采空则 branchMine 刷新暴露面 / 换 oracle 下一候选。
// 铁掉 raw_iron, 煤掉 coal — 进度按掉落物库存增量计(delta 口径, 最高契约)。
// 返回契约: 增量>0 → {ore,gained}; 零增量 → false (interrupt 解卷时 kernel 不罚)。
import fs from 'fs';
import path from 'path';
import {
    arrivedAtOracleTarget,
    freshOracleSnapshot,
    liveOracleTargetState,
    loadClearedTargets,
    markOracleTargetCleared,
    oracleFamily,
    targetCleared,
} from './oracleGuard.js';
import { collectLiveOreBlock } from './descentOreSweep.js';

const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
function prog(line) {
    fs.promises.appendFile(PROG, `[${new Date().toISOString()}] [mineOres] ${line}\n`).catch(() => {});
}

// 掉落物口径: 矿石块可能被 silk/直采差异影响, 但本栈无 silk — raw_x/coal 即掉落
const DROP_OF = { iron: /^raw_iron$/, coal: /^coal$/, gold: /^raw_gold$/, copper: /^raw_copper$/, diamonds: /^diamond$/ };
// 采集所需镐级: 铁需石镐+, 煤任意镐
const PICK_FOR = { iron: /(stone|iron|diamond|netherite)_pickaxe$/, gold: /(iron|diamond|netherite)_pickaxe$/, coal: /_pickaxe$/, copper: /(stone|iron|diamond|netherite)_pickaxe$/, diamonds: /(iron|diamond|netherite)_pickaxe$/ };
// collectBlock 的 blockType 词干 (skills.js:945 oreDrops 映射 _ore/deepslate 变体)
const COLLECT_KEY = { iron: 'iron', coal: 'coal', gold: 'gold', copper: 'copper', diamonds: 'diamond' };

export default async function mineOres(bot, ctx, opts = {}) {
    const { skills, world, Vec3 } = ctx;
    const ore = String((opts && opts.ore) || 'iron');
    // ★2026-07-14 挖钻石(diamonds)走竖直直井下潜(shaft, 不梯式); 其他矿(浅层铁/煤等)保留楼梯。传给下方三处 mineDown。
    const wantShaft = /^diamond/.test(ore);
    const count = Number(opts && opts.count) > 0 ? Number(opts.count) : 8;
    const maxMs = Number(opts && opts.maxMs) > 0 ? Number(opts.maxMs) : 300000;
    const yMax = Number.isFinite(opts && opts.yMax) ? opts.yMax : Infinity;   // 夜挖只收地下带目标
    const deadline = Date.now() + maxMs;
    const dropRe = DROP_OF[ore] || new RegExp(`^raw_${ore}$`);
    const pickRe = PICK_FOR[ore] || /_pickaxe$/;
    const collectKey = COLLECT_KEY[ore] || ore;
    const family = oracleFamily(ore);
    const cnt = () => {
        try {
            const c = world.getInventoryCounts(bot);
            return Object.keys(c).reduce((s, k) => s + (dropRe.test(k) ? c[k] : 0), 0);
        } catch (e) { return 0; }
    };
    const hasPick = () => { try { return bot.inventory.items().some(i => pickRe.test(i.name || '')); } catch (e) { return false; } };

    if (!bot || !bot.entity) return false;
    if (!hasPick()) { prog(`ABORT ore=${ore} — 无合格镐(需 ${pickRe}), 失败让 TOOL_UPKEEP 先修`); return false; }
    // ★死57前实录: MAROONED 态下 goToPosition 无条件秒返 false → collectBlock 全瞬败,
    //   13 轮 7s 空转白磨镐; 而能解 MAROONED 的 mobility 被本技能身体令牌挡住 = 死锁。
    //   让位: 诚实 false, kernel 记账冷却, mobility 拿身体脱困后下个窗口再来。
    const marooned = () => {
        try { return /MAROONED/.test((bot._mobility && bot._mobility.state) || ''); } catch (e) { return false; }
    };
    if (marooned()) { prog(`ABORT ore=${ore} — MAROONED 态(寻路全被压制), 让位 mobility 脱困`); return false; }
    bot._svnOreZeroRounds = 0;   // ★跨 run 残留 bug (20:36 实录: 上 run 攒 2 + 本 run 第 1 轮 = 秒收工 46s 白跑)
    if (bot.armorManager) try { await bot.armorManager.equipAll(); } catch (e) {}
    const g0 = cnt();

    // ★幻影铁活锁修: live 世界(mineflayer 已装载区块)半径内是否真有此矿 — 与 collectBlock 同源。
    //   零命中即 oracle 磁盘坐标为幻影。取不到 block id 时 fail-open(返 true, 绝不误标)。
    const oreIds = (() => {
        try {
            const stems = collectKey === 'diamond' ? ['diamond_ore', 'deepslate_diamond_ore']
                : collectKey === 'coal' ? ['coal_ore', 'deepslate_coal_ore']
                : collectKey === 'gold' ? ['gold_ore', 'deepslate_gold_ore']
                : collectKey === 'copper' ? ['copper_ore', 'deepslate_copper_ore']
                : ['iron_ore', 'deepslate_iron_ore'];
            return stems.map(n => bot.registry && bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(v => v != null);
        } catch (e) { return []; }
    })();
    const liveOreNear = (radius) => {
        try {
            if (!oreIds.length) return true;
            // TODO(0714): 待异步化, 同步扫穿风险, 保持同步 —— liveOreNear 为 sync 谓词, 被 faceOreNear()
            //   (mineOres:164/166 sync boolean 上下文) 调用, 转 async 会破坏 async 传播返回 Promise; radius 保持 64。
            const f = bot.findBlocks({ point: bot.entity.position, matching: oreIds, maxDistance: radius, count: 1 });
            return !!(f && f.length);
        } catch (e) { return true; }
    };
    const initialSnapshot = bot._world && bot._world.oracleOres;
    const phantomCenters = await loadClearedTargets(initialSnapshot && initialSnapshot.worldId);
    const isPhantom = (candidate) => targetCleared(candidate, family, phantomCenters);
    const quarantine = async (candidate, reason) => {
        const snapshot = bot._world && bot._world.oracleOres;
        if (!candidate || !freshOracleSnapshot(snapshot)) return false;
        await markOracleTargetCleared(snapshot, family, candidate, reason);
        const now = Date.now();
        phantomCenters.push({ ore: family, x: candidate.x, y: candidate.y, z: candidate.z, r: 12, ts: now, expiresAt: now + 20 * 60 * 1000, worldId: snapshot.worldId });
        prog(`ORACLE quarantine ${family}@${candidate.x},${candidate.y},${candidate.z} reason=${reason}`);
        return true;
    };
    const liveOreCandidates = (radius = 8, limit = 4) => {
        try {
            if (!oreIds.length) return [];
            return (bot.findBlocks({ point: bot.entity.position, matching: oreIds, maxDistance: radius, count: limit }) || [])
                .map((position) => { try { return bot.blockAt(position); } catch (e) { return null; } })
                .filter((block) => block && block.position);
        } catch (e) { return []; }
    };
    const harvestLiveFirst = async () => {
        const liveDeadline = Date.now() + 10000;
        for (const block of liveOreCandidates()) {
            const remaining = liveDeadline - Date.now();
            if (remaining <= 0) break;
            const result = await collectLiveOreBlock(bot, ctx, block, {
                expectedFamily: family,
                approach: true,
                maxApproachDistance: 10,
                maxBlocks: 8,
                budgetMs: Math.min(4500, remaining),
            });
            if (result.mined > 0) {
                prog(`LIVE-FIRST ${family}@${block.position.x},${block.position.y},${block.position.z} mined=${result.mined} (${result.elapsedMs}ms) — oracle bypassed`);
                return result;
            }
        }
        return null;
    };

    // ★死亡热图避区 (deaths 58-61 四死同窝实录, chopWood/achieve 同款口径): 末 50 死亡记录
    //   16 格内 ≥3 死 = 雷区, oracle 候选整体过滤 — 22k 铁不差雷区里那几颗。
    const deathZones = await (async () => {
        try {
            const raw = await fs.promises.readFile(path.resolve(process.cwd(), 'bots', '_supervisor', 'death_log.jsonl'), 'utf8');
            const lines = raw.trim().split('\n').slice(-50);
            return lines.map(ln => { try { const r = JSON.parse(ln); return (typeof r.x === 'number') ? { x: r.x, y: r.y, z: r.z } : null; } catch (e) { return null; } }).filter(Boolean);
        } catch (e) { return []; }
    })();
    const inDeathZone = (c) => {
        if (!deathZones.length) return false;
        let n = 0;
        for (const d of deathZones) {
            // 三维口径: 地表死亡不拉黑正下方深处的矿 (|dy|<=12 才算同区)
            if (Math.hypot(d.x - c.x, d.z - c.z) < 16
                && Math.abs((typeof d.y === 'number' ? d.y : c.y) - c.y) <= 12) { if (++n >= 3) return true; }
        }
        return false;
    };
    // oracle 目标 (新鲜 <10min, 平距 <250, 雷区外)
    const oracleList = () => {
        try {
            const oo = bot._world && bot._world.oracleOres;
            if (!freshOracleSnapshot(oo)) return [];
            // ★2026-07-08 深带优先 (oracle-surface-hop-churn 治本): iron 的 top-24 `iron` 列表是"山面表层铁"
            //   (y53-58 崖面露头), bot 在高台够不着 → 换点蹦跶。深带 `ironDeep` (y48-49) 是密封下潜 vein-follow
            //   的正主。故 iron 一律优先 ironDeep, 无论白天/夜挖; 仅 ironDeep 缺失/被雷区+幻影过滤空时才回退表层
            //   `iron` 列表 (聊胜于无)。yMax 有限时对回退列表仍按 y 截断。
            const filt = (arr) => (Array.isArray(arr) ? arr : []).filter(c => c && !inDeathZone(c) && !isPhantom(c)
                && (yMax === Infinity || c.y <= yMax));
            if (ore === 'iron') {
                const deep = filt(oo.ironDeep);
                if (deep.length) return deep;
                return filt(oo.iron);
            }
            return filt(oo[family]);
        } catch (e) {}
        return [];
    };
    const list0 = oracleList();
    let tgt = (() => {
        const c0 = list0[0];
        if (!c0) return null;
        const p0 = bot.entity.position;
        return Math.hypot(c0.x - p0.x, c0.z - p0.z) < 250 ? c0 : null;
    })();
    prog(`START ore=${ore} need=${count} have=${g0} oracle=${tgt ? `${tgt.x},${tgt.y},${tgt.z}(库存告示${list0.length})` : 'none(盲挖回退)'} pos=${bot.entity.position.floored()} hp=${Math.round(bot.health)} food=${bot.food}`);

    // ★脸上的铁优先 (2026-07-08 用户令: "让他挖铁, 结果它抛弃了脸上的铁跑走了"): oracle[0] 是全局
    //   最优候选, 但它常在 20+ 格外, 而 bot 脚边/上一 run 刚暴露的同类矿就在臂展内。若 live 世界近处
    //   (≤FACE_R) 已有本类矿, 直接进采集环就地 vein-follow, 绝不为了 oracle 坐标掉头走开 —— 那正是
    //   run2(START -95,51 贴着 iron_ore@-94,53,175 d3=2.7) 却 march 去 -120,48 撞 self_defense 浮出
    //   y68 丢铁的病根。见 [[mineores-surface-hop-churn]] / [[diamond-never-reached-blocker-stack]]。
    const FACE_R = 8;
    const faceOreNear = () => liveOreNear(FACE_R);
    if (faceOreNear()) prog(`脸上有${ore}(≤${FACE_R}b) — 跳过 oracle march/下潜, 就地 vein-follow (不为 oracle 坐标掉头)`);

    if (tgt && !faceOreNear()) {
        const dxz = Math.hypot(tgt.x - bot.entity.position.x, tgt.z - bot.entity.position.z);
        if (dxz > 8 && !bot.interrupt_code) {
            await Promise.race([
                skills.goToPosition(bot, tgt.x, null, tgt.z, 6),
                new Promise((_, rej) => setTimeout(() => rej(new Error('oracle-walk-timeout')), 90000)),
            ]).catch(() => { try { bot.pathfinder.stop(); } catch (e) {} try { bot.clearControlStates(); } catch (e) {} });
        }
        // 垂直逼近: 高差 >6 用 mineDown 密封下潜到矿层 y-1 (够近则 collectBlock 自己挖过去);
        // 预算余量 <60s 不再开潜 (评审: 嵌套 mineDown 自带多分钟循环, deadline 只兜 collect 环)
        if (bot.entity.position.y - tgt.y > 6 && !bot.interrupt_code && !bot.death_abort
            && deadline - Date.now() > 60000) {
            try { await skills.customSkill(bot, 'mineDown', { targetY: Math.max(tgt.y - 1, -58), shaft: wantShaft }); } catch (e) {}
        }
    } else if (!faceOreNear()) {
        // ★评审 P2: 无可用 oracle 目标(缺失/陈旧/真距超闸)时不能在地表平采 —
        //   回退到被替代者的行为: 密封楼梯下潜到矿带, 与旧 mineDown 路径等价。
        //   (faceOreNear 时跳过: 脸上已有矿, 盲挖下潜只会离开它 — 见上方 FACE_R 注释。)
        const band = ore === 'coal' ? 40 : (ore === 'diamonds' ? -52 : 14);
        if (bot.entity.position.y - band > 6 && !bot.interrupt_code && deadline - Date.now() > 60000) {
            prog(`无 oracle 目标 — 盲挖回退: mineDown 下潜 y${band}`);
            try { await skills.customSkill(bot, 'mineDown', { targetY: band, shaft: wantShaft }); } catch (e) {}
        }
    }

    // Do not let a disk-only coordinate drive mining once the target cell is live.
    // A definitive non-ore at the exact 3D coordinate quarantines that point for every
    // ore family (including gold/diamonds); unloaded/too-far remains unknown and is not punished.
    if (tgt && arrivedAtOracleTarget(bot, tgt)) {
        const state = liveOracleTargetState(bot, Vec3, tgt, family);
        if (state === 'absent') {
            await quarantine(tgt, 'arrival-live-block-mismatch');
            tgt = null;
        }
    }

    let rounds = 0;
    while (cnt() - g0 < count && Date.now() < deadline && rounds++ < 12) {
        if (bot.interrupt_code || bot.death_abort || bot.health <= 0) break;
        if (!hasPick()) { prog(`镐没了(r${rounds}) — 停`); break; }
        if (marooned()) { prog(`r${rounds}: MAROONED — 让位 mobility 脱困`); break; }
        // ★围殴中止 (deaths 58-60 三连死同源实录: collectBlock 把 bot 带进农场下怪窝):
        //   ≥2 敌对近身 → 携进度收工, 身体交现实威胁反射 (挖矿不打逆风仗)。
        const swarm = (() => {
            try {
                const p = bot.entity.position;
                let n = 0;
                for (const e of Object.values(bot.entities || {})) {
                    if (!e || e === bot.entity || !e.position) continue;
                    let h = false;
                    try { h = ctx.mc.isHostile(e); } catch (e2) {}
                    if (h && e.position.distanceTo(p) <= 10) n++;
                }
                return n;
            } catch (e) { return 0; }
        })();
        if (swarm >= 2) {
            prog(`r${rounds}: 围殴中止 (hostiles10b=${swarm} hp=${Math.round(bot.health)}) — 携进度退`);
            break;
        }
        // 背包临满 → 先清囊 (replenishKit ⓪ 同款 CAPS 白名单; 首战实录: 890 件杂物 0s 收工
        // 三振整个 kind) — 倒不出 2 槽才真收工。永不碰工具/食物/矿物/木/羊毛。
        const emptyN = () => { try { return bot.inventory.emptySlotCount(); } catch (e) { return 9; } };
        if (emptyN() <= 1) {
            const CAPS = { cobblestone: 128, dirt: 64, gravel: 8, andesite: 0, diorite: 0, granite: 0, tuff: 0, flint: 4, rotten_flesh: 8, netherrack: 0, cobbled_deepslate: 64, sand: 0, sandstone: 0, coal: 128, feather: 4, dandelion: 0, azure_bluet: 0, lily_pad: 0, brown_mushroom: 2, egg: 1 };
            let tossed = 0;
            try {
                const haveOf = (n) => bot.inventory.items().reduce((s, i) => s + (i.name === n ? i.count : 0), 0);
                // ★2026-07-14 坑弃: 裸 toss 扔脚底 2s 后被服务器原样捡回 = 清囊白干 (tossed=890 empty
                // 却不涨的实录根因)。改为一次性攒 plan → smartDiscard 单坑批量入弃+验证; 热重载窗口
                // 老 skills.js 没有该函数 → 退回逐件裸 toss。
                const plan = [];
                for (const name of Object.keys(CAPS)) {
                    const have = haveOf(name);
                    if (have > CAPS[name]) plan.push({ name, num: have - CAPS[name] });
                }
                if (plan.length && typeof skills.smartDiscard === 'function') {
                    const pre = plan.reduce((s, p) => s + haveOf(p.name), 0);
                    await skills.smartDiscard(bot, plan);
                    tossed = pre - plan.reduce((s, p) => s + haveOf(p.name), 0);
                } else {
                    for (const it of bot.inventory.items()) {
                        if (emptyN() >= 3) break;
                        const cap = CAPS[it.name];
                        if (cap == null) continue;
                        const have = haveOf(it.name);
                        if (have <= cap) continue;
                        const drop = Math.min(it.count, have - cap);
                        try { await bot.toss(it.type, null, drop); tossed += drop; } catch (e) {}
                    }
                }
            } catch (e) {}
            prog(`r${rounds}: 清囊 tossed=${tossed} → empty=${emptyN()}`);
            if (emptyN() <= 1) { prog(`r${rounds}: 清囊后仍满 — 收工`); break; }
        }
        const before = cnt();
        const rT0 = Date.now();
        // Loaded live blocks are authoritative and outrank every save-oracle target.
        // This path also bypasses historical death-zone/spawner heuristics: current
        // hostiles, fluid adjacency, LOS, reach, and tool harvestability remain hard gates.
        const liveResult = await harvestLiveFirst();
        if (liveResult && cnt() > before) {
            bot._svnOreZeroRounds = 0;
            continue;
        }
        try { await skills.collectBlock(bot, collectKey, Math.max(1, Math.min(4, count - (cnt() - g0)))); }
        catch (e) { prog(`r${rounds}: collectBlock 异常 ${(e && e.message) || e}`); }
        if (cnt() > before) { bot._svnOreZeroRounds = 0; continue; }
        // 死57前实录: 13 轮 7 秒空转(collectBlock 秒败被吞) — 连续 3 轮零增量且轮耗 <5s
        // = 系统性失败(目标不可达/被挖空/镐门), 提前收工省镐, 让 3-strike 正常记账。
        bot._svnOreZeroRounds = (bot._svnOreZeroRounds || 0) + 1;
        // Zero gain alone is not proof of a ghost: the ore may be vertically distant,
        // occluded, or its chunk may not be loaded. Quarantine only an exact, nearby,
        // authoritative live-cell mismatch; never use the old 2D "arrived" heuristic.
        if (tgt && arrivedAtOracleTarget(bot, tgt)) {
            const state = liveOracleTargetState(bot, Vec3, tgt, family);
            if (state === 'absent') {
                await quarantine(tgt, 'zero-gain-live-block-mismatch');
                tgt = null;
            }
        }
        if (bot._svnOreZeroRounds >= 3 && Date.now() - rT0 < 5000) {
            prog(`r${rounds}: 连续 ${bot._svnOreZeroRounds} 轮秒败零增量 — 收工(省镐)`);
            bot._svnOreZeroRounds = 0;
            break;
        }
        // x-ray 64 格内采空 → oracle 下一候选换点; 候选就在脚下(<4b, 单候选自旋)或无候选则支道刷新
        const list = oracleList();
        // ★2026-07-08 无头苍蝇修 (oracle-surface-hop-churn): region 路径修好后 oracle 开始吐"山面表层铁"
        //   (iron 列表全 y53-58), bot 站 y80 森林高台, 每个候选是 20-40 格外山坡裸露矿 —— C304 正确判够不着,
        //   零收获后横向"换点"跳到下一个表层候选 → 在树冠里反复挖树叶满地蹦 (用户实观无头苍蝇; region 修好前
        //   oracle 恒空走盲挖 mineDown 反而挖到铁 = 回归)。守卫: 只要 bot 仍远高于当前候选矿带 (y-bandY>8),
        //   零收获意味"坐在矿上方够不着", 密封下潜切进矿脉 (恢复回归前行为), 而非横向蹦到下一个够不着的表层露头。
        //   下潜到带下方后, collectBlock 就在臂展内 vein-follow。近带内 (y-bandY<=8) 采空才允许横向换点找新脉。
        const bandY = (() => {
            try {
                const ys = list.map(c => c && c.y).filter(v => Number.isFinite(v));
                if (!ys.length) return null;
                return Math.min(...ys);   // 取最浅候选带 — 下潜到它下方即进入整撮候选的采集臂展
            } catch (e) { return null; }
        })();
        if (bandY != null && bot.entity.position.y - bandY > 8 && !bot.interrupt_code && !bot.death_abort
            && deadline - Date.now() > 60000) {
            prog(`r${rounds}: 仍高悬矿带上方 (y=${Math.floor(bot.entity.position.y)} bandY=${bandY}) — 零收获=够不着, 密封下潜切脉 (不横向蹦表层)`);
            try { await skills.customSkill(bot, 'mineDown', { targetY: Math.max(bandY - 2, -58), shaft: wantShaft }); } catch (e) {}
            continue;
        }
        const nxt = list.length ? list[rounds % list.length] : null;
        const nxtDist = nxt ? Math.hypot(nxt.x - bot.entity.position.x, nxt.z - bot.entity.position.z) : Infinity;
        // ★脸上的铁优先(同 START 闸): 本轮零增但臂展内(≤FACE_R)仍有活矿 = 采集环够不着的埋脉/被挡,
        //   不能横向 hop 去 oracle 下一候选把它扔了(run2 病根) — 就地 branchMine 刷新暴露面, 下轮 collectBlock 再吃。
        if (faceOreNear()) {
            prog(`r${rounds}: 脸上仍有${ore}(≤${FACE_R}b)但本轮零增 — 就地 branchMine 刷面, 不横向换点`);
            try { await skills.customSkill(bot, 'branchMine', 8); } catch (e) {}
        } else if (nxt && nxtDist >= 4 && nxtDist < 250) {
            prog(`r${rounds}: 本区采空 → oracle 换点 ${nxt.x},${nxt.y},${nxt.z}`);
            await Promise.race([
                skills.goToPosition(bot, nxt.x, nxt.y, nxt.z, 3),
                new Promise((_, rej) => setTimeout(() => rej(new Error('hop-timeout')), 60000)),
            ]).catch(() => { try { bot.pathfinder.stop(); } catch (e) {} try { bot.clearControlStates(); } catch (e) {} });
        } else {
            try { await skills.customSkill(bot, 'branchMine', 12); } catch (e) {}
        }
    }
    const gained = cnt() - g0;
    prog(`DONE ore=${ore} gained=${gained}/${count} rounds=${rounds} y=${Math.floor(bot.entity.position.y)} hp=${Math.round(bot.health)} 用时${Math.round((maxMs - (deadline - Date.now())) / 1000)}s`);
    return gained > 0 ? { ore, gained } : false;
}
