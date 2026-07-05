// Hot-reloadable REPAIR skill: REPLENISH_KIT — 消耗品补给不变量的修复型执行端。
// (P0-1, review-2026-07-04-distance.md §3.1: 木→棍/台→镐链没有一等 kind, buffer 地下归零
//  → 所有消费技能集体 yield → BOOTSTRAP_KIT 162 次 + GET_FOOD 121 次冷却轮转 36h,
//  y16 石棺 11h。本技能把"补给跑道"变成一等任务: 上浮→取木→折板/棍/台→补镐。)
// 目标不变量: 总镐数>=2 && planksEq>=8; 富余时顺手 stick>=8。
// 派发契约: world_model 以 kind='REPLENISH_KIT', skill='replenishKit' 派发 (提案端由并行改动接线)。
// 返回契约 (最高契约, 本仓库头号病史是零进度返 truthy 的活锁):
//   本次派发有真实 delta (y上升/logs/planks/stick/镐/台任一分量增加) → {progressed:true,...};
//   全程零 delta → return false (诚实吃 strike, kernel 3-strike → 5min 冷却)。
// 打断兼容: 每步之间检查 interrupt/death/supervisor-cancel; 委托的 surfaceUp/chopWood
// 内部自带同款轮询。时间预算 5min。
// Invoked via: {"skill":"replenishKit"}  or  customSkill(bot,'replenishKit')
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

const PICK_RE = /_pickaxe$/;
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
const HOSTILE_RE = /zombie|skeleton|creeper|spider|witch|enderman|drowned|husk|stray|phantom|slime|piglin|silverfish|cave_spider|pillager|vindicator/i;

export default async function replenishKit(bot, ctx, opts = {}) {
    const { skills, world, log } = ctx;
    const BUDGET_MS = 300000;                     // 5min 硬预算
    const started = Date.now();
    const overBudget = () => Date.now() - started > BUDGET_MS;
    // supervisor cancel 惯用法 (与 prepNether cancelRequested 同款, TTL 必须镜像 kernel 的 30s 窗)
    const cancelRequested = () => !!(bot._supervisorCancelAt && Date.now() - bot._supervisorCancelAt < 30000);
    const stop = () => !!(bot.interrupt_code || bot.death_abort || cancelRequested());

    const inv = () => { try { return world.getInventoryCounts(bot) || {}; } catch (e) { return {}; } };
    const cnt = (n) => inv()[n] || 0;
    // 口径与提案端 (world_model /_log$/) 同源: 覆盖 stripped_*_log / pale_oak_log, 防提案↔done 拉锯
    const logsHeld = () => { const c = inv(); return Object.keys(c).filter(k => /_log$/.test(k)).reduce((s, k) => s + c[k], 0); };
    const anyLogName = () => { const c = inv(); return Object.keys(c).find(k => /_log$/.test(k) && c[k] > 0) || null; };
    const plankNameFor = (logName) => logName.replace(/^stripped_/, '').replace('_log', '_planks');
    const planksHeld = () => { const c = inv(); return Object.keys(c).filter(k => k.endsWith('_planks')).reduce((s, k) => s + c[k], 0); };
    const planksEq = () => planksHeld() + logsHeld() * 4;
    // 总镐数 = 不变量口径 (raw count, 不看耐久 — 耐久感知的 effectivePicks 属于提案端;
    // 执行端只对"数量"负责, 宁多勿少, 镐是消耗品跑道)
    const picks = () => { try { return bot.inventory.items().filter(i => PICK_RE.test(i.name)).length; } catch (e) { return 0; } };
    const tableNear = () => { try { return !!world.getNearestBlock(bot, 'crafting_table', 4); } catch (e) { return false; } };

    // 地表判定: 头顶 10 格无实体方块 (树叶/藤不算封顶, 抄 prepNether coveredAboveNow 的排除法) 且 y>=55
    const openAboveNoCanopy = (depth = 10) => {
        try {
            const p = bot.entity.position.floored();
            for (let dy = 1; dy <= depth; dy++) {
                const b = bot.blockAt(p.offset(0, dy, 0));
                if (b && /water|lava/.test(b.name || '')) return false;
                if (b && b.boundingBox === 'block' && !/_leaves$|^leaves$|vine|mangrove_roots|azalea/.test(b.name || '')) return false;
            }
            return true;
        } catch (e) { return false; }
    };
    const onSurface = () => { try { return bot.entity.position.y >= 55 && openAboveNoCanopy(10); } catch (e) { return false; } };
    const hostilesNear = (r = 16) => { try { return Object.values(bot.entities).filter(e => e && e.position && e.name && HOSTILE_RE.test(e.name) && e.position.distanceTo(bot.entity.position) < r).length; } catch (e) { return 0; } };
    const isNight = () => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } };

    // ── 进度签名 (返回契约的地基): 任一分量上升 = 本次派发有真实进度。log 折成 planks 时
    //    logs 减 planks 增 — 按"任一分量上升"计, 不做净值抵消, 所以折板/折棍都算进度。
    const SIG_NAMES = ['picks', 'stick', 'planks', 'logs', 'table'];
    const sig = () => [picks(), cnt('stick'), planksHeld(), logsHeld(), cnt('crafting_table')];
    const before = sig();
    let surfaceYGain = 0;   // 只在 surfaceUp 步内测得的 y 上升才算 (chopWood 途中的爬坡不算, 防虚报)

    const settle = (why) => {
        const after = sig();
        const gains = [];
        for (let i = 0; i < SIG_NAMES.length; i++) if (after[i] > before[i]) gains.push(`${SIG_NAMES[i]}+${after[i] - before[i]}`);
        if (surfaceYGain >= 0.75) gains.push(`y+${surfaceYGain.toFixed(1)}`);
        if (gains.length) {
            prog(`replenishKit: DONE(${why}) progressed [${gains.join(' ')}] → picks=${after[0]} planksEq=${planksEq()} stick=${after[1]} table=${after[4]}`);
            try { log(bot, `replenishKit progressed: ${gains.join(' ')}`); } catch (e) {}
            return { progressed: true, why, gains, picks: after[0], planksEq: planksEq(), stick: after[1] };
        }
        prog(`replenishKit: DONE(${why}) ZERO delta this dispatch (picks=${after[0]} planksEq=${planksEq()} y=${Math.round(bot.entity.position.y)}) — honest false`);
        return false;
    };

    prog(`replenishKit: START picks=${before[0]} stick=${before[1]} planks=${before[2]} logs=${before[3]} table=${before[4]} planksEq=${planksEq()} y=${Math.round(bot.entity.position.y)} onSurface=${onSurface()} night=${isNight()} hostiles16=${hostilesNear(16)} hp=${Math.round(bot.health)} food=${bot.food}`);

    // 已达标 → 诚实 false (不该被派发到这; isGoalDone 释放承诺, 提案端负责别重复提)
    if (picks() >= 3 && planksEq() >= 16 && cnt('stick') >= 8) {   // ★2026-07-05 3镐/16板 (与 world_model REPLENISH_* 同步加厚: 2镐262耐久撑不到下次补给, 20-40min/次复发)
        prog('replenishKit: invariant already satisfied (picks>=3 planksEq>=16 stick>=8) — nothing to do, honest false');
        return false;
    }

    // ── ⓪ ★清囊保槽 (10:44 定案: craftRecipeLocal=true 却零产出 = 背包满, 合成产物落地;
    //    10:49 追加: 排在 ② 后救不了砍木自身 (chopWood C321 帽表窄, dirt661+cobble347+
    //    coal181 占 20 槽它说'无可修剪') → 挪到全技能最前。白名单修剪具名大宗超帽,
    //    永不碰工具/食物/矿物/木/羊毛。──
    const _empty = () => { try { return bot.inventory.emptySlotCount(); } catch (e) { return 9; } };
    if (!stop() && _empty() < 3) {
        const CAPS = { cobblestone: 128, dirt: 64, gravel: 8, andesite: 0, diorite: 0, granite: 0, tuff: 0, flint: 4, rotten_flesh: 8, netherrack: 0, cobbled_deepslate: 64, sand: 0, sandstone: 0, coal: 128, feather: 4, dandelion: 0, azure_bluet: 0, lily_pad: 0, brown_mushroom: 2, egg: 1 };
        let tossed = 0;
        for (const it of bot.inventory.items()) {
            if (_empty() >= 3) break;
            const cap = CAPS[it.name];
            if (cap == null) continue;
            const have = cnt(it.name);
            if (have <= cap) continue;
            const drop = Math.min(it.count, have - cap);
            try { await bot.toss(it.type, null, drop); tossed += drop; } catch (e) {}
        }
        prog(`replenishKit: ⓪ 清囊 tossed=${tossed} → empty=${_empty()} (砍木/合成都要有落点)`);
    }

    // ── ⓪.5 ★零镐急救快道 (12:09 实录: 台×2+棍11+圆石在包, 镐却迟迟不出 — ② 砍木排在
    //    ④ 前, 无板时整个派发预算烧在砍树上)。镐=0 且石镐材料齐(台/棍2/圆石3) → 进门先造
    //    一把再走正常流程; 镐是全系统的血液, 不等木头。──
    if (!stop() && (() => { try { return bot.inventory.items().filter(i => /_pickaxe$/.test(i.name)).length === 0; } catch (e) { return false; } })()
        && cnt('crafting_table') >= 1 && cnt('stick') >= 2 && cnt('cobblestone') >= 3) {
        const p0 = picks();
        try { await skills.craftRecipeLocal(bot, 'stone_pickaxe', 1); } catch (e) { prog(`replenishKit: ⓪.5 急救镐 err ${e.message}`); }
        if (picks() <= p0) {
            try { await skills.craftRecipe(bot, 'stone_pickaxe', 1); } catch (e) { prog(`replenishKit: ⓪.5 fallback err ${e.message}`); }
        }
        prog(`replenishKit: ⓪.5 零镐急救 → picks=${picks()} (台${cnt('crafting_table')} 棍${cnt('stick')} 石${cnt('cobblestone')})`);
    }

    // ── ① 不在地表 → surfaceUp 上浮 (预算 90s — 评审修正: 原先只有外层 Promise.race 截断,
    //      被 race 掉的 surfaceUp 成孤儿协程, 继续清 interrupt_code 并与步②③ 抢身体控制权
    //      (C362-broad 200 徒手破顶预算 × 90s 截断 = 20min 级互绞)。现在把 90s 作为 opts.maxMs
    //      交给 surfaceUp 自己到点收尾退出 (孤儿窗口≈0); 外层 race 放宽到 120s 只当兜底带,
    //      正常路径永远是技能先自退, race 不触发) ──────────────
    if (!onSurface()) {
        if (stop() || overBudget()) return settle('stopped-before-surface');
        const yb = bot.entity.position.y;
        prog(`replenishKit: ① underground (y=${Math.round(yb)}) → surfaceUp target 63, budget 90s (skill-side deadline)`);
        try {
            await Promise.race([
                skills.customSkill(bot, 'surfaceUp', 63, { maxMs: 90000 }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('replenish-surfaceUp-timeout')), 120000)),
            ]);
        } catch (e) {
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
            prog(`replenishKit: ① surfaceUp incomplete: ${e.message}`);
        }
        const ya = bot.entity.position.y;
        surfaceYGain = Math.max(surfaceYGain, ya - yb);
        prog(`replenishKit: ① surfaceUp result y ${Math.round(yb)}→${Math.round(ya)} (gain ${(ya - yb).toFixed(1)}) onSurface=${onSurface()}`);
        // 上不去也不 return — 地下仍可用手里的 log 折板/折棍/补镐 (静态 kit 思路);
        // 只有 chopWood 是地表专属步。
    }

    // ── ①.5 ★oracle 先行开拔 (2026-07-05 实录 00:24: ② 的 90s 预算被 chopWood 内部
    //    oracle 行军(60s/腿)整段吃掉, 旧床死亡热点区 logs 0→0 超时循环跨两个白天窗)。
    //    开拔与砍伐分账: 40 格内无树且 oracle 有森林(<400格) → 先专款走到林腹(穿透点),
    //    ② 的预算全留给真砍。oracle 缺失/树在附近 → 此步零成本跳过。──────────────
    if (!stop() && !overBudget() && onSurface() && logsHeld() < 4 && planksEq() < 16 && !(isNight() && hostilesNear(16) > 0)) {
        const _treeNear = (() => {
            try {
                const ids = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log']
                    .map(n => bot.registry && bot.registry.blocksByName[n] ? bot.registry.blocksByName[n].id : null).filter(x => x != null);
                return ids.length ? (bot.findBlocks({ matching: ids, maxDistance: 40, count: 1 }) || []).length > 0 : false;
            } catch (e) { return false; }
        })();
        if (!_treeNear) {
            const f = (() => {
                try {
                    const o = bot._world && bot._world.oracle;
                    const ff = o && o.fresh && o.dim === 'overworld' && o.nearest && o.nearest.forest;
                    if (!ff || !Number.isFinite(ff.x)) return null;
                    const d = Math.hypot(ff.x - bot.entity.position.x, ff.z - bot.entity.position.z);
                    return (d > 30 && d < 400) ? { x: ff.x, z: ff.z, d } : null;
                } catch (e) { return null; }
            })();
            if (f) {
                const p = bot.entity.position; const vx = f.x - p.x, vz = f.z - p.z, L = Math.hypot(vx, vz) || 1;
                const tx = Math.round(f.x + (vx / L) * 40), tz = Math.round(f.z + (vz / L) * 40);
                prog(`replenishKit: ①.5 oracle 开拔 → 林腹 @${tx},${tz} (森林 ${Math.round(f.d)}b), 专款 90s`);
                try {
                    await Promise.race([
                        skills.goToPosition(bot, tx, null, tz, 16),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('replenish-march-timeout')), 90000)),
                    ]);
                } catch (e) {
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                    prog(`replenishKit: ①.5 开拔未完: ${e.message}`);
                }
            }
        }
    }

    // ── ② 地表取木: chopWood 到 logs>=4 (needLogs 关掉它的 planksEq>=8 早退, 我们真要原木)──
    if (!stop() && !overBudget() && onSurface() && logsHeld() < 4 && planksEq() < 16) {
        if (isNight() && hostilesNear(16) > 0) {
            prog(`replenishKit: ② SKIP chopWood — night+hostiles16=${hostilesNear(16)}, 取木不值一条命 (delta 留给其他步)`);
        } else {
            const lb = logsHeld();
            const need = Math.max(1, 4 - lb);
            prog(`replenishKit: ② chopWood need=${need} (logs=${lb} planksEq=${planksEq()}), budget 120s`);
            try {
                await Promise.race([
                    skills.customSkill(bot, 'chopWood', need, { needLogs: true }),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('replenish-chop-timeout')), 120000)),
                ]);
            } catch (e) {
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                prog(`replenishKit: ② chopWood incomplete: ${e.message}`);
            }
            prog(`replenishKit: ② chopWood result logs ${lb}→${logsHeld()} planksEq=${planksEq()}`);
        }
    }

    // ── ③ 折板/折棍/备台 (craftRecipeLocal 全程 2x2 或自放随身台, 不喂幽灵台 — C340 教训) ──
    if (!stop() && !overBudget() && logsHeld() > 0 && planksHeld() < 8) {
        const logName = anyLogName();
        if (logName) {
            const plankName = plankNameFor(logName);
            const pb = planksHeld();
            const nRecipes = Math.min(cnt(logName), Math.ceil((8 - pb) / 4));   // 1 log → 4 planks
            try { await skills.craftRecipeLocal(bot, plankName, nRecipes); } catch (e) { prog(`replenishKit: ③ planks craft err ${e.message}`); }
            prog(`replenishKit: ③ planks ${pb}→${planksHeld()} (from ${logName} x${nRecipes})`);
        }
    }
    // ── ③.5 ★耐久资产前移 (2026-07-05 实录: 补给周期几乎从未活到尾部⑥⑦ — 夜/死总在中途
    //    打断; 而台/床是 keepInventory 下一次合成永久持有的资产, 必须最先锁定。旧 ③ 的
    //    !tableNear() 门是反的: 在家台旁边就不揣台 → 下矿就没了。板一到手: 台(4板)→床
    //    (同色羊毛3+板3), 然后才轮到消耗品(镐/棍)。craftRecipeLocal 零产出回退 craftRecipe。
    //    ★排序注: 台在折棍【之前】 — 实录 10:08 最小木量(8板)时折棍先吃 2 板, 台(4板)被
    //    截胡到 2 板断供。台是万物解锁器, 排全队最前。──
    if (!stop() && !overBudget() && cnt('crafting_table') < 1 && planksHeld() >= 4) {
        const tb = cnt('crafting_table');
        let r35 = null;
        try { r35 = await skills.craftRecipeLocal(bot, 'crafting_table', 1); } catch (e) { prog(`replenishKit: ③.5 table err ${e.message}`); }
        if (cnt('crafting_table') <= tb) {
            prog(`replenishKit: ③.5 craftRecipeLocal=${JSON.stringify(r35)} 零产出 → 回退 craftRecipe`);
            try { await skills.craftRecipe(bot, 'crafting_table', 1); } catch (e) { prog(`replenishKit: ③.5 fallback err ${e.message}`); }
        }
        prog(`replenishKit: ③.5 口袋台 ${tb}→${cnt('crafting_table')}`);
    }
    if (!stop() && !overBudget() && !bot.inventory.items().some(i => /_bed$/.test(i.name || ''))) {
        const wools = {};
        try { for (const it of bot.inventory.items()) if (/_wool$/.test(it.name || '')) wools[it.name] = (wools[it.name] || 0) + it.count; } catch (e) {}
        const best = Object.entries(wools).sort((a, b) => b[1] - a[1])[0];
        if (best && best[1] >= 3 && planksHeld() >= 3) {
            const bedName = best[0].replace('_wool', '_bed');
            let r36 = null;
            try { r36 = await skills.craftRecipeLocal(bot, bedName, 1); } catch (e) { prog(`replenishKit: ③.5 bed err ${e.message}`); }
            if (cnt(bedName) < 1) {
                prog(`replenishKit: ③.5 bed craftRecipeLocal=${JSON.stringify(r36)} 零产出 → 回退 craftRecipe`);
                try { await skills.craftRecipe(bot, bedName, 1); } catch (e) { prog(`replenishKit: ③.5 bed fallback err ${e.message}`); }
            }
            prog(`replenishKit: ③.5 随身床 ${bedName} → ${cnt(bedName)} (同色 wool=${best[1]})`);
        }
    }
    // ── ③.6 折棍 (台/床锁定后才轮到消耗品) ──
    if (!stop() && !overBudget() && cnt('stick') < 2 && planksHeld() >= 2) {
        const sb = cnt('stick');
        try { await skills.craftRecipeLocal(bot, 'stick', 1); } catch (e) { prog(`replenishKit: ③.6 stick craft err ${e.message}`); }
        prog(`replenishKit: ③.6 stick ${sb}→${cnt('stick')}`);
    }

    // ── ④ 补镐到 2 把: 有 cobble(>=3/把)先石镐, 没有则木镐过渡 (镐是消耗品跑道, 宁多勿清)。
    //      craftRecipeLocal 会把随身台落在臂展内再收回 (T-0079), 不会走向 16 格外的幽灵台。──
    let guard = 0;
    while (!stop() && !overBudget() && picks() < 3 && guard++ < 6) {   // ★3镐口径
        // 原料自愈: 板不够先折 log; 棍不够先折板; 都没有 → 老实 break (不空转)
        if (cnt('stick') < 2 || planksHeld() < 3) {
            const logName = anyLogName();
            if (planksHeld() < 4 && logName) {
                try { await skills.craftRecipeLocal(bot, plankNameFor(logName), 1); } catch (e) {}
            }
            if (cnt('stick') < 2 && planksHeld() >= 2) {
                try { await skills.craftRecipeLocal(bot, 'stick', 1); } catch (e) {}
            }
            if (cnt('stick') < 2) { prog(`replenishKit: ④ break — 棍造不出 (planks=${planksHeld()} logs=${logsHeld()})`); break; }
        }
        // 台自愈: 镐是 3x3 配方, 无台且造不出台 → break (craftRecipeLocal 只放臂展内随身台)
        if (cnt('crafting_table') === 0 && !tableNear()) {
            if (planksHeld() >= 4) { try { await skills.craftRecipeLocal(bot, 'crafting_table', 1); } catch (e) {} }
            if (cnt('crafting_table') === 0 && !tableNear()) { prog(`replenishKit: ④ break — 无台且造不出 (planks=${planksHeld()})`); break; }
        }
        // 石镐原料认全族 (stone_tool_materials tag): 深层上浮的 bot 常常一包 cobbled_deepslate 没一块 cobblestone
        const stoneMat = cnt('cobblestone') + cnt('cobbled_deepslate') + cnt('blackstone');
        const wantStone = stoneMat >= 3;
        if (!wantStone && planksHeld() < 3) { prog(`replenishKit: ④ break — 无 cobble 族且 planks=${planksHeld()}<3, 木镐也造不了`); break; }
        const name = wantStone ? 'stone_pickaxe' : 'wooden_pickaxe';
        const pb = picks();
        try {
            await Promise.race([
                skills.craftRecipeLocal(bot, name, 1),
                new Promise((_, rej) => setTimeout(() => rej(new Error(`${name}-craft-timeout`)), 30000)),
            ]);
        } catch (e) { prog(`replenishKit: ④ ${name} craft err ${e.message}`); }
        if (picks() <= pb) {
            prog(`replenishKit: ④ ${name} craft NO delta (cobble=${cnt('cobblestone')} planks=${planksHeld()} stick=${cnt('stick')} tableInv=${cnt('crafting_table')} tableNear=${tableNear()}) — break, 不空转`);
            break;
        }
        prog(`replenishKit: ④ crafted ${name} → picks=${picks()}`);
        if (wantStone) { try { await skills.equip(bot, 'stone_pickaxe'); } catch (e) {} }
    }

    // ── ⑤ 富余顺手补 stick>=8 (只花不伤不变量的板: 折棍后 planksEq 仍须 >=8) ─────────────
    if (!stop() && !overBudget() && picks() >= 3 && cnt('stick') < 8 && planksHeld() >= 2) {
        const need = Math.ceil((8 - cnt('stick')) / 4);                       // 1 recipe = 2 planks → 4 sticks
        const affordable = Math.floor((planksEq() - 8) / 2);                  // 每 recipe 花 2 planksEq, 留住 8 底线
        const n = Math.min(need, Math.max(0, affordable));
        if (n > 0) {
            const sb = cnt('stick');
            try { await skills.craftRecipeLocal(bot, 'stick', n); } catch (e) { prog(`replenishKit: ⑤ stick top-up err ${e.message}`); }
            prog(`replenishKit: ⑤ stick surplus ${sb}→${cnt('stick')} (recipes=${n}, planksEq=${planksEq()})`);
        }
    }

    // ── ⑥⑦ 口袋台/随身床已前移至 ③.5 (耐久资产先锁定 — 周期常死在尾部, 台/床是
    //    keepInventory 下的一次性永久资产, 见 ③.5 rationale)。──

    // ── ⑧ ★熟食储备 (大修C 核心缺环, 2026-07-05: 3死/小时的'以死换饭'循环 — bot 背着
    //    熔炉+煤79 却生吃腐肉度日, 生肉掉落从不烤。有生肉+煤 → smeltSafe 烤熟, 熟食比生肉
    //    营养×1.6 且无中毒。目标熟食≥8; 无生肉/无燃料零成本跳过。──────────────────
    if (!stop() && !overBudget()) {
        const RAWS = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon'];
        const cookedCount = () => RAWS.reduce((s, r) => s + cnt('cooked_' + r), 0);
        if (cookedCount() < 8 && (cnt('coal') > 0 || cnt('charcoal') > 0)) {
            for (const r of RAWS) {
                if (stop() || overBudget() || cookedCount() >= 8) break;
                const n = cnt(r);
                if (n < 1) continue;
                const cb = cookedCount();
                try { await skills.customSkill(bot, 'smeltSafe', r, Math.min(n, 8 - cb)); } catch (e) { prog(`replenishKit: ⑧ cook ${r} err ${e.message}`); }
                prog(`replenishKit: ⑧ 烤 ${r}×${Math.min(n, 8 - cb)} → 熟食 ${cb}→${cookedCount()}`);
            }
        }
    }

    // ── ⑨ ★离场台回收 (12:49 实录: 台 2→1→0 漏光 — ⓪.5/③.5 的 craftRecipe 回退会自放台
    //    但没有 craftRecipeLocal 的 T-0079 回收)。包里没台且 6 格内有台块 → 拆回包。──
    if (!stop() && cnt('crafting_table') < 1) {
        try {
            const tb = bot.findBlock({ matching: (b) => b && b.name === 'crafting_table', maxDistance: 6 });
            if (tb) {
                await skills.breakBlockAt(bot, tb.position.x, tb.position.y, tb.position.z).catch(() => {});
                await skills.pickupNearbyItems(bot).catch(() => {});
                prog(`replenishKit: ⑨ 离场台回收 → table=${cnt('crafting_table')}`);
            }
        } catch (e) {}
    }

    const met = picks() >= 3 && planksEq() >= 16;   // ★3镐/16板
    return settle(stop() ? 'interrupted' : (overBudget() ? 'budget-5min' : (met ? 'invariant-met' : 'partial')));
}
